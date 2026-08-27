import {
  COLLECTIONS,
  StorageUnavailableError,
  type Collection,
  type StoragePort,
  type StoredRecord,
} from './port';

/**
 * The local adapter: IndexedDB, no account, no network.
 *
 * IndexedDB rather than `localStorage` for two reasons that both matter here. A
 * ChangeSet is capped at 8 MiB by the protocol and a place tree is larger
 * still, which is past what `localStorage` will hold; and `localStorage` is
 * synchronous, so reading a project would block the frame that is rendering a
 * diff. No wrapper library — the surface below is five operations, and the
 * promise-shim is thirty lines of it.
 */

const DB_NAME = 'forgebridge';

/**
 * Bumped whenever `COLLECTIONS` gains a member. IndexedDB creates object stores
 * only inside an `upgradeneeded` transaction, so a new collection without a new
 * version is a store that does not exist and a `NotFoundError` at first use.
 */
const SCHEMA_VERSION = 1;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageUnavailableError(undefined, 'this browser exposes no IndexedDB'));
      return;
    }

    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const collection of COLLECTIONS) {
        if (!db.objectStoreNames.contains(collection)) {
          db.createObjectStore(collection, { keyPath: 'id' });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StorageUnavailableError(request.error));

    /**
     * Fires when another tab holds the database open at an older version. The
     * user has two tabs of this app and one of them is stale; blocking forever
     * would look like a hang, so it is reported as unavailable and the UI can
     * say "close the other tab".
     */
    request.onblocked = () =>
      reject(
        new StorageUnavailableError(
          undefined,
          'another tab is holding an older version of the local database open',
        ),
      );
  });
}

export class IndexedDbStorage implements StoragePort {
  readonly kind = 'local' as const;

  #db: Promise<IDBDatabase> | undefined;

  #database(): Promise<IDBDatabase> {
    // Opened lazily and once. Opening in the constructor would make merely
    // constructing the adapter — which a provider does during render — touch
    // the disk, and would throw on the server where `indexedDB` is undefined.
    this.#db ??= openDatabase();
    return this.#db;
  }

  async #transaction<T>(
    collection: Collection,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.#database();
    const tx = db.transaction(collection, mode);
    const result = await run(tx.objectStore(collection));
    // Wait for the transaction itself, not just the request: a `put` whose
    // request succeeded inside a transaction that later aborts (quota, for
    // instance) did not persist, and returning before commit would report a
    // write that did not happen.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new StorageUnavailableError(tx.error, 'the write was rolled back'));
      tx.onerror = () => reject(new StorageUnavailableError(tx.error));
    });
    return result;
  }

  async get<T extends StoredRecord>(collection: Collection, id: string): Promise<T | null> {
    return this.#transaction(collection, 'readonly', async (store) => {
      const found = await promisify<unknown>(store.get(id));
      return (found ?? null) as T | null;
    });
  }

  async list<T extends StoredRecord>(collection: Collection): Promise<T[]> {
    return this.#transaction(collection, 'readonly', async (store) => {
      const all = (await promisify<unknown[]>(store.getAll())) as T[];
      return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  async put<T extends StoredRecord>(
    collection: Collection,
    record: Omit<T, 'updatedAt'>,
  ): Promise<T> {
    // `updatedAt` is stamped here rather than accepted from the caller, so
    // ordering in `list` reflects when this store was written and not what a
    // producer claimed about its own clock.
    const stamped = { ...record, updatedAt: new Date().toISOString() } as T;
    await this.#transaction(collection, 'readwrite', async (store) => {
      await promisify(store.put(stamped));
    });
    return stamped;
  }

  async delete(collection: Collection, id: string): Promise<void> {
    await this.#transaction(collection, 'readwrite', async (store) => {
      await promisify(store.delete(id));
    });
  }

  async clear(collection: Collection): Promise<void> {
    await this.#transaction(collection, 'readwrite', async (store) => {
      await promisify(store.clear());
    });
  }

  async exportAll(): Promise<Record<Collection, StoredRecord[]>> {
    const entries = await Promise.all(
      COLLECTIONS.map(async (collection) => [collection, await this.list(collection)] as const),
    );
    return Object.fromEntries(entries) as Record<Collection, StoredRecord[]>;
  }
}
