import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { DENY_ALL_POLICY } from '@forgebridge/core';
import { PROTOCOL_VERSION, ProtocolError, STRUCTURAL_PROPERTIES } from '@forgebridge/protocol';
import { LOOPBACK_HOST, MAX_ERROR_MESSAGE_CHARS } from '../src/http.js';
import { InMemoryDaemonStore } from '../src/store.js';
import { DAEMON_VERSION, type ForgeBridgeDaemon } from '../src/server.js';
import {
  approve,
  okValidation,
  makeApplyResult,
  makeChangeSet,
  pair,
  portOf,
  producerHeaders,
  raw,
  startDaemon,
  submit,
  type PairedClient,
} from './helpers.js';

const running: ForgeBridgeDaemon[] = [];

async function daemonFor(options = {}): Promise<ForgeBridgeDaemon> {
  const daemon = await startDaemon(options);
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
});

/** A ChangeSet already submitted and approved, with the link ready to poll. */
async function readyToDeliver(daemon: ForgeBridgeDaemon): Promise<{ client: PairedClient; changeSetId: string }> {
  const client = await pair(daemon);
  const changeSet = makeChangeSet({ projectId: client.projectId });
  expect((await submit(daemon, changeSet)).status).toBe(201);
  expect((await approve(daemon, changeSet.id)).status).toBe(202);
  return { client, changeSetId: changeSet.id };
}

