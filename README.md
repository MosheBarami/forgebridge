# ForgeBridge

**A universal bridge between any AI model or agent and Roblox Studio.**

ForgeBridge is the engine. [apple.gg](#the-two-names) is the official instance that runs on
top of it. The engine is neutral, MIT-licensed, and yours to fork, self-host, or embed —
the instance is one client of it among many.

> **Status: pre-release.** Nine packages, all green — the frozen protocol, the core, the
> local daemon, the model registry, the Luau analyser, and the MCP, A2A, CLI and Python
> connectors — plus a Studio plugin with its own Luau suite. Nothing is published to npm or
> PyPI yet, so everything below runs from a checkout. Every command, diagram box and
> directory that depends on unshipped work is marked with the milestone that lands it, and a
> milestone number is never a claim of completeness: the row in
> [`docs/MILESTONES.md`](docs/MILESTONES.md) says what is still owed. No install command in
> this README points at a package that does not exist, and no diagram in it points at a
> capability that does not either.

---

## What it is

A model writes Luau. Something has to get that Luau into a Roblox place *safely* — reviewed,
reversible, and without handing anyone your API keys. That "something" is the part everyone
rebuilds badly, and it is the only thing ForgeBridge does.

The unit of work is a **ChangeSet**: an ordered list of typed operations on a place
(`createInstance`, `setProperty`, `writeScript`, `moveInstance`, `deleteInstance`) that can be
diffed, reviewed, approved, applied, journaled, and rolled back. Not a wall of streamed code
in a chat window — free text is none of those things.

Any producer can make one: a chat UI, an MCP client like Claude Code or Cursor, another agent
over A2A, a CLI in your CI, your own script through the SDK. Any transport can carry one: a
daemon on your own machine, or an opt-in cloud relay. One consumer applies them: the Roblox
Studio plugin.

**What it is not:** a model, a hosted IDE, a Roblox account manager, or a paid product.

## The one picture

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
│    eight rules; run by packages/daemon on every ChangeSet at submit          │
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

Every box carrying a milestone marker is unbuilt or partial — the marker is the row in
[`docs/MILESTONES.md`](docs/MILESTONES.md) that lands it, and the row says which of the two
it is. `packages/mcp`, `packages/a2a`, `packages/cli` and `apps/relay` exist and are tested;
each still owes something its row names. The relay line is the one worth
reading twice: **relay v1 is not a blind pipe.** It authenticates and integrity-protects
every payload and runs over TLS, but the operator *can* read ChangeSet contents, and the
link indicator says exactly that. A blind relay — end-to-end encrypted payloads the
operator cannot decrypt — is **M19**, and it is not built
([ADR-014](docs/architecture/adr-014-staged-pairing-crypto.md)). The local daemon has no
relay at all, which is why it is the default.

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the wire contract is in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md); the fourteen decisions behind it are in
[`docs/architecture/`](docs/architecture/README.md).

## Quickstart — the local daemon path

This is the default and the recommended one: **no account, no cloud, no key ever leaving your
machine.** Requires Node 22+ and Roblox Studio.

### What works today

```bash
git clone <this repository>
cd forgebridge
npm ci
npm run check          # typecheck · test · build across the workspace
```

> **TODO(M04):** `npm run check` also runs `npm run lint`, and that is not a gate. No linter
> is configured anywhere in this repository — every package's `lint` script is an `echo` that
> exits 0. It is listed here as an omission rather than a feature so nobody reads a green
> `check` as a linted codebase. The M04 follow-up row in
> [`docs/MILESTONES.md`](docs/MILESTONES.md) tracks configuring one.

### The loop

From a checkout, after `npm ci && npm run build` — the workspace links `forgebridge` into
`node_modules/.bin`, so `npx` finds it. Nothing is published to npm yet (M49).

```bash
# 1. Start the bridge on your own machine.
#    Both allowlists deny by default: no writable path, no reachable host.
npx forgebridge daemon \
  --allow-path ServerScriptService.Shop \
  --allow-http-host api.example.com
#    Prints the pairing code and the producer token, once, to stderr.

# 2. Build the Studio plugin and drop it in your local Plugins folder.
#    Needs Rojo — see plugin/BUILD.md for the exact command and its caveats.
cd plugin && rojo build --output ForgeBridge.rbxm

# 3. In Studio, open the ForgeBridge panel and type the pairing code.
#    Roblox asks once for permission to let the plugin reach that address.
#    The plugin explains what it is about to ask for before that dialog appears.

# 4. Run a prompt. Prints every model the router tries, as it tries them.
npx forgebridge run "add a purchase handler to the shop"
#    Ends at a changeset id in "validated". Nothing has touched the place.

# 5. Review and apply. Every command takes --json for scripting.
npx forgebridge status
npx forgebridge diff <changeset-id>    # review before anything touches the place
npx forgebridge apply <changeset-id>
npx forgebridge rollback <journal-id> --expected-version <n>
```

