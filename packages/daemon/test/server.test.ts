import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { DENY_ALL_POLICY } from '@forgebridge/core';
import { LIMITS, PROTOCOL_VERSION, ProtocolError, STRUCTURAL_PROPERTIES, Validation } from '@forgebridge/protocol';
import type { ApplyResult, ChangeSet } from '@forgebridge/protocol';
import { LOOPBACK_HOST, MAX_ERROR_MESSAGE_CHARS } from '../src/http.js';
import { InMemoryDaemonStore } from '../src/store.js';
import { DAEMON_VERSION, type ForgeBridgeDaemon } from '../src/server.js';
import {
  approve,
  diff,
  renderedDigest,
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

  it('refuses a second submission that reuses an existing changeset id', async () => {
    // The producer-controlled half of a complete review bypass: overwriting let
    // a set be swapped after a human read its diff and before the approval
    // landed. The id is write-once now, the way a journal id is.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    expect((await submit(daemon, changeSet)).status).toBe(201);

    const swapped = makeChangeSet({
      id: changeSet.id,
      projectId: changeSet.projectId,
      summary: changeSet.summary,
      operations: [
        {
          op: 'createInstance',
          path: 'ServerScriptService.Shop',
          className: 'Script',
          properties: { Source: { t: 'String', v: 'print("pwned")' } },
        },
      ],
    });
    const response = await submit(daemon, swapped);

    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');
    expect((await daemon.store.getChangeSet(changeSet.id))?.operations).toEqual(changeSet.operations);
  });

  it('accepts the same work proposed again under a fresh id', async () => {
    // The control, and the shape write-once is most confusable with: a producer
    // that rebuilt or re-proposed identical operations is doing something
    // ordinary. Only the *id* is spent, not the content.
    const daemon = await daemonFor();
    const first = makeChangeSet();
    expect((await submit(daemon, first)).status).toBe(201);

    const again = makeChangeSet({ projectId: first.projectId, operations: first.operations });
    expect((await submit(daemon, again)).status).toBe(201);
    expect((await daemon.store.getChangeSet(again.id))?.operations).toEqual(first.operations);
  });

  it('cannot be used to reset an already-approved set back to approvable', async () => {
    // Resubmission did not only swap content: it put `status` back to
    // `validated`, so an approved, applying or applied set became approvable
    // again — a second delivery of work that was cleared once.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    expect((await submit(daemon, changeSet)).status).toBe(201);
    expect((await approve(daemon, changeSet.id)).status).toBe(202);

    expect((await submit(daemon, changeSet)).status).toBe(400);
    expect((await daemon.store.getChangeSet(changeSet.id))?.status).toBe('approved');
    // One delivery, from the one approval.
    expect(await daemon.store.lastOutboundNonce(client.linkId)).toBe(1);
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

/**
 * A store that will write a ChangeSet twice — the seam an adapter, a fixture or
 * a future ingress would arrive by.
 *
 * `POST /v1/changesets` refuses a reused id and `InMemoryDaemonStore` refuses
 * an overwrite, so this is the only way left to ask the question the content
 * digest exists to answer: if the stored operations *did* move under an id a
 * human had already reviewed, would the approval still go through? Id
 * uniqueness is the fix for the route that exists today; the digest is what
 * holds when a route that does not exist yet is added.
 */
class SwappableStore extends InMemoryDaemonStore {
  readonly #swapped = new Map<string, ChangeSet>();

  swap(changeSet: ChangeSet): void {
    this.#swapped.set(changeSet.id, changeSet);
  }

  override async getChangeSet(id: string): Promise<ChangeSet | null> {
    return this.#swapped.get(id) ?? (await super.getChangeSet(id));
  }
}

describe('approval is bound to the content that was reviewed', () => {
  it('refuses an approve that carries no contentDigest at all', async () => {
    // Required with no default: an approval that names only an id is a
    // statement about a name, and names are not content.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    await submit(daemon, changeSet);

    const response = await approve(daemon, changeSet.id, { contentDigest: undefined });
    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');
    expect((await daemon.store.getChangeSet(changeSet.id))?.status).toBe('validated');
    expect(await daemon.store.nextDelivery(client.linkId, 0)).toBeNull();
  });

  it('refuses an approve whose digest is for other content', async () => {
    // A stale digest: the approver read one page and the digest they echoed
    // describes a different one. Whichever way round that happened, the yes
    // does not cover what is stored.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const reviewed = makeChangeSet({ projectId: client.projectId });
    const other = makeChangeSet({
      projectId: client.projectId,
      operations: [
        { op: 'writeScript', path: 'ServerScriptService.Other', scriptType: 'Script', source: 'print("other")' },
      ],
    });
    await submit(daemon, reviewed);
    await submit(daemon, other);

    const response = await approve(daemon, reviewed.id, { contentDigest: await renderedDigest(daemon, other.id) });

    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');
    expect((await daemon.store.getChangeSet(reviewed.id))?.status).toBe('validated');
    expect(await daemon.store.nextDelivery(client.linkId, 0)).toBeNull();
  });

  it('approves on the digest the diff reported, and reports the same digest every time', async () => {
    // The control, and the property that makes the requirement satisfiable: a
    // digest that churned between two reads of the same unchanged set would
    // fail every honest approval, and the field would be deleted within a week.
    const daemon = await daemonFor();
    const client = await pair(daemon);
    const changeSet = makeChangeSet({ projectId: client.projectId });
    await submit(daemon, changeSet);

    const first = await renderedDigest(daemon, changeSet.id);
    const second = await renderedDigest(daemon, changeSet.id);
    expect(first).toBeDefined();
    expect(second).toBe(first);

    expect((await approve(daemon, changeSet.id, { contentDigest: first })).status).toBe(202);
    expect((await daemon.store.getChangeSet(changeSet.id))?.status).toBe('approved');
  });

  it('refuses the approval when the stored content moved under the reviewed id', async () => {
    // The digest layer on its own, with the id layer taken out of the picture
    // by a store that permits the swap. This is the regression the id check
    // cannot cover: a future code path that updates a set in place.
    const store = new SwappableStore();
    const daemon = await daemonFor({ store });
    const client = await pair(daemon);
    const reviewed = makeChangeSet({ projectId: client.projectId });
    await submit(daemon, reviewed);

    const digest = await renderedDigest(daemon, reviewed.id);

    store.swap(
      makeChangeSet({
        id: reviewed.id,
        projectId: reviewed.projectId,
        summary: reviewed.summary,
        operations: [
          {
            op: 'createInstance',
            path: 'ServerScriptService.Shop',
            className: 'Script',
            properties: { Source: { t: 'String', v: 'print("pwned")' } },
          },
        ],
        validation: okValidation,
      }),
    );

    const response = await approve(daemon, reviewed.id, { contentDigest: digest });
    expect(response.status).toBe(400);
    expect(await daemon.store.nextDelivery(client.linkId, 0)).toBeNull();
  });

  it('blocks the whole swap: submit, diff, re-submit, approve', async () => {
    // The two findings combined, replayed end to end. Benign set in, diff read
    // by a human, malicious set re-submitted under the same id, approval landed
    // on the digest the human was shown.
    const daemon = await daemonFor();
    const client = await pair(daemon);

    // 1. A benign proposal: one property write, no code.
    const proposal = makeChangeSet({
      projectId: client.projectId,
      summary: 'make the platform solid',
      operations: [
        { op: 'setProperty', path: 'Workspace.Platform', property: 'Anchored', value: { t: 'Bool', v: true } },
      ],
    });
    expect((await submit(daemon, proposal)).status).toBe(201);

    // 2. The human reads the diff. No Luau on the page, and a digest of it.
    const reviewed = (await diff(daemon, proposal.id)).json<{
      counts: { scripts: number };
      contentDigest: string;
      operations: { after?: string }[];
    }>();
    expect(reviewed.counts.scripts).toBe(0);
    expect(reviewed.operations[0]?.after).toBe('{"t":"Bool","v":true}');

    // 3. The producer re-submits the same id carrying a Script instead.
    const swap = await submit(
      daemon,
      makeChangeSet({
        id: proposal.id,
        projectId: proposal.projectId,
        summary: proposal.summary,
        operations: [
          {
            op: 'createInstance',
            path: 'ServerScriptService.Shop',
            className: 'Script',
            properties: { Source: { t: 'String', v: 'print("pwned")' } },
          },
        ],
      }),
    );
    expect(swap.status).toBe(400);

    // 4. The approval lands on the digest the human was shown, and clears the
    //    set the human actually read.
    expect((await approve(daemon, proposal.id, { contentDigest: reviewed.contentDigest })).status).toBe(202);

    const delivery = await daemon.store.nextDelivery(client.linkId, 0);
    expect(delivery?.payload).toMatchObject({ kind: 'changeset', changeSet: { operations: proposal.operations } });
    expect(JSON.stringify(delivery?.payload)).not.toContain('pwned');
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

  it('renders a createInstance that carries Source as script content, and counts it', async () => {
    // The reviewed half of the bypass: this operation installs Luau exactly as
    // writeScript does, and the diff used to render it as one line naming a
    // class and a path — `counts.scripts: 0`, no source text anywhere on the
    // page. A human approving that is approving nothing (ADR-012).
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'createInstance',
          path: 'ServerScriptService.Shop',
          className: 'Script',
          properties: {
            Source: { t: 'String', v: 'print("pwned")' },
            Disabled: { t: 'Bool', v: false },
          },
        },
      ],
    });
    await submit(daemon, changeSet);

    const response = await diff(daemon, changeSet.id);
    const rendered = response.json<{
      counts: { total: number; creates: number; scripts: number };
      operations: { summary: string; after?: string; properties?: Record<string, string> }[];
    }>();

    expect(response.status).toBe(200);
    expect(rendered.counts).toMatchObject({ total: 1, creates: 1, scripts: 1 });
    // Shown the same way writeScript's source is shown: raw Luau, in `after`.
    expect(rendered.operations[0]?.after).toBe('print("pwned")');
    // The same rendering setProperty's `after` uses — the tagged PropertyValue,
    // not a coerced primitive, so a reviewer sees the datatype as well as the value.
    expect(rendered.operations[0]?.properties).toEqual({ Disabled: '{"t":"Bool","v":false}' });
    expect(rendered.operations[0]?.summary).toContain('Source');
  });

  it('counts a setProperty on Source as a script too', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'setProperty',
          path: 'ServerScriptService.Shop',
          property: 'Source',
          value: { t: 'String', v: 'print("hi")' },
        },
      ],
    });
    await submit(daemon, changeSet);

    const rendered = (await diff(daemon, changeSet.id)).json<{ counts: { scripts: number } }>();
    expect(rendered.counts.scripts).toBe(1);
  });

  it('does not count a createInstance that carries no Source as a script', async () => {
    // The control, and it holds both before and after the fix: fail-closed must
    // not mean fail-noisy. A diff that called every createInstance a script
    // would teach reviewers that the script count means nothing, which lands in
    // the same place as reporting zero for one that really carries code.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'createInstance',
          path: 'Workspace.Platform',
          className: 'Part',
          properties: { Anchored: { t: 'Bool', v: true } },
        },
      ],
    });
    await submit(daemon, changeSet);

    const rendered = (await diff(daemon, changeSet.id)).json<{
      counts: { creates: number; scripts: number };
      operations: { after?: string }[];
    }>();

    expect(rendered.counts).toMatchObject({ creates: 1, scripts: 0 });
    expect(rendered.operations[0]?.after).toBeUndefined();
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

