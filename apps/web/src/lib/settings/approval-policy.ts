import type { AutoApplyPolicy } from '@forgebridge/core';
import { InstancePath, SERVICE_ROOTS, isWithin } from '@forgebridge/protocol';

/**
 * The approval policy, browser side.
 *
 * ── The shape is the core's, not this app's ────────────────────────────────
 *
 * `AutoApplyPolicy` is imported from `@forgebridge/core`, where `checkPolicy`
 * makes the real decision on every ChangeSet. It is `{ enabled, pathPrefix }` —
 * **one** prefix, and the core's own comment says why: *"Auto-apply is scoped to
 * one prefix and one prefix only (ADR-012). A project that wants two folders
 * auto-applied does not get auto-apply; it gets a narrower project."*
 *
 * That constraint is load-bearing for this milestone's brief, which asks for a
 * scope that is hard to widen by accident. A list invites growth — each new
 * entry is a small, individually reasonable act, and the sum is a policy nobody
 * decided on. One prefix cannot grow; it can only be replaced, which is visible.
 *
 * The import is **type-only**, so nothing from the core reaches the browser
 * bundle. What crosses is the obligation to agree with it: if the core's shape
 * changes, this file stops compiling, which is the failure worth having. A
 * second definition here that merely looked the same would let the UI collect
 * three folders while the daemon enforced one — a user who set a scope and got
 * a different one is the worst outcome an approval surface can produce.
 *
 * ── What this file adds, and what it is not ────────────────────────────────
 *
 * It adds *pre-flight* validation: the checks that let the form refuse a prefix
 * at the moment it is typed rather than at the moment a run is refused. It is
 * not a second policy engine. `checkPolicy` in the core is the decision, it runs
 * inside the trust boundary, and it applies two rules this browser cannot: that
 * the prefix must sit inside the project's own `allowedPathPrefixes`, and that
 * a set failing the path policy is never eligible whatever this says.
 *
 * ── Not enforced yet, and the UI says so ───────────────────────────────────
 *
 * TODO(M38): the daemon has no route that accepts a project's approval policy —
 * `checkPolicy` reads a `ProjectPolicy` the daemon was started with. Until a
 * `PUT /v1/projects/:id/policy` exists, what a user sets here is a recorded
 * intention held in this browser, and `describeEnforcement` is what puts that
 * on screen rather than letting the switch imply otherwise. Owner: the daemon
 * maintainer, as an additive route.
 */

/** The stored value. `null` is "no auto-apply policy", which is the core's own default. */
export type StoredAutoApply = AutoApplyPolicy | null;

export const DEFAULT_AUTO_APPLY: StoredAutoApply = null;

/**
 * The operations auto-apply may ever cover. `deleteInstance` is absent by
 * construction, mirroring the core's `decideAutoApply`, which refuses a set the
 * moment it finds one — at any index, inside the prefix or not.
 */
export const AUTO_APPLIABLE_OPS = [
  'createInstance',
  'setProperty',
  'writeScript',
  'moveInstance',
] as const;
export type AutoAppliableOp = (typeof AUTO_APPLIABLE_OPS)[number];

/**
 * Named rather than left as "the ops missing from the list above", so the
 * exclusion is legible at every call site instead of being a fact about a list
 * somebody has to notice is short.
 */
export const NEVER_AUTO_APPLIED = ['deleteInstance'] as const;

/** Why a candidate prefix was refused, in words a field error can show. */
export type PrefixRejection =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid-path'; readonly detail: string }
  | { readonly kind: 'service-root'; readonly root: string };

export type PrefixCheck =
  | { readonly ok: true; readonly prefix: string }
  | { readonly ok: false; readonly rejection: PrefixRejection };

