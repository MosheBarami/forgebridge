import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  MESSAGING_PUBLISH_SCOPE,
  createOpenCloudClient,
  publishMessage,
} from '../src/index.js';
import { TEST_KEY, fakeFetch } from './helpers.js';

describe('publishMessage', () => {
  it('is exactly the documented request', async () => {
    // https://create.roblox.com/docs/reference/cloud/messaging-service/v1
    const fetch = fakeFetch({ status: 200 });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });

    await publishMessage(client, { universeId: 99, topic: 'shop-restock', message: 'now' });

    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://apis.roblox.com/messaging-service/v1/universes/99/topics/shop-restock');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toBe('{"message":"now"}');
  });

  it('encodes a topic, so a slash addresses a topic and not a path', async () => {
    const fetch = fakeFetch({ status: 200 });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await publishMessage(client, { universeId: 1, topic: 'a/b', message: 'x' });
    expect(fetch.calls[0]!.url).toBe('https://apis.roblox.com/messaging-service/v1/universes/1/topics/a%2Fb');
  });

  it('names the scope an operator has to grant', () => {
    expect(MESSAGING_PUBLISH_SCOPE).toBe('universe-messaging-service:publish');
  });
});

describe('publishMessage — the ceiling, under both readings of "1,024 characters (1 KB)"', () => {
  it('refuses a message over 1024 characters', async () => {
    const fetch = fakeFetch();
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await expect(
      publishMessage(client, { universeId: 1, topic: 't', message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }),
    ).rejects.toThrow(/ceiling of 1024 characters/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses a message inside the character count but over 1024 UTF-8 bytes', async () => {
    // 400 emoji are 400 code points, 800 UTF-16 units and 1600 bytes. Only the
    // byte reading catches this one, which is why both are enforced.
    const fetch = fakeFetch();
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await expect(
      publishMessage(client, { universeId: 1, topic: 't', message: '🧱'.repeat(400) }),
    ).rejects.toThrow(/bytes/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('CONTROL — a message at exactly the ceiling is sent', async () => {
    const fetch = fakeFetch({ status: 200 });
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await publishMessage(client, { universeId: 1, topic: 't', message: 'a'.repeat(MAX_MESSAGE_LENGTH) });
    expect(fetch.calls).toHaveLength(1);
  });

  it('refuses an empty topic rather than posting to /topics/', async () => {
    const fetch = fakeFetch();
    const client = createOpenCloudClient({ apiKey: TEST_KEY, fetch });
    await expect(publishMessage(client, { universeId: 1, topic: '  ', message: 'x' })).rejects.toThrow(
      /non-empty topic/,
    );
  });
});
