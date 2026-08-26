import type { ProjectPolicy } from '@forgebridge/core';
import { ForgeBridgeError } from '@forgebridge/protocol';
import type { ApplyResult, ChangeSet, ChangeSetStatus, Link } from '@forgebridge/protocol';
import { NONCE_ORIGIN } from './envelope.js';
import type { DeliveryPayload, OutputMessage } from './wire.js';

/**
 * State the daemon keeps for a link. `sessionKey` is deliberately absent: keys
 * live in the in-process keyring in `server.ts` and never reach a store, so a
 * persistent adapter cannot accidentally write one to disk (C4, ADR-006).
 */
export interface DeliveryRecord {
  linkId: string;
  nonce: number;
  payload: DeliveryPayload;
  createdAt: string;
}

/**
 * What the daemon knows about an apply, which is less than a protocol
 * `JournalEntry`: the inverse operations — including serialised subtrees — stay
 * on the consumer that captured them. The server has no business holding a
 * Roblox model format it cannot interpret (see `InverseOperation` in the
 * protocol), so it holds the handle and the version bracket only.
 */
export interface JournalRecord {
  id: string;
  projectId: string;
  changeSetId: string;
  summary: string;
  versionBefore: number;
  versionAfter: number;
  appliedAt: string;
  rollbackRequestedAt: string | null;
  rolledBackAt: string | null;
}

export interface LinkPatch {
  state?: Link['state'];
  pluginVersion?: string | null;
  studioVersion?: string | null;
  placeId?: number | null;
  lastSeenAt?: string | null;
}

/**
 * The daemon's persistence seam.
 *
 * Everything is a Promise even though the in-memory implementation is
 * synchronous: a seam that only fits synchronous adapters is not a seam, and
 * making handlers `await` from day one means swapping the adapter is a
 * one-line change rather than a rewrite of every call site.
 *
 * TODO(M40): `@forgebridge/storage-sqlite` implements this against SQLite under
 * ~/.forgebridge and must pass this package's store test suite unchanged.
 */
export interface DaemonStore {
  putLink(link: Link): Promise<void>;
  getLink(linkId: string): Promise<Link | null>;
  listLinks(): Promise<Link[]>;
  patchLink(linkId: string, patch: LinkPatch): Promise<Link | null>;
  /** The most recently seen paired link for a project, if any. */
  findPairedLink(projectId: string): Promise<Link | null>;

  getProjectVersion(projectId: string): Promise<number>;
  setProjectVersion(projectId: string, version: number): Promise<void>;

  /**
   * The project's path policy, or null when it has none of its own.
   *
   * Null means "not configured", never "everything is permitted" — the caller
   * substitutes its own default, which is `DENY_ALL_POLICY` unless the operator
   * said otherwise. An adapter that returns an empty allowlist for a missing
   * row is saying the same thing a different way; returning null keeps the two
   * facts distinguishable.
   */
  getProjectPolicy(projectId: string): Promise<ProjectPolicy | null>;
  setProjectPolicy(projectId: string, policy: ProjectPolicy): Promise<void>;

  putChangeSet(changeSet: ChangeSet): Promise<void>;
  getChangeSet(id: string): Promise<ChangeSet | null>;
  setChangeSetStatus(id: string, status: ChangeSetStatus): Promise<ChangeSet | null>;

