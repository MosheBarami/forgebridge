--!strict
--[[
	Pairing — turning the code the user carries into a session key.

	The daemon prints an eight-character code in its terminal; the user types it
	here. `POST /v1/link/pair` redeems it (`#pair` in `packages/daemon/src/server.ts`)
	and answers with a link id and a per-pairing salt. Both ends then derive the
	same key from the code with HKDF-SHA256 — the daemon in
	`packages/daemon/src/pairing.ts`, this plugin through the `Crypto` module the
	caller passes in — and every later request is MAC'd under it.

	Deriving from the code rather than shipping a key means nothing secret ever
	crosses the wire: the code is already the shared secret, and its strength comes
	from the three limits the daemon enforces (a 10-minute life, five attempts,
	single use) rather than from its 39 bits.

	Nothing here is Roblox-specific and nothing is required: HttpService, the JSON
	codec, the crypto primitives and the base-URL policy all arrive through
	`context`, so this file can be tested outside Studio like every other leaf.
]]

local Pairing = {}

--[[
	`PAIRING_ALPHABET` from `packages/protocol/src/link.ts`, mirrored rather than
	imported (REPO-LAYOUT boundary rule 4 — this plugin shares no code with the
	TypeScript packages). No I or L (confusable with 1), no O (with 0), no U, and
	no 0 or 1.

	Checked here as well as on the daemon because a look-alike character is the
	single most likely way a hand-carried code goes wrong, and the daemon can only
	answer "incorrect pairing code" — spending one of the five attempts to say it.
]]
Pairing.ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
Pairing.CODE_LENGTH = 8

--- The endpoint that redeems a code. The plugin's fourth and last route.
Pairing.PATH = "/v1/link/pair"

