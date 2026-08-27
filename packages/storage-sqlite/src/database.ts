/**
 * The connection, the pragmas, and the migration runner (M40, ADR-005).
 *
 * ── Why `node:sqlite` and not `better-sqlite3` ───────────────────────────────
 *
 * Both are synchronous, which is the property this adapter needs: `DaemonStore`
 * promises that `tryAdvanceInboundNonce` is one atomic step, and a driver whose
 * every call is a promise turns that guarantee into "two awaits and hope". So
 * the choice is not about speed. It is about what a self-hoster has to install.
 *
 *   - `better-sqlite3` is a native addon. It ships prebuilt binaries for the
 *     common platform/ABI pairs and falls back to `node-gyp` — a C++ toolchain
 *     and a Python — for everything else. ADR-005's promise is "a daemon with a
 *     SQLite file" as a *real* alternative to running Postgres; an alternative
 *     that needs a compiler on an unusual platform is a narrower promise than
 *     that. It is also a dependency, and this repository's supply-chain posture
 *     (ADR-013, `npm audit` at zero) is easier to keep with one fewer native
 *     package in the tree.
 *   - `node:sqlite` is a built-in. Zero install, zero build step, nothing new
 *     in the lockfile, and it is the same SQLite underneath.
 *
 * The cost, stated plainly because it is real: `node:sqlite` is newer, and on
 * Node builds where it is still gated it is only reachable with
 * `--experimental-sqlite`. `openDatabase` imports it dynamically so that such a
 * build produces a sentence naming the flag rather than a module-resolution
 * stack trace. If that trade ever stops being worth it, the seam to swap is
 * this file: everything else in this package talks to `Database` below.
 *
 * ── Why the schema stores documents ──────────────────────────────────────────
 *
 * Each table carries the columns it is *queried* by, plus one `document` column
 * holding the protocol object as JSON. The protocol is frozen and owns those
 * shapes; ADR-005's storage rule is that "adapters serialise; they do not
 * validate, and they do not reshape". A schema that projected every protocol
 * field into a column would have to migrate on every additive protocol change,
 * and an adapter that silently dropped a field it did not have a column for
 * would be reshaping — which is the failure that makes two adapters disagree.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Migration } from './migrations.js';

/** The directory both files live in. */
export function forgeBridgeHome(): string {
  return path.join(homedir(), '.forgebridge');
}

/**
 * Two files, not one, and the reason is a difference in lifetime.
 *
 * `DaemonStore` is the local transport's working state: delivery queues, nonce
 * watermarks, the link table, a bounded cache of recent runs. Almost none of it
 * is worth anything after the Studio session it belongs to ends, and all of it
 * is capped by `RETENTION`. `StoragePort` is the product's store: projects,
 * tree history, journal entries, settings — the things a user would be upset to
 * lose.
 *
 * They also store overlapping *entities* under different rules. A daemon
 * ChangeSet is write-once by id; the core's `ChangeSetStore.save` is not. One
 * table serving both would make each port's guarantee depend on the other
 * port's callers, which is exactly the coupling ADR-005 draws a port to avoid.
 */
export const DAEMON_DATABASE = 'daemon.sqlite';
export const STORAGE_DATABASE = 'forgebridge.sqlite';

export interface OpenDatabaseOptions {
  /**
   * A filesystem path, or `:memory:`. The parent directory is created if it
   * does not exist.
   */
  location: string;
  /** The schema to bring this file up to. See `migrations.ts`. */
  migrations: readonly Migration[];
  /**
   * Stop after this migration version. Exists so a test can assert what an
   * older schema looked like and that the next migration moves it; a daemon
   * never passes it.
   */
  migrateTo?: number;
}

/**
 * The narrow surface the rest of this package uses.
 *
 * Deliberately not `DatabaseSync` itself: keeping the driver behind five
 * methods is what makes the paragraph above ("the seam to swap is this file")
 * true rather than aspirational.
 */
export interface Database {
  /** A cached prepared statement. Statements are reused; SQLite compiles each one once. */
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  /**
   * Run `body` inside `BEGIN IMMEDIATE` / `COMMIT`, rolling back if it throws.
   *
   * `IMMEDIATE` rather than the default deferred begin: a deferred transaction
   * takes its write lock at the first write, so two processes that both read
   * and then write can deadlock into `SQLITE_BUSY` after doing work. Taking the
   * lock up front turns that into a wait, which `busy_timeout` handles.
   *
   * Synchronous by design. `body` cannot await, and that is the point — an
   * `await` inside a transaction would let another handler's statements
   * interleave with it on the same connection.
   */
  transaction<T>(body: () => T): T;
  close(): void;
  /** The migration versions applied to this file, ascending. */
  appliedMigrations(): number[];
}