describe('binding', () => {
  it('binds loopback and nothing else', async () => {
    const daemon = await daemonFor();
    expect(daemon.address?.address).toBe(LOOPBACK_HOST);
    expect(daemon.address?.family).toBe('IPv4');
  });

  it('is not reachable on any non-loopback interface of this machine', async () => {
    // The real assertion behind "binds 127.0.0.1": if the daemon had been
    // listening on 0.0.0.0, this connection would succeed and every machine on
    // the network could drive writes into the user's place.
    const daemon = await daemonFor();
    const port = portOf(daemon);
    const external = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);

    if (external.length === 0) return; // no external interface to test against

    for (const address of external) {
      const reachable = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: address, port, timeout: 750 });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });
      expect(reachable, `daemon answered on ${address}:${port}`).toBe(false);
    }
  });

  it('refuses a request whose Host is not a loopback name', async () => {
    // DNS rebinding: a page can point a hostname it controls at 127.0.0.1 and
    // have the user's own browser deliver the request here.
    const daemon = await daemonFor();
    const response = await raw({
      port: portOf(daemon),
      method: 'GET',
      path: '/v1/health',
      host: 'daemon.attacker.example',
    });
    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');
  });

  it('refuses a browser origin the operator did not allow', async () => {
    const daemon = await daemonFor();
    const response = await raw({
      port: portOf(daemon),
      method: 'GET',
      path: '/v1/health',
      headers: { origin: 'https://not-allowed.example' },
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /v1/health', () => {
  it('reports the transport and the address it is bound to', async () => {
    const daemon = await daemonFor();
    const response = await raw({ port: portOf(daemon), method: 'GET', path: '/v1/health' });
    const body = response.json<{ ok: boolean; transport: string; boundTo: string }>();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.transport).toBe('local-daemon');
    expect(body.boundTo).toBe(`${LOOPBACK_HOST}:${portOf(daemon)}`);
  });

  it('reports its own version, not the protocol version', async () => {
    const daemon = await daemonFor();
    const response = await raw({ port: portOf(daemon), method: 'GET', path: '/v1/health' });
    const body = response.json<{ version: string; protocolVersion: string }>();
    expect(body.version).toBe(DAEMON_VERSION);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('refuses an unknown protocol major rather than half-speaking it', async () => {
    const daemon = await daemonFor();
    const response = await raw({
      port: portOf(daemon),
      method: 'GET',
      path: '/v1/health',
      headers: { 'x-forgebridge-protocol': '2.0.0' },
    });
    expect(response.status).toBe(426);
    expect(response.json<{ code: string }>().code).toBe('unsupported_version');
  });
});

describe('POST /v1/link/pair', () => {
  it('pairs on a correct code and never serves the code back', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    expect(client.linkId).toMatch(/^[0-9a-f-]{36}$/);

    const status = await raw({ port: client.port, method: 'GET', path: '/v1/link' });
    expect(status.status).toBe(200);
    expect(status.body).not.toContain('pairingCode');
    const body = status.json<{ links: { sessionKeyId: string | null }[] }>();
    expect(body.links).toHaveLength(1);
    expect(body.links[0]?.sessionKeyId).toBeTruthy();
  });

  it('refuses a wrong code', async () => {
    const daemon = await daemonFor();
    daemon.issuePairingCode();
    const response = await raw({
      port: portOf(daemon),
      method: 'POST',
      path: '/v1/link/pair',
      body: JSON.stringify({ pairingCode: 'ABCDEFGH' }),
    });
    expect(response.status).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('link_unauthenticated');
  });

  it('refuses a body that is not application/json', async () => {
    // A form or text/plain POST is a simple cross-origin request and needs no
    // preflight; requiring JSON is what keeps a web page from driving this.
    const daemon = await daemonFor();
    const { code } = daemon.issuePairingCode();
    const response = await raw({
      port: portOf(daemon),
      method: 'POST',
      path: '/v1/link/pair',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ pairingCode: code }),
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /v1/changesets', () => {
  it('accepts a set built against the current version', async () => {
    const daemon = await daemonFor();
    const response = await submit(daemon, makeChangeSet());
    expect(response.status).toBe(201);
    expect(response.json<{ status: string }>().status).toBe('validated');
  });

  it('refuses a stale base with 409 stale_base rather than merging it', async () => {
    const daemon = await daemonFor();
    const response = await submit(daemon, makeChangeSet({ baseVersion: 7 }));
    expect(response.status).toBe(409);
    const body = response.json<{ code: string; remedy?: string }>();
    expect(body.code).toBe('stale_base');
    expect(body.remedy).toContain('0');
  });

  it('refuses a set whose base went stale between submit and approve', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    expect((await submit(daemon, changeSet)).status).toBe(201);

    // Something else applied in the meantime.
    await daemon.store.setProjectVersion(client.projectId, 3);

    const response = await approve(daemon, changeSet.id);
    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('stale_base');
  });

  it('refuses a changeset that fails schema validation', async () => {
    const daemon = await daemonFor();
    const response = await raw({
      port: portOf(daemon),
      method: 'POST',
      path: '/v1/changesets',
      headers: producerHeaders(daemon),
      body: JSON.stringify({ id: 'not-a-uuid' }),
    });
    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');
  });
});

describe('POST /v1/changesets/:id/approve', () => {
  it('refuses to approve a set that carries no validation at all', async () => {
    // Unreachable through POST /v1/changesets, which always computes a verdict.
    // Put in through the store instead — the seam a persistent adapter or a
    // second ingress would arrive by — because "no verdict" must fail closed
    // rather than sail past a check written as `if (validation && …)`.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId, validation: undefined });
    await daemon.store.putChangeSet(changeSet);

    const response = await approve(daemon, changeSet.id);
    expect(response.status).toBe(400);
  });

  it('refuses to approve a set whose policy verdict failed', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({
      projectId: client.projectId,
      operations: [{ op: 'deleteInstance', path: 'Lighting.Ambience' }],
    });
    expect((await submit(daemon, changeSet)).status).toBe(201);

    const response = await approve(daemon, changeSet.id);
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('policy_violation');
  });

  it('refuses a bulk delete without an explicit confirmation', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({
      projectId: client.projectId,
      operations: Array.from({ length: 15 }, (_, i) => ({
        op: 'deleteInstance',
        path: `Workspace.Doomed${i}`,
      })),
    });
    await submit(daemon, changeSet);

    expect((await approve(daemon, changeSet.id)).status).toBe(400);
    expect((await approve(daemon, changeSet.id, { confirmBulkDelete: true })).status).toBe(202);
  });

  it('refuses to approve when no Studio session is paired', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    await submit(daemon, changeSet);
    const response = await approve(daemon, changeSet.id);
    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('link_unpaired');
  });
});

