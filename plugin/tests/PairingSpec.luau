--!nonstrict
--[[
	Pairing and the MAC'd link.

	These cover the seam that used to have no owner: the plugin could reach the
	daemon and the daemon could refuse it, and nothing in between turned a
	hand-carried code into a session key. Every test here is a way that seam fails
	in the field — a mistyped code, two ends that derive different keys, a MAC
	assembled in the wrong order, a Studio restart.

	`Crypto` is faked rather than required: these tests are about which bytes get
	signed and in what order, and a stand-in that returns its own input makes the
	signed string assertable. The real primitives have their own suite.
]]

local Pairing = require("../src/Pairing")
local Transport = require("../src/Transport")

local SALT = "c2FsdA=="
local LINK_ID = "11111111-1111-4111-8111-111111111111"

--[[
	A `Crypto` stand-in with the same interface, and no secrecy at all.

	`hmacSha256` returns the message it was asked to sign, which is what lets a
	test assert on the exact bytes the daemon would have to sign to agree.
]]
local function fakeCrypto(overrides)
	local crypto = {
		-- The one stand-in that has to behave: `pair` normalises through it, and a
		-- code normalised differently derives a different key. CryptoSpec pins the
		-- real one against the daemon's rule.
		normalisePairingCode = function(input)
			return string.upper((string.gsub(input, "[%s%-]", "")))
		end,
		-- A real round trip, because one of these tests turns on the key surviving
		-- settings unchanged: anything less would only be testing the stand-in.
		toBase64 = function(raw)
			return "b64(" .. raw .. ")"
		end,
		fromBase64 = function(encoded)
			return string.match(encoded, "^b64%((.*)%)$") or ("raw(" .. encoded .. ")")
		end,
		hmacSha256 = function(key, message)
			return string.format("hmac[%s]%s", key, message)
		end,
		deriveSessionKey = function(code, salt, linkId)
			return string.format("key<%s|%s|%s>", code, salt, linkId)
		end,
		sessionKeyId = function(key)
			return "id<" .. key .. ">"
		end,
	}
	for key, value in overrides or {} do
		crypto[key] = value
	end
	return crypto
end

local function derivedKey(code)
	return string.format("key<%s|raw(%s)|%s>", code, SALT, LINK_ID)
end

local function macOf(key, message)
	return string.format("b64(hmac[%s]%s)", key, message)
end

