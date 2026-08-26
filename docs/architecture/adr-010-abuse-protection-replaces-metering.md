# ADR-010: Delete metering; replace it with abuse protection

## Status
Accepted

## Context
The existing product has a full credits economy — ledger, daily drips, packs, Stripe, a
store modal, a pricing page. The brief removes all of it: free forever, no store, no
paywall. But the underlying cost does not vanish: the sponsored daily run spends real
money, and a free public relay is an open invitation.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Keep credits, set price to zero | Least code churn | Dead economy in the codebase and the UI; contradicts the promise | Low | Never |
| B. Delete metering, no replacement | Simplest | First abuser drains the sponsored budget in an hour | Low | Never |
| C. **Delete metering; add rate limits, verification, and a budget breaker** | Honest free product with a survivable cost floor | New abuse-control subsystem to build and tune | Medium | This product |

## Decision
**Option C.** Remove `credit_ledger`, packs, pricing, store, and Stripe entirely (M06 —
including a migration that drops the tables). Replace with:
- Sponsored run: **1 per day per verified user**, verification via Roblox OAuth with an
  account-age floor.
- Counters in Upstash Redis, date-keyed, enforced per user **and** per IP **and** per ASN.
- Sliding-window rate limits on every relay endpoint; per-link caps on ChangeSet size and
  operation count.
- A global daily budget circuit breaker.

## Rationale
1. Leaving a zero-priced credits system in place is worse than deleting it: it is dead
   weight that implies a future paywall and invites the question every day.
2. The default path (daemon + BYOK or local model) costs us nothing, so abuse control only
   has to protect one narrow surface — the sponsored run — which makes it tractable.
3. A visible breaker keeps the promise honest: when the day's budget is gone, we say so.

## Trade-offs
No revenue mechanism at all. Sustainability becomes sponsorship, donation, or the
maintainer's own funding — a deliberate choice, not an oversight. Abuse control adds a
Redis dependency to apple.gg (self-hosters can stub it).

## Consequences
- **Positive**: the promise is real; a whole subsystem and its UI disappear.
- **Negative**: no revenue; sponsored capacity is finite and will run out on busy days.
- **Mitigation**: BYOK and local models carry the load; the breaker degrades loudly, never
  silently; sponsored capacity is a published number, not a mystery.

## Revisit trigger
If sponsored-run cost exceeds what the maintainer can fund for three consecutive months,
the *sponsored run* is reduced or paused — the product stays free. Reintroducing metering
would require superseding this ADR in public.
