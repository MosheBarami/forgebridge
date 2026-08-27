/**
 * Standard data stores, v1.
 *
 * Endpoints, verbatim from
 * https://create.roblox.com/docs/reference/cloud/datastores-api/v1 — base
 * `https://apis.roblox.com/datastores`:
 *
 *     GET    /v1/universes/{universeId}/standard-datastores
 *     GET    /v1/universes/{universeId}/standard-datastores/datastore/entries
 *     GET    /v1/universes/{universeId}/standard-datastores/datastore/entries/entry
 *     POST   /v1/universes/{universeId}/standard-datastores/datastore/entries/entry
 *     DELETE /v1/universes/{universeId}/standard-datastores/datastore/entries/entry
 *     POST   /v1/universes/{universeId}/standard-datastores/datastore/entries/entry/increment
 *     GET    /v1/universes/{universeId}/standard-datastores/datastore/entries/entry/versions
 *     GET    /v1/universes/{universeId}/standard-datastores/datastore/entries/entry/versions/version
 *
 * Scopes, per the same reference:
 *
 *     universe-datastores.control:list      list data stores
 *     universe-datastores.objects:list      list entries
 *     universe-datastores.objects:read      read an entry
 *     universe-datastores.objects:create    create an entry
 *     universe-datastores.objects:update    overwrite or increment an entry
 *     universe-datastores.objects:delete    delete an entry
 *     universe-datastores.versions:list     list an entry's versions
 *     universe-datastores.versions:read     read one version
 *
 * ── The two rules this module is built around ────────────────────────────────
 *
 * **A read that cannot be verified is not a read.** `GET …/entry` returns a
 * `content-md5` header alongside the body. When it is present and does not
 * match the bytes that arrived, this client raises rather than returning the
 * value: a silently truncated save file written back on the next tick is worse
 * than an error, and "the checksum did not match" and "there is no checksum"
 * must not produce the same answer. When the header is absent the value is
 * returned with `verified: false` on it, so a caller who cares can tell the two
 * apart — which is the whole point of not conflating them.
 *
 * **A write is never retried on a lost answer.** Every mutating call here is
 * declared non-idempotent to `client.send`, so a transport failure surfaces as
 * a transport failure. `incrementEntry` is the sharp case: retrying it after a
 * lost response double-counts, and a counter that is quietly wrong is the
 * failure nobody finds until the leaderboard is.
 */
import { createHash } from 'node:crypto';
import type { OpenCloudClient, OpenCloudResponse } from './client.js';
import { readJson } from './client.js';
import { OpenCloudError } from './errors.js';
import { assertRobloxId } from './ids.js';

const DATASTORES_BASE = 'datastores/v1/universes';
const ENTRY_PATH = 'standard-datastores/datastore/entries/entry';

export const DATASTORE_SCOPES = {
  listDataStores: 'universe-datastores.control:list',
  listEntries: 'universe-datastores.objects:list',
  readEntry: 'universe-datastores.objects:read',
  createEntry: 'universe-datastores.objects:create',
  updateEntry: 'universe-datastores.objects:update',
  deleteEntry: 'universe-datastores.objects:delete',
  listVersions: 'universe-datastores.versions:list',
  readVersion: 'universe-datastores.versions:read',
} as const;

/**
 * The data store *scope* — the second dimension of a key, defaulting to
 * `global` in the engine API.
 *
 * Named `dataStoreScope` throughout rather than `scope`, because `scope` is
 * already the word this package uses for an API key permission string and
 * confusing the two produces a request that addresses the wrong data.
 */
export interface EntryAddress {
  universeId: number | string;
  dataStoreName: string;
  entryKey: string;
  dataStoreScope?: string;
}

