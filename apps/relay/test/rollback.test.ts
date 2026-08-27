import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openEnvelope } from '../src/envelope.js';
import {
  consumerHeaders,
  envelopeBody,
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
 * M11 over the relay: the inverses outlive the Studio session that captured
 * them.
 *
 * Before the journal-entry route existed, the only copy of an apply's inverses
 * was inside the plugin that made them, so closing Studio was the end of the
 * road back from a destructive run. Rollback is the load-bearing safety
 * mechanism of ADR-012 — validation reduces how often it is needed and never
 * removes the need — so a transport where it works only while one window stays
 * open is a transport where it does not really work.
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const OPERATION = {
  op: 'createInstance',
  path: 'Workspace.Shop',
  className: 'Model',
  properties: {},
};

/** A second operation, for the partial case: a partial needs two outcomes. */
const SECOND_OPERATION = {
  op: 'setProperty',
  path: 'Workspace.Shop',
  property: 'Transparency',
  value: { t: 'Number', v: 0.5 },
};

interface Applied {
  base: string;
  session: PairedSession;
  changeSetId: string;
  journalId: string;
  nextNonce: number;
  operations: unknown[];
}

/** Propose, approve, deliver, apply — the state a rollback starts from. */
async function applied(
  relay: ForgeBridgeRelay,
  base: string,
  operations: unknown[] = [OPERATION],
): Promise<Applied> {
  const session = await pairSession(relay, base);
  const set = makeChangeSet({ projectId: session.projectId, operations: operations as never });
  const changeSetId = set.id as string;
  await fetch(`${base}/v1/changesets`, { method: 'POST', headers: producerHeaders(session), body: JSON.stringify(set) });
  const diff = await json(await fetch(`${base}/v1/changesets/${changeSetId}/diff`, { headers: producerHeaders(session) }));
  await fetch(`${base}/v1/changesets/${changeSetId}/approve`, {
    method: 'POST',
    headers: producerHeaders(session),
    body: JSON.stringify({ contentDigest: diff.contentDigest }),
  });

  const journalId = randomUUID();
  await fetch(`${base}/v1/apply-result`, {
    method: 'POST',
    headers: consumerHeaders(session),
    body: envelopeBody(session, 1, {
      changeSetId,
      outcomes: operations.map((_unused, index) => ({ index, ok: true })),
      newVersion: 1,
      journalId,
      appliedAt: new Date(0).toISOString(),
      pluginVersion: '1.0.0',
    }),
  });

  return { base, session, changeSetId, journalId, nextNonce: 2, operations };
}

function entryFor(state: Applied, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: state.journalId,
    projectId: state.session.projectId,
    changeSetId: state.changeSetId,
    summary: 'add a shop handler',
    applied: state.operations.map((operation, index) => ({ index, operation })),
    inverses: state.operations.map((_unused, index) =>
      index === 0
        ? { inverse: 'deleteCreated', path: 'Workspace.Shop' }
        : { inverse: 'restoreProperty', path: 'Workspace.Shop', property: 'Transparency', previous: null },
    ),
    versionBefore: 0,
    versionAfter: 1,
    appliedAt: new Date(0).toISOString(),
    rolledBackAt: null,
    ...overrides,
  };
}

describe('the inverses reach the relay and come back as a replay', () => {
  it('records an entry, dispatches it, and reports the reversal', async () => {
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);

    const recorded = await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce, entryFor(state)),
    });
    expect(recorded.status).toBe(200);
    expect((await json(recorded)).inverses).toBe(1);

    const before = await json(
      await fetch(`${started.base}/v1/journal/${state.journalId}`, { headers: producerHeaders(state.session) }),
    );
    expect(before.state).toBe('applied');
    expect(before.inverses).toBe(1);

    const dispatched = await fetch(`${started.base}/v1/journal/${state.journalId}/rollback`, {
      method: 'POST',
      headers: producerHeaders(state.session),
      body: JSON.stringify({ journalId: state.journalId, expectedVersion: 1 }),
    });
    expect(dispatched.status).toBe(202);
    expect((await json(dispatched)).steps).toBe(1);

    // The delivery carries the inverses, so a fresh Studio session can replay
    // an apply it never saw.
    const polled = await fetch(`${started.base}/v1/link/poll?since=1`, { headers: pollHeaders(state.session, 1) });
    const payload = openEnvelope(state.session.sessionKey, await polled.json(), { linkId: state.session.linkId })
      .payload as { kind: string; restoresToVersion: number; steps: Array<{ index: number }> };
    expect(payload.kind).toBe('rollback');
    expect(payload.restoresToVersion).toBe(0);
    expect(payload.steps).toHaveLength(1);

    const requested = await json(
      await fetch(`${started.base}/v1/journal/${state.journalId}`, { headers: producerHeaders(state.session) }),
    );
    expect(requested.state).toBe('rollback_requested');

    const reported = await fetch(`${started.base}/v1/journal/${state.journalId}/rollback-result`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce + 1, {
        journalId: state.journalId,
        changeSetId: state.changeSetId,
        outcomes: [{ index: 0, ok: true }],
        newVersion: 0,
        rolledBackAt: new Date(1000).toISOString(),
        pluginVersion: '1.0.0',
      }),
    });
    expect(reported.status).toBe(200);
    expect((await json(reported)).state).toBe('rolled_back');

    const after = await json(
      await fetch(`${started.base}/v1/journal/${state.journalId}`, { headers: producerHeaders(state.session) }),
    );
    expect(after.state).toBe('rolled_back');
    expect(after.rolledBackAt).not.toBeNull();
  });

  it('reports a partial reversal as partial, and leaves rolledBackAt null', async () => {
    // Neither reversed nor intact, and the inverses that would have finished
    // the job are spent. A timestamp saying "rolled back" would be the
    // journal's own record lying about the one thing it exists to be right
    // about.
    const started = await startRelay();
    open.push(started.close);
    // Two operations, so the reversal can genuinely be partway: one inverse
    // replayed and one refused.
    const state = await applied(started.relay, started.base, [OPERATION, SECOND_OPERATION]);
    await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce, entryFor(state)),
    });
    await fetch(`${started.base}/v1/journal/${state.journalId}/rollback`, {
      method: 'POST',
      headers: producerHeaders(state.session),
      body: JSON.stringify({ journalId: state.journalId, expectedVersion: 1 }),
    });

    const reported = await json(
      await fetch(`${started.base}/v1/journal/${state.journalId}/rollback-result`, {
        method: 'POST',
        headers: consumerHeaders(state.session),
        body: envelopeBody(state.session, state.nextNonce + 1, {
          journalId: state.journalId,
          changeSetId: state.changeSetId,
          outcomes: [{ index: 0, ok: true }, { index: 1, ok: false, error: 'the instance was already gone' }],
          newVersion: 1,
          rolledBackAt: new Date(1000).toISOString(),
          pluginVersion: '1.0.0',
        }),
      }),
    );
    expect(reported.state).toBe('rollback_partial');

    const state2 = await json(
      await fetch(`${started.base}/v1/journal/${state.journalId}`, { headers: producerHeaders(state.session) }),
    );
    expect(state2.state).toBe('rollback_partial');
    expect(state2.rolledBackAt).toBeNull();
    // The consumer's own report is served back verbatim, including which
    // inverse failed: a summary is not a record.
    expect((state2.result as { outcomes: unknown[] }).outcomes).toHaveLength(2);
  });
});