  /** Assigns the next monotonic nonce for the link and queues the payload. */
  enqueueDelivery(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord>;
  /** The first queued delivery for the link with a nonce above the cursor. */
  nextDelivery(linkId: string, sinceNonce: number): Promise<DeliveryRecord | null>;
  lastOutboundNonce(linkId: string): Promise<number>;

  /**
   * Watermark for replay rejection on envelopes the consumer sends us. Read
   * only — for status and for error messages. Never read-then-write: see below.
   */
  lastInboundNonce(linkId: string): Promise<number>;

  /**
   * Claim `nonce` for this link: advance the watermark and return true, or
   * return false because the nonce is at or below the one already accepted.
   *
   * One call, because replay rejection is a compare-and-swap and nothing less
   * is a guarantee. A `lastInboundNonce()` followed by a `set…()` reads as
   * atomic and is not: two envelopes carrying the same nonce can both read the
   * old watermark before either writes, and both then apply. That it does not
   * happen with a Map today is a property of one implementation, not of this
   * interface — and an adapter that awaits real I/O between the two calls
   * (M40's SQLite) would break it silently, which is the worst way for a
   * replay guard to fail. Implementations must make this one atomic step.
   */
  tryAdvanceInboundNonce(linkId: string, nonce: number): Promise<boolean>;

  putApplyResult(result: ApplyResult): Promise<void>;
  getApplyResult(changeSetId: string): Promise<ApplyResult | null>;

  /**
   * Record a journal entry under the id the consumer minted for it.
   *
   * Refuses an id that already exists. The id is the consumer's handle for the
   * inverse operations it captured, so a second entry claiming the same id is
   * describing a different apply — writing it would overwrite the only route
   * back from the first one (THREAT-MODEL T2 layer 5). The daemon cannot mint
   * the id itself for the same reason: the inverses live on the consumer, keyed
   * by the consumer's id, so a server-side id would name a journal nobody can
   * replay. Refusing is the only option that keeps both halves addressable.
   */
  putJournal(record: JournalRecord): Promise<void>;
  getJournal(id: string): Promise<JournalRecord | null>;
  patchJournal(id: string, patch: Partial<JournalRecord>): Promise<JournalRecord | null>;

  appendOutput(linkId: string, messages: readonly OutputMessage[]): Promise<void>;
  recentOutput(linkId: string, limit: number): Promise<OutputMessage[]>;
}

/**
 * Retention caps. A daemon is expected to run for weeks; an unbounded delivery
 * queue or console mirror is a slow memory leak that presents as "Studio got
 * laggy" long before anyone suspects the bridge.
 */
export const RETENTION = {
  DELIVERIES_PER_LINK: 64,
  OUTPUT_PER_LINK: 500,
} as const;

export class InMemoryDaemonStore implements DaemonStore {
  readonly #links = new Map<string, Link>();
  readonly #versions = new Map<string, number>();
  readonly #policies = new Map<string, ProjectPolicy>();
  readonly #changeSets = new Map<string, ChangeSet>();
  readonly #deliveries = new Map<string, DeliveryRecord[]>();
  readonly #outboundNonce = new Map<string, number>();
  readonly #inboundNonce = new Map<string, number>();
  readonly #applyResults = new Map<string, ApplyResult>();
  readonly #journals = new Map<string, JournalRecord>();
  readonly #output = new Map<string, OutputMessage[]>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async putLink(link: Link): Promise<void> {
    this.#links.set(link.id, link);
  }

  async getLink(linkId: string): Promise<Link | null> {
    return this.#links.get(linkId) ?? null;
  }

