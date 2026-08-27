# `@forgebridge/relay` — the cloud transport

The relay is the second of the two transports ADR-004 chose, and the one you
should reach for **only when you cannot run the first**.

> **Relay — the relay operator can read your changes.**
>
> That sentence is not a caveat buried in a doc. It is `PRIVACY_POSTURE['relay-tls']`
> from `packages/protocol`, and this app serves it verbatim from `GET /v1/health`
> and `GET /v1/link` so every surface above it renders the same words. Payloads
> on this transport are authenticated, not encrypted (ADR-014 v1). The mode where
> the operator holds ciphertext is `relay-e2e`, it is M19, and it does not exist.
>
> If that matters to you, run `packages/daemon`. It binds `127.0.0.1`, holds your
> provider key on your own machine, and there is no relay in the path at all.

## What this process is

A pipe.

It moves ChangeSets from a producer to a paired Studio session and moves
`ApplyResult`s, journal inverses and console output back. It holds no provider
API keys, calls no model, and computes no validation. Everything it refuses, it
refuses on a fact it can check for itself: a MAC, a nonce, a content digest, a
size, a counter.

Its whole runtime dependency list is `@forgebridge/protocol` and `zod`. That is
a property you can read off `package.json` rather than a promise you have to
take — and it is why several small modules here are copies of the daemon's
rather than imports of it. See **Copies, and the gate that holds them** below.

## Running one

```sh
# From the repository root, once: the relay needs its workspace sibling built.
npm run build

# TLS, a hostname, and the relay behind it.
cd apps/relay/deploy
RELAY_DOMAIN=relay.example.org docker compose up --build
```

Two containers: Caddy terminates TLS and sets `X-Forwarded-Proto` and
`X-Forwarded-For`; the relay serves plain HTTP behind it and is not published to
the host. There is no database, no Redis and no vendor account in that file,
because ADR-004 rests on the relay being small enough that self-hosting it is
realistic.

Without Docker:

```sh
# Local development only. See "Two questions a public deployment must answer".
RELAY_INSECURE_HTTP=1 RELAY_PORT=8080 forgebridge-relay
```

### Configuration

Every one of these is read once at startup, and an unparseable value is a
startup error rather than a silent fallback to a default nobody chose.

| Variable | Default | What it decides |
|---|---|---|
| `RELAY_PORT` | `8080` | Port to bind. |
| `RELAY_HOST` | `0.0.0.0` | Interface to bind. Unlike the daemon, which binds loopback with no option to widen it. |
| `RELAY_PROXY_HOPS` | `0` | How many proxies to believe. `0` ignores `X-Forwarded-*` entirely. |
| `RELAY_INSECURE_HTTP` | unset | Waives the TLS check. Local development only; `/v1/health` reports the waiver. |
| `RELAY_ALLOWED_ORIGINS` | empty | Comma-separated browser origins. Never `*` — these routes carry a bearer token. |
| `RELAY_CONTROL_TOKEN` | unset | Closes session minting to callers holding it. Unset means open, and rate limited. |
| `RELAY_SPONSORED_DAILY_BUDGET` | `200` | The published sponsored-run budget for a UTC day. |
| `RELAY_MAX_CHANGESET_BYTES` | `1048576` | Per-link ceiling. Must be below the protocol's 8 MiB. |
| `RELAY_MAX_OPERATIONS` | `200` | Per-link ceiling. Must be below the protocol's 500. |

## The surface, and why it is exactly the daemon's

ADR-004: *"Identical `/v1/*` surface on `packages/daemon` and `apps/relay`. The
plugin is configured with a base URL and does not know which it is talking to."*
The plugin is the hardest artefact in this system to update in the field, so it
has exactly one implementation, which means one protocol.

The instruction was to reuse the daemon's routing rather than write a second
one. It could not be imported: `ForgeBridgeDaemon#route` is a private method on
a class whose constructor builds a model router, a circuit breaker, a Luau
analyser and a keyring, and `@forgebridge/daemon` exports the class rather than
the routing, with no deep import path. Reusing it would have meant instantiating
a daemon inside the relay — a process that reads provider credentials and
computes validation, which is two of the things this app is defined by not
doing.

So the routing is extracted into `src/routes.ts` as a table, and the *identity*
of the two surfaces is enforced by a gate rather than by care. `test/surface.test.ts`
compares that table with `packages/protocol/schema/openapi.json` — the committed
projection of the daemon's own route table, which `npm run verify:schemas`
regenerates and fails on any difference — and with the literals the daemon's
router branches on, read from its source. Both directions: a route the daemon
serves and the relay does not fails, and so does a route the relay serves and
the daemon does not.