/**
 * The journal entry a plugin uploads after an apply: the inverses it captured
 * before it touched anything, paired one-to-one with the operations that ran.
 *
 * Built from the ChangeSet the daemon actually holds rather than from a literal,
 * because `recordJournalEntry` compares the two — a fixture that invented its
 * own operation would be testing the refusal path while claiming to test the
 * happy one.
 */
function journalEntryFor(
  client: PairedClient,
  changeSet: ChangeSet,
  result: ApplyResult,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: result.journalId,
    projectId: client.projectId,
    changeSetId: changeSet.id,
    summary: changeSet.summary,
    applied: changeSet.operations.map((operation, index) => ({ index, operation })),
    inverses: changeSet.operations.map((operation) => ({
      inverse: 'restoreSource',
      path: operation.path,
      previousSource: 'print("v1")',
    })),
    versionBefore: 0,
    versionAfter: result.newVersion,
    appliedAt: result.appliedAt,
    rolledBackAt: null,
    ...overrides,
  };
}

/** Apply, then upload the inverses — the sequence a plugin performs. */
async function applied(
  daemon: ForgeBridgeDaemon,
): Promise<{ client: PairedClient; changeSet: ChangeSet; result: ApplyResult }> {
  const client = await pair(daemon);
  const changeSet = makeChangeSet({ projectId: client.projectId });
  expect((await submit(daemon, changeSet)).status).toBe(201);
  expect((await approve(daemon, changeSet.id)).status).toBe(202);
  const result = makeApplyResult(changeSet.id, { newVersion: 1 });
  expect((await client.postEnvelope(`/v1/changesets/${changeSet.id}/apply-result`, 1, result)).status).toBe(200);
  return { client, changeSet, result };
}

