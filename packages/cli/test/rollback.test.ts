import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rollbackCommand } from '../src/commands/rollback.js';
import { EXIT } from '../src/exit.js';
import { captureIo, journalFixture, linkStatusFixture, stubTransport, testDeps } from './helpers.js';

/**
 * What `forgebridge rollback` is allowed to say.
 *
 * The command's whole job is to not overclaim. Until M11 it could not report an
 * outcome at all — there was no shape on the wire for one — so it printed
 * "dispatched" and stopped. Now that a reversal is reported, the ways it can go
 * wrong are the ways it can round a state up: calling a partial reversal done,
 * calling a timeout done, or exiting 0 on either.
 */
const GLOBAL = { json: false, baseUrl: 'http://127.0.0.1:7317', token: 'test-token' };

function invocation(journalId: string, timeoutSeconds = 30) {
  return {
    command: 'rollback' as const,
    global: GLOBAL,
    journalId,
    expectedVersion: 2,
    reason: null,
    timeoutSeconds,
  };
}

function arrange(states: readonly ReturnType<typeof journalFixture>[]) {
  const io = captureIo();
  let at = 0;
  const transport = stubTransport({
    linkStatus: async () => linkStatusFixture(),
    rollback: async (request) => ({
      journalId: request.journalId,
      changeSetId: randomUUID(),
      status: 'dispatched' as const,
      nonce: 4,
      steps: 2,
    }),
    journal: async () => states[Math.min(at++, states.length - 1)] as ReturnType<typeof journalFixture>,
  });
  return { io, transport };
}

describe('forgebridge rollback', () => {
  it('waits for the consumer to report, then says it was reversed', async () => {
    const journalId = randomUUID();
    const { io, transport } = arrange([
      journalFixture({ journalId, state: 'rollback_requested', rolledBackAt: null, result: null }),
      journalFixture({ journalId, state: 'rolled_back' }),
    ]);

    const code = await rollbackCommand(invocation(journalId), testDeps(io, transport));

    expect(code).toBe(EXIT.OK);
    expect(io.outText()).toContain('rolled_back');
    expect(transport.calls.filter((call) => call.startsWith('journal:')).length).toBeGreaterThan(1);
  });

  it('does not round a partial reversal up, and says the inverses are spent', async () => {
    // The outcome that matters most and is easiest to lose. Some inverses
    // replayed and some did not: the place is in a state neither the rollback
    // nor the apply describes, and there is no second attempt, because the
    // inverses that would have finished the job have been consumed.
    const journalId = randomUUID();
    const { io, transport } = arrange([
      journalFixture({
        journalId,
        state: 'rollback_partial',
        rolledBackAt: null,
        result: {
          journalId,
          changeSetId: randomUUID(),
          outcomes: [
            { index: 1, ok: true },
            { index: 0, ok: false, error: 'Workspace.Shop.Sign is gone' },
          ],
          newVersion: 3,
          rolledBackAt: '2026-01-01T00:02:00.000Z',
          pluginVersion: '0.1.0',
        },
      }),
    ]);

    const code = await rollbackCommand(invocation(journalId), testDeps(io, transport));

    expect(code).toBe(EXIT.FAILED);
    expect(io.outText()).toContain('rollback_partial');
    // The per-inverse failure verbatim: the one moment a person needs to know
    // exactly which one did not replay is the moment the rest of them did.
    expect(io.errText()).toContain('inverse 0: Workspace.Shop.Sign is gone');
    expect(io.errText()).toContain('spent');
    expect(io.outText()).not.toContain('rolled_back');
  });

  it('reports a timeout as still requested rather than as reversed', async () => {
    // Silence is not success. A command that exited 0 here would make a Studio
    // session that never answered indistinguishable from one that reversed.
    const journalId = randomUUID();
    const { io, transport } = arrange([
      journalFixture({ journalId, state: 'rollback_requested', rolledBackAt: null, result: null }),
    ]);

    const code = await rollbackCommand(invocation(journalId, 3), testDeps(io, transport));

    expect(code).toBe(EXIT.FAILED);
    expect(io.outText()).toContain('rollback_requested');
    expect(io.errText()).toContain('not reversed until that session reports');
  });

  it('reports what is true now when asked not to wait', async () => {
    const journalId = randomUUID();
    const { io, transport } = arrange([
      journalFixture({ journalId, state: 'rollback_requested', rolledBackAt: null, result: null }),
      journalFixture({ journalId, state: 'rolled_back' }),
    ]);

    const code = await rollbackCommand(invocation(journalId, 0), testDeps(io, transport));

    expect(code).toBe(EXIT.FAILED);
    // Exactly one read: --timeout 0 asks what is true now, and polling anyway
    // would make the flag a suggestion.
    expect(transport.calls.filter((call) => call.startsWith('journal:'))).toHaveLength(1);
  });

  it('emits both halves in --json, because they answer different questions', async () => {
    const journalId = randomUUID();
    const { io, transport } = arrange([journalFixture({ journalId, state: 'rolled_back' })]);

    await rollbackCommand(
      { ...invocation(journalId), global: { ...GLOBAL, json: true } },
      testDeps(io, transport),
    );

    const emitted = JSON.parse(io.outText()) as {
      dispatch: { status: string; steps: number };
      journal: { state: string; result: { outcomes: unknown[] } | null };
    };
    expect(emitted.dispatch).toMatchObject({ status: 'dispatched', steps: 2 });
    expect(emitted.journal.state).toBe('rolled_back');
    expect(emitted.journal.result?.outcomes).toHaveLength(2);
  });

  it('never reaches for anything that could approve', async () => {
    // The structural guarantee `Transport` is written to keep, asserted from the
    // outside: reversing an apply is not a route back to applying one.
    const journalId = randomUUID();
    const { io, transport } = arrange([journalFixture({ journalId, state: 'rolled_back' })]);
    await rollbackCommand(invocation(journalId), testDeps(io, transport));
    expect(transport.calls).not.toContain('startRun');
    expect(Object.keys(transport)).not.toContain('approve');
  });
});
