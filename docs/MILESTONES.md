# The 50 milestones

> **Provenance note, read this first.** The original numbered list of 50 milestones is not
> present anywhere the maintainer can find it — not in the planning directory, not in this
> repo's `docs/`, and not in the memory file. What follows is a **reconstruction** built from the
> categories named in the brief (backend, optional auth, projects, generation, inventory,
> game map, settings, deployment, Studio plugin, persistence, testing, security,
> observability, self-hosting, community) plus the new bridge/open-source scope. Confirm or
> correct the numbering before it is treated as a contract; the *content* is what matters
> and it is complete.

**Live status, 27 Aug 2026** — ten TypeScript packages and two apps, all green: `protocol`,
`core`, `daemon`, `model-registry`, `luau-analysis`, `mcp`, `a2a`, `cli`, `conformance` and
`storage-sqlite` under Vitest, plus `apps/relay` and `apps/web`; `sdk-python` under pytest
and ruff, plus the gate self-tests under `scripts/` and 208 Luau plugin tests run by hand.
Per-suite counts are deliberately not rolled up here. This line read "311 gate self-tests" when
the suite had 313, and the `M10` row read 64 when `luau-analysis` had 71 — which is what a number
nothing decides does. So the rule is the one the rest of this repository already applies to its
claims: a count stays in a hand-maintained document only where a gate can decide it against the
tree. Two can — the `protocol` suite's, and the plugin's 208 Luau tests — and
`scripts/__tests__/docs-claims.test.ts` counts both from the source and fails when this file
disagrees. The TypeScript suites cannot be counted that way: they lean on `it.each`, so a static
count of `it(` under `scripts/` misses about a third of what runs, and a gate that is
confidently wrong is worse than no gate. Every other number lives where it is produced —
`npm run test`, `npx vitest run --dir scripts`, and `python -m pytest` in `packages/sdk-python`.

