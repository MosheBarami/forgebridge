/**
 * The browser key vault — ADR-006's "browser without daemon" row, built.
 *
 * A provider credential the user types on this page is sealed with AES-GCM
 * under a **non-extractable** WebCrypto key and the ciphertext is written to
 * IndexedDB. Four properties follow, and each one is a property of the code
 * rather than a promise about it:
 *
 * 1. **The sealing key cannot leave the browser.** It is generated with
 *    `extractable: false`, so `crypto.subtle.exportKey` on it rejects. Script
 *    running on this origin — ours, or an injected one — can *use* it to
 *    decrypt, but cannot obtain it, cannot copy it to another origin, and
 *    cannot put it in a request body. XSS is not stopped by this; nothing in a
 *    browser stops XSS. What it stops is the key at rest being readable.
 *
 * 2. **Nothing here reaches an app route.** This module makes no network call
 *    of any kind. `apps/web` ships no route handler, and there is nothing for
 *    a credential to be POSTed to — which is what makes ADR-006 structural
 *    rather than a policy, and what `npm run verify:no-key-storage` checks the
 *    declaration-level half of.
 *
 * 3. **It is a separate database from the Storage port.** Rule K2: a
 *    `StoragePort` that can carry a credential will eventually be handed one.
 *    So the vault does not use it — different database, different code path,
 *    and no shape shared between them.
 *
 * 4. **The only way out is `unseal`**, which returns the plaintext to exactly
 *    one caller: the code that is about to hand it to the local daemon over
 *    loopback. It is never rendered, never logged, and never put in a URL. What
 *    the UI shows instead is `hint` — the last four characters — which is the
 *    same affordance every provider console offers and is not a credential.
 *
 * ── What does not work yet, stated plainly ───────────────────────────────────
 *
 * The daemon has **no route that accepts a provider credential**. It reads one
 * from the environment or the OS keychain through `SecretsPort`
 * (`packages/daemon/src/secrets.ts`), and both backends are read-only. So a
 * credential sealed here cannot start a run today: the egress does not exist.
 *
 * That is why `settings/keys` leads with the keychain and the environment
 * variable — the paths that work — and presents this vault as the one that will
 * carry a credential to the daemon once the daemon can take one. Building the
 * vault now is not premature: it is the half that must not be improvised later,
 * under time pressure, by someone who reaches for `localStorage`.
 *
 * TODO(M24): the loopback hand-off. It needs a daemon route that accepts a
 * credential for the life of one run and never stores it — the daemon's own
 * K4 rule — and it needs this module to be its only caller. Owner: whoever
 * wires the first browser BYOK path (ADR-006's own revisit note).
 */

const DB_NAME = 'forgebridge-keys';
const DB_VERSION = 1;

/** Ciphertext records, keyed by provider. */
const SEALED_STORE = 'sealed';
/** The non-extractable sealing key, stored out-of-line under one fixed key. */
const SEALER_STORE = 'sealer';
const SEALER_ID = 'v1';

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
/** 96 bits — the IV length AES-GCM is specified and analysed for. */
const IV_BYTES = 12;

/** Providers a credential can be held for. Closed: an unknown id is a typo. */
export const VAULT_PROVIDERS = ['openrouter'] as const;
export type VaultProvider = (typeof VAULT_PROVIDERS)[number];

/** How the credential got here. Shown, because "you signed in" and "you pasted it" differ. */
export type VaultSource = 'pasted' | 'oauth';

/**
 * The record on disk. No field here is credential-shaped, and that is not a
 * naming trick: `sealed` genuinely is not a credential without the sealing key,
 * and the sealing key genuinely cannot be exported.
 */
