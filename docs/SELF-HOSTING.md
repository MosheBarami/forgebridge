# Self-hosting ForgeBridge

The bar this page is written to: **a stranger self-hosts from it without
contacting anyone.** If you have to ask a question that is not "what does this
error mean", the page has failed and that is worth an issue.

There are two things you might mean by self-hosting, and they are not variations
of one another.

| You want | Run | Reaches |
|---|---|---|
| Your own key, your own machine, nothing leaves it | `packages/daemon` — **no server needed** | Studio on that same machine |
| A relay so Studio can reach a producer that is not on your machine | `docker compose up` — this page | Studio anywhere |

**Read the first row before the second.** The daemon is the default path and the
private one: it binds `127.0.0.1`, holds your provider key on your own machine,
and there is no relay in the path at all. Most people do not need a server. The
[Quickstart in `README.md`](../README.md) is that path and takes about a minute.

The rest of this page is the second row.

## What the relay is, and what it can see

> **Relay — the relay operator can read your changes.**
>
> That is `PRIVACY_POSTURE['relay-tls']` from `packages/protocol`, served
> verbatim from `GET /v1/health`. Payloads on this transport are authenticated,
> not encrypted (ADR-014). The mode where the operator holds ciphertext is
> `relay-e2e`, it is M19, and it does not exist. If you self-host, *you* are the
> operator, which is one good reason to.

The relay is a pipe. It moves ChangeSets from a producer to a paired Studio
session and moves results back. It holds no provider API keys, calls no model,
and computes no validation — its whole runtime dependency list is
`@forgebridge/protocol` and `zod`, which is a property you can read off
`apps/relay/package.json` rather than a promise you have to take.

## The stack

```sh
git clone https://github.com/MosheBarami/forgebridge.git
cd forgebridge
cp .env.example .env        # then set RELAY_DOMAIN
docker compose up -d
```

Three services, and no database. What each is for:

