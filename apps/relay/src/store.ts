import { ForgeBridgeError } from '@forgebridge/protocol';
import type {
  ApplyResult,
  ChangeSet,
  ChangeSetStatus,
  JournalEntry,
  Link,
  RollbackResult,
} from '@forgebridge/protocol';
import type { DeliveryPayload, OutputMessage } from './wire.js';

/**
 * Relay state, behind a port.
 *
 * The one structural difference from `packages/daemon/src/store.ts`, and the
 * reason this is not a copy: **every record here belongs to a session, and
 * every read is scoped by one.**
 *
 * A daemon is one user's process. Its store can answer `getChangeSet(id)`
 * because every ChangeSet in it is that user's, and "whose is this?" is not a
 * question the daemon has to ask. On a relay the same call is a cross-tenant
 * read: ChangeSet ids are UUIDs, but an id is not an authorisation, and a store
 * whose reads take only an id is a store where forgetting one ownership check
 * in one handler exposes a stranger's script source.
 *
 * So the ownership check is not left to the handlers. It is in the signature:
 * there is no way to ask this store for a ChangeSet without saying which
 * session is asking, and a handler that omitted the check would not compile.
 * `test/isolation.test.ts` covers the routes end to end as well, because a type
 * signature is a proof about this code and not about a future adapter.
 */

export interface RelaySession {
  id: string;
  projectId: string;
  /**
   * A digest of the producer token, never the token.
   *
   * The relay compares by looking the digest up, which is both constant-time
   * with respect to the token's content and the only way to find "which of ten
   * thousand sessions is this?" without a linear scan of secrets.
   */
  producerTokenDigest: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface DeliveryRecord {
  linkId: string;
  nonce: number;
  payload: DeliveryPayload;
  enqueuedAt: string;
}

export interface JournalRecord {
  id: string;
  sessionId: string;
  projectId: string;
  changeSetId: string;
  summary: string;
  versionBefore: number;
  versionAfter: number;
  appliedAt: string;
  rollbackRequestedAt: string | null;
  rolledBackAt: string | null;
}

export interface RelayStore {
  // ── sessions ──
  putSession(session: RelaySession): Promise<void>;
  getSession(sessionId: string): Promise<RelaySession | null>;
  /** Resolve a producer token digest to its session, or null. */
  findSessionByTokenDigest(digest: string): Promise<RelaySession | null>;
  touchSession(sessionId: string, at: string): Promise<void>;
  dropSession(sessionId: string): Promise<void>;

  // ── links ──
  putLink(sessionId: string, link: Link): Promise<void>;
  getLink(linkId: string): Promise<{ session: RelaySession; link: Link } | null>;
  listLinks(sessionId: string): Promise<Link[]>;
  findPairedLink(sessionId: string, projectId: string): Promise<Link | null>;
  patchLink(linkId: string, patch: Partial<Link>): Promise<void>;

  // ── changesets ──
  putChangeSet(sessionId: string, changeSet: ChangeSet): Promise<void>;
  getChangeSet(sessionId: string, changeSetId: string): Promise<ChangeSet | null>;
  /** True when the id is taken by ANY session. Ids are write-once relay-wide. */
  changeSetIdTaken(changeSetId: string): Promise<boolean>;
  setChangeSetStatus(sessionId: string, changeSetId: string, status: ChangeSetStatus): Promise<void>;
  putApplyResult(sessionId: string, result: ApplyResult): Promise<void>;

