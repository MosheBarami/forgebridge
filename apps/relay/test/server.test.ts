import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIVACY_POSTURE } from '@forgebridge/protocol';
import { openEnvelope } from '../src/envelope.js';
import {
  consumerHeaders,
  envelopeBody,
  failingValidation,
  json,
  makeChangeSet,
  pairSession,
  pollHeaders,
  producerHeaders,
  startRelay,
  type PairedSession,
} from './helpers.js';
import type { ForgeBridgeRelay } from '../src/server.js';

/**
 * The relay end to end: mint a session, pair a consumer, propose, review,
 * approve, deliver, apply, journal, reverse.
 *
 * These are the paths ADR-012 is about. Each one is here because skipping it
 * would leave a step of the approval gate unexercised, and the gate is the
 * whole safety story for a transport that writes into a place someone may have
 * spent months on.
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function relayAndSession(): Promise<{ relay: ForgeBridgeRelay; base: string; session: PairedSession }> {
  const started = await startRelay();
  open.push(started.close);
  const session = await pairSession(started.relay, started.base);
  return { relay: started.relay, base: started.base, session };
}

describe('the transport says what it is', () => {
  it('serves the protocol’s own privacy posture, verbatim, on health and link', async () => {
    const { base, session } = await relayAndSession();

    const health = await json(await fetch(`${base}/v1/health`));
    expect(health.service).toBe('forgebridge-relay');
    expect(health.transport).toBe('relay-tls');
    // Verbatim, from `PRIVACY_POSTURE`. Not paraphrased, not softened, and not
    // replaced by a padlock — this is the string ADR-014 requires the UI to
    // render for this transport.
    expect(health.privacyPosture).toBe('Relay — the relay operator can read your changes');
    expect(health.privacyPosture).toBe(PRIVACY_POSTURE['relay-tls']);

    const link = await json(await fetch(`${base}/v1/link`, { headers: producerHeaders(session) }));
    expect(link.transport).toBe('relay-tls');
    expect(link.privacyPosture).toBe(PRIVACY_POSTURE['relay-tls']);
  });

  it('never describes itself as end-to-end encrypted, and seals nothing (M19, ADR-014)', async () => {
    const { base, session } = await relayAndSession();
    const health = JSON.stringify(await json(await fetch(`${base}/v1/health`)));
    expect(health.toLowerCase()).not.toContain('end-to-end');
    expect(health.toLowerCase()).not.toContain('e2e');

    // And the wire agrees with the words: a delivery is authenticated, not
    // encrypted, and `encrypted` stays false until M19 exists.
    const set = makeChangeSet({ projectId: session.projectId });
    await fetch(`${base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(set),
    });
    const diff = await json(await fetch(`${base}/v1/changesets/${set.id as string}/diff`, { headers: producerHeaders(session) }));
    await fetch(`${base}/v1/changesets/${set.id as string}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: diff.contentDigest }),
    });
    const delivery = await json(await fetch(`${base}/v1/link/poll?since=0`, { headers: pollHeaders(session, 0) }));
    expect(delivery.encrypted).toBe(false);
  });

  it('reports that it computed no validation', async () => {
    const { base } = await relayAndSession();
    const health = await json(await fetch(`${base}/v1/health`));
    expect((health.validation as { computedHere: boolean }).computedHere).toBe(false);
  });
});

describe('propose → review → approve → deliver → apply', () => {
  it('carries a ChangeSet to a paired consumer and records the result', async () => {
    const { base, session } = await relayAndSession();
    const set = makeChangeSet({ projectId: session.projectId });
    const id = set.id as string;

    const submitted = await fetch(`${base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(set),
    });
    expect(submitted.status).toBe(201);
    const submitBody = await json(submitted);
    expect(submitBody.status).toBe('validated');
    // The relay carried the verdict; it did not make it.
    expect(submitBody.validationWitnessedHere).toBe(false);

    const diff = await json(await fetch(`${base}/v1/changesets/${id}/diff`, { headers: producerHeaders(session) }));
    expect(diff.validationWitnessedHere).toBe(false);
    // The count that has been got wrong three times in this repository: a
    // `writeScript` is code, and so is a `createInstance` carrying `Source`.
    expect((diff.counts as { scripts: number }).scripts).toBe(1);
    expect((diff.operations as Array<{ after?: string }>)[0]?.after).toBe('print("hello")');

    const approved = await fetch(`${base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: diff.contentDigest }),
    });
    expect(approved.status).toBe(202);

    const polled = await fetch(`${base}/v1/link/poll?since=0`, { headers: pollHeaders(session, 0) });
    expect(polled.status).toBe(200);
    const envelope = await polled.json();
    const opened = openEnvelope(session.sessionKey, envelope, { linkId: session.linkId });
    const payload = opened.payload as { kind: string; changeSet: { id: string } };
    expect(payload.kind).toBe('changeset');
    expect(payload.changeSet.id).toBe(id);

    const journalId = randomUUID();
    const result = {
      changeSetId: id,
      outcomes: [{ index: 0, ok: true }],
      newVersion: 1,
      journalId,
      appliedAt: new Date(0).toISOString(),
      pluginVersion: '1.0.0',
    };
    const reported = await fetch(`${base}/v1/apply-result`, {
      method: 'POST',
      headers: consumerHeaders(session),
      body: envelopeBody(session, 1, result),
    });
    expect(reported.status).toBe(200);
    expect((await json(reported)).status).toBe('applied');
  });

  it('refuses an approval whose digest is not the digest of what is stored', async () => {
    const { base, session } = await relayAndSession();
    const set = makeChangeSet({ projectId: session.projectId });
    await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) });

    const refused = await fetch(`${base}/v1/changesets/${set.id as string}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: 'not-the-digest' }),
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).code).toBe('invalid_request');
  });

  it('refuses to deliver a set whose verdict says fail', async () => {
    const { base, session } = await relayAndSession();
    const set = makeChangeSet({ projectId: session.projectId, validation: failingValidation() });
    const id = set.id as string;
    const submitted = await json(
      await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) }),
    );
    // `validated` — the verdict has been computed, and nothing has refused it
    // yet. The refusal is the approval, below, and it is the same on both
    // transports.
    expect(submitted.status).toBe('validated');

    const refused = await fetch(`${base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: submitted.contentDigest }),
    });
    expect(refused.status).toBe(403);
    expect((await json(refused)).code).toBe('policy_violation');
  });

  it('refuses a second ChangeSet under an id already used', async () => {
    const { base, session } = await relayAndSession();
    const set = makeChangeSet({ projectId: session.projectId });
    await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) });
    const again = await fetch(`${base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ ...set, summary: 'something else entirely' }),
    });
    expect(again.status).toBe(400);
  });

  it('refuses a bulk delete without the explicit confirmation', async () => {
    const { base, session } = await relayAndSession();
    const operations = Array.from({ length: 11 }, (_unused, index) => ({
      op: 'deleteInstance',
      path: `Workspace.Doomed${index}`,
    }));
    const set = makeChangeSet({ projectId: session.projectId, operations: operations as never });
    const id = set.id as string;
    const submitted = await json(
      await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) }),
    );

    const refused = await fetch(`${base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: submitted.contentDigest }),
    });
    expect(refused.status).toBe(400);
    expect(String((await json(refused)).message)).toContain('deletes 11 instances');

    const confirmed = await fetch(`${base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: submitted.contentDigest, confirmBulkDelete: true }),
    });
    expect(confirmed.status).toBe(202);
  });
});

describe('the long poll is the transport', () => {
  it('holds a poll open and releases it the moment a set is approved', async () => {
    // Studio has no WebSocket API, so every option is HTTP polling (ADR-004).
    // A poll that did not wake on an approval would add a full poll interval to
    // every apply, which is the whole difference between a bridge that feels
    // live and one that feels broken.
    const { relay, base, session } = await relayAndSession();
    const set = makeChangeSet({ projectId: session.projectId });
    const id = set.id as string;
    await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) });
    const diff = await json(await fetch(`${base}/v1/changesets/${id}/diff`, { headers: producerHeaders(session) }));

    const held = fetch(`${base}/v1/link/poll?since=0`, { headers: pollHeaders(session, 0) });
    // Give the poll time to be registered rather than answered immediately.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(relay.heldPolls).toBe(1);

    await fetch(`${base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ contentDigest: diff.contentDigest }),
    });

    const answered = await held;
    expect(answered.status).toBe(200);
    const payload = openEnvelope(session.sessionKey, await answered.json(), { linkId: session.linkId }).payload as {
      changeSet: { id: string };
    };
    expect(payload.changeSet.id).toBe(id);
    // Released, not leaked: a count that only ever climbs is how a relay dies
    // quietly after an hour.
    expect(relay.heldPolls).toBe(0);
  });

  it('answers 204 when the window closes with nothing to send', async () => {
    const started = await startRelay({ pollTimeoutMs: 30 });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const answered = await fetch(`${started.base}/v1/link/poll?since=0`, { headers: pollHeaders(session, 0) });
    // A quiet period ends in a clean 204 rather than an error the plugin would
    // have to distinguish from a dead relay.
    expect(answered.status).toBe(204);
    expect(started.relay.heldPolls).toBe(0);
  });

  it('does not wake another tenant’s poll', async () => {
    const started = await startRelay({ pollTimeoutMs: 60 });
    open.push(started.close);
    const alice = await pairSession(started.relay, started.base);
    const mallory = await pairSession(started.relay, started.base);

    const eavesdrop = fetch(`${started.base}/v1/link/poll?since=0`, { headers: pollHeaders(mallory, 0) });
    const set = makeChangeSet({ projectId: alice.projectId });
    const id = set.id as string;
    await fetch(`${started.base}/v1/changesets`, { method: 'POST', headers: producerHeaders(alice), body: JSON.stringify(set) });
    const diff = await json(await fetch(`${started.base}/v1/changesets/${id}/diff`, { headers: producerHeaders(alice) }));
    await fetch(`${started.base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(alice),
      body: JSON.stringify({ contentDigest: diff.contentDigest }),
    });

    expect((await eavesdrop).status).toBe(204);
  });
});

describe('the consumer half is authenticated and replay-proof', () => {
  it('refuses a poll with no MAC, and one with the wrong MAC', async () => {
    const { base, session } = await relayAndSession();

    const noMac = await fetch(`${base}/v1/link/poll?since=0`, { headers: { 'x-forgebridge-link': session.linkId } });
    expect(noMac.status).toBe(401);

    const wrongMac = await fetch(`${base}/v1/link/poll?since=0`, {
      headers: { 'x-forgebridge-link': session.linkId, 'x-forgebridge-mac': 'AAAA' },
    });
    expect(wrongMac.status).toBe(401);
  });

  it('refuses a MAC computed for a different cursor', async () => {
    const { base, session } = await relayAndSession();
    // The MAC covers the cursor, so a captured poll cannot be replayed against
    // a different one.
    const mismatched = await fetch(`${base}/v1/link/poll?since=5`, { headers: pollHeaders(session, 0) });
    expect(mismatched.status).toBe(401);
  });

  it('refuses a replayed envelope', async () => {
    const { base, session } = await relayAndSession();
    const batch = { messages: [{ level: 'print', message: 'hello', at: new Date(0).toISOString() }] };

    const first = await fetch(`${base}/v1/output`, {
      method: 'POST',
      headers: consumerHeaders(session),
      body: envelopeBody(session, 1, batch),
    });
    expect(first.status).toBe(204);

    const replayed = await fetch(`${base}/v1/output`, {
      method: 'POST',
      headers: consumerHeaders(session),
      body: envelopeBody(session, 1, batch),
    });
    expect(replayed.status).toBe(409);
    expect((await json(replayed)).code).toBe('replay_detected');
  });

  it('lets a producer read the console back', async () => {
    const { base, session } = await relayAndSession();
    await fetch(`${base}/v1/output`, {
      method: 'POST',
      headers: consumerHeaders(session),
      body: envelopeBody(session, 1, { messages: [{ level: 'error', message: 'boom', at: new Date(0).toISOString() }] }),
    });
    const read = await json(await fetch(`${base}/v1/output`, { headers: producerHeaders(session) }));
    expect((read.messages as Array<{ message: string }>)[0]?.message).toBe('boom');
  });
});

describe('routes that exist without the capability behind them', () => {
  it('answers GET /v1/models with configured: false rather than an empty catalogue', async () => {
    const { base } = await relayAndSession();
    const models = await json(await fetch(`${base}/v1/models`));
    // The field that keeps this honest: "the registry is configured and knows
    // of no model you can use" is a different fact from "nothing is configured".
    expect(models.configured).toBe(false);
    expect(models.models).toEqual([]);
  });

  it('answers POST /v1/runs with provider_unconfigured, naming BYOK and the daemon', async () => {
    const { base, session } = await relayAndSession();
    const refused = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ prompt: 'build me a shop' }),
    });
    expect(refused.status).toBe(503);
    const body = await json(refused);
    expect(body.code).toBe('provider_unconfigured');
    expect(String(body.remedy)).toMatch(/BYOK/);
    expect(String(body.remedy)).toMatch(/daemon/);
  });
});

describe('the routing table is the surface', () => {
  it('answers not_found for a path outside it', async () => {
    const { base } = await relayAndSession();
    expect((await fetch(`${base}/v1/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v2/health`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it('refuses a caller declaring an incompatible protocol major', async () => {
    const { base } = await relayAndSession();
    const refused = await fetch(`${base}/v1/health`, { headers: { 'x-forgebridge-protocol': '2.0.0' } });
    expect(refused.status).toBe(426);
  });

  it('refuses a producer route with no token, and one with a token from nowhere', async () => {
    const { base } = await relayAndSession();
    expect((await fetch(`${base}/v1/link`)).status).toBe(401);
    expect((await fetch(`${base}/v1/link`, { headers: { 'x-forgebridge-token': 'made-up' } })).status).toBe(401);
  });
});