  async listLinks(): Promise<Link[]> {
    return [...this.#links.values()];
  }

  async patchLink(linkId: string, patch: LinkPatch): Promise<Link | null> {
    const existing = this.#links.get(linkId);
    if (!existing) return null;
    const updated: Link = { ...existing, ...patch };
    this.#links.set(linkId, updated);
    return updated;
  }

  async findPairedLink(projectId: string): Promise<Link | null> {
    let best: Link | null = null;
    for (const link of this.#links.values()) {
      if (link.projectId !== projectId || link.state !== 'paired') continue;
      if (!best || (link.lastSeenAt ?? link.createdAt) >= (best.lastSeenAt ?? best.createdAt)) {
        best = link;
      }
    }
    return best;
  }

  async getProjectVersion(projectId: string): Promise<number> {
    return this.#versions.get(projectId) ?? 0;
  }

  async setProjectVersion(projectId: string, version: number): Promise<void> {
    this.#versions.set(projectId, version);
  }

  async getProjectPolicy(projectId: string): Promise<ProjectPolicy | null> {
    return this.#policies.get(projectId) ?? null;
  }

  async setProjectPolicy(projectId: string, policy: ProjectPolicy): Promise<void> {
    this.#policies.set(projectId, policy);
  }

  async putChangeSet(changeSet: ChangeSet): Promise<void> {
    this.#changeSets.set(changeSet.id, changeSet);
  }

  async getChangeSet(id: string): Promise<ChangeSet | null> {
    return this.#changeSets.get(id) ?? null;
  }

  async setChangeSetStatus(id: string, status: ChangeSetStatus): Promise<ChangeSet | null> {
    const existing = this.#changeSets.get(id);
    if (!existing) return null;
    const updated: ChangeSet = { ...existing, status };
    this.#changeSets.set(id, updated);
    return updated;
  }

  async enqueueDelivery(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord> {
    const nonce = (this.#outboundNonce.get(linkId) ?? NONCE_ORIGIN) + 1;
    this.#outboundNonce.set(linkId, nonce);
    const record: DeliveryRecord = {
      linkId,
      nonce,
      payload,
      createdAt: new Date(this.#now()).toISOString(),
    };
    const queue = this.#deliveries.get(linkId) ?? [];
    queue.push(record);
    // Trim the front: a consumer that fell this far behind has to re-pair
    // anyway, and holding megabytes of stale ChangeSets helps nobody.
    if (queue.length > RETENTION.DELIVERIES_PER_LINK) {
      queue.splice(0, queue.length - RETENTION.DELIVERIES_PER_LINK);
    }
    this.#deliveries.set(linkId, queue);
    return record;
  }

  async nextDelivery(linkId: string, sinceNonce: number): Promise<DeliveryRecord | null> {
    const queue = this.#deliveries.get(linkId);
    if (!queue) return null;
    for (const record of queue) {
      if (record.nonce > sinceNonce) return record;
    }
    return null;
  }

  async lastOutboundNonce(linkId: string): Promise<number> {
    return this.#outboundNonce.get(linkId) ?? NONCE_ORIGIN;
  }

  async lastInboundNonce(linkId: string): Promise<number> {
    return this.#inboundNonce.get(linkId) ?? NONCE_ORIGIN;
  }

  /**
   * Atomic here because a JS Map read and write cannot be interleaved without
   * an `await` between them, and there is none. An adapter that talks to a
   * database gets this from the database — `UPDATE … WHERE nonce < ?` and a
   * rowcount, or a transaction — not from checking first and hoping.
   */
  async tryAdvanceInboundNonce(linkId: string, nonce: number): Promise<boolean> {
    if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
    const current = this.#inboundNonce.get(linkId) ?? NONCE_ORIGIN;
    if (nonce <= current) return false;
    this.#inboundNonce.set(linkId, nonce);
    return true;
  }

  async putApplyResult(result: ApplyResult): Promise<void> {
    this.#applyResults.set(result.changeSetId, result);
  }

  async getApplyResult(changeSetId: string): Promise<ApplyResult | null> {
    return this.#applyResults.get(changeSetId) ?? null;
  }

  async putJournal(record: JournalRecord): Promise<void> {
    if (this.#journals.has(record.id)) {
      // The last line of defence, not the first: the apply-result handler
      // checks before it mutates anything so the caller gets this error with
      // the project version untouched. This one is here so that a future
      // handler which forgets cannot quietly destroy a rollback handle.
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${record.id} already exists and would be overwritten`,
        'Report each apply under the journal id it was captured with, and mint a fresh id per apply.',
      );
    }
    this.#journals.set(record.id, record);
  }

  async getJournal(id: string): Promise<JournalRecord | null> {
    return this.#journals.get(id) ?? null;
  }

  async patchJournal(id: string, patch: Partial<JournalRecord>): Promise<JournalRecord | null> {
    const existing = this.#journals.get(id);
    if (!existing) return null;
    const updated: JournalRecord = { ...existing, ...patch, id: existing.id };
    this.#journals.set(id, updated);
    return updated;
  }

  async appendOutput(linkId: string, messages: readonly OutputMessage[]): Promise<void> {
    const buffer = this.#output.get(linkId) ?? [];
    buffer.push(...messages);
    if (buffer.length > RETENTION.OUTPUT_PER_LINK) {
      buffer.splice(0, buffer.length - RETENTION.OUTPUT_PER_LINK);
    }
    this.#output.set(linkId, buffer);
  }

  async recentOutput(linkId: string, limit: number): Promise<OutputMessage[]> {
    const buffer = this.#output.get(linkId) ?? [];
    return buffer.slice(Math.max(0, buffer.length - limit));
  }
}
