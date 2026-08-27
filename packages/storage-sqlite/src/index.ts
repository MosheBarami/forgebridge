/**
 * `@forgebridge/storage-sqlite` — one SQLite file each for the daemon's
 * transport state and for the product's store (M40, ADR-005).
 *
 * Two adapters, because there are two ports:
 *
 *   - `createSqliteDaemonStore` implements `DaemonStore` from
 *     `@forgebridge/daemon`, and is held to `DAEMON_STORE_SUITE` — the same
 *     array `InMemoryDaemonStore` passes, run in `test/parity.test.ts`.
 *   - `createSqliteStoragePort` implements `StoragePort` from
 *     `@forgebridge/core`, which is the port a Supabase adapter will implement
 *     too. That is what makes "signed-out and self-host-lite" a mode rather
 *     than an aspiration.
 *
 * Neither is installed by anything yet: the daemon still constructs
 * `InMemoryDaemonStore` in `packages/daemon/src/bin.ts`, and switching it over
 * is a change to that package rather than to this one.
 */
export {
  DAEMON_DATABASE,
  STORAGE_DATABASE,
  SqliteUnavailableError,
  forgeBridgeHome,
  isUniqueViolation,
  migrate,
  openDatabase,
  type Database,
  type OpenDatabaseOptions,
} from './database.js';
export { DAEMON_MIGRATIONS, STORAGE_MIGRATIONS, type Migration } from './migrations.js';
export {
  SqliteDaemonStore,
  createSqliteDaemonStore,
  type SqliteDaemonStoreOptions,
} from './store.js';
export {
  createSqliteStoragePort,
  storagePortOver,
  type SqliteStoragePort,
  type SqliteStoragePortOptions,
} from './storage.js';
