import { describe, expect, it } from 'vitest';
import {
  ApplyResult,
  InverseOperation,
  JournalEntry,
  LIMITS,
  RollbackResult,
  isFullyApplied,
  rollbackStatusOf,
} from '../src/index.js';

/**
 * Literal ids rather than `randomUUID`.
 *
 * `npm run verify:boundaries` (B1) holds this package to zod and its own
 * relative modules: `packages/protocol` is the contract every other package
 * projects, and a test that reached for `node:crypto` would be the first Node
 * dependency in a package that is meant to have none.
 */
let nextId = 0;
function randomUUID(): string {
  nextId += 1;
  return `3f2504e0-4f89-41d3-9a0c-${String(nextId).padStart(12, '0')}`;
}

/**
 * `RollbackResult` — the M11 addition, and the reading of it.
 *
 * It is a sibling of `ApplyResult`, not a field on it, and the two tests at the
 * bottom of this file are why: they are keyed on different things and their
 * outcomes index different lists. A shape that conflated them would make every
 * field on an `ApplyResult` conditional on a flag, and the one mechanism ADR-012
 * says must never guess would then be read through an `if`.
 */
function result(overrides: Record<string, unknown> = {}): RollbackResult {
  return RollbackResult.parse({
    journalId: randomUUID(),
    changeSetId: randomUUID(),
    outcomes: [{ index: 0, ok: true }],
    newVersion: 3,
    rolledBackAt: new Date().toISOString(),
    pluginVersion: '0.1.0',
    ...overrides,
  });
}

describe('RollbackResult is an additive sibling of ApplyResult', () => {
  it('is keyed on a journal, where ApplyResult is keyed on a changeset', () => {
    // Both ids are required here. A rollback names the journal it is reversing
    // *and* the apply that journal records, because the daemon checks the second
    // against what it witnessed rather than believing the consumer.
    const shape = RollbackResult.shape;
    expect(Object.keys(shape).sort()).toEqual(
      ['changeSetId', 'journalId', 'newVersion', 'outcomes', 'pluginVersion', 'rolledBackAt'].sort(),
    );
    expect(RollbackResult.safeParse({ ...result(), journalId: 'not-a-uuid' }).success).toBe(false);
  });

  it('leaves ApplyResult exactly as it was — additive means nothing moved', () => {
    // The guarantee the addition was allowed under. If a field had been added to
    // `ApplyResult`, or one renamed, every existing consumer would be reading a
    // different type under the same name.
    expect(Object.keys(ApplyResult.shape).sort()).toEqual(
      ['appliedAt', 'changeSetId', 'journalId', 'newVersion', 'outcomes', 'pluginVersion'].sort(),
    );
    const applied = ApplyResult.parse({
      changeSetId: randomUUID(),
      outcomes: [{ index: 0, ok: true }],
      newVersion: 1,
      journalId: randomUUID(),
      appliedAt: new Date().toISOString(),
      pluginVersion: '0.1.0',
    });
    expect(isFullyApplied(applied)).toBe(true);
  });

  it('caps its outcomes where a ChangeSet caps its operations', () => {
    const tooMany = Array.from({ length: LIMITS.MAX_OPERATIONS + 1 }, (_, index) => ({ index, ok: true }));
    expect(RollbackResult.safeParse({ ...result(), outcomes: tooMany }).success).toBe(false);
  });
});

