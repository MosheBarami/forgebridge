# Governance

## Structure

**BDFL.** One maintainer holds final say on scope, architecture, and releases. This is a
deliberate choice for a project at this stage: the risk to guard against is not tyranny,
it is drift — a universal bridge dies the moment its protocol becomes a committee output.

The BDFL's veto is bounded by the rules below, and every use of it is public.

**Escalation path**
1. Issue or discussion thread — anyone.
2. RFC in `rfcs/` for anything touching `packages/protocol` or `plugin/`.
3. BDFL decision, recorded as an ADR with its rationale. A decision without a written
   rationale is not a decision.

**Succession.** The BDFL names a successor in `GOVERNANCE.md`. If the BDFL is unreachable
for 90 days, the three most active maintainers by merged-PR count may jointly appoint one.

## Contributions

- **DCO required.** Every commit signed off (`git commit -s`). A bot blocks unsigned PRs.
  DCO, not a CLA: contributors keep their copyright, and we take no rights beyond MIT.
- **No CLA, ever.** A CLA on a project that promises to stay free is a relicensing option
  nobody asked for.
- **Contribution ladder**: contributor → reviewer (5 merged PRs, invited) → maintainer
  (BDFL invitation, area ownership) .
- **Protocol changes need an RFC.** Everything else needs a PR and a green CI.

## Licensing

- Code: **MIT**. No CLA, no dual licence, no "open core", no commercial edition.
- Third-party trademarks and logos: **not** covered by MIT — see `BRAND-ASSETS.md`.
- The **apple.gg** name and mark are reserved by the project owner. Forks may use the code
  freely; they may not present themselves as apple.gg. ForgeBridge itself is unencumbered —
  that is the whole point of splitting the two names (ADR-001).

## Promises

Written down so they can be held against us:

1. **Free forever.** No credits, no metering, no store, no paywall, no "pro" tier, no
   feature held back for a hosted plan.
2. **No required attribution.** Build with it, ship it, say nothing. MIT's notice
   requirement is the only obligation, and it does not reach your game.
3. **No telemetry by default.** Self-hosted and local installs phone home to nobody.
   apple.gg's own instance discloses exactly what it collects, in the UI, before it
   collects it.
4. **Your keys stay yours.** A BYOK key lives in the user's OS keychain — or, in a browser,
   as a non-extractable WebCrypto key — and reaches a provider only from the user's own
   machine. apple.gg's servers hold exactly one key: apple.gg's own, for the sponsored run
   ([ADR-006](architecture/adr-006-key-custody-daemon-as-egress.md)).

   Checked, not promised. `npm run verify:no-key-storage` enforces the strong form of
   `THREAT-MODEL.md` T1 — *there is no column for them; the schema cannot hold one* — as four
   rules: no persisted shape declares a credential-shaped field, no `StoragePort` method
   accepts or returns a credential, no credential-shaped value reaches disk, a database, a log
   or telemetry, and nothing the daemon persists holds a provider key.

   What it does not prove is printed on every run and belongs here too: it reads declarations
   and call sites under `packages/` and `apps/`, so it cannot catch a credential carried in a
   blandly named `string`, it does not inspect the Luau plugin, and it says nothing about an
   adapter nobody has written yet. The claim is exactly as wide as the check, which is the
   only width a promise like this is allowed to have.
5. **The core stays neutral.** If apple.gg disappears tomorrow, ForgeBridge keeps working.

## Release cadence

Semver. `packages/protocol` is the version everything else is measured against. Patch and
minor releases roll as they land; a major requires an RFC, a migration guide, and one
minor release of overlap.
