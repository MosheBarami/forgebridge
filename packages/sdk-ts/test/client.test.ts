/**
 * The client, against a fetch this file controls.
 *
 * Nothing here needs a daemon: what these tests are about is what the client
 * decides *before* a request goes out and what it does with the answer, and both
 * are visible from a stub. The live-daemon half is `test/conformance.test.ts`,
 * which runs the whole M31 matrix through an adapter over this same class.
 *
 * The claims worth stating out loud, because they are the ones a future
 * convenience would quietly break:
 *
 *   - proposing never reaches `/approve`, and neither does starting a run;
 *   - a method and the generated route table cannot disagree about what a route
 *     answers with — and that check is planted here and shown to fire;
 *   - a request body is validated against the protocol's own schema before it
 *     is sent, so a malformed ChangeSet never leaves the process.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@forgebridge/protocol';
import {
  AUTH_HEADERS,
  ForgeBridgeClient,
  ForgeBridgeResponseError,
  OPERATION_COVERAGE,
  ROUTES,
  RouteContractError,
  TransportError,
  buildPath,
  expectRouteAnswersWith,
} from '../src/index.js';
import { HealthResponse, LinkStatusResponse } from '../src/generated/wire.js';

// ── a fetch this file controls ───────────────────────────────────────────────

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface Stub {
  calls: Recorded[];
  fetch: typeof globalThis.fetch;
}

function stub(answer: (call: Recorded) => { status: number; body?: unknown; contentType?: string }): Stub {
  const calls: Recorded[] = [];
  const fetchLike = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const { status, body, contentType } = answer(call);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType ?? 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch: fetchLike };
}

const TOKEN = 'producer-token-for-tests';

function client(stubbed: Stub, options: { producerToken?: string; linkId?: string } = {}): ForgeBridgeClient {
  return new ForgeBridgeClient({
    baseUrl: 'http://127.0.0.1:7317/',
    producerToken: 'producerToken' in options ? options.producerToken : TOKEN,
    linkId: options.linkId,
    fetch: stubbed.fetch,
  });
}

const CHANGE_SET = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  baseVersion: 3,
  summary: 'add a respawn handler',
  operations: [
    {
      op: 'writeScript' as const,
      path: 'ServerScriptService.Respawn',
      scriptType: 'Script' as const,
      source: 'print("hi")\n',
    },
  ],
  createdAt: '2026-01-01T00:00:00Z',
};

// ── the route table is the client's only idea of the surface ─────────────────

describe('every /v1 operation is reachable through a method', () => {
  it('names a real method for each one', () => {
    for (const [operationId, method] of Object.entries(OPERATION_COVERAGE)) {
      const candidate = (ForgeBridgeClient.prototype as unknown as Record<string, unknown>)[method as string];
      expect(typeof candidate, `${operationId} claims to be covered by ${String(method)}`).toBe('function');
    }
  });

  it('covers every operation the generated table declares', () => {
    // `OPERATION_COVERAGE` is a `Record<OperationId, …>`, so a route added to
    // the document and not to that map fails `tsc` rather than this test. This
    // is the other direction: that the map has not grown a key the table lost.
    expect(Object.keys(OPERATION_COVERAGE).sort()).toEqual(Object.keys(ROUTES).sort());
  });
});

describe('a method and the route table cannot disagree about what a route answers', () => {
  it('accepts the schema the table names', () => {
    expect(() => expectRouteAnswersWith('getHealth', HealthResponse)).not.toThrow();
  });

  it('refuses a schema the table does not name', () => {
    // Planted: without this check a method could call `getHealth` and parse the
    // answer as a `LinkStatusResponse`, and every test that only ever called the
    // method the right way would pass.
    expect(() => expectRouteAnswersWith('getHealth', LinkStatusResponse)).toThrow(RouteContractError);
    expect(() => expectRouteAnswersWith('getHealth', LinkStatusResponse)).toThrow(/answers with HealthResponse/);
  });

  it('refuses a route with no body at all', () => {
    expect(() => expectRouteAnswersWith('mirrorOutput', HealthResponse)).toThrow(/answers with none/);
  });
});

describe('paths and queries are built fail-closed in both directions', () => {
  it('substitutes a declared path parameter, encoded', () => {
    expect(buildPath(ROUTES.getChangeSetDiff, { changeSetId: 'a/b' }, undefined)).toBe(
      '/v1/changesets/a%2Fb/diff',
    );
  });

  it('refuses a missing path parameter rather than sending a literal brace', () => {
    expect(() => buildPath(ROUTES.getChangeSetDiff, {}, undefined)).toThrow(/needs the path parameter "changeSetId"/);
  });

  it('refuses a path parameter the route does not declare', () => {
    expect(() => buildPath(ROUTES.getChangeSetDiff, { changeSetId: 'x', runId: 'y' }, undefined)).toThrow(
      /declares no path parameter "runId"/,
    );
  });

  it('refuses a query parameter the route does not declare', () => {
    // A typo in a query name would otherwise be sent, ignored by the daemon, and
    // read by the caller as "the filter did nothing".
    expect(() => buildPath(ROUTES.readOutput, undefined, { lnk: 'x' })).toThrow(/declares no query parameter "lnk"/);
  });

  it('drops an undefined query value instead of sending the word undefined', () => {
    expect(buildPath(ROUTES.readOutput, undefined, { link: undefined })).toBe('/v1/output');
  });
});

// ── what the client does before a request goes out ───────────────────────────

describe('auth is required by the route, not by the caller remembering', () => {
  it('refuses a producer route with no token, before any request', async () => {
    const stubbed = stub(() => ({ status: 200, body: {} }));
    await expect(client(stubbed, { producerToken: undefined }).getDiff(CHANGE_SET.id)).rejects.toThrow(
      /needs the daemon's producer token/,
    );
    expect(stubbed.calls).toHaveLength(0);
  });

  it('refuses a consumer route with no link, before any request', async () => {
    const stubbed = stub(() => ({ status: 200, body: {} }));
    await expect(client(stubbed).poll({ mac: 'whatever' })).rejects.toThrow(/needs a paired link/);
    expect(stubbed.calls).toHaveLength(0);
  });

  it('sends the token and the protocol version on a producer route', async () => {
    const stubbed = stub(() => ({
      status: 201,
      body: {
        changeSetId: CHANGE_SET.id,
        status: 'validated',
        baseVersion: 3,
        validation: {
          luau: { status: 'ok', findings: [] },
          policy: { status: 'ok', violations: [] },
          computedAt: '2026-01-01T00:00:01Z',
          computedBy: 'daemon',
        },
      },
    }));
    await client(stubbed).proposeChangeSet(CHANGE_SET);
    const call = stubbed.calls[0];
    expect(call?.url).toBe('http://127.0.0.1:7317/v1/changesets');
    expect(call?.method).toBe('POST');
    expect(call?.headers[AUTH_HEADERS.producerToken.toLowerCase()]).toBe(TOKEN);
    expect(call?.headers['x-forgebridge-protocol']).toBe(PROTOCOL_VERSION);
  });
});

describe('a request body is checked against the protocol before it is sent', () => {
  it('refuses a ChangeSet the protocol would refuse, without a round trip', async () => {
    const stubbed = stub(() => ({ status: 201, body: {} }));
    await expect(
      client(stubbed).proposeChangeSet({
        ...CHANGE_SET,
        operations: [
          // `setProperty` may not write `Parent`: reparenting is a structural
          // change wearing a property's clothes, and `moveInstance` exists for
          // it. The protocol schema says so, and this client parses with it.
          {
            op: 'setProperty' as const,
            path: 'ServerScriptService.Respawn',
            property: 'Parent',
            value: { t: 'Nil' as const },
          },
        ],
      }),
    ).rejects.toThrow(/is not one the protocol accepts/);
    expect(stubbed.calls).toHaveLength(0);
  });

  it('refuses a ChangeSet whose ordering rule the JSON Schema projection cannot carry', async () => {
    // This one is the reason the contract schemas are bound to the protocol
    // package rather than re-derived from JSON Schema: `.superRefine()` bodies
    // do not survive a projection, so a client built on the projected side
    // would have posted this and read the 400.
    const stubbed = stub(() => ({ status: 201, body: {} }));
    await expect(
      client(stubbed).proposeChangeSet({
        ...CHANGE_SET,
        operations: [
          { op: 'deleteInstance' as const, path: 'Workspace.Shop' },
          { op: 'deleteInstance' as const, path: 'Workspace.Shop' },
        ],
      }),
    ).rejects.toThrow(/is not one the protocol accepts/);
    expect(stubbed.calls).toHaveLength(0);
  });
});

// ── what the client does with the answer ─────────────────────────────────────

describe('a refusal keeps the code the daemon sent', () => {
  it('raises a ForgeBridgeError carrying the code, the remedy and the status', async () => {
    const stubbed = stub(() => ({
      status: 409,
      body: { code: 'stale_base', message: 'the project moved on', remedy: 'Rebase and resubmit.' },
    }));
    const failure = await client(stubbed)
      .proposeChangeSet(CHANGE_SET)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForgeBridgeResponseError);
    expect((failure as ForgeBridgeResponseError).code).toBe('stale_base');
    expect((failure as ForgeBridgeResponseError).remedy).toBe('Rebase and resubmit.');
    expect((failure as ForgeBridgeResponseError).httpStatus).toBe(409);
  });

  it('does not invent a code for a refusal that is not a ProtocolError', async () => {
    const stubbed = stub(() => ({ status: 502, body: { nginx: 'bad gateway' } }));
    await expect(client(stubbed).proposeChangeSet(CHANGE_SET)).rejects.toBeInstanceOf(TransportError);
  });

  it('refuses a 2xx whose body does not match the contract', async () => {
    const stubbed = stub(() => ({ status: 200, body: { ok: 'yes please' } }));
    await expect(client(stubbed).health()).rejects.toThrow(/a body this build does not recognise/);
  });
});

describe('a long poll tells an empty window from a delivery', () => {
  it('answers null on 204 rather than an empty envelope', async () => {
    const stubbed = stub(() => ({ status: 204 }));
    const delivery = await client(stubbed, { linkId: '33333333-3333-4333-8333-333333333333' }).poll({ mac: 'm' });
    expect(delivery).toBeNull();
    expect(stubbed.calls[0]?.url).toContain('/v1/link/poll?since=0');
    expect(stubbed.calls[0]?.headers[AUTH_HEADERS.linkMac.toLowerCase()]).toBe('m');
  });
});

// ── ADR-012, as something a test can fail on ─────────────────────────────────

describe('proposing and approving are separate calls', () => {
  it('never reaches /approve while proposing', async () => {
    const stubbed = stub(() => ({
      status: 201,
      body: {
        changeSetId: CHANGE_SET.id,
        status: 'validated',
        baseVersion: 3,
        validation: {
          luau: { status: 'ok', findings: [] },
          policy: { status: 'ok', violations: [] },
          computedAt: '2026-01-01T00:00:01Z',
          computedBy: 'daemon',
        },
      },
    }));
    await client(stubbed).proposeChangeSet(CHANGE_SET);
    expect(stubbed.calls.map((call) => call.url).join('\n')).not.toContain('/approve');
  });

  it('never reaches /approve while starting a run', async () => {
    const stubbed = stub(() => ({ status: 201, body: runResponse() }));
    await client(stubbed).startRun({ prompt: 'add a respawn handler' });
    expect(stubbed.calls.map((call) => call.url).join('\n')).not.toContain('/approve');
  });

  it('makes an approval carry the digest of what was reviewed', async () => {
    // `contentDigest` has no default, here or on the wire. A caller that has not
    // read a diff has nothing to put in it, which is the whole mechanism.
    const stubbed = stub(() => ({ status: 202, body: { changeSetId: CHANGE_SET.id, status: 'approved', nonce: 1 } }));
    await expect(
      // @ts-expect-error contentDigest is required: an approval names operations, not an id.
      client(stubbed).approveChangeSet(CHANGE_SET.id, { approvedBy: 'alex' }),
    ).rejects.toThrow(/is not one the protocol accepts/);

    await client(stubbed).approveChangeSet(CHANGE_SET.id, { contentDigest: 'sha256:abc', approvedBy: 'alex' });
    expect(stubbed.calls.at(-1)?.url).toBe(`http://127.0.0.1:7317/v1/changesets/${CHANGE_SET.id}/approve`);
  });
});

describe('a run is asked for one way and read the same way', () => {
  it('refuses a caller-supplied stream flag', async () => {
    const stubbed = stub(() => ({ status: 201, body: runResponse() }));
    await expect(client(stubbed).startRun({ prompt: 'x', stream: true })).rejects.toThrow(
      /startRun sets `stream` itself/,
    );
    expect(stubbed.calls).toHaveLength(0);
  });

  it('refuses an explicit stream: false too, because the field is not a caller\'s to set', async () => {
    // Not pedantry. If an explicit `false` were accepted alongside a listener,
    // the request would ask for JSON while the client read an event stream —
    // the exact disagreement the client owning the field prevents.
    const stubbed = stub(() => ({ status: 201, body: runResponse() }));
    await expect(client(stubbed).startRun({ prompt: 'x', stream: false })).rejects.toThrow(
      /startRun sets `stream` itself/,
    );
    expect(stubbed.calls).toHaveLength(0);
  });

  it('sends stream: false when no listener was given', async () => {
    const stubbed = stub(() => ({ status: 201, body: runResponse() }));
    await client(stubbed).startRun({ prompt: 'x' });
    expect(JSON.parse(stubbed.calls[0]?.body ?? '{}')).toMatchObject({ stream: false });
  });

  it('returns the whole attempt list, not the model that won', async () => {
    const stubbed = stub(() => ({ status: 201, body: runResponse() }));
    const run = await client(stubbed).startRun({ prompt: 'x' });
    expect(run.run.attempts.map((attempt) => `${attempt.modelId}:${attempt.outcome}`)).toEqual([
      'glm-5.2:free:rate-limited',
      'minimax-m3:free:ok',
    ]);
  });
});

function runResponse(): unknown {
  return {
    run: {
      id: '44444444-4444-4444-8444-444444444444',
      projectId: CHANGE_SET.projectId,
      prompt: 'add a respawn handler',
      stage: 'awaiting-approval',
      status: 'running',
      attempts: [
        {
          modelId: 'glm-5.2:free',
          outcome: 'rate-limited',
          startedAt: '2026-01-01T00:00:00Z',
          durationMs: 120,
        },
        {
          modelId: 'minimax-m3:free',
          outcome: 'ok',
          startedAt: '2026-01-01T00:00:01Z',
          durationMs: 900,
        },
      ],
      changeSetIds: [CHANGE_SET.id],
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: null,
    },
    plan: { steps: ['plan', 'generate', 'validate'] },
    changeSetId: CHANGE_SET.id,
    changeSetStatus: 'validated',
    contentDigest: 'sha256:abc',
    validation: {
      luau: { status: 'ok', findings: [] },
      policy: { status: 'ok', violations: [] },
      computedAt: '2026-01-01T00:00:02Z',
      computedBy: 'daemon',
    },
    skipped: [],
    ordering: null,
    failure: null,
  };
}
