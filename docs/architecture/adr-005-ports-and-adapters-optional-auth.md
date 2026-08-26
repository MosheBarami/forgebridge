# ADR-005: Ports and adapters for storage, so auth can be optional

## Status
Accepted

## Context
"Auth is optional" and "self-hostable" are both hard constraints. A Supabase-shaped app
where every query assumes `auth.uid()` cannot satisfy either. But a local-only app cannot
serve the community features or the sponsored run.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Supabase everywhere, anonymous sessions | One code path | An "anonymous account" is still an account and still a server round-trip; offline dead | Low | SaaS |
| B. Local-only, sync as an export | Truly offline | Community/sharing become second-class bolt-ons | Medium | Desktop tools |
| C. **Storage port, two adapters (SQLite / Supabase)** | Same domain code both ways; signed-out is first-class | Two adapters to keep at parity | Medium | This product |

## Decision
**Option C.** `Storage` is a port in `packages/core`. `storage-sqlite` (no account, files
under `~/.forgebridge`) and `storage-supabase` (Postgres 17 + RLS) implement it. Same
entity shapes, same test suite run twice.

## Rationale
1. It makes "optional auth" structural rather than a set of `if (user)` branches that will
   rot within a month.
2. Self-hosters get a real choice: full Postgres stack, or a daemon with a SQLite file.
3. Adapter parity is testable — one suite, two backends, both green or the build fails.

## Trade-offs
No Postgres-only features in domain code (no `LISTEN/NOTIFY`, no RLS-as-authorisation
inside the core). Authorisation moves up into the core, and RLS becomes defence-in-depth
rather than the primary mechanism.

## Consequences
- **Positive**: offline works; self-host lite works; core is testable without a network.
- **Negative**: lowest-common-denominator query surface; realtime needs its own port.
- **Mitigation**: keep RLS as a second layer (it already passes a live 37–44 check suite);
  put realtime behind a `Transport` port so SQLite mode degrades to polling.

## Revisit trigger
If adapter parity tests start being skipped for SQLite, the abstraction has failed and
local mode should become an explicitly reduced feature set rather than a fake peer.
