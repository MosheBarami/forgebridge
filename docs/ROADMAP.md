<!--
  GENERATED FILE — DO NOT EDIT.

  Written by scripts/roadmap.ts from docs/MILESTONES.md. Run `npm run generate:roadmap`
  after editing that file. `scripts/__tests__/roadmap.test.ts` regenerates this
  in memory and fails when the two disagree, so an edit here is reverted by the
  next run and an edit there without a run is a red build.
-->

# Roadmap

Generated from [`MILESTONES.md`](MILESTONES.md), which is the source of truth and
says, for every row below, exactly what it still owes. This page is the shape of
the whole thing at a glance; that file is the detail, and nothing here paraphrases
it — a summary of a carefully qualified claim is usually a stronger claim.

| | |
|---|---|
| ✅ shipped | 25 |
| ◐ in progress | 24 |
| · not started or planned | 2 |
| **total** | **51** |

“Shipped” means the row carries a ✅ in `MILESTONES.md`, and every ✅ there was put
there against a check that was run. It does not mean the area is finished: several
shipped rows name what they still owe in their own text. Follow the link.

## Where to start

Issues labelled **`good first issue`** are ones a first-time contributor can finish
without reading the whole tree. [`COMMUNITY.md`](COMMUNITY.md) says what that label
means here, what the other labels mean, and what the path from a first patch to a
maintainer looks like.

## Phase 0 — Open-source foundation (M01–M06)

| Milestone | | Status |
|---|---|---|
| [`M01`](MILESTONES.md) | Fresh public monorepo `forgebridge`, history quarantined | ✅ shipped |
| [`M02`](MILESTONES.md) | MIT `LICENSE` + `NOTICE` + trademark carve-out | ✅ shipped |
| [`M03`](MILESTONES.md) | DCO sign-off + `CONTRIBUTING` + `CODE_OF_CONDUCT` + BDFL governance | ✅ shipped |
| [`M04`](MILESTONES.md) | Turborepo + npm workspaces skeleton, all packages stubbed | ✅ shipped |
| [`M04b`](MILESTONES.md) | Configure an actual linter — the `lint` task is a no-op | · not started |
| [`M05`](MILESTONES.md) | `assets/brands/` with provenance manifest + CI gate | ✅ shipped |
| [`M06`](MILESTONES.md) | Credits, store, pricing, Stripe, paywall deleted | ✅ shipped |

## Phase 1 — Protocol & core engine (M07–M13)

| Milestone | | Status |
|---|---|---|
| [`M07`](MILESTONES.md) | `packages/protocol` — Zod schemas for ChangeSet/Run/Link/Apply | ✅ shipped |
| [`M08`](MILESTONES.md) | OpenAPI 3.1 + JSON Schema + Python model generation in CI | ✅ shipped |
| [`M09`](MILESTONES.md) | `packages/core` RunPipeline: plan → generate → validate → diff | ✅ shipped |
| [`M10`](MILESTONES.md) | Luau static validation + policy rules on every ChangeSet | ✅ shipped |
| [`M11`](MILESTONES.md) | Journal + inverse operations + `rollback` | ✅ shipped |
| [`M12`](MILESTONES.md) | `baseVersion` optimistic concurrency (`409 stale_base`) | ✅ shipped |
| [`M13`](MILESTONES.md) | Ports: Storage · Secrets · Transport · Telemetry · Sandbox | ✅ shipped |

## Phase 2 — Transports: daemon, plugin, cloud link (M14–M19)

| Milestone | | Status |
|---|---|---|
| [`M14`](MILESTONES.md) | `packages/daemon` — localhost HTTP server, zero-cloud mode | ✅ shipped |
| [`M15`](MILESTONES.md) | Studio plugin v2 — poll, diff preview, approve, apply, journal | ◐ in progress |
| [`M16`](MILESTONES.md) | Plugin: console mirror + selection context back to producers | ◐ in progress |
| [`M17`](MILESTONES.md) | `apps/relay` — cloud transport, pairing codes, long-poll | ✅ shipped |
| [`M18`](MILESTONES.md) | Encrypted pairing v1 — session keys + payload HMAC over TLS | ✅ shipped |
| [`M19`](MILESTONES.md) | Encrypted pairing v2 — end-to-end payload encryption, blind relay | ◐ in progress |

## Phase 3 — Models, providers, routing (M20–M25)