--- An HttpService that answers from a script and keeps every request it was given.
local function fakeHttp(scripted)
	local calls = {}
	return {
		RequestAsync = function(_, request)
			table.insert(calls, request)
			local response = scripted[math.min(#calls, #scripted)]
			if response.transportError then
				error(response.transportError, 0)
			end
			return {
				StatusCode = response.status,
				Headers = response.headers or {},
				Body = response.body or "",
			}
		end,
	},
		calls
end

--- Decode by looking the body text up, the idiom TransportSpec uses.
local function decoder(bodies)
	return function(text)
		local decoded = bodies[text]
		if decoded == nil then
			error("no decode scripted for " .. tostring(text), 0)
		end
		return decoded
	end
end

local function encoder(recorder)
	return function(value)
		table.insert(recorder, value)
		return "encoded#" .. tostring(#recorder)
	end
end

local function pairedResponse(overrides)
	local body = {
		linkId = LINK_ID,
		sessionKeyId = "id<" .. derivedKey("ABCD2345") .. ">",
		projectId = "22222222-2222-4222-8222-222222222222",
		transport = "local-daemon",
		privacyPosture = "Local — nothing leaves this machine",
		sessionSalt = SALT,
		since = 0,
		protocolVersion = "1.0.0",
	}
	for key, value in overrides or {} do
		body[key] = value
	end
	return body
end

local function context(http, sent, decoded, overrides)
	local ctx = {
		http = http,
		encodeJson = encoder(sent),
		decodeJson = decoder(decoded),
		crypto = fakeCrypto(),
		vetUrl = Transport.parseBaseUrl,
		pluginVersion = "0.1.0-test",
		protocolVersion = "1.0.0",
		protocolMajor = 1,
		pluginVersionHeader = "X-ForgeBridge-Plugin",
		protocolVersionHeader = "X-ForgeBridge-Protocol",
	}
	for key, value in overrides or {} do
		ctx[key] = value
	end
	return ctx
end

return function(t)
	t.suite("Pairing — the code the user carries")

	t.test("refuses a code carrying a character the daemon can never mint", function()
		-- I, L, O, U, 0 and 1 are out of the alphabet precisely because they are the
		-- ones a person mis-hears; catching it here saves one of the five attempts.
		local ok, reason = Pairing.checkCode("ABCD2I45")
		t.falsy(ok)
		t.contains(reason, "look-alike")

		local short, shortReason = Pairing.checkCode("ABCD")
		t.falsy(short)
		t.contains(shortReason, "8 characters")

		t.truthy((Pairing.checkCode("ABCD2345")))
	end)

	t.test("will not send a code to an address no policy vetted", function()
		local unvetted = Pairing.pair("http://relay.example.org", "ABCD2345", context({}, {}, {}))
		t.isNil(unvetted, "cleartext to a remote host is exactly how a code leaks")

		local noPolicy = context({}, {}, {})
		noPolicy.vetUrl = nil
		local link, reason = Pairing.pair("http://127.0.0.1:9000", "ABCD2345", noPolicy)
		t.isNil(link)
		t.contains(reason, "unvetted address")
	end)

	t.suite("Pairing — redeeming a code")

	t.test("stores the link the daemon issued and the key both ends derived", function()
		local sent = {}
		local http, calls = fakeHttp({ { status = 200, body = "pair-ok" } })
		local link, reason = Pairing.pair(
			"http://127.0.0.1:9000",
			"abcd-2345",
			context(http, sent, { ["pair-ok"] = pairedResponse() })
		)

		t.isNil(reason)
		t.equal(calls[1].Url, "http://127.0.0.1:9000/v1/link/pair")
		t.equal(calls[1].Method, "POST")
		-- Normalised before it goes out: the daemon compares against the code it
		-- minted, not against the case and spacing the user typed.
		t.equal(sent[1].pairingCode, "ABCD2345")
		t.equal(sent[1].pluginVersion, "0.1.0-test")

		t.equal(link.linkId, LINK_ID)
		t.equal(link.sessionKey, derivedKey("ABCD2345"))
		t.equal(link.sessionKeyId, "id<" .. derivedKey("ABCD2345") .. ">")
		t.equal(link.projectId, "22222222-2222-4222-8222-222222222222")
		t.equal(link.transport, "local-daemon")
		-- The first delivery is nonce 1, so a fresh link honestly polls from 0.
		t.equal(link.since, 0)
	end)

	t.test("refuses a link whose key id does not match the one the daemon issued", function()
		-- Both ends accepted the code and derived different keys: every request from
		-- here would 401, ten seconds later, with nothing tying it back to pairing.
		local http = fakeHttp({ { status = 200, body = "pair-ok" } })
		local link, reason = Pairing.pair(
			"http://127.0.0.1:9000",
			"ABCD2345",
			context(http, {}, { ["pair-ok"] = pairedResponse({ sessionKeyId = "id<somebody-elses-key>" }) })
		)
		t.isNil(link, "a key that will silently 401 is not a link")
		t.contains(reason, "derived different session keys")
		t.contains(reason, "id<somebody-elses-key>")
	end)

	t.test("surfaces the daemon's own words, including how many attempts remain", function()
		-- `PairingService.redeem` counts the attempt before it compares, and puts the
		-- remaining count in the remedy. That number is the thing the user needs.
		local http = fakeHttp({ { status = 401, body = "wrong-code" } })
		local link, reason = Pairing.pair(
			"http://127.0.0.1:9000",
			"ABCD2345",
			context(http, {}, {
				["wrong-code"] = {
					code = "link_unauthenticated",
					message = "incorrect pairing code",
					remedy = "4 attempt(s) remain before this code is revoked.",
				},
			})
		)
		t.isNil(link)
		t.contains(reason, "incorrect pairing code")
		t.contains(reason, "4 attempt(s) remain")
	end)

	t.test("stops on a protocol major it does not share rather than pairing anyway", function()
		local http = fakeHttp({ { status = 200, body = "pair-ok" } })
		local link, reason = Pairing.pair(
			"http://127.0.0.1:9000",
			"ABCD2345",
			context(http, {}, { ["pair-ok"] = pairedResponse({ protocolVersion = "2.0.0" }) })
		)
		t.isNil(link)
		t.contains(reason, "update the plugin")
	end)

	t.test("says the daemon could not be reached rather than throwing out of the button handler", function()
		local http = fakeHttp({ { transportError = "HttpError: ConnectFail" } })
		local link, reason = Pairing.pair("http://127.0.0.1:9000", "ABCD2345", context(http, {}, {}))
		t.isNil(link)
		t.contains(reason, "could not reach the daemon")
	end)

	t.suite("Pairing — the MAC the link carries")

	t.test("assembles a request MAC in the daemon's exact order and framing", function()
		-- `requestMac` in packages/daemon/src/envelope.ts: the domain, then every
		-- part length-prefixed and newline-framed, link id first. A separator out of
		-- place fails in exactly the way a wrong key fails, which is why this is
		-- pinned to the byte.
		t.equal(
			Transport.requestMacMessage({ "L", "GET", "/v1/link/poll", "0" }),
			"forgebridge/v1/request\n1:L\n3:GET\n13:/v1/link/poll\n1:0"
		)
		-- Length prefixes are what stop ("ab","c") and ("a","bc") signing alike.
		t.truthy(Transport.requestMacMessage({ "ab", "c" }) ~= Transport.requestMacMessage({ "a", "bc" }))
	end)

	t.test("assembles an envelope MAC over the link, nonce and encrypted flag, payload last", function()
		t.equal(
			Transport.envelopeMacMessage("L", 7, false, '{"a":1}'),
			'forgebridge/v1/envelope\nL\n7\n0\n{"a":1}'
		)
		t.equal(Transport.envelopeMacMessage("L", 7, true, "x"), "forgebridge/v1/envelope\nL\n7\n1\nx")
		-- A fractional nonce is not something `String(nonce)` ever produced, so
		-- there is no string to sign rather than a guessed one.
		t.isNil(Transport.envelopeMacMessage("L", 1.5, false, "x"))
	end)

	t.test("signs the poll, cursor included, under the paired key", function()
		local key = derivedKey("ABCD2345")
		-- 204 is an empty poll and the loop simply asks again; the 426 behind it is
		-- what stops the loop dead, which is the only clean way to end one.
		local http, calls = fakeHttp({ { status = 204 }, { status = 426 } })
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = http,
			scheduler = { spawn = function(fn)
				fn()
			end, wait = function() end },
			encodeJson = tostring,
			decodeJson = function()
				return {}
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
			linkId = LINK_ID,
			sessionKey = key,
			crypto = fakeCrypto(),
			cursor = 4,
		})
		transport:start()

		local request = calls[1]
		t.equal(request.Url, "http://127.0.0.1:9000/v1/link/poll?since=4")
		t.equal(request.Headers["X-ForgeBridge-Link"], LINK_ID)
		t.equal(
			request.Headers["X-ForgeBridge-Mac"],
			macOf(key, Transport.requestMacMessage({ LINK_ID, "GET", "/v1/link/poll", "4" }))
		)
	end)

	t.test("seals an apply result in an envelope the daemon can open", function()
		local key = derivedKey("ABCD2345")
		local sent = {}
		local http, calls = fakeHttp({ { status = 200, body = "" } })
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = http,
			scheduler = { spawn = function() end, wait = function() end },
			encodeJson = encoder(sent),
			decodeJson = function()
				return {}
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
			linkId = LINK_ID,
			sessionKey = key,
			crypto = fakeCrypto(),
			outboundNonce = 6,
		})

		local ok = transport:postApplyResult({ changeSetId = "cs-1", outcomes = {} })
		t.truthy(ok)
		t.equal(calls[1].Url, "http://127.0.0.1:9000/v1/changesets/cs-1/apply-result")

		-- The envelope is the second thing encoded: the payload string first, then
		-- the envelope wrapping it. The MAC is over that exact payload string.
		local envelope = sent[2]
		t.equal(envelope.linkId, LINK_ID)
		t.equal(envelope.nonce, 7, "the nonce continues above the daemon's watermark")
		t.falsy(envelope.encrypted)
		t.equal(envelope.mac, macOf(key, Transport.envelopeMacMessage(LINK_ID, 7, false, envelope.payload)))
	end)

	t.test("never reuses an outbound nonce, even after a failed send", function()
		local seen = {}
		local http = fakeHttp({ { status = 500, body = "" } })
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = http,
			scheduler = { spawn = function() end, wait = function() end },
			encodeJson = tostring,
			decodeJson = function()
				return {}
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
			linkId = LINK_ID,
			sessionKey = derivedKey("ABCD2345"),
			crypto = fakeCrypto(),
		})
		transport.onNonce = function(nonce)
			table.insert(seen, nonce)
		end

		transport:postOutput({})
		transport:postOutput({})
		-- A request the daemon accepted but whose response was lost has already
		-- moved its watermark; resending under the same nonce is a replay.
		t.equal(seen[1], 1)
		t.equal(seen[2], 2)
	end)

	t.test("refuses to send anything on a link with no session key", function()
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = {},
			scheduler = { spawn = function() end, wait = function() end },
			encodeJson = tostring,
			decodeJson = function()
				return {}
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
		})
		local ok, reason = transport:postApplyResult({ changeSetId = "cs-1" })
		t.falsy(ok)
		t.contains(reason, "not paired")
	end)

	t.suite("Pairing — authenticated delivery")

	local function pairedTransport(options)
		local key = derivedKey("ABCD2345")
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = {},
			scheduler = { spawn = function() end, wait = function() end },
			encodeJson = tostring,
			decodeJson = function()
				return { kind = "changeset", changeSet = { id = "cs" } }
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
			linkId = LINK_ID,
			sessionKey = key,
			crypto = fakeCrypto(),
			cursor = if options then options.cursor else nil,
		})
		return transport, key
	end

	local function sealed(key, nonce, payload)
		return {
			linkId = LINK_ID,
			nonce = nonce,
			payload = payload,
			encrypted = false,
			mac = macOf(key, Transport.envelopeMacMessage(LINK_ID, nonce, false, payload)),
		}
	end

	t.test("accepts a delivery that verifies under the paired key", function()
		local transport, key = pairedTransport()
		-- `unwrap` hands back the tagged `DeliveryPayload`, not the ChangeSet
		-- inside it: the poll carries rollbacks too, and a caller given a bare
		-- ChangeSet has no way to tell which kind it was handed.
		local payload, reason = transport:unwrap(sealed(key, 1, "{}"))
		t.isNil(reason)
		t.equal(payload.kind, "changeset")
		t.equal(payload.changeSet.id, "cs")
		t.equal(transport._cursor, 1)
	end)

	t.test("refuses a delivery signed by anything but the daemon this link paired with", function()
		-- Loopback is not an authentication boundary: any process on the machine can
		-- answer on 127.0.0.1. The MAC is what tells the daemon from everything else.
		local transport = pairedTransport()
		local forged = sealed("some-other-key", 1, "{}")
		local changeSet, reason = transport:unwrap(forged)
		t.isNil(changeSet)
		t.contains(reason, "did not come from the daemon")
		t.equal(transport._cursor, 0, "an unauthenticated delivery must not move the cursor")
	end)

	t.test("refuses a delivery whose payload was edited after it was signed", function()
		local transport, key = pairedTransport()
		local tampered = sealed(key, 1, "{}")
		tampered.payload = "{tampered}"
		local changeSet, reason = transport:unwrap(tampered)
		t.isNil(changeSet)
		t.contains(reason, "did not verify")
	end)

	t.test("refuses a delivery whose nonce was edited after it was signed", function()
		-- The MAC covers the nonce, or replay detection would be bypassable by
		-- editing one number.
		local transport, key = pairedTransport()
		local renumbered = sealed(key, 1, "{}")
		renumbered.nonce = 9
		local changeSet, reason = transport:unwrap(renumbered)
		t.isNil(changeSet)
		t.contains(reason, "did not verify")
	end)

	t.suite("Pairing — surviving a Studio restart")

	t.test("a link restored from settings resumes without a code", function()
		--[[
			Codes live ten minutes and are single-use, so a restart that asked for one
			again would be asking for something the user does not have. What Studio
			keeps is the link: its id, the key base64'd, the cursor and the outbound
			nonce (Config.SETTING).
		]]
		local crypto = fakeCrypto()
		local http = fakeHttp({ { status = 200, body = "pair-ok" } })
		local link = Pairing.pair(
			"http://127.0.0.1:9000",
			"ABCD2345",
			context(http, {}, { ["pair-ok"] = pairedResponse() })
		)

		-- What init.server.luau writes through plugin:SetSetting …
		local settings = {
			["forgebridge.linkId"] = link.linkId,
			["forgebridge.sessionKey"] = crypto.toBase64(link.sessionKey),
			["forgebridge.linkCursor"] = 12,
			["forgebridge.linkNonce"] = 3,
		}

		-- … and what it reads back on the next launch.
		local restoredKey = crypto.fromBase64(settings["forgebridge.sessionKey"])
		local pollHttp, calls = fakeHttp({ { status = 204 }, { status = 426 } })
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = pollHttp,
			scheduler = { spawn = function(fn)
				fn()
			end, wait = function() end },
			encodeJson = tostring,
			decodeJson = function()
				return {}
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
			linkId = settings["forgebridge.linkId"],
			sessionKey = restoredKey,
			crypto = crypto,
			cursor = settings["forgebridge.linkCursor"],
			outboundNonce = settings["forgebridge.linkNonce"],
		})
		transport:start()

		-- Resumed at the delivery it stopped at, not at the beginning: a link that
		-- restarts at 0 is re-offered every ChangeSet it has already applied.
		t.equal(calls[1].Url, "http://127.0.0.1:9000/v1/link/poll?since=12")
		t.equal(
			calls[1].Headers["X-ForgeBridge-Mac"],
			macOf(restoredKey, Transport.requestMacMessage({ LINK_ID, "GET", "/v1/link/poll", "12" }))
		)
		-- The restored key is byte-for-byte the derived one, or nothing it signs
		-- would verify.
		t.equal(restoredKey, link.sessionKey)
		t.equal(transport._lastNonce, 12, "a delivery at or below the restored cursor is still a replay")
	end)
end
