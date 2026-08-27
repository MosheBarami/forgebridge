--!strict
--[[
	Crypto — SHA-256, HMAC-SHA256, HKDF-SHA256, ChaCha20-Poly1305 and X25519
	in pure Luau.

	This module exists because of the gap ADR-014 names: Roblox Luau has no
	crypto standard library, and pairing needs a session key that BOTH ends can
	derive from the code the human carried across. The daemon derives its half
	with `node:crypto` (packages/daemon/src/pairing.ts). This file is the other
	half, and every value it produces must agree with that one byte for byte or
	the link 401s forever.

	`bit32` is what makes the first three tractable — SHA-256 is defined entirely
	in terms of 32-bit rotates, shifts and adds, all of which Luau gives us
	natively. That is why ADR-014 chose an HMAC for the v1 pairing: a hash and a
	MAC are primitives a careful reader can check against published vectors line
	by line, and tests/CryptoSpec.luau does exactly that — NIST for SHA-256,
	RFC 4231 for HMAC, RFC 5869 for HKDF, RFC 8439 for ChaCha20-Poly1305 and
	RFC 7748 for X25519. Nothing in that file was produced by running this code;
	a test that only proves an implementation agrees with itself proves nothing
	at all.

	THE FILE IS IN TWO HALVES AND THEY HAVE DIFFERENT STATUS. Everything up to
	`sessionKeyId` is M18: shipped, wired into Pairing.luau and Transport.luau,
	and exercised against a live daemon. Everything after it is the M19 spike —
	ChaCha20-Poly1305 and X25519, verified but deliberately not reachable from any
	transport, because a Studio plugin has no documented CSPRNG and so cannot
	generate a private key. The long comment above `chacha20Block` is the part to
	read before using any of it, and `Crypto.E2E.AVAILABLE` is false.

	Strings are the byte buffers throughout — keys, nonces, digests, ciphertext.
	Luau strings are 8-bit clean, so a "raw" digest here is a 32-character string
	whose characters are the digest bytes, not hex.
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

--[[
	================================================================
	M19 — the ADR-014 v2 primitives: ChaCha20-Poly1305 and X25519.

	READ THIS BEFORE CALLING ANYTHING BELOW.

	Everything from here down is verified against published test vectors
	(RFC 8439 and RFC 7748, in tests/CryptoSpec.luau) and against `node:crypto`
	byte for byte. It is nevertheless NOT WIRED INTO ANY TRANSPORT, and calling
	it does not give this plugin end-to-end encryption. ADR-014 records why in
	full; the short version is one sentence:

	    An AEAD and a key agreement are useless without a secret nobody else can
	    predict, and a Roblox Studio plugin has no documented source of one.

	Roblox's published API reference documents no cryptographic-randomness
	guarantee for `math.random`, for `Random.new()`, or for
	`HttpService:GenerateGUID` — it does not describe the algorithm, the seeding,
	or the entropy source of any of them. "Undocumented" is not "secure": under
	the fail-closed rule this repository runs on, an unproven CSPRNG and no
	CSPRNG are the same answer.

	That is why this module deliberately offers NO key generation. There is no
	`Crypto.randomBytes` and no `Crypto.generateKeyPair`, and their absence is
	the safety property: a caller cannot complete an X25519 handshake here
	without supplying a scalar from somewhere, which forces whoever tries to
	confront where it came from instead of getting a plausible-looking keypair
	from a PRNG seeded off the clock.

	Deriving the consumer's private key from the pairing code instead does not
	work either, and it is worth writing down so nobody re-invents it: the code
	is 8 characters over a 30-character alphabet, about 39 bits. The relay is
	precisely the party this mode defends against, and 2^39 offline X25519
	trials is hours of ordinary compute — so a key derived from the code is a
	key the relay can find. A PAKE does not rescue it: every PAKE still needs
	each side to draw an unpredictable ephemeral scalar.

	What IS here is the arithmetic, correct and measured, so that the day Roblox
	documents a CSPRNG this becomes wiring rather than a rewrite.
	================================================================
]]

local bor, lrotate = bit32.bor, bit32.lrotate
local floor = math.floor

--[[
	ChaCha20 (RFC 8439 §2.3).

	Like SHA-256 above, this is entirely 32-bit add/xor/rotate, so `bit32` covers
	it exactly and there is no arbitrary-precision arithmetic anywhere in the
	cipher. The state is held in sixteen locals rather than a table because this
	is the one function here whose cost scales with payload size; a table index
	per operation across twenty rounds is the difference between ~3.5 MiB/s and
	something a Studio session would notice.
]]
local CHACHA_CONST = table.freeze({ 0x61707865, 0x3320646e, 0x79622d32, 0x6b206574 })

local function leU32(s: string, offset: number): number
	local b1, b2, b3, b4 = byte(s, offset, offset + 3)
	return (b1 :: number) + (b2 :: number) * 0x100 + (b3 :: number) * 0x10000 + (b4 :: number) * 0x1000000
end

local function u32le(value: number): string
	return char(
		band(value, 0xff),
		band(floor(value / 0x100), 0xff),
		band(floor(value / 0x10000), 0xff),
		band(floor(value / 0x1000000), 0xff)
	)
end

--[[
	One 64-byte keystream block. `counter` is the 32-bit block counter and
	`nonce` is 12 raw bytes.

	RFC 8439 fixes the counter at 32 bits, so it wraps after 256 GiB under one
	nonce. Nothing here can reach that — `MAX_CHANGESET_BYTES` is 8 MiB — but the
	`% MOD32` is written rather than assumed because a silent wrap would reuse
	keystream, which is the one ChaCha20 failure that destroys confidentiality
	outright rather than just producing a wrong answer.
]]
function Crypto.chacha20Block(key: string, counter: number, nonce: string): string
	if #key ~= 32 then
		error(string.format("chacha20Block: key must be 32 bytes, got %d", #key), 2)
	end
	if #nonce ~= 12 then
		error(string.format("chacha20Block: nonce must be 12 bytes, got %d", #nonce), 2)
	end

	local s0, s1, s2, s3 = CHACHA_CONST[1], CHACHA_CONST[2], CHACHA_CONST[3], CHACHA_CONST[4]
	local s4, s5, s6, s7 = leU32(key, 1), leU32(key, 5), leU32(key, 9), leU32(key, 13)
	local s8, s9, s10, s11 = leU32(key, 17), leU32(key, 21), leU32(key, 25), leU32(key, 29)
	local s12 = counter % MOD32
	local s13, s14, s15 = leU32(nonce, 1), leU32(nonce, 5), leU32(nonce, 9)

	local x0, x1, x2, x3 = s0, s1, s2, s3
	local x4, x5, x6, x7 = s4, s5, s6, s7
	local x8, x9, x10, x11 = s8, s9, s10, s11
	local x12, x13, x14, x15 = s12, s13, s14, s15

	-- Ten double rounds: four column quarter-rounds then four diagonal ones.
	-- Written out rather than looped over an index table for the same reason the
	-- state is in locals.
	for _ = 1, 10 do
		x0 = (x0 + x4) % MOD32; x12 = lrotate(bxor(x12, x0), 16)
		x8 = (x8 + x12) % MOD32; x4 = lrotate(bxor(x4, x8), 12)
		x0 = (x0 + x4) % MOD32; x12 = lrotate(bxor(x12, x0), 8)
		x8 = (x8 + x12) % MOD32; x4 = lrotate(bxor(x4, x8), 7)

		x1 = (x1 + x5) % MOD32; x13 = lrotate(bxor(x13, x1), 16)
		x9 = (x9 + x13) % MOD32; x5 = lrotate(bxor(x5, x9), 12)
		x1 = (x1 + x5) % MOD32; x13 = lrotate(bxor(x13, x1), 8)
		x9 = (x9 + x13) % MOD32; x5 = lrotate(bxor(x5, x9), 7)

		x2 = (x2 + x6) % MOD32; x14 = lrotate(bxor(x14, x2), 16)
		x10 = (x10 + x14) % MOD32; x6 = lrotate(bxor(x6, x10), 12)
		x2 = (x2 + x6) % MOD32; x14 = lrotate(bxor(x14, x2), 8)
		x10 = (x10 + x14) % MOD32; x6 = lrotate(bxor(x6, x10), 7)

		x3 = (x3 + x7) % MOD32; x15 = lrotate(bxor(x15, x3), 16)
		x11 = (x11 + x15) % MOD32; x7 = lrotate(bxor(x7, x11), 12)
		x3 = (x3 + x7) % MOD32; x15 = lrotate(bxor(x15, x3), 8)
		x11 = (x11 + x15) % MOD32; x7 = lrotate(bxor(x7, x11), 7)

		x0 = (x0 + x5) % MOD32; x15 = lrotate(bxor(x15, x0), 16)
		x10 = (x10 + x15) % MOD32; x5 = lrotate(bxor(x5, x10), 12)
		x0 = (x0 + x5) % MOD32; x15 = lrotate(bxor(x15, x0), 8)
		x10 = (x10 + x15) % MOD32; x5 = lrotate(bxor(x5, x10), 7)

		x1 = (x1 + x6) % MOD32; x12 = lrotate(bxor(x12, x1), 16)
		x11 = (x11 + x12) % MOD32; x6 = lrotate(bxor(x6, x11), 12)
		x1 = (x1 + x6) % MOD32; x12 = lrotate(bxor(x12, x1), 8)
		x11 = (x11 + x12) % MOD32; x6 = lrotate(bxor(x6, x11), 7)

		x2 = (x2 + x7) % MOD32; x13 = lrotate(bxor(x13, x2), 16)
		x8 = (x8 + x13) % MOD32; x7 = lrotate(bxor(x7, x8), 12)
		x2 = (x2 + x7) % MOD32; x13 = lrotate(bxor(x13, x2), 8)
		x8 = (x8 + x13) % MOD32; x7 = lrotate(bxor(x7, x8), 7)

		x3 = (x3 + x4) % MOD32; x14 = lrotate(bxor(x14, x3), 16)
		x9 = (x9 + x14) % MOD32; x4 = lrotate(bxor(x4, x9), 12)
		x3 = (x3 + x4) % MOD32; x14 = lrotate(bxor(x14, x3), 8)
		x9 = (x9 + x14) % MOD32; x4 = lrotate(bxor(x4, x9), 7)
	end

	return u32le((x0 + s0) % MOD32) .. u32le((x1 + s1) % MOD32) .. u32le((x2 + s2) % MOD32) .. u32le((x3 + s3) % MOD32)
		.. u32le((x4 + s4) % MOD32) .. u32le((x5 + s5) % MOD32) .. u32le((x6 + s6) % MOD32) .. u32le((x7 + s7) % MOD32)
		.. u32le((x8 + s8) % MOD32) .. u32le((x9 + s9) % MOD32) .. u32le((x10 + s10) % MOD32) .. u32le((x11 + s11) % MOD32)
		.. u32le((x12 + s12) % MOD32) .. u32le((x13 + s13) % MOD32) .. u32le((x14 + s14) % MOD32) .. u32le((x15 + s15) % MOD32)
end

--- ChaCha20 stream encryption (RFC 8439 §2.4). Decryption is the same call.
function Crypto.chacha20(key: string, counter: number, nonce: string, message: string): string
	local blocks = math.ceil(#message / 64)
	local out = table.create(blocks)
	for i = 1, blocks do
		local keystream = Crypto.chacha20Block(key, counter + i - 1, nonce)
		local base = (i - 1) * 64
		local n = math.min(64, #message - base)
		local piece = table.create(n)
		for j = 1, n do
			piece[j] = char(bxor(byte(message, base + j) :: number, byte(keystream, j) :: number))
		end
		out[i] = table.concat(piece)
	end
	return table.concat(out)
end

--[[
	Poly1305 (RFC 8439 §2.5) — arithmetic modulo 2^130-5, which Luau has no type
	for. This is the part that needs an explanation, because it is the part where
	a plausible-looking implementation is silently wrong for one input in
	billions.

	A Luau number is an IEEE-754 double: integers are exact up to 2^53 and
	rounded, silently, above it. So the limb size is not a style choice, it is
	the whole correctness argument. Six limbs of 22 bits hold 132 bits, and:

	  - a product of two limbs is under 2^44;
	  - the wrap multiplier is 2^132 mod (2^130-5) = 4 * 5 = 20, not 5, because
	    the limbs overshoot the modulus by two bits;
	  - the widest accumulator is d_0, which carries one direct product plus
	    five wrapped ones: (1 + 20*5) * 2^44 ~= 2^50.7.

	2^50.7 < 2^53, with about two bits to spare even when a limb runs slightly
	over 22 bits between carries. Every other split fails: the textbook five
	limbs of 26 bits — what every 32-bit C implementation uses — needs
	5 * 5 * 2^52 = 2^56.6 of accumulator, which a double cannot hold, and it
	would fail by rounding rather than by erroring.

	RFC 8439 A.3 vectors #5 through #11 exist to catch exactly the mistakes this
	layout could make, and CryptoSpec.luau runs all of them.
]]
local P22 = 0x400000 -- 2^22
local P20 = 0x100000 -- 2^20, the width of the top limb once the value is < 2^130

--[[
	Little-endian bytes to six 22-bit limbs.

	`count` bytes are read from `bytes`; the caller appends Poly1305's mandatory
	high 0x01 byte itself, because for the final short block it sits at the end
	of the data rather than at offset 16.
]]
local function poly1305Limbs(bytes: { number }, count: number): (number, number, number, number, number, number)
	local l0, l1, l2, l3, l4, l5 = 0, 0, 0, 0, 0, 0
	local accumulator, bits, index = 0, 0, 0
	for i = 1, count do
		-- accumulator holds `bits` (< 22) bits, so this stays under 2^30.
		accumulator += bytes[i] * 2 ^ bits
		bits += 8
		if bits >= 22 then
			local low = accumulator % P22
			if index == 0 then l0 = low
			elseif index == 1 then l1 = low
			elseif index == 2 then l2 = low
			elseif index == 3 then l3 = low
			elseif index == 4 then l4 = low
			else l5 = low end
			index += 1
			accumulator = (accumulator - low) / P22
			bits -= 22
		end
	end
	if index == 0 then l0 = accumulator
	elseif index == 1 then l1 = accumulator
	elseif index == 2 then l2 = accumulator
	elseif index == 3 then l3 = accumulator
	elseif index == 4 then l4 = accumulator
	elseif index == 5 then l5 = accumulator end
	return l0, l1, l2, l3, l4, l5
end

--- Poly1305 one-time authenticator: 32-byte one-time key, 16-byte raw tag.
function Crypto.poly1305(key: string, message: string): string
	if #key ~= 32 then
		error(string.format("poly1305: key must be 32 bytes, got %d", #key), 2)
	end
	local k = { byte(key, 1, 32) }

	-- Clamp r (RFC 8439 §2.5): r &= 0x0ffffffc0ffffffc0ffffffc0fffffff. In
	-- little-endian bytes that is bytes 3,7,11,15 &= 15 and bytes 4,8,12 &= 252,
	-- zero-indexed — hence the 1-indexed positions below.
	local rb = table.create(16)
	for i = 1, 16 do
		rb[i] = k[i]
	end
	rb[4] = band(rb[4], 15); rb[8] = band(rb[8], 15); rb[12] = band(rb[12], 15); rb[16] = band(rb[16], 15)
	rb[5] = band(rb[5], 252); rb[9] = band(rb[9], 252); rb[13] = band(rb[13], 252)

	local r0, r1, r2, r3, r4, r5 = poly1305Limbs(rb, 16)
	-- Pre-multiplied by the wrap constant so the inner loop does not repeat it.
	local s1, s2, s3, s4, s5 = r1 * 20, r2 * 20, r3 * 20, r4 * 20, r5 * 20

	local h0, h1, h2, h3, h4, h5 = 0, 0, 0, 0, 0, 0
	local blockBytes = table.create(17)
	local offset = 1

	while offset <= #message do
		local n = math.min(16, #message - offset + 1)
		for i = 1, n do
			blockBytes[i] = byte(message, offset + i - 1) :: number
		end
		blockBytes[n + 1] = 1
		local n0, n1, n2, n3, n4, n5 = poly1305Limbs(blockBytes, n + 1)

		h0 += n0; h1 += n1; h2 += n2; h3 += n3; h4 += n4; h5 += n5

		-- d_k = sum_{i+j=k} h_i*r_j + 20 * sum_{i+j=k+6} h_i*r_j
		local d0 = h0 * r0 + h1 * s5 + h2 * s4 + h3 * s3 + h4 * s2 + h5 * s1
		local d1 = h0 * r1 + h1 * r0 + h2 * s5 + h3 * s4 + h4 * s3 + h5 * s2
		local d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s5 + h4 * s4 + h5 * s3
		local d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s5 + h5 * s4
		local d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0 + h5 * s5
		local d5 = h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1 + h5 * r0

		local carry
		carry = floor(d0 / P22); h0 = d0 - carry * P22
		d1 += carry; carry = floor(d1 / P22); h1 = d1 - carry * P22
		d2 += carry; carry = floor(d2 / P22); h2 = d2 - carry * P22
		d3 += carry; carry = floor(d3 / P22); h3 = d3 - carry * P22
		d4 += carry; carry = floor(d4 / P22); h4 = d4 - carry * P22
		d5 += carry; carry = floor(d5 / P22); h5 = d5 - carry * P22
		-- Carrying out of limb 5 is carrying past 2^132, which folds back as 20.
		h0 += carry * 20
		carry = floor(h0 / P22); h0 -= carry * P22; h1 += carry

		offset += 16
	end

	--[[
		One carry chain, then fold bits 130 and 131 back as 5.

		Once and not twice, and the reason is a bound rather than a hope. The block
		loop leaves every limb under 2^22 bar a few units of slack, so h5 is under
		2^22 here, the carry out of it is at most 4, and limb 0 grows by at most
		20. The fold cannot cascade: nothing above limb 0 is touched by it.

		Limb 0 can therefore end this step a few units above 2^22 — non-canonical,
		and deliberately left that way. Both things that read the limbs afterwards
		are positional sums that carry as they go, so an over-wide limb 0 costs
		them nothing, and a second pass exists only to tidy a number no one looks
		at. That it makes no difference to any output was also checked directly:
		over 30,120 cases, including all-0xff messages up to 40 blocks under a
		maximal clamped r, a second pass never changed a tag. It was removed
		rather than left in as insurance a reader would mistake for a requirement.

		What this leaves is a value under 2^130 + 2^110 — below 2p, but NOT fully
		reduced. The conditional subtraction below is what finishes the job, and
		A.3 vector #5 is the vector that fails if it is missing.
	]]
	local carry
	carry = floor(h0 / P22); h0 -= carry * P22; h1 += carry
	carry = floor(h1 / P22); h1 -= carry * P22; h2 += carry
	carry = floor(h2 / P22); h2 -= carry * P22; h3 += carry
	carry = floor(h3 / P22); h3 -= carry * P22; h4 += carry
	carry = floor(h4 / P22); h4 -= carry * P22; h5 += carry
	carry = floor(h5 / P20); h5 -= carry * P20; h0 += carry * 5

	-- h + 5 carries out of bit 130 exactly when h >= 2^130-5, so this subtracts
	-- p once without ever comparing against a multi-limb constant. One
	-- subtraction is enough because h is below 2p.
	local g0 = h0 + 5; carry = floor(g0 / P22); g0 -= carry * P22
	local g1 = h1 + carry; carry = floor(g1 / P22); g1 -= carry * P22
	local g2 = h2 + carry; carry = floor(g2 / P22); g2 -= carry * P22
	local g3 = h3 + carry; carry = floor(g3 / P22); g3 -= carry * P22
	local g4 = h4 + carry; carry = floor(g4 / P22); g4 -= carry * P22
	local g5 = h5 + carry
	if g5 >= P20 then
		h0, h1, h2, h3, h4, h5 = g0, g1, g2, g3, g4, g5 - P20
	end

	-- Serialise the low 128 bits, then add s with a byte-wise carry. Dropping
	-- the carry out of byte 16 is the "mod 2^128" the RFC asks for, and A.3
	-- vector #6 is the case that proves it must be dropped and not propagated.
	local limbs = { h0, h1, h2, h3, h4, h5 }
	local tagBytes = table.create(16)
	local accumulator, bits, index = 0, 0, 0
	for i = 1, 6 do
		accumulator += limbs[i] * 2 ^ bits
		bits += 22
		while bits >= 8 and index < 16 do
			local low = accumulator % 256
			index += 1
			tagBytes[index] = low
			accumulator = (accumulator - low) / 256
			bits -= 8
		end
	end
	while index < 16 do
		local low = accumulator % 256
		index += 1
		tagBytes[index] = low
		accumulator = (accumulator - low) / 256
	end

	local out = table.create(16)
	local addCarry = 0
	for i = 1, 16 do
		local value = tagBytes[i] + k[16 + i] + addCarry
		addCarry = if value > 255 then 1 else 0
		out[i] = char(value % 256)
	end
	return table.concat(out)
end

--[[
	AEAD_CHACHA20_POLY1305 (RFC 8439 §2.8).

	The one-time Poly1305 key comes from counter block 0 and the ciphertext from
	counter block 1 onward, so the authenticator key is never itself keystream
	that covers plaintext.
]]
local function pad16(length: number): string
	local remainder = length % 16
	return if remainder == 0 then "" else rep("\0", 16 - remainder)
end

local function le64(value: number): string
	local out = table.create(8)
	local n = value
	for i = 1, 8 do
		out[i] = char(n % 256)
		n = floor(n / 256)
	end
	return table.concat(out)
end

local function aeadMacData(ciphertext: string, aad: string): string
	return aad .. pad16(#aad) .. ciphertext .. pad16(#ciphertext) .. le64(#aad) .. le64(#ciphertext)
end

--[[
	Seal: returns (ciphertext, 16-byte tag).

	`nonce` MUST NOT repeat under a given key. This function cannot check that —
	it holds no state — which is one more reason nothing calls it yet: a nonce
	discipline is a protocol decision, and ADR-014 has not made it.
]]
function Crypto.aeadSeal(key: string, nonce: string, plaintext: string, aad: string): (string, string)
	local oneTimeKey = sub(Crypto.chacha20Block(key, 0, nonce), 1, 32)
	local ciphertext = Crypto.chacha20(key, 1, nonce, plaintext)
	return ciphertext, Crypto.poly1305(oneTimeKey, aeadMacData(ciphertext, aad))
end

--[[
	Compare two strings without leaking where they first differ.

	Length is compared first and non-constant-time, which is intentional and
	standard: a MAC's length is public. The loop below runs over the whole string
	with no early exit.

	Honesty about the limit: this is constant-time as an *algorithm*. Luau is an
	interpreted VM with no control over caches, branch prediction, or the JIT, so
	this reduces the signal rather than eliminating it. Anywhere a real guarantee
	is required, this is not it.
]]
function Crypto.constantTimeEquals(a: string, b: string): boolean
	if #a ~= #b then
		return false
	end
	local difference = 0
	for i = 1, #a do
		difference = bor(difference, bxor(byte(a, i) :: number, byte(b, i) :: number))
	end
	return difference == 0
end

--[[
	Open: returns the plaintext, or nil if the tag does not verify.

	nil means "this did not authenticate" and nothing else. There is no partial
	success and no plaintext returned alongside a failure, because a caller that
	got both would eventually use one without checking the other.
]]
function Crypto.aeadOpen(key: string, nonce: string, ciphertext: string, tag: string, aad: string): string?
	local oneTimeKey = sub(Crypto.chacha20Block(key, 0, nonce), 1, 32)
	local expected = Crypto.poly1305(oneTimeKey, aeadMacData(ciphertext, aad))
	if not Crypto.constantTimeEquals(expected, tag) then
		return nil
	end
	return Crypto.chacha20(key, 1, nonce, ciphertext)
end

--[[
	================================================================
	X25519 (RFC 7748) — field arithmetic modulo 2^255-19.

	Same constraint as Poly1305 and a tighter one: a double is exact to 2^53 and
	this needs 255-bit numbers. Fifteen limbs of 17 bits is the choice, and the
	reason is arithmetic rather than taste:

	  - 15 * 17 = 255 EXACTLY, so a carry out of the top limb folds back as 19
	    and not as 19 * 2^k. Every split that overshoots 255 inflates that
	    constant and blows the accumulator budget — 13 limbs of 21 bits, for
	    instance, needs a wrap multiplier of 19 * 2^18 and overflows.
	  - a limb product is under 2^40 even when limbs run to 2^20 between carries
	    (which `feSub` deliberately does);
	  - the widest column is 15 products plus 19 times 15 wrapped ones:
	    20 * 15 * 2^40 ~= 2^48.2, comfortably inside 2^53.

	The margin matters more than the speed. An accumulator that exceeds 2^53
	does not raise anything — it rounds, and the result is a number that is
	wrong for a vanishing fraction of inputs, which is precisely the bug that
	published test vectors do not always catch. The bound above is what makes
	the vectors sufficient rather than merely encouraging.

	Field elements are 15-element arrays, 1-indexed, limb i weighted 2^(17*(i-1)).
	================================================================
]]
local FE_LIMBS = 15
local P17 = 0x20000 -- 2^17

--[[
	4*p in limb form, added by `feSub` so no limb can go negative.

	Four rather than two: at two, an input limb that had grown to 2^18 between
	carries would underflow, and the result would be a field element with a
	negative limb that every later multiply would quietly corrupt.
]]
local FOUR_P = table.create(FE_LIMBS)
FOUR_P[1] = 0x80000 - 76
for i = 2, FE_LIMBS do
	FOUR_P[i] = 0x80000 - 4
end
table.freeze(FOUR_P)

local function feZero(): { number }
	return { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }
end

local function feOne(): { number }
	local f = feZero()
	f[1] = 1
	return f
end

--- Normalise limbs back under 2^17, folding the overflow past 2^255 back as 19.
local function feCarry(f: { number })
	local carry = 0
	for i = 1, FE_LIMBS do
		local value = f[i] + carry
		carry = floor(value / P17)
		f[i] = value - carry * P17
	end
	f[1] += carry * 19
	-- The fold can push limb 1 up to ~2^35, so it needs propagating on; three
	-- limbs is more than enough to absorb it and costs nothing measurable.
	carry = floor(f[1] / P17); f[1] -= carry * P17; f[2] += carry
	carry = floor(f[2] / P17); f[2] -= carry * P17; f[3] += carry
	carry = floor(f[3] / P17); f[3] -= carry * P17; f[4] += carry
end

--[[
	Schoolbook multiply then reduce.

	No `if a[i] ~= 0 then` skip: it would be a real speedup and a data-dependent
	branch on secret limbs, which is the wrong trade in a key agreement.
]]
local FE_PRODUCT = table.create(29, 0)
local function feMul(a: { number }, b: { number }): { number }
	local t = FE_PRODUCT
	for k = 1, 29 do
		t[k] = 0
	end
	for i = 1, FE_LIMBS do
		local ai = a[i]
		for j = 1, FE_LIMBS do
			t[i + j - 1] += ai * b[j]
		end
	end
	-- Columns at or past limb 16 carry weight 2^255 or more, and 2^255 = 19
	-- mod p. Sources (16..29) and targets (1..14) are disjoint, so this is safe
	-- to do in place in one pass.
	for k = FE_LIMBS + 1, 29 do
		t[k - FE_LIMBS] += 19 * t[k]
	end
	local out = table.create(FE_LIMBS)
	for i = 1, FE_LIMBS do
		out[i] = t[i]
	end
	feCarry(out)
	return out
end

local function feSquare(a: { number }): { number }
	return feMul(a, a)
end

--- Limbs may reach 2^18 here; `feMul`'s bound is stated for 2^20, so no carry.
local function feAdd(a: { number }, b: { number }): { number }
	local out = table.create(FE_LIMBS)
	for i = 1, FE_LIMBS do
		out[i] = a[i] + b[i]
	end
	return out
end

--- a - b, kept non-negative by adding 4*p (which is 0 mod p).
local function feSub(a: { number }, b: { number }): { number }
	local out = table.create(FE_LIMBS)
	for i = 1, FE_LIMBS do
		out[i] = a[i] + FOUR_P[i] - b[i]
	end
	return out
end

--[[
	Multiply by a small constant. This one MUST carry: a24 is 121665, so limbs
	come out around 2^37, and feeding those into `feMul` unreduced would push a
	column to 2^57 and past the point where a double is exact.
]]
local function feMulSmall(a: { number }, n: number): { number }
	local out = table.create(FE_LIMBS)
	for i = 1, FE_LIMBS do
		out[i] = a[i] * n
	end
	feCarry(out)
	return out
end

--[[
	32 little-endian bytes to limbs, with bit 255 masked.

	RFC 7748 §5 requires that mask on the u-coordinate: the high bit is not part
	of the value, and an implementation that honoured it would accept a
	u-coordinate that a conformant peer had already discarded.
]]
local function feFromBytes(s: string): { number }
	local f = feZero()
	local accumulator, bits, index = 0, 0, 0
	for i = 1, 32 do
		local value = byte(s, i) :: number
		if i == 32 then
			value = band(value, 0x7f)
		end
		accumulator += value * 2 ^ bits
		bits += 8
		while bits >= 17 and index < FE_LIMBS do
			index += 1
			local low = accumulator % P17
			f[index] = low
			accumulator = (accumulator - low) / P17
			bits -= 17
		end
	end
	if index < FE_LIMBS then
		f[index + 1] = accumulator
	end
	return f
end

--- Limbs to 32 little-endian bytes, fully reduced.
local function feToBytes(f: { number }): string
	local t = table.create(FE_LIMBS)
	for i = 1, FE_LIMBS do
		t[i] = f[i]
	end
	feCarry(t)
	feCarry(t)

	-- Conditional subtraction of p without comparing against a multi-limb
	-- constant: t + 19 carries out of bit 255 exactly when t >= 2^255-19.
	local g = table.create(FE_LIMBS)
	local carry = 19
	for i = 1, FE_LIMBS do
		local value = t[i] + carry
		carry = floor(value / P17)
		g[i] = value - carry * P17
	end
	if carry >= 1 then
		t = g
	end

	local out = table.create(32)
	local accumulator, bits, index = 0, 0, 0
	for i = 1, FE_LIMBS do
		accumulator += t[i] * 2 ^ bits
		bits += 17
		while bits >= 8 and index < 32 do
			local low = accumulator % 256
			index += 1
			out[index] = char(low)
			accumulator = (accumulator - low) / 256
			bits -= 8
		end
	end
	-- 15 limbs of 17 bits is 255 bits, so the loop above emits 31 bytes and
	-- leaves 7 bits unflushed. Padding a zero here instead of draining the
	-- accumulator produces a result correct in every byte but the last — which
	-- passes a careless eyeball and fails every published vector.
	while index < 32 do
		local low = accumulator % 256
		index += 1
		out[index] = char(low)
		accumulator = (accumulator - low) / 256
	end
	return table.concat(out)
end

--[[
	Swap a and b iff `swap` is 1, with no branch on `swap`.

	The mask is arithmetic rather than a conditional because `swap` is a bit of
	the private scalar. Limbs stay under 2^20 here, so `bit32` — which is exactly
	32-bit — covers them without truncation.
]]
local function feConditionalSwap(swap: number, a: { number }, b: { number })
	local mask = swap * 0xffffffff
	for i = 1, FE_LIMBS do
		local delta = band(bxor(a[i], b[i]), mask)
		a[i] = bxor(a[i], delta)
		b[i] = bxor(b[i], delta)
	end
end

--[[
	z^(p-2), which is z^-1 for z /= 0 by Fermat's little theorem.

	The exponent p-2 = 2^255-21 has a bit pattern worth deriving rather than
	trusting: 2^255-21 is (2^255-1) - 20, and 20 is 0b10100, so it is 255 set
	bits with bits 2 and 4 cleared. Bits 0, 1 and 3 are set, bits 2 and 4 are
	clear, and bits 5 through 254 are set.

	This is plain square-and-multiply — about 254 squarings and 252
	multiplications, where the standard addition chain would need eleven
	multiplications. That is roughly 20% of one scalar multiplication, measured,
	and this version is one line a reader can check against the paragraph above.
	Speed is not the binding constraint on this code; see the header.
]]
local function feInvert(z: { number }): { number }
	local result = feOne()
	for t = 254, 0, -1 do
		result = feSquare(result)
		local bitIsSet = t >= 5 or t == 3 or t == 1 or t == 0
		if bitIsSet then
			result = feMul(result, z)
		end
	end
	return result
end

local A24 = 121665

--[[
	X25519 (RFC 7748 §5): the Montgomery ladder on Curve25519.

	`scalar` and `u` are 32 raw bytes each; the result is 32 raw bytes. The
	scalar is clamped here, as the RFC requires, so callers pass the scalar they
	generated rather than a pre-clamped one.

	The ladder runs a fixed 255 iterations regardless of the scalar and swaps
	with a mask rather than a branch, which is the shape a constant-time
	implementation has. It is not a constant-time *guarantee*: this is an
	interpreted VM and the arithmetic below is double-precision floating point,
	whose timing this code does not control. Said plainly because the difference
	matters and the shape is easy to mistake for the property.
]]
function Crypto.x25519(scalar: string, u: string): string
	if #scalar ~= 32 then
		error(string.format("x25519: scalar must be 32 bytes, got %d", #scalar), 2)
	end
	if #u ~= 32 then
		error(string.format("x25519: u-coordinate must be 32 bytes, got %d", #u), 2)
	end

	local k = { byte(scalar, 1, 32) }
	-- decodeScalar25519, RFC 7748 §5: clear the low three bits, clear bit 255,
	-- set bit 254. The first puts the scalar in the prime-order subgroup; the
	-- last fixes the ladder's length so it cannot leak the scalar's magnitude.
	k[1] = band(k[1], 248)
	k[32] = bor(band(k[32], 127), 64)

	local x1 = feFromBytes(u)
	local x2, z2 = feOne(), feZero()
	local x3, z3 = feFromBytes(u), feOne()
	local swap = 0

	for t = 254, 0, -1 do
		local kt = band(floor(k[floor(t / 8) + 1] / 2 ^ (t % 8)), 1)
		swap = bxor(swap, kt)
		feConditionalSwap(swap, x2, x3)
		feConditionalSwap(swap, z2, z3)
		swap = kt

		local a = feAdd(x2, z2)
		local aa = feSquare(a)
		local b = feSub(x2, z2)
		local bb = feSquare(b)
		local e = feSub(aa, bb)
		local c = feAdd(x3, z3)
		local d = feSub(x3, z3)
		local da = feMul(d, a)
		local cb = feMul(c, b)
		x3 = feSquare(feAdd(da, cb))
		z3 = feMul(x1, feSquare(feSub(da, cb)))
		x2 = feMul(aa, bb)
		z2 = feMul(e, feAdd(aa, feMulSmall(e, A24)))
	end

	feConditionalSwap(swap, x2, x3)
	feConditionalSwap(swap, z2, z3)
	return feToBytes(feMul(x2, feInvert(z2)))
end

--- The u-coordinate of the Curve25519 base point: 9, then 31 zero bytes.
local X25519_BASE = "\9" .. rep("\0", 31)

--- X25519(scalar, 9) — the public key for a private scalar.
function Crypto.x25519Base(scalar: string): string
	return Crypto.x25519(scalar, X25519_BASE)
end

--[[
	True when every byte of an X25519 output is zero, which RFC 7748 §6.1 says
	to check for: it is what the function returns for a small-order input, and
	continuing past it would mean agreeing a key an attacker chose.

	Provided because a caller that needed it and did not find it here would write
	`shared == string.rep("\0", 32)`, which is a length-dependent early-exit
	comparison on a secret.
]]
function Crypto.isAllZero(value: string): boolean
	return Crypto.constantTimeEquals(value, rep("\0", #value))
end

--[[
	The M19 outcome, as a value rather than as a sentence in a document nobody
	loads.

	Anything that renders a privacy posture must read this before showing
	`PRIVACY_POSTURE['relay-e2e']`. It is false, and it is false for a reason
	that no amount of work on the arithmetic above will change.
]]
Crypto.E2E = table.freeze({
	AVAILABLE = false,
	BLOCKER = "no documented CSPRNG in Roblox Studio; an X25519 private key cannot be generated here",
	SEE = "docs/architecture/adr-014-staged-pairing-crypto.md",
})

return Crypto
