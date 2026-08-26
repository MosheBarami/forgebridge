# ADR-009: MCP is the primary connector; A2A, REST, CLI and SDKs are peers over one core

## Status
Accepted

## Context
The brief names eleven agent surfaces: ChatGPT, Claude, Codex, Cursor, Windsurf, Cline,
Roo, Kilo, Continue, OpenCode, Copilot. Building eleven integrations is not a plan; it is a
maintenance sentence.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Bespoke plugin per tool | Native feel in each | 11 codebases, 11 release cadences, 11 breaking-change sources | Very high | Funded teams |
| B. REST only, "integrate yourself" | Cheapest | Nobody integrates; the promise is unfulfilled | Low | Infra products |
| C. **MCP first, plus A2A/REST/CLI/SDK as thin peers** | One implementation reaches most named tools; others covered by CLI/SDK | Depends on MCP adoption continuing | Medium | This product |

## Decision
**Option C.** `packages/mcp` (stdio + streamable HTTP) is the flagship connector. `a2a`,
REST/OpenAPI, `cli`, `sdk-ts`, and `sdk-python` are peers, all thin adapters over
`packages/core`. Zero business logic in any connector, enforced by review and by a
conformance suite (M31) every connector must pass.

## Rationale
1. Most of the named tools already speak MCP. One server, many clients, is the only
   affordable answer for a small team.
2. Tools that do not speak MCP (Codex/Copilot CLI flows, CI) are reachable by the CLI —
   which we need anyway for headless use.
3. A2A covers the agent-to-agent case MCP does not, at low marginal cost since the core
   already exposes the operations.

## Trade-offs
Strategic dependence on MCP's continued adoption. MCP's UX ceiling (tool lists, no rich
custom UI) caps how good the in-editor experience can be versus a native extension.

## Consequences
- **Positive**: eleven surfaces from roughly two implementations; connectors stay tiny.
- **Negative**: no bespoke polish anywhere; MCP protocol churn hits us directly.
- **Mitigation**: conformance suite catches churn early; the tool surface is deliberately
  small (11 tools) so a protocol migration is a day, not a quarter.

## Revisit trigger
If one tool exceeds ~40% of active links, a native extension for that tool becomes worth
its maintenance cost.
