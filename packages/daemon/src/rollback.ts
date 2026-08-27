import { z } from 'zod';
import {
  ForgeBridgeError,
  InverseOperation,
  JournalEntry,
  LIMITS,
  Operation,
  parentOf,
  type Link,
} from '@forgebridge/protocol';
import { canonicalJson } from './envelope.js';
import type { DaemonStore, JournalRecord } from './store.js';

/**
 * Rollback: the second half of the mechanism ADR-012 calls load-bearing.
 *
 * The first half already worked. `POST /v1/journal/:id/rollback` dispatches a
 * reversal to the paired Studio session and answers `202 dispatched`, and every
 * surface above it — CLI, A2A, the Python SDK — is careful to say "dispatched"
 * rather than "rolled back". They are careful because two things were missing,
 * and this file is both of them:
 *
 *   1. **The journal never travelled.** `ApplyResult` carries a `journalId` and
 *      nothing else, so the inverse operations the plugin captured stayed in the
 *      Studio session that captured them. Close Studio and the only route back
 *      from an apply was gone. `JournalEntry` is *already* in the frozen
 *      protocol, with `applied`, `inverses` and the version bracket — it simply
 *      had no endpoint. `recordJournalEntry` gives it one. No protocol addition
 *      is needed for this half; it was a missing route, not a missing type.
 *
 *   2. **Completion could not be reported.** There is no shape on the wire for
 *      "the reversal of journal X finished". That one is a genuine protocol gap,
 *      and `RollbackResult` below is a local stand-in — see its own comment.
 *
 * What this file will not do is interpret a Roblox model. `restoreSubtree`
 * carries an opaque `serialised` blob and it stays opaque here: the daemon
 * stores it, orders it, checks that it is paired with the delete it reverses,
 * and hands it back. Storing a blob is not understanding a format, and a format
 * change must still not require a daemon release.
 */

/**
 * The outcome of replaying one inverse operation.
 *
 * `index` is an index into the journal's `inverses` array, *not* into the
 * ChangeSet's operations. They are different lists — a journal holds only the
 * operations that actually ran — and a consumer that conflates them reports
 * failures against the wrong operation, which is a worse lie than reporting
 * nothing.
 */
export const RollbackOutcome = z.object({
  index: z.number().int().min(0),
  ok: z.boolean(),
  /** Present only when ok is false. Plain language, no Luau stack traces. */
  error: z.string().max(1000).optional(),
});
export type RollbackOutcome = z.infer<typeof RollbackOutcome>;

/**
 * TODO(M11-protocol): this belongs in `@forgebridge/protocol` beside
 * `ApplyResult`, as an additive sibling. It lives here because that package is
 * frozen to this milestone; the exact schema to add, and why it is a sibling
 * rather than a field on `ApplyResult`, is written out in the M11 report.
 *
 * The short version: `ApplyResult` is keyed on `changeSetId` and reports
 * outcomes indexed into that set's operations. A rollback is keyed on a
 * `journalId` and reports outcomes indexed into that journal's inverses. Bolting
 * an optional `rolledBackJournalId` onto `ApplyResult` would make every field on
 * it conditional on a flag, and the one mechanism that must never guess would be
 * read through an `if`.
 */
