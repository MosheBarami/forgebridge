import { describe, expect, it } from 'vitest';
import {
  OpenCloudError,
  PLACES_WRITE_SCOPE,
  contentTypeForPlaceFile,
  createOpenCloudClient,
  publishPlaceVersion,
} from '../src/index.js';
import { TEST_KEY, fakeFetch, failingFetch } from './helpers.js';

const PLACE = new Uint8Array([0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78]);

function client(...responses: Parameters<typeof fakeFetch>) {
  const fetch = fakeFetch(...responses);
  return { fetch, client: createOpenCloudClient({ apiKey: TEST_KEY, fetch }) };
}

describe('publishPlaceVersion — the wire shape', () => {
  it('is exactly the documented request', async () => {
    // https://create.roblox.com/docs/cloud/guides/usage-place-publishing
    const { fetch, client: c } = client({ status: 200, body: '{"versionNumber":7}' });

    const result = await publishPlaceVersion(c, {
      universeId: 123,
      placeId: 456,
      file: PLACE,
      format: 'rbxl',
      versionType: 'Published',
    });

    expect(result).toEqual({ versionNumber: 7 });
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://apis.roblox.com/universes/v1/123/places/456/versions?versionType=Published');
    expect(call.headers['content-type']).toBe('application/octet-stream');
    expect(call.body).toBe(PLACE);
  });

  it('sends application/xml for an rbxlx', async () => {
    const { fetch, client: c } = client({ status: 200, body: '{"versionNumber":1}' });
    await publishPlaceVersion(c, {
      universeId: '1',
      placeId: '2',
      file: PLACE,
      format: 'rbxlx',
      versionType: 'Saved',
    });
    expect(fetch.calls[0]!.headers['content-type']).toBe('application/xml');
    expect(fetch.calls[0]!.url).toContain('versionType=Saved');
  });

  it('names the scope an operator has to grant', () => {
    expect(PLACES_WRITE_SCOPE).toBe('universe-places:write');
  });
});

describe('publishPlaceVersion — what it refuses', () => {
  it('refuses a versionType it was not given, rather than picking one', async () => {
    const { client: c } = client();
    await expect(
      publishPlaceVersion(c, {
        universeId: 1,
        placeId: 2,
        file: PLACE,
        format: 'rbxl',
        versionType: undefined as unknown as 'Published',
      }),
    ).rejects.toThrow(/no default/);
  });

  it('refuses a zero-byte place file', async () => {
    const { client: c } = client();
    await expect(
      publishPlaceVersion(c, {
        universeId: 1,
        placeId: 2,
        file: new Uint8Array(0),
        format: 'rbxl',
        versionType: 'Saved',
      }),
    ).rejects.toThrow(/zero-byte/);
  });

  it('refuses an id that would become "undefined" in the path', async () => {
    const { client: c } = client();
    await expect(
      publishPlaceVersion(c, {
        universeId: undefined as unknown as number,
        placeId: 2,
        file: PLACE,
        format: 'rbxl',
        versionType: 'Saved',
      }),
    ).rejects.toThrow(/universeId must be a positive integer/);
  });

  it('refuses a 200 with no readable versionNumber, and says the publish is unconfirmed', async () => {
    // The rule: an unreadable "OK" and a real "OK" must not be the same answer.
    const { client: c } = client({ status: 200, body: '{"ok":true}' });
    const error = await publishPlaceVersion(c, {
      universeId: 1,
      placeId: 2,
      file: PLACE,
      format: 'rbxl',
      versionType: 'Published',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpenCloudError);
    expect((error as OpenCloudError).kind).toBe('unreadable');
    expect((error as OpenCloudError).message).toMatch(/may or may not have been published/);
  });

  it('CONTROL — accepts versionNumber sent as a string, which the reference describes', async () => {
    const { client: c } = client({ status: 200, body: '{"versionNumber":"12"}' });
    const result = await publishPlaceVersion(c, {
      universeId: 1,
      placeId: 2,
      file: PLACE,
      format: 'rbxl',
      versionType: 'Published',
    });
    expect(result).toEqual({ versionNumber: 12 });
  });

  it('never retries a publish: a second one is a second version', async () => {
    const fetch = failingFetch();
    const c = createOpenCloudClient({ apiKey: TEST_KEY, fetch, retry: { attempts: 5 } });
    await expect(
      publishPlaceVersion(c, { universeId: 1, placeId: 2, file: PLACE, format: 'rbxl', versionType: 'Published' }),
    ).rejects.toBeInstanceOf(OpenCloudError);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('contentTypeForPlaceFile', () => {
  it('maps the two documented extensions', () => {
    expect(contentTypeForPlaceFile('game.rbxl')).toEqual({ format: 'rbxl', contentType: 'application/octet-stream' });
    expect(contentTypeForPlaceFile('Game.RBXLX')).toEqual({ format: 'rbxlx', contentType: 'application/xml' });
  });

  it('refuses anything else rather than defaulting to octet-stream', () => {
    expect(() => contentTypeForPlaceFile('game.rbxm')).toThrow(/neither .rbxl nor .rbxlx/);
  });
});