> **`forgebridge run` proposes; it never applies.** A run leaves a ChangeSet in
> `validated` and prints the id, how to review it, and how a human approves it. There is no
> `--yes`: that flag would be the off switch for the only gate between a model and your
> place. It prints every model the router tried as it tries them, and again as one line
> when it is done — `glm-5.2:free → rate-limited → minimax-m3:free` — because a model
> swapped in without an attempt beside it is a silent substitution.

That summary line is not an illustration. It is the shape of a real run made on 2026-08-27
against OpenRouter's free tier, which fell through two models to reach a third:

```
models     z-ai/glm-5.2:free → rate-limited → nvidia/nemotron-3-super-120b-a12b:free → invalid-output → liquid/lfm-2.5-2.6b:free
changeset  b000a62e-e6d4-42c5-9d29-ac59759a66b9  validated
validation luau ok, policy ok
           computed by forgebridge-daemon@0.1.0
```

Three properties of that run are worth naming, because each is a thing the pipeline is *for*.
Every model reached is in `run.attempts` with its outcome, including the two that failed — the
fallback is recorded, not just performed. The verdict is the daemon's: a ChangeSet submitted
with its own `validation: ok` over unparseable Luau is re-judged and comes back `fail`, and
`approve` refuses it. And the run stopped at `awaiting-approval` — the ChangeSet was never
applied, because no code path from a run to an apply exists to take.

### Bring your own model

Any of these, chosen per run by the capability router:

- **Local models** — Ollama, LM Studio, llama.cpp, vLLM. Discovered by the daemon on their
  well-known ports. Nothing leaves your machine at all.
- **OpenRouter** — one key, hundreds of models, OAuth so you never paste a key (M23).
- **Direct provider APIs** — with your own key, held in your OS keychain.

The model list is [synced from live provider catalogs](docs/architecture/adr-007-registry-as-synced-data.md),
never hand-written, and a model is labelled *free* only because a catalog reported a price of
zero at a recorded timestamp. Stale hand-maintained "free models" lists are how tools like
this lose trust.

### Connecting an agent instead

One core, five front doors — MCP, A2A, REST (the daemon on localhost or `apps/relay` in the
cloud, serving the same nineteen `/v1` routes), the CLI, and the SDKs. MCP is the primary
connector (ADR-009), so an editor that speaks it reaches
ForgeBridge through these twelve tools, which is the surface `packages/mcp` registers today:

```
forge.list_projects        forge.read_tree         forge.read_script
forge.start_run            forge.propose_changeset forge.diff_changeset
forge.apply_changeset      forge.run_tests         forge.rollback
forge.tail_output          forge.list_models       forge.link_status
```

`propose_` and `apply_` are separate calls on purpose. An agent proposes; a human or a policy
approves; only then does anything touch your place. A producer cannot approve its own work.

Three of the twelve — `read_tree`, `read_script`, `run_tests` — refuse today, because the
`/v1` endpoints behind them do not exist yet (M09/M13/M31/M41); each refusal names the code
and tells the model to ask you instead. And **no editor on that list has actually been tried**:
what has been verified is a run against the reference MCP SDK's own client. M31 is the
conformance suite that would make the editor list a claim rather than an intention.

### Self-hosting, when Studio and the producer are not on one machine

The Quickstart above needs no server: `packages/daemon` binds `127.0.0.1`, your key stays on
your machine, and there is no relay in the path. That is the default and most people want
nothing else.

When the producer is somewhere Studio cannot reach — CI, a shared box, a teammate — you need
the second transport, and you can run it yourself:

```sh
git clone https://github.com/MosheBarami/forgebridge.git && cd forgebridge && \
  cp .env.example .env && RELAY_DOMAIN=localhost docker compose up -d
```

Three containers: Caddy terminating TLS, the relay behind it publishing no port of its own, and
an OpenTelemetry collector. `RELAY_DOMAIN=localhost` gets you a certificate from Caddy's own CA
and a genuinely end-to-end run of the whole path; swap in a real hostname when you mean it.

