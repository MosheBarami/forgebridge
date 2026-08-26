import { describe, it, expect } from 'vitest';
import { LIMITS, Validation } from '@forgebridge/protocol';
import { checkPolicy, DENY_ALL_POLICY, type ProjectPolicy } from '../src/policy.js';
import { createOp, createRefOp, deleteOp, makeChangeSet, moveOp, refOp } from './helpers.js';

const SHOP_ONLY: ProjectPolicy = { allowedPathPrefixes: ['ServerScriptService.Shop'], autoApply: null };

describe('path allowlist', () => {
  it('allows a change inside an allowed prefix', () => {
    const set = makeChangeSet([createOp('ServerScriptService.Shop.PurchaseHandler')]);
    expect(checkPolicy(set, SHOP_ONLY).policy.status).toBe('ok');
  });

  it('allows a change at the prefix itself', () => {
    const set = makeChangeSet([createOp('ServerScriptService.Shop')]);
    expect(checkPolicy(set, SHOP_ONLY).policy.status).toBe('ok');
  });

  it('refuses the ShopAdmin escape from a Shop allowlist', () => {
    // The exact hole a startsWith check leaves open: "ServerScriptService.ShopAdmin"
    // shares a string prefix with "ServerScriptService.Shop" and is NOT inside it.
    const set = makeChangeSet([createOp('ServerScriptService.ShopAdmin.Backdoor')]);
    const decision = checkPolicy(set, SHOP_ONLY);

    expect(decision.policy.status).toBe('fail');
    expect(decision.policy.violations).toHaveLength(1);
    expect(decision.policy.violations[0]).toContain('ServerScriptService.ShopAdmin.Backdoor');
    expect(decision.policy.violations[0]).toContain('outside every allowed path prefix');
  });

  it('refuses a bare sibling of the allowed prefix', () => {
    const set = makeChangeSet([createOp('ServerScriptService.ShopAdmin')]);
    expect(checkPolicy(set, SHOP_ONLY).policy.status).toBe('fail');
  });

  it('checks BOTH ends of a move, not just the source', () => {
    // Checking only `path` would let a set walk an instance out of the allowlist.
    const set = makeChangeSet([moveOp('ServerScriptService.Shop.Thing', 'ServerScriptService.ShopAdmin.Thing')]);
    const decision = checkPolicy(set, SHOP_ONLY);

    expect(decision.policy.status).toBe('fail');
    expect(decision.policy.violations[0]).toContain('ServerScriptService.ShopAdmin.Thing');
  });

  it('sees an InstanceRef target that appears only in a property VALUE', () => {
    // The operation writes inside the allowlist. The value it writes points at
    // "ServerScriptService.ShopAdmin.Secret", which appears nowhere in
    // `operation.path` — so while `pathsOf` returned only the operation's own
    // path, this set was indistinguishable from a legal one and the allowlist
    // was never shown the path the model actually chose.
    const set = makeChangeSet([
      refOp('ServerScriptService.Shop.Model', 'ServerScriptService.ShopAdmin.Secret'),
    ]);
    const decision = checkPolicy(set, SHOP_ONLY);

    expect(decision.policy.status).toBe('fail');
    expect(decision.policy.violations[0]).toContain('ServerScriptService.ShopAdmin.Secret');
    expect(decision.policy.violations[0]).toContain('outside every allowed path prefix');
  });

  it('sees an InstanceRef target inside a createInstance property bag', () => {
    // Same hole, reached through the other operation that carries a property bag.
    const set = makeChangeSet([
      createRefOp('ServerScriptService.Shop.Model', 'Workspace.Elsewhere'),
    ]);
    const decision = checkPolicy(set, SHOP_ONLY);

    expect(decision.policy.status).toBe('fail');
    expect(decision.policy.violations[0]).toContain('Workspace.Elsewhere');
  });

  it('still allows a reference that stays inside the allowlist', () => {
    // The counterpart the two tests above need: the check reports the reference
    // target, it does not simply refuse every operation that carries one.
    const set = makeChangeSet([
      refOp('ServerScriptService.Shop.Model', 'ServerScriptService.Shop.Anchor'),
    ]);
    expect(checkPolicy(set, SHOP_ONLY).policy.status).toBe('ok');
  });

  it('refuses everything when no policy is configured', () => {
    const set = makeChangeSet([createOp('ServerScriptService.Shop.Thing')]);
    const decision = checkPolicy(set, DENY_ALL_POLICY);

    expect(decision.policy.status).toBe('fail');
    expect(decision.policy.violations[0]).toContain('no usable path policy');
  });

  it('reports a malformed prefix instead of silently permitting nothing', () => {
    const set = makeChangeSet([createOp('ServerScriptService.Shop.Thing')]);
    const decision = checkPolicy(set, { allowedPathPrefixes: ['game.Players'], autoApply: null });

    expect(decision.policy.status).toBe('fail');
    expect(decision.policy.violations.some((v) => v.includes('is not a valid instance path'))).toBe(true);
  });

  it('produces a result the protocol accepts even when violations overflow the cap', () => {
    const operations = Array.from({ length: 400 }, (_, i) => createOp(`ServerScriptService.ShopAdmin.N${i}`));
    const decision = checkPolicy(makeChangeSet(operations), SHOP_ONLY);

    const parsed = Validation.safeParse({
      luau: { status: 'ok', findings: [] },
      policy: decision.policy,
      computedAt: '2026-08-26T00:00:00.000Z',
      computedBy: 'test',
    });

    expect(parsed.success).toBe(true);
    expect(decision.policy.violations).toHaveLength(200);
    expect(decision.policy.violations[199]).toContain('further violations, not listed');
  });
});