export const RollbackResult = z.object({
  journalId: z.string().uuid(),
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
 * What a rollback achieved.
 *
 * `partial` is the one that matters. A rollback that half-restores is worse than
 * one that never ran: the tree is now in a state neither the user nor the
 * journal describes, and the remaining inverses have been consumed. So it is a
 * status of its own rather than being rounded to either neighbour, and
 * `recordRollbackResult` refuses to stamp `rolledBackAt` on it.
 */
export type RollbackStatus = 'rolled_back' | 'partial' | 'failed';

export function rollbackStatusOf(result: RollbackResult): RollbackStatus {
  if (result.outcomes.length === 0) return 'failed';
  if (result.outcomes.every((outcome) => outcome.ok)) return 'rolled_back';
  return result.outcomes.some((outcome) => outcome.ok) ? 'partial' : 'failed';
}

/**
 * TODO(M11): fold into `DeliveryPayload` in `wire.ts`, whose `rollback` variant
 * currently carries only the ids and the expected version — which is all a
 * consumer needs when it is the same Studio session that captured the inverses,
 * and nothing like enough when it is not. Owner: whoever holds `wire.ts`; the
 * M11 report names the exact fields.
 *
 * The `steps` are already in replay order. Ordering them at dispatch rather than
 * on arrival means one implementation of the rule instead of one per consumer.
 */
export const RollbackDelivery = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  reason: z.string().max(500).optional(),
  /** The version to restore to. A consumer reports this back as `newVersion`. */
  restoresToVersion: z.number().int().min(0),
  steps: z.array(
    z.object({
      /** Index into the journal's `inverses`, which is what outcomes report on. */
      index: z.number().int().min(0),
      inverse: InverseOperation,
    }),
  ),
});
export type RollbackDelivery = z.infer<typeof RollbackDelivery>;

/** One inverse, paired with the operation it reverses. */
export interface RollbackStep {
  /** Index into `JournalEntry.inverses`. Outcomes are reported against this. */
  index: number;
  /** Index into `ChangeSet.operations`, from `JournalEntry.applied`. */
  operationIndex: number;
  operation: Operation;
  inverse: InverseOperation;
}

export interface RollbackPlan {
  journalId: string;
  changeSetId: string;
  projectId: string;
  /** The version the tree had before the apply — where a full replay lands. */
  restoresToVersion: number;
  /** The version the apply produced, and the version a rollback starts from. */
  reversesVersion: number;
  /** In replay order: last applied, first reversed. */
  steps: RollbackStep[];
}

/**
 * The rule that every inverse has to obey, stated once.
 *
 * A pair that does not obey it is a journal describing an apply that did not
 * happen, and replaying it would write something nobody approved. Checked here
 * rather than trusted because the journal arrives from the consumer, which is
 * across a trust boundary like everything else.
 *
 * The `moveInstance` case pins a reading the union alone does not disambiguate,
 * and which `plugin/src/Journal.luau` asks to have pinned: `moveBack.path` is
 * where the instance is *now* (the move's destination) and `moveBack.from` is
 * where it goes *back* to (the move's origin). Read the other way round a
 * rollback silently misplaces instances instead of erroring, which is the
 * failure mode a journal exists to make impossible.
 */
function assertInverts(operation: Operation, inverse: InverseOperation, at: number): void {
  const refuse = (detail: string): never => {
    throw new ForgeBridgeError(
      'invalid_request',
      `journal entry ${at} pairs a "${operation.op}" with a "${inverse.inverse}": ${detail}`,
      'The consumer must journal the inverse of the operation it ran; a mismatched pair cannot be replayed.',
    );
  };

  switch (operation.op) {
    case 'createInstance':
      if (inverse.inverse !== 'deleteCreated') refuse('a create is undone by deleting what it created');
      else if (inverse.path !== operation.path) refuse(`it names "${inverse.path}", not "${operation.path}"`);
      return;

    case 'setProperty':
      if (inverse.inverse !== 'restoreProperty') refuse('a property write is undone by restoring the previous value');
      else if (inverse.path !== operation.path) refuse(`it names "${inverse.path}", not "${operation.path}"`);
      else if (inverse.property !== operation.property) {
        refuse(`it restores "${inverse.property}", but the operation wrote "${operation.property}"`);
      }
      return;

    case 'writeScript':
      // Two legal inverses, and which one is correct depends on whether the
      // script already existed. A writeScript against a path that did not exist
      // creates it, so its inverse is a delete; getting this backwards leaves an
      // orphan script behind on every rollback. The daemon holds no tree, so it
      // cannot decide which case applied — it accepts either and rejects the
      // three that are wrong under both.
      if (inverse.inverse !== 'restoreSource' && inverse.inverse !== 'deleteCreated') {
        refuse('a script write is undone by restoring its source, or by deleting a script it created');
      } else if (inverse.path !== operation.path) refuse(`it names "${inverse.path}", not "${operation.path}"`);
      return;

    case 'moveInstance':
      if (inverse.inverse !== 'moveBack') refuse('a move is undone by moving back');
      else if (inverse.path !== operation.to) {
        refuse(`after the move the instance is at "${operation.to}", but the inverse looks for it at "${inverse.path}"`);
      } else if (inverse.from !== operation.path) {
        refuse(`the instance came from "${operation.path}", but the inverse returns it to "${inverse.from}"`);
      }
      return;

    case 'deleteInstance': {
      if (inverse.inverse !== 'restoreSubtree') refuse('a delete is undone by restoring the subtree it removed');
      else {
        const parent = parentOf(operation.path);
        if (inverse.parentPath !== parent) {
          refuse(`"${operation.path}" hung under "${parent ?? '(a service root)'}", not "${inverse.parentPath}"`);
        }
      }
      return;
    }
  }
}

