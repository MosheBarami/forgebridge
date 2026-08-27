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

Building on the *semantics* rather than on `@opentelemetry/*` is a further trade this ADR
did not spell out and M44 had to make: `packages/core` keeps its single dependency and B2
stays enforceable, at the cost of an OTLP/HTTP+JSON exporter this project maintains itself.
That exporter is deliberately small — batch, `fetch`, no timers — and a deployment that
wants the full SDK can still install one behind the same port.

## Consequences
- **Positive**: neutral, self-hostable, standards-based; one trace across four processes.
- **Negative**: more setup; redaction is our responsibility.
- **Mitigation, in force since M44**: the shared redactor is
  `packages/core/src/ports/redact.ts`, applied at the port by `redactedTelemetry`, and both
  shipped adapters wrap themselves in it in their own constructors so that no caller can
  obtain an unwrapped one. `packages/core/test/redact.test.ts` feeds seventeen known
  credential formats through every entry point the port has and through both adapters, and
  asserts none survives to the wire — alongside the controls that keep it from being
  fail-noisy (a run id, a content digest, a model id and an npm integrity hash come back
  unchanged). What it does not cover is stated in the redactor's own header.
- **Off by default, structurally**: `telemetryFromEnvironment` returns `undefined` unless an
  operator names a collector, and every `TelemetryPort` in the core is optional, so there is
  no `enabled: false` anywhere for a later refactor to invert.

## Revisit trigger
If OTel instrumentation cost exceeds its debugging value after a year, keep the port and
ship a much thinner default exporter.
