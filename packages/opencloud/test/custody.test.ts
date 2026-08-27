import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_ENV,
  createOpenCloudClient,
  getEntry,
  incrementEntry,
  publishMessage,
  publishPlaceVersion,
  run,
  setEntry,
} from '../src/index.js';
import { TEST_KEY, fakeFetch, failingFetch, type FakeResponse } from './helpers.js';

/**
 * The custody sweep.
 *
 * `scripts/verify-no-key-storage.ts` proves this package declares no persisted
 * field shaped like a credential and passes none to a log, a disk write or a
 * response body. That is a check over *shapes*. This suite is the check over
 * *behaviour*: it puts a recognisable key into a real client, drives every
 * failure path the package has, and asserts the key comes out of none of them.
 *
 * The two checks answer different questions and neither replaces the other — a
 * key can leak through a value the static gate cannot follow, and a shape can
 * be wrong in a path no test drives.
 */

/** Everything an error, a client or a result would contribute to a log line. */
function everythingSerialisable(value: unknown): string {
  const parts = [
    String(value),
    inspect(value, { depth: null, showHidden: true }),
    safeJson(value),
  ];
  if (value instanceof Error) {
    parts.push(value.stack ?? '', safeJson({ ...value }));
    if (value.cause !== undefined) parts.push(String(value.cause), inspect(value.cause, { depth: null }));
  }
  return parts.join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, Object.getOwnPropertyNames(Object(value)) as string[]) ?? '';
  } catch {
    return '';
  }
}

const PLACE = new Uint8Array([1, 2, 3]);

function clientFor(...responses: readonly FakeResponse[]) {
  return createOpenCloudClient({ apiKey: TEST_KEY, fetch: fakeFetch(...responses), retry: { attempts: 1 } });
}

describe('the client object itself', () => {
  it('does not carry the key on any enumerable or own property', () => {
    const client = clientFor();
    expect(everythingSerialisable(client)).not.toContain(TEST_KEY);
    expect(JSON.stringify(client)).not.toContain(TEST_KEY);
  });

  it('CONTROL — the key really is in play, so the assertion above is not vacuous', async () => {
    const fetch = fakeFetch({ status: 200, body: '{}' });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await client.send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true });
    expect(fetch.calls[0]!.headers['x-api-key']).toBe(TEST_KEY);
  });
});

describe('every failure path this package has', () => {
  const cases: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: 'refused with an error envelope',
      run: () =>
        getEntry(clientFor({ status: 403, body: '{"error":"Forbidden","message":"missing scope"}' }), {
          universeId: 1,
          dataStoreName: 'S',
          entryKey: 'k',
        }),
    },
    {
      name: 'refused with an HTML proxy page',
      run: () =>
        publishMessage(clientFor({ status: 502, body: '<html>Bad Gateway</html>' }), {
          universeId: 1,
          topic: 't',
          message: 'm',
        }),
    },
    {
      name: 'transport failure',
      run: () =>
        publishPlaceVersion(
          createOpenCloudClient({ apiKey: TEST_KEY, fetch: failingFetch('ECONNRESET') }),
          { universeId: 1, placeId: 2, file: PLACE, format: 'rbxl', versionType: 'Published' },
        ),
    },
    {
      name: 'unreadable success body',
      run: () =>
        publishPlaceVersion(clientFor({ status: 200, body: 'not json' }), {
          universeId: 1,
          placeId: 2,
          file: PLACE,
          format: 'rbxl',
          versionType: 'Published',
        }),
    },
    {
      name: 'content-md5 mismatch',
      run: () =>
        getEntry(clientFor({ status: 200, body: '{"a":1}', headers: { 'content-md5': 'AAAAAAAAAAAAAAAAAAAAAA==' } }), {
          universeId: 1,
          dataStoreName: 'S',
          entryKey: 'k',
        }),
    },
    {
      name: 'increment with an unreadable total',
      run: () =>
        incrementEntry(clientFor({ status: 200, body: '"x"' }), {
          universeId: 1,
          dataStoreName: 'S',
          entryKey: 'k',
          incrementBy: 1,
        }),
    },
    {
      name: 'argument refused before the request',
      run: () =>
        setEntry(clientFor(), {
          universeId: 0,
          dataStoreName: 'S',
          entryKey: 'k',
          value: 1,
        }),
    },
  ];

  for (const scenario of cases) {
    it(`does not leak the key: ${scenario.name}`, async () => {
      const error = await scenario.run().then(
        () => new Error('expected this path to fail'),
        (e: unknown) => e,
      );
      expect(everythingSerialisable(error)).not.toContain(TEST_KEY);
    });
  }
});

describe('the binary', () => {
  it('never prints the key, on success or on failure', async () => {
    const environment = { [API_KEY_ENV]: TEST_KEY };
    const failing = await run(['datastore', 'get', '--universe', '1', '--datastore', 'S', '--key', 'k'], {
      environment,
      createClient: () => clientFor({ status: 500, body: '{"message":"boom"}' }),
    });
    const succeeding = await run(['datastore', 'get', '--universe', '1', '--datastore', 'S', '--key', 'k'], {
      environment,
      createClient: () => clientFor({ status: 200, body: '{"coins":1}' }),
    });

    expect(failing.code).toBe(1);
    expect(succeeding.code).toBe(0);
    for (const result of [failing, succeeding]) {
      expect(result.stdout).not.toContain(TEST_KEY);
      expect(result.stderr).not.toContain(TEST_KEY);
    }
  });

  it('takes the key from the environment and refuses a --api-key flag', async () => {
    // A flag is in shell history and visible in `ps` to every process on the box.
    const result = await run(['message', 'publish', '--universe', '1', '--topic', 't', '--message', 'm', '--api-key', TEST_KEY], {
      environment: { [API_KEY_ENV]: TEST_KEY },
      createClient: () => clientFor({ status: 200 }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown option "--api-key"');
    expect(result.stderr).not.toContain(TEST_KEY);
  });
});