/**
 * Turn a journal into an ordered replay, or refuse.
 *
 * Refusing is half the job. Every check below is a way a journal can be
 * unreplayable, and a rollback that discovers one of them halfway through has
 * already half-restored the tree — the state ADR-012 is least able to help with.
 * So the whole plan is validated before the first inverse is dispatched, and a
 * journal that fails any check produces no plan at all.
 */
export function planRollback(entry: JournalEntry): RollbackPlan {
  if (entry.rolledBackAt !== null) {
    throw new ForgeBridgeError(
      'invalid_request',
      `journal ${entry.id} was already rolled back at ${entry.rolledBackAt}`,
      'Its inverses have been consumed; there is nothing left to replay.',
    );
  }

  if (entry.applied.length !== entry.inverses.length) {
    // Not a mismatch to paper over by zipping the shorter list: the pairing is
    // positional, so a length disagreement means we cannot know which inverse
    // belongs to which operation. Replaying the overlap would reverse some of
    // an apply, which is the one outcome worse than reversing none of it.
    throw new ForgeBridgeError(
      'invalid_request',
      `journal ${entry.id} records ${entry.applied.length} applied operations but ${entry.inverses.length} inverses`,
      'The consumer must journal exactly one inverse per operation it applied, in the same order.',
    );
  }

  if (entry.applied.length === 0) {
    throw new ForgeBridgeError(
      'invalid_request',
      `journal ${entry.id} records no applied operations`,
      'An apply that changed nothing has nothing to reverse.',
    );
  }

  if (entry.versionAfter < entry.versionBefore) {
    throw new ForgeBridgeError(
      'invalid_request',
      `journal ${entry.id} claims to have moved the tree from version ${entry.versionBefore} to ${entry.versionAfter}`,
    );
  }

  const steps: RollbackStep[] = [];
  let previousIndex = -1;
  entry.applied.forEach((applied, at) => {
    // Applies are sequential, so the operation indices a journal records are
    // strictly increasing. A repeat or a reversal means the journal is not a
    // record of one pass through the ChangeSet, and the ordering the replay
    // depends on is not the ordering that happened.
    if (applied.index <= previousIndex) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${entry.id} records operation ${applied.index} after operation ${previousIndex}`,
        'Journal the operations in the order they were applied.',
      );
    }
    previousIndex = applied.index;

    const inverse = entry.inverses[at] as InverseOperation;
    assertInverts(applied.operation, inverse, at);
    steps.push({ index: at, operationIndex: applied.index, operation: applied.operation, inverse });
  });

  return {
    journalId: entry.id,
    changeSetId: entry.changeSetId,
    projectId: entry.projectId,
    restoresToVersion: entry.versionBefore,
    reversesVersion: entry.versionAfter,
    // Reversed, and this is the whole of why the plan is a list rather than a
    // set. Undo the last operation first: a ChangeSet that creates an instance
    // and then writes a property on it journals `deleteCreated` then
    // `restoreProperty`, and replaying those in application order deletes the
    // instance and then tries to restore a property on a path that is gone.
    steps: steps.reverse(),
  };
}

/**
 * The delivery a plan becomes.
 *
 * Only the inverses travel, not the operations they reverse: the consumer does
 * not need to be told what it did, and a rollback delivery that echoed the
 * original operations would be a second copy of the ChangeSet on the wire with
 * no reader.
 */
export function rollbackDeliveryFor(
  plan: RollbackPlan,
  options: { expectedVersion: number; reason?: string },
): RollbackDelivery {
  return RollbackDelivery.parse({
    journalId: plan.journalId,
    changeSetId: plan.changeSetId,
    expectedVersion: options.expectedVersion,
    ...(options.reason ? { reason: options.reason } : {}),
    restoresToVersion: plan.restoresToVersion,
    steps: plan.steps.map((step) => ({ index: step.index, inverse: step.inverse })),
  });
}

/**
 * TODO(M11): fold into `DaemonStore` in `store.ts`, alongside `putJournal`.
 *
 * It is a separate seam today only because `store.ts` belongs to another author
 * this milestone, and inventing a second `DaemonStore` here would be worse than
 * a small port that is obviously temporary. The M11 report names the three
 * methods to move.
 *
 * Note what this does *not* change about `JournalRecord`: the daemon still holds
 * the handle and the version bracket, and now also the inverses — because
 * without them a rollback cannot outlive the Studio session that applied the
 * change, which is not a safety net, it is a session feature. It still does not
 * interpret them.
 */
export interface JournalEntryStore {
  /** Refuses an id already recorded, for the reason `putJournal` does. */
  putJournalEntry(entry: JournalEntry): Promise<void>;
  getJournalEntry(id: string): Promise<JournalEntry | null>;
  putRollbackResult(result: RollbackResult): Promise<void>;
  getRollbackResult(journalId: string): Promise<RollbackResult | null>;
}

export class InMemoryJournalEntryStore implements JournalEntryStore {
  readonly #entries = new Map<string, JournalEntry>();
  readonly #results = new Map<string, RollbackResult>();

  async putJournalEntry(entry: JournalEntry): Promise<void> {
    if (this.#entries.has(entry.id)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${entry.id} already carries inverse operations`,
        'The inverses of an apply are captured once, before it runs; a second upload would replace the only route back.',
      );
    }
    this.#entries.set(entry.id, entry);
  }

  async getJournalEntry(id: string): Promise<JournalEntry | null> {
    return this.#entries.get(id) ?? null;
  }

  async putRollbackResult(result: RollbackResult): Promise<void> {
    this.#results.set(result.journalId, result);
  }

  async getRollbackResult(journalId: string): Promise<RollbackResult | null> {
    return this.#results.get(journalId) ?? null;
  }
}