Read the posture before you do: **on this transport the relay operator can read your changes**
(ADR-014), which is a good reason for the operator to be you. What the stack contains, what it
deliberately does not, and every way it fails are in
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

## The promises

Written down so they can be held against us. The long form is in
[`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

1. **Free forever.** No credits, no metering, no store, no paywall, no "pro" tier, no feature
   held back for a hosted plan.
2. **No required attribution.** Build with it, ship it, say nothing. MIT's notice requirement
   is the only obligation, and it does not reach your game.
3. **No telemetry by default.** Self-hosted and local installs phone home to nobody. The
   official instance discloses exactly what it collects, in the UI, before it collects it.
4. **Your keys stay yours.** A BYOK key lives in your OS keychain — or, in a browser, as a
   non-extractable WebCrypto key — and reaches a provider only from your own machine
   ([ADR-006](docs/architecture/adr-006-key-custody-daemon-as-egress.md)). No key of yours
   is ever stored server-side. The one key any ForgeBridge server holds is apple.gg's own,
   used for the sponsored daily run — never a user's. That is a CI gate rather than a
   promise:
   `npm run verify:no-key-storage` fails the build if any shape that reaches storage declares
   a credential-shaped field, if a `StoragePort` method accepts or returns one, or if a
   credential-shaped value reaches disk, a database, a log or telemetry. It reads declarations
   and call sites, so it cannot see a key smuggled through a blandly named `string`, and it
   does not read the Luau plugin — it prints both limits on every run, so the gate and this
   sentence say the same thing.
5. **The core stays neutral.** If the official instance disappears tomorrow, ForgeBridge keeps
   working.

Promises 4 and 5 are not sentiments; they are CI gates. `npm run verify:boundaries` fails the
build if anything under `packages/` names the official instance, if `packages/protocol` grows
a dependency beyond zod, if `packages/core` imports a vendor SDK, or if any package imports an
app. `npm run verify:no-key-storage` fails it if a credential-shaped field appears in a shape
that reaches storage. Policies without gates decay in three months — and a gate is only worth
the sentence it can actually carry, which is why both of those sentences name their limits.

## The two names

One monorepo, two names, for one reason: a rival tool will install `@forgebridge/mcp`, and it
will not install a competitor's brand. See
[ADR-001](docs/architecture/adr-001-forgebridge-core-applegg-instance.md).

- **ForgeBridge** — the neutral core. Everything under `packages/` and `plugin/`. MIT, no
  strings, no reserved marks. Fork it, rename your fork, ship it commercially.
- **apple.gg** — the official hosted instance (`apps/web`). The name and mark are reserved by
  the project owner and are **not** licensed under MIT. Use the code freely; do not present
  your fork as apple.gg.

## Trademarks

> Third-party names and logos are the property of their respective owners and are used
> nominatively to identify the services ForgeBridge connects to. Their inclusion is not an
> endorsement, and they are **not** covered by the MIT licence.

Every third-party asset in this repository is recorded in
[`assets/brands/manifest.json`](assets/brands/manifest.json) with its official source URL, the
terms it is used under, the date it was retrieved, and its SHA-256 checksum.
`npm run verify:assets` fails the build if any asset is present without a complete record, if
a checksum drifts, or if anything is flagged as generated. No brand asset here is AI-drawn,
redrawn, or approximated — where an official asset cannot be used under acceptable terms, a
plain text label is used instead. Full policy: [`docs/BRAND-ASSETS.md`](docs/BRAND-ASSETS.md)
and [`NOTICE`](NOTICE).

## Repository layout

A directory listed below either has code in it or says which milestone puts code there.
Nothing here is a placeholder pretending to be a package.

```
packages/protocol/       the contract — Zod schemas, zero deps but zod    frozen ✅
packages/core/           RunPipeline, router, policy, breaker, ports      M09–M13
packages/daemon/         localhost transport — the default path           M14
packages/luau-analysis/  static analysis of model-authored Luau           M10
packages/model-registry/ synced model catalog + capability metadata       M20
plugin/                  Roblox Studio plugin (Luau) + its own tests      M15
packages/mcp/            MCP server (stdio + streamable HTTP)             M26
packages/a2a/            A2A agent card + task endpoints                  M27
packages/cli/            the `forgebridge` binary                         M28
packages/sdk-ts/         generated /v1 client + ergonomic wrapper         M29
packages/sdk-python/     generated pydantic models + a thin client        M30
packages/conformance/    the connector conformance matrix + its cheats    M31
packages/storage-sqlite/ SQLite adapters over `node:sqlite`               M40
packages/opencloud/      Roblox Open Cloud — places, DataStore, messaging M48
examples/                one runnable walk-through per connector          M50
apps/relay/              the cloud transport — a pipe, not a brain        M17
apps/web/                apple.gg — the official instance                 M32–M39
assets/brands/           official third-party marks + provenance manifest
scripts/                 sync-catalog · generate-schemas · verify-assets
                         · verify-boundaries · verify-no-key-storage
                         · verify-no-secrets
                         · docs-claims-rules (read by the gate self-tests)
docs/                    architecture, protocol, threat model, milestones, ADRs
docker-compose.yml       the self-hosting stack — relay, TLS, OTel collector M47
deploy/                  Caddyfile, collector config, the lite daemon image  M47
```

Every `packages/*` row, both `apps/*` rows and `plugin/` has code and its own tests in it. The
remaining rows are not packages and do not pretend to be: `assets/brands/` holds third-party
marks and their provenance manifest, `scripts/` holds the gates and their self-tests, `docs/`
holds prose, `examples/` holds one runnable walk-through per connector, and `deploy/` holds the
configuration `docker-compose.yml` mounts. No row here says *empty* or *absent* any more —
`examples/` was the last one, and it filled up as M29, M30 and M50 landed their walk-throughs. A
milestone on a row that has code is the milestone the row is still working through, not a
promise that the directory will appear.

The table is checked in both directions. `scripts/__tests__/docs-claims.test.ts` asserts that
every directory carrying a `package.json` has a row here and that no such row calls itself empty
or absent — which is the check that was missing when `apps/relay`, `packages/conformance` and
`packages/storage-sqlite` each landed as a full package and none of them reached this table, and
when the `apps/web` row still read *absent* after the app had built and passed 248 tests.

A milestone number is not a claim of completeness: `packages/mcp` has not been tried from any of
the editors M26 names, and no connector can read a tree snapshot, because no `/v1` route serves
one. Each row in [`docs/MILESTONES.md`](docs/MILESTONES.md) says what its package still owes.

Two directories that this section listed as absent for most of the project's life now have
code: `packages/sdk-ts/` (M29) and `packages/opencloud/` (M48). Both have rows above. The
sentences that named them as missing are gone rather than annotated, because a layout table is
the one document where a stale absence reads exactly like a correct one.

The boundary rules that keep this shape honest are in
[`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md) and enforced by `scripts/verify-boundaries.ts`.

## Documentation

| Document | What it answers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the whole system fits together |
| [PROTOCOL.md](docs/PROTOCOL.md) | The wire contract, its invariants, its endpoints |
| [architecture/](docs/architecture/README.md) | The fourteen ADRs — every decision and what was rejected |
| [THREAT-MODEL.md](docs/THREAT-MODEL.md) | What we defend against, and what we do not |
| [MILESTONES.md](docs/MILESTONES.md) | The fifty milestones and their status |
| [REPO-LAYOUT.md](docs/REPO-LAYOUT.md) | Where code goes and which boundaries are enforced |
| [BRAND-ASSETS.md](docs/BRAND-ASSETS.md) | The official-assets-only rule and its CI gate |
| [GOVERNANCE.md](docs/GOVERNANCE.md) | Who decides, how, and what we promised |
| [ROADMAP.md](docs/ROADMAP.md) | What is shipped and what is not — generated from MILESTONES.md |
| [SELF-HOSTING.md](docs/SELF-HOSTING.md) | Running your own relay, and what the stack deliberately lacks |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | One command from a clean clone, and the Vercel settings for `apps/web` |
| [COMMUNITY.md](docs/COMMUNITY.md) | Labels, triage, and how a first patch becomes a maintainer |

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: sign your commits off
(`git commit -s`), open an RFC before changing `packages/protocol` or `plugin/`, and expect CI
to check the boundaries. There is no CLA and there never will be.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go
through [`SECURITY.md`](SECURITY.md), not the public issue tracker.

## Licence

[MIT](LICENSE), for our code. See [`NOTICE`](NOTICE) for the third-party trademark carve-out —
we cannot license what we do not own, and we do not pretend to.
