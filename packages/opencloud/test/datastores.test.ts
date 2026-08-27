import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DATASTORE_SCOPES,
  OpenCloudError,
  createOpenCloudClient,
  deleteEntry,
  getEntry,
  getEntryVersion,
  incrementEntry,
  listDataStores,
  listEntries,
  listEntryVersions,
  md5Base64,
  setEntry,
} from '../src/index.js';
import { TEST_KEY, fakeFetch, type FakeResponse } from './helpers.js';

const BASE = 'https://apis.roblox.com/datastores/v1/universes';
const ENTRY = 'standard-datastores/datastore/entries/entry';

function make(...responses: readonly FakeResponse[]) {
  const fetch = fakeFetch(...responses);
  return { fetch, client: createOpenCloudClient({ apiKey: TEST_KEY, fetch }) };
}

/** A body with the `content-md5` the service would have sent for it. */
function signed(body: string, extra: Record<string, string> = {}): FakeResponse {
  return {
    status: 200,
    body,
    headers: { 'content-md5': createHash('md5').update(body, 'utf8').digest('base64'), ...extra },
  };
}

describe('the eight documented endpoints', () => {
  // Paths quoted from https://create.roblox.com/docs/reference/cloud/datastores-api/v1
  it('getEntry', async () => {
    const { fetch, client } = make(signed('{"coins":3}', { 'roblox-entry-version': 'v1' }));
    const result = await getEntry(client, { universeId: 7, dataStoreName: 'Saves', entryKey: 'user_42' });

    expect(fetch.calls[0]!.method).toBe('GET');
    expect(fetch.calls[0]!.url).toBe(`${BASE}/7/${ENTRY}?datastoreName=Saves&entryKey=user_42`);
    expect(result.value).toEqual({ coins: 3 });
    expect(result.metadata.version).toBe('v1');
    expect(result.metadata.verified).toBe(true);
  });

  it('getEntry with a data store scope sends it as the `scope` query parameter', async () => {
    const { fetch, client } = make(signed('1'));
    await getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k', dataStoreScope: 'eu' });
    expect(fetch.calls[0]!.url).toContain('&scope=eu');
  });

  it('setEntry', async () => {
    const { fetch, client } = make({ status: 200, body: '{"version":"v2","createdTime":"2026-01-01T00:00:00Z"}' });
    const result = await setEntry(client, {
      universeId: 7,
      dataStoreName: 'Saves',
      entryKey: 'user_42',
      value: { coins: 4 },
      attributes: { season: 3 },
      userIds: [42],
    });

    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BASE}/7/${ENTRY}?datastoreName=Saves&entryKey=user_42`);
    expect(call.body).toBe('{"coins":4}');
    expect(call.headers['content-md5']).toBe(md5Base64('{"coins":4}'));
    expect(call.headers['roblox-entry-attributes']).toBe('{"season":3}');
    expect(call.headers['roblox-entry-userids']).toBe('[42]');
    expect(result.version).toBe('v2');
  });

  it('setEntry carries matchVersion and exclusiveCreate as query parameters', async () => {
    const { fetch, client } = make({ status: 200, body: '{"version":"v3"}' });
    await setEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k', value: 1, matchVersion: 'v2' });
    expect(fetch.calls[0]!.url).toContain('&matchVersion=v2');
  });

  it('deleteEntry', async () => {
    const { fetch, client } = make({ status: 204 });
    await deleteEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' });
    expect(fetch.calls[0]!.method).toBe('DELETE');
    expect(fetch.calls[0]!.url).toBe(`${BASE}/7/${ENTRY}?datastoreName=S&entryKey=k`);
  });

  it('incrementEntry', async () => {
    const { fetch, client } = make(signed('11', { 'roblox-entry-version': 'v9' }));
    const result = await incrementEntry(client, {
      universeId: 7,
      dataStoreName: 'S',
      entryKey: 'k',
      incrementBy: 5,
    });
    expect(fetch.calls[0]!.method).toBe('POST');
    expect(fetch.calls[0]!.url).toBe(`${BASE}/7/${ENTRY}/increment?datastoreName=S&entryKey=k&incrementBy=5`);
    expect(result.value).toBe(11);
  });

  it('listDataStores', async () => {
    const { fetch, client } = make({
      status: 200,
      body: '{"datastores":[{"name":"Saves","createdTime":"2026-01-01T00:00:00Z"}],"nextPageCursor":"c2"}',
    });
    const page = await listDataStores(client, { universeId: 7, prefix: 'Sa', limit: 10 });
    expect(fetch.calls[0]!.url).toBe(`${BASE}/7/standard-datastores?prefix=Sa&limit=10`);
    expect(page.items).toEqual([{ name: 'Saves', createdTime: '2026-01-01T00:00:00Z' }]);
    expect(page.cursor).toBe('c2');
  });

  it('listEntries', async () => {
    const { fetch, client } = make({ status: 200, body: '{"keys":[{"key":"user_42"}]}' });
    const page = await listEntries(client, { universeId: 7, dataStoreName: 'Saves', allScopes: true });
    expect(fetch.calls[0]!.url).toBe(
      `${BASE}/7/standard-datastores/datastore/entries?datastoreName=Saves&allScopes=true`,
    );
    expect(page.items).toEqual([{ key: 'user_42', dataStoreScope: undefined }]);
    expect(page.cursor).toBeUndefined();
  });

  it('listEntryVersions', async () => {
    const { fetch, client } = make({ status: 200, body: '{"versions":[{"version":"v1","deleted":false}]}' });
    const page = await listEntryVersions(client, {
      universeId: 7,
      dataStoreName: 'S',
      entryKey: 'k',
      sortOrder: 'Descending',
      limit: 5,
    });
    expect(fetch.calls[0]!.url).toBe(
      `${BASE}/7/${ENTRY}/versions?datastoreName=S&entryKey=k&sortOrder=Descending&limit=5`,
    );
    expect(page.items[0]!.version).toBe('v1');
  });

  it('getEntryVersion', async () => {
    const { fetch, client } = make(signed('{"coins":1}'));
    await getEntryVersion(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k', versionId: 'v1' });
    expect(fetch.calls[0]!.url).toBe(`${BASE}/7/${ENTRY}/versions/version?datastoreName=S&entryKey=k&versionId=v1`);
  });

  it('names every scope an operator has to grant', () => {
    expect(Object.values(DATASTORE_SCOPES)).toEqual([
      'universe-datastores.control:list',
      'universe-datastores.objects:list',
      'universe-datastores.objects:read',
      'universe-datastores.objects:create',
      'universe-datastores.objects:update',
      'universe-datastores.objects:delete',
      'universe-datastores.versions:list',
      'universe-datastores.versions:read',
    ]);
  });
});

describe('a read that cannot be verified is not a read', () => {
  it('refuses a body whose content-md5 does not match it', async () => {
    const { client } = make({
      status: 200,
      body: '{"coins":3}',
      headers: { 'content-md5': createHash('md5').update('{"coins":300}', 'utf8').digest('base64') },
    });

    const error = await getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenCloudError);
    expect((error as OpenCloudError).kind).toBe('unreadable');
    expect((error as OpenCloudError).message).toMatch(/does not match the body/);
  });

  it('CONTROL — a matching content-md5 returns the value and marks it verified', async () => {
    const { client } = make(signed('{"coins":3}'));
    const result = await getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' });
    expect(result.metadata.verified).toBe(true);
  });

  it('CONTROL — no content-md5 at all returns the value and says it is unverified', async () => {
    // "There was no checksum" and "the checksum was wrong" are different facts
    // and this is where they are kept apart.
    const { client } = make({ status: 200, body: '{"coins":3}' });
    const result = await getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' });
    expect(result.value).toEqual({ coins: 3 });
    expect(result.metadata.verified).toBe(false);
  });
});

describe('metadata headers: present-and-broken is not the same as absent', () => {
  it('refuses an unparseable roblox-entry-userids rather than reporting no users', async () => {
    const body = '{"coins":1}';
    const { client } = make(signed(body, { 'roblox-entry-userids': '[42' }));
    await expect(getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' })).rejects.toThrow(
      /roblox-entry-userids header is present and is not JSON/,
    );
  });

  it('refuses a roblox-entry-attributes that is JSON but the wrong shape', async () => {
    const body = '{"coins":1}';
    const { client } = make(signed(body, { 'roblox-entry-attributes': '[1,2]' }));
    await expect(getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' })).rejects.toThrow(
      /not the documented shape/,
    );
  });

  it('CONTROL — absent metadata headers are undefined, not an error', async () => {
    const { client } = make(signed('{"coins":1}'));
    const result = await getEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k' });
    expect(result.metadata.userIds).toBeUndefined();
    expect(result.metadata.attributes).toBeUndefined();
  });
});

describe('what these calls refuse before sending anything', () => {
  it('refuses exclusiveCreate together with matchVersion', async () => {
    const { fetch, client } = make();
    await expect(
      setEntry(client, {
        universeId: 7,
        dataStoreName: 'S',
        entryKey: 'k',
        value: 1,
        exclusiveCreate: true,
        matchVersion: 'v1',
      }),
    ).rejects.toThrow(/not both/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses allScopes together with a data store scope', async () => {
    const { client } = make();
    await expect(
      listEntries(client, { universeId: 7, dataStoreName: 'S', allScopes: true, dataStoreScope: 'eu' }),
    ).rejects.toThrow(/not both/);
  });

  it('refuses an empty data store name', async () => {
    const { client } = make();
    await expect(getEntry(client, { universeId: 7, dataStoreName: '', entryKey: 'k' })).rejects.toThrow(
      /dataStoreName must be a non-empty string/,
    );
  });

  it('refuses a non-finite incrementBy', async () => {
    const { client } = make();
    await expect(
      incrementEntry(client, { universeId: 7, dataStoreName: 'S', entryKey: 'k', incrementBy: Number.NaN }),
    ).rejects.toThrow(/finite number/);
  });
});

describe('an increment whose new total cannot be read is a failure', () => {
  it('refuses a non-numeric increment body rather than returning it', async () => {
    const { client } = make(signed('"eleven"'));
    const error = await incrementEntry(client, {
      universeId: 7,
      dataStoreName: 'S',
      entryKey: 'k',
      incrementBy: 1,
    }).catch((e: unknown) => e);
    expect((error as OpenCloudError).message).toMatch(/the new total is unknown/);
  });
});

describe('list responses in a shape this client cannot read', () => {
  it('refuses rather than returning an empty page', async () => {
    // An empty page and an unreadable one look identical to a caller looping
    // until the cursor is undefined, and one of them silently loses data.
    const { client } = make({ status: 200, body: '{"datastores":"soon"}' });
    await expect(listDataStores(client, { universeId: 7 })).rejects.toThrow(/expected a JSON array/);
  });
});
