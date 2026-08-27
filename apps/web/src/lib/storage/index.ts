import { IndexedDbStorage } from './indexeddb';
import type { StoragePort } from './port';

export { COLLECTIONS, StorageUnavailableError } from './port';
export type { Collection, StoragePort, StoredRecord } from './port';
export { IndexedDbStorage } from './indexeddb';

/**
 * Which adapter this build uses.
 *
 * There is exactly one today and it needs no account. The signature is a
 * function rather than a constant so that M33 can make the choice — local
 * versus remote — without every call site changing shape when it does.
 *
 * TODO(M33): return a Supabase-backed `StoragePort` when a session exists. The
 * rule that migration has to honour is in ADR-005 and in this app's README:
 * signing in **adopts** what the local adapter holds, it never silently
 * replaces it. A user who built three projects signed out and finds an empty
 * account afterwards has been robbed by a feature.
 */
export function createStorage(): StoragePort {
  return new IndexedDbStorage();
}
