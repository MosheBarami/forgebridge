# ForgeBridge — system architecture

## 0. What this thing is

A **bridge**, not an app. The app (`apple.gg`) is one client of the bridge among many.
That framing drives every decision below: the durable asset is the *protocol* and the
*Studio plugin*, and everything else is an adapter that can be replaced without breaking
the others.

**Non-negotiables** (from the brief, treated as hard constraints):

| # | Constraint | Architectural consequence |
|---|---|---|
| C1 | Free forever — no credits, store, paywall, or required attribution | No metering subsystem. Cost control becomes *abuse control* (ADR-010). |
| C2 | MIT, fully open source | Trademark carve-out + provenance for third-party assets (ADR-002). |
| C3 | Works with *almost any* model or agent | Registry-as-data + capability router (ADR-007, ADR-008). |
| C4 | User keys never leave the user's machine | Daemon is the BYOK egress; browser never proxies a user key to our server (ADR-006). |
| C5 | Auth is optional | Storage is a port with a local adapter; signed-out is a first-class mode (ADR-005). |
| C6 | Self-hostable | No hard dependency on any single vendor; every vendor is behind a port. |
| C7 | Official brand assets only, never generated | `assets/brands/` + manifest + CI gate (ADR-002, `BRAND-ASSETS.md`). |

## 1. Component map

```
┌──────────────────────── PRODUCERS (make ChangeSets) ─────────────────────────┐
│                                                                              │
│  apps/web (M32–M39)              packages/mcp (M26)    packages/a2a (M27)    │
│    Next.js 15 — apple.gg           MCP server            A2A agent card      │
│    chat · inventory · game map     stdio + HTTP          task endpoints      │
│    projects · settings · community                                           │
│                                                                              │
│  packages/cli (M28)              packages/sdk-ts (M29) packages/sdk-py (M30) │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  all speak ↓
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                packages/protocol  —  the contract   (frozen)                 │
│   ChangeSet · Operation · Run · Link · ApplyResult · JournalEntry · Error    │
│   Zod schemas → TS types, inferred from the same file (zero drift)           │
│   OpenAPI 3.1 · JSON Schema · pydantic models  (M08 — generated, committed)  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                   packages/core  —  the engine   (M09–M13)                   │
│                                                                              │
│  Router ──▶ Registry ──▶ Provider adapters (OpenRouter · direct APIs ·       │
│   (policy,   (synced       Ollama/llama.cpp/LM Studio · BYOK)                │
│    fallback,  catalog)                                                       │
│    breaker)                                                                  │
│                                                                              │
│  RunPipeline:  prompt → plan → generate → validate → diff → approve →        │
│                apply → test → journal (→ rollback)                           │
│                                                                              │
│  Ports:  Storage · Secrets · Transport · Telemetry · Sandbox                 │
│                                                                              │
│  packages/luau-analysis  —  static analysis of model-authored Luau           │
│    eight rules, three-valued verdict; run by packages/daemon on              │
│    every ChangeSet at submit, inside the trust boundary                      │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                       TRANSPORTS (deliver ChangeSets)                        │
│                                                                              │
│  packages/daemon (M14)                      apps/relay (M17)                 │
│    localhost, DEFAULT                         cloud, OPT-IN                  │
│   • no cloud, no account                     • pairing code + session key    │
│   • keys in OS keychain                      • operator can read changes     │
│   • plugin polls 127.0.0.1                   • plugin long-polls HTTPS       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│                         CONSUMERS (apply ChangeSets)                         │
│  plugin/ (M15)                             packages/opencloud (M48)          │
│   Luau, Roblox Studio                       publish place versions,          │
│   poll → diff preview → approve →           DataStore + MessagingService     │
│   apply → journal → rollback                                                 │
│   console mirror                                                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Every box carrying a milestone marker is unbuilt or partial; the marker names the row in
[`MILESTONES.md`](MILESTONES.md) that lands it. `packages/mcp`, `packages/a2a`,
`packages/cli` and `packages/luau-analysis` now exist and are tested — their rows say what
each still owes, and the connector table in §5 states each one's limits rather than leaving
"exists" to mean "finished". The relay line needs stating plainly:
**relay v1 is not a blind pipe.** It authenticates and integrity-protects every payload
over TLS, but the operator *can* read ChangeSet contents, and the link indicator says so
in those words rather than showing a padlock. A blind relay — end-to-end encrypted
payloads the operator cannot decrypt — is **M19** and is unbuilt
([ADR-014](architecture/adr-014-staged-pairing-crypto.md)). The local daemon has no relay
at all, which is why it is the default.

## 2. The core abstraction: ChangeSet

Everything the system does reduces to *proposing a set of typed operations on a Roblox
place, then applying them under review*. Full schema in [`PROTOCOL.md`](PROTOCOL.md).

```
Run
 ├─ plan          (human-readable steps, streamed)
 ├─ ChangeSet     (ordered Operation[])
 │    ├─ CreateInstance   { className, path, properties }
 │    ├─ SetProperty      { path, property, value }
 │    ├─ WriteScript      { path, source, scriptType }
 │    ├─ MoveInstance     { from, to }
 │    └─ DeleteInstance   { path }
 ├─ Validation    (Zod → Luau static analysis → policy rules)
 ├─ Diff          (what Studio will look like before/after)
 ├─ Approval      (human gate — default ON, ADR-012)
 ├─ Apply         (plugin, transactional per-op with journal)
 └─ Rollback      (inverse ChangeSet replayed from the journal)
