# The 50 milestones

> **Provenance note, read this first.** The original numbered list of 50 milestones is not
> present anywhere the maintainer can find it — not in the planning directory, not in this
> repo's `docs/`, and not in the memory file. What follows is a **reconstruction** built from the
> categories named in the brief (backend, optional auth, projects, generation, inventory,
> game map, settings, deployment, Studio plugin, persistence, testing, security,
> observability, self-hosting, community) plus the new bridge/open-source scope. Confirm or
> correct the numbering before it is treated as a contract; the *content* is what matters
> and it is complete.

**Live status, 26 Aug 2026** — this repo exists and has not been pushed yet. `M01`–`M04` are
done. `M07` is done and frozen: the Zod schemas are complete and
42 tests are green — but only the TypeScript projection exists, so the cross-language drift
gate that the M07 row used to claim has moved to `M08`, where the artefacts it would compare
actually live. `M20`'s catalog is real: 417 models pulled live, 16 free and tool-capable, 3
excluded with stated reasons.

Two holes in the frozen protocol were found by adversarial review and closed before the first
public commit: `setProperty` could write `Parent`, which relocated an entire subtree while
reporting only its source path and so slipped the policy allowlist, the bulk-delete counter
and the auto-apply exclusion simultaneously; and `InstanceRef` carried an unvalidated string
that `pathsOf` never reported, so a reference could point anywhere the allowlist was never
shown. Both are fixed, and both are pinned by tests in
`packages/protocol/test/changeset.test.ts` — `refuses setProperty on Parent`, and the `pathsOf`
cases that report an `InstanceRef` target from a `setProperty` and from a `createInstance`
property bag. Recording it here, with the file, because "the review process works" is a claim
that needs evidence like any other.

**Status legend** — `DONE` rows below were verified against the *predecessor* repo at HEAD
`b174ec2`; rows marked ✅ were completed in the new public repo:

- `DONE` — exists and is verified by a check that was actually run
- `PART` — exists in some form, needs rework for the open-source/bridge model
- `NEW` — does not exist yet
- `DEL` — exists and must be **removed** (free-forever constraint)

---

## Phase 0 — Open-source foundation (M01–M06)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M01 ✅ | Fresh public monorepo `forgebridge`, history quarantined | NEW | New repo, no prior history, no `.env*`, no competitor scrapes; old repo stays private (ADR-013) |
| M02 ✅ | MIT `LICENSE` + `NOTICE` + trademark carve-out | NEW | `LICENSE` MIT; `NOTICE` lists every third-party asset; README states marks are not licensed (ADR-002) |
| M03 ✅ | DCO sign-off + `CONTRIBUTING` + `CODE_OF_CONDUCT` + BDFL governance | NEW | DCO bot blocks unsigned commits; `GOVERNANCE.md` names the BDFL and the escalation path |
| M04 ✅ | Turborepo + npm workspaces skeleton, all packages stubbed | NEW | `turbo run build lint test typecheck` green on an empty skeleton |
| M04b | **Configure an actual linter** — the `lint` task is a no-op | NEW | TODO(M04): every package's `lint` script is `echo`, and no linter config exists anywhere. A `lint` task that cannot fail is decoration. Done when a real linter runs and a deliberately violating fixture fails CI |
| M05 | `assets/brands/` with provenance manifest + CI gate | NEW | Every logo has source URL, licence, retrieved-at; CI fails on an unmanifested asset (`BRAND-ASSETS.md`) |
| M06 | Credits, store, pricing, Stripe, paywall **deleted** | DEL | `grep -ri "credit\|stripe\|paywall\|checkout" src/` returns nothing outside a migration that drops the tables |

