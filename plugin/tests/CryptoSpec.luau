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

	--[[
		=========================================================
		M19 — the ADR-014 v2 primitives.

		Same bar as the suites above and the same provenance rule: every constant
		here was lifted mechanically out of the RFC text, not retyped by hand. That
		is not fastidiousness. The first draft of this file WAS hand-typed, and
		three of its vectors were wrong in ways that made a correct implementation
		look broken — a dropped nibble in the ChaCha20 block, a doubled byte in
		Poly1305 A.3 #7, an extra byte in #10. A wrong vector and a wrong
		implementation fail identically, so the only safe move is to not transcribe.

		  - ChaCha20       RFC 8439 §2.3.2 (block) and §2.4.2 (the "sunscreen"
		                   encryption).
		  - Poly1305       RFC 8439 §2.5.2, plus ALL eleven appendix A.3 vectors.
		                   #5 through #11 are the ones that matter here: they exist
		                   specifically to catch partial reduction, an s-addition
		                   that overflows 2^128, an all-ones limb carrying, a result
		                   of exactly 2^130-5 and of exactly 2^130-6, and a 5*H+L
		                   reduction going to 131 bits. A limb layout that is subtly
		                   wrong passes §2.5.2 and fails these.
		  - AEAD           RFC 8439 §2.8.2.
		  - X25519         RFC 7748 §5.2 (both vectors, and the first iterated
		                   result) and §6.1 (the full Diffie-Hellman exchange).

		The last group is different in kind, and mirrors what the M18 suite does for
		the session key: it pins both primitives against `node:crypto`. Those
		numbers came out of Node, not out of this module, and they cover the block
		boundaries a hand-picked vector tends to miss — 0, 1, 15, 16, 17, 63, 64,
		65, 130 and 500 bytes.
		=========================================================
	]]

	t.suite("Crypto — ChaCha20 (RFC 8439)")

	t.test("produces the §2.3.2 keystream block", function()
		local key = ascending(0, 32)
		t.equal(toHex(Crypto.chacha20Block(key, 1, fromHex("000000090000004a00000000"))), "10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4ed2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e")
	end)

	--[[
		The counter is per block, so this is also the test that the second block of
		a message uses counter+1 and not counter — an implementation that reused one
		block would XOR the same keystream twice and leak the plaintext difference.
	]]
	t.test("encrypts the §2.4.2 sunscreen plaintext", function()
		local plaintext = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
		t.equal(
			toHex(Crypto.chacha20(ascending(0, 32), 1, fromHex("000000000000004a00000000"), plaintext)),
			"6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d"
		)
	end)

	t.test("is its own inverse", function()
		local key, nonce = ascending(7, 32), ascending(3, 12)
		local plaintext = string.rep("the quick brown fox ", 13)
		t.equal(Crypto.chacha20(key, 1, nonce, Crypto.chacha20(key, 1, nonce, plaintext)), plaintext)
	end)

	t.test("refuses a key or nonce of the wrong length", function()
		t.falsy(pcall(Crypto.chacha20Block, ascending(0, 31), 1, ascending(0, 12)))
		t.falsy(pcall(Crypto.chacha20Block, ascending(0, 32), 1, ascending(0, 8)))
		--- The control: the same call with both lengths right must succeed.
		t.truthy(pcall(Crypto.chacha20Block, ascending(0, 32), 1, ascending(0, 12)))
	end)

	t.suite("Crypto — Poly1305 (RFC 8439)")

	t.test("authenticates the §2.5.2 message", function()
		t.equal(
			toHex(Crypto.poly1305(fromHex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b"), "Cryptographic Forum Research Group")),
			"a8061dc1305136c6c22b8baf0c0127a9"
		)
	end)

	do
		--[[
			Appendix A.3, all eleven. Columns: name, one-time key, message, tag —
			all hex, message included, because #2 and #3 are 375-byte texts and a
			hex column is what the extraction produced.
		]]
		local A3 = {
			{ "#1", "0000000000000000000000000000000000000000000000000000000000000000", "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", "00000000000000000000000000000000" },
			{ "#2", "0000000000000000000000000000000036e5f6b5c5e06070f0efca96227a863e", "416e79207375626d697373696f6e20746f20746865204945544620696e74656e6465642062792074686520436f6e7472696275746f7220666f72207075626c69636174696f6e20617320616c6c206f722070617274206f6620616e204945544620496e7465726e65742d4472616674206f722052464320616e6420616e792073746174656d656e74206d6164652077697468696e2074686520636f6e74657874206f6620616e204945544620616374697669747920697320636f6e7369646572656420616e20224945544620436f6e747269627574696f6e222e20537563682073746174656d656e747320696e636c756465206f72616c2073746174656d656e747320696e20494554462073657373696f6e732c2061732077656c6c206173207772697474656e20616e6420656c656374726f6e696320636f6d6d756e69636174696f6e73206d61646520617420616e792074696d65206f7220706c6163652c207768696368206172652061646472657373656420746f", "36e5f6b5c5e06070f0efca96227a863e" },
			{ "#3", "36e5f6b5c5e06070f0efca96227a863e00000000000000000000000000000000", "416e79207375626d697373696f6e20746f20746865204945544620696e74656e6465642062792074686520436f6e7472696275746f7220666f72207075626c69636174696f6e20617320616c6c206f722070617274206f6620616e204945544620496e7465726e65742d4472616674206f722052464320616e6420616e792073746174656d656e74206d6164652077697468696e2074686520636f6e74657874206f6620616e204945544620616374697669747920697320636f6e7369646572656420616e20224945544620436f6e747269627574696f6e222e20537563682073746174656d656e747320696e636c756465206f72616c2073746174656d656e747320696e20494554462073657373696f6e732c2061732077656c6c206173207772697474656e20616e6420656c656374726f6e696320636f6d6d756e69636174696f6e73206d61646520617420616e792074696d65206f7220706c6163652c207768696368206172652061646472657373656420746f", "f3477e7cd95417af89a6b8794c310cf0" },
			{ "#4", "1c9240a5eb55d38af333888604f6b5f0473917c1402b80099dca5cbc207075c0", "2754776173206272696c6c69672c20616e642074686520736c6974687920746f7665730a446964206779726520616e642067696d626c6520696e2074686520776162653a0a416c6c206d696d737920776572652074686520626f726f676f7665732c0a416e6420746865206d6f6d65207261746873206f757467726162652e", "4541669a7eaaee61e708dc7cbcc5eb62" },
			{ "#5", "0200000000000000000000000000000000000000000000000000000000000000", "ffffffffffffffffffffffffffffffff", "03000000000000000000000000000000" },
			{ "#6", "02000000000000000000000000000000ffffffffffffffffffffffffffffffff", "02000000000000000000000000000000", "03000000000000000000000000000000" },
			{ "#7", "0100000000000000000000000000000000000000000000000000000000000000", "fffffffffffffffffffffffffffffffff0ffffffffffffffffffffffffffffff11000000000000000000000000000000", "05000000000000000000000000000000" },
			{ "#8", "0100000000000000000000000000000000000000000000000000000000000000", "fffffffffffffffffffffffffffffffffbfefefefefefefefefefefefefefefe01010101010101010101010101010101", "00000000000000000000000000000000" },
			{ "#9", "0200000000000000000000000000000000000000000000000000000000000000", "fdffffffffffffffffffffffffffffff", "faffffffffffffffffffffffffffffff" },
			{ "#10", "0100000000000000040000000000000000000000000000000000000000000000", "e33594d7505e43b900000000000000003394d7505e4379cd01000000000000000000000000000000000000000000000001000000000000000000000000000000", "14000000000000005500000000000000" },
			{ "#11", "0100000000000000040000000000000000000000000000000000000000000000", "e33594d7505e43b900000000000000003394d7505e4379cd010000000000000000000000000000000000000000000000", "13000000000000000000000000000000" },
		}
		--[[
			One test over eleven vectors rather than eleven tests, because
			scripts/__tests__/docs-claims.test.ts counts `t.test(` statically to
			check the figure quoted in CI and MILESTONES. A loop that generated
			tests would make that count silently wrong — which is the same class
			of defect that gate exists to catch. The per-row message below is what
			keeps a failure locatable.
		]]
		t.test("matches all eleven appendix A.3 vectors", function()
			for _, case in A3 do
				t.equal(toHex(Crypto.poly1305(fromHex(case[2]), fromHex(case[3]))), case[4], "A.3 vector " .. case[1])
			end
		end)
	end

	t.suite("Crypto — AEAD_CHACHA20_POLY1305 (RFC 8439)")

	t.test("seals the §2.8.2 vector", function()
		local ciphertext, tag = Crypto.aeadSeal(fromHex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f"), fromHex("070000004041424344454647"), fromHex("4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e"), fromHex("50515253c0c1c2c3c4c5c6c7"))
		t.equal(toHex(ciphertext), "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116")
		t.equal(toHex(tag), "1ae10b594f09e26a7e902ecbd0600691")
	end)

	t.test("opens what it sealed", function()
		local key, nonce, aad = ascending(1, 32), ascending(9, 12), "link:lnk_7Q2W"
		local plaintext = "{\"op\":\"setProperty\"}"
		local ciphertext, tag = Crypto.aeadSeal(key, nonce, plaintext, aad)
		t.equal(Crypto.aeadOpen(key, nonce, ciphertext, tag, aad), plaintext)
	end)

	--[[
		The four ways a delivery can be tampered with, each of which must return nil
		and not a plaintext. A `nil` here is the whole security property of the
		construction: an AEAD that returned bytes on a bad tag would be a stream
		cipher with a decorative checksum.
	]]
	t.test("refuses a flipped tag, ciphertext, AAD or key", function()
		local key, nonce, aad = ascending(1, 32), ascending(9, 12), "link:lnk_7Q2W"
		local plaintext = "apply this changeset"
		local ciphertext, tag = Crypto.aeadSeal(key, nonce, plaintext, aad)

		local badTag = string.char(bit32.bxor(string.byte(tag, 1), 1)) .. string.sub(tag, 2)
		t.isNil(Crypto.aeadOpen(key, nonce, ciphertext, badTag, aad), "a flipped tag byte must not open")

		local badCipher = string.char(bit32.bxor(string.byte(ciphertext, 1), 1)) .. string.sub(ciphertext, 2)
		t.isNil(Crypto.aeadOpen(key, nonce, badCipher, tag, aad), "a flipped ciphertext byte must not open")

		t.isNil(Crypto.aeadOpen(key, nonce, ciphertext, tag, "link:lnk_ZZZZ"), "a substituted AAD must not open")
		t.isNil(Crypto.aeadOpen(ascending(2, 32), nonce, ciphertext, tag, aad), "another key must not open")

		--- The control test: none of the above rejected the legitimate delivery.
		t.equal(Crypto.aeadOpen(key, nonce, ciphertext, tag, aad), plaintext)
	end)

	t.test("seals an empty plaintext and an empty AAD", function()
		local key, nonce = ascending(4, 32), ascending(5, 12)
		local ciphertext, tag = Crypto.aeadSeal(key, nonce, "", "")
		t.equal(ciphertext, "")
		t.equal(#tag, 16)
		t.equal(Crypto.aeadOpen(key, nonce, ciphertext, tag, ""), "")
	end)

	t.suite("Crypto — constant-time comparison")

	t.test("matches equal strings and rejects unequal ones", function()
		t.truthy(Crypto.constantTimeEquals("abcdef", "abcdef"))
		t.falsy(Crypto.constantTimeEquals("abcdef", "abcdeg"), "a differing last byte")
		t.falsy(Crypto.constantTimeEquals("abcdef", "bbcdef"), "a differing first byte")
		t.falsy(Crypto.constantTimeEquals("abcdef", "abcde"), "a differing length")
		t.truthy(Crypto.constantTimeEquals("", ""))
	end)

	t.test("detects the all-zero shared secret", function()
		t.truthy(Crypto.isAllZero(string.rep("\0", 32)))
		t.falsy(Crypto.isAllZero(string.rep("\0", 31) .. "\1"))
	end)

	t.suite("Crypto — X25519 (RFC 7748)")

	t.test("computes the §5.2 vectors", function()
		t.equal(
			toHex(Crypto.x25519(fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"))),
			"c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"
		)
		t.equal(
			toHex(Crypto.x25519(fromHex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d"), fromHex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493"))),
			"95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957"
		)
	end)

	--[[
		§6.1: the whole point of the function. Both ends deriving the same secret
		from opposite halves is the property, and checking only the public keys
		would miss a ladder that was self-consistently wrong.
	]]
	t.test("agrees a shared secret both ways (§6.1)", function()
		local alice = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
		local bob = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
		local alicePublic = Crypto.x25519Base(alice)
		local bobPublic = Crypto.x25519Base(bob)
		t.equal(toHex(alicePublic), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
		t.equal(toHex(bobPublic), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
		t.equal(toHex(Crypto.x25519(alice, bobPublic)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
		t.equal(toHex(Crypto.x25519(bob, alicePublic)), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
	end)

	--[[
		RFC 7748 §5.2 also publishes the result of feeding the function back into
		itself. Both depths it gives are here; the constant picks which one runs.

		One at 1 rather than a second test at 1,000, because 1,000 rounds takes
		about twelve seconds against the ~250 ms the rest of this suite costs. It
		has been run at 1,000 and it passes — but that sentence is worth nothing
		on its own, which is why the vector is committed below and the change
		needed to check it is a single digit.
	]]
	local X25519_ITERATIONS = 1
	local ITERATED_RESULT = {
		[1] = "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079",
		[1000] = "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51",
	}

	t.test(string.format("matches the §5.2 iterated vector after %d round(s)", X25519_ITERATIONS), function()
		local k = fromHex("0900000000000000000000000000000000000000000000000000000000000000")
		local u = k
		for _ = 1, X25519_ITERATIONS do
			k, u = Crypto.x25519(k, u), k
		end
		t.equal(toHex(k), ITERATED_RESULT[X25519_ITERATIONS], "no published vector for this depth")
	end)

	--- RFC 7748 §5: bit 255 of the u-coordinate is not part of the value.
	t.test("ignores the high bit of the u-coordinate", function()
		local scalar = fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
		local u = fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
		local withHighBit = string.sub(u, 1, 31) .. string.char(bit32.bor(string.byte(u, 32), 0x80))
		t.falsy(u == withHighBit, "the fixture must actually differ, or this test proves nothing")
		t.equal(Crypto.x25519(scalar, u), Crypto.x25519(scalar, withHighBit))
	end)

	--[[
		Small-order inputs. RFC 7748 §6.1 says X25519 *produces* the all-zero value
		for these and that callers MAY check for it — so this module returns the
		zeros rather than raising, which is conformant and is NOT what `node:crypto`
		does (Node refuses the derivation outright). Anything that ever wires this
		up owes the check itself; `Crypto.isAllZero` is there for it.
	]]
	t.test("returns all-zero for small-order u, rather than raising", function()
		local scalar = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
		t.truthy(Crypto.isAllZero(Crypto.x25519(scalar, string.rep("\0", 32))), "u = 0")
		t.truthy(Crypto.isAllZero(Crypto.x25519(scalar, "\1" .. string.rep("\0", 31))), "u = 1")
		--- The control: an honest peer key does not look like a small-order one.
		t.falsy(Crypto.isAllZero(Crypto.x25519(scalar, Crypto.x25519Base(ascending(9, 32)))))
	end)

	t.test("refuses a scalar or u-coordinate of the wrong length", function()
		t.falsy(pcall(Crypto.x25519, ascending(0, 31), ascending(0, 32)))
		t.falsy(pcall(Crypto.x25519, ascending(0, 32), ascending(0, 33)))
		t.truthy(pcall(Crypto.x25519, ascending(0, 32), ascending(0, 32)))
	end)

	t.suite("Crypto — agreement with node:crypto")

	do
		--- Columns: alice scalar, bob scalar, alice public, bob public, shared.
		local AGREEMENTS = {
			{ "df34f6a23af55080b15931a7be58e53622e6036be17901d72c9f4ae3360428db", "3afe995bb16df5b05fb93d2aa1197d24a7d34356146f475d36a9b14bb5f1028a", "263ce8bfa41dda2ccb3151670c55dcb2a4b68c3ed97018b33938b84d905c676c", "3aef4290a65b3b007d736616bb5353cb5ba7466b4a99e7594c259075f396ca12", "82af3df1fe8c688bd962ba97be388cecc4d201bdd90c14c92cba5c1bc7b7eb07" },
			{ "f5ce7056f66dffe6ff45e1330f49d251e80e01e0def115f6d650aeb0017b6619", "c92b7a2e41a42b448c466b9f563baa941b643775248b5c2d4122d868e3ae8648", "a749833a95e0777917d706235b57e7bb101e7cbfe555eabd477bd639ec6e2918", "15ca6d90e2850dc0f12f1cf97c529ffa983e7b02ad233570ef10c61838ecb75f", "fa559135eba4b87a7355e2467b5d5e592762cd4afd04de851786840458cef948" },
			{ "9ff67b3eb26d03dac41303e3c59064d1a9ac52719f12540458efec69e2d32d7e", "1cd9ca07ce559bc2ffb1cb0f914ad6a1a9f20b563e5b9dbe60ed4a361cdef57d", "c2b8ee8075de567a851c813d1f2fcd792c5e2ff510bdbeab8a8dbf9466e80a45", "d2a900bedc6b9935c10cdf0d2e3cbdea7ef4b7b8330e8e8badcfbdb6d42e4739", "bc3dac4b512e81d5f664be9b97fc81cea6a1d1d2819ec3561d32614930460274" },
			{ "c8641059120d718c33fc333db95636a2e27df9cb85c592d83c7f4c6aad64fc00", "8c0af84ba08afc732975560955bca0891043812c6d4e7d4150d99bb4bd39e966", "63374d249ad11febe4209bfbc69be4b330beedd8eac165ca8d752ce636db4404", "1ad4fd6f27e2897aa82edaed07f6330a913bc77339852cc6ebe284d124d6a442", "47217a6ee5bf2938df4d1c13ba5c5936afac10b2d4aa4f214795a0108cb48f54" },
		}
		t.test("X25519 agrees with node:crypto on four key agreements", function()
			for i, case in AGREEMENTS do
				local label = string.format("agreement #%d", i)
				t.equal(toHex(Crypto.x25519Base(fromHex(case[1]))), case[3], label .. " alice public")
				t.equal(toHex(Crypto.x25519Base(fromHex(case[2]))), case[4], label .. " bob public")
				t.equal(toHex(Crypto.x25519(fromHex(case[1]), fromHex(case[4]))), case[5], label .. " shared from alice")
				t.equal(toHex(Crypto.x25519(fromHex(case[2]), fromHex(case[3]))), case[5], label .. " shared from bob")
			end
		end)
	end

	do
		--- Columns: key, nonce, AAD, plaintext, ciphertext, tag.
		local SEALS = {
			{ "6e80ea31247a32efe4da6043fe1e399d383fd025ba4f90fa6c570feb405af7a6", "fb9157bb0a55c40a6d9838f9", "", "", "", "f9619cc0aba75f576bc6d5090d683fd9" },
			{ "9c490431555c14ed2b088c121be64e67a407b03471512d54a3954ceb2cc45cef", "3275446b4c7d31ad8d9ba36f", "f3", "87", "a6", "5166ac825d69ae5dc41db3e2272930db" },
			{ "4eb029731041bd3e92804dd98c9ee9afe93303d5d1ff3c2523b3d09cfcdc0d15", "ed71ba1d58de56b19fdf2036", "5d", "1b00aacf8f4f26f4d2f37382704dd2", "afcebfa1492f24a4346fdadc6a5e2b", "8cbaf6654b10cf099991cfb9a49cb147" },
			{ "8ad65f259a7a23115271d1b6af0882d5a8edd4189b64a4c6b829d4c83f557671", "1fd5d4cf07ad89fa056c068b", "980a", "0ad1d21cf7ea31102b0a9a7fa27eb416", "e3ca7fe7a8ab6a63966fb29dc4adcd35", "a2aa89d7e9c04191f35512165c2e890b" },
			{ "a20692df911ae96b82d9e8a8cf828e564cdea19726bc2bd3fe02342df92dd270", "d0bd4158f1436bef4458637a", "dea487", "3f98275b2bb6482bc217d90bbd60d8a71a", "3667fe6bf0650040ddf95ee6e61a2452e0", "68873913afb3cfcfed3168ee6b44027c" },
			{ "38cb6c24ee0806c3fd32b8b82a5cd57f1adb6d7b889bfb608d73dc494bf9385e", "c0d23531700842e8602b613c", "", "03ed8f5cd4d7a3e54b63d79ceee833b10775a593c18606c8dfbf3a7aa51458d81514414b204d79bab39e05401cc511d0954fee6671c0c000b27805dfc4f2ed", "afe54d6f69567fd8958eb61ff05684daaf345be4f66ac077c3b360db2de8fa94b0794e53be9f58ffb08c152c511b361d652c899deca2dc9f2383794cd82c4e", "21f6978495663ec26c58fcca6463e59c" },
			{ "f19ab53e844efc98ac3306a4be9cc3370f8aa191be5df406abb94997a17c4158", "3c56c6e4a2d88b9624d6fdd8", "2b", "bb9dd78771f6fa75d596f40a17cfd95829fc941bd198962d6c360ab8ad3b89f583f056b2d4c8d84ff7b0921569c8f53d6c124084bd79ff0c8026eea8117cda94", "f5fddd76c88738e361a23816f03b623168d333d35e7f1c2487b00ea512ce4b3b59ce62d76d00c077ac830b6a3c9a6c3f6edb1cd6ea274cf2b35b2309e7fc01c5", "92bfe198e4e6045f9fc38dcdc8a09ef0" },
			{ "5b9c76721c8c5d0b743fae09ee3f2d58c5dfe8039df9784cf90baa17c67d70ba", "eb20410508ce77809324122b", "4ed4", "080f8e16738c3e2358c8ceaa04e7f4bb6689631911be7d56ca612465c29eba0fc400f78827f12e03f6cf3d078d6a79d957e5ab699527342d9c7363cd5d12af5f9b", "2a2ab7d40f0f269caf12e54a0c4a3bc4968f08d2f5bccb04d772ae3b03e19a5ed236d4b6e4fde22be9bdb6045df46b290e85b64a4071e895335371f049ab2cad62", "e6563280080fc3f2efc6c70a5c57f2a8" },
			{ "2421716a4c553e9892c0b4a459d35cb12b18d43278e17dd61e8a9b394df092e7", "ad52af66e8896b409bc0c446", "ca396f58", "45d409dd1974ae9650ada0f999aa9906808f20ac5079e21db8bc71c20c8c670e2276db96c9051b49c920bff415cdba137ab55469491cc81d9d9c1d748fec3aa9d1262faf34bdb0878ae3ede56d247fecbcfa4ac9a9d5cde5013b4a29a7ab666697cbf4f6557274eab5be60063dbf1effcdb42036954f5e40bd15e67ea8033cdb63f3", "458030de97219d2d17b44bef0a25fa090ae94af5a02e3eae333dfd2c1e1912ad2fbcc85cbda3c967281c89b0338aae44ce402d59ac4d0f43a31d68adbd6673a848afa5d5378e422aed3ab1fd3f4423520128997c9e5e63cbef66452451b0d8895f34c479471fb45bba6d1f9ded3d319bba37c654f9c33f6dd73e7cca5b0d4f9812e8", "7f3b2189d50f03f3610cab1ee8fc2b53" },
			{ "1573cdf0fc5b3a443ecea5d635617955f7e4ffe783727795638863be28718c2a", "aa27616448d2bdbc7d54caa5", "45dacb", "bc2053ed60dac25fbe59f16364e27ed54078bcc3958a93900ead7c1d4431a25ecd2db391b5ebe936d11da1326f1336e24885a9eee9c327ea25275b261e41fe611c80a97ca49169a8c935fd49b69f50a0f78c3afd4f801450995ff6db5c26309756b73a7c344aefb043f080261028184c6861bf339a6f2e4c68df244ad0ac41aabdd1e8dd9461e8baa6713a8e4428993678aa405fe296af78c811c46b5dba1082b743df4334750f15e457f4acb6b968267ead1a3f4bf45b4a088e674c2054378fed5f94a665c57d067e2e3a79ded271e8ed975fcc20655632553d4cf182251b50bd6c04710eb2bf37ab9911ac2924986418e17dc938c7cdb5513c34658c06d902c1044b860a0f043dfbc445e96e9f235d841748853190f986396287aff1d2eba27cd1d9ea3f6ea14efe0bf7f23001cbfeabb3128ce2cf7e60b0914dc6fd5952ee292174d7ccdd72f738d5414613fd949e5000733255cef17e46967f9f05e913b37fbc2ac10dcdc980a3e763e152f893095b5bbc466e83638ece8d7f93f67695532f2a88da11e4fbbd9cbc19ccca3feeb16c02e88155162ed230c083bde282ebcfbd1693a46e20040a21e2f379cb42e725897d51b0a5e79ce4188a58f500efedbc8f722282ecc33d8d8df49a12527dac5aed65659ee28de57266354b154323efaf885afb038d31d0df387ed5d212b396703c7e39de", "3305d751b788a3c8ded79fa541055521c43eb254366ac16d202280c84e6b1ed320e9a7afca24bc7ceabcea1964518c863b3303ae92922865ba9adee4d9d0f31a215fc24f014358263f69bf86c613053b290d86d87a41ffc2eed753e18204ae2c408c12ab1597787aba6278a0887fa2e7a5ef2eb120d78a7f607040a99d3d966556f405e8429280ce56698bde4c061589fb29ae9fa3d449c07c8f65bdf1e9a4ee694ad4ec121dd6b67f660296b95a416b19165d467cc9802271211c15c5c0ea3998700fda0345aaf62f99673aa9520daa5b2ebaecb95a6665522d0ef22324becbdbafa4bd21797a7884e62bd251143d6a084cdb3e284d752eb7ddcc024bcd3f4930f6100cabd1a5d727e19224ce79ffffd2f1914356983e3b0f19bd2b3eb2ed2acc26566ba95fcdfed665554f0a239024c85aee2e9fa6e04423e9fdeab38977de6f3b033bbadf5e3b355a23be0fdc3f339019fc2b3c413dcdcb90aa5a1b7fc992721feb909f7aa2c63da084b3a5b24194e33f3c6e9cdbdb9f43417a6055915f79b2912c841491c764f35f1c4d451cc0226c20c6bc6d3ee2a70d803b91d63a01c45bb043415fbf3291587971a74c7fbf6815de85661abdc026d10b65077972ee17b1c6770fcc5c7893aceb7c6ef9bf6c8d5acd36fcf3b00b0c5bca1d5fc0eb813e74d0fab237211c3bb0d973345a4c4b16b8e9c877", "91f7cdc106f64c6c6fc7e05edc4da651" },
		}
		t.test("AEAD agrees with node:crypto across ten payload sizes", function()
			for _, case in SEALS do
				local label = string.format("%d plaintext bytes", #case[4] // 2)
				local ciphertext, tag = Crypto.aeadSeal(fromHex(case[1]), fromHex(case[2]), fromHex(case[4]), fromHex(case[3]))
				t.equal(toHex(ciphertext), case[5], label .. " ciphertext")
				t.equal(toHex(tag), case[6], label .. " tag")
				t.equal(Crypto.aeadOpen(fromHex(case[1]), fromHex(case[2]), ciphertext, tag, fromHex(case[3])), fromHex(case[4]), label .. " round trip")
			end
		end)
	end

	t.suite("Crypto — M19 did not ship")

	--[[
		These are not decoration and they are not a formality. The M19 outcome is
		that the arithmetic above is correct and the FEATURE is still unavailable,
		because a Studio plugin has no documented CSPRNG. That is a fact about this
		module which a future change could silently reverse — by adding a
		`randomBytes` built on `math.random`, or by flipping `E2E.AVAILABLE` to true
		while nothing else changed — and either would produce a plugin that claims
		end-to-end encryption and does not have it.
	]]
	t.test("exposes no key generation", function()
		t.isNil((Crypto :: any).randomBytes, "a CSPRNG this module does not have must not appear to exist")
		t.isNil((Crypto :: any).generateKeyPair, "a keypair needs a CSPRNG; see ADR-014")
		t.isNil((Crypto :: any).generatePrivateKey)
	end)

	t.test("reports end-to-end encryption as unavailable", function()
		t.falsy(Crypto.E2E.AVAILABLE, "flipping this without a CSPRNG would make the posture string a lie")
		t.contains(Crypto.E2E.BLOCKER, "CSPRNG")
		t.contains(Crypto.E2E.SEE, "adr-014")
	end)

end
