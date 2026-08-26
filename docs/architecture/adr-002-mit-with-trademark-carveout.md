# ADR-002: MIT licence with an explicit trademark carve-out and asset provenance

## Status
Accepted

## Context
"MIT, fully open, no attribution required" is a hard constraint. But the product's most
distinctive surface — a model/provider selector — is *made of other companies' logos*, and
MIT cannot licence what we do not own. A naive `LICENSE: MIT` at the root implies we are
granting rights to OpenAI's wordmark. We are not, and cannot.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. MIT, ship logos, say nothing | Zero effort | Misrepresents the grant; exposes forkers to trademark risk | Low | Never |
| B. Ship no third-party logos | No risk | Selector becomes a wall of text; brief explicitly forbids substitutes | Low | Text-only tools |
| C. AI-generate look-alike marks | Fills the UI | Wrong, unlicensed, implies endorsement; brief forbids it | Low | Never |
| D. **MIT + `NOTICE` + per-asset provenance manifest + CI gate** | Honest grant; forkers know exactly what they got; official assets kept | Manifest discipline forever | Medium | Any project shipping vendor marks |

## Decision
**Option D.** `LICENSE` is MIT for our code. `NOTICE` enumerates every third-party asset
with source, licence, retrieval date, and constraints. `assets/brands/manifest.json` is
machine-checked in CI. The apple.gg name and mark are reserved; ForgeBridge is not.

## Rationale
1. It is the only option that is simultaneously honest, useful, and compliant with the
   brief's "official assets only, never generated" rule.
2. It makes forking *safe*: a forker can read `NOTICE` and know precisely which files carry
   someone else's rights.
3. A CI gate turns a policy into a fact. Policies without gates decay in three months.

## Trade-offs
Every new provider costs a manual step: find the official brand page, record the URL,
licence, and hash. That friction is the point — it is what stops a generated logo landing.

## Consequences
- **Positive**: legally clean, forkable, and the selector looks right.
- **Negative**: contributor friction adding providers; manifest can go stale.
- **Mitigation**: `scripts/verify-assets.ts` fails the build on drift; a documented
  five-minute "adding a provider" checklist.

## Revisit trigger
If a vendor's brand terms forbid nominative use in an open-source repo, that vendor's asset
is removed and replaced with a text label — never a substitute drawing.
