# ADR-014: Staged pairing cryptography — authenticated in v1, end-to-end in v2

## Status
Accepted

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
If a reviewed, maintained pure-Luau crypto library becomes available, v2 stops being a
spike and becomes an implementation task — pull it forward immediately.