Five of those packages — `luau-analysis`, `mcp`, `a2a`, `cli`, `sdk-python` — landed
together, and the four rows they belong to say what each still owes. `conformance`,
`storage-sqlite` and `apps/relay` landed in a second wave, under `M31`, `M40` and `M17`. `M01`–`M04` are
done. `M07` is done and frozen: the Zod schemas are complete and
61 tests are green. `M08` is done too, so the cross-language drift gate the `M07` row used to
claim now exists and has artefacts to compare: JSON Schema, an OpenAPI 3.1 document and
pydantic models are generated from those schemas and committed, and a corpus of documents is
run through all three projections and required to agree. `M20`'s catalog is real: 417 models
pulled live, 16 free and tool-capable, 3 excluded with stated reasons.

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
| M07 ✅ | `packages/protocol` — Zod schemas for ChangeSet/Run/Link/Apply | NEW | Schemas frozen; TS types are `z.infer` of them, so that projection cannot drift by construction; 61 tests green. Every other projection of these schemas is generated from them by `M08`, never hand-written |
| M08 ✅ | OpenAPI 3.1 + JSON Schema + Python model generation in CI | NEW | Generated artefacts committed: 54 JSON Schema (draft 2020-12) files and one OpenAPI 3.1 document under `packages/protocol/schema/`, and `models.py` under `packages/sdk-python`. One generator, `scripts/generate-schemas.ts`, writes all of them; its `verifyNoDrift` regenerates into memory and `npm run verify:schemas` fails the build on any difference. A 23-document corpus is judged identically by Zod, by the JSON Schema and by the pydantic models in `scripts/__tests__/schema-projection.test.ts`. The few refinements that had to be restated in JSON Schema carry probe values checked against the real Zod schemas on every run; the two constraints that do **not** survive the projection are named in `packages/protocol/schema/README.md`. The OpenAPI paths are read off the daemon's router, not off `docs/PROTOCOL.md`, and the generator fails when the two disagree — which is how the two endpoints the document had never listed were found |
| M09 ✅ | `packages/core` RunPipeline: plan → generate → validate → diff | NEW | `executeRun` in `packages/core/src/run.ts` walks the `RunStage` machine in `pipeline.ts` and stops at `awaiting-approval`; there is no path from it to an apply. The model is reached through `ModelClient` — a port — so `npm run verify:boundaries` still passes with no vendor SDK anywhere in core. `POST /v1/runs` exposes it (`packages/daemon/src/runs.ts`), `forgebridge run` drives it, and both stream every stage as it happens. Every model reached is appended to `run.attempts` as a protocol `ModelAttempt` before the next is tried, and a candidate the breaker suppressed is reported under `skipped`, never as an attempt (ADR-008). The verdict is recomputed by the core and again by the daemon; a producer-supplied `validation` or `status` is overwritten, never merged (`#submitChangeSet`). **Proven live, not by unit tests**: a real run against OpenRouter on 2026-08-27 fell through `z-ai/glm-5.2:free` (429) and `nvidia/nemotron-3-super-120b-a12b:free` (unparseable) to `liquid/lfm-2.5-2.6b:free`, and reached `awaiting-approval` with a schema-valid ChangeSet, `luau ok, policy ok`, `computed by forgebridge-daemon@0.1.0`, unapplied. One gap remains and is marked `TODO(M09)` in `packages/core/src/run.ts`: nothing renders a `treeSummary`, so a model is told the request and the allowlist but not what is already in the place |
| M10 | Luau static validation + policy rules on every ChangeSet | PART | `packages/luau-analysis` reads model-authored Luau and returns `ok`/`warn`/`fail` over eight rules — `loadstring`, `getfenv`/`setfenv`, `require` of an unreviewed asset id, `HttpService` to a non-allowlisted host, an unbounded `Heartbeat` loop, `while true` with no yield, a `RemoteEvent` handler with no argument validation, and the deprecated `wait`/`spawn` globals — each rule pinned by its own tests, alongside a `fail-closed regressions` block in `packages/luau-analysis/test/rules.test.ts` for the bypasses adversarial review found. `packages/daemon` runs it at submit time, inside the trust boundary, over `writeScript` **and** over `Source` written as a property; the verdict it computes overwrites whatever the producer sent, and `POST /v1/changesets/:id/approve` refuses a `fail`. A source the analyser could not read is `fail`, never `ok`. Path policy was already real (`checkPolicy`). Two things it deliberately is not: a Luau compiler — it recognises what a script says, not what it computes — and per-project, since the `HttpService` allowlist is a daemon-wide option until `ProjectPolicy` grows a field for it (TODO(M38) in `packages/daemon/src/server.ts`). `packages/core`'s out-of-process `SandboxPort` still has no adapter (M13) |
| M11 ✅ | Journal + inverse operations + `rollback` | NEW | Closed end to end. `RollbackResult` was added to `packages/protocol/src/apply.ts` — additively, beside `ApplyResult`: nothing renamed, nothing removed, no existing field's meaning changed — and it is what makes a completed reversal expressible on the wire at all. Three routes carry it: `POST /v1/journal/:id/entry` takes the inverses off the Studio session that captured them, `POST /v1/journal/:id/rollback` dispatches a reversal **carrying those inverses** rather than only the ids, and `POST /v1/journal/:id/rollback-result` reports how far the replay got. `GET /v1/journal/:id` answers with one of five states, and `rollback_partial` is one of them: the CLI exits non-zero on it and prints which inverses failed, the A2A `read-journal` skill says the word verbatim, and the Python SDK exposes the per-inverse outcomes — none of them rounds it to either neighbour, because a half-reversed tree is in a state neither the apply nor the rollback describes and the remaining inverses are spent. `plugin/src/Rollback.luau` is the replay: last-first, refusing a delivery whose steps are out of order rather than re-sorting them, and refusing one carrying no inverses rather than reporting a clean reversal for a tree nobody touched. **The row's old blocker is gone**: `plugin/tests/RollbackSpec.luau` applies a ChangeSet using every operation the protocol has and asserts the place is the exact structure it was before, `deleteInstance` with a serialised subtree included. Two limits are stated rather than papered over, and the same suite pins both: a restored deletion is a rebuild, not a resurrection, because Luau has no property reflection (`TODO(M15)` in `plugin/src/Journal.luau`), and — until M40 — the daemon's inverse store was not on `DaemonStore` at all. **That second limit is now closed**: M40 moved the four journal-entry methods onto `DaemonStore`, `packages/daemon/src/rollback.ts` no longer carries the `TODO(M40)` this row used to point at, and a daemon handed a persistent adapter keeps its inverses across a restart. The first limit stands and is the one to read: a restored deletion is a rebuild, not a resurrection |
| M12 | `baseVersion` optimistic concurrency (`409 stale_base`) | NEW | Concurrent-edit test proves no last-write-wins |
| M13 | Ports: Storage · Secrets · Transport · Telemetry · Sandbox | NEW | Core compiles with every port stubbed; no vendor import outside an adapter |

