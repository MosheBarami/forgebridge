import { randomUUID } from 'node:crypto';
import type { ChangeSet, Validation } from '@forgebridge/protocol';
import { ForgeBridgeRelay, type RelayOptions } from '../src/server.js';
import { deriveSessionKey } from '../src/pairing.js';
import { requestMac, sealEnvelope } from '../src/envelope.js';

/**
 * A relay a test can talk to over a real socket.
 *
 * `requireTls: false` throughout, because these tests speak plain HTTP to
 * 127.0.0.1 and the TLS gate is exercised deliberately in `proxy.test.ts`
 * rather than accidentally disabled everywhere.
 */
export async function startRelay(options: RelayOptions = {}): Promise<{
  relay: ForgeBridgeRelay;
  base: string;
  close: () => Promise<void>;
}> {
  const relay = new ForgeBridgeRelay({ port: 0, host: '127.0.0.1', requireTls: false, ...options });
  const { port } = await relay.listen();
  return { relay, base: `http://127.0.0.1:${port}`, close: () => relay.close() };
}

export interface PairedSession {
  sessionId: string;
  projectId: string;
  producerToken: string;
  linkId: string;
  sessionKey: Buffer;
}

/** Mint a session and pair a consumer against it, the way the plugin would. */
export async function pairSession(relay: ForgeBridgeRelay, base: string): Promise<PairedSession> {
  const minted = await relay.createSession();
  const response = await fetch(`${base}/v1/link/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: minted.pairingCode }),
  });
  if (!response.ok) throw new Error(`pair failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { linkId: string; sessionSalt: string };
  return {
    sessionId: minted.session.id,
    projectId: minted.session.projectId,
    producerToken: minted.producerToken,
    linkId: body.linkId,
    sessionKey: deriveSessionKey(minted.pairingCode, Buffer.from(body.sessionSalt, 'base64'), body.linkId),
  };
}

export function producerHeaders(session: PairedSession): Record<string, string> {
  return { 'content-type': 'application/json', 'x-forgebridge-token': session.producerToken };
}

export function pollHeaders(session: PairedSession, since: number): Record<string, string> {
  return {
    'x-forgebridge-link': session.linkId,
    'x-forgebridge-mac': requestMac(session.sessionKey, [
      session.linkId,
      'GET',
      '/v1/link/poll',
      String(since),
    ]),
  };
}

/**
 * Headers for an enveloped consumer write.
 *
 * The link header AND the envelope, because the two answer different questions:
 * the header says which session key the relay should check, and the envelope is
 * the proof that the caller holds it. The relay reads the header first and
 * cannot verify anything without it.
 */
export function consumerHeaders(session: PairedSession): Record<string, string> {
  return { 'content-type': 'application/json', 'x-forgebridge-link': session.linkId };
}

/** An enveloped consumer write, MAC'd under the session key. */
export function envelopeBody(session: PairedSession, nonce: number, payload: unknown): string {
  return JSON.stringify(sealEnvelope(session.sessionKey, { linkId: session.linkId, nonce, payload }));
}

/** A verdict shaped like one the core would have computed. */
export function passingValidation(computedBy = 'test-core@0.0.0'): Validation {
  return {
    luau: { status: 'ok', findings: [] },
    policy: { status: 'ok', violations: [] },
    computedAt: new Date(0).toISOString(),
    computedBy,
  };
}

export function failingValidation(): Validation {
  return {
    luau: { status: 'fail', findings: [] },
    policy: { status: 'ok', violations: [] },
    computedAt: new Date(0).toISOString(),
    computedBy: 'test-core@0.0.0',
  };
}

export interface ChangeSetOverrides {
  id?: string;
  projectId?: string;
  baseVersion?: number;
  operations?: ChangeSet['operations'];
  validation?: Validation | undefined;
  summary?: string;
}

export function makeChangeSet(overrides: ChangeSetOverrides = {}): Record<string, unknown> {
  const validation = 'validation' in overrides ? overrides.validation : passingValidation();
  return {
    id: overrides.id ?? randomUUID(),
    projectId: overrides.projectId ?? randomUUID(),
    baseVersion: overrides.baseVersion ?? 0,
    summary: overrides.summary ?? 'add a shop handler',
    operations: overrides.operations ?? [
      {
        op: 'writeScript',
        path: 'ServerScriptService.Shop',
        scriptType: 'Script',
        source: 'print("hello")',
      },
    ],
    status: 'proposed',
    createdAt: new Date(0).toISOString(),
    metadata: {},
    ...(validation ? { validation } : {}),
  };
}

/** N distinct createInstance operations, for the operation-count ceiling. */
export function manyOperations(count: number): ChangeSet['operations'] {
  return Array.from({ length: count }, (_unused, index) => ({
    op: 'createInstance' as const,
    path: `Workspace.Part${index}` as ChangeSet['operations'][number]['path'],
    className: 'Part',
    properties: {},
  })) as ChangeSet['operations'];
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