describe('GET /v1/link/poll', () => {
  it('requires a MAC, not just a link id', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const response = await raw({
      port: client.port,
      method: 'GET',
      path: '/v1/link/poll?since=0',
      headers: { 'x-forgebridge-link': client.linkId },
    });
    expect(response.status).toBe(401);
  });

  it('returns a sealed delivery that is already waiting', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);

    const response = await client.poll(0);
    expect(response.status).toBe(200);
    const envelope = response.json<{ linkId: string; nonce: number; payload: string; mac: string }>();
    expect(envelope.linkId).toBe(client.linkId);
    expect(envelope.nonce).toBe(1);
    expect(JSON.parse(envelope.payload)).toMatchObject({ kind: 'changeset', changeSet: { id: changeSetId } });
  });

  it('resolves early when a ChangeSet is approved while the poll is held', async () => {
    const daemon = await daemonFor({ pollTimeoutMs: 10_000 });
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    await submit(daemon, changeSet);

    const pending = client.poll(0);
    await waitFor(() => daemon.heldPolls === 1);

    const started = Date.now();
    expect((await approve(daemon, changeSet.id)).status).toBe(202);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(daemon.heldPolls).toBe(0);
  });

  it('returns 204 when the window closes with nothing to send', async () => {
    const daemon = await daemonFor({ pollTimeoutMs: 120 });
    const client = await pair(daemon);
    const response = await client.poll(0);
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(daemon.heldPolls).toBe(0);
  });

  it('releases the held request when the client disconnects', async () => {
    // A leaked waiter per poll is a dead daemon within the hour.
    const daemon = await daemonFor({ pollTimeoutMs: 60_000 });
    const client = await pair(daemon);
    const controller = new AbortController();

    const pending = client.poll(0, controller.signal).catch(() => undefined);
    await waitFor(() => daemon.heldPolls === 1);

    controller.abort();
    await pending;
    await waitFor(() => daemon.heldPolls === 0);
    expect(daemon.heldPolls).toBe(0);
  });

  it('does not re-send a delivery the consumer has already advanced past', async () => {
    const daemon = await daemonFor({ pollTimeoutMs: 120 });
    const { client } = await readyToDeliver(daemon);

    const first = await client.poll(0);
    const nonce = first.json<{ nonce: number }>().nonce;
    expect((await client.poll(nonce)).status).toBe(204);
  });

  it('refuses a cursor that is not a non-negative integer', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const response = await raw({
      port: client.port,
      method: 'GET',
      path: '/v1/link/poll?since=-3',
      headers: { 'x-forgebridge-link': client.linkId },
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /v1/changesets/:id/apply-result', () => {
  it('records the result and advances the project version', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);

    const result = makeApplyResult(changeSetId, { newVersion: 1 });
    const response = await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result);

    expect(response.status).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('applied');
    expect(await daemon.store.getProjectVersion(client.projectId)).toBe(1);
    expect((await daemon.store.getJournal(result.journalId))?.versionBefore).toBe(0);
  });

  it('records a partial apply as partial rather than as success', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);

    const result = makeApplyResult(changeSetId, {
      outcomes: [
        { index: 0, ok: true },
        { index: 1, ok: false, error: 'parent missing' },
      ],
    });
    const response = await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result);
    expect(response.json<{ status: string }>().status).toBe('partial');
  });

  it('rejects a tampered payload with 401', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);

    const result = makeApplyResult(changeSetId, { newVersion: 1 });
    const response = await client.postEnvelope(
      `/v1/changesets/${changeSetId}/apply-result`,
      1,
      result,
      // Rewrite the signed payload without touching the MAC.
      (body) => body.replace('\\"newVersion\\":1', '\\"newVersion\\":99'),
    );

    expect(response.status).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('link_unauthenticated');
    expect(await daemon.store.getProjectVersion(client.projectId)).toBe(0);
  });

  it('rejects a replayed envelope with 409 replay_detected', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);
    const result = makeApplyResult(changeSetId, { newVersion: 1 });

    expect((await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 2, result)).status).toBe(200);

    // Same nonce again, and an older one: both are replays.
    for (const nonce of [2, 1]) {
      const replay = await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, nonce, result);
      expect(replay.status).toBe(409);
      expect(replay.json<{ code: string }>().code).toBe('replay_detected');
    }
  });

  it('refuses a result for a changeset that was never approved', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    await submit(daemon, changeSet);

    const response = await client.postEnvelope(
      `/v1/changesets/${changeSet.id}/apply-result`,
      1,
      makeApplyResult(changeSet.id),
    );
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('not_approved');
  });

  it('refuses a result whose changeset id disagrees with the path', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);
    const response = await client.postEnvelope(
      `/v1/changesets/${changeSetId}/apply-result`,
      1,
      makeApplyResult(randomUUID()),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /v1/changesets/:id/diff', () => {
  it('describes every operation and says plainly that it is not tree-aware', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    await submit(daemon, changeSet);

    const response = await raw({
      port: portOf(daemon),
      method: 'GET',
      path: `/v1/changesets/${changeSet.id}/diff`,
      headers: producerHeaders(daemon),
    });
    const diff = response.json<{
      counts: { total: number; scripts: number };
      operations: { summary: string; destructive: boolean; after?: string }[];
      treeAware: boolean;
      stale: boolean;
    }>();

    expect(response.status).toBe(200);
    expect(diff.counts).toMatchObject({ total: 1, scripts: 1 });
    expect(diff.operations[0]?.destructive).toBe(false);
    expect(diff.operations[0]?.after).toBe('print("hello")');
    expect(diff.treeAware).toBe(false);
    expect(diff.stale).toBe(false);
  });

  it('404s an unknown changeset', async () => {
    const daemon = await daemonFor();
    const response = await raw({
      port: portOf(daemon),
      method: 'GET',
      path: `/v1/changesets/${randomUUID()}/diff`,
      headers: producerHeaders(daemon),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /v1/journal/:id/rollback', () => {
  it('dispatches a rollback to the paired consumer', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);
    const result = makeApplyResult(changeSetId, { newVersion: 1 });
    await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result);

    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      headers: producerHeaders(daemon),
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1, reason: 'undo' }),
    });

    expect(response.status).toBe(202);
    expect(response.json<{ status: string }>().status).toBe('dispatched');

    const delivered = await client.poll(1);
    expect(JSON.parse(delivered.json<{ payload: string }>().payload)).toMatchObject({
      kind: 'rollback',
      journalId: result.journalId,
    });

    // Dispatched is not done: only the consumer holding the inverses can say so.
    expect((await daemon.store.getJournal(result.journalId))?.rolledBackAt).toBeNull();
  });

  it('refuses a rollback against a version the project has moved past', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);
    const result = makeApplyResult(changeSetId, { newVersion: 1 });
    await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result);

    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      headers: producerHeaders(daemon),
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 0 }),
    });
    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('stale_base');
  });
});

