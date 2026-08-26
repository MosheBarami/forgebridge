import { describe, it, expect } from 'vitest';
import { InstancePath, isWithin, parentOf, nameOf, segmentsOf } from '../src/path.js';

describe('InstancePath', () => {
  it('accepts a well-formed path under a service root', () => {
    expect(InstancePath.safeParse('ServerScriptService.Shop.PurchaseHandler').success).toBe(true);
  });

  it('refuses a root that is not an addressable service', () => {
    const result = InstancePath.safeParse('game.Players.Someone');
    expect(result.success).toBe(false);
  });

  it('refuses a segment that is not a safe identifier', () => {
    // The real risk: a name containing a dot would make the path ambiguous and
    // could be used to escape a policy prefix.
    for (const bad of ['ServerScriptService.My Script', 'ServerScriptService.a-b', 'ServerScriptService.2fast']) {
      expect(InstancePath.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses an empty segment', () => {
    expect(InstancePath.safeParse('ServerScriptService..Child').success).toBe(false);
  });

  it('refuses a path deeper than the limit', () => {
    const deep = ['Workspace', ...Array.from({ length: 40 }, (_, i) => `n${i}`)].join('.');
    expect(InstancePath.safeParse(deep).success).toBe(false);
  });
});

describe('isWithin', () => {
  it('treats a path as within itself', () => {
    expect(isWithin('ServerScriptService.Shop', 'ServerScriptService.Shop')).toBe(true);
  });

  it('matches a true descendant', () => {
    expect(isWithin('ServerScriptService.Shop.Handler', 'ServerScriptService.Shop')).toBe(true);
  });

  it('does NOT match a sibling that shares a string prefix', () => {
    // A naive startsWith would return true here and turn the policy allowlist
    // into a hole wide enough to drive a ChangeSet through.
    expect(isWithin('ServerScriptService.ShopAdmin', 'ServerScriptService.Shop')).toBe(false);
  });

  it('does not match an ancestor', () => {
    expect(isWithin('ServerScriptService', 'ServerScriptService.Shop')).toBe(false);
  });
});

describe('path helpers', () => {
  it('splits, and finds parent and name', () => {
    expect(segmentsOf('Workspace.A.B')).toEqual(['Workspace', 'A', 'B']);
    expect(parentOf('Workspace.A.B')).toBe('Workspace.A');
    expect(parentOf('Workspace')).toBeNull();
    expect(nameOf('Workspace.A.B')).toBe('B');
  });
});
