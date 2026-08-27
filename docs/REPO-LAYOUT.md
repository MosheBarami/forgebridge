# Monorepo layout

This is the *target* shape. A line with no marker is a directory that has code in it
today; a line marked `M__` is a directory this repository does not have yet, and the marker
names the row in [`MILESTONES.md`](MILESTONES.md) that creates it. Nothing here is a
placeholder pretending to be a package — `ls packages/` returns exactly
`a2a cli conformance core daemon luau-analysis mcp model-registry opencloud protocol sdk-python sdk-ts storage-sqlite`.

```
forgebridge/
├── LICENSE                     MIT
├── NOTICE                      third-party assets, licences, attribution
├── GOVERNANCE.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
├── turbo.json  package.json    npm workspaces + Turborepo
│
├── packages/
│   ├── protocol/               ⭐ Zod schemas → TS types. Zero deps but zod.
│   │                             schema/ = generated JSON-Schema + OpenAPI (M08)
│   ├── core/                   RunPipeline, Router, validators, ports. No vendor imports.
│   │                             telemetry/ = OTLP + injected-reporter adapters (M44)
│   ├── conformance/            the connector conformance suite; bin `forgebridge-conformance`
│   ├── model-registry/         synced catalog + capability metadata + sync script
│   ├── daemon/                 localhost transport (the default path); bin `forgebridge-daemon`
│   ├── luau-analysis/          static checks for model-authored Luau        M10
│   ├── mcp/                    MCP server (stdio + streamable HTTP)         M26
│   ├── a2a/                    A2A agent card + task endpoints              M27
│   ├── cli/                    the `forgebridge` binary                     M28
│   ├── sdk-python/             pydantic models + client (uv + hatch)        M30 — unpublished
│   ├── sdk-ts/                 generated /v1 client + ergonomics            M29 — unpublished
│   ├── opencloud/              Roblox Open Cloud: publish, DataStore, msg   M48
│   │                             zero runtime deps; bin `forgebridge-opencloud`
│   ├── storage-sqlite/         DaemonStore + StoragePort over node:sqlite — no account needed
│   ├── storage-supabase/       Storage port adapter — apple.gg / self-host  M40 — absent
│   └── ui/                     shared React primitives (used only by apps/) M32–M39 absent
│
├── apps/
│   ├── web/                    ⭐ apple.gg — Next.js 15, official instance  M32–M39
│   ├── relay/                  cloud transport service                      M17
│   └── docs/                   documentation site                           M50 — absent
│
├── plugin/                     ⭐ Roblox Studio plugin (Luau) + build to .rbxm
│   ├── src/                    modules: transport, diff, approve, apply, journal
│   └── tests/                  Luau unit tests (run by hand; in CI: M41)
│
├── assets/brands/              official third-party logos + provenance manifest
│   ├── manifest.json           source URL · licence · retrieved-at · constraints
│   └── <slug>/logo.svg         none committed yet — the manifest is the only file here
│
├── examples/                   one runnable example per connector           M50
│                               typescript · python · cli · mcp · a2a · opencloud
├── deploy/                     Caddyfile · otel-collector.yaml · daemon image M47
├── docker-compose.yml          relay + TLS + OTel collector; `.env.example`    M47
├── .changes/                   one file per user-visible change → CHANGELOG.md M49
├── scripts/                    sync-catalog · generate-schemas · verify-assets
│                               · verify-boundaries · verify-no-key-storage
│                               · verify-no-secrets · __tests__
└── .github/workflows/          ci · catalog-drift · dco · release
                                (M42 adds four more; `release` is manual-only
                                 and has never published anything)
```

## Boundary rules (enforced by `scripts/verify-boundaries.ts`, run in CI)

Four of the five are machine-checked today, by the script named above and by nothing else.
There is no ESLint in this repository and no `no-restricted-imports` config — every package's
`lint` script is an `echo` (TODO(M04)) — so the rules below cite the check that actually runs.
The identifiers `B1`–`B4` are the ones the script reports.

1. **B1** — `packages/protocol` imports **nothing** but `zod`. It is the only package every
   other package may depend on.
2. **B2** — `packages/core` may not import `next`, `@supabase/*`, `@sentry/*`, or any vendor
   SDK. Vendors live behind ports, in adapter packages.
3. **B4** — `apps/*` may import any package. No package may import an app.
4. `plugin/` shares no code with TypeScript — it re-implements the protocol by hand, and
   `plugin/src/Path.luau`, `Value.luau` and `Apply.luau` say in comments which TypeScript
   file each mirrors. **Still not machine-checked.** Half of what it needs now exists:
   **M08** generates and commits the JSON Schema projection under
   `packages/protocol/schema/`, so there is finally something to compare the Luau mirror
   against. The conformance test that does the comparing is a test, so it belongs to the
   testing milestone — TODO(M41). `plugin/README.md` and `plugin/src/Config.luau` name the
   same milestone; if you change one, change all three.
5. **B3** — nothing under `packages/`, `plugin/`, `examples/` or `apps/` may contain the
   string `apple.gg`, with one exemption: `apps/web/` **is** the official instance, so
   naming itself is its job. Those are the trees a fork adopts; `docs/`, the root
   `README.md` and `NOTICE` name the official instance on purpose, and are out of scope by
   design. The scope is a tree with one named exemption rather than a list of neutral
   directories, so an app added tomorrow is in scope the day it lands — `apps/relay`
   arrived while the scan covered three trees. Widening it found nothing —
   `apps/relay` was already neutral. The scope was wrong regardless: a rule
   stated as "everything outside `apps/web`" that reads three named directories
   is a rule whose next violation is invisible.

## Language split

| Surface | Language | Toolchain |
|---|---|---|
| everything TypeScript | TS 5.x strict | Node 22+, Turborepo, Vitest (Playwright arrives with M41) |
| Studio plugin | Luau | Rojo-compatible layout, `.rbxm` build artefact |
| Python SDK | Python 3.10+ | uv, hatch, pytest, pydantic v2 |
| infra | Docker / Compose | `docker compose up` for the relay stack; `deploy/daemon.Dockerfile` for the lite image ([`SELF-HOSTING.md`](SELF-HOSTING.md)) |
