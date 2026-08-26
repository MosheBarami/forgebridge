--!strict
--[[
	Crypto — SHA-256, HMAC-SHA256 and HKDF-SHA256 in pure Luau.

	This module exists because of the gap ADR-014 names: Roblox Luau has no
	crypto standard library, and pairing needs a session key that BOTH ends can
	derive from the code the human carried across. The daemon derives its half
	with `node:crypto` (packages/daemon/src/pairing.ts). This file is the other
	half, and every value it produces must agree with that one byte for byte or
	the link 401s forever.

	`bit32` is what makes this tractable — SHA-256 is defined entirely in terms of
	32-bit rotates, shifts and adds, all of which Luau gives us natively. There is
	no arbitrary-precision arithmetic here and no field maths; that is precisely
	why ADR-014 chose an HMAC for v1 and deferred X25519 and an AEAD to v2 behind
	an external review. A hash and a MAC are the two primitives a careful reader
	can check against published vectors line by line, and tests/CryptoSpec.luau
	does exactly that: NIST for SHA-256, RFC 4231 for HMAC, RFC 5869 for HKDF.
	Nothing in that file was produced by running this code — a test that only
	proves an implementation agrees with itself proves nothing at all.

	Strings are the byte buffers. Luau strings are 8-bit clean, so a "raw" digest
	here is a 32-character string whose characters are the digest bytes, not hex.
	Callers that need to put a digest in JSON must run it through `toBase64` or
	`sha256Hex` first.

	Indexing note: Luau strings are 1-based and `string.byte(s, i, j)` is
	inclusive of both ends. Every loop below reads as `offset` .. `offset + 3` for
	a 4-byte word rather than `offset + 4`, which is the one off-by-one that would
	silently corrupt a digest.
]]

local Crypto = {}

local band, bxor, bnot = bit32.band, bit32.bxor, bit32.bnot
local rshift, rrotate = bit32.rshift, bit32.rrotate
local char, byte, rep, sub = string.char, string.byte, string.rep, string.sub

-- 2^32. Every intermediate sum is reduced by this rather than by `band(x, 0xffffffff)`
-- because the sums are computed as doubles first; a double holds the full 2^34-ish
-- intermediate exactly, so the modulo is lossless.
local MOD32 = 0x100000000

--[[
	The first 32 bits of the fractional parts of the cube roots of the first 64
	primes (FIPS 180-4 §4.2.2). A single wrong digit anywhere in this table
	changes every digest, which is why the "abc" vector in the spec is worth more
	than any amount of staring at these numbers.
]]
local K = table.freeze({
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
})

-- Fractional parts of the square roots of the first 8 primes (FIPS 180-4 §5.3.3).
local H_INIT = table.freeze({
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
})

local BLOCK_BYTES = 64
local DIGEST_BYTES = 32

--[[
	Mirrors the constants in packages/daemon/src/pairing.ts. They are duplicated
	rather than derived because the two halves of this protocol are written in
	different languages and there is no shared header to import — so they are
	named here, next to the code that depends on them, where a mismatch is at
	least visible to a reader comparing the two files.
]]
Crypto.KEY_BYTES = 32
Crypto.SALT_BYTES = 32
Crypto.KEY_ID_CHARS = 22

--[[
	The pairing key-derivation labels, byte for byte as the daemon writes them.
	The trailing "|" before the linkId is part of the info string, not a
	separator this code adds.
]]
local SESSION_KEY_INFO_PREFIX = "forgebridge/v1 session key|"
local SESSION_KEY_ID_PREFIX = "forgebridge/v1/session-key-id"

local function beU32(value: number): string
	return char(band(rshift(value, 24), 0xff), band(rshift(value, 16), 0xff), band(rshift(value, 8), 0xff), band(value, 0xff))
end

--[[
	The FIPS 180-4 padding: a single 0x80 byte, zeros up to 56 mod 64, then the
	message length in BITS as a 64-bit big-endian integer.

	The length is split rather than computed as `length * 8` in one go because a
	Luau number is a double: `length * 8` stays exact well past any plausible
	message, but the high word still has to come from a division, and doing it in
	two halves keeps both words provably below 2^32.
]]
local function padding(length: number): string
	local zeros = (55 - length) % BLOCK_BYTES
	local high = math.floor(length / 0x20000000)
	local low = (length % 0x20000000) * 8
	return "\128" .. rep("\0", zeros) .. beU32(high) .. beU32(low)
end