/**
 * Validate one candidate prefix.
 *
 * Two refusals, and the second is stricter than the protocol requires:
 *
 *   - **Not an `InstancePath`.** The protocol's own parser, not a regex written
 *     here. It rejects segments that are not safe identifiers, which is the
 *     same check that stops a model smuggling a `.` into an instance name to
 *     escape a prefix comparison.
 *   - **A bare service root.** `Workspace` is not a scope; it is auto-apply
 *     over the whole place wearing a scope's clothes. The core would also
 *     refuse it — but only later, as "not inside the project path policy",
 *     which is a true message about a different problem. Refusing it here, by
 *     name, is the difference between a user learning what they did wrong and a
 *     user learning that something did not work.
 */
export function checkPathPrefix(candidate: string): PrefixCheck {
  const prefix = candidate.trim();
  if (prefix.length === 0) return { ok: false, rejection: { kind: 'empty' } };

  const parsed = InstancePath.safeParse(prefix);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: {
        kind: 'invalid-path',
        detail: parsed.error.issues[0]?.message ?? 'not an addressable instance path',
      },
    };
  }

  if (!prefix.includes('.') && (SERVICE_ROOTS as readonly string[]).includes(prefix)) {
    return { ok: false, rejection: { kind: 'service-root', root: prefix } };
  }

  return { ok: true, prefix };
}

/**
 * Parse a stored policy back out of whatever the browser held.
 *
 * All-or-nothing. A record that does not fully satisfy the shape becomes
 * `null` — no auto-apply — rather than being merged field by field. A merge
 * would let a record that lost its `pathPrefix` keep `enabled: true`, which is
 * an unscoped auto-apply assembled out of a partial read, and that is the one
 * state this file exists to make unreachable.
 *
 * The prefix is re-validated on read, not only on write: a record edited by
 * hand in devtools, or written by an older build with a looser check, is
 * exactly the input a policy must not widen on.
 */
export function parseAutoApply(value: unknown): StoredAutoApply {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  if (typeof record['enabled'] !== 'boolean') return null;
  if (typeof record['pathPrefix'] !== 'string') return null;

  const check = checkPathPrefix(record['pathPrefix']);
  if (!check.ok) return null;

  return { enabled: record['enabled'], pathPrefix: check.prefix };
}

/**
 * Would this policy cover an operation at this path?
 *
 * A *display* answer, mirroring the core's `decideAutoApply` for the two rules a
 * browser can evaluate on its own. It is exported so the generation surface
 * (M35) can mark, on a diff, which operations the user's own policy would have
 * applied without asking — and so that this file stays the single browser-side
 * answer to that question rather than the second one.
 *
 * It is deliberately *more* conservative than the core in one direction and
 * cannot be less: it knows nothing about the project's `allowedPathPrefixes` or
 * about the set's validation status, both of which can only turn an eligible
 * set ineligible. So a `true` here can still be refused by the daemon, and a
 * `false` here is never overturned by it.
 */
export function covers(policy: StoredAutoApply, op: string, path: string): boolean {
  if (!policy || !policy.enabled) return false;
  if ((NEVER_AUTO_APPLIED as readonly string[]).includes(op)) return false;
  if (!(AUTO_APPLIABLE_OPS as readonly string[]).includes(op)) return false;
  return isWithin(path, policy.pathPrefix);
}

/**
 * What this build can honestly say about who enforces the policy.
 *
 * Two states, and the difference is on screen rather than assumed: a policy
 * nothing enforces is a preference, and calling it a policy in the UI would be
 * the kind of claim this repository's review culture exists to catch.
 */
export interface EnforcementNote {
  /** True once a daemon build accepts a policy. Never true today. */
  readonly enforced: boolean;
  readonly key: string;
}

export function describeEnforcement(): EnforcementNote {
  // Not inferred from the daemon's health response: no field on it reports
  // policy support, and reading support out of a version string would be
  // guessing at a contract. When the route lands, this reads the capability the
  // daemon advertises for it. TODO(M38).
  return { enforced: false, key: 'settings.approval.enforcement.notYet' };
}
