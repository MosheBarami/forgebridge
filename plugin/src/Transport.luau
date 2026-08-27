--!strict
--[[
	Transport — the long-poll link to a daemon or relay.

	Long-polling is not a preference. Studio has no WebSocket API, and a Studio
	plugin may call HttpService — including to 127.0.0.1, and without the place's
	"Allow HTTP Requests" setting, which is a game-server requirement rather than a
	plugin one. That is the same shape Rojo has used in the wild for years, so the
	loop below is HTTP or it is nothing.

	The plugin's whole network surface is six endpoints (PROTOCOL.md):
	`/v1/link/pair` (once, in `Pairing.luau`), then `/v1/link/poll`,
	`/v1/changesets/:id/apply-result`, `/v1/journal/:id/entry`,
	`/v1/journal/:id/rollback-result` and `/v1/output`. The two journal routes are
	M11's: the first takes the inverse operations off this session so a rollback
	can outlive it, the second reports how far a reversal actually got. Keeping the
	surface this small is deliberate — the plugin is the hardest artefact to update
	in the field, so it should have as little to update as possible.

	Every one of the latter five carries the pairing-derived session key: the poll
	as a MAC over its own parameters, the four writes as a MAC over a sealed
	envelope (`#authenticate` and `#openFromConsumer` in
	`packages/daemon/src/server.ts`).
	Loopback is not an authentication boundary — any process on the machine can
	open a socket to 127.0.0.1 — so the MAC, not the address, is what separates the
	daemon this plugin paired with from anything else that found the port.

	Nothing Roblox-specific is touched at module scope, and nothing is required:
	HttpService, `task`, the JSON codec and the crypto primitives all arrive
	through `Transport.new`, so the pure parts (URL policy, status classification,
	backoff, MAC framing) can be unit-tested outside Studio.
]]

local Transport = {}
Transport.__index = Transport

--[[
	The domain separators from `packages/daemon/src/envelope.ts`, mirrored rather
	than imported (REPO-LAYOUT boundary rule 4). Two of them, so a MAC minted for a
	bodyless request can never be replayed as one over an envelope.
]]
local REQUEST_DOMAIN = "forgebridge/v1/request"
local ENVELOPE_DOMAIN = "forgebridge/v1/envelope"

Transport.DEFAULT_BACKOFF = table.freeze({
	base = 1,
	factor = 2,
	max = 30,
	jitter = 0.2,
})