export interface RollbackDeps {
  store: DaemonStore;
  journals: JournalEntryStore;
  now(): number;
}

/**
 * `POST /v1/journal/:id/entry` — a consumer uploading the inverses it captured.
 *
 * Consumer surface: the body arrives inside a MAC'd envelope like an
 * `ApplyResult`, and for the same reason. This is the record that decides
 * whether a destructive apply is survivable, so a process that can reach
 * loopback must not be able to write one.
 *
 * The entry is checked against what the daemon already recorded from the
 * `ApplyResult` rather than believed. A journal is a claim about an apply, and a
 * claim that disagrees with the apply the daemon witnessed describes a different
 * apply — one whose "inverses" would write operations no human approved.
 */
export async function recordJournalEntry(
  deps: RollbackDeps,
  link: Link,
  entry: JournalEntry,
): Promise<{ journalId: string; changeSetId: string; inverses: number }> {
  const record = await deps.store.getJournal(entry.id);
  if (!record) {
    throw new ForgeBridgeError(
      'not_found',
      'no such journal entry',
      'Report the ApplyResult first; the journal it names is what these inverses attach to.',
    );
  }
  if (record.projectId !== link.projectId) {
    throw new ForgeBridgeError('link_unauthenticated', 'this link is not bound to that journal');
  }
  if (entry.projectId !== record.projectId || entry.changeSetId !== record.changeSetId) {
    throw new ForgeBridgeError(
      'invalid_request',
      `journal ${entry.id} names a different apply than the one recorded under that id`,
    );
  }
  if (entry.versionBefore !== record.versionBefore || entry.versionAfter !== record.versionAfter) {
    throw new ForgeBridgeError(
      'invalid_request',
      `journal ${entry.id} brackets versions ${entry.versionBefore}→${entry.versionAfter}; ` +
        `the recorded apply moved ${record.versionBefore}→${record.versionAfter}`,
    );
  }

  const changeSet = await deps.store.getChangeSet(entry.changeSetId);
  if (!changeSet) throw new ForgeBridgeError('not_found', 'no such changeset');
  assertJournalMatchesChangeSet(entry, changeSet.operations);

  // Validated as a replay before it is stored, not when someone asks to roll
  // back. A journal that cannot be replayed is not a safety net, and the moment
  // to learn that is while the apply is still fresh and the user is still here —
  // not weeks later at the moment they need it.
  planRollback(entry);

  await deps.journals.putJournalEntry(entry);
  return { journalId: entry.id, changeSetId: entry.changeSetId, inverses: entry.inverses.length };
}

