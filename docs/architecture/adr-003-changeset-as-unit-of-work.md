# ADR-003: The ChangeSet is the universal unit of work

## Status
Accepted

## Context
Producers are wildly heterogeneous: a web chat, an MCP client inside Cursor, an A2A agent,
a shell script. Consumers are two: an open Studio session and Roblox Open Cloud. Without a
single unit of exchange, every producer×consumer pair becomes bespoke integration.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Stream Luau text | Trivial; what chatbots do | Not diffable, reviewable, reversible, or testable; every consumer re-parses | Low | Chat toys |
| B. Ship whole files | Simple, git-like | Destroys unrelated edits; no property/instance ops; huge payloads | Low | File-based projects |
| C. Full CRDT of the place tree | Real-time multiplayer editing | Enormous; Luau side impossible; solves a problem nobody has yet | Very high | Figma-class collaboration |
| D. **Typed, ordered, invertible operation set** | Diffable, reviewable, reversible, transport-agnostic, testable | Must define and version an op vocabulary | Medium | Exactly this |

## Decision
**Option D.** `ChangeSet = { baseVersion, operations: Operation[], validation }` with five
operation kinds, applied in order, each journaled with an inverse.

## Rationale
1. Review is the core safety mechanism (ADR-012), and you cannot review what you cannot
   diff. A typed op set diffs trivially; free text does not.
2. Rollback becomes mechanical rather than heuristic — replay the inverse.
3. It is the narrowest interface that lets any producer talk to any consumer, which is the
   entire product thesis.

## Trade-offs
The op vocabulary is a commitment: adding a sixth kind is a protocol change with a plugin
update behind it. Expressiveness is capped by what the vocabulary can say.

## Consequences
- **Positive**: one plugin implementation; connectors are thin; safety is structural.
- **Negative**: protocol versioning burden; field upgrades of the plugin are slow.
- **Mitigation**: `metadata` escape hatch for non-semantic extras; plugin refuses unknown
  protocol versions loudly rather than half-applying (see `PROTOCOL.md`).

## Revisit trigger
If three consecutive quarters each require a new operation kind, the vocabulary is wrong
and should be replaced by a lower-level primitive with a higher-level DSL above it.