describe('/v1/output', () => {
  it('mirrors the Studio console back to producers', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);

    const posted = await client.postEnvelope('/v1/output', 1, {
      messages: [{ level: 'warning', message: 'attempt to index nil', at: new Date().toISOString() }],
    });
    expect(posted.status).toBe(204);

    const read = await raw({
      port: client.port,
      method: 'GET',
      path: '/v1/output',
      headers: producerHeaders(daemon),
    });
    expect(read.json<{ messages: { message: string }[] }>().messages[0]?.message).toBe('attempt to index nil');
  });

  it('refuses output from an unauthenticated caller', async () => {
    const daemon = await daemonFor();
    await pair(daemon);
    const response = await raw({
      port: portOf(daemon),
      method: 'POST',
      path: '/v1/output',
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(401);
  });
});

describe('GET /v1/models', () => {
  it('says it has no registry rather than implying an empty catalog', async () => {
    const daemon = await daemonFor();
    const response = await raw({ port: portOf(daemon), method: 'GET', path: '/v1/models' });
    const body = response.json<{ configured: boolean; models: unknown[] }>();
    expect(response.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.models).toEqual([]);
  });

  it('serves whatever the registry port returns', async () => {
    const daemon = await daemonFor({
      models: {
        async snapshot() {
          return {
            configured: true,
            source: 'test registry',
            verifiedAt: new Date().toISOString(),
            models: [{ id: 'test:model', free: true }],
          };
        },
      },
    });
    const response = await raw({ port: portOf(daemon), method: 'GET', path: '/v1/models' });
    expect(response.json<{ models: { id: string }[] }>().models[0]?.id).toBe('test:model');
  });
});