--[[
	Raw 32-byte SHA-256 digest.

	The whole padded message is materialised as one string. That is the wrong
	trade for hashing a large file and the right one here: every input this
	plugin hashes is a pairing code, a 32-byte key, or a delivery payload, and a
	streaming API would add state that the pairing path has no use for.
]]
function Crypto.sha256(message: string): string
	local data = message .. padding(#message)
	local h1, h2, h3, h4 = H_INIT[1], H_INIT[2], H_INIT[3], H_INIT[4]
	local h5, h6, h7, h8 = H_INIT[5], H_INIT[6], H_INIT[7], H_INIT[8]

	-- Allocated once per digest and reused across blocks. Not shared between
	-- calls: `hmacSha256` runs two digests, and a shared scratch table is the
	-- kind of coupling that only breaks once something nests.
	local w: { number } = table.create(64, 0)

	for base = 1, #data, BLOCK_BYTES do
		for i = 1, 16 do
			local offset = base + (i - 1) * 4
			local b1, b2, b3, b4 = byte(data, offset, offset + 3)
			w[i] = b1 * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4
		end

		for i = 17, 64 do
			local x, y = w[i - 15], w[i - 2]
			local s0 = bxor(rrotate(x, 7), rrotate(x, 18), rshift(x, 3))
			local s1 = bxor(rrotate(y, 17), rrotate(y, 19), rshift(y, 10))
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) % MOD32
		end

		local a, b, c, d, e, f, g, h = h1, h2, h3, h4, h5, h6, h7, h8

		for i = 1, 64 do
			local sigma1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
			local ch = bxor(band(e, f), band(bnot(e), g))
			local temp1 = (h + sigma1 + ch + K[i] + w[i]) % MOD32
			local sigma0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
			local maj = bxor(band(a, b), band(a, c), band(b, c))
			local temp2 = (sigma0 + maj) % MOD32

			h = g
			g = f
			f = e
			e = (d + temp1) % MOD32
			d = c
			c = b
			b = a
			a = (temp1 + temp2) % MOD32
		end

		h1 = (h1 + a) % MOD32
		h2 = (h2 + b) % MOD32
		h3 = (h3 + c) % MOD32
		h4 = (h4 + d) % MOD32
		h5 = (h5 + e) % MOD32
		h6 = (h6 + f) % MOD32
		h7 = (h7 + g) % MOD32
		h8 = (h8 + h) % MOD32
	end

	return beU32(h1) .. beU32(h2) .. beU32(h3) .. beU32(h4) .. beU32(h5) .. beU32(h6) .. beU32(h7) .. beU32(h8)
end

local HEX = "0123456789abcdef"

