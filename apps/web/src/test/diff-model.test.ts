import { describe, expect, it } from 'vitest';

import type { ChangeSetDiff, OperationDiff } from '@/lib/daemon/wire';
import { propertyOf, resolveDiff } from '@/app/[locale]/generate/diff-model';

/**
 * The diff resolver, pinned against the defect it exists to prevent.
 *
 * A Studio plugin reported "0 scripts" over a ChangeSet that installed one,
 * because it looked only at `writeScript` and the script had arrived as a
 * `createInstance` carrying `Source`. These tests assert that all three routes
 * a ChangeSet can install Luau by are resolved to *displayable code*, and that
 * when the resolver cannot account for a script the daemon counted, it says so
 * loudly rather than rendering a shorter list that looks complete.
 */

function diffOf(
  operations: OperationDiff[],
  counts: Partial<ChangeSetDiff['counts']> = {},
): ChangeSetDiff {
  return {
    changeSetId: 'cs',
    projectId: 'p',
    summary: 'a set',
    status: 'validated',
    baseVersion: 1,
    currentVersion: 1,
    stale: false,
    counts: {
      total: operations.length,
      creates: 0,
      setProperties: 0,
      scripts: 0,
      moves: 0,
      deletes: 0,
      ...counts,
    },
    contentDigest: 'sha256:deadbeef',
    operations,
    treeAware: false,
  };
}

const LUAU = 'local part = Instance.new("Part")\nprint("hello")\n';

describe('the three ways a ChangeSet installs Luau', () => {
  it('resolves writeScript source', () => {
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'writeScript',
            paths: ['ServerScriptService.Shop'],
            summary: 'write Script ServerScriptService.Shop (52 bytes)',
            destructive: false,
            after: LUAU,
          },
        ],
        { scripts: 1 },
      ),
    );

    expect(resolved.operations[0]?.content).toEqual({ kind: 'luau', source: LUAU });
    expect(resolved.operations[0]?.carriesLuau).toBe(true);
    expect(resolved.undisclosedScripts).toBe(0);
  });

  it('resolves a createInstance that carries Source in its property bag', () => {
    // The exact shape of the reported defect: a Script created with its body in
    // the property bag rather than through `writeScript`.
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'createInstance',
            paths: ['ServerScriptService.Sneaky'],
            summary: 'create Script at ServerScriptService.Sneaky with 52 bytes of Source',
            destructive: false,
            after: LUAU,
            properties: { Disabled: '{"t":"Bool","v":false}' },
          },
        ],
        { creates: 1, scripts: 1 },
      ),
    );

    expect(resolved.operations[0]?.content).toEqual({ kind: 'luau', source: LUAU });
    expect(resolved.shownScripts).toBe(1);
    expect(resolved.undisclosedScripts).toBe(0);
  });

  it('unwraps a setProperty of Source out of its PropertyValue envelope', () => {
    // The daemon renders a `setProperty` value as `JSON.stringify(value)`, so
    // the Luau arrives wrapped. Printing `after` verbatim here would show the
    // reviewer a JSON string literal with `\n` for every newline — a diff of a
    // string, not of the script.
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'setProperty',
            paths: ['ServerScriptService.Shop'],
            summary: 'set ServerScriptService.Shop.Source',
            destructive: false,
            after: JSON.stringify({ t: 'String', v: LUAU }),
          },
        ],
        { setProperties: 1, scripts: 1 },
      ),
    );

    expect(resolved.operations[0]?.content).toEqual({ kind: 'luau', source: LUAU });
    expect(resolved.operations[0]?.property).toBe('Source');
    expect(resolved.undisclosedScripts).toBe(0);
  });
});

describe('the property name is recovered exactly, not by splitting on the last dot', () => {
  it('handles a dotted instance path', () => {
    // `ServerScriptService.Shop.Handler.Source` split on the last dot happens to
    // work; anchoring on the known path is what makes it correct rather than
    // lucky.
    expect(
      propertyOf({
        index: 0,
        op: 'setProperty',
        paths: ['ServerScriptService.Shop.Handler'],
        summary: 'set ServerScriptService.Shop.Handler.Source',
        destructive: false,
      }),
    ).toBe('Source');
  });

  it('returns null for a summary it does not recognise', () => {
    expect(
      propertyOf({
        index: 0,
        op: 'setProperty',
        paths: ['Workspace.Part'],
        summary: 'something a newer daemon wrote',
        destructive: false,
      }),
    ).toBeNull();
  });

  it('is null for operations that are not setProperty', () => {
    expect(
      propertyOf({
        index: 0,
        op: 'writeScript',
        paths: ['Workspace.Part'],
        summary: 'write Script Workspace.Part (1 bytes)',
        destructive: false,
      }),
    ).toBeNull();
  });
});

