# Governance

The governance model lives in **[`docs/GOVERNANCE.md`](docs/GOVERNANCE.md)**. This file is a
pointer, not a copy — two versions of a governance document is one version too many, and the
one that drifts is always the one nobody reads.

It covers:

- **Structure** — BDFL, what the veto is bounded by, and why a universal bridge cannot have a
  committee-authored protocol.
- **Escalation** — issue → RFC → decision recorded as an ADR. A decision without a written
  rationale is not a decision.
- **Succession** — how a successor is named, and what happens if the BDFL is unreachable for
  90 days.
- **Contributions** — DCO required, no CLA ever, the contribution ladder, and which changes
  need an RFC.
- **Licensing** — MIT for our code, the trademark carve-out for everything we do not own.
- **The five promises** — free forever, no required attribution, no telemetry by default, your
  keys stay yours, the core stays neutral.
- **Release cadence** — semver measured against `packages/protocol`.

Related: [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to actually contribute,
[`docs/architecture/`](docs/architecture/README.md) for the decisions already made, and
[`SECURITY.md`](SECURITY.md) for reporting a vulnerability.
