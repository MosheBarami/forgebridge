import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LocalOperatorApprovalGate } from '../src/approval.js';
import { WRITING_SKILLS } from '../src/skills.js';
import type { A2AServer } from '../src/server.js';
import { invocationMessage, startServer, type StartedServer } from './helpers.js';

/**
 * `read-journal` — how an agent finds out whether a rollback happened.
 *
 * The skill exists because `rollback-apply` answers `dispatched` and cannot
 * answer anything else: the Studio plugin holds the inverses and replays them
 * after it polls. Before M11 there was no shape on the wire for the outcome at
 * all, so "dispatched" was the connector's last word on every reversal.
 *
 * What is asserted here is the summary text, not the payload. A calling agent
 * that reads only the summary — which is what a summary is for — must not be
 * able to come away believing a partial reversal was a complete one.
 */
const running: A2AServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function serve(overrides = {}): Promise<StartedServer> {
  const started = await startServer(overrides);
  running.push(started.server);
  return started;
}

function summaryOf(body: { result: { task: { status: { message?: { parts: { text?: string }[] } } } } }): string {
  return (body.result.task.status.message?.parts ?? []).map((part) => part.text ?? '').join(' ');
}

describe('read-journal', () => {
  it('is a read, so it never passes through the approval gate', () => {
    // Structural rather than behavioural: a skill that writes to the place is in
    // `WRITING_SKILLS` and the executor refuses it without a grant. This one
    // changes nothing, and putting it in that set would make finding out what
    // happened require an approval of its own.
    expect(WRITING_SKILLS.has('rollback-apply')).toBe(true);
    expect([...WRITING_SKILLS]).not.toContain('read-journal');
  });

  it('answers without a grant, and reports a completed reversal as completed', async () => {
    const started = await serve();
    const journalId = randomUUID();

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('read-journal', { journalId }),
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(started.backend.callsTo('journal')).toHaveLength(1);
    expect(summaryOf(body)).toContain('"rolled_back"');
    expect(summaryOf(body)).toContain('replayed 2 of 2');
  });

  it('says "rollback_partial" in the daemon\'s own word and names the inverses that failed', async () => {
    // The outcome every surface is most likely to round up. A summary that said
    // "partial" without naming the failures would leave an agent with nothing to
    // act on, and one that said "rolled back" would leave it building on a tree
    // that is in neither of the two states anyone has a record of.
    const started = await serve();
    const journalId = randomUUID();
    started.backend.journalStates.set(journalId, {
      journalId,
      changeSetId: randomUUID(),
      summary: 'add a shop script',
      state: 'rollback_partial',
      versionBefore: 1,
      versionAfter: 2,
      rolledBackAt: null,
      inverses: 2,
      result: {
        outcomes: [
          { index: 1, ok: true },
          { index: 0, ok: false, error: 'Workspace.Shop.Sign is gone' },
        ],
        newVersion: 3,
      },
    });

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('read-journal', { journalId }),
    });

    const summary = summaryOf(body);
    expect(summary).toContain('"rollback_partial"');
    expect(summary).toContain('replayed 1 of 2');
    expect(summary).toContain('Workspace.Shop.Sign is gone');
    expect(summary).toContain('spent');
    expect(summary).not.toContain('"rolled_back"');
  });

  it('tells "no inverses on this daemon" apart from "an apply with nothing to undo"', async () => {
    // Null and 0 are different facts. Null means the inverses never left the
    // Studio session that captured them — that session may still be able to undo
    // in place, and nothing else can — while 0 would mean an apply that changed
    // nothing.
    const started = await serve();
    const journalId = randomUUID();
    started.backend.journalStates.set(journalId, {
      journalId,
      changeSetId: randomUUID(),
      summary: 'add a shop script',
      state: 'applied',
      versionBefore: 1,
      versionAfter: 2,
      rolledBackAt: null,
      inverses: null,
      result: null,
    });

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('read-journal', { journalId }),
    });

    expect(summaryOf(body)).toContain('holds no inverse operation(s)');
  });

  it('points a caller at itself after a dispatch, so "dispatched" is not a dead end', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const journalId = randomUUID();
    gate.record({ skill: 'rollback-apply', subject: journalId, approvedBy: 'a human' });

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('rollback-apply', { journalId, expectedVersion: 3 }),
    });

    const summary = summaryOf(body);
    expect(summary).toContain('dispatched');
    expect(summary).toContain('2 inverse operation(s)');
    expect(summary).toContain(`read-journal with journalId ${journalId}`);
    // Still not claiming the reversal happened. It has not: the plugin has not
    // polled yet.
    expect(summary).not.toContain('rolled_back');
  });
});
