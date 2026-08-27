import { describe, expect, it } from 'vitest';
import {
  API_KEY_HEADER,
  DEFAULT_BASE_URL,
  OpenCloudError,
  buildUrl,
  createOpenCloudClient,
  parseRetryAfter,
  readErrorEnvelope,
} from '../src/index.js';
import { TEST_KEY, fakeFetch, fakeSleep, failingFetch } from './helpers.js';

const ok = { status: 200, body: '{}' };

describe('createOpenCloudClient — the credential', () => {
  it('sends the key in x-api-key and in no other header', async () => {
    const fetch = fakeFetch(ok);
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await client.send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true });

    const call = fetch.calls[0]!;
    expect(call.headers[API_KEY_HEADER]).toBe(TEST_KEY);
    const elsewhere = Object.entries(call.headers).filter(([name]) => name !== API_KEY_HEADER);
    expect(elsewhere.map(([, value]) => value).join(' ')).not.toContain(TEST_KEY);
  });

  it('refuses a key that cannot go in a header, without quoting it back', () => {
    // The shape this catches in the field: `export KEY=$(cat keyfile)`.
    let thrown: unknown;
    try {
      createOpenCloudClient({ apiKey: `${TEST_KEY}\n` });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(TEST_KEY);
    expect((thrown as Error).message).toContain('whitespace or control characters');
  });

  it('refuses an empty key rather than sending an unauthenticated request', () => {
    expect(() => createOpenCloudClient({ apiKey: '   ' })).toThrow(/API key is required/);
  });
});

