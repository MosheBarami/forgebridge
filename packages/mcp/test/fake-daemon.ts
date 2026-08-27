import { randomUUID } from 'node:crypto';
import type { ChangeSetStatus } from '@forgebridge/protocol';
import type { FetchLike } from '../src/daemon-client.js';
import { DaemonClient } from '../src/daemon-client.js';
import type { ToolContext } from '../src/tools.js';

/**
 * A recording stand-in for `/v1`.
 *
 * It records every request before it answers, which is what makes the approval
 * boundary testable at all: the interesting assertion is not what a tool
 * returned but which requests it did — and, above all, which one it did not.
 *
 * It answers an approve path with 200 rather than 404 on purpose. A 404 would
 * make an accidental approval look like an ordinary failure; a 200 makes it
 * look like success, so the only thing that can catch it is the recording, and
 * the test that reads the recording cannot be satisfied by a lucky error.
 */

export interface RecordedRequest {
  method: string;
  /** Path and query, without the origin. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export const DEFAULT_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const DEFAULT_LINK_ID = '22222222-2222-4222-8222-222222222222';
export const BASE_URL = 'http://127.0.0.1:7317';

export interface FakeDaemon {
  fetch: FetchLike;
  requests: RecordedRequest[];
  /** Status the diff endpoint reports. Flip it to simulate a human approving. */
  status: ChangeSetStatus;
  /** Set to make every route answer with this ProtocolError instead. */
  failWith: { status: number; body: unknown } | null;
  paths(): string[];
}

export function fakeDaemon(initial: Partial<Pick<FakeDaemon, 'status'>> = {}): FakeDaemon {
  const daemon: FakeDaemon = {
    requests: [],
    status: initial.status ?? 'validated',
    failWith: null,
    paths: () => daemon.requests.map((request) => `${request.method} ${request.path}`),
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const rawBody = typeof init?.body === 'string' ? init.body : undefined;
      daemon.requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        headers: normaliseHeaders(init?.headers),
        body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
      });

      if (daemon.failWith) return json(daemon.failWith.status, daemon.failWith.body);
      return route(daemon, method, url, rawBody);
    },
  };
  return daemon;
}