```

Why this and not "stream Luau into chat": a ChangeSet is *diffable, reviewable,
reversible, testable, and transport-agnostic*. Free-text code is none of those.

## 3. The two transports

| | **Local daemon** (default) | **Cloud relay** (opt-in) |
|---|---|---|
| Runs | `forgebridge daemon` from `packages/cli`, or the `forgebridge-daemon` bin `packages/daemon/package.json` declares. Both start the same server; the CLI is a front-end over `createDaemon` and holds no transport decisions of its own | `apps/relay` on apple.gg or self-hosted |
| Studio reaches it via | `HttpService` → `http://127.0.0.1:<port>` | `HttpService` → `https://…` long-poll |
| Needs an account | No | Yes (for the sponsored run + sync) |
| Sees user API keys | Yes — locally, from OS keychain | **Never** |
| Sees ChangeSet contents | Yes (it is the user's machine) | **v1: yes** — TLS to an operator who can read them; v2 no (E2E, M19) — ADR-014 |
| Best for | Privacy, offline, local models, BYOK | Chromebooks, no-install, sharing, community |

### The platform constraint, stated accurately

Two facts from the Roblox documentation drive this design, and one of them is easy to get wrong:

1. **Studio has no WebSocket API.** Long-polling is the only option, not a preference.
2. **Plugins can use `HttpService`** — that path is not governed by the experience's
   "Allow HTTP Requests" setting, which covers game scripts. But it is not ungated either:
   the first time a plugin calls out, Roblox prompts the user to grant that plugin permission
   to talk to **that particular web address**, and the user can accept or deny.

That second fact has teeth, because the permission is scoped *per address*:

- The daemon must listen on a **stable, fixed default port**. An ephemeral or
  auto-incrementing port would re-prompt the user on every restart, which reads as broken.
- The relay must be a **single stable hostname**. Per-tenant or per-region subdomains would
  prompt again on each one.
- Onboarding has one unavoidable click. It is worth designing for explicitly — the plugin
  should explain what it is about to ask for *before* Roblox's own dialog appears, so the user
  is not deciding blind.

## 4. Model & provider layer

**Registry as data, never as hardcoded truth** (ADR-007). `packages/model-registry`
ships a catalog file generated by `scripts/sync-catalog.ts`, which reads the live
provider catalogs (OpenRouter's `/api/v1/models` and each direct provider's models
endpoint) and records, per model:

```jsonc
{
  "id": "openrouter:<slug>",
  "provider": "openrouter",
  "displayName": "…",
  "contextTokens": 262144,
  "capabilities": ["tools", "structured-output", "streaming", "vision"],
  "pricing": { "inputPerMTok": 0, "outputPerMTok": 0, "currency": "USD" },
  "free": true,                      // DERIVED from pricing === 0, never asserted
  "verifiedAt": "2026-08-26T00:00:00Z",
  "sourceUrl": "https://openrouter.ai/api/v1/models"
}
```

A model is listed as *free* only because a live catalog said its price was zero at
`verifiedAt`. No free-model list is ever written by hand — that is how stale, wrong
lists get shipped. CI re-runs the sync weekly and opens a PR when the catalog drifts.

**Provider families supported**

1. **OpenRouter** — one key, hundreds of models, OAuth PKCE so users never paste a key.
2. **Direct APIs** — Anthropic, OpenAI, Google, Mistral, Groq, Together, Cerebras,
   DeepSeek, xAI, … each a thin adapter over the Vercel AI SDK v7 provider interface.
3. **Free-tier API providers** — same adapters, flagged `freeTier` with documented limits.
4. **Local models** — Ollama, LM Studio, llama.cpp, vLLM via their OpenAI-compatible
   endpoints. Auto-discovered by the daemon on well-known localhost ports.
5. **BYOK** — any of the above with the user's own key, held locally (C4).

**Router** (`packages/core/router`) picks per run:

```
requirements (needs tools? needs 200k ctx? needs vision?)
   → filter registry by capability
   → order by policy  (free-first | fastest | cheapest | best | pinned)
   → attempt; on 4xx-capability / 429 / 5xx / timeout → next candidate
   → circuit-breaker per provider, health recorded, surfaced in the UI
```

Fallback is explicit and *visible*: the run log names every model attempted and why it
moved on. A silent downgrade would be a lie about what produced the code.

## 5. Agent connectors

One core, six front doors. Each is a thin adapter — no business logic lives in a
connector. All six now have code — `apps/relay` and `packages/sdk-ts` were the last two to
arrive. The `Status` column says what each one's limits are, because "the package exists"
and "the door opens onto everything the row promises" are not the same claim.

| Connector | Package | Status | Reaches |
|---|---|---|---|
| **REST** | `packages/daemon` | shipping | anything that can do HTTP, on `127.0.0.1` |
| **REST + OpenAPI 3.1** | `apps/relay` | built; `apps/relay/test/surface.test.ts` compares the routes it serves against `packages/protocol/schema/openapi.json` in both directions, so a transport that answered a different set of paths would fail rather than fork the protocol. State is in memory only, so a restart drops every session (M40) | the same surface, over a relay. On this transport the operator can read changes — the posture is `relay-tls`, served verbatim, and `relay-e2e` is M19 and unbuilt |
| **MCP** (stdio + streamable HTTP) | `packages/mcp` | built; twelve tools over both transports, verified against the reference SDK client and against the M31 conformance suite on a live daemon. **No editor in the next column has been tried** (M26, M31) | Claude Code / Claude Desktop, Cursor, Windsurf, Cline, Roo, Kilo, Continue, OpenCode, Copilot agent mode, ChatGPT connectors |
| **A2A** (agent card + tasks) | `packages/a2a` | built against A2A `v1.0.1`; card at `/.well-known/agent-card.json`, eight skills, message and task methods, conformant against the M31 suite. Streaming and push are declared unsupported and answer the required error (M27) | agent-to-agent orchestration, multi-agent frameworks |
| **CLI** | `packages/cli` | built; every subcommand, `run` included — it streams the plan and the attempt log off `POST /v1/runs` and never approves. Conformant against the M31 suite | shells, CI, Codex/Copilot CLI, scripting |
| **SDKs** | `packages/sdk-ts`, `packages/sdk-python` | TypeScript: a typed `/v1` client whose route table and wire schemas are generated from `packages/protocol/schema/openapi.json`, with the contract types bound to `@forgebridge/protocol` rather than re-derived; conformant against the M31 suite. Python: generated pydantic models and the producer half of the client — `propose_changeset`, `start_run`, `approve_changeset`, `watch_run` — plus `describe_error`; green against the same suite through a subprocess driver. Both are unpublished by construction — `packages/sdk-ts` is `private` and `packages/sdk-python` carries `Private :: Do Not Upload` — and M49 owns whether either marker comes off | embedding ForgeBridge in other products |

The MCP tool surface below is the shipped one — these are the twelve names
`packages/mcp/src/tools.ts` registers, and a live client has listed them. Three of them
(`read_tree`, `read_script`, `run_tests`) refuse today, because the `/v1` endpoints they
would call do not exist yet; each refusal names the code and tells the model to ask the
human instead:

```
forge.list_projects        forge.read_tree         forge.read_script
forge.start_run            forge.propose_changeset forge.diff_changeset
forge.apply_changeset      forge.run_tests         forge.rollback
forge.tail_output          forge.list_models       forge.link_status
```

`start_run` and `propose_changeset` end in the same place — a ChangeSet the daemon
validated and nobody approved — and differ only in who wrote the operations: the daemon's
own model, or the model calling the tool. Neither is a route past the gate.

`propose_` and `apply_` are deliberately separate calls: an external agent proposes,
a human (or a policy) approves, and only then does anything touch the place. That guarantee
does not rest on a connector honouring it — `packages/daemon` enforces the split at its
endpoints, and the Studio plugin decides approval itself on arrival rather than trusting
the verdict that came with the ChangeSet. Both connectors are built so the split is
structural on their side too: no MCP tool calls the approve path, and `packages/a2a`'s
apply is unreachable without an `ApprovalGrant` a human produced.

## 6. Data & persistence

**Ports and adapters** (ADR-005), because auth is optional and self-hosting is required:

Adapters that exist carry the export that builds them; the rest are the target
shape and are marked. Three of the four secrets backends the original plan named are
built, and each is named here by the export that exists rather than by the name the plan
gave it — a diagram that keeps the planned name after the code lands is a diagram nobody
can grep. Windows Credential Manager and libsecret are still unbuilt, so off macOS
`defaultSecrets()` layers the environment alone; and because `LayeredSecrets.describe()`
reports `readableByOtherProcesses` true if *any* layer is, adding a keychain never
upgrades the posture a UI shows. Both backends are read-only: `TODO(M38)` in
`packages/daemon/src/secrets.ts` owns the remaining platforms and the verified write
path.

```
Storage port ──┬── SqliteStoragePort         node:sqlite under ~/.forgebridge   (no account)
               └── SupabaseAdapter           Postgres 17 + RLS + Realtime       M40 — absent

Secrets port ──┬── KeychainSecrets           macOS Keychain via `security(1)`   read-only; writes M38
               ├── browser key vault         non-extractable key + IndexedDB    apps/web/src/lib/keys/vault.ts
               └── EnvironmentSecrets        CI / headless                      packages/daemon/src/secrets.ts

Telemetry port ┬── otlpTelemetry             OTLP/HTTP+JSON over fetch; no vendor dependency
               └── errorReporterTelemetry    an injected client — a Sentry module object fits
```

The daemon has a second, narrower persistence seam of its own — `DaemonStore`,
the local transport's queues, nonce watermarks and link table — with the same
two implementations: `InMemoryDaemonStore` (the default) and
`SqliteDaemonStore`. One suite runs against both (`DAEMON_STORE_SUITE`).

Neither telemetry adapter is constructed unless an operator names a collector:
`telemetryFromEnvironment` returns `undefined` otherwise, so "off by default"
is the absence of an adapter rather than a disabled one (ADR-011).

Core entities (same shape in both adapters):

```
project(id, owner?, name, place_id?, created_at)
tree_snapshot(project_id, version, instances_json)      -- current known place state
run(id, project_id, prompt, model_attempts_json, status, started_at, finished_at)
changeset(id, run_id, operations_json, validation_json, status)
journal(id, changeset_id, applied_ops_json, inverse_ops_json, applied_at)  -- rollback
link(id, project_id, transport, pairing_state, session_key_id, last_seen_at)
inventory_item(id, kind, recipe_json, source, author?)   -- mechanic cards
game_map_node(project_id, node_id, kind, position, edges_json)
setting(scope, key, value)
```

Signed-out users get the identical schema in SQLite. Signing in later triggers a
one-way *adopt* migration that uploads local rows — never the reverse, and never
silently.

## 7. Security posture (summary — full detail in `THREAT-MODEL.md`)

1. **The model is an untrusted caller.** Every ChangeSet is Zod-validated, then
   Luau-static-checked, then policy-checked (path allowlist, no unreviewed `require`,
   no `HttpService` egress to non-allowlisted hosts) before a human ever sees it.
2. **Approval-gated apply.** Default is manual approval per ChangeSet, with an
   opt-in auto-apply scoped to a path prefix. Every apply is journaled with an
   inverse; rollback is a first-class operation, not a git suggestion.
3. **Keys are local.** apple.gg's servers have no column that could hold a user API key.
   The single server-side key is apple.gg's own, used only for the sponsored daily run.
4. **Pairing is authenticated, and v1 is not private from the operator.** Short pairing
   code → session key; v1 authenticates and integrity-protects payloads to a TLS relay,
   which means the operator can read what crosses it — the UI says so in those words.
   End-to-end payload encryption, which makes the relay blind, is v2 and lands in M19.
   Local daemon mode has no relay at all and is the recommended default (ADR-014).
5. **Prompt injection is assumed.** Content fetched into context (docs, community cards,
   another agent's output) is data, never instruction; the pipeline never lets retrieved
   text expand the ChangeSet's write scope.

## 8. Cost control without money (ADR-010)

Deleting credits does not delete the bill. The replacements — and how much of each is real:
only the first of the four below is true of this repository today. **M45 is status NEW.**
There is no counter, no Redis client, no rate-limiting middleware and no sponsored run in
this tree; the other three bullets are the design M45 lands, marked as such.

- **Default path costs us nothing** — local daemon + BYOK/local model = zero server cost.
  This one holds now: `packages/daemon` binds `127.0.0.1` and talks to no service of ours.
- **Sponsored run (M45)**: 1 AI run per day per *verified* user (Roblox OAuth, account-age
  floor), to be executed with apple.gg's key, gated by a date-keyed counter in Upstash
  Redis plus per-IP and per-ASN buckets.
- **Rate limits everywhere (M45)**: sliding-window on relay endpoints, per-link ceilings on
  ChangeSet size and op count. The protocol's `LIMITS` already bound a ChangeSet's size; the
  per-link and per-endpoint ceilings are the part that is not written.
- **Graceful degradation (M45)**: when the sponsored budget for the day is exhausted, the UI
  is to say so plainly and point to BYOK/local — never silently queue or degrade.

## 9. Deployment topologies

| Topology | Who runs it | Pieces |
|---|---|---|
| **Solo local** | any user, no account | daemon + plugin + local model or BYOK |
| **apple.gg** | us | Vercel (web + relay) · Supabase · Upstash · Sentry/OTel |
| **Self-host full** | anyone | `docker compose up` → relay + Caddy (TLS) + OTel collector. **Built, and smaller than this row used to claim**: there is no database and no Redis, because the relay holds session keys in memory and nowhere else and persisting them would put the material to forge a delivery to any user in one file. `apps/web` is not in the stack either — it is a static front end a self-hoster deploys separately (`docs/DEPLOYMENT.md`). The collector runs and nothing exports to it yet (M44). See [`SELF-HOSTING.md`](SELF-HOSTING.md) |
| **Self-host lite** | anyone | `deploy/daemon.Dockerfile` — the daemon alone. Useful on Linux with `--network host`; **not** useful on Docker Desktop for macOS or Windows, because the daemon binds the container's loopback and Studio is outside the VM. The Dockerfile says so at the top rather than leaving it to be discovered |
| **CI / headless** | teams | CLI + SDK, env-based secrets, no UI |

## 10. What already exists

Two different answers, and conflating them is how this section went stale before.

**In this repository, right now** — `ls packages/` returns `a2a cli conformance core
daemon luau-analysis mcp model-registry opencloud protocol sdk-python sdk-ts
storage-sqlite`, and every one of the thirteen has code and tests in it. `ls apps/`
returns `relay web`, and so do both of those:

| Directory | What is in it |
|---|---|
| `packages/protocol/` | The frozen contract: Zod schemas and the types inferred from them, with its own test suite. `schema/` holds the generated JSON Schema and OpenAPI projections (M08); nothing in it is hand-written, and `npm run verify:schemas` fails on any difference between it and `src/`. |
| `packages/core/` | `RunPipeline`, the router, policy checks, the inverse-operation logic, and the ports (Storage, Secrets, Transport, Telemetry, Sandbox), with tests. |
| `packages/daemon/` | The localhost transport: HTTP server, pairing, envelope handling, store seam, and the `forgebridge-daemon` bin, with tests. |
| `packages/model-registry/` | The synced catalog and its capability metadata, plus `scripts/sync-catalog.ts` and the weekly `catalog-drift.yml` job that opens a PR on drift. |
| `packages/luau-analysis/` | The Luau linter: a tokenizer, a block recogniser, eight rules, and an `analyse` that never reports a pass for a source it could not read. `packages/daemon` calls it on every ChangeSet. |
| `packages/mcp/` | The MCP server: twelve tools over stdio and streamable HTTP, with the SDK confined to `src/server.ts` and everything above it tested against a double. |
| `packages/a2a/` | The A2A connector: Agent Card, message and task methods over JSON-RPC, and an approval seam that makes apply unreachable without a human grant. |
| `packages/cli/` | `forgebridge` — `daemon`, `link`, `status`, `models`, `run`, `diff`, `apply`, `rollback`, with `--json` output and distinct exit codes. `run` streams the plan and the attempt log, and never approves. |
| `packages/sdk-ts/` | The TypeScript SDK: a typed `/v1` client driven by a route table and wire schemas generated from the protocol's own OpenAPI document. Not published (M49). |
| `packages/sdk-python/` | The generated pydantic models and a thin `/v1` client, with ruff and pytest. Not published (M49). |
| `packages/conformance/` | The one executable definition of what a connector must do, plus the cheating adapters that prove each case can fail. Five connectors inherit it through one adapter interface. |
| `packages/storage-sqlite/` | `DaemonStore` and `StoragePort` over `node:sqlite` — the persistence that needs no account. One suite runs against it and the in-memory default both. |
| `packages/opencloud/` | Roblox Open Cloud: place versions, standard data stores, MessagingService, and the `forgebridge-opencloud` bin. Zero runtime dependencies. |
| `apps/relay/` | The cloud transport: the daemon's `/v1` surface over a relay, with pairing, long-poll and SSE, and a privacy posture it is required to state rather than draw. In-memory state only (M40). |
| `apps/web/` | apple.gg — the official instance, as a static front end with no route handler of its own, which is what keeps a credential unable to reach a server we run (ADR-006). |
| `plugin/` | The Studio plugin in Luau — transport, diff, approve, apply, journal — and a Luau test suite run by hand (in CI: M41). |
| `scripts/` + `.github/workflows/` | The gates: boundaries, brand-asset provenance, key custody, secret scanning, DCO, and their own tests. Eight workflows — `ci`, `catalog-drift`, `dco`, `codeql`, `semgrep`, `sbom`, `dependency-review` and `release`. `release` is manual-only, defaults to publishing nothing, and has never published anything: no credential for either registry exists here. |

Two rows of the target shape in [`REPO-LAYOUT.md`](REPO-LAYOUT.md) are still empty
directories nothing has created: `packages/storage-supabase/` (M40) and `packages/ui/`
(M32–M39). Everything else that document draws exists. A milestone marker in §1 does not
by itself mean absent — `packages/core` (M09–M13), `packages/daemon` (M14) and `plugin/`
(M15) are all partial rather than missing, and so are several of the six connectors, each
for a reason its row states; [`MILESTONES.md`](MILESTONES.md) carries the per-row status.
No test count is quoted here on purpose: `npm run test` prints the real one, and a number
transcribed into prose is the first thing in this document to rot.

**Elsewhere** — the predecessor private repo (`Claude-Web-Cloner`, HEAD `b174ec2`,
referenced as lineage in `NOTICE` and quarantined by
[ADR-013](architecture/adr-013-fresh-public-repo.md)) carries a large part of the *web app*
half: 15 pages, 20 route handlers, 121 components, 24 test files, 14 Supabase migrations, a
Luau plugin file, and a Roblox knowledge corpus. None of it is in this repository, and none
of it is a bridge — it is the client half, and `MILESTONES.md` marks which of the 50 rows
it covers. Porting it here is M32–M39, and ADR-013 requires every file to be read before it
moves.
