/**
 * The schemas, as an ordered list of versioned migrations (M40).
 *
 * Rules this file follows, each one a way a migration list stops being safe:
 *
 *   1. **Append only.** A migration that has shipped is never edited — editing
 *      one means a file created before the edit and a file created after it
 *      have the same version number and different shapes, and nothing can tell
 *      them apart afterwards.
 *   2. **Every statement is idempotent-safe under its own transaction.** The
 *      runner wraps each migration with the row that records it, so a crash
 *      leaves the file at the previous version rather than half-way through
 *      this one.
 *   3. **No credential-shaped column, ever.** THREAT-MODEL T1's strong form is
 *      "there is no column for them; the schema cannot hold one", and
 *      `scripts/verify-no-key-storage.ts` K1 reads this file to check it. The
 *      one credential-adjacent thing stored here is `Link.session_key_id`,
 *      which lives inside the JSON document and is an identifier for a key held
 *      in memory, never the key.
 */

export interface Migration {
  /** Strictly increasing. Recorded in `schema_migrations`. */
  readonly version: number;
  /** Shown in the migrations table, and in the error when a file is from the future. */
  readonly name: string;
  readonly statements: readonly string[];
}

/**
 * The daemon's transport state (`DaemonStore` in `@forgebridge/daemon`).
 *
 * Every table here is bounded — by `RETENTION`, by a link's lifetime, or by
 * being one row per project. A daemon runs for weeks; a table with no ceiling
 * is a leak that presents as "Studio got laggy".
 */
