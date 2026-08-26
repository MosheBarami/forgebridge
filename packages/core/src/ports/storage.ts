import type {
  ApplyResult,
  ChangeSet,
  ChangeSetStatus,
  JournalEntry,
  Link,
  ModelAttempt,
  Run,
} from '@forgebridge/protocol';
import type { ProjectPolicy } from '../policy.js';

/**
 * Storage port — the same domain surface over SQLite and over Supabase (ADR-005).
 *
 * Three rules shaped every signature below, and breaking any of them breaks one
 * of the two adapters:
 *
 * 1. **No interactive transactions.** The Supabase adapter is an HTTP client;
 *    it cannot hold a transaction open across two calls. So every operation that
 *    must be atomic is one named method an adapter can implement as a single
 *    statement (`append`, `setStatus` with an expected value), never a
 *    read-then-write the caller is trusted to get right.
 * 2. **No Postgres-only constructs.** No `LISTEN/NOTIFY` (realtime lives behind
 *    the transport port), no jsonb operators, no `RETURNING`-dependent control
 *    flow, no RLS as authorisation — authorisation is the core's job, and RLS is
 *    defence in depth behind it.
 * 3. **No OFFSET paging.** It is O(n) in SQLite and unstable under concurrent
 *    inserts in both. Listings are keyset-paged through an opaque cursor the
 *    adapter defines.
 *
 * Values crossing this port are already-parsed protocol types. Adapters
 * serialise; they do not validate, and they do not reshape.
 */

export interface PageRequest {
  limit: number;
  /** Opaque, adapter-defined. Callers pass back what the previous page returned. */
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  /** Null when the listing is exhausted. */
  nextCursor: string | null;
}

export interface ProjectRecord {
  id: string;
  /** Null in signed-out mode. Optional auth is a first-class mode, not a fallback (ADR-005). */
  ownerId: string | null;
  name: string;
  placeId: number | null;
  createdAt: string;
}

export interface ProjectStore {
  get(projectId: string): Promise<ProjectRecord | null>;
  create(project: ProjectRecord): Promise<void>;
  rename(projectId: string, name: string): Promise<void>;
  list(ownerId: string | null, page: PageRequest): Promise<Page<ProjectRecord>>;
  delete(projectId: string): Promise<void>;
}

/**
 * The place tree as the consumer last reported it.
 *
 * `instances` is opaque to the core on purpose — the same reasoning as the
 * protocol's `restoreSubtree`: the core has no business understanding a Roblox
 * model format, and a format change must not require a core release.
 */
export interface TreeSnapshot {
  projectId: string;
  version: number;
  instances: unknown;
  capturedAt: string;
}

export interface TreeStore {
  /** The version a ChangeSet must declare as its `baseVersion`. Zero for a project no consumer has read yet. */
  currentVersion(projectId: string): Promise<number>;
  get(projectId: string, version?: number): Promise<TreeSnapshot | null>;
  /**
   * Compare-and-set append. Stores `instances` at `expectedVersion + 1` and
   * returns the new version; resolves to `null` when `expectedVersion` is not
   * the current version, which the caller reports as `stale_base`. There is no
   * last-write-wins path here, by construction rather than by convention.
   */
  append(
    projectId: string,
    expectedVersion: number,
    instances: unknown,
    capturedAt: string,
  ): Promise<number | null>;
  /**
   * Record that the consumer reports being at `version` after an apply.
   *
   * Distinct from `append` because it is a weaker claim: the consumer told us a
   * version number, not a tree. Reading the tree back is a separate round trip,
   * and until it happens `get()` will return an older snapshot than
   * `currentVersion()` names. Saying so plainly beats storing an invented tree.
   */
  recordConsumerVersion(projectId: string, version: number, at: string): Promise<void>;
}

/** The mutable part of a run. `prompt`, `projectId`, and `startedAt` never change. */
export interface RunPatch {
  stage?: Run['stage'];
  status?: Run['status'];
  /**
   * Replaced whole, never appended to. Array-append semantics differ between the
   * two backends, and the core holds the authoritative list in memory for the
   * life of the run anyway.
   */
  attempts?: ModelAttempt[];
  changeSetIds?: string[];
  finishedAt?: string | null;
}

export interface RunStore {
  create(run: Run): Promise<void>;
  get(runId: string): Promise<Run | null>;
  patch(runId: string, patch: RunPatch): Promise<void>;
  listByProject(projectId: string, page: PageRequest): Promise<Page<Run>>;
}

export interface ChangeSetStore {
  save(set: ChangeSet): Promise<void>;
  get(changeSetId: string): Promise<ChangeSet | null>;
  /**
   * Compare-and-set on status. Returns false when the stored status was not
   * `expected` — which is how a double-approve or a double-apply is refused
   * even when two producers race. A plain `setStatus` would make that race
   * silently destructive.
   */
  setStatus(changeSetId: string, next: ChangeSetStatus, expected: ChangeSetStatus): Promise<boolean>;
  /** What the consumer reported back. Kept whole; a partial apply is evidence. */
  recordApplyResult(changeSetId: string, result: ApplyResult): Promise<void>;
  getApplyResult(changeSetId: string): Promise<ApplyResult | null>;
  listByRun(runId: string): Promise<ChangeSet[]>;
}

export interface JournalStore {
  save(entry: JournalEntry): Promise<void>;
  get(journalId: string): Promise<JournalEntry | null>;
  listByProject(projectId: string, page: PageRequest): Promise<Page<JournalEntry>>;
  markRolledBack(journalId: string, at: string): Promise<void>;
  /**
   * Retention (ADR-012): a delete's inverse carries the whole removed subtree,
   * so journals are the one entity that grows without bound. Returns how many
   * entries were removed.
   */
  prune(projectId: string, keepMostRecent: number): Promise<number>;
}

export interface LinkStore {
  getByProject(projectId: string): Promise<Link | null>;
  get(linkId: string): Promise<Link | null>;
  save(link: Link): Promise<void>;
  setState(linkId: string, state: Link['state']): Promise<void>;
  touch(linkId: string, lastSeenAt: string): Promise<void>;
}

export interface PolicyStore {
  /**
   * Null when the project has never had a policy written. The core treats that
   * as deny-all rather than allow-all — see `DENY_ALL_POLICY`.
   */
  get(projectId: string): Promise<ProjectPolicy | null>;
  set(projectId: string, policy: ProjectPolicy): Promise<void>;
}

/**
 * Scoped key/value. Values are strings so both backends store one TEXT column;
 * callers that want structure JSON-encode it themselves. Scope is a free string
 * (`user:<id>`, `project:<id>`, `install`) rather than an enum, because settings
 * outlive any enum the core would guess today.
 */
export interface SettingsStore {
  get(scope: string, key: string): Promise<string | null>;
  set(scope: string, key: string, value: string): Promise<void>;
  delete(scope: string, key: string): Promise<void>;
  list(scope: string): Promise<Record<string, string>>;
}

/**
 * `inventory_item` and `game_map_node` from the architecture's entity list are
 * deliberately absent: they are product-surface state (M36, M37) that the engine
 * never reads. Adapters still own those tables; the core just has no opinion
 * about them, and a port method nothing calls is a port method that rots.
 */
export interface StoragePort {
  projects: ProjectStore;
  trees: TreeStore;
  runs: RunStore;
  changeSets: ChangeSetStore;
  journal: JournalStore;
  links: LinkStore;
  policies: PolicyStore;
  settings: SettingsStore;
}