## Phase 2 — Transports: daemon, plugin, cloud link (M14–M19)

| # | Milestone | Status | Definition of done |
|---|---|---|---|
| M14 | `packages/daemon` — localhost HTTP server, zero-cloud mode | NEW | `forgebridge daemon` serves `/v1/*`; plugin pairs and applies with no account |
| M15 | Studio plugin v2 — poll, diff preview, approve, apply, journal | PART | One Luau file exists; rebuild against the protocol with an in-Studio diff/approve UI |
| M16 | Plugin: console mirror + selection context back to producers | PART | `/v1/output` populated; producers can read what Studio printed |
| M17 ✅ | `apps/relay` — cloud transport, pairing codes, long-poll | PART | `apps/relay` is a standalone process, and the thing it had to prove is that a second transport does not fork the protocol. **The surface is the daemon's, not a subset of it**: `apps/relay/test/surface.test.ts` compares the routes the relay serves against `packages/protocol/schema/openapi.json` in *both* directions — nineteen routes each way, no extras and no gaps — and it reads the committed projection rather than parsing the daemon's TypeScript, so the comparison fails on drift instead of on a regular expression. Provisioning is the one thing a relay needs that a daemon does not, and it is deliberately **outside** `/v1`: the daemon prints a producer token at a terminal and a relay has no terminal, so `POST /control/sessions` mints one — putting that route under `/v1` would add a path to a frozen protocol that the daemon does not serve, which is the one thing ADR-004 forbids. **The posture is served, not described**: `PRIVACY_POSTURE['relay-tls']` from `packages/protocol` is emitted verbatim in five places — the startup log, `GET /v1/health`, `POST /control/sessions`, `POST /v1/link/pair` and `GET /v1/link` — so no surface above it can render a padlock instead. Crypto is ADR-014 v1 and is proved equal to the daemon's rather than assumed: `test/drift.test.ts` runs canonical JSON, both MAC forms, envelope seal/open, session-key derivation and the content digest through *both* implementations and asserts byte identity, including that both refuse an encrypted payload because `relay-e2e` is M19. Tenancy is enforced in the type signature, not in the handlers: `RelayStore` has no read that takes an id without a session, so a handler that forgot the ownership check would not compile, and `test/isolation.test.ts` covers the routes end to end anyway because a signature is a proof about this code and not about a future adapter. Runtime dependencies are `@forgebridge/protocol` and `zod` — a property readable off `package.json`, which is why several small modules here are copies of the daemon's held in place by the drift suite rather than imports of it. 178 tests across eleven files; `apps/relay/deploy` is Caddy for TLS plus the relay on plain HTTP behind it, no database and no vendor account. **Still `PART`**: state is `InMemoryRelayStore` only, so a restart drops every session — `packages/storage-sqlite` (M40) exists and nothing wires it in; and the relay is not deployed anywhere. The long-poll in this row's title is real — `GET /v1/link/poll` holds the connection for `POLL_TIMEOUT_MS` (25s) and answers `204` only when it expires, measured at 25,005 ms against a running process, and `GET /v1/runs/:id/events` is SSE with a keep-alive and a ten-minute reconnect ceiling |
| M18 ✅ | Encrypted pairing v1 — session keys + payload HMAC over TLS | NEW | Landed for the local-daemon transport. `plugin/src/Crypto.luau` is a pure-Luau SHA-256, HMAC-SHA256, HKDF-SHA256 and base64, checked against published vectors rather than against itself (NIST, RFC 4231, RFC 5869); `plugin/src/Pairing.luau` redeems a code at `POST /v1/link/pair` and derives the session key both ends compute independently, so nothing secret crosses the wire. Requests are MAC'd with `requestMac` framing and deliveries verified with `envelopeMac` framing, both binding the link id — a delivery captured on one link does not verify on another — and the nonce, so a replayed or re-cursored poll cannot be reused. **Proven against a live daemon, not by unit tests**: `plugin/tests/live-pair.mjs` pairs for real on `127.0.0.1:7317` and asserts the Luau-derived session key id equals the daemon's, that the daemon accepts a Luau-built poll MAC and answers `401` to the same MAC with one byte flipped, and that `Transport.verifyMac` accepts a daemon-sealed envelope and refuses it after one byte of payload changes. Not yet exercised over TLS or against a relay — pairing is written against the daemon's handshake and there is no relay to pair with, so `Transport.deliveryGate` still refuses every non-loopback host (`M17`). The handshake is still one implementation per end rather than a written specification, which is what `M30` is waiting on |
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
| M26 | `packages/mcp` — MCP server, stdio + streamable HTTP | PART | Built: twelve tools over both transports, no business logic (ADR-009). `forge.start_run` reaches `POST /v1/runs` and returns the whole `ModelAttempt` list; the connector conformance suite (M31) runs against this package in `test/conformance.test.ts`. `@modelcontextprotocol/sdk` is installed and pinned at the `^1.30.0` that every call was actually run against; the reference SDK `Client` listed every tool with its projected schema over an in-memory transport, and the HTTP binding answered a real `initialize` and refused an `Origin`-bearing request. **None of the nine editors this row names has been tried**, so the row stays `PART`: its definition of done is a verified run from each, and M31's conformance suite is what would keep them verified |
| M27 | `packages/a2a` — agent card + task endpoints | PART | Built against A2A `v1.0.1`: Agent Card, `SendMessage`, `GetTask`, `ListTasks`, `CancelTask` over JSON-RPC. Streaming and push notifications are declared `false` in the card and answer the error §3.3.4 requires, which is implemented behaviour rather than a gap. Two corrections to this row's own wording: the card is served at `/.well-known/agent-card.json`, which is where A2A has registered it since 0.3.0, and a second agent **can** now drive a full run: the `start-run` skill reaches `POST /v1/runs`, and its artifact carries every `ModelAttempt` the router made. What an agent drives today is run-or-propose → diff → approve-with-a-human-grant → apply. The connector conformance suite (M31) runs against this package in `test/conformance.test.ts` |
| M28 | `packages/cli` — `link · daemon · run · diff · apply · rollback · models` | PART | Built: `daemon`, `link`, `status`, `models`, `run`, `diff`, `apply`, `rollback`, with human and `--json` output and distinct exit codes. `run` submits to `POST /v1/runs`, follows the run as it happens, prints the collapsed attempt log (`--verbose` for the full record), and never approves — it prints the changeset id and the two real ways a human clears it. So the whole loop is now drivable from a shell with no browser. Conformant against the M31 suite (`test/conformance.test.ts`). Still `PART`: the durable, cross-process approval gate the MCP and A2A connectors both point at this package for (`TODO(M28)` in `packages/mcp/src/approval.ts` and `packages/a2a/src/approval.ts`) does not exist |
| M29 | `packages/sdk-ts` — generated client + ergonomic wrapper | NEW | Published to npm; example app in `examples/` |
| M30 | `packages/sdk-python` — pydantic models + client | PART | The generated models and the producer half of the client landed with `M08`, with ruff and pytest configured; `start_run` and `get_run` reach `POST /v1/runs` and `GET /v1/runs/:id`. It is wired into the M31 conformance suite and green: `tests/conformance_driver.py` is a subprocess entry point in the shape of `tests/roundtrip.py`, and `packages/conformance/test/python-sdk.test.ts` drives it against a live daemon. It is the only connector that runs the matrix in another language. `forgebridge.describe_error` was added to make that possible and is public API in its own right. Done when it is published to PyPI, an example script lives in `examples/`, and the three consumer routes can derive their own session key and MAC instead of taking one as a parameter — that last part is blocked on `M18` writing the pairing handshake down as a specification rather than as one TypeScript file |
| M31 PART | Connector conformance suite | NEW | `packages/conformance` is that matrix: twelve cases — `propose-returns-id-and-diff`, `apply-refused-without-approval`, `apply-after-human-approval`, `apply-unknown-changeset-is-not-found`, `verdict-recomputed`, `run-reports-every-attempt`, `stale-base-refused`, `error-codes-total`, `link-posture`, `tree-read`, `projects-listed`, `surface-portable` — run against a connector through one adapter interface. Four connectors are wired and green: `packages/cli`, `packages/mcp` and `packages/a2a` each carry a `test/conformance.test.ts`, and the Python SDK runs the same matrix through a subprocess driver from `packages/conformance/test/python-sdk.test.ts` — the one connector that does not share this suite's language, its schemas or its error class. The suite is checked against itself rather than trusted: `test/cheating-adapters.test.ts` builds adapters that fake each guarantee and asserts the matrix fails them — including one that passes `apply-refused-without-approval` by always throwing, which is why that case alone is not the gate. `run.expectedAttempts` makes the attempt list a completeness check when the harness knows what the router was scripted to do, and the case says in its notes when it does not. Every connector's own adapter is held against the same three approval cheats through `approvalCheats` in `packages/conformance/src/cheats.ts`, because "the suite would catch this" is a claim about each adapter and not only about the reference one. Still `PART` on two counts: `tree-read` reports `unsupported` for every connector because `/v1` serves no tree snapshot, and "a connector that fails cannot ship" is not yet enforced anywhere, since nothing publishes yet |

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
| M40 ✅ | Persistence: SQLite adapter reaching parity with Supabase | NEW | Half done, and the row says which half. **Done**: `packages/storage-sqlite` ships two adapters over `node:sqlite` — `SqliteDaemonStore` for the daemon's `DaemonStore`, and `SqliteStoragePort` for the core's `StoragePort` — with versioned migrations, WAL, and a runner that refuses a file written by a newer build rather than guessing at its schema. `node:sqlite` over `better-sqlite3` because it is a built-in: no native build step for a self-hoster, and nothing added to a lockfile this repository keeps at `npm audit` zero; the cost is that a Node build which still gates it needs `--experimental-sqlite`, which `openDatabase` reports by name. **The parity claim is real and is the point**: the `DaemonStore` cases live in `packages/daemon/src/store-suite.ts` as one array, and two hosts run it — `packages/daemon/test/store.test.ts` against the in-memory store and `packages/storage-sqlite/test/parity.test.ts` against SQLite — so neither adapter can pass with its own version of a case. `packages/daemon/test/store-suite.test.ts` plants five defects a second adapter author would plausibly ship and asserts the suite rejects each one, because a parity suite that cannot fail is decoration. M11's retargeted `TODO(M40)` is closed with it: the four journal-entry methods moved onto `DaemonStore`, so a daemon handed a persistent adapter no longer loses the inverse operations — the only route back from a destructive apply — on restart. **Not done**: `storage-supabase` does not exist, so "parity with Supabase" is parity with the in-memory store today; the `StoragePort` cases in `packages/storage-sqlite/test/storage-port.test.ts` are one adapter's tests and are the ones to lift into a shared suite when the second lands. Nothing constructs either adapter yet — `createDaemon` still defaults to `InMemoryDaemonStore` |
| M41 | Test strategy: Vitest units + Playwright E2E + Luau plugin tests | PART | Plugin tests exist: 208 Luau tests in `plugin/tests/`, run by hand with `luau tests/run.luau`. Still to add: those tests in CI (needs a pinned Luau toolchain — see the TODO in `.github/workflows/ci.yml`) and E2E of the full apply/rollback loop |
| M42 | Security: RLS suite, Semgrep/CodeQL, secret scanning, SBOM | PART | RLS suite passes live today. Working-tree secret scanning now exists and runs in CI: `scripts/verify-no-secrets.ts` (`npm run verify:no-secrets`), which is the check ADR-013's mitigation names. Still to add: SAST, a **history** scan (`gitleaks`, blocked on a pinned action version a human must choose), SBOM publishing |
| M43 | Threat model + prompt-injection defences documented and tested | PART | `THREAT-MODEL.md` claims are each backed by a test. T1's key-custody claim now is: `scripts/verify-no-key-storage.ts` (`npm run verify:no-key-storage`) enforces "there is no column for them". T2–T6 are still prose |
| M44 ✅ | Observability: OpenTelemetry core + optional Sentry adapter | NEW | OpenTelemetry semantics with no OpenTelemetry dependency, so `packages/core` keeps its single dependency and B2 stays enforceable. Spans cover producer → core → transport: `RunRequest.parentTrace` and `RunInput.parentTrace` take the producer's context (parsed with `parseTraceparent`, which returns null for a header it cannot read rather than inventing a parent), the run span carries the run id, project id, producer kind and — once a set exists — the ChangeSet id, and `forgebridge.transport.deliver` and `forgebridge.transport.await-apply` are separate spans so a fast queue and a slow Studio session are distinguishable rather than summed. Approval arrives in a later request and is therefore a second trace, joined on `forgebridge.changeset.id`; the row says so rather than claiming one unbroken trace. Two adapters ship, both wrapped in the redactor by their own constructors: `otlpTelemetry` (OTLP/HTTP+JSON over `fetch`) and `errorReporterTelemetry` (an injected client a Sentry module object satisfies structurally, so the vendor stays at the edge). **Off by default is structural**: `telemetryFromEnvironment` returns `undefined` with no collector configured and every `TelemetryPort` in the core is optional, so there is no flag to invert. **The THREAT-MODEL T1 debt is paid**: the shared redactor exists at the port, and `packages/core/test/redact.test.ts` pushes seventeen known credential formats through every entry point and both adapters and asserts none reaches the wire — with controls proving a run id, a content digest, a model id and an npm integrity hash survive untouched. **Not done**: nothing under `plugin/` is instrumented, so the trace stops at the transport rather than reaching Luau (`M41`), and no deployment installs an adapter yet |
| M45 ✅ | Abuse protection replacing metering: rate limits + sponsored run | NEW | ADR-010's replacement for metering, built into `apps/relay/src/abuse/`, and the whole of it fails closed. **The sponsored gate grants nothing it cannot resolve**: with no verification port wired it refuses, with no ASN port wired it refuses, when the caller cannot be attributed to a network it refuses, and a verifier that *throws* is treated exactly like one that said no — so "I do not know who this is" and "this is a legitimate first-time user" are never the same answer. `test/sponsored.test.ts` plants each of those five cases and a CONTROL that grants a verified, attributable, first-of-the-day caller. All three counters are required, not any-of: same user, same address, same network — and every counter is given back when a later one refuses or the dispatch fails, so a refusal does not silently spend a stranger's day. Reservations go through an atomic reserve so "1 per day" cannot become "1 per millisecond", the day is keyed in UTC so daylight saving does not hand out a second run, and the key space is bounded so attacker-chosen keys cannot grow the store without limit. Rate limits are a sliding window rather than a bucket that resets on the hour, a refused request still counts (or a caller could hold the window open by hammering it), the limits key separately per scope and identity, and HTTP refusals carry a `Retry-After` a client can act on. Per-link ceilings on ChangeSet size and operation count are checked on the headers **before** the body is parsed. **A ceiling at the protocol bound is not a ceiling**: the relay refuses to *start* with an operation ceiling at or above `packages/protocol`'s own limit, or with a window that has no room in it. Every rule ships with the legitimate shape it is most confusable with as a CONTROL — ordinary use is not caught, a set exactly at the ceiling is accepted, the shipped defaults start. The daily budget breaker is charged before a user's own counter, publishes its number on `GET /v1/health` before anyone hits it, and when the day is spent says so plainly and points at BYOK and the local daemon rather than at a checkout. **Not done**: `apps/relay/src/bin.ts` wires no verification port, no ASN port and no run service, which is why a relay started from the shipped binary reports `sponsored.available: false` — the gate is built and refuses correctly, and what it would grant to is M23 |

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