| Milestone | | Status |
|---|---|---|
| [`M20`](MILESTONES.md) | `packages/model-registry` + `sync-catalog` script | ✅ shipped |
| [`M21`](MILESTONES.md) | Weekly catalog-drift CI job opening a PR | ✅ shipped |
| [`M22`](MILESTONES.md) | Provider adapters: OpenRouter + direct APIs via AI SDK v7 | ◐ in progress |
| [`M23`](MILESTONES.md) | OpenRouter OAuth (PKCE) — no key pasting | ◐ in progress |
| [`M24`](MILESTONES.md) | Local model discovery — Ollama / LM Studio / llama.cpp / vLLM | ◐ in progress |
| [`M25`](MILESTONES.md) | Router: capability filter, policy ordering, fallback, breaker | ✅ shipped |

## Phase 4 — Agent connectors (M26–M31)

| Milestone | | Status |
|---|---|---|
| [`M26`](MILESTONES.md) | `packages/mcp` — MCP server, stdio + streamable HTTP | ◐ in progress |
| [`M27`](MILESTONES.md) | `packages/a2a` — agent card + task endpoints | ✅ shipped |
| [`M28`](MILESTONES.md) | `packages/cli` — `link · daemon · run · diff · apply · rollback · models` | ◐ in progress |
| [`M29`](MILESTONES.md) | `packages/sdk-ts` — generated client + ergonomic wrapper | ◐ in progress |
| [`M30`](MILESTONES.md) | `packages/sdk-python` — pydantic models + client | ◐ in progress |
| [`M31`](MILESTONES.md) | Connector conformance suite | ◐ in progress |

## Phase 5 — Product surfaces (M32–M39)

| Milestone | | Status |
|---|---|---|
| [`M32`](MILESTONES.md) | Full backend: route handlers over ports, no vendor leakage | ✅ shipped |
| [`M33`](MILESTONES.md) | Optional auth — signed-out is a first-class mode | ◐ in progress |
| [`M34`](MILESTONES.md) | Projects: create, open, tree, snapshot, delete, export `.rbxlx` | ◐ in progress |
| [`M35`](MILESTONES.md) | Generation surface: streamed plan, live run log, diff review | ◐ in progress |
| [`M36`](MILESTONES.md) | Inventory: mechanic cards, recipes, community submissions | ◐ in progress |
| [`M37`](MILESTONES.md) | Game map: node graph of systems, edges, navigation | ✅ shipped |
| [`M38`](MILESTONES.md) | Settings: models, keys, transport, approval policy, theme, locale | ◐ in progress |
| [`M39`](MILESTONES.md) | i18n + WCAG 2.2 AA across every surface | ◐ in progress |

## Phase 6 — Quality, security, operations (M40–M45)

| Milestone | | Status |
|---|---|---|
| [`M40`](MILESTONES.md) | Persistence: SQLite adapter reaching parity with Supabase | ✅ shipped |
| [`M41`](MILESTONES.md) | Test strategy: Vitest units + Playwright E2E + Luau plugin tests | ◐ in progress |
| [`M42`](MILESTONES.md) | Security: RLS suite, Semgrep/CodeQL, secret scanning, SBOM | ◐ in progress |
| [`M43`](MILESTONES.md) | Threat model + prompt-injection defences documented and tested | ◐ in progress |
| [`M44`](MILESTONES.md) | Observability: OpenTelemetry core + optional Sentry adapter | ✅ shipped |
| [`M45`](MILESTONES.md) | Abuse protection replacing metering: rate limits + sponsored run | ✅ shipped |

## Phase 7 — Distribution, self-hosting, community (M46–M50)

| Milestone | | Status |
|---|---|---|
| [`M46`](MILESTONES.md) | Deployment: Vercel for apple.gg, reproducible from a clean clone | · not started |
| [`M47`](MILESTONES.md) | Self-hosting: `docker compose up` full stack + lite daemon image | ◐ in progress |
| [`M48`](MILESTONES.md) | Roblox Open Cloud: publish place versions, DataStore, messaging | ◐ in progress |
| [`M49`](MILESTONES.md) | Release engineering: semver, changesets, signed releases, plugin dist | ◐ in progress |
| [`M50`](MILESTONES.md) | Community: docs site, examples, templates, issue triage, roadmap | ◐ in progress |
