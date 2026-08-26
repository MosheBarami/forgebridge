import { LIMITS, deletionCount, isWithin, pathsOf, InstancePath } from '@forgebridge/protocol';
import type { ChangeSet, Validation } from '@forgebridge/protocol';

/**
 * The project policy check. It runs on every ChangeSet before a human sees one,
 * because an approval UI that shows a set which was never going to be legal is
 * training the user to click through (THREAT-MODEL T2, T3).
 *
 * It answers three separate questions, and they stay separate on purpose:
 *
 *   1. Is every path this set touches inside the project's allowlist?
 *   2. Does it delete enough that a human must confirm regardless of policy?
 *   3. Is it eligible for the project's opt-in auto-apply (ADR-012)?
 *
 * A "yes" to 1 is not a "yes" to 3, and 2 overrides both.
 */

export interface AutoApplyPolicy {
  enabled: boolean;
  /**
   * Auto-apply is scoped to one prefix and one prefix only (ADR-012). A project
   * that wants two folders auto-applied does not get auto-apply; it gets a
   * narrower project.
   */
  pathPrefix: string;
}

export interface ProjectPolicy {
  /**
   * Instance paths a ChangeSet may touch, itself or beneath. Compared with the
   * protocol's `isWithin`, never `startsWith`.
   */
  allowedPathPrefixes: readonly string[];
  autoApply?: AutoApplyPolicy | null;
}

/**
 * What a project with no configured policy gets.
 *
 * Missing configuration reads as *deny*, not as *allow*. An absent policy that
 * means "everything is permitted" is the single most common way a path allowlist
 * turns out to have been off for a month, and nobody notices until a ChangeSet
 * writes somewhere nobody expected.
 */
export const DENY_ALL_POLICY: ProjectPolicy = Object.freeze({
  allowedPathPrefixes: Object.freeze([]) as readonly string[],
  autoApply: null,
});

export interface BulkDeleteGate {
  deletions: number;
  threshold: number;
  reason: string;
}

export interface AutoApplyDecision {
  eligible: boolean;
  /** Always populated, for "yes" as well as "no". The UI shows it either way. */
  reason: string;
}

export interface PolicyDecision {
  /** Exactly the protocol's `Validation['policy']` shape, ready to embed. */
  policy: Validation['policy'];
  /**
   * True when this set may not be applied on a human's approval alone — the
   * approver must additionally confirm the deletion count.
   */
  requiresConfirmation: boolean;
  bulkDelete: BulkDeleteGate | null;
  autoApply: AutoApplyDecision;
}

/**
 * The protocol caps `Validation.policy.violations` at 200 entries of 500
 * characters. Mirrored here rather than imported because the protocol keeps them
 * inline in the Zod schema; `policy.test.ts` parses a produced decision through
 * `Validation` so this copy cannot drift without a test going red.
 */
const MAX_VIOLATIONS = 200;
const MAX_VIOLATION_CHARS = 500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** True when `path` is inside at least one prefix. Segment-aware via `isWithin`. */
function withinAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => isWithin(path, prefix));
}

export function checkPolicy(set: ChangeSet, policy: ProjectPolicy): PolicyDecision {
  const violations: string[] = [];

  // A malformed prefix is reported rather than silently ignored. Left alone it
  // would just never match anything, which looks identical to a policy that is
  // working — the worst possible failure mode for a security control.
  const prefixes: string[] = [];
  for (const prefix of policy.allowedPathPrefixes) {
    if (InstancePath.safeParse(prefix).success) {
      prefixes.push(prefix);
    } else {
      violations.push(
        `allowed path prefix "${clip(prefix, 100)}" is not a valid instance path, so it permits nothing`,
      );
    }
  }

  if (prefixes.length === 0) {
    // One violation, not one per operation: a 500-operation set against an
    // unconfigured project would otherwise bury the actual problem.
    violations.push(
      'this project has no usable path policy; set allowedPathPrefixes before any ChangeSet can be applied',
    );
  } else {
    set.operations.forEach((operation, index) => {
      // `pathsOf` returns both ends of a moveInstance. Checking only the source
      // would let a set move an instance out of the allowlist and into anywhere.
      for (const path of pathsOf(operation)) {
        if (!withinAny(path, prefixes)) {
          violations.push(
            `operation ${index} (${operation.op}) touches "${clip(path, 200)}", which is outside every allowed path prefix`,
          );
        }
      }
    });
  }

  const deletions = deletionCount(set);
  const threshold = LIMITS.BULK_DELETE_CONFIRM_THRESHOLD;
  const bulkDelete: BulkDeleteGate | null =
    deletions > threshold
      ? {
          deletions,
          threshold,
          reason: `this set deletes ${deletions} instances, above the confirmation threshold of ${threshold}`,
        }
      : null;

  const status: Validation['policy']['status'] = violations.length === 0 ? 'ok' : 'fail';

  return {
    policy: { status, violations: capViolations(violations) },
    requiresConfirmation: bulkDelete !== null,
    bulkDelete,
    autoApply: decideAutoApply(set, policy, prefixes, status),
  };
}

function capViolations(violations: string[]): string[] {
  const clipped = violations.map((violation) => clip(violation, MAX_VIOLATION_CHARS));
  if (clipped.length <= MAX_VIOLATIONS) return clipped;
  const kept = clipped.slice(0, MAX_VIOLATIONS - 1);
  kept.push(`…and ${clipped.length - kept.length} further violations, not listed`);
  return kept;
}

function decideAutoApply(
  set: ChangeSet,
  policy: ProjectPolicy,
  prefixes: readonly string[],
  policyStatus: Validation['policy']['status'],
): AutoApplyDecision {
  const autoApply = policy.autoApply;
  if (!autoApply || !autoApply.enabled) {
    return { eligible: false, reason: 'auto-apply is not enabled for this project' };
  }
  if (policyStatus !== 'ok') {
    return { eligible: false, reason: 'the set failed the project path policy' };
  }
  if (!InstancePath.safeParse(autoApply.pathPrefix).success) {
    return {
      eligible: false,
      reason: `the auto-apply prefix "${clip(autoApply.pathPrefix, 100)}" is not a valid instance path`,
    };
  }
  // Auto-apply may narrow the project's allowlist; it may never widen it.
  if (!withinAny(autoApply.pathPrefix, prefixes)) {
    return {
      eligible: false,
      reason: `the auto-apply prefix "${autoApply.pathPrefix}" is not inside the project path policy`,
    };
  }

  // ADR-012, without exception. moveInstance stays eligible because its inverse
  // is a `moveBack` the journal can always replay; a delete's inverse is a
  // serialised subtree, and that is the one inverse journal retention can age
  // out from under a user who wants it back.
  const deletion = set.operations.findIndex((operation) => operation.op === 'deleteInstance');
  if (deletion !== -1) {
    return {
      eligible: false,
      reason: `operation ${deletion} deletes an instance, which auto-apply never covers`,
    };
  }

  for (const [index, operation] of set.operations.entries()) {
    for (const path of pathsOf(operation)) {
      if (!isWithin(path, autoApply.pathPrefix)) {
        return {
          eligible: false,
          reason: `operation ${index} touches "${clip(path, 200)}", outside the auto-apply scope "${autoApply.pathPrefix}"`,
        };
      }
    }
  }

  return {
    eligible: true,
    reason: `every operation is inside "${autoApply.pathPrefix}" and none deletes an instance`,
  };
}
