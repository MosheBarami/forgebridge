--!nonstrict
--[[
	Crypto — checked against PUBLISHED test vectors.

	ADR-014 says shipping an unreviewed crypto primitive is worse than shipping
	late, so the bar for src/Crypto.luau is not "it runs". It is "it agrees with
	the numbers other people published years ago, and this file shows the
	agreement". A test that asserted whatever the implementation happened to
	produce would prove only that the code agrees with itself, which is exactly
	the property a broken hash also has.

	Provenance of every constant below, so a reviewer can check them without
	trusting this file:

	  - SHA-256      FIPS 180-4 / the NIST example vectors (empty, "abc", the
	                 448-bit and 896-bit multi-block examples).
	  - HMAC-SHA256  RFC 4231 §4, test cases 1-7. Case 5 publishes only the
	                 128-bit truncation, so that is what case 5 asserts.
	  - HKDF-SHA256  RFC 5869 appendix A, test cases 1, 2 and 3 — including the
	                 PRK from the extract step, which is the value that catches
	                 an implementation that keyed the HMAC with the IKM instead
	                 of the salt.
	  - base64       RFC 4648 §10, which covers every padding length.

	The final group is different in kind and says so: it pins this module against
	packages/daemon/src/pairing.ts, the implementation it actually has to agree
	with. Those numbers came from running the daemon's own derivation under
	node:crypto, not from running this module.
]]

local Crypto = require("../src/Crypto")

local HEX = "0123456789abcdef"

local function toHex(raw: string): string
	local out = {}
	for i = 1, #raw do
		local value = string.byte(raw, i)
		local hi = math.floor(value / 16) + 1
		local lo = value % 16 + 1
		out[i] = string.sub(HEX, hi, hi) .. string.sub(HEX, lo, lo)
	end
	return table.concat(out)
end