describe('routing', () => {
  it('404s an unknown path without saying anything about the daemon', async () => {
    const daemon = await daemonFor();
    const response = await raw({ port: portOf(daemon), method: 'GET', path: '/v1/nope' });
    expect(response.status).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('not_found');
  });

  it('404s a known path used with the wrong method', async () => {
    const daemon = await daemonFor();
    expect((await raw({ port: portOf(daemon), method: 'POST', path: '/v1/health', body: '{}' })).status).toBe(404);
  });
});

describe('validation', () => {
  it('discards the producer\'s verdict and computes its own', async () => {
    // The fixture claims { luau: ok, policy: ok } and names itself as the
    // computer. Believing any of that is believing the caller the check exists
    // to defend against (PROTOCOL invariant 4, THREAT-MODEL T2 layers 2 and 3).
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    const response = await submit(daemon, changeSet);

    expect(response.status).toBe(201);
    const stored = await daemon.store.getChangeSet(changeSet.id);
    expect(stored?.validation?.computedBy).toBe(`forgebridge-daemon@${DAEMON_VERSION}`);
    expect(stored?.validation?.computedBy).not.toBe(okValidation.computedBy);
  });

  it('will not let a producer clear its own set past the path policy', async () => {
    // The whole finding in one test: a set that writes outside the allowlist,
    // carrying a producer-authored "policy: ok". Without a daemon-side verdict
    // this is approved and delivered.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({
      projectId: client.projectId,
      operations: [
        { op: 'writeScript', path: 'StarterGui.Admin', scriptType: 'LocalScript', source: 'print(1)' },
      ],
      validation: okValidation,
    });

    expect((await submit(daemon, changeSet)).status).toBe(201);
    const stored = await daemon.store.getChangeSet(changeSet.id);
    expect(stored?.validation?.policy.status).toBe('fail');
    expect(stored?.validation?.policy.violations.join(' ')).toContain('StarterGui.Admin');

    const approved = await approve(daemon, changeSet.id);
    expect(approved.status).toBe(403);
    expect(approved.json<{ code: string }>().code).toBe('policy_violation');
    expect((await daemon.store.getChangeSet(changeSet.id))?.status).not.toBe('approved');
  });

  it('sees a path that appears only inside a property value', async () => {
    // `pathsOf` reports InstanceRef targets, and the policy check is what makes
    // that matter: the operation itself is inside the allowlist and only the
    // reference reaches out of it.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'setProperty',
          path: 'Workspace.Sign',
          property: 'Adornee',
          value: { t: 'InstanceRef', path: 'Lighting.Secret' },
        },
      ],
    });

    expect((await submit(daemon, changeSet)).status).toBe(201);
    const stored = await daemon.store.getChangeSet(changeSet.id);
    expect(stored?.validation?.policy.status).toBe('fail');
    expect(stored?.validation?.policy.violations.join(' ')).toContain('Lighting.Secret');
  });

  it('reports Luau as unanalysed rather than inheriting an "ok" it did not compute', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    await submit(daemon, changeSet);

    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau.status).toBe('warn');
    expect(validation?.luau.findings[0]?.rule).toBe('luau/not-analysed');
  });

  it('treats Source written as a property as Luau source too', async () => {
    // Same act as writeScript by another route; an analyser gate that only saw
    // writeScript would have a door beside it.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'setProperty',
          path: 'ServerScriptService.Shop',
          property: 'Source',
          value: { t: 'String', v: 'while true do end' },
        },
      ],
    });
    await submit(daemon, changeSet);

    expect((await daemon.store.getChangeSet(changeSet.id))?.validation?.luau.status).toBe('warn');
  });

  it('reports Luau as ok when the set carries no source at all', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [{ op: 'moveInstance', path: 'Workspace.Crate', to: 'Workspace.Storage.Crate' }],
    });
    await submit(daemon, changeSet);

    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau).toEqual({ status: 'ok', findings: [] });
  });

  it('refuses everything for a project with no configured policy', async () => {
    // Missing configuration reads as deny. An unconfigured daemon that applied
    // anything would be running the policy layer with the check switched off.
    const daemon = await daemonFor({ policy: DENY_ALL_POLICY });
    const changeSet = makeChangeSet();
    const response = await submit(daemon, changeSet);

    expect(response.status).toBe(201);
    const validation = response.json<{ validation: { policy: { status: string; violations: string[] } } }>()
      .validation;
    expect(validation.policy.status).toBe('fail');
    expect(validation.policy.violations.join(' ')).toContain('allowedPathPrefixes');
  });

  it('prefers a policy stored for the project over the daemon default', async () => {
    const daemon = await daemonFor({ policy: DENY_ALL_POLICY });
    const changeSet = makeChangeSet();
    await daemon.store.setProjectPolicy(changeSet.projectId, {
      allowedPathPrefixes: ['ServerScriptService'],
      autoApply: null,
    });

    await submit(daemon, changeSet);
    expect((await daemon.store.getChangeSet(changeSet.id))?.validation?.policy.status).toBe('ok');
  });

  it('refuses a setProperty on a structural property at the wire', async () => {
    // Setting Parent moves a subtree while reporting only its source path,
    // which walks past the allowlist, the bulk-delete counter and the
    // auto-apply exclusion at once. The protocol refuses it; this asserts the
    // daemon does not accept one through some other door.
    const daemon = await daemonFor();
    for (const property of STRUCTURAL_PROPERTIES) {
      const response = await raw({
        port: portOf(daemon),
        method: 'POST',
        path: '/v1/changesets',
        headers: producerHeaders(daemon),
        body: JSON.stringify({
          id: randomUUID(),
          projectId: randomUUID(),
          baseVersion: 0,
          summary: 'sneak a reparent past the gates',
          operations: [
            { op: 'setProperty', path: 'Workspace.Crate', property, value: { t: 'String', v: 'Lighting' } },
          ],
          createdAt: new Date().toISOString(),
        }),
      });
      expect(response.status, property).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('invalid_request');
    }
  });
});