export interface EntryMetadata {
  /** `roblox-entry-version`, the opaque version id of what was returned. */
  version: string | undefined;
  /** `roblox-entry-created-time`, ISO 8601. */
  createdTime: string | undefined;
  /** `roblox-entry-version-created-time`, ISO 8601. */
  versionCreatedTime: string | undefined;
  /** `roblox-entry-attributes`, parsed. Undefined when absent; a parse failure is an error, not an empty object. */
  attributes: Record<string, unknown> | undefined;
  /** `roblox-entry-userids`, parsed. Undefined when absent. */
  userIds: number[] | undefined;
  /**
   * Whether a `content-md5` header was present *and* matched the body.
   *
   * False means the header was absent. A header that was present and did not
   * match never reaches a caller — it throws.
   */
  verified: boolean;
}

export interface EntryResult<T = unknown> {
  value: T;
  /** The stored bytes, before JSON parsing. */
  raw: string;
  metadata: EntryMetadata;
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getEntry<T = unknown>(
  client: OpenCloudClient,
  address: EntryAddress,
): Promise<EntryResult<T>> {
  const universeId = assertRobloxId(address.universeId, 'universeId');
  const operation = `GET /${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}`;
  const response = await client.send({
    operation,
    method: 'GET',
    path: `${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}`,
    query: {
      datastoreName: assertName(address.dataStoreName, 'dataStoreName'),
      entryKey: assertName(address.entryKey, 'entryKey'),
      ...(address.dataStoreScope === undefined ? {} : { scope: address.dataStoreScope }),
    },
    idempotent: true,
  });
  return readEntryResponse<T>(response, operation);
}

export async function getEntryVersion<T = unknown>(
  client: OpenCloudClient,
  address: EntryAddress & { versionId: string },
): Promise<EntryResult<T>> {
  const universeId = assertRobloxId(address.universeId, 'universeId');
  const path = `${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}/versions/version`;
  const operation = `GET /${path}`;
  const response = await client.send({
    operation,
    method: 'GET',
    path,
    query: {
      datastoreName: assertName(address.dataStoreName, 'dataStoreName'),
      entryKey: assertName(address.entryKey, 'entryKey'),
      versionId: assertName(address.versionId, 'versionId'),
      ...(address.dataStoreScope === undefined ? {} : { scope: address.dataStoreScope }),
    },
    idempotent: true,
  });
  return readEntryResponse<T>(response, operation);
}

export interface ListPage<T> {
  items: T[];
  /** `nextPageCursor` from the service, or undefined when this was the last page. */
  cursor: string | undefined;
}

export interface DataStoreSummary {
  name: string;
  createdTime: string | undefined;
}

export async function listDataStores(
  client: OpenCloudClient,
  request: { universeId: number | string; prefix?: string; limit?: number; cursor?: string },
): Promise<ListPage<DataStoreSummary>> {
  const universeId = assertRobloxId(request.universeId, 'universeId');
  const path = `${DATASTORES_BASE}/${universeId}/standard-datastores`;
  const operation = `GET /${path}`;
  const response = await client.send({
    operation,
    method: 'GET',
    path,
    query: {
      ...(request.prefix === undefined ? {} : { prefix: request.prefix }),
      ...(request.limit === undefined ? {} : { limit: assertLimit(request.limit) }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    },
    idempotent: true,
  });
  const body = asRecord(readJson(response, operation), response.status, operation);
  return {
    items: asArray(body['datastores'], response.status, operation).map((entry) => {
      const record = asRecord(entry, response.status, operation);
      return {
        name: asString(record['name'], response.status, operation, 'datastores[].name'),
        createdTime: typeof record['createdTime'] === 'string' ? record['createdTime'] : undefined,
      };
    }),
    cursor: readCursor(body),
  };
}

export async function listEntries(
  client: OpenCloudClient,
  request: {
    universeId: number | string;
    dataStoreName: string;
    dataStoreScope?: string;
    allScopes?: boolean;
    prefix?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<ListPage<{ key: string; dataStoreScope: string | undefined }>> {
  const universeId = assertRobloxId(request.universeId, 'universeId');
  if (request.allScopes === true && request.dataStoreScope !== undefined) {
    // The service rejects this pairing; refusing here says why in one sentence
    // rather than in an error about a query parameter the caller did not write.
    throw new Error('opencloud: listEntries takes either allScopes or a dataStoreScope, not both');
  }
  const path = `${DATASTORES_BASE}/${universeId}/standard-datastores/datastore/entries`;
  const operation = `GET /${path}`;
  const response = await client.send({
    operation,
    method: 'GET',
    path,
    query: {
      datastoreName: assertName(request.dataStoreName, 'dataStoreName'),
      ...(request.dataStoreScope === undefined ? {} : { scope: request.dataStoreScope }),
      ...(request.allScopes === undefined ? {} : { allScopes: request.allScopes }),
      ...(request.prefix === undefined ? {} : { prefix: request.prefix }),
      ...(request.limit === undefined ? {} : { limit: assertLimit(request.limit) }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    },
    idempotent: true,
  });
  const body = asRecord(readJson(response, operation), response.status, operation);
  return {
    items: asArray(body['keys'], response.status, operation).map((entry) => {
      const record = asRecord(entry, response.status, operation);
      return {
        key: asString(record['key'], response.status, operation, 'keys[].key'),
        dataStoreScope: typeof record['scope'] === 'string' ? record['scope'] : undefined,
      };
    }),
    cursor: readCursor(body),
  };
}

export interface EntryVersionSummary {
  version: string;
  createdTime: string | undefined;
  objectCreatedTime: string | undefined;
  deleted: boolean;
  contentLength: number | undefined;
}

export async function listEntryVersions(
  client: OpenCloudClient,
  request: EntryAddress & {
    startTime?: string;
    endTime?: string;
    sortOrder?: 'Ascending' | 'Descending';
    limit?: number;
    cursor?: string;
  },
): Promise<ListPage<EntryVersionSummary>> {
  const universeId = assertRobloxId(request.universeId, 'universeId');
  const path = `${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}/versions`;
  const operation = `GET /${path}`;
  const response = await client.send({
    operation,
    method: 'GET',
    path,
    query: {
      datastoreName: assertName(request.dataStoreName, 'dataStoreName'),
      entryKey: assertName(request.entryKey, 'entryKey'),
      ...(request.dataStoreScope === undefined ? {} : { scope: request.dataStoreScope }),
      ...(request.startTime === undefined ? {} : { startTime: request.startTime }),
      ...(request.endTime === undefined ? {} : { endTime: request.endTime }),
      ...(request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder }),
      ...(request.limit === undefined ? {} : { limit: assertLimit(request.limit) }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    },
    idempotent: true,
  });
  const body = asRecord(readJson(response, operation), response.status, operation);
  return {
    items: asArray(body['versions'], response.status, operation).map((entry) => {
      const record = asRecord(entry, response.status, operation);
      return {
        version: asString(record['version'], response.status, operation, 'versions[].version'),
        createdTime: typeof record['createdTime'] === 'string' ? record['createdTime'] : undefined,
        objectCreatedTime:
          typeof record['objectCreatedTime'] === 'string' ? record['objectCreatedTime'] : undefined,
        deleted: record['deleted'] === true,
        contentLength: typeof record['contentLength'] === 'number' ? record['contentLength'] : undefined,
      };
    }),
    cursor: readCursor(body),
  };
}

// ── writes ───────────────────────────────────────────────────────────────────

export interface SetEntryRequest extends EntryAddress {
  /** Serialised with `JSON.stringify`; the endpoint stores the body verbatim. */
  value: unknown;
  /** Optimistic concurrency: write only if the current version is this one. */
  matchVersion?: string;
  /** Write only if no entry exists. Mutually exclusive with `matchVersion`. */
  exclusiveCreate?: boolean;
  attributes?: Record<string, unknown>;
  /** Roblox user ids this entry is about, for GDPR-style deletion requests. */
  userIds?: readonly number[];
}

export interface SetEntryResult {
  version: string;
  createdTime: string | undefined;
  objectCreatedTime: string | undefined;
}

export async function setEntry(client: OpenCloudClient, request: SetEntryRequest): Promise<SetEntryResult> {
  const universeId = assertRobloxId(request.universeId, 'universeId');
  if (request.exclusiveCreate === true && request.matchVersion !== undefined) {
    throw new Error(
      'opencloud: setEntry takes either exclusiveCreate or matchVersion, not both. ' +
        'They ask for opposite things — "only if absent" and "only if it is exactly this version".',
    );
  }

  const body = JSON.stringify(request.value ?? null);
  const path = `${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}`;
  const operation = `POST /${path}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Documented request header. MD5 here is an integrity check the service
    // specifies, not a security primitive — it is what detects a body truncated
    // in transit before it becomes the saved value of somebody's inventory.
    'content-md5': md5Base64(body),
  };
  if (request.attributes !== undefined) headers['roblox-entry-attributes'] = JSON.stringify(request.attributes);
  if (request.userIds !== undefined) headers['roblox-entry-userids'] = JSON.stringify([...request.userIds]);

  const response = await client.send({
    operation,
    method: 'POST',
    path,
    query: {
      datastoreName: assertName(request.dataStoreName, 'dataStoreName'),
      entryKey: assertName(request.entryKey, 'entryKey'),
      ...(request.dataStoreScope === undefined ? {} : { scope: request.dataStoreScope }),
      ...(request.matchVersion === undefined ? {} : { matchVersion: request.matchVersion }),
      ...(request.exclusiveCreate === undefined ? {} : { exclusiveCreate: request.exclusiveCreate }),
    },
    headers,
    body,
    idempotent: false,
  });

  const parsed = asRecord(readJson(response, operation), response.status, operation);
  return {
    version: asString(parsed['version'], response.status, operation, 'version'),
    createdTime: typeof parsed['createdTime'] === 'string' ? parsed['createdTime'] : undefined,
    objectCreatedTime: typeof parsed['objectCreatedTime'] === 'string' ? parsed['objectCreatedTime'] : undefined,
  };
}

export async function deleteEntry(client: OpenCloudClient, address: EntryAddress): Promise<void> {
  const universeId = assertRobloxId(address.universeId, 'universeId');
  const path = `${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}`;
  await client.send({
    operation: `DELETE /${path}`,
    method: 'DELETE',
    path,
    query: {
      datastoreName: assertName(address.dataStoreName, 'dataStoreName'),
      entryKey: assertName(address.entryKey, 'entryKey'),
      ...(address.dataStoreScope === undefined ? {} : { scope: address.dataStoreScope }),
    },
    // A delete marks the entry deleted; sending it twice is harmless. It is
    // still declared non-idempotent, because "harmless" is a judgement about
    // today's semantics and the retry buys nothing a caller cannot do.
    idempotent: false,
  });
}

export async function incrementEntry(
  client: OpenCloudClient,
  request: EntryAddress & {
    incrementBy: number;
    attributes?: Record<string, unknown>;
    userIds?: readonly number[];
  },
): Promise<EntryResult<number>> {
  const universeId = assertRobloxId(request.universeId, 'universeId');
  if (!Number.isFinite(request.incrementBy)) {
    throw new Error(`opencloud: incrementBy must be a finite number (got ${String(request.incrementBy)})`);
  }
  const path = `${DATASTORES_BASE}/${universeId}/${ENTRY_PATH}/increment`;
  const operation = `POST /${path}`;
  const headers: Record<string, string> = {};
  if (request.attributes !== undefined) headers['roblox-entry-attributes'] = JSON.stringify(request.attributes);
  if (request.userIds !== undefined) headers['roblox-entry-userids'] = JSON.stringify([...request.userIds]);

  const response = await client.send({
    operation,
    method: 'POST',
    path,
    query: {
      datastoreName: assertName(request.dataStoreName, 'dataStoreName'),
      entryKey: assertName(request.entryKey, 'entryKey'),
      incrementBy: request.incrementBy,
      ...(request.dataStoreScope === undefined ? {} : { scope: request.dataStoreScope }),
    },
    headers,
    // NOT idempotent, and this is the call the rule was written for: a retry
    // after a lost answer increments a second time and nothing ever reports it.
    idempotent: false,
  });

  const result = readEntryResponse<unknown>(response, operation);
  if (typeof result.value !== 'number' || !Number.isFinite(result.value)) {
    throw new OpenCloudError({
      kind: 'unreadable',
      operation,
      status: response.status,
      detail: 'increment returned a body that is not a finite number, so the new total is unknown',
    });
  }
  return { value: result.value, raw: result.raw, metadata: result.metadata };
}

// ── response reading ─────────────────────────────────────────────────────────

/**
 * Turn an entry response into a value and its metadata, refusing rather than
 * guessing at every point where the answer is ambiguous.
 */
function readEntryResponse<T>(response: OpenCloudResponse, operation: string): EntryResult<T> {
  const declared = response.headers.get('content-md5');
  let verified = false;
  if (declared !== null && declared.trim() !== '') {
    const actual = md5Base64Bytes(response.bytes);
    if (actual !== declared.trim()) {
      throw new OpenCloudError({
        kind: 'unreadable',
        operation,
        status: response.status,
        detail:
          'the content-md5 header does not match the body that arrived, so the value is not returned. ' +
          'A truncated entry written back on the next save is worse than this error',
      });
    }
    verified = true;
  }

  const value = readJson(response, operation) as T;
  return {
    value,
    raw: response.text,
    metadata: {
      version: header(response, 'roblox-entry-version'),
      createdTime: header(response, 'roblox-entry-created-time'),
      versionCreatedTime: header(response, 'roblox-entry-version-created-time'),
      attributes: parseHeaderJson(response, 'roblox-entry-attributes', operation, isRecord),
      userIds: parseHeaderJson(response, 'roblox-entry-userids', operation, isNumberArray),
      verified,
    },
  };
}

function header(response: OpenCloudResponse, name: string): string | undefined {
  const value = response.headers.get(name);
  return value === null || value.trim() === '' ? undefined : value;
}

/**
 * A metadata header that is present and unparseable is an error, not an absent
 * header. The two mean different things — "this entry is about no users" and
 * "this entry's user list could not be read" — and a GDPR deletion sweep that
 * treats the second as the first deletes nothing and reports success.
 */
function parseHeaderJson<T>(
  response: OpenCloudResponse,
  name: string,
  operation: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const raw = header(response, name);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new OpenCloudError({
      kind: 'unreadable',
      operation,
      status: response.status,
      detail: `the ${name} header is present and is not JSON`,
      cause,
    });
  }
  if (!guard(parsed)) {
    throw new OpenCloudError({
      kind: 'unreadable',
      operation,
      status: response.status,
      detail: `the ${name} header is present and is not the documented shape`,
    });
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function readCursor(body: Record<string, unknown>): string | undefined {
  const cursor = body['nextPageCursor'];
  return typeof cursor === 'string' && cursor !== '' ? cursor : undefined;
}

function asRecord(value: unknown, status: number, operation: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new OpenCloudError({ kind: 'unreadable', operation, status, detail: 'expected a JSON object' });
}

function asArray(value: unknown, status: number, operation: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new OpenCloudError({ kind: 'unreadable', operation, status, detail: 'expected a JSON array' });
}

function asString(value: unknown, status: number, operation: string, field: string): string {
  if (typeof value === 'string' && value !== '') return value;
  throw new OpenCloudError({ kind: 'unreadable', operation, status, detail: `expected a string at ${field}` });
}

function assertName(value: string, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`opencloud: ${field} must be a non-empty string`);
  }
  return value;
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`opencloud: limit must be a positive integer (got ${String(limit)})`);
  }
  return limit;
}

/** Base64 of the MD5 digest, which is what `content-md5` is defined to carry. */
export function md5Base64(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('base64');
}

function md5Base64Bytes(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('base64');
}
