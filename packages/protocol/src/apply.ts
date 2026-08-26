import { z } from 'zod';
import { Operation } from './operation.js';

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