describe('POST /v1/journal/:id/entry', () => {
  it('takes the inverses off the Studio session that captured them', async () => {
    // The half of M11 that needed no protocol addition. Before this route the
    // inverses stayed inside the session that captured them, so closing Studio
    // was the end of the road back from an apply.
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);

    const response = await client.postEnvelope(
      `/v1/journal/${result.journalId}/entry`,
      2,
      journalEntryFor(client, changeSet, result),
    );
    expect(response.status).toBe(200);
    expect(response.json<{ inverses: number }>().inverses).toBe(changeSet.operations.length);
  });

  it('refuses an entry whose id is not the one in the path', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);
    const response = await client.postEnvelope(
      `/v1/journal/${randomUUID()}/entry`,
      2,
      journalEntryFor(client, changeSet, result),
    );
    expect(response.status).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('does not match the journal in the path');
  });

  it('refuses an unauthenticated upload — this record decides what is survivable', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);
    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/entry`,
      body: JSON.stringify(journalEntryFor(client, changeSet, result)),
    });
    expect(response.status).toBe(401);
  });
});

describe('POST /v1/journal/:id/rollback', () => {
  it('dispatches the inverses themselves, in replay order', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);
    await client.postEnvelope(`/v1/journal/${result.journalId}/entry`, 2, journalEntryFor(client, changeSet, result));

    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      headers: producerHeaders(daemon),
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1, reason: 'undo' }),
    });

    expect(response.status).toBe(202);
    expect(response.json<{ status: string; steps: number }>()).toMatchObject({ status: 'dispatched', steps: 1 });

    // The delivery carries the inverses now, not just the ids. That is what
    // makes a rollback survive the session that applied the change.
    const delivered = await client.poll(1);
    expect(JSON.parse(delivered.json<{ payload: string }>().payload)).toMatchObject({
      kind: 'rollback',
      journalId: result.journalId,
      restoresToVersion: 0,
      steps: [{ index: 0, inverse: { inverse: 'restoreSource', path: 'ServerScriptService.Shop' } }],
    });

    // Dispatched is not done: only the consumer that replays them can say so.
    expect((await daemon.store.getJournal(result.journalId))?.rolledBackAt).toBeNull();
  });

  it('refuses to dispatch a rollback whose inverses never reached this daemon', async () => {
    // Fail closed, and say which of the two problems it is. A daemon that
    // dispatched an empty reversal would have the user watching a rollback that
    // can never arrive; the refusal names the one route that might still work.
    const daemon = await daemonFor();
    const { client, result } = await applied(daemon);

    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      headers: producerHeaders(daemon),
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1 }),
    });
    expect(response.status).toBe(404);
    expect(response.json<{ message: string }>().message).toContain('no inverse operations on this daemon');
  });

  it('refuses a rollback against a version the project has moved past', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);
    await client.postEnvelope(`/v1/journal/${result.journalId}/entry`, 2, journalEntryFor(client, changeSet, result));

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

describe('POST /v1/journal/:id/rollback-result', () => {
  /** Dispatch a rollback and hand back what a consumer needs to report on it. */
  async function dispatched(daemon: ForgeBridgeDaemon) {
    const { client, changeSet, result } = await applied(daemon);
    await client.postEnvelope(`/v1/journal/${result.journalId}/entry`, 2, journalEntryFor(client, changeSet, result));
    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      headers: producerHeaders(daemon),
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1 }),
    });
    expect(response.status).toBe(202);
    return { client, changeSet, result };
  }

  function report(changeSet: ChangeSet, result: ApplyResult, outcomes: { index: number; ok: boolean; error?: string }[]) {
    return {
      journalId: result.journalId,
      changeSetId: changeSet.id,
      outcomes,
      newVersion: 2,
      rolledBackAt: new Date().toISOString(),
      pluginVersion: '0.1.0',
    };
  }

  it('closes the loop every surface above the daemon was saying "dispatched" about', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await dispatched(daemon);

    const response = await client.postEnvelope(
      `/v1/journal/${result.journalId}/rollback-result`,
      3,
      report(changeSet, result, [{ index: 0, ok: true }]),
    );
    expect(response.status).toBe(200);
    expect(response.json<{ state: string; version: number }>()).toMatchObject({ state: 'rolled_back', version: 2 });
    expect((await daemon.store.getJournal(result.journalId))?.rolledBackAt).not.toBeNull();
  });

  it('reports a partial reversal as partial and leaves rolledBackAt null', async () => {
    // The outcome that must never be rounded up. Half a tree restored is a state
    // neither the user nor the journal describes, and the inverses that would
    // have finished the job are spent.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("a")' },
        { op: 'writeScript', path: 'ServerScriptService.Till', scriptType: 'Script', source: 'print("b")' },
      ],
    });
    const client = await pair(daemon);
    const owned = makeChangeSet({ ...changeSet, projectId: client.projectId });
    expect((await submit(daemon, owned)).status).toBe(201);
    expect((await approve(daemon, owned.id)).status).toBe(202);
    const result = makeApplyResult(owned.id, {
      newVersion: 1,
      outcomes: [
        { index: 0, ok: true },
        { index: 1, ok: true },
      ],
    });
    await client.postEnvelope(`/v1/changesets/${owned.id}/apply-result`, 1, result);
    await client.postEnvelope(`/v1/journal/${result.journalId}/entry`, 2, journalEntryFor(client, owned, result));
    expect(
      (
        await raw({
          port: client.port,
          method: 'POST',
          path: `/v1/journal/${result.journalId}/rollback`,
          headers: producerHeaders(daemon),
          body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1 }),
        })
      ).status,
    ).toBe(202);

    const response = await client.postEnvelope(
      `/v1/journal/${result.journalId}/rollback-result`,
      3,
      report(owned, result, [
        { index: 0, ok: true },
        { index: 1, ok: false, error: 'the script was already gone' },
      ]),
    );
    expect(response.json<{ state: string }>().state).toBe('rollback_partial');
    expect((await daemon.store.getJournal(result.journalId))?.rolledBackAt).toBeNull();
  });

  it('refuses a reversal nobody asked for', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);
    await client.postEnvelope(`/v1/journal/${result.journalId}/entry`, 2, journalEntryFor(client, changeSet, result));

    const response = await client.postEnvelope(
      `/v1/journal/${result.journalId}/rollback-result`,
      3,
      report(changeSet, result, [{ index: 0, ok: true }]),
    );
    expect(response.status).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('no rollback was requested');
  });

  it('refuses an unauthenticated report — it is what stamps a journal reversed', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await dispatched(daemon);
    const response = await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback-result`,
      body: JSON.stringify(report(changeSet, result, [{ index: 0, ok: true }])),
    });
    expect(response.status).toBe(401);
    expect((await daemon.store.getJournal(result.journalId))?.rolledBackAt).toBeNull();
  });
});

