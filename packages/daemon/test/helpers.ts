import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { ProjectPolicy } from '@forgebridge/core';
import { ChangeSet, type ApplyResult, type Validation } from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER } from '../src/auth.js';
import { deriveSessionKey } from '../src/pairing.js';
import { requestMac, sealEnvelope } from '../src/envelope.js';
import { createDaemon, type DaemonOptions, type ForgeBridgeDaemon } from '../src/server.js';

/**
 * The path policy the suite runs under. Written out rather than defaulted away
 * because the daemon's own default is deny-all: a test that did not name its
 * writable paths would be testing a daemon that refuses everything, and the
 * fixtures below would fail for a reason no assertion mentions.
 */
export const TEST_POLICY: ProjectPolicy = {
  allowedPathPrefixes: ['Workspace', 'ServerScriptService', 'ReplicatedStorage'],
  autoApply: null,
};

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json<T = unknown>(): T;
}

/**
 * A raw client rather than `fetch`, because several of these tests need to send
 * headers `fetch` forbids (Host) or malformed ones it would normalise away.
 */
export function raw(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  host?: string;
  signal?: AbortSignal;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${options.port}`, ...options.headers };
    if (options.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(options.body, 'utf8'));
      headers['content-type'] ??= 'application/json';
    }
    const req = httpRequest(
      { host: '127.0.0.1', port: options.port, method: options.method, path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body) as T,
          });
        });
      },
    );
    req.on('error', reject);
    options.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<ForgeBridgeDaemon> {
  // Port 0 for tests: the fixed default is a production concern and would make
  // the suite collide with a daemon the developer already has running.
  const daemon = createDaemon({ port: 0, policy: TEST_POLICY, ...options });
  await daemon.listen();
  return daemon;
}

export interface PairedClient {
  linkId: string;
  projectId: string;
  sessionKey: Buffer;
  port: number;
  poll(since: number, signal?: AbortSignal): Promise<RawResponse>;
  postEnvelope(path: string, nonce: number, payload: unknown, mutate?: (raw: string) => string): Promise<RawResponse>;
}

export async function pair(daemon: ForgeBridgeDaemon): Promise<PairedClient> {
  const port = daemon.address?.port as number;
  const { code } = daemon.issuePairingCode();
  const response = await raw({
    port,
    method: 'POST',
    path: '/v1/link/pair',
    body: JSON.stringify({ pairingCode: code }),
  });
  if (response.status !== 200) throw new Error(`pairing failed: ${response.status} ${response.body}`);
  const paired = response.json<{ linkId: string; projectId: string; sessionSalt: string }>();
  const sessionKey = deriveSessionKey(code, Buffer.from(paired.sessionSalt, 'base64'), paired.linkId);

  return {
    linkId: paired.linkId,
    projectId: paired.projectId,
    sessionKey,
    port,
    poll(since, signal) {
      return raw({
        port,
        method: 'GET',
        path: `/v1/link/poll?since=${since}`,
        headers: {
          'x-forgebridge-link': paired.linkId,
          'x-forgebridge-mac': requestMac(sessionKey, [paired.linkId, 'GET', '/v1/link/poll', String(since)]),
        },
        ...(signal ? { signal } : {}),
      });
    },
    postEnvelope(path, nonce, payload, mutate) {
      const envelope = sealEnvelope(sessionKey, { linkId: paired.linkId, nonce, payload });
      const body = mutate ? mutate(JSON.stringify(envelope)) : JSON.stringify(envelope);
      return raw({
        port,
        method: 'POST',
        path,
        headers: { 'x-forgebridge-link': paired.linkId },
        body,
      });
    },
  };
}

/**
 * The verdict a producer would like the daemon to believe. Fixtures carry it on
 * purpose: it is the attacker-authored field, and the daemon must overwrite it
 * with one it computed itself.
 */
export const okValidation: Validation = {
  luau: { status: 'ok', findings: [] },
  policy: { status: 'ok', violations: [] },
  computedAt: new Date().toISOString(),
  computedBy: 'test-harness',
};

export function makeChangeSet(overrides: Record<string, unknown> = {}): ChangeSet {
  // Built through the frozen schema rather than cast into shape, so a fixture
  // that drifts from the contract fails here instead of in a handler.
  return ChangeSet.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    baseVersion: 0,
    summary: 'add a shop script',
    operations: [
      { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("hello")' },
    ],
    validation: okValidation,
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

export function makeApplyResult(changeSetId: string, overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    changeSetId,
    outcomes: [{ index: 0, ok: true }],
    newVersion: 1,
    journalId: randomUUID(),
    appliedAt: new Date().toISOString(),
    pluginVersion: '0.1.0',
    ...overrides,
  };
}

/** The header a producer request is authenticated by. */
export function producerHeaders(daemon: ForgeBridgeDaemon): Record<string, string> {
  return { [PRODUCER_TOKEN_HEADER.toLowerCase()]: daemon.producerToken };
}

export function portOf(daemon: ForgeBridgeDaemon): number {
  return daemon.address?.port as number;
}

export async function submit(daemon: ForgeBridgeDaemon, changeSet: ChangeSet): Promise<RawResponse> {
  return raw({
    port: portOf(daemon),
    method: 'POST',
    path: '/v1/changesets',
    headers: producerHeaders(daemon),
    body: JSON.stringify(changeSet),
  });
}

export async function diff(daemon: ForgeBridgeDaemon, id: string): Promise<RawResponse> {
  return raw({
    port: portOf(daemon),
    method: 'GET',
    path: `/v1/changesets/${id}/diff`,
    headers: producerHeaders(daemon),
  });
}

/**
 * The digest the daemon currently reports for a set, read off its rendered diff.
 *
 * Read rather than computed, deliberately: computing it here with the daemon's
 * own function would make every test agree with the implementation by
 * construction, and the whole point of the field is that it travels from the
 * page a human read back to the approval. Undefined when there is no diff to
 * read, which is the honest input for a set that does not exist.
 */
export async function renderedDigest(daemon: ForgeBridgeDaemon, id: string): Promise<string | undefined> {
  const response = await diff(daemon, id);
  return response.status === 200 ? response.json<{ contentDigest: string }>().contentDigest : undefined;
}

/**
 * Approve a set the way an approver does: read the diff, then approve what it
 * showed. A caller that names its own `contentDigest` — including one that
 * names a stale or absent one — gets exactly what it asked for instead.
 */
export async function approve(
  daemon: ForgeBridgeDaemon,
  id: string,
  body: Record<string, unknown> = {},
): Promise<RawResponse> {
  const withDigest =
    'contentDigest' in body ? body : { ...body, contentDigest: await renderedDigest(daemon, id) };
  return raw({
    port: portOf(daemon),
    method: 'POST',
    path: `/v1/changesets/${id}/approve`,
    headers: producerHeaders(daemon),
    body: JSON.stringify(withDigest),
  });
}