describe('bulk-delete gate', () => {
  const deletes = (count: number) =>
    makeChangeSet(Array.from({ length: count }, (_, i) => deleteOp(`ServerScriptService.Shop.Item${i}`)));

  it('does not gate a deletion count at the threshold', () => {
    const decision = checkPolicy(deletes(LIMITS.BULK_DELETE_CONFIRM_THRESHOLD), SHOP_ONLY);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.bulkDelete).toBeNull();
  });

  it('gates one deletion above the threshold', () => {
    const decision = checkPolicy(deletes(LIMITS.BULK_DELETE_CONFIRM_THRESHOLD + 1), SHOP_ONLY);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.bulkDelete?.deletions).toBe(LIMITS.BULK_DELETE_CONFIRM_THRESHOLD + 1);
  });

  it('gates regardless of the paths being fully allowed', () => {
    const decision = checkPolicy(deletes(30), SHOP_ONLY);
    expect(decision.policy.status).toBe('ok');
    expect(decision.requiresConfirmation).toBe(true);
  });
});

describe('auto-apply', () => {
  const autoShop: ProjectPolicy = {
    allowedPathPrefixes: ['ServerScriptService.Shop', 'ReplicatedStorage'],
    autoApply: { enabled: true, pathPrefix: 'ServerScriptService.Shop' },
  };

  it('is off unless the project opts in', () => {
    const decision = checkPolicy(makeChangeSet([createOp('ServerScriptService.Shop.A')]), SHOP_ONLY);
    expect(decision.autoApply.eligible).toBe(false);
    expect(decision.autoApply.reason).toContain('not enabled');
  });

  it('covers a set entirely inside its scope', () => {
    const decision = checkPolicy(makeChangeSet([createOp('ServerScriptService.Shop.A')]), autoShop);
    expect(decision.autoApply.eligible).toBe(true);
  });

  it('NEVER covers deleteInstance, even inside its scope', () => {
    const decision = checkPolicy(makeChangeSet([deleteOp('ServerScriptService.Shop.A')]), autoShop);
    expect(decision.autoApply.eligible).toBe(false);
    expect(decision.autoApply.reason).toContain('deletes an instance');
  });

  it('does not cover a set that is legal for the project but outside the auto-apply scope', () => {
    const decision = checkPolicy(makeChangeSet([createOp('ReplicatedStorage.Shared')]), autoShop);
    expect(decision.policy.status).toBe('ok');
    expect(decision.autoApply.eligible).toBe(false);
    expect(decision.autoApply.reason).toContain('outside the auto-apply scope');
  });

  it('does not cover a set whose only escape is a reference target', () => {
    // `ReplicatedStorage` is inside the project policy but outside the
    // auto-apply prefix, so this set is legal for the project and must still
    // not apply itself. Without reference targets in `pathsOf` the scope check
    // saw a set entirely inside "ServerScriptService.Shop" and auto-applied it.
    const set = makeChangeSet([
      refOp('ServerScriptService.Shop.Model', 'ReplicatedStorage.Shared'),
    ]);
    const decision = checkPolicy(set, autoShop);

    expect(decision.policy.status).toBe('ok');
    expect(decision.autoApply.eligible).toBe(false);
    expect(decision.autoApply.reason).toContain('outside the auto-apply scope');
  });

  it('refuses an auto-apply scope that is wider than the project policy', () => {
    const wider: ProjectPolicy = {
      allowedPathPrefixes: ['ServerScriptService.Shop'],
      autoApply: { enabled: true, pathPrefix: 'ServerScriptService' },
    };
    const decision = checkPolicy(makeChangeSet([createOp('ServerScriptService.Shop.A')]), wider);
    expect(decision.autoApply.eligible).toBe(false);
    expect(decision.autoApply.reason).toContain('not inside the project path policy');
  });

  it('does not cover a set that failed the path policy', () => {
    const decision = checkPolicy(makeChangeSet([createOp('Workspace.Elsewhere')]), autoShop);
    expect(decision.autoApply.eligible).toBe(false);
    expect(decision.autoApply.reason).toContain('failed the project path policy');
  });
});