interface SealedRecord {
  readonly providerId: VaultProvider;
  readonly sealed: ArrayBuffer;
  /*
   * `Uint8Array<ArrayBuffer>`, not the bare `Uint8Array`, whose buffer type is
   * `ArrayBufferLike` and so admits a `SharedArrayBuffer` that `crypto.subtle`
   * will not accept as a `BufferSource`. The IV here is always a plain buffer —
   * `getRandomValues` allocates one and IndexedDB structured-clones it back the
   * same way — so the narrower type is the true one, and it keeps `unseal` from
   * needing a cast to hand the IV back to WebCrypto.
   */
  readonly iv: Uint8Array<ArrayBuffer>;
  /** Last four characters of the plaintext. Not usable; shown so the user can tell which one this is. */
  readonly hint: string;
  readonly source: VaultSource;
  readonly createdAt: string;
}

/** What a surface may know about a held credential. Never the value. */
export interface VaultEntry {
  readonly providerId: VaultProvider;
  readonly hint: string;
  readonly source: VaultSource;
  readonly createdAt: string;
}

/**
 * Why the vault cannot operate here.
 *
 * `insecure-context` is the one worth naming separately. `crypto.subtle` is
 * undefined outside a secure context, so on an origin served over plain HTTP
 * that is not localhost there is no encryption available at all — and the
 * honest response is to refuse the credential rather than to store it in the
 * clear and call the panel "the vault".
 */
export type VaultUnavailable =
  | { readonly reason: 'server' }
  | { readonly reason: 'insecure-context' }
  | { readonly reason: 'no-indexeddb' }
  | { readonly reason: 'blocked'; readonly detail: string };

export class VaultUnavailableError extends Error {
  /*
   * `override`: `Error` itself declares `cause` (as `unknown`) since ES2022, so
   * this parameter property is a narrowing of an inherited member rather than a
   * new one, and TypeScript wants that said out loud.
   */
  constructor(override readonly cause: VaultUnavailable) {
    super(`key vault unavailable: ${cause.reason}`);
    this.name = 'VaultUnavailableError';
  }
}

/** Why the vault cannot run, or null when it can. Cheap; safe to call in render. */
export function vaultAvailability(): VaultUnavailable | null {
  if (typeof window === 'undefined') return { reason: 'server' };
  // `isSecureContext` rather than a protocol check: it is already true for
  // `http://localhost` and `http://127.0.0.1`, which is where this app runs
  // during development and where a self-hoster may keep it permanently.
  if (!window.isSecureContext || typeof crypto === 'undefined' || !crypto.subtle) {
    return { reason: 'insecure-context' };
  }
  if (typeof indexedDB === 'undefined') return { reason: 'no-indexeddb' };
  return null;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SEALED_STORE)) {
        db.createObjectStore(SEALED_STORE, { keyPath: 'providerId' });
      }
      // Out-of-line keys: the value is a `CryptoKey`, which has no properties
      // of its own to use as a keyPath and must not be wrapped in an object
      // that invites someone to add a second field beside it.
      if (!db.objectStoreNames.contains(SEALER_STORE)) db.createObjectStore(SEALER_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new VaultUnavailableError({
          reason: 'blocked',
          detail: request.error?.message ?? 'the browser refused to open the vault database',
        }),
      );
    request.onblocked = () =>
      reject(
        new VaultUnavailableError({
          reason: 'blocked',
          detail: 'another tab is holding an older version of the vault database open',
        }),
      );
  });
}

/**
 * Opened lazily and once. A connection per operation would ask the browser to
 * reopen the database for every read, and would raise `onblocked` against
 * itself the moment two calls overlapped.
 */
let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  connection ??= openDatabase().catch((error: unknown) => {
    // A failed open must not be cached as a permanently broken vault: the user
    // may close the tab that blocked it and try again.
    connection = undefined;
    throw error;
  });
  return connection;
}

async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const unavailable = vaultAvailability();
  if (unavailable) throw new VaultUnavailableError(unavailable);

  const db = await database();
  const tx = db.transaction(store, mode);
  const result = await run(tx.objectStore(store));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        new VaultUnavailableError({
          reason: 'blocked',
          detail: tx.error?.message ?? 'the write was rolled back',
        }),
      );
    tx.onerror = () =>
      reject(
        new VaultUnavailableError({
          reason: 'blocked',
          detail: tx.error?.message ?? 'the vault write failed',
        }),
      );
  });
  return result;
}

