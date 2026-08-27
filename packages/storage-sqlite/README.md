# `@forgebridge/storage-sqlite`

The no-account storage adapters (M40, [ADR-005](../../docs/architecture/adr-005-ports-and-adapters-optional-auth.md)).
Two ports, two SQLite files, one dependency-free driver.

| Export | Implements | Default file |
|---|---|---|
| `createSqliteDaemonStore` | `DaemonStore` from `@forgebridge/daemon` | `~/.forgebridge/daemon.sqlite` |
| `createSqliteStoragePort` | `StoragePort` from `@forgebridge/core` | `~/.forgebridge/forgebridge.sqlite` |

```ts
import { createSqliteDaemonStore } from '@forgebridge/storage-sqlite';
import { createDaemon } from '@forgebridge/daemon';

const store = await createSqliteDaemonStore();
const daemon = createDaemon({ store });
```

## Why `node:sqlite` and not `better-sqlite3`

Both are synchronous, which is the property these adapters need — `DaemonStore`
promises that `tryAdvanceInboundNonce` is one atomic step, and a driver whose
every call returns a promise turns that guarantee into two awaits and a hope. So
the choice was never about speed. It is about what a self-hoster has to install.

- **`better-sqlite3`** is a native addon. It ships prebuilt binaries for the
  common platform/ABI pairs and falls back to `node-gyp` — a C++ toolchain and a
  Python — for everything else. ADR-005 promises "a daemon with a SQLite file"
  as a *real* alternative to running Postgres; an alternative that needs a
  compiler on an unusual platform is a narrower promise than that. It is also a
  dependency, and this repository's supply-chain posture (ADR-013, `npm audit`
  at zero) is easier to keep with one fewer native package in the tree.
- **`node:sqlite`** is a built-in. Zero install, zero build step, nothing added
  to the lockfile, and the same SQLite underneath.

The cost is real and worth stating: `node:sqlite` is newer than the alternative,
and on Node builds where it is still gated it is reachable only with
`--experimental-sqlite`. Two things follow.

- **This package's `test` script sets `NODE_OPTIONS=--experimental-sqlite`.** The
  flag is a no-op on a build where the module is already enabled and is what
  enables it on a build where it is not, so one script covers both — and the
  parity suite is never skipped for want of a driver, which is precisely the
  outcome ADR-005's revisit trigger names as the abstraction having failed.
- **A host that opens a database gets a sentence, not a stack trace.**
  `openDatabase` imports the module dynamically and converts a failure into
  `SqliteUnavailableError`, which names the flag.

If the trade ever stops being worth it, the seam to swap is `src/database.ts`;
nothing else in the package touches the driver.

## The parity test is the point

ADR-005's third rationale is that "adapter parity is testable — one suite, two
backends, both green or the build fails", and its revisit trigger is the day
that stops being true. So the `DaemonStore` cases do not live in either
adapter's test file. They live in `packages/daemon/src/store-suite.ts` as
`DAEMON_STORE_SUITE`, and two hosts run the same array:

- `packages/daemon/test/store.test.ts` — against `InMemoryDaemonStore`
- `packages/storage-sqlite/test/parity.test.ts` — against `SqliteDaemonStore`

`packages/daemon/test/store-suite.test.ts` is the suite's own self-test: it
plants five defects a second adapter author would plausibly ship — a replay
guard that reads then writes, an `INSERT OR REPLACE` where write-once was
required, a missing policy reported as an empty allowlist, a queue that is never
trimmed, a field dropped in serialisation — and asserts the suite rejects each
one. A parity suite that cannot fail is decoration.

`test/storage-port.test.ts` covers `StoragePort`, and is *not* a parity suite:
`storage-supabase` does not exist yet, so there is nothing to run it against
twice. When that adapter lands, those cases are the ones to lift into a shared
suite the same way.

## What is stored, and what is not

Each table carries the columns it is *queried* by plus one `document` column
holding the protocol object as JSON. The protocol is frozen and owns those
shapes; ADR-005's rule is that adapters serialise, they do not validate and they
do not reshape. A schema that projected every protocol field into a column would
migrate on every additive protocol change, and one that silently dropped a field
it had no column for would be reshaping — which is how two adapters come to
disagree.

**No credential is stored, and there is no column that could hold one.** Session
keys live in the daemon's in-process keyring and never reach a store (ADR-006,
C4); the only credential-adjacent value here is `Link.sessionKeyId`, an
identifier for a key held in memory. `scripts/verify-no-key-storage.ts` checks
that statically over `src/`, and `test/migrations.test.ts` checks it against the
statements that actually run.

## Not wired in yet

Nothing in the tree constructs these adapters. `createDaemon` in
`packages/daemon/src/server.ts` still falls back to `InMemoryDaemonStore` when
no store is passed, and `packages/daemon/src/bin.ts` passes none — so a daemon
started from the CLI today is still in-memory. Changing that default belongs to
the daemon, and carries a decision this package does not get to make on its own:
what a daemon should do when it finds a database written by a newer build, which
`openDatabase` currently answers by refusing to open it.