--[[
	Is this a code the daemon could have minted? Returns (ok, reason).

	A validator that accepts more than the generator produces is not checking
	anything (link.ts says so about its own regex), so this admits exactly the
	alphabet and exactly the length.
]]
function Pairing.checkCode(code: string): (boolean, string?)
	if code == "" then
		return false, "enter the pairing code the daemon printed in its terminal"
	end
	if #code ~= Pairing.CODE_LENGTH then
		return false,
			string.format("a pairing code is %d characters; this one is %d", Pairing.CODE_LENGTH, #code)
	end
	for index = 1, #code do
		local character = string.sub(code, index, index)
		if not string.find(Pairing.ALPHABET, character, 1, true) then
			return false,
				string.format(
					'"%s" is not a character pairing codes use — they carry no I, L, O, U, 0 or 1, so check for a look-alike',
					character
				)
		end
	end
	return true, nil
end

--- One line for the widget. Never the key, only its public handle.
function Pairing.describe(link: any): string
	if type(link) ~= "table" or type(link.linkId) ~= "string" then
		return "Not paired"
	end
	return string.format("Paired · session key %s", tostring(link.sessionKeyId))
end

local function headerValue(headers: any, name: string): string?
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

--[[
	The daemon's own words, not this plugin's paraphrase of them.

	`ProtocolError` carries `message` and `remedy`, and for a wrong code the remedy
	is the sentence that says how many of the five attempts are left
	(`PairingService.redeem`). That number is the thing the user most needs, so it
	is carried through verbatim rather than flattened into "pairing failed".
]]
local function failureReason(response: any): string
	local body = response.body
	local message = if type(body) == "table" and type(body.message) == "string"
		then body.message
		else string.format("the daemon refused the pairing request (HTTP %d)", response.statusCode)
	local remedy = if type(body) == "table" and type(body.remedy) == "string" then body.remedy else nil
	if remedy then
		return string.format("%s — %s", message, remedy)
	end
	return message
end

local function post(context: any, url: string, body: any): any
	local headers: any = {
		["Content-Type"] = "application/json",
		Accept = "application/json",
	}
	if context.pluginVersionHeader and context.pluginVersion then
		headers[context.pluginVersionHeader] = context.pluginVersion
	end
	if context.protocolVersionHeader and context.protocolVersion then
		headers[context.protocolVersionHeader] = context.protocolVersion
	end

	local encoded: string
	local encodedOk, encodedValue = pcall(context.encodeJson, body)
	if not encodedOk then
		return { ok = false, transportError = tostring(encodedValue) }
	end
	encoded = encodedValue

	local ok, response = pcall(function()
		return context.http:RequestAsync({
			Url = url,
			Method = "POST",
			Headers = headers,
			Body = encoded,
		})
	end)
	if not ok then
		return { ok = false, transportError = tostring(response) }
	end

	local decoded: any = nil
	if type(response.Body) == "string" and #response.Body > 0 then
		local decodeOk, value = pcall(context.decodeJson, response.Body)
		if decodeOk then
			decoded = value
		end
	end

	return {
		ok = true,
		statusCode = response.StatusCode,
		headers = response.Headers,
		body = decoded,
	}
end

export type Context = {
	http: any, -- HttpService
	encodeJson: (any) -> string,
	decodeJson: (string) -> any,
	crypto: any, -- { normalisePairingCode, fromBase64, deriveSessionKey, sessionKeyId }
	--[[
		The same policy the transport applies to a base URL — `Transport.parseBaseUrl`.

		Passed in rather than reimplemented, and required rather than defaulted: the
		pairing code is the one secret the user types by hand, and a URL nobody vetted
		is exactly how it would leave the machine in the clear. A missing policy is a
		refusal here, never a default-allow.
	]]
	vetUrl: (any) -> (any?, string?),
	pluginVersion: string?,
	protocolVersion: string?,
	protocolMajor: number?,
	pluginVersionHeader: string?,
	protocolVersionHeader: string?,
	projectId: string?,
	studioVersion: string?,
	placeId: number?,
}

export type Link = {
	baseUrl: string,
	linkId: string,
	sessionKey: string,
	sessionKeyId: string,
	projectId: string?,
	transport: string,
	privacyPosture: string?,
	since: number,
	protocolVersion: string?,
}

--[[
	Redeem a code and derive the session key. Returns (link, nil) or (nil, reason).

	The reason is meant to be shown to the user as-is: pairing is the one step
	where a human is definitely watching, and every failure here has a different
	next action — retype the code, start the daemon, issue a fresh code, update the
	plugin.
]]
function Pairing.pair(baseUrl: any, code: any, context: Context): (Link?, string?)
	if
		type(context) ~= "table"
		or type(context.crypto) ~= "table"
		or type(context.crypto.normalisePairingCode) ~= "function"
	then
		return nil, "this plugin build was assembled without the crypto module pairing needs"
	end
	if type(context.vetUrl) ~= "function" then
		return nil, "this plugin build has no base-URL policy, and a pairing code is not sent to an unvetted address"
	end

	local parts, urlError = context.vetUrl(baseUrl)
	if not parts then
		return nil, urlError
	end

	--[[
		Normalised by `Crypto`, which is where the rule lives because that is where
		the key derivation lives: the daemon normalises before it hashes, so a
		plugin that normalised differently would derive a different key from the
		same eight characters and the failure would look like a wrong code.
	]]
	local normalised = context.crypto.normalisePairingCode(if type(code) == "string" then code else "")
	local wellFormed, codeError = Pairing.checkCode(normalised)
	if not wellFormed then
		return nil, codeError
	end

	--[[
		`PairRequest` in `packages/daemon/src/wire.ts`. Everything but the code is
		optional and everything but the code is only ever used for display and field
		debugging — `projectId` picks which project this Studio session binds to, and
		the daemon falls back to its own default when it is absent.
	]]
	local body: any = { pairingCode = normalised }
	if type(context.pluginVersion) == "string" then
		body.pluginVersion = context.pluginVersion
	end
	if type(context.projectId) == "string" and context.projectId ~= "" then
		body.projectId = context.projectId
	end
	if type(context.studioVersion) == "string" and context.studioVersion ~= "" then
		body.studioVersion = context.studioVersion
	end
	-- An unpublished place reports 0, which is not a place id; sending it would put
	-- a made-up number in the daemon's link record.
	if type(context.placeId) == "number" and context.placeId > 0 then
		body.placeId = context.placeId
	end

	local response = post(context, parts.base .. Pairing.PATH, body)
	if not response.ok then
		return nil,
			string.format(
				"could not reach the daemon at %s: %s",
				parts.base,
				tostring(response.transportError)
			)
	end

	-- Checked before the status, exactly as the poll loop does it: a server whose
	-- protocol major differs is one whose pairing response this plugin has no
	-- business interpreting, whatever status it chose to send.
	local headerMajor = majorOf(headerValue(response.headers, context.protocolVersionHeader or "X-ForgeBridge-Protocol"))
	local expectedMajor = context.protocolMajor
	if expectedMajor and headerMajor and headerMajor ~= expectedMajor then
		return nil,
			string.format(
				"this daemon speaks protocol v%d and this plugin speaks v%d — update the plugin",
				headerMajor,
				expectedMajor
			)
	end

	if response.statusCode ~= 200 then
		return nil, failureReason(response)
	end

	local answer = response.body
	if type(answer) ~= "table" then
		return nil, "the daemon's pairing response was not readable JSON"
	end
	if type(answer.linkId) ~= "string" or answer.linkId == "" then
		return nil, "the daemon's pairing response carried no link id"
	end
	if type(answer.sessionKeyId) ~= "string" or answer.sessionKeyId == "" then
		return nil, "the daemon's pairing response named no session key"
	end
	if type(answer.sessionSalt) ~= "string" or answer.sessionSalt == "" then
		return nil, "the daemon's pairing response carried no session salt, so no key can be derived"
	end

	local bodyMajor = majorOf(answer.protocolVersion)
	if expectedMajor and bodyMajor and bodyMajor ~= expectedMajor then
		return nil,
			string.format(
				"this daemon speaks protocol v%d and this plugin speaks v%d — update the plugin",
				bodyMajor,
				expectedMajor
			)
	end

	--[[
		HKDF-SHA256 over the code, salted per pairing, bound to the link id
		(`deriveSessionKey` in `packages/daemon/src/pairing.ts`). Wrapped in pcall
		because the salt is base64 that arrived over the wire: a malformed one must
		surface as a refusal to pair, not as an error unwinding the widget's button
		handler.
	]]
	local derivedOk, derived = pcall(function()
		local salt = context.crypto.fromBase64(answer.sessionSalt)
		local key = context.crypto.deriveSessionKey(normalised, salt, answer.linkId)
		return { key = key, id = context.crypto.sessionKeyId(key) }
	end)
	if not derivedOk then
		return nil, string.format("the session key could not be derived: %s", tostring(derived))
	end

	--[[
		The one check that makes the rest of the link trustworthy.

		The daemon computed a key id from the key it derived; this plugin computed
		one from the key it derived. If they differ, the two ends hold different
		keys, and every MAC from here on would fail — as a 401 on a poll, ten
		seconds later, with nothing on screen tying it back to this moment. Said
		plainly here instead.

		Wrong codes do not reach this point (the daemon rejects them itself and
		spends an attempt saying so), so a mismatch means the derivations have
		drifted apart: a plugin and a daemon built against different rules for it.
	]]
	if derived.id ~= answer.sessionKeyId then
		return nil,
			string.format(
				"paired, but the two ends derived different session keys (this plugin got %s, the daemon issued %s) — "
					.. "this plugin build and that daemon disagree about key derivation, so every request would be refused. "
					.. "Update whichever of the two is older.",
				tostring(derived.id),
				tostring(answer.sessionKeyId)
			)
	end

	return {
		baseUrl = parts.base,
		linkId = answer.linkId,
		sessionKey = derived.key,
		sessionKeyId = derived.id,
		projectId = if type(answer.projectId) == "string" then answer.projectId else nil,
		transport = if type(answer.transport) == "string" then answer.transport else "local-daemon",
		privacyPosture = if type(answer.privacyPosture) == "string" then answer.privacyPosture else nil,
		-- `NONCE_ORIGIN` for a fresh link: the first delivery is nonce 1, so a poll
		-- from 0 is the honest opening cursor (packages/daemon/src/envelope.ts).
		since = if type(answer.since) == "number" then answer.since else 0,
		protocolVersion = if type(answer.protocolVersion) == "string" then answer.protocolVersion else nil,
	},
		nil
end

return Pairing
