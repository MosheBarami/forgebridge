/**
 * The Storage port, browser side (ADR-005).
 *
 * "Auth is optional" is a structural claim or it is nothing. A codebase that
 * reaches for a Supabase client and sprinkles `if (user)` around it has an
 * account requirement with holes in it, not an optional account — and within a
 * month the holes leak. So storage is a port with two adapters, the same domain
 * code runs over both, and signed-out is the one that ships first.
 *
 * What this port deliberately does NOT do:
 *
 *   - It never carries a credential. Not as a parameter, not as a return value,
 *     not as a field on a record it stores. That is rule K2 of
 *     `npm run verify:no-key-storage`, and it is why the daemon's producer
 *     token lives in memory in `lib/daemon/session.tsx` instead of here.
 *   - It offers no query language. The lowest common denominator between
 *     IndexedDB and Postgres is get / list / put / delete, and a port that
 *     promises more is a port whose local adapter quietly becomes a fake peer
 *     (ADR-005's own revisit trigger).
 *
 * TODO(M33): the Supabase adapter. Signing in must *adopt* whatever the local
 * adapter already holds rather than replacing it — a user who built three
 * projects signed out and then signs in must still have three projects. That
 * migration is M33's job; the shape of it is why this interface exposes `list`
 * on every collection.
 */

/**
 * The collections this app persists.
 *
 * A closed union rather than an open string: an object store IndexedDB has
 * never heard of fails at open time, and a typo would otherwise be a silently
 * empty list. Adding one means adding it here and bumping `SCHEMA_VERSION` in
 * the adapter, which is the intended friction.
 */
export const COLLECTIONS = ['projects', 'settings', 'changesets', 'runs', 'journal'] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** The minimum every stored record carries, so `list` can order without a schema. */
export interface StoredRecord {
  readonly id: string;
  /** ISO-8601. Written by the adapter on every `put`, never by the caller. */
  readonly updatedAt: string;
}

export interface StoragePort {
  /**
   * Which adapter this is.
   *
   * Surfaced rather than hidden: the shell tells the user where their work
   * lives ("in this browser" versus "in your account"), and a user who cannot
   * tell cannot make an informed choice about signing in.
   */
  readonly kind: 'local' | 'remote';

  get<T extends StoredRecord>(collection: Collection, id: string): Promise<T | null>;
  /** Newest first. */
  list<T extends StoredRecord>(collection: Collection): Promise<T[]>;
  put<T extends StoredRecord>(collection: Collection, record: Omit<T, 'updatedAt'>): Promise<T>;
  delete(collection: Collection, id: string): Promise<void>;
  clear(collection: Collection): Promise<void>;
  /** Everything this adapter holds, for the export half of M34 and for M33's adoption. */
  exportAll(): Promise<Record<Collection, StoredRecord[]>>;
}

/**
 * Storage can be genuinely unavailable — a private window with IndexedDB
 * disabled, a browser with site data blocked, a quota that is full. That is a
 * state the UI must be able to describe, so it is an error type rather than a
 * bare throw.
 */
export class StorageUnavailableError extends Error {
  constructor(
    override readonly cause: unknown,
    message = 'browser storage is not available',
  ) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}