--[[
	Parse and vet a base URL.

	Returns (parts, nil) or (nil, reason). `parts.loopback` is what every later
	security decision hangs off, so the check is anchored: "127.0.0.1.example.com"
	is not loopback, and a prefix match would say it was.
]]
function Transport.parseBaseUrl(url: any): (any?, string?)
	if type(url) ~= "string" or url == "" then
		return nil, "no base URL is set"
	end
	local scheme, rest = string.match(url, "^(%a[%w+.%-]*)://(.+)$")
	if not scheme or not rest then
		return nil, "a base URL must look like http://host:port"
	end
	scheme = string.lower(scheme)
	if scheme ~= "http" and scheme ~= "https" then
		return nil, string.format('"%s" is not a scheme this plugin will talk over', scheme)
	end

	local authority = string.match(rest, "^([^/]+)") or rest
	local path = string.sub(rest, #authority + 1)
	if string.find(authority, "@", 1, true) then
		return nil, "a base URL may not carry credentials"
	end

	local host = authority
	local port: number? = nil
	local bracketHost, bracketPort = string.match(authority, "^(%[[^%]]+%]):?(%d*)$")
	if bracketHost then
		host = bracketHost
		port = tonumber(bracketPort)
	else
		local plainHost, plainPort = string.match(authority, "^([^:]+):(%d+)$")
		if plainHost then
			host = plainHost
			port = tonumber(plainPort)
		end
	end

	local lowerHost = string.lower(host)
	local loopback = lowerHost == "localhost"
		or lowerHost == "::1"
		or lowerHost == "[::1]"
		or string.match(lowerHost, "^127%.%d+%.%d+%.%d+$") ~= nil

	if not loopback and scheme ~= "https" then
		return nil, "a remote base URL must be https — this plugin will not send changes in the clear"
	end

	-- Trim a trailing slash so path concatenation never produces "//v1/…".
	path = string.gsub(path, "/+$", "")

	return {
		scheme = scheme,
		host = lowerHost,
		port = port,
		loopback = loopback,
		base = string.format("%s://%s%s", scheme, authority, path),
	},
		nil
end

--[[
	Which transport kind a base URL implies.

	`relay-e2e` is deliberately not derivable: claiming it before the end-to-end
	implementation exists (ADR-014, M19) would put a false privacy posture in front
	of the user, which is the single thing that ADR is most concerned with.
]]
function Transport.transportKind(parts: any): string
	return if parts.loopback then "local-daemon" else "relay-tls"
end

--[[
	Whether this plugin will accept deliveries from a URL at all.

	Delivery authentication itself is no longer the obstacle — `Transport.verifyMac`
	verifies every envelope under the pairing-derived key. What is missing is the
	other end: pairing is written against the daemon's `/v1/link/pair`, and there is
	no relay in this repository to pair with or to test that handshake against.
	Pointing this plugin at an unbuilt relay would mean guessing at its half of the
	protocol, and the honest answer to a guess is to refuse and say so.

	TODO(M17): when `apps/relay` exists and speaks the pairing handshake, this gate
	becomes "the link is paired and its MACs verify" rather than "the host is
	loopback". Owner: plugin + apps/relay.
]]
function Transport.deliveryGate(parts: any): (boolean, string?)
	if parts.loopback then
		return true, nil
	end
	return false,
		"this plugin pairs against a daemon's /v1/link/pair, and no relay in this build "
			.. "speaks that handshake yet (ADR-014, M17). Use a local daemon."
end

local function header(headers: any, name: string): string?
	if type(headers) ~= "table" then
		return nil
	end
	local wanted = string.lower(name)
	for key, value in headers do
		if type(key) == "string" and string.lower(key) == wanted then
			return tostring(value)
		end
	end
	return nil
end

local function majorOf(version: any): number?
	if type(version) ~= "string" then
		return nil
	end
	return tonumber(string.match(version, "^(%d+)%."))
end

export type Verdict = {
	action: string, -- delivery | empty | unpaired | unauthenticated | update-required | rate-limited | retry | refuse
	reason: string?,
	retryAfter: number?,
}

--[[
	Classify one response. Pure, so the awkward cases have tests.

	426 is the one that matters most: a server holding operations from a protocol
	version this plugin does not understand must stop the loop dead. Applying the
	subset it happens to recognise is exactly the half-applied ChangeSet the
	journal cannot cleanly reverse (packages/protocol/src/version.ts).
]]
function Transport.classify(response: any, protocolMajor: number): Verdict
	if not response.ok then
		return { action = "retry", reason = response.transportError or "the request did not complete" }
	end

	local status = response.statusCode
	local body = response.body
	local code = if type(body) == "table" then body.code else nil

	-- A protocol major the plugin does not share is treated exactly like a 426,
	-- whatever status the server chose to send it with.
	local serverMajor = majorOf(header(response.headers, "X-ForgeBridge-Protocol"))
	if serverMajor ~= nil and serverMajor ~= protocolMajor then
		return {
			action = "update-required",
			reason = string.format(
				"this server speaks protocol v%d and this plugin speaks v%d — update the plugin",
				serverMajor,
				protocolMajor
			),
		}
	end

	if status == 426 or code == "unsupported_version" then
		return {
			action = "update-required",
			reason = if type(body) == "table" and body.message
				then tostring(body.message)
				else "the server refused to send operations this plugin version understands — update the plugin",
		}
	end
	if status == 204 then
		return { action = "empty" }
	end
	if status == 200 then
		if type(body) ~= "table" then
			return { action = "retry", reason = "the server sent a body this plugin could not read as JSON" }
		end
		return { action = "delivery" }
	end
	if status == 401 or code == "link_unauthenticated" then
		return { action = "unauthenticated", reason = "this link is not authenticated — pair again" }
	end
	if status == 409 then
		if code == "replay_detected" then
			return { action = "refuse", reason = "the server rejected this poll as a replay" }
		end
		return { action = "unpaired", reason = "no link is paired on the other end" }
	end
	if status == 429 then
		local retryAfter = tonumber(header(response.headers, "Retry-After"))
		return { action = "rate-limited", reason = "the server asked this plugin to slow down", retryAfter = retryAfter }
	end
	if status >= 500 then
		return { action = "retry", reason = string.format("the server returned %d", status) }
	end
	return {
		action = "refuse",
		reason = string.format(
			"the server returned %d%s",
			status,
			if code then string.format(" (%s)", tostring(code)) else ""
		),
	}
end

--- Exponential backoff with jitter, capped. `attempt` counts from 1.
function Transport.nextBackoff(attempt: number, options: any?): number
	local opts: any = options or Transport.DEFAULT_BACKOFF
	local base = opts.base or Transport.DEFAULT_BACKOFF.base
	local factor = opts.factor or Transport.DEFAULT_BACKOFF.factor
	local max = opts.max or Transport.DEFAULT_BACKOFF.max
	local jitter = opts.jitter or Transport.DEFAULT_BACKOFF.jitter
	local random = opts.random or math.random

	local delay = math.min(base * factor ^ math.max(attempt - 1, 0), max)
	-- Jitter so a daemon restart does not bring every open Studio window back in
	-- the same millisecond.
	local spread = delay * jitter
	return math.max(0, delay - spread + random() * spread * 2)
end

--[[
	The string a bodyless request is MAC'd over — `requestMac` in
	`packages/daemon/src/envelope.ts`.

	Each part is length-prefixed because the parts are free-form: without it
	("ab","c") and ("a","bc") would sign identically, and a MAC minted for one poll
	cursor would verify for another. `#part` is a byte count in Luau, which is what
	`Buffer.byteLength(part, "utf8")` counts on the other side.
]]
function Transport.requestMacMessage(parts: { string }): string
	local pieces = { REQUEST_DOMAIN }
	for _, part in parts do
		table.insert(pieces, string.format("\n%d:%s", #part, part))
	end
	return table.concat(pieces)
end

local function integerString(value: any): string?
	if type(value) ~= "number" or value ~= math.floor(value) then
		return nil
	end
	return string.format("%d", value)
end

--[[
	The string an envelope is MAC'd over — `envelopeMac` in the same file.

	Newline-framed with the only free-form field last, so no shuffling of content
	between fields can produce the same signed string. The MAC covers the link id
	and the nonce as well as the payload: a delivery captured on one link must not
	verify on another, and a nonce editable without invalidating the MAC would make
	replay detection trivially bypassable.

	Returns nil when the nonce is not an integer, because `String(nonce)` on the
	daemon's side never produces anything else and a guess here would sign a string
	the daemon never signed.
]]
function Transport.envelopeMacMessage(linkId: string, nonce: any, encrypted: boolean, payload: string): string?
	local nonceText = integerString(nonce)
	if not nonceText then
		return nil
	end
	return table.concat({
		ENVELOPE_DOMAIN,
		linkId,
		nonceText,
		if encrypted then "1" else "0",
		payload,
	}, "\n")
end

local function macOf(crypto: any, sessionKey: string, message: string): string
	return crypto.toBase64(crypto.hmacSha256(sessionKey, message))
end

--[[
	Compare two base64 MACs without leaking where they first differ.

	A length mismatch is a `false` rather than an error: `timingSafeEqual` on the
	daemon's side throws on one, and a crash on malformed input is a worse failure
	than the very coarse oracle the early return gives up.
]]
function Transport.macMatches(expected: any, provided: any): boolean
	if type(expected) ~= "string" or type(provided) ~= "string" then
		return false
	end
	if #expected == 0 or #expected ~= #provided then
		return false
	end
	local difference = 0
	for index = 1, #expected do
		difference = bit32.bor(difference, bit32.bxor(string.byte(expected, index), string.byte(provided, index)))
	end
	return difference == 0
end

--[[
	Verify the MAC on a delivery envelope. Returns (verified, reason).

	This is the check that decides whether an operation list gets to touch the
	user's place. It is not a formality on a loopback link: the daemon binds
	127.0.0.1, and so can anything else on the machine, including a page the user
	has open being made to answer a poll. The session key is what tells them apart.

	`crypto` is passed rather than required — `Crypto.luau` is a leaf like every
	other module here — and its absence is a refusal, never a pass.
]]
function Transport.verifyMac(envelope: any, sessionKey: string?, crypto: any?): (boolean, string)
	if type(envelope) ~= "table" then
		return false, "there is no envelope to authenticate"
	end
	if type(sessionKey) ~= "string" or sessionKey == "" then
		return false, "this link holds no session key, so nothing it receives can be authenticated — pair with the daemon"
	end
	if type(crypto) ~= "table" or type(crypto.hmacSha256) ~= "function" or type(crypto.toBase64) ~= "function" then
		return false, "this plugin build has no HMAC implementation, so a delivery cannot be authenticated"
	end
	if type(envelope.mac) ~= "string" or envelope.mac == "" then
		return false, "the delivery carries no MAC"
	end
	if type(envelope.linkId) ~= "string" or envelope.linkId == "" then
		return false, "the delivery names no link, so its MAC cannot be bound to one"
	end
	if type(envelope.payload) ~= "string" then
		return false, "the delivery carries no payload to authenticate"
	end
	local message = Transport.envelopeMacMessage(
		envelope.linkId,
		envelope.nonce,
		envelope.encrypted == true,
		envelope.payload
	)
	if not message then
		return false, "the delivery nonce is not an integer, so its MAC cannot be recomputed"
	end
	local computed = macOf(crypto, sessionKey, message :: string)
	if not Transport.macMatches(computed, envelope.mac) then
		return false, "the delivery MAC did not verify — this did not come from the daemon this link paired with"
	end
	return true, "verified"
end

export type Options = {
	baseUrl: string,
	http: any, -- HttpService
	scheduler: any, -- { spawn, wait }
	encodeJson: (any) -> string,
	decodeJson: (string) -> any,
	pluginVersion: string,
	protocolVersion: string,
	protocolMajor: number,
	pluginVersionHeader: string,
	protocolVersionHeader: string,
	linkId: string?,
	--[[
		The pairing-derived key, raw bytes (`Pairing.pair`). Without it this
		transport can neither authenticate what it receives nor sign what it sends,
		and `start` refuses to run.
	]]
	sessionKey: string?,
	crypto: any?, -- { hmacSha256, toBase64 }
	--- Where to resume polling: the last nonce this link accepted.
	cursor: number?,
	--- The last envelope nonce this link *sent*. See `_seal`.
	outboundNonce: number?,
	backoff: any?,
}

function Transport.new(options: Options): (any?, string?)
	local parts, err = Transport.parseBaseUrl(options.baseUrl)
	if not parts then
		return nil, err
	end

	local self = setmetatable({
		url = parts,
		kind = Transport.transportKind(parts),
		http = options.http,
		scheduler = options.scheduler,
		encodeJson = options.encodeJson,
		decodeJson = options.decodeJson,
		pluginVersion = options.pluginVersion,
		protocolVersion = options.protocolVersion,
		protocolMajor = options.protocolMajor,
		pluginVersionHeader = options.pluginVersionHeader,
		protocolVersionHeader = options.protocolVersionHeader,
		linkId = options.linkId,
		sessionKey = options.sessionKey,
		crypto = options.crypto,
		backoff = options.backoff or Transport.DEFAULT_BACKOFF,

		state = "idle",
		stateReason = nil :: string?,
		_running = false,
		_failures = 0,
		-- The cursor is the last nonce this plugin accepted: the protocol's nonce
		-- is already a per-link monotonic counter, which is precisely what a
		-- resume cursor has to be. `packages/daemon` reads `?since=` as exactly
		-- that and returns the first delivery *above* it, so 0 is the honest
		-- opening cursor for a link that has accepted nothing yet.
		-- TODO(M17): `apps/relay` must read the cursor the same way. Owner: apps/relay.
		--
		-- Restored from settings across a Studio restart, because a link that
		-- resumes at 0 is a link that will be re-offered every delivery it has
		-- already applied.
		_cursor = options.cursor or 0,
		_lastNonce = if type(options.cursor) == "number" and options.cursor > 0 then options.cursor else -1,
		--[[
			The nonce this link last *sent*. The daemon holds a per-link watermark and
			refuses anything at or below it (`tryAdvanceInboundNonce`), so this counter
			only ever moves forward — including across a Studio restart, which is why
			it is restored here rather than started at zero.
		]]
		_outboundNonce = options.outboundNonce or 0,

		onChangeSet = nil :: ((any) -> ())?,
		--[[
			The rollback executor, and its absence is load-bearing rather than
			cosmetic: `unwrap` refuses a rollback delivery outright when this is nil,
			so a build with no executor leaves the delivery queued and says why
			instead of skipping past a reversal the user is waiting for.
		]]
		onRollback = nil :: ((any) -> ())?,
		onState = nil :: ((string, string?) -> ())?,
		--[[
			Called with the cursor and the outbound nonce whenever either moves, so the
			composition root can persist them. Both are link bookkeeping rather than
			transport state, and this module deliberately knows nothing about settings.
		]]
		onCursor = nil :: ((number) -> ())?,
		onNonce = nil :: ((number) -> ())?,
	}, Transport)

	return self, nil
end

function Transport:_setState(state: string, reason: string?)
	if self.state == state and self.stateReason == reason then
		return
	end
	self.state = state
	self.stateReason = reason
	if self.onState then
		self.onState(state, reason)
	end
end

function Transport:posture(postures: any): string
	return postures[self.kind] or self.kind
end

--[[
	The header names live in `packages/daemon/src/server.ts` rather than in
	`packages/protocol`, so they are mirrored from there.

	`X-ForgeBridge-Link` names the link and `X-ForgeBridge-Mac` proves it: the
	daemon looks the link up by the first, then refuses the request unless the
	second verifies under that link's session key (`#authenticate`). The link id on
	its own is not a credential and the daemon does not treat it as one.

	TODO(M31): promote both to `packages/protocol` with the rest of the wire
	contract, so a second transport cannot name them differently. Owner: protocol.
]]
function Transport:_headers(hasBody: boolean, mac: string?): any
	local headers: any = {
		Accept = "application/json",
		[self.pluginVersionHeader] = self.pluginVersion,
		[self.protocolVersionHeader] = self.protocolVersion,
	}
	if hasBody then
		headers["Content-Type"] = "application/json"
	end
	if self.linkId then
		headers["X-ForgeBridge-Link"] = self.linkId
	end
	if mac then
		headers["X-ForgeBridge-Mac"] = mac
	end
	return headers
end

--[[
	`macParts` are the request's own parameters, in the order `#authenticate` reads
	them — the method, the path and whatever else identifies *this* request. The
	link id is prepended here because the daemon prepends it there, and a MAC that
	agreed on everything but the ordering would fail in the way a wrong key fails.
]]
function Transport:_request(method: string, path: string, body: any?, macParts: { string }?): any
	local mac: string? = nil
	if macParts and self.linkId and self.sessionKey and self.crypto then
		local parts = { self.linkId }
		for _, part in macParts do
			table.insert(parts, part)
		end
		mac = macOf(self.crypto, self.sessionKey, Transport.requestMacMessage(parts))
	end
	--[[
		An unpaired link sends the request unsigned and is refused with a 401, which
		`classify` turns into "pair again". Refusing locally instead would be this
		module deciding a question that belongs to the daemon: it is the side that
		knows which links it holds keys for, and the only side whose answer is
		authoritative. The composition root is what keeps a user from getting here
		with nothing paired.
	]]

	local request: any = {
		Url = self.url.base .. path,
		Method = method,
		Headers = self:_headers(body ~= nil, mac),
	}
	if body ~= nil then
		request.Body = self.encodeJson(body)
	end

	local ok, response = pcall(function()
		return self.http:RequestAsync(request)
	end)
	if not ok then
		return { ok = false, transportError = tostring(response) }
	end

	local decoded: any = nil
	if type(response.Body) == "string" and #response.Body > 0 then
		local decodeOk, value = pcall(self.decodeJson, response.Body)
		if decodeOk then
			decoded = value
		end
	end

	return {
		ok = true,
		statusCode = response.StatusCode,
		headers = response.Headers,
		body = decoded,
		rawBody = response.Body,
	}
end

--[[
	Unwrap a DeliveryEnvelope into a ChangeSet.

	Returns (changeSet, nil) or (nil, reason). Every refusal here is a security
	decision, so each one says which invariant it is defending.
]]
function Transport:unwrap(envelope: any): (any?, string?)
	if type(envelope) ~= "table" then
		return nil, "the server sent something that is not a delivery envelope"
	end
	if self.linkId and envelope.linkId and envelope.linkId ~= self.linkId then
		return nil, "the delivery is addressed to a different link"
	end

	--[[
		Authenticate first, exactly as `openEnvelope` does on the daemon's side, and
		for the same reason: every check below acts on fields the MAC covers, and
		acting on an unauthenticated nonce is how an unauthenticated caller pushes a
		watermark forward and locks the real link out.

		Conditional on holding a key at all rather than duplicating a refusal: a
		transport with no session key cannot verify anything and never polls —
		`start` refuses to run one.
	]]
	if self.sessionKey then
		local verified, reason = Transport.verifyMac(envelope, self.sessionKey, self.crypto)
		if not verified then
			return nil, reason
		end
	end

	local nonce = envelope.nonce
	if type(nonce) ~= "number" then
		return nil, "the delivery carries no nonce"
	end
	-- Monotonic per link: a delivery at or below the last accepted nonce is a
	-- replay of something already applied, and the baseVersion check would only
	-- catch it after the plugin had already been told to act on it.
	if nonce <= self._lastNonce then
		return nil, string.format("replayed delivery (nonce %d, already at %d)", nonce, self._lastNonce)
	end

	if envelope.encrypted == true then
		return nil, "this delivery is end-to-end encrypted and this plugin build cannot decrypt it (M19)"
	end

	if type(envelope.payload) ~= "string" then
		return nil, "the delivery carries no payload"
	end
	local ok, payload = pcall(self.decodeJson, envelope.payload)
	if not ok or type(payload) ~= "table" then
		return nil, "the delivery payload is not readable JSON"
	end

	--[[
		`DeliveryPayload` in `packages/daemon/src/wire.ts`: a tagged union, not a
		bare ChangeSet. The tag exists because a rollback the user asked for has no
		other route to this plugin — `PROTOCOL.md` gives the consumer only poll,
		apply-result and output — so the poll has to be able to carry more than one
		kind of thing.
	]]
	if payload.kind == "rollback" then
		--[[
			Both refusals below deliberately leave the cursor where it is, so the
			daemon offers the same delivery again. A rollback silently skipped is a
			user watching for a restore that will never come — the worse of the two
			failures — so the delivery stays queued and the refusal stays on screen.

			The first is the fail-closed check for a build with no rollback executor
			wired in: `unwrap` cannot execute anything itself, and handing a payload
			to a loop that will drop it is the same outcome as skipping it. The
			second is an old daemon sending the pre-M11 shape, which carried the ids
			and nothing else; treating that as a reversal with no work to do would
			report a clean rollback for a tree nobody touched.
		]]
		if self.onRollback == nil then
			return nil, "the daemon sent a rollback, which this plugin build has no executor for"
		end
		if type(payload.steps) ~= "table" or #payload.steps == 0 then
			return nil, "the daemon sent a rollback carrying no inverse operations, so there is nothing to reverse"
		end
	elseif payload.kind ~= "changeset" or type(payload.changeSet) ~= "table" then
		return nil, "the delivery is not a kind of payload this plugin understands"
	end

	self._lastNonce = nonce
	self._cursor = nonce
	if self.onCursor then
		self.onCursor(nonce)
	end
	-- The whole tagged payload, not the ChangeSet inside it. The poll can carry
	-- more than one kind of thing (`DeliveryPayload` in
	-- `packages/daemon/src/wire.ts`) and a caller that received a bare ChangeSet
	-- would have no way to tell which kind it had been handed.
	return payload, nil
end

function Transport:_loop()
	while self._running do
		-- The MAC covers the cursor, so a captured poll cannot be replayed at a
		-- different `since` to fish for a delivery this link has already taken.
		local cursor = self._cursor
		local response = self:_request(
			"GET",
			string.format("/v1/link/poll?since=%d", cursor),
			nil,
			{ "GET", "/v1/link/poll", string.format("%d", cursor) }
		)
		local verdict = Transport.classify(response, self.protocolMajor)

		if verdict.action == "update-required" then
			-- Full stop. Not a backoff, not a retry: this plugin does not
			-- understand what the server is holding, and half-applying it is the
			-- one failure the journal cannot cleanly reverse.
			self._running = false
			self:_setState("update-required", verdict.reason)
			break
		elseif verdict.action == "delivery" then
			local payload, reason = self:unwrap(response.body)
			if payload then
				self._failures = 0
				self:_setState("connected", nil)
				-- One dispatch for both kinds. `unwrap` has already refused a
				-- rollback this build has no executor for, so a rollback that reaches
				-- here has a handler.
				local handler = if payload.kind == "rollback" then self.onRollback else self.onChangeSet
				local argument = if payload.kind == "rollback" then payload else payload.changeSet
				if handler then
					-- The handler is the whole rest of the plugin: diff, approval,
					-- apply, report. Called raw, one throw anywhere in there unwinds
					-- this loop, and the link dies with nothing on screen to say why —
					-- the user sees a plugin that has simply stopped receiving. The
					-- loop survives instead and names the failure. The cursor has
					-- already advanced, deliberately: re-offering a delivery whose
					-- apply may have partly landed is worse than skipping it, and the
					-- ApplyResult (or its absence) is what the producer reasons from.
					local handled, handlerError = pcall(handler, argument)
					if not handled then
						self._failures += 1
						self:_setState(
							"error",
							string.format("this plugin failed while handling a delivery: %s", tostring(handlerError))
						)
						self.scheduler.wait(Transport.nextBackoff(self._failures, self.backoff))
					end
				end
			else
				-- A delivery this plugin refuses does not advance the cursor, so the
				-- server will offer the same one again. Backing off is what keeps a
				-- refusal from becoming a hot loop against the daemon.
				self._failures += 1
				self:_setState("connected", reason)
				self.scheduler.wait(Transport.nextBackoff(self._failures, self.backoff))
			end
		elseif verdict.action == "empty" then
			self._failures = 0
			self:_setState("connected", nil)
		elseif verdict.action == "unpaired" then
			self._failures += 1
			self:_setState("unpaired", verdict.reason)
			self.scheduler.wait(Transport.nextBackoff(self._failures, self.backoff))
		elseif verdict.action == "unauthenticated" then
			self._failures += 1
			self:_setState("unauthenticated", verdict.reason)
			self.scheduler.wait(Transport.nextBackoff(self._failures, self.backoff))
		elseif verdict.action == "rate-limited" then
			self._failures += 1
			self:_setState("throttled", verdict.reason)
			self.scheduler.wait(verdict.retryAfter or Transport.nextBackoff(self._failures, self.backoff))
		elseif verdict.action == "refuse" then
			self._failures += 1
			self:_setState("error", verdict.reason)
			self.scheduler.wait(Transport.nextBackoff(self._failures, self.backoff))
		else
			self._failures += 1
			self:_setState("reconnecting", verdict.reason)
			-- A long poll that outlives Studio's own HTTP timeout comes back here
			-- as a transport error, which is why this path backs off gently
			-- instead of treating it as an outage. `packages/daemon` holds a poll
			-- for 25s (`POLL_TIMEOUT_MS` in `src/server.ts`) and then answers 204,
			-- which lands well inside that budget.
			-- TODO(M17): `apps/relay` owes the same bound. Owner: apps/relay.
			self.scheduler.wait(Transport.nextBackoff(self._failures, self.backoff))
		end
	end
end

function Transport:start(): (boolean, string?)
	if self._running then
		return true, nil
	end
	local allowed, reason = Transport.deliveryGate(self.url)
	if not allowed then
		self:_setState("blocked", reason)
		return false, reason
	end
	self._running = true
	self._failures = 0
	self:_setState("connecting", nil)
	self.scheduler.spawn(function()
		self:_loop()
	end)
	return true, nil
end

function Transport:stop()
	self._running = false
	self:_setState("idle", nil)
end

--[[
	Wrap a payload in the envelope the daemon opens with `#openFromConsumer`.

	The MAC is computed over the exact string that goes on the wire, and the daemon
	recomputes it over the exact string it received (`openEnvelope`), so the two
	never have to agree on how an object serialises — only on the bytes. That is
	why there is no canonicaliser on this side of the link.

	The nonce advances on every attempt and is never reused, including after a
	failure: a request the daemon accepted but whose response was lost has already
	moved its watermark, and resending under the same nonce would come back as
	`replay_detected`. Burning a nonce costs nothing — the daemon only requires
	that they increase.
]]
function Transport:_seal(payload: any): (any?, string?)
	if not self.linkId or not self.sessionKey or not self.crypto then
		return nil, "this link is not paired, so nothing can be sent to the daemon"
	end
	local encoded: string
	local ok, value = pcall(self.encodeJson, payload)
	if not ok then
		return nil, string.format("this plugin could not encode what it was about to send: %s", tostring(value))
	end
	encoded = value

	self._outboundNonce += 1
	local nonce = self._outboundNonce
	if self.onNonce then
		self.onNonce(nonce)
	end

	local message = Transport.envelopeMacMessage(self.linkId, nonce, false, encoded)
	if not message then
		return nil, "the outbound nonce is not an integer"
	end
	return {
		linkId = self.linkId,
		nonce = nonce,
		-- `local-daemon` never encrypts: there is no untrusted hop, and the daemon
		-- refuses an encrypted payload on this transport outright (envelope.ts).
		encrypted = false,
		payload = encoded,
		mac = macOf(self.crypto, self.sessionKey, message :: string),
	},
		nil
end

--- Seal a payload, POST it, and turn the answer into (ok, reason).
function Transport:_postSealed(path: string, payload: any): (boolean, string?)
	local envelope, sealError = self:_seal(payload)
	if not envelope then
		return false, sealError
	end
	local response = self:_request("POST", path, envelope)
	if not response.ok then
		return false, response.transportError
	end
	if response.statusCode >= 200 and response.statusCode < 300 then
		return true, nil
	end
	return false, Transport.classify(response, self.protocolMajor).reason
end

--- POST /v1/changesets/:id/apply-result, enveloped. Returns (ok, reason).
function Transport:postApplyResult(result: any): (boolean, string?)
	return self:_postSealed(
		string.format("/v1/changesets/%s/apply-result", tostring(result.changeSetId)),
		result
	)
end

--[[
	POST /v1/journal/:id/entry — hand the inverse operations to the daemon.

	M11's first half, and the one that decides whether an apply is survivable at
	all. The inverses are captured before anything runs and, until this route
	existed, never left the session that captured them: close Studio and the only
	route back from an apply was gone.

	Enveloped and MAC'd like the apply result, and for a stronger reason than
	symmetry. This is the record a rollback is replayed from, so a process that
	found the loopback port must not be able to write one.
]]
function Transport:postJournalEntry(entry: any): (boolean, string?)
	return self:_postSealed(string.format("/v1/journal/%s/entry", tostring(entry.id)), entry)
end

--[[
	POST /v1/journal/:id/rollback-result — say how far a reversal actually got.

	M11's second half. Until it existed the daemon could dispatch a rollback and
	never learn whether it happened, so `rolledBackAt` stayed null forever and the
	CLI, the A2A connector and the Python SDK could only ever say "dispatched".

	A partial reversal is posted exactly as a partial reversal: `RollbackResult
	.outcomes` carries one entry per inverse attempted and nothing here rounds a
	failure up.
]]
function Transport:postRollbackResult(result: any): (boolean, string?)
	return self:_postSealed(
		string.format("/v1/journal/%s/rollback-result", tostring(result.journalId)),
		result
	)
end

--[[
	POST /v1/output — mirror the Studio console back to the producer.

	The body is `OutputBatch` from `packages/daemon/src/wire.ts`: `{ messages }`,
	each entry `{ level, message, at }` with `level` one of the four names in
	`Config.OUTPUT_LEVEL`. The daemon rejects any other shape outright, so the
	names are the daemon's and not this file's to choose.

	Sent only when the user turns the mirror on.

	TODO(M31): the shape lives in the daemon rather than in `packages/protocol`,
	so a second transport could define it differently. The conformance suite is
	what promotes it. Owner: packages/protocol.
]]
function Transport:postOutput(messages: { any }): (boolean, string?)
	return self:_postSealed("/v1/output", { messages = messages })
end

return Transport
