# ADR-014: Staged pairing cryptography — authenticated in v1, end-to-end in v2

## Status
Accepted. The v2 mode below was spiked in M19 and **did not ship** — see
[M19 spike outcome](#m19-spike-outcome-27-august-2026), which is the part of this
document to read if you are here to find out whether ForgeBridge has end-to-end
encryption. It does not.

## Context
The brief asks for encrypted pairing. The obstacle is the consumer side: Roblox Luau has no
crypto standard library — no WebCrypto equivalent, no AES, no X25519, no CSPRNG suitable
for key generation. Real end-to-end encryption means shipping pure-Luau X25519 and an AEAD
inside a Studio plugin, and being confident in that implementation.

Being *wrong* about crypto is worse than being *late* about it, and worse still is claiming
end-to-end encryption while a relay reads plaintext.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. TLS only, call it encrypted | Ships immediately | Misleading — "encrypted" would mean "in transit to a server that reads it" | Low | Never |
| B. Full E2E before any launch | Strongest | Blocks the entire product on a pure-Luau crypto implementation nobody has reviewed | High | Security products |
| C. **Staged: v1 authenticated over TLS + local daemon default; v2 E2E** | Ships; honest about what each mode gives; privacy path exists from day one | Two security postures to document without confusing anyone | Medium | This product |

## Decision
**Option C**, three modes, each described accurately in the UI:

- **Local daemon (default, recommended)** — no relay exists. The strongest privacy posture,
  available immediately, with no crypto implementation required.
- **Relay v1** — pairing code → session key; every payload carries a MAC under that key;
  transport is TLS. The relay *can* read ChangeSet contents, and the UI says so in those
  words. Defends against replay, cross-link injection, and a malicious client — not against
  the relay operator.
- **Relay v2 (M19)** — X25519 key agreement + ChaCha20-Poly1305 payload encryption, with a
  short-authentication-string confirmation on the pairing code. The relay holds ciphertext.
  Gated behind a spike and an external review of the Luau implementation.
  **The spike ran and this mode is blocked.** It is blocked on the Roblox platform rather
  than on the cryptography, and no amount of further work in this repository unblocks it;
  the section at the end of this document records what was built, what was measured, and
  what stopped it.

## Rationale
1. The default path needs no crypto at all — routing privacy-sensitive users to the daemon
   solves their problem today, correctly.
2. Authentication and integrity (v1) are achievable in Luau with an HMAC-SHA256 that is far
   easier to get right than an AEAD plus key agreement, and they block the attacks that
   actually threaten the place: replay and injection.
3. Saying "the relay can read this" is worth more than any cryptography we would ship
   unreviewed. Users can then choose the daemon.

## Trade-offs
v1 users trust the relay operator with their ChangeSet contents. That is a real limitation
and it is stated in the product, not buried in a doc.

## Consequences
- **Positive**: ships without unreviewed crypto; a genuinely private mode exists on day one.
- **Negative**: a security posture that differs by mode — the hardest kind of thing to
  communicate well.
- **Mitigation**: the link indicator names the posture in the UI at all times ("Local — private"
  / "Relay — apple.gg can read changes" / "Relay — end-to-end encrypted"), never a padlock
  icon alone.

## Revisit trigger
**Superseded by the M19 outcome below.** The original trigger — "if a reviewed, maintained
pure-Luau crypto library becomes available" — turned out to be aimed at the wrong thing. A
crypto library would not have helped, because the arithmetic was never what blocked this;
M19 wrote the arithmetic and verified it. The trigger that matters is stated at the end of
this document, and it is a single, checkable question about Roblox rather than about Luau.

---

## M19 spike outcome, 27 August 2026

### The short version

The primitives were built and verified. The mode still cannot ship, because the *consumer*
end cannot generate a private key.

Roblox Studio has no documented source of cryptographic randomness. An AEAD and a key
agreement are worth nothing without a secret the adversary cannot predict, and the adversary
here is precisely the relay operator sitting between the two ends.

### What was built and verified

`plugin/src/Crypto.luau` gained ChaCha20, Poly1305, AEAD_CHACHA20_POLY1305 and X25519 in
pure Luau. `packages/daemon/src/e2e.ts` is the Node counterpart. Both are checked against
**published** vectors, in `plugin/tests/CryptoSpec.luau` and `packages/daemon/test/e2e.test.ts`:

| Primitive | Vectors |
|---|---|
| ChaCha20 | RFC 8439 §2.3.2 block, §2.4.2 encryption |
| Poly1305 | RFC 8439 §2.5.2, and **all eleven** appendix A.3 vectors |
| AEAD | RFC 8439 §2.8.2 |
| X25519 | RFC 7748 §5.2 (both vectors, the iterated vector), §6.1 (full Diffie-Hellman) |

Appendix A.3 vectors #5–#11 are the ones that earned their place. They exist to catch
partial reduction, an `s` addition overflowing 2^128, an all-ones limb carrying, results of
exactly 2^130-5 and 2^130-6, and a 5*H+L reduction reaching 131 bits. A limb layout that is
subtly wrong passes §2.5.2 and fails those.

Beyond the RFCs, both implementations were cross-checked against `node:crypto` byte for byte
— four X25519 agreements and ten AEAD payload sizes chosen to straddle the 64-byte block
boundary (0, 1, 15, 16, 17, 63, 64, 65, 130, 500). Those numbers came out of Node, not out of
the Luau code, and `packages/daemon/test/e2e.test.ts` recomputes them in CI so that the
committed expectations cannot be quietly edited to match a broken implementation. That gate
matters more than usual here: nothing in CI runs Luau at all (`TODO(M41)`).

Two things are worth recording because they are not obvious:

- **A double is exact only to 2^53, so the limb layout is the correctness argument, not a
  performance choice.** Poly1305 uses six limbs of 22 bits (widest accumulator ~2^50.7) and
  X25519 uses fifteen limbs of 17 bits (~2^48.2). The textbook 32-bit layouts — five limbs of
  26 bits, ten of 25.5 — need 64-bit accumulators and would overflow **silently**, by
  rounding, for a small fraction of inputs. There is no error to catch.
- **A comment claiming a defence must be a defence.** The first draft reduced Poly1305 twice
  at the end and said A.3 #5 depended on it. Mutating it to a single pass changed no test, so
  the claim was measured: over 30,120 cases, including all-0xff messages up to 40 blocks under
  a maximal clamped `r`, the second pass never changed a tag. It was dead code and was removed.
  A.3 #5 actually gates the conditional subtraction of `p`, which is now what the comment says.

### What was measured

Luau 0.729 (the standalone CLI, macOS/arm64):

| Operation | Cost |
|---|---|
| X25519 scalar multiplication | 11.4 ms |
| ChaCha20-Poly1305 seal | ~3.5 MiB/s |
| An 8 MiB `MAX_CHANGESET_BYTES` payload | ~2.3 s |

**Performance is not the blocker.** A handshake at 11 ms is unnoticeable and payload
throughput would need chunking across frames but is workable.

The honest caveat: this is the reference Luau interpreter on a developer machine, **not
Roblox Studio's VM**, which cannot be benchmarked from outside Studio. Treat these as an
order of magnitude, not as a Studio measurement.

### What stopped it

X25519 needs each side to draw a private scalar that nobody else can predict. The producer
side is fine — Node has a real CSPRNG. The consumer side is a Studio plugin, and:

> Roblox's published API reference documents no cryptographic-randomness guarantee for
> `math.random`, for `Random.new()`, or for `HttpService:GenerateGUID`. It does not state
> the algorithm, the seeding, or the entropy source of any of them.

Under the fail-closed rule this repository runs on, "undocumented" and "unsuitable" are the
same answer. Shipping a keypair drawn from a generator that *might* be seeded off the clock,
behind a UI that says "the relay sees only ciphertext", is worse than shipping nothing —
which is the position this ADR took in the first place.

Three workarounds were considered and all fail:

1. **Derive the consumer's private key from the pairing code.** The code is 8 characters over
   a 30-character alphabet: 656,100,000,000 possibilities, **39.3 bits**. The relay is the
   adversary and it holds the ciphertext, so it can search that space offline at roughly
   11 ms per trial in Luau and microseconds per trial in C. Hours of ordinary compute
   recovers the key. The 10-minute TTL and the 5-attempt cap defend the *online* handshake
   and do nothing about an offline search of a recorded session.
2. **Use a PAKE (SPAKE2, CPace) so the low-entropy code is safe.** Correct instinct — a PAKE
   is exactly the primitive for a short shared code, and it does remove the offline attack.
   It does not help here: every PAKE still requires both sides to draw an unpredictable
   ephemeral scalar. The gap is upstream of the protocol choice.
3. **Build an entropy pool from ambient Studio state** — clocks, mouse positions, keystroke
   timing while the user types the code. Some of this carries real entropy. None of it can be
   *quantified* from outside the engine, and an unquantified entropy estimate is not a
   security argument. This repository does not write confident sentences about things it
   cannot verify.

### What shipped, and what deliberately did not

- The primitives are in `plugin/src/Crypto.luau`, exported so the spec can hold them to the
  published vectors, and **not reachable from any transport**. `Pairing.luau` and
  `Transport.luau` are untouched.
- `Crypto.E2E.AVAILABLE` is `false`. `RELAY_E2E_AVAILABLE` in `packages/daemon/src/e2e.ts` is
  `false`, and `assertRelayE2eAvailable()` throws unconditionally, so a route that tried to
  advertise the mode fails loudly instead of falling back to plaintext under a padlock.
- `packages/daemon/src/e2e.ts` is **not** re-exported from `index.ts`, and a test asserts the
  absence of that line so it cannot be added without a decision.
- **There is no `Crypto.randomBytes` and no key generation, and that absence is the safety
  property.** A caller cannot complete a handshake without supplying a scalar from somewhere,
  which forces them to confront where it came from. A test asserts those functions do not
  exist, because the tempting fix — a `randomBytes` over `math.random` — would look
  reasonable in a diff.
- `M19` is **not** marked done. No transport in this tree ever reports `relay-e2e`: every
  link the daemon serves is `local-daemon` and every link the relay serves is `relay-tls`,
  both as literals in `server.ts`. The `relay-e2e` posture string still appears in
  `packages/protocol`, the CLI help, the web dictionaries and `plugin/src/Config.luau` —
  because `TransportKind` is an enum and those are exhaustive `Record<TransportKind, …>`
  mappings the type system requires, not because anything selects the value. The surfaces
  that would render it are unreachable, and `apps/relay/test/posture.test.ts` already
  forbids the relay from claiming the mode without citing M19 or this ADR.

### What remains, for whoever picks this up

The AEAD **nonce discipline is undecided** and is the one design question the spike did not
reach. ChaCha20-Poly1305 fails catastrophically on nonce reuse, and neither option is free: a
random 96-bit nonce carries a birthday bound that a long-lived link has to be argued about,
and a counter needs state that survives a Studio restart. `deriveE2eKey` in
`packages/daemon/src/e2e.ts` carries the `TODO(M19)`.

Also outstanding, and unchanged from the original decision: the short-authentication-string
confirmation, the wire format for a sealed envelope, and — the point the original ADR was
built around — **third-party review**. Nothing here has been reviewed by anyone outside this
repository. Verified against published vectors is a real property and it is not the same
property.

## Revisit trigger, restated

**Does Roblox document a cryptographically secure random source available to a Studio
plugin?**

That is the whole gate, and it is a question about Roblox's API reference, not about this
repository. If the answer becomes yes, M19 stops being a spike and becomes wiring: the
arithmetic is written, verified against RFC 7748 and RFC 8439, cross-checked against
`node:crypto`, and measured. What follows is the nonce decision, the SAS, the wire format,
and the external review — real work, but bounded.

If the answer stays no, `relay-e2e` should be **withdrawn from the protocol** rather than
left as a permanent aspiration: `TransportKind` in `packages/protocol/src/link.ts` offers a
mode that cannot be built, and an enum value nobody can select is a claim the tree does not
back.
