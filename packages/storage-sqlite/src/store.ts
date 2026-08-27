/**
 * `DaemonStore` over SQLite (M40).
 *
 * The daemon's persistence seam against a file under `~/.forgebridge`, held to
 * the same suite as the in-memory store: `test/parity.test.ts` runs
 * `DAEMON_STORE_SUITE` — the same array `packages/daemon/test/store.test.ts`
 * runs — and both are required green.
 *
 * ── Every method is `async`, and no method awaits ─────────────────────────────
 *
 * That is not an oversight, it is the whole atomicity story. `node:sqlite` is
 * synchronous, so a sequence of statements inside one method cannot be
 * interleaved by another handler: the event loop gets no turn between them.
 * `DaemonStore.tryAdvanceInboundNonce` warns that an adapter which "awaits real
 * I/O between the two calls (M40's SQLite) would break it silently, which is
 * the worst way for a replay guard to fail". Nothing here awaits, and the
 * replay guard is additionally a single SQL statement so that it holds against
 * a *second process* on the same file too — which the event-loop argument does
 * not cover.
 *
 * ── Retention ────────────────────────────────────────────────────────────────
 *
 * `RETENTION` is imported from the daemon rather than restated. Two copies of a
 * cap are two caps, and the suite asserts the trimmed queue's first surviving
 * nonce — a number that is only right if both adapters trim by the same rule
 * and to the same depth.
 */
import { ForgeBridgeError } from '@forgebridge/protocol';
import type {
  ApplyResult,
  ChangeSet,
  ChangeSetStatus,
  JournalEntry,
  Link,
  RollbackResult,
} from '@forgebridge/protocol';
import type { ProjectPolicy } from '@forgebridge/core';
import { NONCE_ORIGIN } from '@forgebridge/daemon';
import {
  RETENTION,
  type DaemonStore,
  type DeliveryRecord,
  type JournalRecord,
  type LinkPatch,
  type RunRecord,
} from '@forgebridge/daemon';
import type { DeliveryPayload, OutputMessage } from '@forgebridge/daemon';
import {
  DAEMON_DATABASE,
  forgeBridgeHome,
  isUniqueViolation,
  openDatabase,
  type Database,
} from './database.js';
import { DAEMON_MIGRATIONS } from './migrations.js';
import path from 'node:path';

export interface SqliteDaemonStoreOptions {
  /** Defaults to `~/.forgebridge/daemon.sqlite`. `:memory:` for a test. */
  location?: string;
  /** Injected so a test can drive delivery timestamps. Defaults to `Date.now`. */
  now?: () => number;
  /** See `OpenDatabaseOptions.migrateTo`. */
  migrateTo?: number;
}

export async function createSqliteDaemonStore(
  options: SqliteDaemonStoreOptions = {},
): Promise<SqliteDaemonStore> {
  const database = await openDatabase({
    location: options.location ?? path.join(forgeBridgeHome(), DAEMON_DATABASE),
    migrations: DAEMON_MIGRATIONS,
    ...(options.migrateTo !== undefined ? { migrateTo: options.migrateTo } : {}),
  });
  return new SqliteDaemonStore(database, options.now ?? Date.now);
}

export class SqliteDaemonStore implements DaemonStore {
  readonly #db: Database;
  readonly #now: () => number;

  /**
   * Constructed from an already-open database rather than opening one, so that
   * a host running both adapters can decide for itself how many connections it
   * wants. `createSqliteDaemonStore` is the ordinary way in.
   */
  constructor(database: Database, now: () => number = Date.now) {
    this.#db = database;
    this.#now = now;
  }

  /** Releases the file handle. A closed store throws on every subsequent call. */
  close(): void {
    this.#db.close();
  }

  // ── links ──────────────────────────────────────────────────────────────────