/**
 * Every journalled operation must be the operation the approved ChangeSet says
 * it is.
 *
 * Without this the journal is a free-form list of operations a consumer can put
 * anything into, and `planRollback` would faithfully build a replay for work
 * that was never proposed, never validated and never approved — reachable by
 * asking for a rollback, which is a producer route that deliberately requires no
 * diff. Compared canonically because key order out of a re-parse is not
 * meaningful and a false mismatch here refuses a legitimate journal.
 */
function assertJournalMatchesChangeSet(entry: JournalEntry, operations: readonly Operation[]): void {
  for (const applied of entry.applied) {
    const proposed = operations[applied.index];
    if (!proposed) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${entry.id} records an operation at index ${applied.index}, ` +
          `beyond the ${operations.length} in changeset ${entry.changeSetId}`,
      );
    }
    if (canonicalJson(applied.operation) !== canonicalJson(proposed)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${entry.id} records something other than operation ${applied.index} of changeset ${entry.changeSetId}`,
        'A journal records what was applied; an operation that was never in the approved set was never approved.',
      );
    }
  }
}

/** The plan for a stored journal, or a refusal naming what is missing. */
export async function planRollbackFor(deps: RollbackDeps, journalId: string): Promise<RollbackPlan> {
  const record = await deps.store.getJournal(journalId);
  if (!record) throw new ForgeBridgeError('not_found', 'no such journal entry');

  const entry = await deps.journals.getJournalEntry(journalId);
  if (!entry) {
    // The distinction is worth the extra branch: "no such journal" and "that
    // apply's inverses never reached this daemon" send a user to two different
    // places, and only one of them is a bug in the plugin.
    throw new ForgeBridgeError(
      'not_found',
      `journal ${journalId} has no inverse operations on this daemon`,
      'The Studio session that applied it never uploaded them; it may still be able to undo in-session.',
    );
  }
  if (record.rolledBackAt) {
    throw new ForgeBridgeError('invalid_request', 'this journal entry has already been rolled back');
  }
  return planRollback(entry);
}

