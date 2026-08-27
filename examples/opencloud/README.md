# Open Cloud example

Three scripts against `@forgebridge/opencloud`: publish a place version, round-trip
a data store entry, and publish a MessagingService message.

Unlike the other examples here, these talk to **Roblox**, not to a ForgeBridge
daemon. Open Cloud writes into a published universe; the rest of this repository
writes into a Studio session. Different boundary, different credential, and this
directory is the only one that needs the second.

## Before you start

`@forgebridge/opencloud` is not published (`M49`), so these run from a checkout:

```bash
npm ci
npm run build
```

Create an API key at <https://create.roblox.com/dashboard/credentials> with the
scopes each script names, and export it. The key is read from the environment and
never taken as a flag — a flag is in your shell history and visible in `ps` to
every process on the machine:

```bash
export ROBLOX_OPEN_CLOUD_API_KEY=…
export FORGEBRIDGE_UNIVERSE_ID=1234        # Creator Dashboard → your experience
export FORGEBRIDGE_PLACE_ID=5678           # the place inside it
```

## The three scripts

```bash
# Scope: universe-datastores.objects:read, :create, :update
node examples/opencloud/datastore.mjs

# Scope: universe-messaging-service:publish
node examples/opencloud/message.mjs

# Scope: universe-places:write — this one changes what players load.
node examples/opencloud/publish-place.mjs build/game.rbxl Saved
```

`publish-place.mjs` takes the version type as an argument and has no default,
which is the same refusal the library makes. `Saved` writes a version nobody is
playing; `Published` makes it live for everyone in the universe. Those are not
variations of one action, and neither this script nor the library will choose
between them for you.

## What these are showing, beyond the API

Each script prints the failure it would have hidden. `datastore.mjs` reports
whether the value it read carried a `content-md5` that matched, because *"there
was no checksum"* and *"the checksum was wrong"* are different facts and the
library never merges them. `publish-place.mjs` says in as many words that a
response it cannot read means the place *may or may not* have been published —
the honest sentence for an operation whose answer was lost.
