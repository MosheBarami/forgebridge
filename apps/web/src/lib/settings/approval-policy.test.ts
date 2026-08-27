import { describe, expect, it } from 'vitest';
import type { AutoApplyPolicy } from '@forgebridge/core';

import {
  AUTO_APPLIABLE_OPS,
  DEFAULT_AUTO_APPLY,
  NEVER_AUTO_APPLIED,
  checkPathPrefix,
  covers,
  parseAutoApply,
} from './approval-policy';

/**
 * ADR-012's constraints, as tests.
 *
 * Each `it` below is a way the approval gate could quietly stop being the
 * approval gate. None would fail a build on its own — an enabled policy with an
 * empty prefix parses fine, a service root is a valid `InstancePath`, and a
 * `deleteInstance` slipping through `covers` produces no type error. They are
 * exactly the failures that need a test rather than a type.
 */

const SHOP: AutoApplyPolicy = { enabled: true, pathPrefix: 'ServerScriptService.Shop' };

describe('the default', () => {
  it('is no policy at all, which is the core’s own default', () => {
    expect(DEFAULT_AUTO_APPLY).toBeNull();
  });
});

describe('the path prefix', () => {
  it('accepts a path below a service root', () => {
    expect(checkPathPrefix('ServerScriptService.Shop')).toEqual({
      ok: true,
      prefix: 'ServerScriptService.Shop',
    });
  });

  it('trims, so a pasted path with a stray space is not silently a different path', () => {
    expect(checkPathPrefix('  ServerScriptService.Shop  ')).toEqual({
      ok: true,
      prefix: 'ServerScriptService.Shop',
    });
  });

  it('refuses a bare service root — that is the whole place, not a folder in it', () => {
    const result = checkPathPrefix('Workspace');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('service-root');
  });

  it('refuses a root the protocol does not address', () => {
    const result = checkPathPrefix('NotAService.Thing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('invalid-path');
  });

  it('refuses a segment that is not a safe identifier', () => {
    // The protocol rejects these because a name carrying a dot or a quote makes
    // a dotted path ambiguous — which is how a prefix check becomes escapable.
    const result = checkPathPrefix('ServerScriptService.Shop-Admin');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('invalid-path');
  });

  it('refuses nothing at all', () => {
    const result = checkPathPrefix('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('empty');
  });
});

describe('parsing a stored policy', () => {
  it('round-trips a valid one', () => {
    expect(parseAutoApply(SHOP)).toEqual(SHOP);
  });

  it('falls back to no policy — not to a merge — when the prefix is missing', () => {
    // The failure this prevents: `enabled: true` surviving a partial read while
    // the prefix is reconstructed as empty, which is an unscoped auto-apply
    // assembled out of a corrupted record.
    expect(parseAutoApply({ enabled: true })).toBeNull();
  });

  it('refuses a stored prefix that is a bare service root', () => {
    expect(parseAutoApply({ enabled: true, pathPrefix: 'Workspace' })).toBeNull();
  });

  it('refuses a stored prefix the protocol would not accept as a path', () => {
    expect(parseAutoApply({ enabled: true, pathPrefix: 'ServerScriptService.Shop; DROP' })).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    expect(parseAutoApply(null)).toBeNull();
    expect(parseAutoApply('auto')).toBeNull();
    expect(parseAutoApply(['ServerScriptService.Shop'])).toBeNull();
  });
});

describe('what a policy covers', () => {
  it('covers every appliable operation inside the prefix', () => {
    for (const op of AUTO_APPLIABLE_OPS) {
      expect(covers(SHOP, op, 'ServerScriptService.Shop.Handler')).toBe(true);
    }
  });

  it('never covers deleteInstance, anywhere, at any depth', () => {
    for (const op of NEVER_AUTO_APPLIED) {
      expect(covers(SHOP, op, 'ServerScriptService.Shop')).toBe(false);
      expect(covers(SHOP, op, 'ServerScriptService.Shop.Handler.Deep')).toBe(false);
    }
  });

  it('does not cover a sibling whose name merely starts the same way', () => {
    // The bug that turns a prefix allowlist into a hole: a naive `startsWith`
    // reports ShopAdmin as being inside Shop. `isWithin` is segment-aware.
    expect(covers(SHOP, 'writeScript', 'ServerScriptService.ShopAdmin.Handler')).toBe(false);
  });

  it('covers nothing while auto-apply is off', () => {
    expect(covers({ ...SHOP, enabled: false }, 'writeScript', 'ServerScriptService.Shop.H')).toBe(
      false,
    );
  });

  it('covers nothing when there is no policy', () => {
    expect(covers(null, 'writeScript', 'ServerScriptService.Shop.Handler')).toBe(false);
  });

  it('does not cover an operation the protocol has but this policy never lists', () => {
    expect(covers(SHOP, 'somethingNewInTheProtocol', 'ServerScriptService.Shop')).toBe(false);
  });
});
