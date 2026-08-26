import type { Invocation } from '../args.js';
import { EXIT, type ExitCode } from '../exit.js';
import { emitJson, paint } from '../output.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge rollback <journal-id>` — reverse an apply.
 *
 * ── Dispatched is not done ───────────────────────────────────────────────────
 *
 * The inverse operations live on the consumer that captured them, before the
 * originals ran. Only that consumer can replay them, and only that consumer can
 * say a rollback completed. The transport answers `202 dispatched`, and this
 * command says exactly that word — a CLI that printed "rolled back" on the
 * strength of a 202 would be claiming an outcome nobody has reported.
 *
 * The protocol has no way for a consumer to report a completed rollback:
 * `ApplyResult` cannot say "this was the inverse of journal X".
 *
 * TODO(M11): report rollback completion, as an additive `RollbackResult` or a
 * field on `ApplyResult`, and have this command wait for it the way `apply`
 * waits for an apply. Owner: the protocol maintainer — `packages/protocol` is
 * frozen to this package, and the daemon carries the matching TODO on
 * `JournalRecord.rolledBackAt`. Inferring completion from the next `ApplyResult`
 * would be a heuristic on the one mechanism that must never guess.
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

  if (invocation.global.json) {
    emitJson(io, response);
    return EXIT.OK;
  }

  io.out(`journal    ${response.journalId}`);
  io.out(`changeset  ${response.changeSetId}`);
  io.out(`status     ${response.status}`);
  io.out(`nonce      ${response.nonce}`);
  io.err(
    paint(
      io,
      'yellow',
      'Dispatched to the paired Studio session, which holds the inverse operations. It is not reversed until that session replays them; this transport cannot yet report when it has.',
    ),
  );

  return EXIT.OK;
}
