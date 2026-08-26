import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER } from '@forgebridge/daemon';
import { DaemonClient } from '../src/daemon-client.js';
import { DaemonRequestError, asProtocolError } from '../src/errors.js';
import { BASE_URL, fakeDaemon } from './fake-daemon.js';

/**
 * The client's contract with `/v1`: present the producer token, declare the
 * protocol version, and translate a refusal without reinterpreting it.
 */

function clientFor(daemon = fakeDaemon()): { client: DaemonClient; daemon: ReturnType<typeof fakeDaemon> } {
  return {
    daemon,
    client: new DaemonClient({ baseUrl: `${BASE_URL}/`, producerToken: 'test-producer-token', fetch: daemon.fetch }),
  };
}

describe('requests', () => {
  it('carries the producer token and the protocol version on every call', async () => {
    const { client, daemon } = clientFor();
    await client.linkStatus();
    await client.models();

    for (const request of daemon.requests) {
      expect(request.headers[PRODUCER_TOKEN_HEADER.toLowerCase()]).toBe('test-producer-token');
      expect(request.headers[PROTOCOL_VERSION_HEADER.toLowerCase()]).toBe(PROTOCOL_VERSION);
    }
  });

  it('sends application/json only with a body, which is what the daemon insists on', async () => {
    const { client, daemon } = clientFor();
    await client.linkStatus();
    await client.rollback({ journalId: '44444444-4444-4444-8444-444444444444', expectedVersion: 0 });

    expect(daemon.requests[0]?.headers['content-type']).toBeUndefined();
    expect(daemon.requests[1]?.headers['content-type']).toBe('application/json');
  });

  it('trims a trailing slash off the configured base URL', async () => {
    const { client, daemon } = clientFor();
    await client.health();
    expect(daemon.requests[0]?.path).toBe('/v1/health');
    expect(client.baseUrl).toBe(BASE_URL);
  });

  it('escapes an id into its path segment', async () => {
    const { client, daemon } = clientFor();
    await client.diff('a b/c').catch(() => undefined);
    expect(daemon.requests[0]?.path).toBe('/v1/changesets/a%20b%2Fc/diff');
  });
});

describe('answers', () => {
  it('passes the daemon-chosen error code through rather than deriving one from the status', async () => {
    const daemon = fakeDaemon();
    // Four codes share 403/409; a client that re-derived from the status would
    // collapse them and the agent would get the wrong instruction.
    daemon.failWith = { status: 403, body: { code: 'policy_violation', message: 'outside the allowed paths', remedy: 'Stay inside.' } };
    const { client } = clientFor(daemon);

    await expect(client.models()).rejects.toBeInstanceOf(DaemonRequestError);
    const error = await client.models().catch((caught: unknown) => asProtocolError(caught));
    expect(error.code).toBe('policy_violation');
    expect(error.remedy).toBe('Stay inside.');
  });

  it('falls back to a code when the body is not a ProtocolError', async () => {
    const daemon = fakeDaemon();
    daemon.failWith = { status: 502, body: '<html>gateway</html>' };
    const { client } = clientFor(daemon);

    const error = await client.models().catch((caught: unknown) => asProtocolError(caught));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('502');
  });

  it('reads 204 as nothing rather than as malformed JSON', async () => {
    const daemon = fakeDaemon();
    daemon.fetch = async () => new Response(null, { status: 204 });
    const { client } = clientFor(daemon);
    await expect(client.output()).resolves.toBeNull();
  });

  it('says the daemon is unreachable without repeating what the runtime said', async () => {
    const daemon = fakeDaemon();
    daemon.fetch = async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED /opt/forgebridge/state');
    };
    const { client } = clientFor(daemon);

    const error = await client.health().catch((caught: unknown) => asProtocolError(caught));
    expect(error.code).toBe('internal');
    expect(error.message).toContain(BASE_URL);
    expect(error.message).not.toContain('/opt/');
    expect(error.remedy).toMatch(/forgebridge-daemon/);
  });
});
