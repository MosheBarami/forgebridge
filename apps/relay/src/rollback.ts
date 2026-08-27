import {
  ForgeBridgeError,
  parentOf,
  rollbackStatusOf,
  type InverseOperation,
  type JournalEntry,
  type Link,
  type Operation,
  type RollbackResult,
  type RollbackStatus,
} from '@forgebridge/protocol';
import { canonicalJson } from './envelope.js';
import type { JournalRecord, RelaySession, RelayStore } from './store.js';
import { RollbackDelivery, type JournalState } from './wire.js';

/**
 * Rollback on the relay — M11's half of the transport.
 *
 * ── Why this is a copy, and what holds it in place ───────────────────────────
 *
 * `packages/daemon/src/rollback.ts` is the reference. It is not importable for
 * the reason given at the top of `routes.ts` — `@forgebridge/daemon` has no
 * deep exports and its entry point drags in the model router and a provider
 * client — and it is not optional either: without it the relay would serve
 * `POST /v1/journal/:id/rollback` and have nothing to send, which is the state
 * M11 exists to end. Before M11 the inverses lived only in the Studio session
 * that captured them, so closing Studio ended the road back from an apply.
 *
 * `test/rollback-drift.test.ts` runs this implementation and the daemon's over
 * the same fixtures — every legal pairing and every illegal one — so a change
 * to the rule on either side is a red test rather than two transports that
 * disagree about what a journal means.
 *
 * ── What the relay checks, and why it checks the same things ─────────────────
 *
 * All of it. This is the one place where "the relay is a pipe" would be the
 * wrong instinct: the journal arrives from the consumer, and a journal that
 * does not describe the apply the relay witnessed is a list of operations
 * nobody approved, replayable by asking for a rollback — a producer route that
 * deliberately requires no diff. So the entry is checked against the recorded
 * apply, against the approved ChangeSet, and against the rule that every
 * inverse must actually invert its operation, exactly as the daemon does.
 *
 * The distinction that matters is which kind of check: these are all facts the
 * relay already holds — an id, a version bracket, a canonical comparison of two
 * operations it stored itself. None of them needs a model, a credential or a
 * Luau analyser, which is why they can live here and validation cannot.
 */

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
 * The rule that every inverse has to obey.
 *
 * A pair that does not obey it is a journal describing an apply that did not
 * happen, and replaying it would write something nobody approved.
 *
 * The `moveInstance` case pins a reading the union alone does not disambiguate:
 * `moveBack.path` is where the instance is *now* (the move's destination) and
 * `moveBack.from` is where it goes *back* to (the move's origin). Read the
 * other way round a rollback silently misplaces instances instead of erroring,
 * which is the failure mode a journal exists to make impossible.
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
      // orphan script behind on every rollback. The relay holds no tree, so it
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
 * already half-restored the tree — the state ADR-012 is least able to help
 * with. So the whole plan is validated before the first inverse is dispatched,
 * and a journal that fails any check produces no plan at all.
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
    // record of one pass through the ChangeSet.
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
    kind: 'rollback',
    journalId: plan.journalId,
    changeSetId: plan.changeSetId,
    expectedVersion: options.expectedVersion,
    ...(options.reason ? { reason: options.reason } : {}),
    restoresToVersion: plan.restoresToVersion,
    steps: plan.steps.map((step) => ({ index: step.index, inverse: step.inverse })),
  });
}

/**
 * Every journalled operation must be the operation the approved ChangeSet says
 * it is.
 *
 * Without this the journal is a free-form list of operations a consumer can put
 * anything into, and `planRollback` would faithfully build a replay for work
 * that was never proposed, never validated and never approved — reachable by
 * asking for a rollback, which is a producer route that deliberately requires
 * no diff. Compared canonically because key order out of a re-parse is not
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

export interface RollbackDeps {
  store: RelayStore;
  session: RelaySession;
  now(): number;
}

/**
 * `POST /v1/journal/:id/entry` — a consumer uploading the inverses it captured.
 *
 * Consumer surface: the body arrives inside a MAC'd envelope like an
 * `ApplyResult`, and for the same reason. This is the record that decides
 * whether a destructive apply is survivable.
 */