/**
 * `POST /v1/journal/:id/rollback-result` — a consumer reporting a reversal.
 *
 * Consumer surface, enveloped and MAC'd. This is the report the CLI, the A2A
 * connector and the Python SDK have all been waiting on, and the reason each of
 * them says "dispatched": until it exists, `rolledBackAt` stays null forever.
 *
 * `rolledBackAt` is stamped only on a clean reversal. A partial one leaves it
 * null on purpose — the entry is neither reversed nor intact, its inverses are
 * spent, and a timestamp saying "rolled back" would be the journal's own record
 * lying about the one thing it exists to be right about.
 */
export async function recordRollbackResult(
  deps: RollbackDeps,
  link: Link,
  result: RollbackResult,
): Promise<{ journalId: string; changeSetId: string; status: RollbackStatus; version: number }> {
  const record = await deps.store.getJournal(result.journalId);
  if (!record) throw new ForgeBridgeError('not_found', 'no such journal entry');
  if (record.projectId !== link.projectId) {
    throw new ForgeBridgeError('link_unauthenticated', 'this link is not bound to that journal');
  }
  if (record.changeSetId !== result.changeSetId) {
    throw new ForgeBridgeError('invalid_request', 'rollback result does not match the changeset the journal records');
  }
  if (record.rolledBackAt) {
    throw new ForgeBridgeError('invalid_request', 'this journal entry has already been rolled back');
  }
  if (!record.rollbackRequestedAt) {
    // A reversal nobody asked for is a consumer undoing approved work on its own
    // initiative. ADR-012 puts rollback behind a producer route for the same
    // reason it puts apply behind approval.
    throw new ForgeBridgeError(
      'invalid_request',
      `no rollback was requested for journal ${result.journalId}`,
      'Rollbacks are dispatched by POST /v1/journal/:id/rollback; a consumer does not start one.',
    );
  }

  const entry = await deps.journals.getJournalEntry(result.journalId);
  if (entry && result.outcomes.length > entry.inverses.length) {
    throw new ForgeBridgeError(
      'invalid_request',
      `rollback result reports ${result.outcomes.length} outcomes for ${entry.inverses.length} inverses`,
    );
  }

  const status = rollbackStatusOf(result);
  await deps.journals.putRollbackResult(result);

  if (status === 'rolled_back') {
    const patch: Partial<JournalRecord> = { rolledBackAt: result.rolledBackAt };
    await deps.store.patchJournal(result.journalId, patch);
  }
  // A `partial` or `failed` reversal leaves `rolledBackAt` null, which is the
  // honest reading of both: nothing was fully undone. The result itself carries
  // which inverses failed, and `journalStateOf` is what turns the pair into the
  // word a UI shows.

  // The tree moved, whichever way it went: a partial reversal moved it too, and
  // leaving the recorded version at the pre-rollback value would make the next
  // ChangeSet's `stale_base` check pass against a version that no longer
  // describes the place.
  await deps.store.setProjectVersion(record.projectId, result.newVersion);

  return {
    journalId: result.journalId,
    changeSetId: result.changeSetId,
    status,
    version: result.newVersion,
  };
}

/**
 * What a UI should say about a journal, in one word.
 *
 * Split out because three surfaces answer this question today and each answered
 * it slightly differently — `dispatched` in the CLI, a summary sentence in the
 * A2A executor, a docstring in the Python SDK. There is one right answer and it
 * comes from two nullable timestamps plus, now, a result.
 */
export function journalStateOf(
  record: Pick<JournalRecord, 'rollbackRequestedAt' | 'rolledBackAt'>,
  result: RollbackResult | null,
): 'applied' | 'rollback_requested' | 'rolled_back' | 'rollback_partial' | 'rollback_failed' {
  if (record.rolledBackAt) return 'rolled_back';
  if (result) {
    const status = rollbackStatusOf(result);
    return status === 'partial' ? 'rollback_partial' : status === 'failed' ? 'rollback_failed' : 'rolled_back';
  }
  return record.rollbackRequestedAt ? 'rollback_requested' : 'applied';
}