export const DAEMON_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'daemon-transport-state',
    statements: [
      /**
       * `document` holds the protocol `Link`; the columns beside it are the ones
       * `findPairedLink` filters and orders by. `last_seen_at` is nullable
       * because a link that has paired but never polled has genuinely not been
       * seen, and `findPairedLink` falls back to `created_at` — which is why
       * both are columns rather than one coalesced value written at insert
       * time. Coalescing at write time would make the fallback invisible to a
       * later reader.
       */
      `CREATE TABLE links (
         id           TEXT PRIMARY KEY,
         project_id   TEXT NOT NULL,
         state        TEXT NOT NULL,
         created_at   TEXT NOT NULL,
         last_seen_at TEXT,
         document     TEXT NOT NULL
       )`,
      `CREATE INDEX links_by_project ON links (project_id, state)`,

      `CREATE TABLE project_versions (
         project_id TEXT PRIMARY KEY,
         version    INTEGER NOT NULL
       )`,

      `CREATE TABLE project_policies (
         project_id TEXT PRIMARY KEY,
         document   TEXT NOT NULL
       )`,

      /**
       * Write-once by primary key. `putChangeSet` relies on the constraint
       * rather than on a read-then-write: the daemon's own comment says an
       * adapter "gets the same guarantee from a unique constraint, not from
       * checking first and hoping", and this is that constraint.
       */
      `CREATE TABLE change_sets (
         id         TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         status     TEXT NOT NULL,
         created_at TEXT NOT NULL,
         document   TEXT NOT NULL
       )`,

      /**
       * The queue. `(link_id, nonce)` is the primary key because the nonce is
       * the consumer's cursor and two rows sharing one would make the cursor
       * ambiguous — a poll would return one of them and the other would never
       * be delivered.
       */
      `CREATE TABLE deliveries (
         link_id    TEXT NOT NULL,
         nonce      INTEGER NOT NULL,
         payload    TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (link_id, nonce)
       )`,

      /**
       * The counters live apart from `deliveries` on purpose. Retention deletes
       * the oldest rows, so `MAX(nonce)` over the queue is not the last nonce
       * issued — it is the last one still stored. A cursor derived from a table
       * that gets trimmed would hand out a nonce the consumer has already seen.
       */
      `CREATE TABLE outbound_nonces (
         link_id TEXT PRIMARY KEY,
         nonce   INTEGER NOT NULL
       )`,

      /**
       * The replay watermark. Advanced by a single upsert whose `WHERE` clause
       * carries the comparison, so the check and the write are one statement —
       * `DaemonStore.tryAdvanceInboundNonce` requires exactly that, and warns
       * that an adapter awaiting real I/O between a read and a write "would
       * break it silently, which is the worst way for a replay guard to fail".
       */
      `CREATE TABLE inbound_nonces (
         link_id TEXT PRIMARY KEY,
         nonce   INTEGER NOT NULL
       )`,

      `CREATE TABLE apply_results (
         change_set_id TEXT PRIMARY KEY,
         document      TEXT NOT NULL
       )`,

      /**
       * The inverse operations a consumer captured, write-once by primary key.
       *
       * The strongest write-once rule in the schema: this row is the only copy
       * of the operations a rollback replays, so a second write under the same
       * id does not update a record — it replaces the route back from one apply
       * with the route back from a different one.
       *
       * `document` because the inverses include `restoreSubtree`, which carries
       * a serialised Roblox model. The server has no business understanding
       * that format (`InverseOperation` in the protocol says so), and a schema
       * that gave it columns would be claiming otherwise.
       */
      `CREATE TABLE journal_entries (
         id            TEXT PRIMARY KEY,
         project_id    TEXT NOT NULL,
         change_set_id TEXT NOT NULL,
         applied_at    TEXT NOT NULL,
         document      TEXT NOT NULL
       )`,

      /**
       * Not write-once, and the difference is deliberate. A partial replay
       * leaves inverses unspent, so a second rollback attempt is a legitimate
       * thing for a user to ask for — and a store that refused its result would
       * make the retry unreportable.
       */
      `CREATE TABLE rollback_results (
         journal_id TEXT PRIMARY KEY,
         document   TEXT NOT NULL
       )`,

      /**
       * Write-once by primary key, for a stronger reason than change sets: the
       * consumer holds the inverse operations under this id, so a second row
       * claiming it would leave the first apply with no route back at all
       * (THREAT-MODEL T2 layer 5).
       */
      `CREATE TABLE journals (
         id                    TEXT PRIMARY KEY,
         project_id            TEXT NOT NULL,
         change_set_id         TEXT NOT NULL,
         summary               TEXT NOT NULL,
         version_before        INTEGER NOT NULL,
         version_after         INTEGER NOT NULL,
         applied_at            TEXT NOT NULL,
         rollback_requested_at TEXT,
         rolled_back_at        TEXT
       )`,
      `CREATE INDEX journals_by_project ON journals (project_id, applied_at)`,

      /**
       * `seq` is the arrival order, which is the only order that means anything
       * here: several messages in one batch share a timestamp, and sorting by
       * `at` would scramble a stack trace.
       */
      `CREATE TABLE console_output (
         seq      INTEGER PRIMARY KEY AUTOINCREMENT,
         link_id  TEXT NOT NULL,
         document TEXT NOT NULL
       )`,
      `CREATE INDEX console_output_by_link ON console_output (link_id, seq)`,

      /**
       * `touched` is a monotonic counter bumped on every write, and retention
       * evicts the lowest. Not `updated_at`: two runs written in the same
       * millisecond would tie, and a tie in a retention order means the row
       * evicted depends on how the storage engine feels. It is also what makes
       * "a rewritten run moves to the young end of the window" true, so a burst
       * of new runs cannot evict a run that has not finished yet.
       */
      `CREATE TABLE runs (
         id       TEXT PRIMARY KEY,
         touched  INTEGER NOT NULL,
         document TEXT NOT NULL
       )`,
      `CREATE INDEX runs_by_touched ON runs (touched)`,
    ],
  },
];

/**
 * The product's store (`StoragePort` in `@forgebridge/core`).
 *
 * The three rules in `packages/core/src/ports/storage.ts` shaped this schema as
 * much as they shaped the port: no interactive transactions, no Postgres-only
 * constructs, and no OFFSET paging. The third one is why every listing here has
 * an index on `(scope, created_at DESC, id DESC)` — a keyset page needs the
 * cursor columns to be the index's leading columns, or it degrades into the
 * scan it was drawn to avoid.
 */