## Phase 1 — Protocol & core engine (M07–M13)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M07 ✅ | `packages/protocol` — Zod schemas for ChangeSet/Run/Link/Apply | NEW | Schemas frozen; TS types are `z.infer` of them, so that projection cannot drift by construction; 42 tests green |
| M08 | OpenAPI 3.1 + JSON Schema + Python model generation in CI | NEW | Generated artefacts committed; `verifyNoDrift` proves TS/OpenAPI/JSON-Schema/Python all regenerate identically; CI fails if regeneration produces a diff |
| M09 | `packages/core` RunPipeline: plan → generate → validate → diff | PART | Agent pipeline exists in `src/lib/agent`; must be extracted, de-Next-ified, and made transport-agnostic |
| M10 | Luau static validation + policy rules on every ChangeSet | PART | Self-check exists; add path allowlist, `require` review, `HttpService` egress rules |
| M11 | Journal + inverse operations + `rollback` | NEW | Apply writes inverse ops; rollback restores prior tree byte-for-byte in tests |
| M12 | `baseVersion` optimistic concurrency (`409 stale_base`) | NEW | Concurrent-edit test proves no last-write-wins |
| M13 | Ports: Storage · Secrets · Transport · Telemetry · Sandbox | NEW | Core compiles with every port stubbed; no vendor import outside an adapter |

## Phase 2 — Transports: daemon, plugin, cloud link (M14–M19)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M14 | `packages/daemon` — localhost HTTP server, zero-cloud mode | NEW | `forgebridge daemon` serves `/v1/*`; plugin pairs and applies with no account |
| M15 | Studio plugin v2 — poll, diff preview, approve, apply, journal | PART | One Luau file exists; rebuild against the protocol with an in-Studio diff/approve UI |
| M16 | Plugin: console mirror + selection context back to producers | PART | `/v1/output` populated; producers can read what Studio printed |
| M17 | `apps/relay` — cloud transport, pairing codes, long-poll | PART | Pairing code exists in the web app; extract to a standalone relay speaking the protocol |
| M18 | Encrypted pairing v1 — session keys + payload HMAC over TLS | NEW | Pairing handshake tested; replay and cross-link attacks refused (ADR-014) |
| M19 | Encrypted pairing v2 — end-to-end payload encryption, blind relay | NEW | Spike pure-Luau X25519 + ChaCha20-Poly1305; relay proven to hold only ciphertext |

## Phase 3 — Models, providers, routing (M20–M25)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M20 | `packages/model-registry` + `sync-catalog` script | PART | Catalog generated from live provider APIs; `free` derived from price 0, never hand-written (ADR-007) |
| M21 | Weekly catalog-drift CI job opening a PR | NEW | Scheduled workflow; drift shows as a reviewable diff, not a silent update |
| M22 | Provider adapters: OpenRouter + direct APIs via AI SDK v7 | PART | Selector exists; broaden to the full adapter set with capability metadata |
| M23 | OpenRouter OAuth (PKCE) — no key pasting | NEW | User authorises; token stored locally only (C4) |
| M24 | Local model discovery — Ollama / LM Studio / llama.cpp / vLLM | NEW | Daemon probes well-known ports; local models appear in the selector with a "local" badge |
| M25 | Router: capability filter, policy ordering, fallback, breaker | NEW | Run log names every model attempted and why it moved on — no silent downgrade |

## Phase 4 — Agent connectors (M26–M31)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M26 | `packages/mcp` — MCP server, stdio + streamable HTTP | NEW | Verified from Claude Code, Cursor, Windsurf, Cline, Roo, Kilo, Continue, OpenCode, Copilot agent mode |
| M27 | `packages/a2a` — agent card + task endpoints | NEW | `/.well-known/agent.json` served; a second agent drives a full run |
| M28 | `packages/cli` — `link · daemon · run · diff · apply · rollback · models` | NEW | Full loop drivable from a shell with no browser |
| M29 | `packages/sdk-ts` — generated client + ergonomic wrapper | NEW | Published to npm; example app in `examples/` |
| M30 | `packages/sdk-python` — pydantic models + client | NEW | Published to PyPI; example script in `examples/` |
| M31 | Connector conformance suite | NEW | One test matrix every connector must pass; a connector that fails cannot ship |