describe('createOpenCloudClient — the base URL', () => {
  it('defaults to the documented host', () => {
    expect(createOpenCloudClient({ apiKey: TEST_KEY, fetch: fakeFetch() }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('refuses plain HTTP, because the key travels in a header', () => {
    expect(() => createOpenCloudClient({ apiKey: TEST_KEY, baseUrl: 'http://apis.example.org' })).toThrow(
      /refusing to send the API key/,
    );
  });

  it('refuses plain HTTP off loopback even with the opt-out set', () => {
    // The opt-out exists for a mock server. An opt-out that also permits an
    // internal hostname is the one an operator sets once and forgets.
    expect(() =>
      createOpenCloudClient({
        apiKey: TEST_KEY,
        baseUrl: 'http://collector.internal:8080',
        allowInsecureLoopbackBaseUrl: true,
      }),
    ).toThrow(/loopback only/);
  });

  it('CONTROL — permits plain HTTP on loopback with the opt-out, which is what a mock needs', () => {
    const client = createOpenCloudClient({
      apiKey: TEST_KEY,
      baseUrl: 'http://127.0.0.1:9099',
      allowInsecureLoopbackBaseUrl: true,
      fetch: fakeFetch(),
    });
    expect(client.baseUrl).toBe('http://127.0.0.1:9099');
  });

  it('CONTROL — an https base URL needs no opt-out', () => {
    expect(createOpenCloudClient({ apiKey: TEST_KEY, baseUrl: 'https://proxy.example.org' }).baseUrl).toBe(
      'https://proxy.example.org',
    );
  });
});

describe('buildUrl', () => {
  it('percent-encodes query values, which are user data', () => {
    const url = buildUrl('https://apis.roblox.com', {
      path: 'datastores/v1/universes/1/standard-datastores/datastore/entries/entry',
      query: { datastoreName: 'Player Saves', entryKey: 'user/42?x=1' },
    });
    expect(url).toBe(
      'https://apis.roblox.com/datastores/v1/universes/1/standard-datastores/datastore/entries/entry' +
        '?datastoreName=Player+Saves&entryKey=user%2F42%3Fx%3D1',
    );
  });

  it('drops undefined query values rather than sending the string "undefined"', () => {
    expect(buildUrl('https://apis.roblox.com', { path: 'x', query: { a: undefined, b: 1 } })).toBe(
      'https://apis.roblox.com/x?b=1',
    );
  });
});

describe('retrying', () => {
  it('retries an idempotent request that was refused with 429', async () => {
    const fetch = fakeFetch({ status: 429, body: '' }, { status: 200, body: '{"ok":true}' });
    const { sleep, waits } = fakeSleep();
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch, sleep, retry: { attempts: 2 } });

    const response = await client.send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true });
    expect(response.status).toBe(200);
    expect(fetch.calls).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it('does NOT retry a non-idempotent request, however retryable the status looks', async () => {
    // The lesson this encodes: retrying a write whose answer was lost is a
    // partial failure recorded as a success wearing a helpful face.
    const fetch = fakeFetch({ status: 503, body: '' });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch, sleep: fakeSleep().sleep, retry: { attempts: 5 } });

    await expect(
      client.send({ operation: 'POST /x', method: 'POST', path: 'x', idempotent: false }),
    ).rejects.toBeInstanceOf(OpenCloudError);
    expect(fetch.calls).toHaveLength(1);
  });

  it('does NOT retry a transport failure even when the request is idempotent', async () => {
    const fetch = failingFetch();
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch, sleep: fakeSleep().sleep, retry: { attempts: 4 } });

    const error = await client
      .send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCloudError);
    expect((error as OpenCloudError).kind).toBe('transport');
  });

  it('does NOT retry a 4xx that is not 429 — the answer will not change', async () => {
    const fetch = fakeFetch({ status: 403, body: '{"message":"missing scope"}' });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch, sleep: fakeSleep().sleep, retry: { attempts: 3 } });

    const error = await client
      .send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true })
      .catch((e: unknown) => e);
    expect(fetch.calls).toHaveLength(1);
    expect((error as OpenCloudError).detail).toBe('missing scope');
  });

  it('honours retry-after when it is longer than the backoff, and caps it', async () => {
    const fetch = fakeFetch({ status: 429, headers: { 'retry-after': '600' } }, { status: 200, body: '{}' });
    const { sleep, waits } = fakeSleep();
    const client = createOpenCloudClient({
      apiKey: TEST_KEY,
      fetch,
      sleep,
      retry: { attempts: 2, baseDelayMs: 100, maxDelayMs: 5_000 },
    });

    await client.send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true });
    expect(waits).toEqual([5_000]);
  });

  it('gives up after the declared number of attempts and reports the last refusal', async () => {
    const fetch = fakeFetch({ status: 500 }, { status: 500 }, { status: 500 });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch, sleep: fakeSleep().sleep, retry: { attempts: 3 } });

    const error = await client
      .send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true })
      .catch((e: unknown) => e);
    expect(fetch.calls).toHaveLength(3);
    expect((error as OpenCloudError).status).toBe(500);
  });

  it('refuses a retry policy that cannot be satisfied rather than silently normalising it', () => {
    expect(() => createOpenCloudClient({ apiKey: TEST_KEY, retry: { attempts: 0 } })).toThrow(/at least 1/);
    expect(() => createOpenCloudClient({ apiKey: TEST_KEY, retry: { baseDelayMs: 10, maxDelayMs: 5 } })).toThrow(
      /maxDelayMs/,
    );
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', 0)).toBe(120);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-08-27T00:00:00Z');
    expect(parseRetryAfter('Thu, 27 Aug 2026 00:00:30 GMT', now)).toBe(30);
  });

  it('returns undefined rather than inventing a number it was not sent', () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter('', 0)).toBeUndefined();
  });
});

describe('readErrorEnvelope', () => {
  it('reads the documented legacy fields', () => {
    expect(readErrorEnvelope(400, '{"error":"InvalidInput","message":"bad key"}')).toEqual({
      code: 'InvalidInput',
      detail: 'bad key',
    });
  });

  it('reaches into errorDetails for a datastore code', () => {
    const body = '{"errors":[],"errorDetails":[{"errorDetailType":"DatastoreErrorInfo","datastoreErrorCode":"KeyNotFound"}]}';
    expect(readErrorEnvelope(404, body).code).toBe('KeyNotFound');
  });

  it('falls back to the raw text for a proxy HTML page, rather than reporting nothing', () => {
    const detail = readErrorEnvelope(502, '<html><body>Bad Gateway</body></html>').detail;
    expect(detail).toContain('Bad Gateway');
  });
});

describe('reading a success body', () => {
  it('treats an empty body on a JSON operation as unreadable, not as success', async () => {
    const fetch = fakeFetch({ status: 200, body: '' });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    const response = await client.send({ operation: 'GET /x', method: 'GET', path: 'x', idempotent: true });
    const { readJson } = await import('../src/client.js');
    expect(() => readJson(response, 'GET /x')).toThrow(/cannot read/);
  });
});