  // ── deliveries ──
  enqueueDelivery(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord>;
  nextDelivery(linkId: string, since: number): Promise<DeliveryRecord | null>;
  /**
   * Claim an inbound nonce, atomically. False when it is at or below the
   * watermark — see the daemon's note: read-then-write lets a duplicated
   * request through twice.
   */
  tryAdvanceInboundNonce(linkId: string, nonce: number): Promise<boolean>;
  lastInboundNonce(linkId: string): Promise<number>;

  // ── journal ──
  putJournal(record: JournalRecord): Promise<void>;
  getJournal(sessionId: string, journalId: string): Promise<JournalRecord | null>;
  journalIdTaken(journalId: string): Promise<boolean>;
  patchJournal(journalId: string, patch: Partial<JournalRecord>): Promise<void>;

  /**
   * The inverses a consumer uploaded for one apply (M11).
   *
   * Held here rather than left in the Studio session that captured them,
   * because a rollback that cannot outlive the session that applied the change
   * is a session feature rather than a safety net. Write-once: an id already
   * recorded names an apply whose inverses are the only way back from it, and
   * overwriting that record is discarding the handle.
   */
  putJournalEntry(sessionId: string, entry: JournalEntry): Promise<void>;
  getJournalEntry(sessionId: string, journalId: string): Promise<JournalEntry | null>;
  putRollbackResult(sessionId: string, result: RollbackResult): Promise<void>;
  getRollbackResult(sessionId: string, journalId: string): Promise<RollbackResult | null>;

  // ── output ──
  appendOutput(linkId: string, messages: readonly OutputMessage[]): Promise<void>;
  recentOutput(linkId: string, limit: number): Promise<OutputMessage[]>;

  // ── project version ──
  getProjectVersion(sessionId: string, projectId: string): Promise<number>;
  setProjectVersion(sessionId: string, projectId: string, version: number): Promise<void>;
}

/**
 * Caps, so one session cannot become the relay's memory ceiling.
 *
 * The daemon holds one user's history and can afford to be generous; a shared
 * host cannot, and "unbounded per tenant" multiplied by "unbounded tenants" is
 * the whole of the resource-exhaustion story. Every one of these evicts oldest
 * first rather than refusing, because the alternative — a session that stops
 * working when its history fills — turns a storage bound into an availability
 * bug for the user who did nothing wrong.
 */
export const RELAY_STORE_CAPS = {
  changeSetsPerSession: 200,
  journalsPerSession: 200,
  outputPerLink: 500,
  deliveriesPerLink: 200,
  sessions: 50_000,
} as const;

interface LinkRecord {
  sessionId: string;
  link: Link;
}

interface LinkQueue {
  deliveries: DeliveryRecord[];
  nextNonce: number;
  inboundNonce: number;
  output: OutputMessage[];
}

export class InMemoryRelayStore implements RelayStore {
  readonly #sessions = new Map<string, RelaySession>();
  readonly #tokenIndex = new Map<string, string>();
  readonly #links = new Map<string, LinkRecord>();
  readonly #linkQueues = new Map<string, LinkQueue>();
  readonly #changeSets = new Map<string, { sessionId: string; changeSet: ChangeSet }>();
  readonly #changeSetsBySession = new Map<string, string[]>();
  readonly #applyResults = new Map<string, { sessionId: string; result: ApplyResult }>();
  readonly #journals = new Map<string, JournalRecord>();
  readonly #journalsBySession = new Map<string, string[]>();
  readonly #journalEntries = new Map<string, { sessionId: string; entry: JournalEntry }>();
  readonly #rollbackResults = new Map<string, { sessionId: string; result: RollbackResult }>();
  readonly #versions = new Map<string, number>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  async putSession(session: RelaySession): Promise<void> {
    if (this.#sessions.size >= RELAY_STORE_CAPS.sessions) this.#evictOldestSession();
    this.#sessions.set(session.id, session);
    this.#tokenIndex.set(session.producerTokenDigest, session.id);
  }

  async getSession(sessionId: string): Promise<RelaySession | null> {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= this.#now()) {
      await this.dropSession(sessionId);
      return null;
    }
    return session;
  }

  async findSessionByTokenDigest(digest: string): Promise<RelaySession | null> {
    const sessionId = this.#tokenIndex.get(digest);
    return sessionId ? this.getSession(sessionId) : null;
  }

  async touchSession(sessionId: string, at: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) session.lastSeenAt = at;
  }

  async dropSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    this.#tokenIndex.delete(session.producerTokenDigest);
    for (const [linkId, record] of this.#links) {
      if (record.sessionId !== sessionId) continue;
      this.#links.delete(linkId);
      this.#linkQueues.delete(linkId);
    }
    for (const id of this.#changeSetsBySession.get(sessionId) ?? []) {
      this.#changeSets.delete(id);
      this.#applyResults.delete(id);
    }
    this.#changeSetsBySession.delete(sessionId);
    for (const id of this.#journalsBySession.get(sessionId) ?? []) {
      this.#journals.delete(id);
      this.#journalEntries.delete(id);
      this.#rollbackResults.delete(id);
    }
    this.#journalsBySession.delete(sessionId);
    for (const key of [...this.#versions.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.#versions.delete(key);
    }
  }