describe('rollbackStatusOf', () => {
  it('calls a clean reversal rolled_back', () => {
    expect(rollbackStatusOf(result({ outcomes: [{ index: 1, ok: true }, { index: 0, ok: true }] }))).toBe(
      'rolled_back',
    );
  });

  it('calls a reversal that achieved nothing failed', () => {
    expect(
      rollbackStatusOf(result({ outcomes: [{ index: 0, ok: false, error: 'the path is gone' }] })),
    ).toBe('failed');
  });

  it('calls a mixed reversal partial, and never rounds it to either neighbour', () => {
    // The whole reason the status has three values. A half-reversed tree is in a
    // state neither the user nor the journal describes, and the inverses that
    // would have finished the job are spent — so a caller must be able to tell it
    // from both a clean reversal and one that never started.
    const partial = result({
      outcomes: [
        { index: 1, ok: true },
        { index: 0, ok: false, error: 'Workspace.Shop.Sign is gone' },
      ],
    });
    expect(rollbackStatusOf(partial)).toBe('partial');
  });

  it('calls an empty outcome list failed, because every() over nothing is true', () => {
    // The fail-closed case, and the exact shape of the bug this repository keeps
    // finding: "I replayed nothing" and "I replayed everything successfully"
    // must not be the same answer. A consumer that could not start reports no
    // outcomes, and reading that as a clean reversal would tell a user their
    // place is back the way it was when nothing was touched at all.
    expect([].every(() => false)).toBe(true);
    expect(rollbackStatusOf(result({ outcomes: [] }))).toBe('failed');
  });
});

describe('the journal a rollback is replayed from', () => {
  it('accepts an inverse for every operation kind, and refuses one it has no member for', () => {
    const inverses = [
      { inverse: 'deleteCreated', path: 'Workspace.Door' },
      { inverse: 'restoreProperty', path: 'Workspace.Door', property: 'Anchored', previous: { t: 'Bool', v: true } },
      { inverse: 'restoreSource', path: 'ServerScriptService.Shop', previousSource: 'print(1)' },
      { inverse: 'moveBack', path: 'ReplicatedStorage.Spawn', from: 'Workspace.Spawn' },
      { inverse: 'restoreSubtree', parentPath: 'Workspace.Shop', serialised: '{"name":"Sign"}' },
    ];
    for (const inverse of inverses) expect(InverseOperation.parse(inverse)).toEqual(inverse);
    expect(InverseOperation.safeParse({ inverse: 'restoreFromBackup', path: 'Workspace.Door' }).success).toBe(false);
  });

  it('defaults rolledBackAt to null, which is what lets a consumer omit it', () => {
    // Luau has no way to put an explicit JSON null in a table — a key assigned
    // nil is a key that is not there — so the plugin's uploaded entry omits the
    // field entirely. The default is what makes that expressible.
    const entry = JournalEntry.parse({
      id: randomUUID(),
      projectId: randomUUID(),
      changeSetId: randomUUID(),
      summary: 'add a shop script',
      applied: [
        { index: 0, operation: { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print(1)' } },
      ],
      inverses: [{ inverse: 'deleteCreated', path: 'ServerScriptService.Shop' }],
      versionBefore: 0,
      versionAfter: 1,
      appliedAt: new Date().toISOString(),
    });
    expect(entry.rolledBackAt).toBeNull();
  });
});

describe('rollbackStatusOf tells complete apart from every-attempt-passed', () => {
  const partialResult = () =>
    result({ outcomes: [{ index: 4, ok: true }, { index: 3, ok: true }] });

  it('is rolled_back only when every inverse was accounted for', () => {
    // Two successful outcomes over five inverses means three inverses are still
    // applied to the place. Recorded as complete, that is the journal lying
    // about the one thing it exists to be right about.
    expect(rollbackStatusOf(partialResult(), 5)).toBe('partial');
    expect(rollbackStatusOf(partialResult(), 2)).toBe('rolled_back');
  });

  it('a failure anywhere is still partial or failed, whatever the count', () => {
    const mixed = result({ outcomes: [{ index: 1, ok: true }, { index: 0, ok: false, error: 'gone' }] });
    expect(rollbackStatusOf(mixed, 2)).toBe('partial');
    const none = result({ outcomes: [{ index: 0, ok: false, error: 'gone' }] });
    expect(rollbackStatusOf(none, 1)).toBe('failed');
  });
});