--[[
	Lowercase hex, to match every published vector and the daemon's
	`.digest('hex')`. Uppercase hex would compare unequal against both.
]]
function Crypto.sha256Hex(message: string): string
	local raw = Crypto.sha256(message)
	local out = table.create(#raw)
	for i = 1, #raw do
		local value = byte(raw, i) :: number
		out[i] = sub(HEX, rshift(value, 4) + 1, rshift(value, 4) + 1) .. sub(HEX, band(value, 0x0f) + 1, band(value, 0x0f) + 1)
	end
	return table.concat(out)
end

--[[
	HMAC-SHA256 (RFC 2104), raw 32-byte output.

	A key longer than the 64-byte block is hashed first and a shorter one is
	zero-padded — both are part of the construction, not an optimisation. The
	first is why RFC 4231 case 6 exists at all, and the second is why an empty
	key and a 64-zero-byte key are the same key. That second equivalence is not
	a curiosity: it is what lets `hkdfSha256` treat an absent salt and a
	HashLen-of-zeros salt as identical, exactly as RFC 5869 §2.2 requires.
]]
function Crypto.hmacSha256(key: string, message: string): string
	local block = key
	if #block > BLOCK_BYTES then
		block = Crypto.sha256(block)
	end
	if #block < BLOCK_BYTES then
		block ..= rep("\0", BLOCK_BYTES - #block)
	end

	local inner = table.create(BLOCK_BYTES)
	local outer = table.create(BLOCK_BYTES)
	for i = 1, BLOCK_BYTES do
		local value = byte(block, i) :: number
		inner[i] = char(bxor(value, 0x36))
		outer[i] = char(bxor(value, 0x5c))
	end

	return Crypto.sha256(table.concat(outer) .. Crypto.sha256(table.concat(inner) .. message))
end

--[[
	HKDF-SHA256 (RFC 5869): extract-then-expand.

	The extract step is what a naive implementation gets wrong, and it gets it
	wrong in the same way every time — by using the IKM as the HMAC key. It is
	the other way round: the SALT is the key and the IKM is the message. RFC 5869
	test case 3 is in the spec precisely because it pins that down with an empty
	salt, where the two are easiest to confuse.

	`length` is the number of output bytes. RFC 5869 caps it at 255 * HashLen;
	pairing asks for 32, so the cap is asserted rather than handled.
]]
function Crypto.hkdfSha256(ikm: string, salt: string, info: string, length: number): string
	if length <= 0 then
		error("hkdfSha256: length must be positive", 2)
	end
	local blocks = math.ceil(length / DIGEST_BYTES)
	if blocks > 255 then
		error("hkdfSha256: length exceeds 255 * 32 bytes", 2)
	end

	-- Extract. An empty salt is legal and means HashLen zero bytes; HMAC's own
	-- zero-padding of short keys already makes those two inputs identical, so
	-- this needs no special case — but say so, because the reader will wonder.
	local prk = Crypto.hmacSha256(salt, ikm)

	-- Expand. T(0) is empty and T(n) = HMAC(prk, T(n-1) || info || n), with the
	-- counter as one byte starting at 1 — not 0, which is the other classic slip.
	local out = table.create(blocks)
	local previous = ""
	for counter = 1, blocks do
		previous = Crypto.hmacSha256(prk, previous .. info .. char(counter))
		out[counter] = previous
	end

	return sub(table.concat(out), 1, length)
end

local STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

--[[
	One decode table for both alphabets. Decoding accepts "+/" and "-_"
	interchangeably on purpose: the daemon sends the pairing salt as standard
	base64 (`salt.toString('base64')` in packages/daemon/src/server.ts) but names
	keys in base64url, and a decoder that only spoke one of them would be a
	latent bug waiting for whichever field changed first.
]]
local DECODE: { [string]: number } = {}
for i = 1, 64 do
	DECODE[sub(STANDARD, i, i)] = i - 1
	DECODE[sub(URLSAFE, i, i)] = i - 1
end

local function encode(raw: string, alphabet: string, pad: boolean): string
	local out = table.create(math.ceil(#raw / 3))
	local index = 0

	for offset = 1, #raw, 3 do
		local b1, b2, b3 = byte(raw, offset, offset + 2)
		local triple = (b1 :: number) * 0x10000 + (if b2 then b2 * 0x100 else 0) + (b3 or 0)

		local c1 = band(rshift(triple, 18), 0x3f) + 1
		local c2 = band(rshift(triple, 12), 0x3f) + 1
		local c3 = band(rshift(triple, 6), 0x3f) + 1
		local c4 = band(triple, 0x3f) + 1

		index += 1
		if b3 then
			out[index] = sub(alphabet, c1, c1) .. sub(alphabet, c2, c2) .. sub(alphabet, c3, c3) .. sub(alphabet, c4, c4)
		elseif b2 then
			out[index] = sub(alphabet, c1, c1) .. sub(alphabet, c2, c2) .. sub(alphabet, c3, c3) .. (if pad then "=" else "")
		else
			out[index] = sub(alphabet, c1, c1) .. sub(alphabet, c2, c2) .. (if pad then "==" else "")
		end
	end

	return table.concat(out)
end

--- Standard base64 with "+/" and "=" padding — what `Buffer.toString('base64')` emits.
function Crypto.toBase64(raw: string): string
	return encode(raw, STANDARD, true)
end

--[[
	base64url with "-_" and NO padding — what Node's `.digest('base64url')`
	emits. The padding is dropped rather than translated: Node omits it, so a
	padded string would not compare equal to a session key id from the daemon.
]]
function Crypto.toBase64Url(raw: string): string
	return encode(raw, URLSAFE, false)
end

--[[
	Decode either alphabet, with or without padding.

	Raises on a character that is in neither alphabet. Returning nil would let a
	malformed salt flow onward as a silently wrong session key, and the failure
	would then surface as an unexplained 401 several steps away from its cause.
	Every call site in the transport already decodes inside a `pcall` (see
	Transport.luau), so an error here is reported, not fatal.
]]
function Crypto.fromBase64(encoded: string): string
	local out = table.create(math.ceil(#encoded / 4))
	local index = 0
	local accumulator = 0
	local bits = 0

	for i = 1, #encoded do
		local character = sub(encoded, i, i)
		if character == "=" then
			break
		end
		-- Whitespace is tolerated because base64 arrives wrapped often enough
		-- (headers, pasted text) that refusing a newline would be pedantry.
		if character == "\n" or character == "\r" or character == " " or character == "\t" then
			continue
		end

		local value = DECODE[character]
		if value == nil then
			error(string.format("fromBase64: %q is not a base64 character", character), 2)
		end

		accumulator = accumulator * 64 + value
		bits += 6
		if bits >= 8 then
			bits -= 8
			local shift = 2 ^ bits
			local octet = math.floor(accumulator / shift)
			accumulator -= octet * shift
			index += 1
			out[index] = char(octet)
		end
	end

	return table.concat(out)
end

--[[
	Every code point JavaScript's `\s` matches that Luau's `%s` does not, as the
	UTF-8 byte sequences a Luau pattern can actually see.

	This list is not decoration. The daemon strips whitespace with a JS regex,
	which is Unicode-aware; Luau's `%s` is ASCII-only. Paste a code out of a chat
	window or a rich-text doc and the space between the groups is quite often
	U+00A0, not U+0020 — the daemon would strip it, an ASCII-only plugin would
	not, and the two ends would derive different keys from the same eight
	characters the user read off the screen. That failure is invisible: pairing
	succeeds, every poll afterwards 401s, and nothing anywhere says why.

	Enumerated from the JS specification rather than guessed at: U+00A0, U+1680,
	U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. Note that
	JS `\s` does NOT include U+0085, so neither does this.
]]
local UNICODE_SPACE = table.freeze({
	"\194\160", -- U+00A0 no-break space
	"\225\154\128", -- U+1680 ogham space mark
	"\226\128[\128-\138\168\169\175]", -- U+2000-U+200A, U+2028, U+2029, U+202F
	"\226\129\159", -- U+205F medium mathematical space
	"\227\128\128", -- U+3000 ideographic space
	"\239\187\191", -- U+FEFF zero-width no-break space
})

--[[
	Uppercase, and drop the whitespace and hyphens people insert when reading a
	code aloud.

	This MUST match `normalisePairingCode` in packages/daemon/src/pairing.ts
	(`input.trim().toUpperCase().replace(/[\s-]/g, '')`) exactly. The daemon
	normalises before hashing the code, so a plugin that normalised differently
	would derive a different key from the same eight characters the user typed —
	and the failure would look like a wrong code, not like a bug.

	The daemon's `.trim()` is subsumed here: stripping all whitespace strips the
	leading and trailing whitespace too. `string.upper` is ASCII-only where
	JavaScript's `.toUpperCase()` is not, which costs nothing: PAIRING_ALPHABET
	in packages/protocol/src/link.ts is 30 ASCII characters, and anything left
	non-ASCII after this runs is a code the daemon will reject anyway.
]]
function Crypto.normalisePairingCode(input: string): string
	local value = string.upper(input)
	for _, pattern in UNICODE_SPACE do
		value = string.gsub(value, pattern, "")
	end
	return (string.gsub(value, "[%s%-]", ""))
end

--[[
	The session key both ends MAC under, derived from the pairing code.

	`salt` is RAW BYTES, not base64 — run the daemon's `sessionSalt` field
	through `fromBase64` first. Deriving from the code alone is deliberate and
	is argued in packages/daemon/src/pairing.ts: an attacker who guesses the code
	already holds the link, so the key adds no new weakness, and it is what makes
	the Luau side possible with only the HMAC it needs for the MAC anyway.
]]
function Crypto.deriveSessionKey(code: string, salt: string, linkId: string): string
	local info = SESSION_KEY_INFO_PREFIX .. linkId
	return Crypto.hkdfSha256(Crypto.normalisePairingCode(code), salt, info, Crypto.KEY_BYTES)
end

--[[
	A non-secret name for a key — safe to log, store and show in the widget.

	The truncation to 22 characters is the daemon's `KEY_ID_CHARS`, not a
	round number chosen here; 22 base64url characters is 132 bits, which is far
	more collision resistance than a handful of links on one machine needs.
]]
function Crypto.sessionKeyId(sessionKey: string): string
	local digest = Crypto.sha256(SESSION_KEY_ID_PREFIX .. sessionKey)
	return sub(Crypto.toBase64Url(digest), 1, Crypto.KEY_ID_CHARS)
end

return Crypto