describe('GET /v1/journal/:id', () => {
  it('walks a journal from applied to requested to rolled back', async () => {
    const daemon = await daemonFor();
    const { client, changeSet, result } = await applied(daemon);
    const read = async () =>
      (
        await raw({
          port: client.port,
          method: 'GET',
          path: `/v1/journal/${result.journalId}`,
          headers: producerHeaders(daemon),
        })
      ).json<{ state: string; inverses: number | null; result: { outcomes: unknown[] } | null }>();

    // Null, not zero: the inverses have not been uploaded, which is a different
    // fact from an apply with nothing to undo.
    expect(await read()).toMatchObject({ state: 'applied', inverses: null, result: null });

    await client.postEnvelope(`/v1/journal/${result.journalId}/entry`, 2, journalEntryFor(client, changeSet, result));
    expect((await read()).inverses).toBe(1);

    await raw({
      port: client.port,
      method: 'POST',
      path: `/v1/journal/${result.journalId}/rollback`,
      headers: producerHeaders(daemon),
      body: JSON.stringify({ journalId: result.journalId, expectedVersion: 1 }),
    });
    expect((await read()).state).toBe('rollback_requested');

    await client.postEnvelope(`/v1/journal/${result.journalId}/rollback-result`, 3, {
      journalId: result.journalId,
      changeSetId: changeSet.id,
      outcomes: [{ index: 0, ok: true }],
      newVersion: 2,
      rolledBackAt: new Date().toISOString(),
      pluginVersion: '0.1.0',
    });

    const final = await read();
    expect(final.state).toBe('rolled_back');
    // The consumer's own report, verbatim. A summary is not a record: the one
    // moment a user needs to know which inverse failed is the moment the rest
    // of them did not.
    expect(final.result?.outcomes).toEqual([{ index: 0, ok: true }]);
  });

  it('is producer surface — it names what changed in the user\'s place', async () => {
    const daemon = await daemonFor();
    const { client, result } = await applied(daemon);
    const response = await raw({
      port: client.port,
      method: 'GET',
      path: `/v1/journal/${result.journalId}`,
    });
    expect(response.status).toBe(401);
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

  it('refuses a loadstring rather than inheriting the "ok" the producer claimed', async () => {
    // `makeChangeSet` sends `validation: { luau: ok }` — a model marking its own
    // source clean. The daemon runs `@forgebridge/luau-analysis` itself and
    // stores that instead, which is the whole of THREAT-MODEL T2 layer 2.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'writeScript',
          path: 'ServerScriptService.Shop',
          scriptType: 'Script',
          source: 'local run = loadstring(payload)\nrun()\n',
        },
      ],
    });
    const response = await submit(daemon, changeSet);

    expect(response.status).toBe(201);
    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau.status).toBe('fail');
    expect(validation?.luau.findings.map((finding) => finding.rule)).toContain('luau/no-loadstring');
    // The instance path rides on the message, because a reviewer reading the
    // diff needs to know which script the finding is about.
    expect(validation?.luau.findings[0]?.message).toContain('ServerScriptService.Shop');
    expect(validation?.luau.findings[0]?.operationIndex).toBe(0);
  });

  it('will not approve a ChangeSet whose Luau failed', async () => {
    // The verdict is not advisory. `#approve` refuses a `fail`, so the analyser
    // is a gate on the apply path and not a note in the diff.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        {
          op: 'writeScript',
          path: 'ServerScriptService.Shop',
          scriptType: 'Script',
          source: 'local run = loadstring(payload)\nrun()\n',
        },
      ],
    });
    await submit(daemon, changeSet);

    const response = await approve(daemon, changeSet.id);
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('policy_violation');
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

    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau.status).toBe('fail');
    expect(validation?.luau.findings.map((finding) => finding.rule)).toContain('luau/while-true-no-yield');
  });

  it('refuses a Source it cannot read as Luau rather than passing it', async () => {
    // A non-string on `Source` leaves nothing to analyse. Reporting `ok` for
    // source that was never read is the one answer this layer must never give.
    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: [
        { op: 'setProperty', path: 'ServerScriptService.Shop', property: 'Source', value: { t: 'Nil' } },
      ],
    });
    await submit(daemon, changeSet);

    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau.status).toBe('fail');
    expect(validation?.luau.findings[0]?.rule).toBe('luau/source-not-readable');
  });

  it('reports Luau as ok for a script that passes every rule', async () => {
    const daemon = await daemonFor();
    const changeSet = makeChangeSet();
    await submit(daemon, changeSet);

    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau).toEqual({ status: 'ok', findings: [] });
  });

  it('keeps the verdict inside the bounds the protocol puts on Validation', async () => {
    // Both bounds are literals in `packages/protocol`, and both are reachable
    // from ordinary input: a path near the depth limit prefixed onto a finding
    // message can pass 2000 characters, and a few hundred bad scripts can pass
    // 1000 findings. A verdict that broke either would make the ChangeSet
    // unreadable on the next parse — the analyser finding too much wrong with a
    // set would be what destroyed it.
    const deep = ['ServerScriptService', ...Array.from({ length: 30 }, (_, i) => `Folder${'x'.repeat(90)}${i}`)]
      .join('.')
      .slice(0, 2000);
    const path = deep.slice(0, deep.lastIndexOf('.'));
    const source = `${'local x = loadstring("a")\n'.repeat(40)}`;

    const daemon = await daemonFor();
    const changeSet = makeChangeSet({
      operations: Array.from({ length: 40 }, () => ({
        op: 'writeScript' as const,
        path,
        scriptType: 'Script' as const,
        source,
      })),
    });
    await submit(daemon, changeSet);

    const validation = (await daemon.store.getChangeSet(changeSet.id))?.validation;
    expect(validation?.luau.status).toBe('fail');
    expect(validation?.luau.findings.length).toBeLessThanOrEqual(1000);
    expect(validation?.luau.findings.at(-1)?.rule).toBe('luau/findings-truncated');
    // The real schema is the assertion. If the contract's bounds move, this
    // fails here rather than the daemon storing something it cannot read back.
    expect(() => Validation.parse(validation)).not.toThrow();
    expect(changeSet.operations.length).toBeLessThanOrEqual(LIMITS.MAX_OPERATIONS);
  });

  it('reads the HttpService allowlist it was configured with', async () => {
    // Empty means none, so this proves the option is threaded through rather
    // than that the rule works — `packages/luau-analysis` owns the rule itself.
    const source = 'local http = game:GetService("HttpService")\nhttp:GetAsync("https://api.example.com/v1")\n';
    const operations = [{ op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source }];

    const closed = await daemonFor();
    const refused = makeChangeSet({ operations });
    await submit(closed, refused);
    expect((await closed.store.getChangeSet(refused.id))?.validation?.luau.status).not.toBe('ok');

    // Passed as a URL on purpose: the daemon normalises, so this is the same
    // allowlist entry as `api.example.com` rather than one matching nothing.
    const open = await daemonFor({ allowedHttpHosts: ['https://API.Example.com/v1'] });
    const allowed = makeChangeSet({ operations });
    await submit(open, allowed);
    expect((await open.store.getChangeSet(allowed.id))?.validation?.luau.status).toBe('ok');
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