  // ── links ──────────────────────────────────────────────────────────────────

  async putLink(sessionId: string, link: Link): Promise<void> {
    this.#links.set(link.id, { sessionId, link });
    if (!this.#linkQueues.has(link.id)) {
      this.#linkQueues.set(link.id, { deliveries: [], nextNonce: 1, inboundNonce: 0, output: [] });
    }
  }

  async getLink(linkId: string): Promise<{ session: RelaySession; link: Link } | null> {
    const record = this.#links.get(linkId);
    if (!record) return null;
    const session = await this.getSession(record.sessionId);
    if (!session) return null;
    return { session, link: record.link };
  }

  async listLinks(sessionId: string): Promise<Link[]> {
    const out: Link[] = [];
    for (const record of this.#links.values()) {
      if (record.sessionId === sessionId) out.push(record.link);
    }
    return out;
  }

  async findPairedLink(sessionId: string, projectId: string): Promise<Link | null> {
    for (const record of this.#links.values()) {
      if (record.sessionId !== sessionId) continue;
      if (record.link.projectId !== projectId) continue;
      if (record.link.state !== 'paired') continue;
      return record.link;
    }
    return null;
  }

  async patchLink(linkId: string, patch: Partial<Link>): Promise<void> {
    const record = this.#links.get(linkId);
    if (!record) return;
    record.link = { ...record.link, ...patch };
  }

  // ── changesets ─────────────────────────────────────────────────────────────

  async putChangeSet(sessionId: string, changeSet: ChangeSet): Promise<void> {
    const existing = this.#changeSets.get(changeSet.id);
    if (existing && existing.sessionId !== sessionId) {
      // Unreachable from the wire — `changeSetIdTaken` refuses first — and kept
      // because the store is a seam. A second session writing over the first
      // one's proposal would be a cross-tenant overwrite, which is worse than
      // the same-tenant overwrite the daemon already refuses.
      throw new Error('changeset id belongs to another session');
    }
    this.#changeSets.set(changeSet.id, { sessionId, changeSet });
    if (!existing) {
      const ids = this.#changeSetsBySession.get(sessionId) ?? [];
      ids.push(changeSet.id);
      while (ids.length > RELAY_STORE_CAPS.changeSetsPerSession) {
        const dropped = ids.shift();
        if (dropped !== undefined) {
          this.#changeSets.delete(dropped);
          this.#applyResults.delete(dropped);
        }
      }
      this.#changeSetsBySession.set(sessionId, ids);
    }
  }

  async getChangeSet(sessionId: string, changeSetId: string): Promise<ChangeSet | null> {
    const record = this.#changeSets.get(changeSetId);
    if (!record || record.sessionId !== sessionId) return null;
    return record.changeSet;
  }

  async changeSetIdTaken(changeSetId: string): Promise<boolean> {
    return this.#changeSets.has(changeSetId);
  }

  async setChangeSetStatus(sessionId: string, changeSetId: string, status: ChangeSetStatus): Promise<void> {
    const record = this.#changeSets.get(changeSetId);
    if (!record || record.sessionId !== sessionId) return;
    record.changeSet = { ...record.changeSet, status };
  }

  async putApplyResult(sessionId: string, result: ApplyResult): Promise<void> {
    this.#applyResults.set(result.changeSetId, { sessionId, result });
  }

  // ── deliveries ─────────────────────────────────────────────────────────────