export async function recordJournalEntry(
  deps: RollbackDeps,
  link: Link,
  entry: JournalEntry,
): Promise<{ journalId: string; changeSetId: string; inverses: number }> {
  const record = await deps.store.getJournal(deps.session.id, entry.id);
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

  const changeSet = await deps.store.getChangeSet(deps.session.id, entry.changeSetId);
  if (!changeSet) throw new ForgeBridgeError('not_found', 'no such changeset');
  assertJournalMatchesChangeSet(entry, changeSet.operations);

  // Validated as a replay before it is stored, not when someone asks to roll
  // back. A journal that cannot be replayed is not a safety net, and the moment
  // to learn that is while the apply is still fresh and the user is still here.
  planRollback(entry);

  await deps.store.putJournalEntry(deps.session.id, entry);
  return { journalId: entry.id, changeSetId: entry.changeSetId, inverses: entry.inverses.length };
}

/** The plan for a stored journal, or a refusal naming what is missing. */
export async function planRollbackFor(deps: RollbackDeps, journalId: string): Promise<RollbackPlan> {
  const record = await deps.store.getJournal(deps.session.id, journalId);
  if (!record) throw new ForgeBridgeError('not_found', 'no such journal entry');

  const entry = await deps.store.getJournalEntry(deps.session.id, journalId);
  if (!entry) {
    // The distinction is worth the extra branch: "no such journal" and "that
    // apply's inverses never reached this relay" send a user to two different
    // places, and only one of them is a bug in the plugin.
    throw new ForgeBridgeError(
      'not_found',
      `journal ${journalId} has no inverse operations on this relay`,
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
  const record = await deps.store.getJournal(deps.session.id, result.journalId);
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

  const entry = await deps.store.getJournalEntry(deps.session.id, result.journalId);
  if (entry && result.outcomes.length > entry.inverses.length) {
    throw new ForgeBridgeError(
      'invalid_request',
      `rollback result reports ${result.outcomes.length} outcomes for ${entry.inverses.length} inverses`,
    );
  }

  const status = rollbackStatusOf(result);
  await deps.store.putRollbackResult(deps.session.id, result);

  if (status === 'rolled_back') {
    await deps.store.patchJournal(result.journalId, { rolledBackAt: result.rolledBackAt });
  }
  // A `partial` or `failed` reversal leaves `rolledBackAt` null, which is the
  // honest reading of both: nothing was fully undone.

  // The tree moved, whichever way it went: a partial reversal moved it too, and
  // leaving the recorded version at the pre-rollback value would make the next
  // ChangeSet's `stale_base` check pass against a version that no longer
  // describes the place.
  await deps.store.setProjectVersion(deps.session.id, record.projectId, result.newVersion);

  return { journalId: result.journalId, changeSetId: result.changeSetId, status, version: result.newVersion };
}

/**
 * What a UI should say about a journal, in one word.
 *
 * One answer, from two nullable timestamps plus a result, because three
 * surfaces were each answering it slightly differently.
 */
export function journalStateOf(
  record: Pick<JournalRecord, 'rollbackRequestedAt' | 'rolledBackAt'>,
  result: RollbackResult | null,
): JournalState {
  if (record.rolledBackAt) return 'rolled_back';
  if (result) {
    // No inverse count here, and none needed. `rolledBackAt` is stamped only by
    // the daemon's `recordRollbackResult`, which judges completeness WITH the
    // count in hand. Reaching this line means it did not judge the reversal
    // complete — so a result whose every attempt passed is one that stopped
    // short, and calling it `rolled_back` on the strength of those attempts is
    // the lie the count was added to stop.
    //
    // This is a second copy of the daemon's rule, and `test/drift.test.ts`
    // exists because two copies drift — it caught this one diverging the hour
    // the daemon's changed. Keep them identical or delete this one.
    const status = rollbackStatusOf(result);
    if (status === 'rolled_back') return 'rollback_partial';
    return status === 'partial' ? 'rollback_partial' : 'rollback_failed';
  }
  return record.rollbackRequestedAt ? 'rollback_requested' : 'applied';
}
