import { describe, it, expect } from 'vitest';
import { ChangeSet, deletionCount, withinSizeLimit } from '../src/changeset.js';
import { Operation, isDestructive, pathsOf } from '../src/operation.js';
import { LIMITS } from '../src/limits.js';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  baseVersion: 3,
  summary: 'Add a shop',
  createdAt: '2026-08-26T12:00:00.000Z',
};

const write = (path: string) => ({
  op: 'writeScript' as const, path, scriptType: 'Script' as const, source: 'print("hi")',
});

describe('ChangeSet', () => {
  it('parses a minimal valid set', () => {
    const result = ChangeSet.safeParse({ ...base, operations: [write('ServerScriptService.Shop')] });
    expect(result.success).toBe(true);
  });

  it('refuses an empty operation list', () => {
    expect(ChangeSet.safeParse({ ...base, operations: [] }).success).toBe(false);
  });

  it('refuses more operations than the protocol allows', () => {
    const many = Array.from({ length: LIMITS.MAX_OPERATIONS + 1 }, (_, i) => write(`Workspace.n${i}`));
    expect(ChangeSet.safeParse({ ...base, operations: many }).success).toBe(false);
  });

  it('flags a delete that collides with an earlier operation on the same path', () => {
    const result = ChangeSet.safeParse({
      ...base,
      operations: [write('Workspace.Thing'), { op: 'deleteInstance', path: 'Workspace.Thing' }],
    });
    expect(result.success).toBe(false);
  });

  it('counts deletions for the bulk-delete gate', () => {
    const parsed = ChangeSet.parse({
      ...base,
      operations: [
        { op: 'deleteInstance', path: 'Workspace.A' },
        { op: 'deleteInstance', path: 'Workspace.B' },
        write('Workspace.C'),
      ],
    });
    expect(deletionCount(parsed)).toBe(2);
    expect(withinSizeLimit(parsed)).toBe(true);
  });
});

describe('Operation', () => {
  it('refuses a script larger than the limit', () => {
    const huge = 'x'.repeat(LIMITS.MAX_SCRIPT_BYTES + 1);
    expect(Operation.safeParse({ ...write('Workspace.Big'), source: huge }).success).toBe(false);
  });

  it('refuses an invalid property name inside createInstance', () => {
    const result = Operation.safeParse({
      op: 'createInstance', path: 'Workspace.Part', className: 'Part',
      properties: { __index: { t: 'Bool', v: true } },
    });
    expect(result.success).toBe(false);
  });

  it('reports both paths for a move, and classifies destructiveness', () => {
    const move = Operation.parse({ op: 'moveInstance', path: 'Workspace.A', to: 'ReplicatedStorage.A' });
    expect(pathsOf(move)).toEqual(['Workspace.A', 'ReplicatedStorage.A']);
    expect(isDestructive(move)).toBe(true);
    expect(isDestructive(Operation.parse(write('Workspace.Q')))).toBe(false);
  });
});

describe('structural properties are not property writes', () => {
  // Regression: a setProperty writing Parent relocated a whole subtree while
  // reporting only its source path — escaping the policy allowlist, the
  // bulk-delete counter and the auto-apply exclusion in one move.
  it('refuses setProperty on Parent', () => {
    const result = Operation.safeParse({
      op: 'setProperty', path: 'ServerScriptService.Shop.Handler',
      property: 'Parent', value: { t: 'InstanceRef', path: 'ReplicatedStorage.Hidden' },
    });
    expect(result.success).toBe(false);
  });

  it('refuses setProperty on Name', () => {
    // Renaming invalidates the path every journalled inverse is keyed on.
    const result = Operation.safeParse({
      op: 'setProperty', path: 'Workspace.Thing', property: 'Name', value: { t: 'String', v: 'Other' },
    });
    expect(result.success).toBe(false);
  });

  it('still allows an ordinary property write', () => {
    const result = Operation.safeParse({
      op: 'setProperty', path: 'Workspace.Part', property: 'Transparency', value: { t: 'Number', v: 0.5 },
    });
    expect(result.success).toBe(true);
  });
});

describe('pathsOf sees paths hidden inside property values', () => {
  it('reports an InstanceRef target from setProperty', () => {
    const operation = Operation.parse({
      op: 'setProperty', path: 'Workspace.Part', property: 'PrimaryPart',
      value: { t: 'InstanceRef', path: 'ReplicatedStorage.Elsewhere' },
    });
    expect(pathsOf(operation)).toEqual(['Workspace.Part', 'ReplicatedStorage.Elsewhere']);
  });

  it('reports InstanceRef targets from a createInstance property bag', () => {
    const operation = Operation.parse({
      op: 'createInstance', path: 'Workspace.Weld', className: 'WeldConstraint',
      properties: {
        Part0: { t: 'InstanceRef', path: 'Workspace.A' },
        Part1: { t: 'InstanceRef', path: 'ServerStorage.B' },
        Enabled: { t: 'Bool', v: true },
      },
    });
    expect(pathsOf(operation).sort()).toEqual(['ServerStorage.B', 'Workspace.A', 'Workspace.Weld']);
  });

  it('refuses an InstanceRef whose path is not a valid path', () => {
    // The one place the segment guard was missing.
    const result = Operation.safeParse({
      op: 'setProperty', path: 'Workspace.Part', property: 'PrimaryPart',
      value: { t: 'InstanceRef', path: 'game.Players.Someone' },
    });
    expect(result.success).toBe(false);
  });
});