Five differences in *behaviour*, none in *shape*:

| Route | On the relay |
|---|---|
| `GET /v1/link` | Requires a producer token. On a shared host an open link list enumerates every paired Studio session on the box. |
| `POST /v1/changesets` | Requires the ChangeSet to carry a validation verdict, because the relay computes none. See below. |
| `GET /v1/models` | `configured: false`. Choosing a model is a decision made where the credential is, which is not here. |
| `POST /v1/runs` | Applies the M45 gates, then forwards to an injected run service. With none wired: `provider_unconfigured`, naming BYOK and the daemon. |
| `GET /v1/runs/:id/events` | Streams whatever the run service streams, or answers one `closed` frame saying it does not. |

One route lives **outside** `/v1`, and deliberately: `POST /control/sessions`.
The daemon prints its producer token and pairing code to the terminal of the
person who started it; a relay has no terminal and no such person, so it has to
hand both over an HTTP response. Putting that under `/v1` would add a path to a
frozen protocol that the daemon does not serve, which is the one thing ADR-004
forbids.

## The relay computes no validation, and refuses what has none

This is the sharpest honesty requirement in the app.

`PROTOCOL.md` invariant 4 says validation is produced by the core and never by
the model, and the daemon enforces it by overwriting whatever verdict arrived
with one it computed inside its own trust boundary. The relay cannot do that:
`@forgebridge/core` and the Luau analyser are exactly the brain this transport
does not carry.

That leaves two options and only one of them is defensible. Accepting a set with
no verdict and letting it be approved would make the relay a way to route around
validation entirely — pick the transport, skip the analyser. That is a bypass,
not a limitation. So the relay refuses: a ChangeSet arrives here already
validated by whoever ran the core, or it does not arrive.

What the relay adds is provenance, not endorsement. `Validation.computedBy` is
carried through untouched, and `validationWitnessedHere: false` rides on the
diff so a reviewer is told the verdict on their page is one the relay is
relaying. Note what that is **not**: it is not a claim that the verdict is
genuine. The relay cannot check that, and says so.

## M45 — abuse protection

There is no metering and never will be (ADR-010). The relay is the only part of
this system that costs the project money, so the defence is four things, each
with a test that proves it fires — `test/abuse.test.ts` and
`test/sponsored.test.ts` — and, beside it, a control proving ordinary use is not
caught. A limit that fires on normal work trains people to ignore it, which is
the same outcome as no limit reached more expensively.

**Sliding windows, per link and per source address, on every route.** Sliding
rather than fixed buckets: a fixed hourly bucket lets a caller spend a full
allowance at 10:59 and another at 11:00, and the two minutes either side of a
boundary are exactly when an abuser arrives, because that is what the limit
taught them to do. Both scopes are enforced — per link bounds one paired
session, which is the unit a legitimate user has one of; per address bounds a
caller with a thousand sessions, which is the unit an abuser has one of.
Refusals carry `Retry-After`.

**Per-link ceilings on ChangeSet size and operation count.** Lower than the
protocol's hard bounds, and checked at startup to *be* lower — a ceiling at the
hard bound enforces nothing, and the typo that adds a zero turns the defence off
without changing anything visible.

**A daily budget circuit breaker with a published number.** It is on
`GET /v1/health` before anyone hits it and quoted in the refusal when they do.
When it opens, the relay says so plainly and points at BYOK and the local
daemon. It never queues, never delays, and never substitutes a smaller model —
each of those is a way of spending money the breaker was opened to stop spending
while telling the user nothing happened.

**The sponsored run: one per day per verified user, per address and per network.**
All three counters are required, and they are not redundant — the user counter
is the honest unit, the address counter catches one person with several
accounts, and the ASN counter catches a caller cycling addresses inside one
hosting provider, which is what someone does after they notice the address
counter.

Every gate above has the same shape: it answers one question, and if it cannot
answer it, it **refuses**. Roblox account verification is M23 and belongs to that
milestone, so it arrives here as an injected port — and with no port wired, no
one is eligible for a sponsored run and the relay says exactly that. An ASN the
relay cannot resolve is a refusal too, because granting it anyway would make
"all three required" mean "all three, unless the third is inconvenient".

