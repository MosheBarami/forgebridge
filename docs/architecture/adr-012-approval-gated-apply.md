# ADR-012: Approval-gated apply with journaled rollback

## Status
Accepted

## Context
The system writes into a place a creator may have spent months on. The writer is a language
model — capable, and occasionally confidently destructive. External agents (MCP clients)
make this sharper: an agent in someone else's editor can propose a ChangeSet with no human
having read the prompt that produced it.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Auto-apply everything | Fastest, most magical | One bad run destroys real work; unrecoverable trust loss | Low | Throwaway projects |
| B. Manual approval, no rollback | Human in the loop | Humans approve big diffs without reading them; no recovery when they do | Low | Small diffs only |
| C. **Approval by default + scoped auto-apply opt-in + journaled inverse** | Safe by default, fast when the user chooses, always recoverable | Approval UI in Studio is real work; journal storage cost | Medium | This product |

## Decision
**Option C.**
- Default: every ChangeSet is previewed as a diff and applied only on approval.
- Opt-in auto-apply: per project, scoped to a path prefix, **never** covering
  `deleteInstance`, and always still journaled.
- Every apply writes inverse operations; `rollback` is a first-class protocol endpoint.
- `propose_changeset` and `apply_changeset` are separate MCP tools so a model cannot
  self-approve.

## Rationale
1. Rollback is the load-bearing safety mechanism. Validation reduces how often it is
   needed; it never removes the need.
2. Separating propose from apply is what makes external agents safe to allow at all.
3. Scoped auto-apply preserves the fast inner loop for the case that actually justifies it
   — iterating on one system in one folder.

## Trade-offs
A confirmation step in the hot path, which is exactly the friction competitors will skip.
Journals grow and need retention limits.

## Consequences
- **Positive**: destructive runs are survivable; external agents are safe to permit.
- **Negative**: slower first-run feel; storage growth; approval-fatigue risk.
- **Mitigation**: diffs are grouped and summarised so approval is a glance, not an audit;
  journals retain the last N applies per project, with older entries compacted.

## Revisit trigger
If telemetry shows users approving >95% of ChangeSets without opening the diff, approval
has become a rubber stamp and should be replaced by risk-scored gating — high-risk sets
gated, routine ones auto-applied.