  async enqueueDelivery(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord> {
    const queue = this.#queue(linkId);
    const record: DeliveryRecord = {
      linkId,
      nonce: queue.nextNonce,
      payload,
      enqueuedAt: new Date(this.#now()).toISOString(),
    };
    queue.nextNonce += 1;
    queue.deliveries.push(record);
    while (queue.deliveries.length > RELAY_STORE_CAPS.deliveriesPerLink) queue.deliveries.shift();
    return record;
  }

  async nextDelivery(linkId: string, since: number): Promise<DeliveryRecord | null> {
    const queue = this.#queue(linkId);
    for (const delivery of queue.deliveries) {
      if (delivery.nonce > since) return delivery;
    }
    return null;
  }

  async tryAdvanceInboundNonce(linkId: string, nonce: number): Promise<boolean> {
    const queue = this.#queue(linkId);
    if (!Number.isSafeInteger(nonce) || nonce <= queue.inboundNonce) return false;
    queue.inboundNonce = nonce;
    return true;
  }

  async lastInboundNonce(linkId: string): Promise<number> {
    return this.#queue(linkId).inboundNonce;
  }

  // ── journal ────────────────────────────────────────────────────────────────

  async putJournal(record: JournalRecord): Promise<void> {
    const existing = this.#journals.get(record.id);
    if (existing && existing.sessionId !== record.sessionId) {
      throw new Error('journal id belongs to another session');
    }
    this.#journals.set(record.id, record);
    if (!existing) {
      const ids = this.#journalsBySession.get(record.sessionId) ?? [];
      ids.push(record.id);
      while (ids.length > RELAY_STORE_CAPS.journalsPerSession) {
        const dropped = ids.shift();
        if (dropped !== undefined) {
          this.#journals.delete(dropped);
          // The inverses go with the journal they belong to. Keeping them after
          // the record is gone would leave a replay nothing can be checked
          // against, which is worse than no replay at all.
          this.#journalEntries.delete(dropped);
          this.#rollbackResults.delete(dropped);
        }
      }
      this.#journalsBySession.set(record.sessionId, ids);
    }
  }

  async getJournal(sessionId: string, journalId: string): Promise<JournalRecord | null> {
    const record = this.#journals.get(journalId);
    if (!record || record.sessionId !== sessionId) return null;
    return record;
  }

  async journalIdTaken(journalId: string): Promise<boolean> {
    return this.#journals.has(journalId);
  }

  async patchJournal(journalId: string, patch: Partial<JournalRecord>): Promise<void> {
    const record = this.#journals.get(journalId);
    if (!record) return;
    this.#journals.set(journalId, { ...record, ...patch });
  }

  async putJournalEntry(sessionId: string, entry: JournalEntry): Promise<void> {
    if (this.#journalEntries.has(entry.id)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${entry.id} already carries inverse operations`,
        'The inverses of an apply are captured once, before it runs; a second upload would replace the only route back.',
      );
    }
    this.#journalEntries.set(entry.id, { sessionId, entry });
  }

  async getJournalEntry(sessionId: string, journalId: string): Promise<JournalEntry | null> {
    const record = this.#journalEntries.get(journalId);
    return record && record.sessionId === sessionId ? record.entry : null;
  }

  async putRollbackResult(sessionId: string, result: RollbackResult): Promise<void> {
    this.#rollbackResults.set(result.journalId, { sessionId, result });
  }

  async getRollbackResult(sessionId: string, journalId: string): Promise<RollbackResult | null> {
    const record = this.#rollbackResults.get(journalId);
    return record && record.sessionId === sessionId ? record.result : null;
  }

  // ── output ─────────────────────────────────────────────────────────────────

  async appendOutput(linkId: string, messages: readonly OutputMessage[]): Promise<void> {
    const queue = this.#queue(linkId);
    queue.output.push(...messages);
    while (queue.output.length > RELAY_STORE_CAPS.outputPerLink) queue.output.shift();
  }

  async recentOutput(linkId: string, limit: number): Promise<OutputMessage[]> {
    const queue = this.#queue(linkId);
    return queue.output.slice(Math.max(0, queue.output.length - limit));
  }

  // ── project version ────────────────────────────────────────────────────────

  async getProjectVersion(sessionId: string, projectId: string): Promise<number> {
    return this.#versions.get(`${sessionId}:${projectId}`) ?? 0;
  }

  async setProjectVersion(sessionId: string, projectId: string, version: number): Promise<void> {
    this.#versions.set(`${sessionId}:${projectId}`, version);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  #queue(linkId: string): LinkQueue {
    const existing = this.#linkQueues.get(linkId);
    if (existing) return existing;
    const fresh: LinkQueue = { deliveries: [], nextNonce: 1, inboundNonce: 0, output: [] };
    this.#linkQueues.set(linkId, fresh);
    return fresh;
  }

  #evictOldestSession(): void {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const session of this.#sessions.values()) {
      const at = Date.parse(session.lastSeenAt);
      if (at < oldestAt) {
        oldestAt = at;
        oldestId = session.id;
      }
    }
    if (oldestId !== null) void this.dropSession(oldestId);
  }
}