| Service | Image | Published | Why |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | `80`, `443` | Terminates TLS and sets `X-Forwarded-Proto` and `X-Forwarded-For`. |
| `relay` | built from `apps/relay/Dockerfile` | nothing | The pipe. Reachable only through Caddy. |
| `otel-collector` | `otel/opentelemetry-collector-contrib` | nothing | An OTLP receiver, waiting — read [Telemetry](#telemetry-what-is-and-is-not-wired) before you rely on it. |

Only Caddy publishes a port, and that is load-bearing rather than tidy. With the
relay unpublished there is no path to it that skips the proxy, which is what
makes `RELAY_PROXY_HOPS: 1` a fact rather than a hope: the rightmost
`X-Forwarded-For` entry really was written by Caddy, so every per-address rate
limit is keyed on an address a caller cannot choose.

### Trying it with no domain

`RELAY_DOMAIN=localhost` is a real run, not a special case. Caddy issues a
certificate from its own local CA, the relay sees `X-Forwarded-Proto: https`,
and the whole path is exercised:

```sh
RELAY_DOMAIN=localhost docker compose up -d
curl -sk https://localhost/v1/health | jq
```

`curl -k` because the certificate is from Caddy's own CA and your machine has no
reason to trust it. That is the only thing about this mode that differs.

### With a real hostname

Set `RELAY_DOMAIN` in `.env` to a name whose DNS A/AAAA record already points at
this host, and make sure ports 80 and 443 reach it. Caddy provisions and renews
the certificate; there is nothing else to do.

One hostname, and only one. ADR-004: Roblox grants plugin HTTP permission *per
web address*, so a per-tenant or per-region subdomain would ask every one of your
users to approve another one.

## Configuration

Everything is in `.env`, and [`.env.example`](../.env.example) lists the whole
surface with the defaults spelled out. Two entries decide whether the relay is
safe rather than merely running:

**`RELAY_PROXY_HOPS`** — how many proxies to believe. The compose file sets `1`,
for the one Caddy in front. `X-Forwarded-For` is a header any client can set, so
it is ignored outright unless this says how many proxies to trust, and then it is
read from the *right*, because everything left of the trusted tail was written by
someone we do not trust. Behind an unconfigured proxy the relay rate limits the
whole world as one caller: loud, uniform and safe, where the opposite failure is
silent and unlimited.

**`RELAY_MAX_CHANGESET_BYTES` / `RELAY_MAX_OPERATIONS`** — per-link ceilings, both
below the protocol's own hard bounds. The relay refuses to *start* with either at
or above them, because a ceiling at the hard bound enforces nothing and the typo
that adds a zero turns the defence off without changing anything visible.

## Checking it works

```sh
curl -sk https://$RELAY_DOMAIN/v1/health | jq
```

You should see `"transport": "relay-tls"`, `"tls": { "required": true,
"proxyHops": 1 }`, and today's sponsored budget. That endpoint is
unauthenticated and answers before any link exists, which is why the relay's
container healthcheck uses it too.

Then point the Studio plugin at `https://$RELAY_DOMAIN` and mint a session:

```sh
curl -sk -X POST https://$RELAY_DOMAIN/control/sessions | jq
```

That returns a producer token and a pairing code. `POST /control/sessions` lives
outside `/v1` deliberately: the daemon prints both to the terminal of the person
who started it, a relay has no such terminal, and adding a route to a frozen
protocol that the daemon does not serve is the one thing ADR-004 forbids.

Set `RELAY_CONTROL_TOKEN` in `.env` to close that route to callers holding your
token. Left empty, anyone can mint a session; it is rate limited either way and
costs the relay a UUID and a pairing code.

## What is deliberately not here

**No database.** The relay holds session keys in memory and nowhere else, so a
restart forces every link to re-pair. That is about ten seconds per user, and the
refusal says so. Persisting them would put the material to forge a delivery to
any of your users in one file, which is a worse trade than ten seconds.

The rest of the relay's state — deliveries, results, console output — is in
memory too, capped per session and per link and evicted oldest-first, because
"unbounded per tenant" multiplied by "unbounded tenants" is the whole
resource-exhaustion story. The consequence to plan for: **two relay processes
behind a load balancer each enforce the limits they can see.** Run one, or accept
that the rate limits are per-process. `packages/storage-sqlite` implements the
*daemon's* store and the core's `StoragePort`; neither is a relay store, and
wiring one is not a configuration change.

**No Postgres and no Redis.** Adding either to make the stack look complete would
mean persisting the thing above or persisting nothing. ADR-010 names Upstash
Redis for the abuse counters and there is no such dependency in this repository;
`AbuseStore` in `apps/relay/src/abuse/` is the seam, and its `TODO(M45)` says
what an implementation has to do.

**No run service.** A self-hosted relay with nothing wired answers
`POST /v1/runs` with `provider_unconfigured` and points at BYOK and the local
daemon. That is the honest answer: choosing a model is a decision made where the
credential is, and the credential is not here.

**No sponsored runs.** `GET /v1/health` reports `sponsored.available: false` on a
relay started from the shipped binary, because the verification port that decides
who is eligible is not wired. The gate is built and refuses correctly; what it
would grant to is M23.

## Telemetry: what is and is not wired

The collector is in the stack, it starts, and it is reachable from the other
services at `http://otel-collector:4318`. **Nothing exports to it yet**, and that
is worth saying here rather than leaving you to infer it from an empty trace
list.

`@forgebridge/core` ships `telemetryFromEnvironment` and two adapters — that is
M44 and it is done — and no process in this repository calls them. The relay
does not depend on `@forgebridge/core` at all, by design. So the collector is
provisioned so that the first process wired to it needs a deployment change and
not a new service, and `docker compose logs otel-collector` currently shows a
collector with nothing to collect.

To send your own spans there from something else on the same network, point it at
`http://otel-collector:4318` and replace the `debug` exporter in
`deploy/otel-collector.yaml` with yours. Nothing else in that file has to change.

## The lite image: the daemon, alone

```sh
docker build -f deploy/daemon.Dockerfile -t forgebridge-daemon .
```

**Read this before you run it.** The image is useful on Linux with
`--network host`, and is not useful on Docker Desktop for macOS or Windows.

The daemon binds loopback and only loopback — `LOOPBACK_HOST` in
`packages/daemon/src/server.ts`, with no flag to widen it — and it also refuses
any request whose `Host` header is not loopback. Both are deliberate: a process
holding a provider key and a writable-path allowlist should not become reachable
from the network by accident.

Inside a container, "loopback" is the *container's* loopback. `-p 8080:8080`
forwards to the container's `0.0.0.0:8080`, where nothing is listening, so the
daemon is unreachable while the port mapping looks correct. `--network host` on
Linux shares the host's network namespace, so the daemon binds the host's own
`127.0.0.1` and Studio on that machine reaches it exactly as it would a daemon
started from npm. On macOS and Windows, Docker Desktop runs containers in a VM,
and that VM's loopback is not the one Studio is on.

```sh
# Linux
docker run --rm --network host -e OPENROUTER_API_KEY forgebridge-daemon \
  --allow-path ServerScriptService.Shop
```

On macOS or Windows, run it directly instead — `npm run build`, then the
`forgebridge-daemon` binary. It is the same process without the container.

The image mounts no volume, because there is nothing to persist: the daemon
constructs an in-memory store, and switching it to `packages/storage-sqlite` is a
change to `packages/daemon` rather than to this deployment. A volume here would
produce an empty directory and the impression of durability.

## Upgrading

```sh
git pull
docker compose up -d --build
```

Session keys do not survive a restart, so every paired Studio session re-pairs
after an upgrade. Tell your users, or upgrade when nobody is mid-run.

## When something is wrong

| Symptom | What it means |
|---|---|
| Every request is refused with a TLS error | The relay could not tell whether its hop was TLS. Check `RELAY_PROXY_HOPS` is `1` and that Caddy is actually in front. Refusing is the designed behaviour: a relay that cannot tell and serves anyway is a relay whose transport name is a guess. |
| Everything is rate limited as one caller | `RELAY_PROXY_HOPS` is `0`, so `X-Forwarded-For` is being ignored. |
| `docker compose up` fails on `RELAY_DOMAIN` | It is required and has no default. Set it in `.env`; `localhost` is a valid answer. |
| Caddy cannot get a certificate | DNS for `RELAY_DOMAIN` does not point here, or ports 80/443 do not reach this host. |
| Studio will not connect | Roblox grants plugin HTTP permission per address. The plugin must be pointed at `https://$RELAY_DOMAIN` and the permission approved for that exact name. |
| The plugin disconnects every 25 seconds | A proxy in front of Caddy is cutting the long-poll. `deploy/Caddyfile` sets `read_timeout 15m` for this reason; anything further out needs the same. |

The gate in `scripts/__tests__/deployment.test.ts` holds several of the claims on
this page against the files they describe — that only the proxy publishes a port,
that the two Caddy configurations agree, that every image is pinned, and that
every variable the relay reads is either set in the compose file or listed as
deliberately unset.
