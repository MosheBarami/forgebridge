# ADR-007: The model registry is synced data, and "free" is derived, never asserted

## Status
Accepted

## Context
The brief asks for "every verified free model". Free tiers change weekly: models are
withdrawn, prices move off zero, cooldowns appear. A hand-maintained list is wrong within
days and is the single most common way an AI-tool directory becomes untrustworthy.

There is a documented precedent in this project's own history: an earlier model check
truncated its result set and reported two existing models as absent. Verification against
a *full live* catalog is the lesson that generalised.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Hardcoded list in TS | Zero infrastructure | Stale in days; the classic failure | Low | Demos |
| B. Live fetch on every page load | Always current | Latency, rate limits, a hard dependency on provider uptime | Medium | Small catalogs |
| C. **Synced snapshot committed to the repo + scheduled drift PR** | Fast, offline-capable, auditable, reviewable | Snapshot can lag by up to a week | Medium | This product |

## Decision
**Option C.** `scripts/sync-catalog.ts` reads live provider catalogs and writes
`packages/model-registry/data/catalog.json`. Each entry records `pricing`, `syncedAt`, and the
source. A weekly CI job re-runs the sync and opens a PR when the catalog drifts.

`free` is **derived**, and the derivation is not the obvious one:

```
free  ⟺  input tokens priced at 0
     AND output tokens priced at 0
     AND the model is token-priced (not per-request / per-image / per-song / per-clip)
     AND its output modality is text
```

### The counterexample that forces the last two clauses

The first live sync (26 Aug 2026, 417 models in the catalog) returned **19 models at
`$0/M tokens`**. Two of them were `google/lyria-3-pro-preview` and
`google/lyria-3-clip-preview` — music generation models that genuinely report a token price
of zero **and bill $0.08 per song and $0.04 per 30-second clip**. Their token price is not
their price.

A naive `price === 0` check would have shipped both as "free models" in the selector, and the
first user to click one would have been charged. `packages/model-registry/src/derive.ts` has a
test pinned to this exact pair: if anyone later simplifies the rule back to a price check, that
test fails.

A third model, `nvidia/nemotron-3.5-content-safety:free`, is genuinely free but is a 4B guardrail
model with no tool-calling — it cannot drive the pipeline, so it is excluded with a stated reason
rather than silently dropped. **16 of 19 survive** as free and usable.

## Rationale
1. A free-model list nobody can trust is worse than no list. Deriving `free` from a price
   observed at a recorded time is the only claim we can actually defend.
2. Committing the snapshot keeps the app fast and lets it work offline.
3. A drift PR makes catalog change *reviewable* — a model disappearing shows up as a diff a
   human reads, not as a silent 404 in production.

## Trade-offs
Up to a week of staleness, and a weekly PR to triage. Providers without a machine-readable
catalog need a hand-written adapter entry, which reintroduces exactly the staleness risk
this ADR exists to remove — those entries carry a visible `syncedAt` and go stale loudly.

Two further facts the first live sync surfaced, both now modelled:

- **`:free` is a distinct tier, not a suffix.** `z-ai/glm-5.2:free` and `z-ai/glm-5.2` are
  different catalog entries with different pricing and different endpoints — the paid one's
  cheapest endpoint is $0.4186/M input across 30-odd providers. Listing endpoints for the
  canonical slug does *not* show the free tier. Treating the suffix as cosmetic would misreport
  both price and availability.
- **Models expire.** Catalog entries carry an `expiration_date`;
  `dots-studio/dots-3-note-preview:free` expires 30 Sep 2026. A model that vanishes mid-run is a
  worse failure than one that was never offered, so entries within 30 days of expiry are flagged
  `expiringSoon` and the router deprioritises them.

## Consequences
- **Positive**: trustworthy free-model claims; offline registry; auditable history.
- **Negative**: weekly maintenance; a lag window during which the UI can be wrong.
- **Mitigation**: the UI shows `verifiedAt` on hover and degrades to "availability unknown"
  past a threshold; runtime 4xx from a provider immediately marks the entry unhealthy.

## Revisit trigger
If drift PRs regularly exceed 50 changed entries a week, move to a hosted catalog service
with the committed snapshot as a fallback.