describe('a setProperty whose property could not be read still shows its code', () => {
  it('unwraps anyway when the summary did not parse', () => {
    // Failing towards showing the reviewer more: a script rendered that turns
    // out to be an ordinary string property costs a glance, while the reverse
    // costs a script nobody saw.
    const resolved = resolveDiff(
      diffOf([
        {
          index: 0,
          op: 'setProperty',
          paths: ['Workspace.Part'],
          summary: 'a summary in a shape this build does not know',
          destructive: false,
          after: JSON.stringify({ t: 'String', v: LUAU }),
        },
      ]),
    );

    expect(resolved.operations[0]?.content).toEqual({ kind: 'luau', source: LUAU });
  });
});

describe('a Source that is not a string is reported, never rendered as ok', () => {
  it('marks a non-string Source unreadable and still counts it as carrying Luau', () => {
    const raw = JSON.stringify({ t: 'Bool', v: true });
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'setProperty',
            paths: ['Workspace.Part'],
            summary: 'set Workspace.Part.Source',
            destructive: false,
            after: raw,
          },
        ],
        { setProperties: 1, scripts: 1 },
      ),
    );

    expect(resolved.operations[0]?.content).toEqual({ kind: 'unreadable-source', raw });
    expect(resolved.operations[0]?.carriesLuau).toBe(true);
    // There is genuinely no code to show, so it is not counted as shown — and
    // the cross-check therefore reports it, which is what puts the warning in
    // front of the approver.
    expect(resolved.shownScripts).toBe(0);
    expect(resolved.undisclosedScripts).toBe(1);
  });
});

describe('the cross-check against the daemon’s own script count', () => {
  it('fires when the daemon counted a script this build could not resolve', () => {
    // The failure mode this guard exists for: the daemon knows the set installs
    // one script, and the operation list as rendered contains no code at all.
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'someFutureOpThatCarriesLuau',
            paths: ['Workspace.Thing'],
            summary: 'does something this build has never heard of',
            destructive: false,
          },
        ],
        { scripts: 1 },
      ),
    );

    expect(resolved.shownScripts).toBe(0);
    expect(resolved.undisclosedScripts).toBe(1);
  });

  it('does not go negative when more code is shown than the daemon counted', () => {
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'writeScript',
            paths: ['Workspace.A'],
            summary: 'write Script Workspace.A (1 bytes)',
            destructive: false,
            after: LUAU,
          },
        ],
        { scripts: 0 },
      ),
    );

    expect(resolved.undisclosedScripts).toBe(0);
  });
});

describe('non-script operations', () => {
  it('shows an ordinary property as a value, not as code', () => {
    const raw = JSON.stringify({ t: 'Bool', v: false });
    const resolved = resolveDiff(
      diffOf([
        {
          index: 0,
          op: 'setProperty',
          paths: ['Workspace.Part'],
          summary: 'set Workspace.Part.Anchored',
          destructive: false,
          after: raw,
        },
      ]),
    );

    expect(resolved.operations[0]?.content).toEqual({ kind: 'value', raw });
    expect(resolved.operations[0]?.carriesLuau).toBe(false);
  });

  it('counts destructive operations', () => {
    const resolved = resolveDiff(
      diffOf(
        [
          {
            index: 0,
            op: 'deleteInstance',
            paths: ['Workspace.Old'],
            summary: 'delete Workspace.Old',
            destructive: true,
          },
          {
            index: 1,
            op: 'moveInstance',
            paths: ['Workspace.A', 'Workspace.B'],
            summary: 'move Workspace.A to Workspace.B',
            destructive: true,
          },
        ],
        { deletes: 1, moves: 1 },
      ),
    );

    expect(resolved.destructiveCount).toBe(2);
    expect(resolved.operations[0]?.content).toEqual({ kind: 'none' });
  });
});