export const STORAGE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'storage-port-entities',
    statements: [
      /**
       * `owner_id` is nullable, and that is the ADR-005 decision in one column:
       * signed-out is a first-class mode, not a fallback. A schema with
       * `owner_id NOT NULL` and a magic "anonymous" row would be the same
       * `if (user)` branching the ADR rejected, moved into the data.
       */
      `CREATE TABLE projects (
         id         TEXT PRIMARY KEY,
         owner_id   TEXT,
         name       TEXT NOT NULL,
         place_id   INTEGER,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX projects_by_owner ON projects (owner_id, created_at DESC, id DESC)`,

      /**
       * One row per version, never updated. `TreeStore.append` is a
       * compare-and-set that inserts at `expected + 1`, and the primary key is
       * what refuses the second writer — the port says there is "no
       * last-write-wins path here, by construction rather than by convention",
       * and the construction is this key.
       */
      `CREATE TABLE tree_snapshots (
         project_id  TEXT NOT NULL,
         version     INTEGER NOT NULL,
         instances   TEXT NOT NULL,
         captured_at TEXT NOT NULL,
         PRIMARY KEY (project_id, version)
       )`,

      /**
       * What the consumer says it is at, which is a weaker claim than a stored
       * tree and is therefore stored apart from one. After
       * `recordConsumerVersion`, `currentVersion()` is ahead of the newest row
       * in `tree_snapshots` — and the port says so: "until it happens `get()`
       * will return an older snapshot than `currentVersion()` names. Saying so
       * plainly beats storing an invented tree."
       */
      `CREATE TABLE tree_consumer_versions (
         project_id TEXT PRIMARY KEY,
         version    INTEGER NOT NULL,
         reported_at TEXT NOT NULL
       )`,

      `CREATE TABLE runs (
         id         TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         started_at TEXT NOT NULL,
         document   TEXT NOT NULL
       )`,
      `CREATE INDEX runs_by_project ON runs (project_id, started_at DESC, id DESC)`,

      `CREATE TABLE change_sets (
         id         TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         run_id     TEXT,
         status     TEXT NOT NULL,
         created_at TEXT NOT NULL,
         document   TEXT NOT NULL
       )`,
      `CREATE INDEX change_sets_by_run ON change_sets (run_id, created_at, id)`,

      `CREATE TABLE apply_results (
         change_set_id TEXT PRIMARY KEY,
         document      TEXT NOT NULL
       )`,

      /**
       * The one entity that grows without bound: a delete's inverse carries the
       * whole removed subtree (ADR-012). `JournalStore.prune` is the ceiling,
       * and `(project_id, applied_at DESC, id DESC)` is both the listing order
       * and the order prune keeps by, so the two cannot disagree about which
       * entries are "the most recent".
       */
      `CREATE TABLE journal_entries (
         id             TEXT PRIMARY KEY,
         project_id     TEXT NOT NULL,
         applied_at     TEXT NOT NULL,
         rolled_back_at TEXT,
         document       TEXT NOT NULL
       )`,
      `CREATE INDEX journal_by_project ON journal_entries (project_id, applied_at DESC, id DESC)`,

      `CREATE TABLE links (
         id         TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         state      TEXT NOT NULL,
         created_at TEXT NOT NULL,
         document   TEXT NOT NULL
       )`,
      `CREATE INDEX links_by_project ON links (project_id, created_at DESC)`,

      `CREATE TABLE project_policies (
         project_id TEXT PRIMARY KEY,
         document   TEXT NOT NULL
       )`,

      /**
       * Scope is a free string (`user:<id>`, `project:<id>`, `install`) rather
       * than an enum, because settings outlive any enum the core would guess
       * today — the port says so, and a CHECK constraint here would quietly
       * turn that sentence into a lie.
       */
      `CREATE TABLE settings (
         scope TEXT NOT NULL,
         key   TEXT NOT NULL,
         value TEXT NOT NULL,
         PRIMARY KEY (scope, key)
       )`,
    ],
  },
];
