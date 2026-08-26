--!nonstrict
local Transport = require("../src/Transport")

local function response(status, body, headers)
	return { ok = true, statusCode = status, body = body, headers = headers or {} }
end

local function newTransport(baseUrl)
	return Transport.new({
		baseUrl = baseUrl,
		http = {},
		scheduler = { spawn = function() end, wait = function() end },
		encodeJson = function(value)
			return tostring(value)
		end,
		-- `unwrap` decodes `envelope.payload` into a `DeliveryPayload` — the tagged
		-- union `packages/daemon/src/wire.ts` puts on the wire, not a bare ChangeSet.
		decodeJson = function(text)
			if text == "{bad}" then
				error("not json")
			end
			if text == "{rollback}" then
				return { kind = "rollback", journalId = "j", changeSetId = "cs", expectedVersion = 4 }
			end
			if text == "{untagged}" then
				return { id = "cs", payloadText = text }
			end
			return { kind = "changeset", changeSet = { id = "cs", payloadText = text } }
		end,
		pluginVersion = "0.1.0-test",
		protocolVersion = "1.0.0",
		protocolMajor = 1,
		pluginVersionHeader = "X-ForgeBridge-Plugin",
		protocolVersionHeader = "X-ForgeBridge-Protocol",
	})
end

return function(t)
	t.suite("Transport — base URL policy")

	t.test("accepts a loopback daemon over http", function()
		local parts, err = Transport.parseBaseUrl("http://127.0.0.1:9000")
		t.isNil(err)
		t.truthy(parts.loopback)
		t.equal(Transport.transportKind(parts), "local-daemon")
	end)

	t.test("treats localhost and ::1 as loopback", function()
		local localhost: any = Transport.parseBaseUrl("http://localhost:9000")
		local ipv6: any = Transport.parseBaseUrl("http://[::1]:9000")
		t.truthy(localhost.loopback)
		t.truthy(ipv6.loopback)
	end)

	t.test("does not mistake a lookalike host for loopback", function()
		-- A prefix match would call this loopback and then allow cleartext to it.
		local parts, err = Transport.parseBaseUrl("http://127.0.0.1.example.com:9000")
		t.isNil(parts)
		t.contains(err, "must be https")
	end)

	t.test("refuses cleartext to a remote host", function()
		local parts, err = Transport.parseBaseUrl("http://relay.example.org")
		t.isNil(parts)
		t.contains(err, "will not send changes in the clear")
	end)

	t.test("accepts a remote relay over https and names it a relay", function()
		local parts, err = Transport.parseBaseUrl("https://relay.example.org")
		t.isNil(err)
		t.falsy(parts.loopback)
		t.equal(Transport.transportKind(parts), "relay-tls")
	end)

	t.test("never claims end-to-end encryption it does not implement", function()
		t.equal(Transport.transportKind((Transport.parseBaseUrl("https://relay.example.org"))), "relay-tls")
	end)

	t.test("refuses credentials in the URL and unknown schemes", function()
		local _, credentials = Transport.parseBaseUrl("https://user:pass@relay.example.org")
		t.contains(credentials, "credentials")
		local _, scheme = Transport.parseBaseUrl("ws://127.0.0.1:9000")
		t.contains(scheme, "not a scheme")
		local _, blank = Transport.parseBaseUrl("")
		t.contains(blank, "no base URL")
	end)

	t.test("trims a trailing slash so paths do not double up", function()
		local parts: any = Transport.parseBaseUrl("http://127.0.0.1:9000/")
		t.equal(parts.base, "http://127.0.0.1:9000")
	end)

	t.test("refuses deliveries from a relay until authenticated delivery exists", function()
		local allowed, reason = Transport.deliveryGate((Transport.parseBaseUrl("https://relay.example.org")))
		t.falsy(allowed)
		t.contains(reason, "M18")
		t.truthy(Transport.deliveryGate((Transport.parseBaseUrl("http://127.0.0.1:9000"))))
	end)

	t.test("MAC verification is honestly unimplemented", function()
		local verified, reason = Transport.verifyMac({ mac = "whatever" }, "key")
		t.falsy(verified)
		t.contains(reason, "M18")
	end)

	t.suite("Transport — response classification")

	t.test("200 with a body is a delivery", function()
		t.equal(Transport.classify(response(200, { nonce = 1 }), 1).action, "delivery")
	end)

	t.test("204 is an empty long poll, not a failure", function()
		t.equal(Transport.classify(response(204), 1).action, "empty")
	end)

	t.test("426 stops the loop rather than applying what it understands", function()
		local verdict = Transport.classify(response(426, { code = "unsupported_version", message = "update the plugin" }), 1)
		t.equal(verdict.action, "update-required")
		t.contains(verdict.reason, "update the plugin")
	end)

	t.test("a protocol major mismatch is treated as 426 whatever the status", function()
		local verdict = Transport.classify(response(200, { nonce = 1 }, { ["x-forgebridge-protocol"] = "2.0.0" }), 1)
		t.equal(verdict.action, "update-required")
		t.contains(verdict.reason, "protocol v2")
	end)

	t.test("a matching protocol version is not a mismatch", function()
		t.equal(Transport.classify(response(204, nil, { ["X-ForgeBridge-Protocol"] = "1.4.0" }), 1).action, "empty")
	end)

	t.test("409 is an unpaired link, 401 is an unauthenticated one", function()
		t.equal(Transport.classify(response(409, { code = "link_unpaired" }), 1).action, "unpaired")
		t.equal(Transport.classify(response(401, { code = "link_unauthenticated" }), 1).action, "unauthenticated")
	end)

	t.test("a replay rejection is not retried as if it were an outage", function()
		t.equal(Transport.classify(response(409, { code = "replay_detected" }), 1).action, "refuse")
	end)

	t.test("429 honours Retry-After", function()
		local verdict = Transport.classify(response(429, { code = "rate_limited" }, { ["Retry-After"] = "12" }), 1)
		t.equal(verdict.action, "rate-limited")
		t.equal(verdict.retryAfter, 12)
	end)

	t.test("5xx and network failures retry", function()
		t.equal(Transport.classify(response(503, {}), 1).action, "retry")
		t.equal(Transport.classify({ ok = false, transportError = "timeout" }, 1).action, "retry")
	end)

	t.test("a 200 that is not JSON is retried rather than half-read", function()
		t.equal(Transport.classify(response(200, nil), 1).action, "retry")
	end)

	t.suite("Transport — backoff")

	t.test("grows and then caps", function()
		local options = { base = 1, factor = 2, max = 10, jitter = 0, random = function() return 0.5 end }
		t.equal(Transport.nextBackoff(1, options), 1)
		t.equal(Transport.nextBackoff(2, options), 2)
		t.equal(Transport.nextBackoff(3, options), 4)
		t.equal(Transport.nextBackoff(10, options), 10)
	end)

	t.test("stays inside the jitter band", function()
		local options = { base = 4, factor = 2, max = 30, jitter = 0.25, random = function() return 0 end }
		local low = Transport.nextBackoff(1, options)
		options.random = function() return 1 end
		local high = Transport.nextBackoff(1, options)
		t.equal(low, 3)
		t.equal(high, 5)
	end)

	t.suite("Transport — delivery envelopes")

	t.test("accepts a fresh delivery and advances the cursor", function()
		local transport = newTransport("http://127.0.0.1:9000")
		local changeSet, err = transport:unwrap({ linkId = "l", nonce = 7, payload = "{}", encrypted = false })
		t.isNil(err)
		t.truthy(changeSet)
		t.equal(transport._cursor, 7)
	end)

	t.test("drops a replayed delivery", function()
		local transport = newTransport("http://127.0.0.1:9000")
		transport:unwrap({ nonce = 7, payload = "{}" })
		local changeSet, err = transport:unwrap({ nonce = 7, payload = "{}" })
		t.isNil(changeSet)
		t.contains(err, "replayed delivery")

		local older, olderErr = transport:unwrap({ nonce = 3, payload = "{}" })
		t.isNil(older)
		t.contains(olderErr, "replayed delivery")
	end)

	t.test("refuses a delivery addressed to another link", function()
		local transport = newTransport("http://127.0.0.1:9000")
		transport.linkId = "mine"
		local changeSet, err = transport:unwrap({ linkId = "theirs", nonce = 1, payload = "{}" })
		t.isNil(changeSet)
		t.contains(err, "different link")
	end)

	t.test("refuses ciphertext it cannot decrypt instead of guessing", function()
		local transport = newTransport("http://127.0.0.1:9000")
		local changeSet, err = transport:unwrap({ nonce = 1, payload = "base64", encrypted = true })
		t.isNil(changeSet)
		t.contains(err, "M19")
	end)

	t.suite("Transport — the poll loop")

	--- A transport wired to a scripted sequence of responses, run synchronously.
	local function looping(responses)
		local calls = 0
		local waits = 0
		local transport = Transport.new({
			baseUrl = "http://127.0.0.1:9000",
			http = {
				RequestAsync = function(_, _request)
					calls += 1
					local scripted = responses[math.min(calls, #responses)]
					return {
						StatusCode = scripted.status,
						Headers = scripted.headers or {},
						Body = scripted.body or "",
					}
				end,
			},
			scheduler = {
				spawn = function(fn)
					fn()
				end,
				wait = function()
					waits += 1
				end,
			},
			encodeJson = function(value)
				return tostring(value)
			end,
			-- Called twice per delivery: once on the HTTP body to get the envelope,
			-- once on `envelope.payload` to get the tagged DeliveryPayload.
			decodeJson = function(text)
				if text == "envelope" then
					return { decoded = text, nonce = 1, payload = "payload" }
				end
				return { kind = "changeset", changeSet = { id = "cs" } }
			end,
			pluginVersion = "0.1.0-test",
			protocolVersion = "1.0.0",
			protocolMajor = 1,
			pluginVersionHeader = "X-ForgeBridge-Plugin",
			protocolVersionHeader = "X-ForgeBridge-Protocol",
			backoff = { base = 1, factor = 2, max = 4, jitter = 0, random = function()
				return 0.5
			end },
		})
		return transport, function()
			return calls, waits
		end
	end

	t.test("a 426 stops the loop dead rather than retrying or applying a subset", function()
		local delivered = 0
		local transport, counters = looping({ { status = 426, body = "{}" } })
		transport.onChangeSet = function()
			delivered += 1
		end
		transport:start()

		local calls = counters()
		t.equal(calls, 1, "it must not keep polling a server it cannot understand")
		t.equal(delivered, 0)
		t.equal(transport.state, "update-required")
		t.falsy(transport._running)
	end)

	t.test("a refused delivery backs off instead of spinning", function()
		local transport, counters = looping({ { status = 200, body = "envelope" } })
		local seen = 0
		transport.onChangeSet = function()
			seen += 1
		end
		-- The first delivery is accepted; the second is the same nonce replayed, and
		-- the cursor has not moved, so without a backoff this would be a hot loop.
		local realWait = transport.scheduler.wait
		local stops = 0
		transport.scheduler.wait = function(...)
			stops += 1
			realWait(...)
			if stops >= 3 then
				transport:stop()
			end
		end
		transport:start()

		local _, waits = counters()
		t.equal(seen, 1, "only the first delivery is fresh")
		t.truthy(waits >= 3, "every refusal has to wait")
	end)

	t.test("a handler that throws does not take the poll loop with it", function()
		local transport, counters = looping({ { status = 200, body = "envelope" } })
		transport.onChangeSet = function()
			-- Anything in the apply path: a Roblox error out of a raw property
			-- assignment, a nil index in the widget. Called raw, this used to unwind
			-- the loop and leave the user with a link that had silently stopped.
			error("boom while applying")
		end

		local seenState, seenReason
		transport.scheduler.wait = function()
			seenState, seenReason = transport.state, transport.stateReason
			transport:stop()
		end
		transport:start()

		local calls = counters()
		t.truthy(calls >= 1)
		t.equal(seenState, "error", "the loop has to survive and say what went wrong")
		t.contains(seenReason, "boom while applying")
	end)

	t.test("refuses to start against a relay it cannot authenticate", function()
		local transport = Transport.new({
			baseUrl = "https://relay.example.org",
			http = {},
			scheduler = { spawn = function()
				error("the loop must not start")
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
		})
		local started, reason = transport:start()
		t.falsy(started)
		t.equal(transport.state, "blocked")
		t.contains(reason, "local daemon")
	end)

	t.suite("Transport — delivery envelopes, continued")

	t.test("refuses a rollback it cannot execute, and does not skip past it", function()
		local transport = newTransport("http://127.0.0.1:9000")
		local changeSet, err = transport:unwrap({ nonce = 5, payload = "{rollback}" })
		t.isNil(changeSet)
		t.contains(err, "M11")
		-- The cursor must not move: a rollback silently skipped is a user watching
		-- for a restore that will never come.
		t.equal(transport._cursor, 0)
	end)

	t.test("refuses an untagged payload rather than treating it as a ChangeSet", function()
		local transport = newTransport("http://127.0.0.1:9000")
		local changeSet, err = transport:unwrap({ nonce = 5, payload = "{untagged}" })
		t.isNil(changeSet)
		t.contains(err, "not a kind of payload")
	end)

	t.test("refuses a delivery with no nonce or an unreadable payload", function()
		local transport = newTransport("http://127.0.0.1:9000")
		local _, noNonce = transport:unwrap({ payload = "{}" })
		t.contains(noNonce, "no nonce")
		local _, badPayload = transport:unwrap({ nonce = 2, payload = "{bad}" })
		t.contains(badPayload, "not readable JSON")
	end)
end