  async putLink(link: Link): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO links (id, project_id, state, created_at, last_seen_at, document)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id   = excluded.project_id,
           state        = excluded.state,
           created_at   = excluded.created_at,
           last_seen_at = excluded.last_seen_at,
           document     = excluded.document`,
      )
      .run(link.id, link.projectId, link.state, link.createdAt, link.lastSeenAt ?? null, JSON.stringify(link));
  }

  async getLink(linkId: string): Promise<Link | null> {
    return documentOf<Link>(this.#db.prepare('SELECT document FROM links WHERE id = ?').get(linkId));
  }

  async listLinks(): Promise<Link[]> {
    return this.#db
      .prepare('SELECT document FROM links ORDER BY created_at, id')
      .all()
      .map((row) => JSON.parse(String(row['document'])) as Link);
  }

  async patchLink(linkId: string, patch: LinkPatch): Promise<Link | null> {
    return this.#db.transaction(() => {
      const existing = documentOf<Link>(
        this.#db.prepare('SELECT document FROM links WHERE id = ?').get(linkId),
      );
      if (!existing) return null;
      // Same merge as the in-memory store. Note that a key explicitly set to
      // `undefined` is dropped by `JSON.stringify` rather than stored as
      // undefined; every field on `LinkPatch` is optional precisely so that a
      // caller omits what it is not changing rather than passing undefined.
      const updated = { ...existing, ...patch } as Link;
      this.#db
        .prepare(
          `UPDATE links SET project_id = ?, state = ?, created_at = ?, last_seen_at = ?, document = ?
           WHERE id = ?`,
        )
        .run(
          updated.projectId,
          updated.state,
          updated.createdAt,
          updated.lastSeenAt ?? null,
          JSON.stringify(updated),
          linkId,
        );
      return JSON.parse(JSON.stringify(updated)) as Link;
    });
  }

  async findPairedLink(projectId: string): Promise<Link | null> {
    // `COALESCE(last_seen_at, created_at)`: a link that paired but has not
    // polled yet has genuinely never been seen, and ordering it as if it had
    // been seen at the epoch would hide a session the user just opened.
    return documentOf<Link>(
      this.#db
        .prepare(
          `SELECT document FROM links
           WHERE project_id = ? AND state = 'paired'
           ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
           LIMIT 1`,
        )
        .get(projectId),
    );
  }

  // ── project version and policy ─────────────────────────────────────────────

  async getProjectVersion(projectId: string): Promise<number> {
    const row = this.#db.prepare('SELECT version FROM project_versions WHERE project_id = ?').get(projectId);
    return row ? Number(row['version']) : 0;
  }

  async setProjectVersion(projectId: string, version: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO project_versions (project_id, version) VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET version = excluded.version`,
      )
      .run(projectId, version);
  }

  async getProjectPolicy(projectId: string): Promise<ProjectPolicy | null> {
    // Null, never an empty allowlist. "Not configured" and "configured to
    // permit nothing" are different facts and the caller decides what the first
    // one means — for the daemon, `DENY_ALL_POLICY`.
    return documentOf<ProjectPolicy>(
      this.#db.prepare('SELECT document FROM project_policies WHERE project_id = ?').get(projectId),
    );
  }

  async setProjectPolicy(projectId: string, policy: ProjectPolicy): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO project_policies (project_id, document) VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET document = excluded.document`,
      )
      .run(projectId, JSON.stringify(policy));
  }

  // ── change sets ────────────────────────────────────────────────────────────

  async putChangeSet(changeSet: ChangeSet): Promise<void> {
    try {
      this.#db
        .prepare('INSERT INTO change_sets (id, project_id, status, created_at, document) VALUES (?, ?, ?, ?, ?)')
        .run(changeSet.id, changeSet.projectId, changeSet.status, changeSet.createdAt, JSON.stringify(changeSet));
    } catch (error) {
      // The primary key is the guarantee, not a preceding SELECT: a read then a
      // write can both find the id free. Anything that is not a uniqueness
      // violation is rethrown untouched — reporting an unrecognised failure as
      // "that id already exists" would answer a question nobody asked.
      if (!isUniqueViolation(error)) throw error;
      throw new ForgeBridgeError(
        'invalid_request',
        `changeset ${changeSet.id} already exists and would be overwritten`,
        'Mint a fresh ChangeSet id; an id that has been proposed once names that proposal for good.',
      );
    }
  }

  async getChangeSet(id: string): Promise<ChangeSet | null> {
    return documentOf<ChangeSet>(this.#db.prepare('SELECT document FROM change_sets WHERE id = ?').get(id));
  }

  async setChangeSetStatus(id: string, status: ChangeSetStatus): Promise<ChangeSet | null> {
    return this.#db.transaction(() => {
      const existing = documentOf<ChangeSet>(
        this.#db.prepare('SELECT document FROM change_sets WHERE id = ?').get(id),
      );
      if (!existing) return null;
      const updated: ChangeSet = { ...existing, status };
      this.#db
        .prepare('UPDATE change_sets SET status = ?, document = ? WHERE id = ?')
        .run(status, JSON.stringify(updated), id);
      return updated;
    });
  }

  // ── deliveries ─────────────────────────────────────────────────────────────

  async enqueueDelivery(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord> {
    return this.#db.transaction(() => {
      // The counter lives in its own table because retention deletes rows from
      // `deliveries`: `MAX(nonce)` over a trimmed queue is the last nonce still
      // *stored*, not the last one issued, and a cursor derived from it would
      // re-issue a nonce the consumer has already seen.
      this.#db
        .prepare(
          `INSERT INTO outbound_nonces (link_id, nonce) VALUES (?, ?)
           ON CONFLICT(link_id) DO UPDATE SET nonce = outbound_nonces.nonce + 1`,
        )
        .run(linkId, NONCE_ORIGIN + 1);
      const nonce = Number(
        this.#db.prepare('SELECT nonce FROM outbound_nonces WHERE link_id = ?').get(linkId)?.['nonce'],
      );

      const record: DeliveryRecord = {
        linkId,
        nonce,
        payload,
        createdAt: new Date(this.#now()).toISOString(),
      };
      this.#db
        .prepare('INSERT INTO deliveries (link_id, nonce, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(linkId, nonce, JSON.stringify(payload), record.createdAt);

      // Trim the front: a consumer that fell this far behind has to re-pair
      // anyway, and holding megabytes of stale ChangeSets helps nobody.
      this.#db
        .prepare(
          `DELETE FROM deliveries
           WHERE link_id = ?
             AND nonce NOT IN (SELECT nonce FROM deliveries WHERE link_id = ? ORDER BY nonce DESC LIMIT ?)`,
        )
        .run(linkId, linkId, RETENTION.DELIVERIES_PER_LINK);

      return record;
    });
  }

  async nextDelivery(linkId: string, sinceNonce: number): Promise<DeliveryRecord | null> {
    const row = this.#db
      .prepare(
        `SELECT link_id, nonce, payload, created_at FROM deliveries
         WHERE link_id = ? AND nonce > ? ORDER BY nonce LIMIT 1`,
      )
      .get(linkId, sinceNonce);
    if (!row) return null;
    return {
      linkId: String(row['link_id']),
      nonce: Number(row['nonce']),
      payload: JSON.parse(String(row['payload'])) as DeliveryPayload,
      createdAt: String(row['created_at']),
    };
  }

  async lastOutboundNonce(linkId: string): Promise<number> {
    const row = this.#db.prepare('SELECT nonce FROM outbound_nonces WHERE link_id = ?').get(linkId);
    return row ? Number(row['nonce']) : NONCE_ORIGIN;
  }

  // ── the replay watermark ───────────────────────────────────────────────────

  async lastInboundNonce(linkId: string): Promise<number> {
    const row = this.#db.prepare('SELECT nonce FROM inbound_nonces WHERE link_id = ?').get(linkId);
    return row ? Number(row['nonce']) : NONCE_ORIGIN;
  }

  async tryAdvanceInboundNonce(linkId: string, nonce: number): Promise<boolean> {
    // The value arrived from across a trust boundary. NaN compares false
    // against everything, so a guard written only as `nonce > current` admits
    // it and then stores it as the watermark — disabling the replay check for
    // the rest of the session.
    if (!Number.isSafeInteger(nonce) || nonce <= NONCE_ORIGIN) return false;

    // One statement, so the comparison and the write cannot be separated: the
    // `WHERE` on the upsert *is* the compare-and-swap. Two processes racing on
    // this file both go through SQLite's write lock, so exactly one of them
    // sees `changes === 1`.
    const result = this.#db
      .prepare(
        `INSERT INTO inbound_nonces (link_id, nonce) VALUES (?, ?)
         ON CONFLICT(link_id) DO UPDATE SET nonce = excluded.nonce
         WHERE excluded.nonce > inbound_nonces.nonce`,
      )
      .run(linkId, nonce);
    return Number(result.changes) === 1;
  }

  // ── apply results ──────────────────────────────────────────────────────────

  async putApplyResult(result: ApplyResult): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO apply_results (change_set_id, document) VALUES (?, ?)
         ON CONFLICT(change_set_id) DO UPDATE SET document = excluded.document`,
      )
      .run(result.changeSetId, JSON.stringify(result));
  }

  async getApplyResult(changeSetId: string): Promise<ApplyResult | null> {
    return documentOf<ApplyResult>(
      this.#db.prepare('SELECT document FROM apply_results WHERE change_set_id = ?').get(changeSetId),
    );
  }

  // ── journals ───────────────────────────────────────────────────────────────

  async putJournal(record: JournalRecord): Promise<void> {
    try {
      this.#db
        .prepare(
          `INSERT INTO journals
             (id, project_id, change_set_id, summary, version_before, version_after,
              applied_at, rollback_requested_at, rolled_back_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.projectId,
          record.changeSetId,
          record.summary,
          record.versionBefore,
          record.versionAfter,
          record.appliedAt,
          record.rollbackRequestedAt,
          record.rolledBackAt,
        );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${record.id} already exists and would be overwritten`,
        'Report each apply under the journal id it was captured with, and mint a fresh id per apply.',
      );
    }
  }

  async getJournal(id: string): Promise<JournalRecord | null> {
    const row = this.#db.prepare('SELECT * FROM journals WHERE id = ?').get(id);
    return row ? journalOf(row) : null;
  }

  async patchJournal(id: string, patch: Partial<JournalRecord>): Promise<JournalRecord | null> {
    return this.#db.transaction(() => {
      const row = this.#db.prepare('SELECT * FROM journals WHERE id = ?').get(id);
      if (!row) return null;
      // `id: existing.id` last: the id is the consumer's handle for the
      // inverses it captured, so a patch that could move it would rename the
      // only route back from an apply.
      const updated: JournalRecord = { ...journalOf(row), ...patch, id };
      this.#db
        .prepare(
          `UPDATE journals SET project_id = ?, change_set_id = ?, summary = ?, version_before = ?,
             version_after = ?, applied_at = ?, rollback_requested_at = ?, rolled_back_at = ?
           WHERE id = ?`,
        )
        .run(
          updated.projectId,
          updated.changeSetId,
          updated.summary,
          updated.versionBefore,
          updated.versionAfter,
          updated.appliedAt,
          updated.rollbackRequestedAt,
          updated.rolledBackAt,
          id,
        );
      return updated;
    });
  }

  // ── the console mirror ─────────────────────────────────────────────────────

  async appendOutput(linkId: string, messages: readonly OutputMessage[]): Promise<void> {
    if (messages.length === 0) return;
    this.#db.transaction(() => {
      const insert = this.#db.prepare('INSERT INTO console_output (link_id, document) VALUES (?, ?)');
      for (const message of messages) insert.run(linkId, JSON.stringify(message));
      this.#db
        .prepare(
          `DELETE FROM console_output
           WHERE link_id = ?
             AND seq NOT IN (SELECT seq FROM console_output WHERE link_id = ? ORDER BY seq DESC LIMIT ?)`,
        )
        .run(linkId, linkId, RETENTION.OUTPUT_PER_LINK);
    });
  }

  async recentOutput(linkId: string, limit: number): Promise<OutputMessage[]> {
    if (limit <= 0) return [];
    // Newest-first with a LIMIT, then reversed: the alternative — ordering
    // ascending and offsetting — is the O(n) scan the storage rules rule out,
    // and the mirror is the one table a runaway script can fill in seconds.
    return this.#db
      .prepare('SELECT document FROM console_output WHERE link_id = ? ORDER BY seq DESC LIMIT ?')
      .all(linkId, limit)
      .map((row) => JSON.parse(String(row['document'])) as OutputMessage)
      .reverse();
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  async putRun(record: RunRecord): Promise<void> {
    this.#db.transaction(() => {
      // `touched` is bumped on every write, including a rewrite, so a run still
      // being executed sits at the young end of the retention window. A
      // timestamp would tie for two runs written in the same millisecond, and a
      // tie in a retention order means the evicted row depends on how the
      // storage engine feels that day.
      this.#db
        .prepare(
          `INSERT INTO runs (id, touched, document)
           VALUES (?, (SELECT COALESCE(MAX(touched), 0) + 1 FROM runs), ?)
           ON CONFLICT(id) DO UPDATE SET touched = excluded.touched, document = excluded.document`,
        )
        .run(record.run.id, JSON.stringify(record));
      this.#db
        .prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY touched DESC LIMIT ?)')
        .run(RETENTION.RUNS);
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return documentOf<RunRecord>(this.#db.prepare('SELECT document FROM runs WHERE id = ?').get(runId));
  }

  // ── the inverses, and how far a replay of them got ─────────────────────────

  async putJournalEntry(entry: JournalEntry): Promise<void> {
    try {
      this.#db
        .prepare(
          'INSERT INTO journal_entries (id, project_id, change_set_id, applied_at, document) VALUES (?, ?, ?, ?, ?)',
        )
        .run(entry.id, entry.projectId, entry.changeSetId, entry.appliedAt, JSON.stringify(entry));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${entry.id} already carries inverse operations`,
        'The inverses of an apply are captured once, before it runs; a second upload would replace the only route back.',
      );
    }
  }

  async getJournalEntry(id: string): Promise<JournalEntry | null> {
    return documentOf<JournalEntry>(
      this.#db.prepare('SELECT document FROM journal_entries WHERE id = ?').get(id),
    );
  }

  async putRollbackResult(result: RollbackResult): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO rollback_results (journal_id, document) VALUES (?, ?)
         ON CONFLICT(journal_id) DO UPDATE SET document = excluded.document`,
      )
      .run(result.journalId, JSON.stringify(result));
  }

  async getRollbackResult(journalId: string): Promise<RollbackResult | null> {
    return documentOf<RollbackResult>(
      this.#db.prepare('SELECT document FROM rollback_results WHERE journal_id = ?').get(journalId),
    );
  }
}

type Row = Record<string, unknown> | undefined;

function documentOf<T>(row: Row): T | null {
  if (!row) return null;
  return JSON.parse(String(row['document'])) as T;
}

/**
 * The journal is the one entity stored in columns rather than as a document.
 *
 * It has no protocol type — `JournalRecord` is the daemon's own shape, and it
 * is the one thing here that gets *queried* by more than its id (by project,
 * and by whether a rollback is outstanding). Columns make those queries
 * possible; a JSON blob would make them a table scan with `json_extract`.
 */
function journalOf(row: Record<string, unknown>): JournalRecord {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    changeSetId: String(row['change_set_id']),
    summary: String(row['summary']),
    versionBefore: Number(row['version_before']),
    versionAfter: Number(row['version_after']),
    appliedAt: String(row['applied_at']),
    rollbackRequestedAt: row['rollback_requested_at'] === null ? null : String(row['rollback_requested_at']),
    rolledBackAt: row['rolled_back_at'] === null ? null : String(row['rolled_back_at']),
  };
}