local function fromHex(hex: string): string
	local out = {}
	for i = 1, #hex, 2 do
		out[#out + 1] = string.char(tonumber(string.sub(hex, i, i + 1), 16))
	end
	return table.concat(out)
end

--- `n` copies of a single byte, the shape most RFC 4231 keys and messages take.
local function bytes(value: number, count: number): string
	return string.rep(string.char(value), count)
end

--- An ascending byte run, e.g. RFC 4231 case 4's key and RFC 5869 case 2's inputs.
local function ascending(first: number, count: number): string
	local out = {}
	for i = 1, count do
		out[i] = string.char(first + i - 1)
	end
	return table.concat(out)
end

return function(t)
	t.suite("Crypto — SHA-256 (NIST vectors)")

	t.test("hashes the empty string", function()
		t.equal(Crypto.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
	end)

	t.test('hashes "abc"', function()
		t.equal(Crypto.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
	end)

	--[[
		56 bytes. This is the awkward length: the 0x80 byte plus the 8-byte
		length no longer fit in the block, so padding has to spill into a second
		one. An implementation that computed `(56 - length) % 64` instead of
		`(55 - length) % 64` passes every shorter vector and fails this one.
	]]
	t.test("hashes the 448-bit NIST example", function()
		t.equal(
			Crypto.sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
		)
	end)

	--- 112 bytes: two full blocks of message before any padding, so this is the
	--- one that proves the chaining between blocks carries the right state.
	t.test("hashes the 896-bit NIST example across blocks", function()
		t.equal(
			Crypto.sha256Hex(
				"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn"
					.. "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
			),
			"cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
		)
	end)

	t.test("returns a raw 32-byte digest, not hex", function()
		local raw = Crypto.sha256("abc")
		t.equal(#raw, 32)
		t.equal(toHex(raw), Crypto.sha256Hex("abc"))
	end)

	t.suite("Crypto — HMAC-SHA256 (RFC 4231)")

	t.test("case 1: 20-byte key, short message", function()
		t.equal(
			toHex(Crypto.hmacSha256(bytes(0x0b, 20), "Hi There")),
			"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
		)
	end)

	--- A 4-byte key, which is the short-key zero-padding path.
	t.test("case 2: short key", function()
		t.equal(
			toHex(Crypto.hmacSha256("Jefe", "what do ya want for nothing?")),
			"5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
		)
	end)

	t.test("case 3: 20-byte key, 50 bytes of 0xdd", function()
		t.equal(
			toHex(Crypto.hmacSha256(bytes(0xaa, 20), bytes(0xdd, 50))),
			"773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
		)
	end)

	t.test("case 4: 25-byte key 0x01..0x19, 50 bytes of 0xcd", function()
		t.equal(
			toHex(Crypto.hmacSha256(ascending(0x01, 25), bytes(0xcd, 50))),
			"82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"
		)
	end)

	--[[
		RFC 4231 publishes only the first 128 bits for case 5, so only the first
		128 bits are asserted. Writing the other half from memory would be
		inventing a "published" number, which is the one failure mode this file
		exists to avoid.
	]]
	t.test("case 5: truncated to 128 bits", function()
		t.equal(
			string.sub(toHex(Crypto.hmacSha256(bytes(0x0c, 20), "Test With Truncation")), 1, 32),
			"a3b6167473100ee06e0c796c2955552b"
		)
	end)

	--[[
		131 bytes of key — longer than the 64-byte block, so HMAC must hash the
		key down first. An implementation that merely truncated the key instead
		of hashing it produces a plausible-looking MAC and fails only here.
	]]
	t.test("case 6: key longer than the block is hashed first", function()
		t.equal(
			toHex(Crypto.hmacSha256(bytes(0xaa, 131), "Test Using Larger Than Block-Size Key - Hash Key First")),
			"60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
		)
	end)

	t.test("case 7: over-long key and over-long message", function()
		t.equal(
			toHex(Crypto.hmacSha256(
				bytes(0xaa, 131),
				"This is a test using a larger than block-size key and a larger than block-size data."
					.. " The key needs to be hashed before being used by the HMAC algorithm."
			)),
			"9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
		)
	end)

	t.suite("Crypto — HKDF-SHA256 (RFC 5869)")

	--[[
		The extract step asserted on its own. HKDF-Extract is
		HMAC(key = salt, message = IKM); getting the two arguments the wrong way
		round still yields 32 plausible bytes and still expands into a
		plausible-looking key, so the PRK is worth pinning separately from the
		OKM that follows it.
	]]
	t.test("case 1: PRK from the extract step", function()
		t.equal(
			toHex(Crypto.hmacSha256(fromHex("000102030405060708090a0b0c"), bytes(0x0b, 22))),
			"077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
		)
	end)

	t.test("case 1: 42 bytes of output", function()
		t.equal(
			toHex(Crypto.hkdfSha256(bytes(0x0b, 22), fromHex("000102030405060708090a0b0c"), fromHex("f0f1f2f3f4f5f6f7f8f9"), 42)),
			"3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
		)
	end)

	--[[
		82 bytes of output — three expand iterations, so this is the case that
		proves T(n) is fed back into T(n+1) and that the counter byte advances.
		An implementation that forgot the feedback produces the correct first 32
		bytes and garbage after them.
	]]
	t.test("case 2: longer inputs and multi-block output", function()
		t.equal(
			toHex(Crypto.hkdfSha256(ascending(0x00, 80), ascending(0x60, 80), ascending(0xb0, 80), 82)),
			"b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c"
				.. "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71"
				.. "cc30c58179ec3e87c14c01d5c1f3434f1d87"
		)
	end)

	--- The case naive implementations get wrong: no salt and no info.
	t.test("case 3: zero-length salt and info — PRK", function()
		t.equal(
			toHex(Crypto.hmacSha256("", bytes(0x0b, 22))),
			"19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04"
		)
	end)

	t.test("case 3: zero-length salt and info — 42 bytes of output", function()
		t.equal(
			toHex(Crypto.hkdfSha256(bytes(0x0b, 22), "", "", 42)),
			"8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
		)
	end)

	--[[
		RFC 5869 §2.2 says an absent salt is HashLen zero bytes. HMAC's own
		zero-padding of short keys makes those two inputs the same key, so this
		asserts an equivalence rather than a vector — and documents why
		hkdfSha256 needs no special case for an empty salt.
	]]
	t.test("an empty salt equals a 32-zero-byte salt", function()
		t.equal(
			Crypto.hkdfSha256(bytes(0x0b, 22), "", "", 42),
			Crypto.hkdfSha256(bytes(0x0b, 22), bytes(0x00, 32), "", 42)
		)
	end)

	t.test("refuses a length no HKDF can produce", function()
		t.falsy(pcall(Crypto.hkdfSha256, "ikm", "salt", "info", 0))
		t.falsy(pcall(Crypto.hkdfSha256, "ikm", "salt", "info", 255 * 32 + 1))
		t.truthy(pcall(Crypto.hkdfSha256, "ikm", "salt", "info", 255 * 32))
	end)

	t.suite("Crypto — base64 (RFC 4648)")

	--- RFC 4648 §10, which walks every remainder and so every padding length.
	t.test("encodes the RFC 4648 test vectors", function()
		t.equal(Crypto.toBase64(""), "")
		t.equal(Crypto.toBase64("f"), "Zg==")
		t.equal(Crypto.toBase64("fo"), "Zm8=")
		t.equal(Crypto.toBase64("foo"), "Zm9v")
		t.equal(Crypto.toBase64("foob"), "Zm9vYg==")
		t.equal(Crypto.toBase64("fooba"), "Zm9vYmE=")
		t.equal(Crypto.toBase64("foobar"), "Zm9vYmFy")
	end)

	t.test("decodes the RFC 4648 test vectors", function()
		t.equal(Crypto.fromBase64(""), "")
		t.equal(Crypto.fromBase64("Zg=="), "f")
		t.equal(Crypto.fromBase64("Zm8="), "fo")
		t.equal(Crypto.fromBase64("Zm9v"), "foo")
		t.equal(Crypto.fromBase64("Zm9vYg=="), "foob")
		t.equal(Crypto.fromBase64("Zm9vYmE="), "fooba")
		t.equal(Crypto.fromBase64("Zm9vYmFy"), "foobar")
	end)

	--[[
		0xfb 0xff selects sextets 62 and 63, the only two positions where the
		standard and URL-safe alphabets disagree. Without a case that reaches
		them, "+/" versus "-_" is untested and a session key id would compare
		unequal against the daemon's roughly one time in sixteen.
	]]
	t.test("distinguishes +/ from -_ on the 62nd and 63rd sextets", function()
		local raw = fromHex("fbff")
		t.equal(Crypto.toBase64(raw), "+/8=")
		t.equal(Crypto.toBase64Url(raw), "-_8")
	end)

	t.test("decodes both alphabets to the same bytes", function()
		t.equal(toHex(Crypto.fromBase64("+/8=")), "fbff")
		t.equal(toHex(Crypto.fromBase64("-_8")), "fbff")
	end)

	t.test("base64url carries no padding", function()
		t.equal(Crypto.toBase64Url("f"), "Zg")
		t.equal(Crypto.toBase64Url("fo"), "Zm8")
		t.equal(Crypto.toBase64Url("foo"), "Zm9v")
	end)

	--- Every byte value, so no character of either alphabet goes unexercised.
	t.test("round-trips all 256 byte values", function()
		local raw = ascending(0, 256)
		t.equal(Crypto.fromBase64(Crypto.toBase64(raw)), raw)
		t.equal(Crypto.fromBase64(Crypto.toBase64Url(raw)), raw)
	end)

	t.test("tolerates wrapped input but refuses a foreign character", function()
		t.equal(Crypto.fromBase64("Zm9v\nYmFy"), "foobar")
		t.falsy(pcall(Crypto.fromBase64, "Zm9v*YmFy"))
	end)

	t.suite("Crypto — pairing (must match packages/daemon/src/pairing.ts)")

	t.test("normalises a code the way the daemon does", function()
		t.equal(Crypto.normalisePairingCode("K7M2-PQR4"), "K7M2PQR4")
		t.equal(Crypto.normalisePairingCode("  k7m2 pqr4  "), "K7M2PQR4")
		t.equal(Crypto.normalisePairingCode("k7-m2-p q r4"), "K7M2PQR4")
		t.equal(Crypto.normalisePairingCode("\tK7M2\nPQR4\r"), "K7M2PQR4")
	end)

	--[[
		The daemon strips whitespace with a JavaScript regex, so its idea of
		whitespace is Unicode's, not ASCII's. A code pasted out of a chat window
		or a rich-text doc very often carries U+00A0 rather than U+0020 between
		the groups; if the plugin left it in place while the daemon removed it,
		pairing would succeed and every poll afterwards would 401, with nothing
		to point at. Each sequence below is the UTF-8 encoding of a code point
		JavaScript's `\s` matches — verified against `\s` itself, not assumed.
	]]
	t.test("strips the Unicode whitespace the daemon's regex strips", function()
		t.equal(Crypto.normalisePairingCode("K7M2\194\160PQR4"), "K7M2PQR4", "U+00A0 no-break space")
		t.equal(Crypto.normalisePairingCode("K7M2\225\154\128PQR4"), "K7M2PQR4", "U+1680 ogham space")
		t.equal(Crypto.normalisePairingCode("K7M2\226\128\128PQR4"), "K7M2PQR4", "U+2000 en quad")
		t.equal(Crypto.normalisePairingCode("K7M2\226\128\138PQR4"), "K7M2PQR4", "U+200A hair space")
		t.equal(Crypto.normalisePairingCode("K7M2\226\128\168PQR4"), "K7M2PQR4", "U+2028 line separator")
		t.equal(Crypto.normalisePairingCode("K7M2\226\128\175PQR4"), "K7M2PQR4", "U+202F narrow no-break space")
		t.equal(Crypto.normalisePairingCode("K7M2\226\129\159PQR4"), "K7M2PQR4", "U+205F medium math space")
		t.equal(Crypto.normalisePairingCode("K7M2\227\128\128PQR4"), "K7M2PQR4", "U+3000 ideographic space")
		t.equal(Crypto.normalisePairingCode("\239\187\191K7M2PQR4"), "K7M2PQR4", "U+FEFF byte order mark")
	end)

	--- U+0085 is whitespace to Unicode but NOT to JavaScript's `\s`, so the
	--- daemon keeps it and this module must keep it too. Stripping more than
	--- the daemon strips diverges just as badly as stripping less.
	t.test("keeps U+0085, which the daemon's regex does not match", function()
		t.equal(Crypto.normalisePairingCode("K7M2\194\133PQR4"), "K7M2\194\133PQR4")
	end)

	t.test("a code pasted with a no-break space derives the daemon's key", function()
		t.equal(
			toHex(Crypto.deriveSessionKey("K7M2\194\160PQR4", ascending(0x00, 32), "lnk_7Q2W")),
			"d6233d239334c84d03d469d4cf1af5f7df30e9dbe4467ccc115df3f0c689ee90"
		)
	end)

	--[[
		The cross-check. These three values are NOT from an RFC: they were
		produced by running the daemon's own deriveSessionKey and sessionKeyIdOf
		(packages/daemon/src/pairing.ts, node:crypto) over a fixed triple —
		code "K7M2-PQR4", a salt of the bytes 0x00..0x1f, and the link ids
		below. They are the only vectors that can catch this module being an
		internally consistent HKDF that nonetheless disagrees with the daemon,
		which is the failure that would leave the plugin 401ing forever.
	]]
	local SALT = ascending(0x00, 32)
	local CODE = "K7M2-PQR4"

	t.test("derives the session key the daemon derives", function()
		t.equal(
			toHex(Crypto.deriveSessionKey(CODE, SALT, "lnk_7Q2W")),
			"d6233d239334c84d03d469d4cf1af5f7df30e9dbe4467ccc115df3f0c689ee90"
		)
	end)

	t.test("names the key the way the daemon names it", function()
		t.equal(Crypto.sessionKeyId(Crypto.deriveSessionKey(CODE, SALT, "lnk_7Q2W")), "op-rSt04cJpqtS1VafhXiu")
	end)

	t.test("derives a 32-byte key", function()
		t.equal(#Crypto.deriveSessionKey(CODE, SALT, "lnk_7Q2W"), Crypto.KEY_BYTES)
		t.equal(Crypto.KEY_BYTES, 32)
	end)

	--[[
		The linkId is in the HKDF info, so two links paired from the same code
		and salt must not share a key. If they did, a delivery for one link would
		verify against the other — the cross-link injection ADR-014 names as one
		of the two attacks v1 exists to block.
	]]
	t.test("a different linkId gives a different key", function()
		local a = Crypto.deriveSessionKey(CODE, SALT, "lnk_7Q2W")
		local b = Crypto.deriveSessionKey(CODE, SALT, "lnk_ZZZZ")
		t.equal(#a, 32)
		t.equal(#b, 32)
		t.falsy(a == b, "two linkIds must not derive the same key")
		t.equal(toHex(b), "c58f690f1e4c115672c0eb77d1b02dd190816a2c10b3fc0aeadb4004431feff0")
	end)

	t.test("a different salt gives a different key", function()
		t.falsy(Crypto.deriveSessionKey(CODE, SALT, "lnk_7Q2W") == Crypto.deriveSessionKey(CODE, ascending(0x20, 32), "lnk_7Q2W"))
	end)

	t.test("a normalised code and its raw spelling derive the same key", function()
		t.equal(Crypto.deriveSessionKey("k7m2 pqr4", SALT, "lnk_7Q2W"), Crypto.deriveSessionKey("K7M2PQR4", SALT, "lnk_7Q2W"))
	end)

	--- The daemon sends the salt as standard base64; this is that round trip.
	t.test("decodes the salt the daemon puts on the wire", function()
		t.equal(Crypto.fromBase64("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="), SALT)
	end)

	t.test("a session key id is 22 base64url characters", function()
		local id = Crypto.sessionKeyId(Crypto.deriveSessionKey(CODE, SALT, "lnk_7Q2W"))
		t.equal(#id, Crypto.KEY_ID_CHARS)
		t.equal(Crypto.KEY_ID_CHARS, 22)
		t.falsy(string.find(id, "[^A-Za-z0-9_%-]"), "a key id must be safe to put in a URL or a log line")
	end)
end