function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((headers ?? {}) as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(daemon: FakeDaemon, method: string, url: URL, rawBody: string | undefined): Response {
  const path = url.pathname;
  const body = rawBody === undefined ? null : (JSON.parse(rawBody) as Record<string, unknown>);

  if (method === 'GET' && path === '/v1/health') {
    return json(200, { ok: true, service: 'forgebridge-daemon', transport: 'local-daemon' });
  }

  if (method === 'GET' && path === '/v1/link') {
    return json(200, {
      transport: 'local-daemon',
      privacyPosture: 'Local — nothing leaves this machine',
      protocolVersion: '1.0.0',
      defaultProjectId: DEFAULT_PROJECT_ID,
      links: [
        {
          id: DEFAULT_LINK_ID,
          projectId: DEFAULT_PROJECT_ID,
          transport: 'local-daemon',
          state: 'paired',
          sessionKeyId: 'k1',
          pluginVersion: '0.1.0',
          studioVersion: null,
          placeId: null,
          lastSeenAt: '2026-08-26T00:00:00.000Z',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      pairing: null,
    });
  }

  if (method === 'POST' && path === '/v1/changesets') {
    return json(201, {
      changeSetId: body?.['id'],
      status: 'validated',
      baseVersion: body?.['baseVersion'],
      validation: {
        luau: { status: 'warn', findings: [] },
        policy: { status: 'ok', violations: [] },
        computedAt: '2026-08-26T00:00:00.000Z',
        computedBy: 'forgebridge-daemon@0.1.0',
      },
    });
  }

  const diffMatch = /^\/v1\/changesets\/([^/]+)\/diff$/.exec(path);
  if (method === 'GET' && diffMatch) {
    return json(200, {
      changeSetId: decodeURIComponent(diffMatch[1] as string),
      projectId: DEFAULT_PROJECT_ID,
      summary: 'a proposal',
      status: daemon.status,
      baseVersion: 0,
      currentVersion: 0,
      stale: false,
      counts: { total: 1, creates: 0, setProperties: 0, scripts: 1, moves: 0, deletes: 0 },
      operations: [],
      treeAware: false,
    });
  }

  const rollbackMatch = /^\/v1\/journal\/([^/]+)\/rollback$/.exec(path);
  if (method === 'POST' && rollbackMatch) {
    return json(202, {
      journalId: decodeURIComponent(rollbackMatch[1] as string),
      changeSetId: randomUUID(),
      status: 'dispatched',
      nonce: 3,
    });
  }

  if (method === 'GET' && path === '/v1/output') {
    return json(200, {
      messages: [
        { level: 'print', message: 'one', at: '2026-08-26T00:00:00.000Z' },
        { level: 'warning', message: 'two', at: '2026-08-26T00:00:01.000Z' },
        { level: 'error', message: 'three', at: '2026-08-26T00:00:02.000Z' },
      ],
    });
  }

  if (method === 'POST' && path === '/v1/runs') {
    const runId = randomUUID();
    const changeSetId = randomUUID();
    return json(201, {
      run: {
        id: runId,
        projectId: (body?.['projectId'] as string) ?? DEFAULT_PROJECT_ID,
        prompt: body?.['prompt'],
        stage: 'awaiting-approval',
        status: 'running',
        // Two attempts, never one: a fake whose run only tried the model that
        // worked would let a connector that reports the winner alone pass every
        // assertion about the attempt list (ADR-008).
        attempts: [
          { modelId: 'glm-5.2:free', outcome: 'rate-limited', startedAt: '2026-08-26T00:00:00.000Z', durationMs: 900 },
          { modelId: 'minimax-m3:free', outcome: 'ok', startedAt: '2026-08-26T00:00:01.000Z', durationMs: 4200 },
        ],
        changeSetIds: [changeSetId],
        producer: body?.['producer'],
        startedAt: '2026-08-26T00:00:00.000Z',
        finishedAt: null,
      },
      plan: { steps: ['write one script'] },
      changeSetId,
      // `validated`, never `approved`: a run stops at the human gate.
      changeSetStatus: 'validated',
      contentDigest: 'sha256:the-digest-this-run-reported',
      validation: {
        luau: { status: 'ok', findings: [] },
        policy: { status: 'ok', violations: [] },
        computedAt: '2026-08-26T00:00:02.000Z',
        computedBy: 'forgebridge-daemon@0.1.0',
      },
      skipped: [],
      ordering: { policy: 'free-first', candidatesConsidered: 4, candidatesEligible: 2, order: ['glm-5.2:free', 'minimax-m3:free'] },
      failure: null,
    });
  }

  if (method === 'GET' && path === '/v1/models') {
    return json(200, { configured: true, source: 'test', verifiedAt: null, models: [] });
  }

  // Answered as a success so that only the recording can catch it. See above.
  if (path.includes('/approve')) return json(202, { changeSetId: 'approved-by-mistake', status: 'approved', nonce: 1 });

  return json(404, { code: 'not_found', message: 'unknown path' });
}

export function contextFor(daemon: FakeDaemon, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    client: new DaemonClient({ baseUrl: BASE_URL, producerToken: 'test-producer-token', fetch: daemon.fetch }),
    defaultProjectId: DEFAULT_PROJECT_ID,
    ...overrides,
  };
}

/** A minimal, schema-valid proposal. */
export function proposalArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseVersion: 0,
    summary: 'add the shop purchase handler',
    operations: [
      {
        op: 'writeScript',
        path: 'ServerScriptService.Shop',
        scriptType: 'ModuleScript',
        source: 'return {}\n',
      },
    ],
    ...overrides,
  };
}

/** The text a tool returned, parsed back out of its single content block. */
export function payloadOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}