describe('producer authentication', () => {
  it('refuses a submit with no token', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    const response = await raw({
      port: portOf(daemon),
      method: 'POST',
      path: '/v1/changesets',
      body: JSON.stringify(changeSet),
    });

    expect(response.status).toBe(401);
    expect(await daemon.store.getChangeSet(changeSet.id)).toBeNull();
  });

  it('refuses an approve with no token, and does not approve it', async () => {
    // The one that matters most: approval is the layer ADR-012 puts between a
    // model and the user's place. Any process on the box could reach it.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    await submit(daemon, changeSet);

    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/changesets/${changeSet.id}/approve`,
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect((await daemon.store.getChangeSet(changeSet.id))?.status).toBe('validated');
    expect(await daemon.store.nextDelivery(client.linkId, 0)).toBeNull();
  });

  it('refuses a rollback with no token, and dispatches nothing', async () => {
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);
    const result = makeApplyResult(changeSetId, { newVersion: 1 });
    await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result);

    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1 }),
    });

    expect(response.status).toBe(401);
    expect((await daemon.store.getJournal(result.journalId))?.rollbackRequestedAt).toBeNull();
  });

  it('refuses a console read with no token', async () => {
    const daemon = await daemonFor();
    const client = await pair(daemon);
    await client.postEnvelope('/v1/output', 1, {
      messages: [{ level: 'print', message: 'secret from the place', at: new Date().toISOString() }],
    });

    const response = await raw({ port: client.port, method: 'GET', path: '/v1/output' });
    expect(response.status).toBe(401);
    expect(response.body).not.toContain('secret from the place');
  });

  it('refuses a token that is wrong, and one that is merely a prefix of the right one', async () => {
    const daemon = await daemonFor();
    for (const token of ['', 'not-the-token', daemon.producerToken.slice(0, -1), `${daemon.producerToken}x`]) {
      const response = await raw({
        port: portOf(daemon),
        method: 'POST',
        path: '/v1/changesets',
        headers: { 'x-forgebridge-token': token },
        body: JSON.stringify(makeChangeSet()),
      });
      expect(response.status, JSON.stringify(token)).toBe(401);
    }
  });

  it('mints a distinct token per process and never serves it', async () => {
    const first = await daemonFor();
    const second = await daemonFor();
    expect(first.producerToken).not.toBe(second.producerToken);

    for (const path of ['/v1/health', '/v1/link']) {
      const response = await raw({ port: portOf(first), method: 'GET', path });
      expect(response.body).not.toContain(first.producerToken);
    }
  });

  it('leaves the consumer routes on the MAC, not on the token', async () => {
    // The plugin has no producer token and must never need one: poll,
    // apply-result and output are authenticated by the pairing-derived key.
    const daemon = await daemonFor({ pollTimeoutMs: 120 });
    const { client } = await readyToDeliver(daemon);
    expect((await client.poll(0)).status).toBe(200);
  });
});

describe('journal integrity', () => {
  it('refuses a second apply result that reuses an earlier journal id', async () => {
    // The journal is the route back from an apply. Overwriting one destroys the
    // only handle on the inverses the consumer captured (THREAT-MODEL T2).
    const daemon = await daemonFor();
    const { client, changeSetId } = await readyToDeliver(daemon);
    const first = makeApplyResult(changeSetId, { newVersion: 1 });
    expect((await client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, first)).status).toBe(200);

    const second = makeChangeSet({ projectId: client.projectId, baseVersion: 1 });
    expect((await submit(daemon, second)).status).toBe(201);
    expect((await approve(daemon, second.id)).status).toBe(202);

    const reused = makeApplyResult(second.id, { newVersion: 2, journalId: first.journalId });
    const response = await client.postEnvelope(`/v1/changesets/${second.id}/apply-result`, 2, reused);

    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');

    // The first journal still points at the apply it was captured for, and
    // nothing else moved on the way to the refusal.
    const journal = await daemon.store.getJournal(first.journalId);
    expect(journal?.changeSetId).toBe(changeSetId);
    expect(journal?.versionAfter).toBe(1);
    expect(await daemon.store.getProjectVersion(client.projectId)).toBe(1);
  });
});

describe('inbound nonce', () => {
  it('accepts exactly one of two identical envelopes in flight at once', async () => {
    // Replay rejection is a compare-and-swap or it is nothing. A store that
    // yields between reading the watermark and writing it — which any adapter
    // doing real I/O does — must still admit only one of these.
    const daemon = await daemonFor({ store: new SlowNonceStore() });
    const { client, changeSetId } = await readyToDeliver(daemon);
    const result = makeApplyResult(changeSetId, { newVersion: 1 });

    const [a, b] = await Promise.all([
      client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result),
      client.postEnvelope(`/v1/changesets/${changeSetId}/apply-result`, 1, result),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const replayed = a.status === 409 ? a : b;
    expect(replayed.json<{ code: string }>().code).toBe('replay_detected');
    expect(await daemon.store.getProjectVersion(client.projectId)).toBe(1);
  });
});

describe('error payloads', () => {
  it('keeps a schema failure inside the size its own schema allows', async () => {
    // Zod messages quote the input: the offending property key is interpolated
    // verbatim, and nothing bounded it before it was rejected.
    const daemon = await daemonFor();
    const response = await raw({
      port: portOf(daemon),
      method: 'POST',
      path: '/v1/changesets',
      headers: producerHeaders(daemon),
      body: JSON.stringify({
        id: randomUUID(),
        projectId: randomUUID(),
        baseVersion: 0,
        summary: 'oversized property name',
        operations: [
          {
            op: 'createInstance',
            path: 'Workspace.Crate',
            className: 'Part',
            properties: { [`a-${'x'.repeat(5_000)}`]: { t: 'Bool', v: true } },
          },
        ],
        createdAt: new Date().toISOString(),
      }),
    });

    expect(response.status).toBe(400);
    const body = response.json<ProtocolError>();
    expect(ProtocolError.safeParse(body).success).toBe(true);
    expect(body.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  });
});

/**
 * A store that awaits before every read of, and every claim on, the inbound
 * watermark — the way any adapter talking to a database does. It exists to make
 * the interleaving deterministic rather than incidental: both requests are
 * inside the critical region before either leaves it.
 */
class SlowNonceStore extends InMemoryDaemonStore {
  /** A read whose value is in hand well before the caller acts on it. */
  override async lastInboundNonce(linkId: string): Promise<number> {
    const watermark = await super.lastInboundNonce(linkId);
    await tick();
    return watermark;
  }

  /** A claim that takes a round trip to reach the thing that is atomic. */
  override async tryAdvanceInboundNonce(linkId: string, nonce: number): Promise<boolean> {
    await tick();
    return super.tryAdvanceInboundNonce(linkId, nonce);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
