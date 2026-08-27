import { z } from 'zod';
import { Operation } from './operation.js';
import { LIMITS } from './limits.js';

export const OperationOutcome = z.object({
  index: z.number().int().min(0),
  ok: z.boolean(),
  /** Present only when ok is false. Plain language, no Luau stack traces. */
  error: z.string().max(1000).optional(),
});
export type OperationOutcome = z.infer<typeof OperationOutcome>;

/**
 * What the consumer reports back after attempting a ChangeSet.
 *
 * A partial apply is a legal outcome, not an error condition. The plugin
 * reports exactly how far it got; it never claims a clean apply it did not
 * achieve, and it never silently rolls back on its own — that is the user's
 * call, made against a journal that already exists.
 */
export const ApplyResult = z.object({
  changeSetId: z.string().uuid(),
  outcomes: z.array(OperationOutcome),
  /** The tree version after this apply. Becomes the next set's baseVersion. */
  newVersion: z.number().int().min(0),
  journalId: z.string().uuid(),
  appliedAt: z.string().datetime(),
  /** Plugin build that performed the apply, for field debugging. */
  pluginVersion: z.string().max(40),
});
export type ApplyResult = z.infer<typeof ApplyResult>;

export function isFullyApplied(result: ApplyResult): boolean {
  return result.outcomes.length > 0 && result.outcomes.every((o) => o.ok);
}

/**
 * The inverse of an applied operation, captured *before* it ran.
 *
 * This is the load-bearing safety mechanism of the whole system. Validation
 * reduces how often it is needed; it never removes the need. Note that a
 * delete's inverse carries the entire removed subtree — that is why journals
 * have a retention policy rather than living forever.
 */
export const InverseOperation = z.discriminatedUnion('inverse', [
  z.object({ inverse: z.literal('deleteCreated'), path: z.string() }),
  z.object({ inverse: z.literal('restoreProperty'), path: z.string(), property: z.string(), previous: z.unknown() }),
  z.object({ inverse: z.literal('restoreSource'), path: z.string(), previousSource: z.string() }),
  z.object({ inverse: z.literal('moveBack'), path: z.string(), from: z.string() }),
  /**
   * Serialised subtree, in the plugin's own model format. Opaque to the server
   * on purpose: the server has no business understanding Roblox binary models,
   * and a format change must not require a server release.
   */
  z.object({ inverse: z.literal('restoreSubtree'), parentPath: z.string(), serialised: z.string() }),
]);
export type InverseOperation = z.infer<typeof InverseOperation>;

export const JournalEntry = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  summary: z.string().max(300),
  /** Only the operations that actually ran, paired with their inverses. */
  applied: z.array(z.object({ index: z.number().int().min(0), operation: Operation })),
  inverses: z.array(InverseOperation),
  versionBefore: z.number().int().min(0),
  versionAfter: z.number().int().min(0),
  appliedAt: z.string().datetime(),
  rolledBackAt: z.string().datetime().nullable().default(null),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

export const RollbackRequest = z.object({
  journalId: z.string().uuid(),
  /** Guards against rolling back onto a tree that moved since. */
  expectedVersion: z.number().int().min(0),
  reason: z.string().max(500).optional(),
});
export type RollbackRequest = z.infer<typeof RollbackRequest>;

/**
 * The outcome of replaying one inverse operation.
 *
 * `index` is an index into the journal's `inverses` array, NOT into the
 * ChangeSet's operations. They are different lists — a journal holds only the
 * operations that actually ran — and a consumer that conflates them reports
 * failures against the wrong operation, which is a worse lie than reporting
 * nothing.
 *
 * Structurally identical to `OperationOutcome` and deliberately not an alias of
 * it: the two count in different lists, and a shared name is how a reader comes
 * to believe they index the same thing.
 */
export const RollbackOutcome = z.object({
  index: z.number().int().min(0),
  ok: z.boolean(),
  /** Present only when ok is false. Plain language, no Luau stack traces. */
  error: z.string().max(1000).optional(),
});
export type RollbackOutcome = z.infer<typeof RollbackOutcome>;

/**
 * What the consumer reports back after replaying a journal's inverses.
 *
 * ADDITIVE, and a sibling of `ApplyResult` rather than a field on it. The two
 * are keyed on different things and index into different lists: an `ApplyResult`
 * is keyed on `changeSetId` and its outcomes index that set's operations, while
 * this is keyed on `journalId` and its outcomes index that journal's `inverses`.
 * Bolting an optional `rolledBackJournalId` onto `ApplyResult` would make every
 * other field on it conditional on a flag, and the one mechanism that must never
 * guess would then be read through an `if`.
 *
 * Until this existed there was no shape on the wire for "the reversal of journal
 * X finished", so `JournalEntry.rolledBackAt` stayed null forever and every
 * surface above the daemon — the CLI, the A2A connector, the Python SDK — could
 * only ever say "dispatched".
 *
 * A partial reversal is a legal outcome and is reported as one, for the reason
 * `ApplyResult` reports a partial apply: it is the honest answer, and it is
 * worse than either neighbour. The tree is then in a state neither the user nor
 * the journal describes and the remaining inverses have been consumed, so a
 * recipient must be able to tell it from a clean reversal. See
 * `rollbackStatusOf`, which is the one reading of these outcomes.
 */
export const RollbackResult = z.object({
  journalId: z.string().uuid(),
  /** The apply being reversed. Checked against the journal, never believed. */
  changeSetId: z.string().uuid(),
  /** One per inverse attempted, in the order they were replayed. */
  outcomes: z.array(RollbackOutcome).max(LIMITS.MAX_OPERATIONS),
  /** The tree version after the reversal. Becomes the next set's baseVersion. */
  newVersion: z.number().int().min(0),
  rolledBackAt: z.string().datetime(),
  /** Plugin build that performed the reversal, for field debugging. */
  pluginVersion: z.string().max(40),
});
export type RollbackResult = z.infer<typeof RollbackResult>;

/**
 * What a rollback achieved, in one word.
 *
 * `partial` is the one that matters, and it is a status of its own rather than
 * being rounded to either neighbour. Rounding it up to `rolled_back` would tell
 * a user their place is back the way it was when it is not; rounding it down to
 * `failed` would tell them nothing happened when something did, and the inverses
 * that would have undone it are spent.
 */
export type RollbackStatus = 'rolled_back' | 'partial' | 'failed';

/**
 * Read a `RollbackResult` as a status.
 *
 * Stated once, here, because three surfaces were each answering this question
 * slightly differently. An empty outcome list is `failed`, not `rolled_back`:
 * "no inverse was replayed" is the shape of a consumer that could not start, and
 * `every()` over an empty array is true — which is exactly how a fail-closed
 * check turns into "I found no problem, so this is fine".
 */
export function rollbackStatusOf(result: RollbackResult): RollbackStatus {
  if (result.outcomes.length === 0) return 'failed';
  if (result.outcomes.every((outcome) => outcome.ok)) return 'rolled_back';
  return result.outcomes.some((outcome) => outcome.ok) ? 'partial' : 'failed';
}
