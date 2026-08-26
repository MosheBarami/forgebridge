# Architecture Decision Records

Every significant decision, with the options rejected and the trade-off accepted. A
decision without a written rationale is not a decision.

| ADR | Decision | Load-bearing because |
|---|---|---|
| [001](adr-001-forgebridge-core-applegg-instance.md) | ForgeBridge (neutral core) + apple.gg (official instance), one monorepo | Competitors will adopt a neutral package; they will not adopt a rival's brand |
| [002](adr-002-mit-with-trademark-carveout.md) | MIT + trademark carve-out + per-asset provenance manifest | We cannot MIT-licence someone else's logo, and the brief forbids fakes |
| [003](adr-003-changeset-as-unit-of-work.md) | The ChangeSet is the universal unit of work | You cannot review, revert, or test free-form generated code |
| [004](adr-004-dual-transport.md) | Local daemon (default) + cloud relay (opt-in), one protocol | The plugin must have exactly one implementation |
| [005](adr-005-ports-and-adapters-optional-auth.md) | Storage port with SQLite and Supabase adapters | "Optional auth" has to be structural or it rots into `if (user)` |
| [006](adr-006-key-custody-daemon-as-egress.md) | Keys local-only; the daemon is the BYOK egress | The only design where we *cannot* leak a key, rather than promise not to |
| [007](adr-007-registry-as-synced-data.md) | Registry is synced data; `free` is derived, never asserted | A stale free-model list is the standard way these tools lose trust |
| [008](adr-008-capability-router-with-visible-fallback.md) | Capability routing with fallback that is always logged | Silent model substitution is a lie about what wrote your code |
| [009](adr-009-mcp-primary-connector.md) | MCP first; A2A/REST/CLI/SDK as thin peers | Eleven bespoke integrations is not a plan |
| [010](adr-010-abuse-protection-replaces-metering.md) | Delete metering; add rate limits, verification, budget breaker | Free forever still has a bill; the bill needs a different defence |
| [011](adr-011-otel-core-sentry-adapter.md) | OTel in core, Sentry as an edge adapter, off by default | A privacy promise the core violates is not a promise |
| [012](adr-012-approval-gated-apply.md) | Approval-gated apply, scoped auto-apply, journaled rollback | The writer is a language model and the target is months of someone's work |
| [013](adr-013-fresh-public-repo.md) | Fresh public repo; quarantine the existing history | Publishing git history is irreversible, and this history holds secrets |
| [014](adr-014-staged-pairing-crypto.md) | Staged crypto: authenticated v1, end-to-end v2, daemon needs neither | Luau has no crypto stdlib; being wrong about crypto beats being late |

## Status

All 14 are **Accepted** as the design baseline. None are implemented yet — see
[`../MILESTONES.md`](../MILESTONES.md).