/** Raised instead of a driver-shaped error when the runtime has no `node:sqlite`. */
export class SqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'storage-sqlite: this Node build does not expose node:sqlite. ' +
        'Run Node with --experimental-sqlite, or upgrade to a build where node:sqlite is enabled by default.',
      { cause },
    );
    this.name = 'SqliteUnavailableError';
  }
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  const location = options.location;

  let DatabaseSyncClass: new (path: string) => DatabaseSync;
  try {
    // Dynamic so that a runtime without the module produces the sentence above
    // rather than a resolution failure at import time, which would take down
    // every consumer of this package including the ones that never open a file.
    ({ DatabaseSync: DatabaseSyncClass } = await import('node:sqlite'));
  } catch (error) {
    throw new SqliteUnavailableError(error);
  }

  if (location !== ':memory:') {
    // 0o700: the file holds prompts, generated Luau and the diff history of a
    // user's place. None of it is a credential (ADR-006 keeps those in the
    // keychain, and `verify-no-key-storage` K4 checks that the daemon's shapes
    // cannot hold one) — but it is the user's work, and a world-readable
    // directory under $HOME is a default nobody chose.
    mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  }

  const handle = new DatabaseSyncClass(location);
  const statements = new Map<string, StatementSync>();

  const database: Database = {
    prepare(sql) {
      const existing = statements.get(sql);
      if (existing) return existing;
      const prepared = handle.prepare(sql);
      statements.set(sql, prepared);
      return prepared;
    },
    exec(sql) {
      handle.exec(sql);
    },
    transaction(body) {
      handle.exec('BEGIN IMMEDIATE');
      try {
        const result = body();
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          // A rollback that fails because the transaction is already gone must
          // not replace the error that got us here — that error is the one
          // worth reading.
        }
        throw error;
      }
    },
    close() {
      statements.clear();
      handle.close();
    },
    appliedMigrations() {
      return handle
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => Number(row['version']));
    },
  };

  configure(database, location);
  try {
    migrate(database, options.migrations, options.migrateTo ?? Number.MAX_SAFE_INTEGER);
  } catch (error) {
    // An unopenable file must not leave a connection behind. A daemon that
    // retries would otherwise leak one handle per attempt.
    database.close();
    throw error;
  }
  return database;
}

function configure(database: Database, location: string): void {
  // Two processes genuinely share this file: the daemon, and a CLI inspecting
  // it. WAL lets the reader work while the writer holds the lock, which is the
  // difference between "the CLI shows you the run" and "the CLI says the
  // database is locked".
  if (location !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  // NORMAL rather than FULL: on a WAL database this risks losing the last
  // transactions to an OS crash, not to a process crash, and the contents are
  // a local cache of work the user can regenerate. FULL costs an fsync per
  // commit, which a delivery queue notices.
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
  // Wait rather than fail. Without this a concurrent writer surfaces as
  // SQLITE_BUSY to a handler that has no useful way to retry.
  database.exec('PRAGMA busy_timeout = 5000');
}

/**
 * Apply every migration this build knows about that the file has not seen.
 *
 * Each migration runs inside its own transaction together with the row that
 * records it, so a crash halfway leaves the file at the previous version rather
 * than at a version whose statements only half ran.
 *
 * A file carrying a version this build does not know about is refused rather
 * than used: it was written by a newer daemon, and the newer daemon's schema is
 * not one this code can reason about. Opening it anyway would be the failure
 * this repository names most often — treating "I do not understand this" as
 * "this is fine".
 */
export function migrate(database: Database, migrations: readonly Migration[], upTo: number): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );

  const applied = new Set(database.appliedMigrations());
  const known = new Set(migrations.map((migration) => migration.version));
  const unknown = [...applied].filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new Error(
      `storage-sqlite: this database was written by a newer build — it carries migration(s) ` +
        `${unknown.join(', ')}, which this build does not know. Upgrade ForgeBridge, or point it at a different file.`,
    );
  }

  for (const migration of migrations) {
    if (applied.has(migration.version) || migration.version > upTo) continue;
    apply(database, migration);
  }
}

function apply(database: Database, migration: Migration): void {
  database.transaction(() => {
    for (const statement of migration.statements) database.exec(statement);
    database
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, new Date().toISOString());
  });
}

/**
 * Was this a uniqueness violation?
 *
 * SQLite reports every constraint failure as primary result code 19
 * (`SQLITE_CONSTRAINT`) with an extended code in the high bits, and
 * `node:sqlite` surfaces the extended code as `errcode`. Masking to the low
 * byte covers `SQLITE_CONSTRAINT_PRIMARYKEY` (1555) and
 * `SQLITE_CONSTRAINT_UNIQUE` (2067) without hard-coding either.
 *
 * Anything this cannot identify returns false and the caller rethrows the
 * original. Converting an unrecognised error into "that id already exists"
 * would answer a question we did not ask — the shape of bug this repository has
 * found four times.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code !== 'number') return false;
  const SQLITE_CONSTRAINT = 19;
  if ((code & 0xff) !== SQLITE_CONSTRAINT) return false;
  const extended = code >> 8;
  // 6 = PRIMARYKEY, 8 = UNIQUE. A NOT NULL or CHECK failure is also a
  // constraint error and is emphatically not "this id is taken".
  return extended === 6 || extended === 8;
}