Counters live behind `AbuseStore`. The implementation that ships is in-process,
which is correct for one process and honestly limited for more: two relay
processes behind a load balancer each enforce the limits they can see. ADR-010
names Upstash Redis; there is no such dependency here, and the `TODO(M45)` on
that interface says exactly what a Redis implementation has to do.

## Two questions a public deployment must answer

A daemon binds loopback and gets both answers for free. A relay is meant to be
reachable from the internet, so each is explicit and each fails closed.

**Whose address is this really?** Every per-address limit is worth exactly what
the address is worth. `X-Forwarded-For` is a header any client can set, so it is
ignored outright unless `RELAY_PROXY_HOPS` says how many proxies to believe —
and then it is read from the *right*, because everything left of the trusted
tail was written by someone we do not trust. Behind an unconfigured proxy the
relay rate limits the whole world as one caller: loud, uniform and safe, where
the opposite failure is silent and unlimited.

**Was this hop actually TLS?** `relay-tls` is the transport's name and the
string the UI renders, so it is a claim, and a claim gets checked. Three states —
confirmed, explicitly waived for development, or *unknown* — and unknown is
refused. A relay that cannot tell whether it is behind TLS and serves anyway is
a relay whose transport name is a guess.

## Copies, and the gate that holds them

`src/envelope.ts`, the key-derivation half of `src/pairing.ts`, the wire schemas
in `src/wire.ts` and the rollback planner in `src/rollback.ts` are copies of the
daemon's. The daemon's own comment says why they have to agree: *"the same
scheme the relay uses, so the plugin has one code path"*. The plugin computes one
MAC in Luau and sends it to whichever transport its base URL points at, and a
relay whose MAC differs by a separator authenticates nothing and refuses
everyone.

`test/drift.test.ts` runs both implementations over the same fixtures —
canonical JSON, both MAC domains, key derivation, seal and open in both
directions, the content digest, every legal and illegal inverse pairing, and the
wire schemas against the same accept/refuse cases. It imports the daemon's
**source** rather than its built package, because a build artefact lags its
source and the window in which it lags is exactly the window a divergence gets
introduced. That caught a real one while this app was being written.

The fix that deletes the copies is `TODO(M31)`: promote the scheme into
`@forgebridge/protocol`, where both transports would import it. The daemon's
`wire.ts` already carries the matching TODO from the other side.

`src/diff.ts` is the one copy with no automatic gate, and that is said in the
file rather than glossed: the daemon's `describeOperation` and `afterValueOf` are
module-private and not comparable from a test. What makes it acceptable is that
the parts a safety decision rests on are not local — the script count is the
protocol's `carriesLuauSource`, the path list is `pathsOf`, and Luau source is
rendered verbatim whichever of the three operations installed it.

## What is not here

- **Session keys do not survive a restart.** They are held in memory and nowhere
  else, so a restart forces every link to re-pair. That is ten seconds per user,
  and the refusal says so. Persisting them would put the material to forge a
  delivery to any user in one file.
- **State is in memory.** `RelayStore` is a port with one in-process
  implementation. Everything it holds is capped per session and per link, evicted
  oldest-first, because "unbounded per tenant" multiplied by "unbounded tenants"
  is the whole resource-exhaustion story.
- **No run service, no verification, no ASN lookup.** Three ports, none wired by
  default. Their absence is a refusal rather than a default — see M45 above.
- **`relay-e2e` is M19.** Nothing in this app may describe itself as
  end-to-end encrypted, and nothing does; `DeliveryEnvelope.encrypted` is `false`
  on every delivery this transport seals (ADR-014).

## Tests

```sh
npm test --workspace @forgebridge/relay
```

`test/surface.test.ts` (the ADR-004 surface gate, with planted violations proving
it can fail) · `test/drift.test.ts` (the copies against the daemon's source) ·
`test/server.test.ts` (propose → review → approve → deliver → apply) ·
`test/isolation.test.ts` (one tenant cannot read another) · `test/abuse.test.ts`
and `test/sponsored.test.ts` (M45, each limit with a control) ·
`test/proxy.test.ts` (the TLS and client-address questions) ·
`test/validation.test.ts` (the relay relays a verdict, it does not make one) ·
`test/rollback.test.ts` (M11 over this transport) · `test/posture.test.ts`
(ADR-014's rule, enforced over this app's own source) · `test/bin.test.ts`
(startup configuration, and why it fails closed).
