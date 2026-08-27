import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumerHeaders,
  envelopeBody,
  json,
  makeChangeSet,
  pairSession,
  producerHeaders,
  startRelay,
  type PairedSession,
} from './helpers.js';
import type { ForgeBridgeRelay } from '../src/server.js';

/**
 * Tenant isolation — the property a daemon gets for free and a relay has to
 * build.
 *
 * A daemon is one user's process: every ChangeSet in it is theirs, and "whose
 * is this?" is not a question its store has to answer. On a relay the same
 * lookup is a cross-tenant read. ChangeSet ids are UUIDs, but an id is not an
 * authorisation, and a store whose reads take only an id is a store where one
 * forgotten check in one handler exposes a stranger's script source — which is
 * the single worst thing this transport could do, because the whole reason a
 * user is on it rather than the daemon is that they could not install one.
 *
 * `RelayStore`'s signatures make the check structural: there is no way to ask
 * for a ChangeSet without saying which session is asking. These tests cover the
 * routes anyway, because a signature is a proof about this code and not about a
 * future adapter or a handler someone adds next month.
 *
 * Note what every refusal below is: `not_found`, never `403`. A relay that
 * answered "forbidden" for another tenant's id would be confirming that the id
 * is real and belongs to someone — which is a membership oracle over every
 * ChangeSet, journal and link on the host.
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function twoTenants(): Promise<{
  relay: ForgeBridgeRelay;
  base: string;
  alice: PairedSession;
  mallory: PairedSession;
}> {
  const started = await startRelay();
  open.push(started.close);
  return {
    relay: started.relay,
    base: started.base,
    alice: await pairSession(started.relay, started.base),
    mallory: await pairSession(started.relay, started.base),
  };
}

describe('one tenant cannot read another', () => {
  it('refuses a diff for a ChangeSet belonging to someone else, as not_found', async () => {
    const { base, alice, mallory } = await twoTenants();
    const set = makeChangeSet({ projectId: alice.projectId });
    const id = set.id as string;
    await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(alice), body: JSON.stringify(set) });

    const mine = await fetch(`${base}/v1/changesets/${id}/diff`, { headers: producerHeaders(alice) });
    expect(mine.status).toBe(200);

    const theirs = await fetch(`${base}/v1/changesets/${id}/diff`, { headers: producerHeaders(mallory) });
    expect(theirs.status).toBe(404);
    expect((await json(theirs)).code).toBe('not_found');
  });

  it('refuses to approve someone else’s ChangeSet', async () => {
    const { base, alice, mallory } = await twoTenants();
    const set = makeChangeSet({ projectId: alice.projectId });
    const id = set.id as string;
    await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(alice), body: JSON.stringify(set) });
    const diff = await json(await fetch(`${base}/v1/changesets/${id}/diff`, { headers: producerHeaders(alice) }));

    // Mallory holds the digest — it is a fingerprint, not a capability, and
    // anyone who can compute the operations can compute it. What stops her is
    // that the set is not addressable from her session at all.
    const refused = await fetch(`${base}/v1/changesets/${id}/approve`, {
      method: 'POST',
      headers: producerHeaders(mallory),
      body: JSON.stringify({ contentDigest: diff.contentDigest }),
    });
    expect(refused.status).toBe(404);
  });

  it('lists only its own links', async () => {
    const { base, alice, mallory } = await twoTenants();
    const mine = await json(await fetch(`${base}/v1/link`, { headers: producerHeaders(alice) }));
    const links = mine.links as Array<{ id: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]?.id).toBe(alice.linkId);
    expect(links.map((link) => link.id)).not.toContain(mallory.linkId);
  });

  it('refuses to read console output through another tenant’s link id', async () => {
    const { base, alice, mallory } = await twoTenants();
    await fetch(`${base}/v1/output`, {
      method: 'POST',
      headers: consumerHeaders(alice),
      body: envelopeBody(alice, 1, { messages: [{ level: 'print', message: 'secret', at: new Date(0).toISOString() }] }),
    });

    const refused = await fetch(`${base}/v1/output?link=${alice.linkId}`, { headers: producerHeaders(mallory) });
    // `link_unpaired`, the same answer an id that does not exist gets: the
    // difference between the two is a way to test whether an id is real.
    expect(refused.status).toBe(409);
    const read = await json(refused);
    expect(JSON.stringify(read)).not.toContain('secret');
  });

  it('refuses a rollback against a journal belonging to someone else', async () => {
    const { base, alice, mallory } = await twoTenants();
    const journalId = await applyOnce(base, alice);

    const refused = await fetch(`${base}/v1/journal/${journalId}/rollback`, {
      method: 'POST',
      headers: producerHeaders(mallory),
      body: JSON.stringify({ journalId, expectedVersion: 1 }),
    });
    expect(refused.status).toBe(404);

    const alsoRefused = await fetch(`${base}/v1/journal/${journalId}`, { headers: producerHeaders(mallory) });
    expect(alsoRefused.status).toBe(404);
  });

  it('refuses an envelope from one link presented on another', async () => {
    const { base, alice, mallory } = await twoTenants();
    const batch = { messages: [{ level: 'print', message: 'hi', at: new Date(0).toISOString() }] };
    // Mallory's link header, Alice's sealed envelope: the MAC covers the link
    // id, so the two cannot be recombined.
    const crossed = await fetch(`${base}/v1/output`, {
      method: 'POST',
      headers: consumerHeaders(mallory),
      body: envelopeBody(alice, 1, batch),
    });
    expect(crossed.status).toBe(401);
  });

  it('refuses a ChangeSet naming a project the session does not own', async () => {
    const { base, alice, mallory } = await twoTenants();
    const trespass = makeChangeSet({ projectId: mallory.projectId });
    const refused = await fetch(`${base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(alice),
      body: JSON.stringify(trespass),
    });
    expect(refused.status).toBe(400);
  });

  it('refuses a ChangeSet id another tenant already used', async () => {
    const { base, alice, mallory } = await twoTenants();
    const set = makeChangeSet({ projectId: alice.projectId });
    await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(alice), body: JSON.stringify(set) });

    // Write-once relay-wide rather than per session. Per session would let one
    // tenant mint a set under an id another tenant's later steps already name.
    const collision = await fetch(`${base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(mallory),
      body: JSON.stringify({ ...set, projectId: mallory.projectId }),
    });
    expect(collision.status).toBe(400);
  });
});

/** Drive one ChangeSet all the way to an applied journal, and return its id. */
async function applyOnce(base: string, session: PairedSession): Promise<string> {
  const set = makeChangeSet({ projectId: session.projectId });
  const id = set.id as string;
  await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) });
  const diff = await json(await fetch(`${base}/v1/changesets/${id}/diff`, { headers: producerHeaders(session) }));
  await fetch(`${base}/v1/changesets/${id}/approve`, {
    method: 'POST',
    headers: producerHeaders(session),
    body: JSON.stringify({ contentDigest: diff.contentDigest }),
  });
  const journalId = randomUUID();
  await fetch(`${base}/v1/apply-result`, {
    method: 'POST',
    headers: consumerHeaders(session),
    body: envelopeBody(session, 1, {
      changeSetId: id,
      outcomes: [{ index: 0, ok: true }],
      newVersion: 1,
      journalId,
      appliedAt: new Date(0).toISOString(),
      pluginVersion: '1.0.0',
    }),
  });
  return journalId;
}