## Phase 5 — Product surfaces (M32–M39)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M32 | Full backend: route handlers over ports, no vendor leakage | PART | 20 handlers exist; refactor onto `packages/core` |
| M33 | **Optional** auth — signed-out is a first-class mode | PART | Auth exists; every surface must work with no account (ADR-005) |
| M34 | Projects: create, open, tree, snapshot, delete, export `.rbxlx` | PART | CRUD exists; add snapshot/versioning and export |
| M35 | Generation surface: streamed plan, live run log, diff review | PART | Chat + streaming exist; add the diff/approve gate (ADR-012) |
| M36 | Inventory: mechanic cards, recipes, community submissions | PART | Cards exist; grow the catalog, add recipe format + submission flow |
| M37 | Game map: node graph of systems, edges, navigation | PART | Exists as stubs; complete edges + drill-through to scripts |
| M38 | Settings: models, keys, transport, approval policy, theme, locale | PART | Panel exists; add transport + approval-policy + key management |
| M39 | i18n + WCAG 2.2 AA across every surface | PART | a11y clean in both themes; add locale routing, RTL (Hebrew) support |

## Phase 6 — Quality, security, operations (M40–M45)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M40 | Persistence: SQLite adapter reaching parity with Supabase | NEW | Same test suite runs green against both adapters |
| M41 | Test strategy: Vitest units + Playwright E2E + Luau plugin tests | PART | Plugin tests exist: 118 Luau tests in `plugin/tests/`, run by hand with `luau tests/run.luau`. Still to add: those tests in CI (needs a pinned Luau toolchain — see the TODO in `.github/workflows/ci.yml`) and E2E of the full apply/rollback loop |
| M42 | Security: RLS suite, Semgrep/CodeQL, secret scanning, SBOM | PART | RLS suite passes live today. Working-tree secret scanning now exists and runs in CI: `scripts/verify-no-secrets.ts` (`npm run verify:no-secrets`), which is the check ADR-013's mitigation names. Still to add: SAST, a **history** scan (`gitleaks`, blocked on a pinned action version a human must choose), SBOM publishing |
| M43 | Threat model + prompt-injection defences documented and tested | PART | `THREAT-MODEL.md` claims are each backed by a test. T1's key-custody claim now is: `scripts/verify-no-key-storage.ts` (`npm run verify:no-key-storage`) enforces "there is no column for them". T2–T6 are still prose |
| M44 | Observability: OpenTelemetry core + optional Sentry adapter | NEW | Traces span producer → core → transport → plugin; self-hosters need no vendor |
| M45 | Abuse protection replacing metering: rate limits + sponsored run | NEW | 1 run/day/verified user; limits provable by test (ADR-010) |

## Phase 7 — Distribution, self-hosting, community (M46–M50)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M46 | Deployment: Vercel for apple.gg, reproducible from a clean clone | PART | One documented command from fresh clone to running deploy |
| M47 | Self-hosting: `docker compose up` full stack + lite daemon image | NEW | A stranger self-hosts from the README alone, no support contact |
| M48 | Roblox Open Cloud: publish place versions, DataStore, messaging | NEW | `packages/opencloud`; publish-from-CLI works end to end |
| M49 | Release engineering: semver, changesets, signed releases, plugin dist | NEW | Tagged release publishes npm + PyPI + `.rbxm` plugin with checksums |
| M50 | Community: docs site, examples, templates, issue triage, roadmap | NEW | Public roadmap, good-first-issues, contribution ladder documented |

---

## Sequencing

```
M01─M06  foundation ──┐
                      ├─▶ M07─M13 protocol+core ──┬─▶ M14─M19 transports ──┐
                      │                           ├─▶ M20─M25 models       ├─▶ M32─M39 surfaces
                      │                           └─▶ M26─M31 connectors ──┘        │
                      └──────────────────────────────────────────────────────────────┤
                                                                  M40─M45 quality ───┤
                                                                  M46─M50 release ───┘
```

**Critical path**: M07 → M09 → M14 → M15. Nothing else matters if a ChangeSet cannot make
it from a producer into an open Studio session and back out again. Build that spine first,
with the ugliest possible UI, then widen.

**Gate before Phase 5**: no product surface is rebuilt until the protocol is frozen. The
existing web app is *evidence the surfaces can be built*, not a dependency — porting it
onto a protocol that is still moving would mean porting it twice.