/**
 * The sealing key: generated once, non-extractable, reused thereafter.
 *
 * Stored rather than derived from a passphrase because there is no passphrase —
 * asking for one would be a second secret for the user to lose, and losing it
 * would mean losing the credential it protects for no gain against the threat
 * this actually addresses (a copy of the profile directory, another origin,
 * a devtools reader). Against script already running on this origin, no scheme
 * that can decrypt without user interaction helps.
 */
async function sealingKey(): Promise<CryptoKey> {
  const existing = await transact(SEALER_STORE, 'readonly', async (store) =>
    promisify<unknown>(store.get(SEALER_ID)),
  );
  if (existing) return existing as CryptoKey;

  const generated = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    // The whole point. `exportKey` on this rejects, in every browser, forever.
    false,
    ['encrypt', 'decrypt'],
  );
  await transact(SEALER_STORE, 'readwrite', async (store) => {
    await promisify(store.put(generated, SEALER_ID));
  });
  return generated;
}

/** The last four characters. Fewer than a provider console shows, and not a credential. */
function hintOf(value: string): string {
  return value.length <= 4 ? '••••' : value.slice(-4);
}

/**
 * Seal a credential the user entered.
 *
 * The plaintext is a parameter and a local, and it reaches exactly one call:
 * `crypto.subtle.encrypt`. It is not returned, not stored, not logged, and the
 * caller is expected to drop its own copy — `key-vault.tsx` clears the input on
 * submit for that reason.
 */
export async function seal(
  providerId: VaultProvider,
  entered: string,
  source: VaultSource,
): Promise<VaultEntry> {
  const trimmed = entered.trim();
  if (trimmed.length === 0) throw new Error('nothing to seal');

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    await sealingKey(),
    new TextEncoder().encode(trimmed),
  );

  const record: SealedRecord = {
    providerId,
    sealed,
    iv,
    hint: hintOf(trimmed),
    source,
    createdAt: new Date().toISOString(),
  };
  await transact(SEALED_STORE, 'readwrite', async (store) => {
    await promisify(store.put(record));
  });

  return { providerId, hint: record.hint, source, createdAt: record.createdAt };
}

/** What is held, without what is held. Safe to render. */
export async function listEntries(): Promise<VaultEntry[]> {
  const records = await transact(SEALED_STORE, 'readonly', async (store) =>
    promisify<unknown[]>(store.getAll()),
  );
  return (records as SealedRecord[]).map((record) => ({
    providerId: record.providerId,
    hint: record.hint,
    source: record.source,
    createdAt: record.createdAt,
  }));
}

/**
 * The plaintext, for the one caller that needs it.
 *
 * There is no such caller yet — see TODO(M24) at the top of this file. It is
 * exported now so that when the loopback hand-off is written, the person
 * writing it does not have to invent a way out of the vault under deadline; the
 * way out exists, it is narrow, and it is documented as the only one.
 */
export async function unseal(providerId: VaultProvider): Promise<string | null> {
  const record = (await transact(SEALED_STORE, 'readonly', async (store) =>
    promisify<unknown>(store.get(providerId)),
  )) as SealedRecord | undefined;
  if (!record) return null;

  const plain = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: record.iv },
    await sealingKey(),
    record.sealed,
  );
  return new TextDecoder().decode(plain);
}

/**
 * Forget a credential.
 *
 * The ciphertext record is deleted; the sealing key is left alone, because it
 * still seals whatever else the vault holds. `forgetEverything` is the one that
 * removes the key as well, and it is what the "remove everything" control on
 * the keys surface calls — a user who asks to be forgotten should not have a
 * usable sealing key left behind for the next credential to be sealed under.
 */
export async function forget(providerId: VaultProvider): Promise<void> {
  await transact(SEALED_STORE, 'readwrite', async (store) => {
    await promisify(store.delete(providerId));
  });
}

export async function forgetEverything(): Promise<void> {
  await transact(SEALED_STORE, 'readwrite', async (store) => {
    await promisify(store.clear());
  });
  await transact(SEALER_STORE, 'readwrite', async (store) => {
    await promisify(store.clear());
  });
}
