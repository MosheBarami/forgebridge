--!nonstrict
--[[
	The live pairing harness — the one check that is not a unit test.

	Everything in `run.luau` proves this plugin agrees with itself and with the
	published vectors it was written against. None of it proves the thing M18
	actually needs, which is that THIS Luau derivation and the daemon's Node
	derivation land on the same session key for the same code, salt and link id.
	Both halves were built separately and both halves passed their own tests
	while the seam between them did not exist at all; a suite that cannot fail
	when the two ends disagree is exactly the suite that let that happen.

	So this file is driven by a real daemon. `tests/live-pair.mjs`-style
	orchestration lives outside Luau because the standalone `luau` CLI has no
	`io` and no `os.execute` — it cannot open a socket, and pretending otherwise
	by mocking the HTTP layer would put us back to proving self-consistency. The
	driver does the sockets and passes the daemon's REAL answers in as program
	arguments; every byte of crypto below is this plugin's own shipping code.

	Two directions are proved, because a link needs both and they use different
	framings:

	  derive  the plugin's key id must equal the one the daemon minted, and the
	          plugin must produce a poll MAC the daemon accepts (consumer → daemon,
	          `requestMac`, length-prefixed).
	  verify  the plugin must accept a delivery envelope the daemon sealed
	          (daemon → consumer, `envelopeMac`, newline-framed). This is the
	          direction that decides whether operations touch the user's place,
	          so a harness that skipped it would leave the more dangerous half
	          unproven.

	Run it through the driver, never by hand:

	    node tests/live-pair.mjs <pairing-code> <producer-token>

	Deliberately NOT in `run.luau`'s suite list. That suite must stay offline and
	hermetic; a test that fails when no daemon happens to be running is a test
	people learn to ignore.
]]

local Crypto = require("../src/Crypto")
local Pairing = require("../src/Pairing")
local Transport = require("../src/Transport")

local args = { ... }
local mode = args[1]

--[[
	Re-derived from the code every time rather than passed between invocations.

	The driver could hand the raw key over and save a few milliseconds, but then
	the second invocation would be verifying an envelope against a key this file
	never derived — and reproducibility of the derivation is half of what is on
	trial here. Deriving twice, in two processes, from nothing but what the user
	typed and what the daemon said, is the property we want.
]]
local function sessionKeyFor(code: string, saltBase64: string, linkId: string): string
	return Crypto.deriveSessionKey(code, Crypto.fromBase64(saltBase64), linkId)
end

--[[
	Run the daemon's real pairing answer through the real `Pairing.pair`.

	The HTTP call is stubbed, and only the HTTP call: `Pairing.pair` takes its
	transport and its JSON codec as arguments precisely so a caller can supply
	them, and the values flowing through are the ones the live daemon just sent.
	What is under test is everything `Pairing.pair` does with them — the salt
	decode, the HKDF, the key-id recomputation, and the equality check that is
	the plugin's only chance to notice a derivation mismatch before it turns
	into a silent 401 ten seconds later.
]]
local function derive(code: string, linkId: string, saltBase64: string, daemonKeyId: string, since: string)
	local answer = {
		linkId = linkId,
		sessionKeyId = daemonKeyId,
		sessionSalt = saltBase64,
		projectId = nil,
		transport = "local-daemon",
		since = tonumber(since) or 0,
	}

	local link, reason = Pairing.pair("http://127.0.0.1:7317", code, {
		http = {
			RequestAsync = function()
				return { StatusCode = 200, Headers = {}, Body = "{}" }
			end,
		},
		encodeJson = function()
			return "{}"
		end,
		-- Returns the daemon's answer rather than parsing the stub body. The JSON
		-- codec is Studio's in the real plugin and is not what this harness is
		-- testing; the daemon's field values are.
		decodeJson = function()
			return answer
		end,
		crypto = Crypto,
		vetUrl = Transport.parseBaseUrl,
	})

	if not link then
		print(string.format("PAIR=fail:%s", tostring(reason)))
		return
	end

	--[[
		`Pairing.pair` already refuses a key-id mismatch, so reaching here means
		the two ends agree. Printed anyway so the driver asserts it against the
		daemon's own JSON independently — a check the code under test performs on
		itself is not a check.
	]]
	print("PAIR=ok")
	print(string.format("KEYID=%s", link.sessionKeyId))

	--[[
		The poll MAC, framed exactly as `Transport:_loop` frames it: the link id
		first because the daemon's `#authenticate` prepends it there, then the
		method, the path and the cursor. The driver puts this on a real
		`GET /v1/link/poll` and the daemon is the judge — a 401 means these two
		derivations disagree, whatever this file thinks.
	]]
	local parts = { link.linkId, "GET", "/v1/link/poll", string.format("%d", link.since) }
	local message = Transport.requestMacMessage(parts)
	print(string.format("POLLMAC=%s", Crypto.toBase64(Crypto.hmacSha256(link.sessionKey, message))))
end

--[[
	Verify a delivery envelope the live daemon sealed.

	This runs the shipping `Transport.verifyMac` — the same call the poll loop
	makes before a single operation is allowed near the place — over an envelope
	that came off the wire, keyed by a session key derived here from the code.
]]
local function verify(code: string, linkId: string, saltBase64: string, envelopeLinkId: string, nonce: string, encrypted: string, mac: string, payload: string)
	local sessionKey = sessionKeyFor(code, saltBase64, linkId)
	local envelope = {
		linkId = envelopeLinkId,
		nonce = tonumber(nonce),
		encrypted = encrypted == "true",
		mac = mac,
		payload = payload,
	}

	local ok, reason = Transport.verifyMac(envelope, sessionKey, Crypto)
	if ok then
		print("ENVELOPE=ok")
	else
		print(string.format("ENVELOPE=fail:%s", tostring(reason)))
	end

	--[[
		The negative control. A harness that only ever shows a MAC verifying has
		not shown that verification can fail — and a `verifyMac` that returned
		true unconditionally would sail through the check above. One flipped byte
		in the payload must break it.
	]]
	local tampered = table.clone(envelope)
	tampered.payload = payload .. " "
	local tamperedOk = Transport.verifyMac(tampered, sessionKey, Crypto)
	print(string.format("TAMPER=%s", if tamperedOk then "accepted" else "refused"))
end

if mode == "derive" then
	derive(args[2], args[3], args[4], args[5], args[6])
elseif mode == "verify" then
	verify(args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9])
else
	print(string.format("MODE=unknown:%s", tostring(mode)))
end
