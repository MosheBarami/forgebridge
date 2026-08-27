import type { JournalStateResponse } from '@forgebridge/daemon';
import type { Invocation } from '../args.js';
import { EXIT, type ExitCode } from '../exit.js';
import { emitJson, paint, type Io } from '../output.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge rollback <journal-id>` — reverse an apply, and wait to find out
 * whether it worked.
 *
 * ── What changed, and what did not ───────────────────────────────────────────
 *
 * The inverse operations are captured by the consumer, before the originals ran,
 * and only that consumer can replay them. That has not changed and cannot: this
 * command still dispatches, and `POST /v1/journal/:id/rollback` still answers
 * `202 dispatched`.
 *
 * What changed is that a reversal can now be *reported*. Before M11 there was no
 * shape on the wire for "the reversal of journal X finished", so `dispatched`
 * was the last word this command would ever have — and it said exactly that,
 * because printing "rolled back" on the strength of a 202 would have claimed an
 * outcome nobody had reported. `RollbackResult` closed the gap and
 * `GET /v1/journal/:id` is where the answer appears, so this command now watches
 * for it the way `apply` watches for an `ApplyResult`.
 *
 * ── Why the states are not collapsed ─────────────────────────────────────────
 *
 * `rollback_partial` is its own outcome and never rounded to either neighbour.
 * A half-reversed tree is in a state neither the user nor the journal describes,
 * and the inverses that would have finished the job are spent — so it exits
 * non-zero, prints which inverses failed, and says in words that a second
 * attempt is not available.
 */
export async function rollbackCommand(
  invocation: Extract<Invocation, { command: 'rollback' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);
  const { io } = deps;

  const link = await transport.linkStatus();
  printPosture(io, link.transport);

  const response = await transport.rollback({
    journalId: invocation.journalId,
    expectedVersion: invocation.expectedVersion,
    ...(invocation.reason === null ? {} : { reason: invocation.reason }),
  });

  const journal = await watch(transport, response.journalId, invocation.timeoutSeconds, deps);

  if (invocation.global.json) {
    // Both halves, because they answer different questions: the dispatch says
    // how many inverses went out and under which delivery nonce, and the journal
    // says what came back. A caller handed only one of them would have to infer
    // the other.
    emitJson(io, { dispatch: response, journal });
    return outcomeCode(journal.state);
  }

  report(io, response.steps, journal);
  return outcomeCode(journal.state);
}

const POLL_INTERVAL_MS = 1000;

/** States the consumer has not answered from yet. Anything else is terminal. */
const IN_FLIGHT = new Set(['applied', 'rollback_requested']);

async function watch(
  transport: ReturnType<Deps['createTransport']>,
  journalId: string,
  timeoutSeconds: number,
  deps: Deps,
): Promise<JournalStateResponse> {
  let latest = await transport.journal(journalId);
  if (timeoutSeconds === 0 || !IN_FLIGHT.has(latest.state)) return latest;

  deps.io.err(
    paint(
      deps.io,
      'dim',
      `waiting up to ${timeoutSeconds}s for the paired Studio session to replay ${latest.inverses ?? 0} inverse operation(s)…`,
    ),
  );

  const deadline = deps.now() + timeoutSeconds * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    latest = await transport.journal(journalId);
    if (!IN_FLIGHT.has(latest.state)) return latest;
  }
  return latest;
}

/**
 * Map a journal state to an exit code.
 *
 * `rollback_partial` fails for the reason `partial` fails an apply, only more
 * so: it is a legal protocol outcome and it is the one a pipeline must stop and
 * look at. `rollback_requested` also fails, because the command was asked to
 * wait and did not get an answer — reporting success there would make a timeout
 * indistinguishable from a reversal.
 */
function outcomeCode(state: string): ExitCode {
  return state === 'rolled_back' ? EXIT.OK : EXIT.FAILED;
}

function report(io: Io, steps: number, journal: JournalStateResponse): void {
  const colour =
    journal.state === 'rolled_back' ? 'green' : journal.state === 'rollback_failed' ? 'red' : 'yellow';

  io.out(`journal    ${journal.journalId}`);
  io.out(`changeset  ${journal.changeSetId}`);
  io.out(`summary    ${journal.summary}`);
  io.out(`state      ${paint(io, colour, journal.state)}`);
  io.out(`inverses   ${steps} dispatched`);
  io.out(`version    ${journal.versionAfter} → ${journal.result?.newVersion ?? journal.versionAfter}`);

  if (journal.state === 'rolled_back') return;

  if (journal.state === 'rollback_requested' || journal.state === 'applied') {
    io.err(
      paint(
        io,
        'yellow',
        'Dispatched to the paired Studio session, which replays the inverse operations. It is not reversed until that session reports; re-run to check again, or raise --timeout.',
      ),
    );
    return;
  }

  // Per-inverse failures, verbatim. This is the one moment a person needs to
  // know exactly which inverse did not replay, because the rest of them did and
  // the tree is now a mixture of two states.
  for (const outcome of journal.result?.outcomes ?? []) {
    if (!outcome.ok) io.err(`  inverse ${outcome.index}: ${outcome.error ?? 'failed, with no reason given'}`);
  }

  io.err(
    paint(
      io,
      'yellow',
      journal.state === 'rollback_partial'
        ? 'Partially reversed. The place is in a state neither this rollback nor the original apply describes, and the inverses that would have finished the job are spent — this journal cannot be rolled back again.'
        : 'Nothing was reversed. The place is where the apply left it.',
    ),
  );
}
