--!strict
--[[
	Transport — the long-poll link to a daemon or relay.

	Long-polling is not a preference. Studio has no WebSocket API, and a Studio
	plugin may call HttpService — including to 127.0.0.1, and without the place's
	"Allow HTTP Requests" setting, which is a game-server requirement rather than a
	plugin one. That is the same shape Rojo has used in the wild for years, so the
	loop below is HTTP or it is nothing.

	The plugin's whole network surface is three endpoints (PROTOCOL.md):
	`/v1/link/poll`, `/v1/changesets/:id/apply-result` and `/v1/output`. Keeping it
	this small is deliberate — the plugin is the hardest artefact to update in the
	field, so it should have as little to update as possible.

	Nothing Roblox-specific is touched at module scope, and nothing is required:
	HttpService, `task` and the JSON codec all arrive through `Transport.new`, so
	the pure parts (URL policy, status classification, backoff) can be unit-tested
	outside Studio.
]]

local Transport = {}
Transport.__index = Transport

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

	Luau has no crypto standard library, so the payload MAC that authenticates a
	relay delivery does not exist yet (see `Transport.verifyMac`). Until it does, a
	relay link would mean applying whatever the relay sent, unauthenticated, into
	someone's place. The honest answer is to refuse and say why, not to run and
	hope.

	TODO(M18): once HMAC-SHA256 verification lands, this gate becomes "the MAC must
	verify" rather than "the host must be loopback". Owner: plugin + apps/relay.
]]
function Transport.deliveryGate(parts: any): (boolean, string?)
	if parts.loopback then
		return true, nil
	end
	return false,
		"relay links need authenticated delivery, which this plugin build does not have yet (ADR-014, M18). Use a local daemon."
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
	Verify the MAC on a delivery envelope.

	Not implemented, and deliberately so. Luau has no crypto standard library, so
	the HMAC-SHA256 the protocol calls for has to be implemented or vendored, and
	shipping an unreviewed hand-rolled crypto primitive inside a plugin that runs
	with the user's Studio session is worse than shipping the feature late
	(ADR-014). Until then `Transport.deliveryGate` keeps this plugin on loopback,
	where there is no relay to authenticate against.

	TODO(M18): drop in a reviewed HMAC-SHA256 (vendored, with its provenance
	recorded in NOTICE), then verify `envelope.mac` over the canonical payload
	under the pairing-derived session key and return the real verdict here.
	Owner: plugin + packages/daemon + apps/relay.
]]
function Transport.verifyMac(_envelope: any, _sessionKey: string?): (boolean, string)
	return false, "authenticated delivery is not implemented in this plugin build (M18)"
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
		_cursor = 0,
		_lastNonce = -1,

		onChangeSet = nil :: ((any) -> ())?,
		onState = nil :: ((string, string?) -> ())?,
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

function Transport:_headers(hasBody: boolean): any
	local headers: any = {
		Accept = "application/json",
		[self.pluginVersionHeader] = self.pluginVersion,
		[self.protocolVersionHeader] = self.protocolVersion,
	}
	if hasBody then
		headers["Content-Type"] = "application/json"
	end
	if self.linkId then
		-- Provisional. The authenticated form of link identification is defined
		-- with the MAC in M18; until then this is a hint for a daemon that serves
		-- more than one link, and nothing trusts it.
		headers["X-ForgeBridge-Link"] = self.linkId
	end
	return headers
end

function Transport:_request(method: string, path: string, body: any?): any
	local request: any = {
		Url = self.url.base .. path,
		Method = method,
		Headers = self:_headers(body ~= nil),
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

	if not self.url.loopback then
		local verified, reason = Transport.verifyMac(envelope, nil)
		if not verified then
			return nil, reason
		end
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
		-- Deliberately does not advance the cursor. This plugin cannot execute a
		-- rollback that arrives over the wire: the inverse operations live in the
		-- session journal, and `ApplyResult` has nowhere to report that a rollback
		-- completed (Journal.luau, M11). Skipping past it would leave the user
		-- watching a rollback that says "requested" and will never arrive, which is
		-- the worse of the two failures — so the delivery stays queued and the
		-- refusal stays on screen.
		--
		-- TODO(M11): execute it, and report the result. Owner: packages/core
		-- rollback + packages/protocol + plugin.
		return nil, "the daemon sent a rollback, which this plugin build cannot execute yet (M11)"
	end
	if payload.kind ~= "changeset" or type(payload.changeSet) ~= "table" then
		return nil, "the delivery is not a kind of payload this plugin understands"
	end

	self._lastNonce = nonce
	self._cursor = nonce
	return payload.changeSet, nil
end

function Transport:_loop()
	while self._running do
		local response = self:_request("GET", string.format("/v1/link/poll?since=%d", self._cursor))
		local verdict = Transport.classify(response, self.protocolMajor)

		if verdict.action == "update-required" then
			-- Full stop. Not a backoff, not a retry: this plugin does not
			-- understand what the server is holding, and half-applying it is the
			-- one failure the journal cannot cleanly reverse.
			self._running = false
			self:_setState("update-required", verdict.reason)
			break
		elseif verdict.action == "delivery" then
			local changeSet, reason = self:unwrap(response.body)
			if changeSet then
				self._failures = 0
				self:_setState("connected", nil)
				if self.onChangeSet then
					-- The handler is the whole rest of the plugin: diff, approval,
					-- apply, report. Called raw, one throw anywhere in there unwinds
					-- this loop, and the link dies with nothing on screen to say why —
					-- the user sees a plugin that has simply stopped receiving. The
					-- loop survives instead and names the failure. The cursor has
					-- already advanced, deliberately: re-offering a delivery whose
					-- apply may have partly landed is worse than skipping it, and the
					-- ApplyResult (or its absence) is what the producer reasons from.
					local handled, handlerError = pcall(self.onChangeSet, changeSet)
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

--- POST /v1/changesets/:id/apply-result. Returns (ok, reason).
function Transport:postApplyResult(result: any): (boolean, string?)
	local response = self:_request(
		"POST",
		string.format("/v1/changesets/%s/apply-result", tostring(result.changeSetId)),
		result
	)
	if not response.ok then
		return false, response.transportError
	end
	if response.statusCode >= 200 and response.statusCode < 300 then
		return true, nil
	end
	local verdict = Transport.classify(response, self.protocolMajor)
	return false, verdict.reason
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
	local response = self:_request("POST", "/v1/output", { messages = messages })
	if not response.ok then
		return false, response.transportError
	end
	if response.statusCode >= 200 and response.statusCode < 300 then
		return true, nil
	end
	return false, Transport.classify(response, self.protocolMajor).reason
end

return Transport
