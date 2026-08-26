# ADR-006: Keys stay local; the daemon is the BYOK egress

## Status
Accepted

## Context
"User keys are stored locally only" is non-negotiable. The obstacle is browsers: most AI
providers do not send permissive CORS headers, so a web page cannot call them directly.
The industry's usual answer — proxy the key through your own server — is exactly what the
constraint forbids.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Proxy keys through our API | Works in every browser | Violates C4 outright; makes us a breach target | Low | Never here |
| B. Browser-direct only | No server involvement | Only works for the minority of CORS-friendly providers | Low | Narrow provider set |
| C. **Daemon as egress; browser talks to `127.0.0.1`** | Full provider coverage; key never crosses our origin | Requires the daemon for BYOK in the browser | Medium | This product |
| D. Browser extension holding keys | No daemon | A whole second distribution channel and review process | High | Extension-first products |

## Decision
**Option C**, layered:
- **Daemon / CLI**: OS keychain (macOS Keychain, Windows Credential Manager, libsecret),
  falling back to an AES-GCM file sealed with an OS-derived key.
- **Browser with daemon**: key lives in the daemon; the page never holds it.
- **Browser without daemon**: only CORS-capable providers and OpenRouter-OAuth are offered;
  the key is a non-extractable WebCrypto key or an AES-GCM blob in IndexedDB.
- **apple.gg servers**: hold exactly one key — apple.gg's own, for the sponsored run.

## Rationale
1. It is the only design where "we cannot leak your key" is a property of the system rather
   than a policy we promise to follow.
2. It gives the daemon a second reason to exist beyond Studio transport, which improves the
   install-rate problem in ADR-004.
3. It is verifiable in part today, and the part matters: `scripts/verify-no-key-storage.ts`
   runs in CI (`npm run verify:no-key-storage`) and fails the build if any persisted shape
   declares a credential-shaped field (K1), if a `StoragePort` method accepts or returns a
   credential (K2), if a credential-shaped value reaches a disk, database, response, log or
   telemetry call under `packages/` (K3), or if a shape the daemon persists holds a provider
   key (K4 — this ADR's own sentence, at the daemon's store seam).

   That is **static analysis of declarations and call sites**. It does not run the daemon,
   does not read `plugin/`, and cannot see a key smuggled through a blandly named `string`;
   the gate prints those limits in its summary on every run. This rationale previously
   claimed *a test asserts no outbound request to our origin ever carries a key-shaped
   string* — an assertion about an observed request, which nothing here makes. That test is
   owed under **M43**, and until it is written the honest form of the claim is the one
   above: the shapes cannot hold a key, and no call site in `packages/` hands one to an
   egress. Owner: whoever wires the first browser BYOK path.

## Trade-offs
BYOK in a pure browser is genuinely reduced. Some users will hit "install the daemon to use
this provider" and bounce.

## Consequences
- **Positive**: no server-side key storage; no key-breach blast radius; honest marketing.
- **Negative**: provider availability differs by environment — a confusing UX if handled badly.
- **Mitigation**: the selector shows *why* a provider is unavailable and what unlocks it,
  inline. OpenRouter OAuth (M23) covers most users without any key handling at all.

## Revisit trigger
If a provider ships first-class browser CORS with scoped, revocable tokens, that provider
moves to browser-direct and the daemon requirement drops for it.