describe('a journal is a claim about an apply, and the claim is checked', () => {
  it('refuses an entry recording an operation that was never in the approved set', async () => {
    // Without this the journal is a free-form list a consumer can put anything
    // into, and a rollback would faithfully replay work that was never
    // proposed, never validated and never approved.
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);

    const refused = await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(
        state.session,
        state.nextNonce,
        entryFor(state, {
          applied: [{ index: 0, operation: { op: 'deleteInstance', path: 'Workspace.SomethingElse' } }],
          inverses: [{ inverse: 'restoreSubtree', parentPath: 'Workspace', serialised: 'x' }],
        }),
      ),
    });
    expect(refused.status).toBe(400);
    expect(String((await json(refused)).message)).toContain('records something other than operation 0');
  });

  it('refuses an inverse that does not invert its operation', async () => {
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);

    const refused = await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(
        state.session,
        state.nextNonce,
        entryFor(state, { inverses: [{ inverse: 'restoreSource', path: 'Workspace.Shop', previousSource: '' }] }),
      ),
    });
    expect(refused.status).toBe(400);
    expect(String((await json(refused)).message)).toContain('a create is undone by deleting what it created');
  });

  it('refuses an entry whose version bracket is not the apply the relay witnessed', async () => {
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);
    const refused = await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce, entryFor(state, { versionBefore: 7, versionAfter: 9 })),
    });
    expect(refused.status).toBe(400);
  });

  it('refuses a rollback when no inverses ever reached the relay, and says where they are', async () => {
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);

    const refused = await fetch(`${started.base}/v1/journal/${state.journalId}/rollback`, {
      method: 'POST',
      headers: producerHeaders(state.session),
      body: JSON.stringify({ journalId: state.journalId, expectedVersion: 1 }),
    });
    expect(refused.status).toBe(404);
    const body = await json(refused);
    expect(String(body.message)).toContain('no inverse operations on this relay');
    expect(String(body.remedy)).toContain('undo in-session');
  });

  it('refuses a reversal report for a rollback nobody asked for', async () => {
    // A consumer undoing approved work on its own initiative. ADR-012 puts
    // rollback behind a producer route for the same reason it puts apply behind
    // approval.
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);
    await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce, entryFor(state)),
    });

    const refused = await fetch(`${started.base}/v1/journal/${state.journalId}/rollback-result`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce + 1, {
        journalId: state.journalId,
        changeSetId: state.changeSetId,
        outcomes: [{ index: 0, ok: true }],
        newVersion: 0,
        rolledBackAt: new Date(1000).toISOString(),
        pluginVersion: '1.0.0',
      }),
    });
    expect(refused.status).toBe(400);
    expect(String((await json(refused)).message)).toContain('no rollback was requested');
  });

  it('refuses a second entry under a journal id already recorded', async () => {
    const started = await startRelay();
    open.push(started.close);
    const state = await applied(started.relay, started.base);
    const first = await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce, entryFor(state)),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${started.base}/v1/journal/${state.journalId}/entry`, {
      method: 'POST',
      headers: consumerHeaders(state.session),
      body: envelopeBody(state.session, state.nextNonce + 1, entryFor(state)),
    });
    // The inverses are the only way back from an apply; overwriting them is
    // discarding the handle.
    expect(second.status).toBe(400);
    expect(String((await json(second)).message)).toContain('already carries inverse operations');
  });
});
