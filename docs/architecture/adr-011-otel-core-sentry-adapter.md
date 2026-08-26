# ADR-011: OpenTelemetry in the core, Sentry as an optional adapter

## Status
Accepted

## Context
Debugging a failed run means following it across four processes — producer, core,
transport, plugin — often on someone else's machine. That needs real tracing. But a
self-hostable, privacy-promising, zero-telemetry-by-default project cannot hard-wire a
commercial SaaS into its core.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Sentry SDK throughout | Best DX; excellent error grouping | Vendor lock in the core; self-hosters inherit a dependency they may not want | Low | Single-vendor SaaS |
| B. `console.log` only | Zero dependency | Cross-process debugging is guesswork | Low | Toys |
| C. **OTel in core; Sentry as an adapter apple.gg installs** | Neutral core; vendor choice at the edge; standard semantics | Two paths to configure; OTel setup is fiddlier | Medium | This product |

## Decision
**Option C.** `packages/core` emits OpenTelemetry spans and metrics through a `Telemetry`
port. apple.gg installs a Sentry adapter behind that port. Self-hosters point the OTel
collector at anything, or at nothing. Telemetry is **off by default** for local and
self-hosted installs.

## Rationale
1. A privacy promise that the core itself violates is not a promise. Off-by-default has to
   be structural.
2. OTel semantics survive vendor changes; a trace id that spans producer → plugin is worth
   more than any single vendor's UI.
3. Sentry's error grouping is genuinely better than raw OTel for triage, so apple.gg keeps
   it — as a choice, at the edge.

## Trade-offs
Two observability paths to keep working. OTel's ergonomics are worse than a native SDK, and
the redaction logic must be implemented once at the port rather than inherited from a
vendor's defaults.

## Consequences
- **Positive**: neutral, self-hostable, standards-based; one trace across four processes.
- **Negative**: more setup; redaction is our responsibility.
- **Mitigation, planned — M44, and neither half exists yet**: a shared redactor at the port,
  with a test that feeds known secret formats through every log path (see `THREAT-MODEL.md`
  T1). Today `packages/core/src/ports/telemetry.ts` declares the port and carries a
  `TODO(M44)` where the redactor belongs; nothing redacts anything, and there is no such test.
  Read this row as the decision's obligation, not as a control that is in force.

## Revisit trigger
If OTel instrumentation cost exceeds its debugging value after a year, keep the port and
ship a much thinner default exporter.
