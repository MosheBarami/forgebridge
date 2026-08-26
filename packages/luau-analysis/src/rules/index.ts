import type { Finding } from '@forgebridge/protocol';
import type { RuleContext, Severity } from '../query.js';
import { deprecatedWaitSpawn, noGetfenvSetfenv, noLoadstring } from './globals.js';
import { httpEgressUnallowlisted } from './http-egress.js';
import { unboundedHeartbeat, whileTrueNoYield } from './loops.js';
import { remoteNoValidation } from './remote-validation.js';
import { requireUnreviewedAsset } from './require-asset.js';

export interface Rule {
  /** Stable id, matching the protocol's `Finding.rule` pattern. Never renamed — suppressions and docs point at it. */
  id: string;
  /** Every severity this rule can emit. `error` makes the verdict `fail`; `warning` makes it `warn`. */
  severities: readonly Severity[];
  /** One line, for the README table and for `forge.list_rules` when a connector grows one. */
  summary: string;
  run(context: RuleContext): Finding[];
}

/**
 * Order is the order findings are reported in before sorting, and it is also
 * the order a reader meets them in the README: arbitrary code execution first,
 * then supply chain, then egress, then the ways a script freezes Studio, then
 * the exploit surface, then deprecations.
 */
export const RULES: readonly Rule[] = [
  noLoadstring,
  noGetfenvSetfenv,
  requireUnreviewedAsset,
  httpEgressUnallowlisted,
  unboundedHeartbeat,
  whileTrueNoYield,
  remoteNoValidation,
  deprecatedWaitSpawn,
];

/**
 * Emitted by `analyse` itself rather than by a rule, because a source that does
 * not tokenize has no token stream for a rule to read.
 */
export const SYNTAX_ERROR_RULE = 'luau/syntax-error';

/** Emitted when the analyser stopped early. Never reported as a pass — see `analyse`. */
export const INCOMPLETE_RULE = 'luau/analysis-incomplete';
