# Deployment

Two things get deployed out of this repository, and they are unrelated.

| | What | Where | Documented in |
|---|---|---|---|
| **The relay** | `apps/relay` — the cloud transport | anywhere Docker runs | [`SELF-HOSTING.md`](SELF-HOSTING.md) and below |
| **The web surface** | `apps/web` — the official instance | Vercel | [below](#appsweb-on-vercel) |

Neither is required to use ForgeBridge. The default path is `packages/daemon` on
your own machine, with no server of any kind — see the Quickstart in
[`README.md`](../README.md).

## One command, from a clean clone

```sh
git clone https://github.com/MosheBarami/forgebridge.git && cd forgebridge && \
  cp .env.example .env && RELAY_DOMAIN=localhost docker compose up -d
```

That is the whole thing. No `npm install` on the host, no toolchain, no build
step you have to remember: the image builds inside Docker from
`package-lock.json`, and `.dockerignore` keeps the context to the tree.

For a real deployment, edit `RELAY_DOMAIN` in `.env` instead of passing it
inline, point its DNS at the host, and make sure ports 80 and 443 reach it.
Caddy provisions the certificate.

### What "verified" means on this page

That command was run, in this repository, into a temporary directory containing
nothing but a clean copy of the tree — no `node_modules`, no `dist/`, no cached
build output. What came back:

```
caddy           Up (published 80, 443)
otel-collector  Up
relay           Up (healthy)

$ curl -sk https://localhost/v1/health
  transport : relay-tls
  tls       : { required: true, proxyHops: 1 }

$ curl -sk -X POST https://localhost/control/sessions
  → sessionId, projectId, producerToken, pairingCode, transport, privacyPosture, …
```

Three services up, TLS terminated by Caddy with the relay believing exactly one
proxy hop, and a real pairing code minted through the whole path. The lite
daemon image was built and run from the same tree and printed its pairing code
and producer token.

What is *not* verified, and would be dishonest to imply: nothing here has been
deployed to a public host, no certificate has been issued by a public CA from
this tree, and `apps/web` has never been deployed anywhere. See below.

### If the command fails

`docker compose config` parses the file without starting anything and is the
fastest way to separate "my `.env` is wrong" from "the stack is wrong". Then the
symptom table at the end of [`SELF-HOSTING.md`](SELF-HOSTING.md#when-something-is-wrong).

## `apps/web` on Vercel

**No deployment has ever been made from this repository, and it holds no Vercel
credential.** What follows is read off the tree — `apps/web/package.json` and
`apps/web/next.config.ts` — rather than transcribed from a dashboard somebody
remembers. Treat it as the settings to enter, not as a report of a working
deployment.

| Setting | Value | Why |
|---|---|---|
| Framework preset | Next.js | `next@^16` in `apps/web/package.json`. |
| Root directory | `apps/web` | Leave "include files outside the root directory" **on**: the app imports three workspace siblings. |
| Install command | `npm ci` (at the repository root) | The lockfile is the root's; a per-app install would not resolve `@forgebridge/*`. |
| Build command | `npm run build --workspace @forgebridge/web` | Turborepo builds the workspace dependencies first. |
| Node version | 22 | `engines.node` in the root manifest. |
| Environment variables | none | The app ships zero route handlers and no authentication, and works signed out. There is nothing for it to hold. |

`next.config.ts` sets `outputFileTracingRoot` to the repository root explicitly,
which is what makes the output trace the same on a developer machine and in a
build container: Next otherwise walks up looking for a lockfile and stops at the
first one it finds, which on some machines is a stray one in the home directory.

`transpilePackages: ['@forgebridge/protocol']` means a change to the contract is
picked up without a stale `dist/` quietly serving the old one.

### What deploying `apps/web` does not give you

A daemon. The web surface talks to a daemon on the *viewer's* machine over
loopback — that is what makes signed-out a first-class mode rather than a
degraded one. A hosted `apps/web` with no daemon running locally can render
every surface and propose nothing, which is the designed behaviour and not a
misconfiguration.

## Reproducibility, and where it stops

**Node dependencies** are installed with `npm ci` from `package-lock.json`,
inside the image, so the same commit produces the same tree.

**Base images** are pinned in `docker-compose.yml`. `latest` on a collector
means the processor pipeline can change under a deployment nobody touched, and
`scripts/__tests__/deployment.test.ts` plants an unpinned image to prove the rule
fires.

**Images are not pinned by digest**, only by tag, and a tag is mutable. Pinning
by digest is a real improvement and it needs digests recorded from a pull
somebody verified — a value invented here would look like a check while being
one. It is not done, rather than half-done.

**The plugin `.rbxm`** is built by `.github/workflows/release.yml` with the Rojo
version pinned in `aftman.toml`, and the release publishes a `SHA256SUMS` beside
it because a plugin runs inside Studio with the user's session
(`THREAT-MODEL.md` T6). That workflow is manual-only and has never run with
publishing enabled.
