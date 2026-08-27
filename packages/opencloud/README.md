# `@forgebridge/opencloud` — Roblox Open Cloud

Three Open Cloud API families, from Node, with no runtime dependencies:

| What | Endpoint family | Scope an API key needs |
|---|---|---|
| Publish a place version | `POST /universes/v1/{universeId}/places/{placeId}/versions` | `universe-places:write` |
| Standard data stores | `/datastores/v1/universes/{universeId}/standard-datastores/…` | `universe-datastores.*` |
| MessagingService | `POST /messaging-service/v1/universes/{universeId}/topics/{topic}` | `universe-messaging-service:publish` |

Every endpoint shape in this package was read from the Roblox documentation, and
each module names the page it was read from in its own header — `src/places.ts`,
`src/datastores.ts`, `src/messaging.ts`. Nothing here was inferred from a blog
post or from what a similar API happened to do.

## Why this package exists

ForgeBridge writes into a Studio *session*. Open Cloud writes into a *published
universe*. Those are different trust boundaries with different credentials, and
this package is deliberately the only place the second one appears: no other
package imports it, and it imports none of them.

That separation is why it has no dependency on `@forgebridge/protocol` and no
knowledge of ChangeSets. A tool that publishes a build and pokes a data store is
useful with or without the rest of this repository.

## Using it

```sh
export ROBLOX_OPEN_CLOUD_API_KEY=…      # from create.roblox.com/dashboard/credentials

forgebridge-opencloud publish-place \
  --universe 1234 --place 5678 \
  --file build/game.rbxl --version-type Published

forgebridge-opencloud datastore get \
  --universe 1234 --datastore PlayerSaves --key user_42

forgebridge-opencloud message publish \
  --universe 1234 --topic shop-restock --message '{"sku":"lantern"}'
```

The key comes from the environment and from nowhere else. There is no
`--api-key` flag, and passing one is an error rather than a silent no-op: a flag
is in your shell history and is visible in `ps` to every process on the machine.

From TypeScript:

```ts
import { createOpenCloudClient, publishPlaceVersion } from '@forgebridge/opencloud';

const client = createOpenCloudClient({ apiKey: process.env.ROBLOX_OPEN_CLOUD_API_KEY! });
const { versionNumber } = await publishPlaceVersion(client, {
  universeId: 1234,
  placeId: 5678,
  file: await readFile('build/game.rbxl'),
  format: 'rbxl',
  versionType: 'Published',
});
```

`examples/opencloud/` is a runnable version of exactly that.

## The four rules this package is built on

Each one exists because of a failure this repository has already had to fix, and
each one ships with the legitimate shape it is most confusable with as a control
test — a rule that fires on ordinary work is a rule someone turns off.

**1. An answer this client cannot read is a failure, not a success.** A `200`
whose body is not the documented shape raises `OpenCloudError` with
`kind: 'unreadable'`. A publish whose response carries no `versionNumber` is
reported as *"the place may or may not have been published"* rather than as
done, because those are the honest words for it.

**2. A write is never retried on a lost answer.** Retries are declared per
request rather than derived from the status: only requests marked idempotent are
repeated, and only when the service actually *refused* them. A transport failure
on `incrementEntry` — where the counter may have moved and the answer was lost —
is surfaced, never repeated. `test/client.test.ts` plants each of those cases.

**3. A read that cannot be verified is not a read.** `GET …/entry` returns a
`content-md5`. When it is present and does not match the bytes that arrived,
this client raises instead of returning the value; when it is absent, the value
comes back with `metadata.verified: false`. *"There was no checksum"* and *"the
checksum was wrong"* are different facts and this package never merges them —
`test/datastores.test.ts` has a control for each.

**4. The credential is never anywhere but the request header.** It is captured
in a closure by `createOpenCloudClient` and is not a property of the returned
object, so `JSON.stringify`, `console.dir` and an error reporter all get a
client with a `baseUrl` and nothing else. It appears in no error message this
package raises. `test/custody.test.ts` drives every failure path with a
recognisable key in play and asserts it comes out of none of them, and
`npm run verify:no-key-storage` covers the shapes from the other side.

## What is not here

- **OAuth 2.0.** Open Cloud accepts `Authorization: Bearer …` in place of
  `x-api-key`, which is what a tool acting for *another* creator must use. The
  `TODO(M48)` at the foot of `src/client.ts` names the exact unknowns: the
  authorisation-code + PKCE parameters, the token endpoint, and the mapping from
  these scope strings onto OAuth scope strings could not be verified from the
  reachable documentation, and a guessed auth flow fails in the field with a
  credential already in play.
- **Ordered data stores, and the `/cloud/v2` surface.** This package speaks the
  `v1` standard data store endpoints only. The v2 API is a different resource
  model with different scope strings, and half of it would be worse than none.
- **The `forgebridge opencloud …` subcommand.** `packages/cli` belongs to M28.
  Wiring it through to these functions is a small change for whoever owns it;
  this package ships its own binary so it does not have to wait.
- **Retries with a shared budget.** Each call retries on its own. Two hundred
  concurrent calls will each politely back off and collectively will not.

## Tests

```sh
npm test --workspace @forgebridge/opencloud
```

`test/client.test.ts` (the credential in the header, the plain-HTTP refusal, the
retry rules) · `test/places.test.ts` and `test/messaging.test.ts` (the wire shape
against the documented one, and the ceilings) · `test/datastores.test.ts` (all
eight endpoints, the `content-md5` rule and its controls) ·
`test/custody.test.ts` (every failure path, with a key in play) ·
`test/bin.test.ts` (publish-from-CLI end to end, and the exit-code contract).
