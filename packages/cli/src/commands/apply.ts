import { LIMITS } from '@forgebridge/protocol';
import type { ChangeSetDiff } from '@forgebridge/daemon';
import { approveCurl } from '../approve.js';
import type { Invocation } from '../args.js';
import { EXIT, operationFailed, type ExitCode } from '../exit.js';
import { emitJson, paint, type Io } from '../output.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge apply <changeset-id>` — report on an approved changeset.
 *
 * ── The rule this command exists to keep ─────────────────────────────────────
 *
 * A ChangeSet that is not approved is not applied, and there is no flag that
 * changes that. Not `--yes`, not `--force`, not `--auto-approve`. Approval is
 * the human gate ADR-012 puts between a language model and a place someone may
 * have spent months on, and an approval flag on the apply command is that gate
 * with a switch on it — reachable by exactly the automation the gate exists to
 * contain, since an agent driving this CLI can pass any flag a human can.
 *
 * The guarantee is structural rather than conditional: `Transport` has no
 * `approve` method, so there is no branch here to audit and no call to reach.
 *
 * ── Why this command waits rather than sends ─────────────────────────────────
 *
 * On the `/v1` surface a producer does not push an apply. Approval enqueues the
 * ChangeSet for delivery; the paired Studio session polls for it, applies it
 * operation by operation, and reports an `ApplyResult` back. So the honest job
 * left for a CLI is to check that the set really is cleared, then watch the
 * status until the consumer says how far it got — which is what a CI step
 * needs, and is the whole reason `applied`, `partial` and `failed` are
 * different words.
 */

/** Statuses that mean a consumer has it, or is about to. */
const IN_FLIGHT = new Set(['approved', 'applying']);

/** Statuses that mean a consumer already reported. No further polling changes them. */
const REPORTED = new Set(['applied', 'partial', 'failed']);

/**
 * The only statuses this command has anything to say about.
 *
 * Everything else — `draft`, `proposed`, `validated`, `rejected`, `stale` — is a
 * ChangeSet that was never cleared to apply, and is refused. Listing what is
 * accepted rather than what is rejected is what keeps a status added to
 * `ChangeSetStatus` later from falling through into the applied path by default.
 */
const RECOGNISED = new Set([...IN_FLIGHT, ...REPORTED]);

const POLL_INTERVAL_MS = 1000;

export async function applyCommand(
  invocation: Extract<Invocation, { command: 'apply' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);
  const { io } = deps;

  const link = await transport.linkStatus();
  printPosture(io, link.transport);

  let diff = await transport.diff(invocation.changeSetId);

  if (!RECOGNISED.has(diff.status)) throw refusal(diff, invocation.global.baseUrl);

  if (IN_FLIGHT.has(diff.status)) {
    if (diff.stale) {
      // Not a refusal: the daemon re-checks `baseVersion` and owns that call.
      // Worth saying out loud, because an approved set whose base has moved is
      // a set the consumer is entitled to refuse, and a silent refusal later is
      // harder to read than a warning now.
      io.err(
        paint(
          io,
          'yellow',
          `warning: this changeset was built against version ${diff.baseVersion} and the project is at ${diff.currentVersion}; the consumer may refuse it as stale.`,
        ),
      );
    }
    diff = await watch(transport, diff, invocation.timeoutSeconds, deps);
  }

  if (invocation.global.json) {
    emitJson(io, diff);
  } else {
    report(io, diff);
  }

  return outcomeCode(diff.status);
}

async function watch(
  transport: ReturnType<Deps['createTransport']>,
  initial: ChangeSetDiff,
  timeoutSeconds: number,
  deps: Deps,
): Promise<ChangeSetDiff> {
  if (timeoutSeconds === 0) return initial;

  const deadline = deps.now() + timeoutSeconds * 1000;
  let latest = initial;

  deps.io.err(
    paint(
      deps.io,
      'dim',
      `waiting up to ${timeoutSeconds}s for the paired Studio session to report…`,
    ),
  );

  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    latest = await transport.diff(initial.changeSetId);
    if (REPORTED.has(latest.status)) return latest;
  }
  return latest;
}

/**
 * Map a terminal status to an exit code.
 *
 * `partial` is a failure for a pipeline even though it is a legal protocol
 * outcome: some operations landed and some did not, which is the state a CI job
 * must stop and look at rather than build on. Invariant 2 makes partial legal;
 * it does not make it fine.
 */
function outcomeCode(status: string): ExitCode {
  return status === 'applied' ? EXIT.OK : EXIT.FAILED;
}

function report(io: Io, diff: ChangeSetDiff): void {
  const colour = diff.status === 'applied' ? 'green' : diff.status === 'partial' ? 'yellow' : 'red';
  io.out(`changeset  ${diff.changeSetId}`);
  io.out(`summary    ${diff.summary}`);
  io.out(`status     ${paint(io, colour, diff.status)}`);
  io.out(`version    ${diff.baseVersion} → ${diff.currentVersion}`);
  io.out(`operations ${diff.counts.total} (${diff.counts.deletes} destructive delete(s))`);

  if (diff.status === 'applied') return;

  if (diff.status === 'approved' || diff.status === 'applying') {
    io.err(
      paint(
        io,
        'yellow',
        'still in flight — the paired Studio session has not reported yet. Re-run to check again, or raise --timeout.',
      ),
    );
    return;
  }
  io.err(
    paint(
      io,
      'yellow',
      'Per-operation outcomes live with the consumer that applied them; the transport records the journal id on the apply result.',
    ),
  );
}

/**
 * The refusal, with the real way to approve.
 *
 * "Not approved" on its own strands the person reading it, so this names both
 * routes to approval: the Studio plugin's diff view, which is the designed
 * human gate, and the endpoint, which is what a CI job or a non-Studio operator
 * actually needs. Naming the endpoint is not a loophole — calling it is a
 * deliberate act by whoever holds the producer token, which is the human who
 * started the daemon. Doing it silently from inside `apply` would not be.
 *
 * The `contentDigest` in the printed body is this diff's own. The daemon
 * refuses an approve that does not echo the digest of the operations it holds,
 * so a command without it is one the reader would paste and watch fail — and
 * the digest belongs to the diff *this command just read*, which is what makes
 * pasting it an approval of what was on screen rather than of an id.
 */
function refusal(diff: ChangeSetDiff, baseUrl: string): Error {
  const bulk =
    diff.counts.deletes > LIMITS.BULK_DELETE_CONFIRM_THRESHOLD
      ? ` It deletes ${diff.counts.deletes} instances, above the confirmation threshold of ${LIMITS.BULK_DELETE_CONFIRM_THRESHOLD}, so approval must also carry "confirmBulkDelete": true.`
      : '';

  const validation =
    diff.validation && (diff.validation.luau.status === 'fail' || diff.validation.policy.status === 'fail')
      ? ' Validation failed for this changeset, so it cannot be approved as it stands — run `forgebridge diff` to read the findings.'
      : '';

  const stale = diff.stale
    ? ` It was built against version ${diff.baseVersion} and the project is at ${diff.currentVersion}; it must be rebased and resubmitted.`
    : '';

  return operationFailed(
    `changeset ${diff.changeSetId} is "${diff.status}", not approved — nothing was applied.${stale}${validation}${bulk}`,
    [
      'Approval is a human gate: a model must never clear its own work (ADR-012), so this command will not do it for you.',
      'Approve it in the Studio plugin diff view, or from a shell with the producer token:',
      approveCurl({
        baseUrl,
        changeSetId: diff.changeSetId,
        contentDigest: diff.contentDigest,
        deletes: diff.counts.deletes,
      }),
    ].join('\n'),
    // Named so a caller embedding this package can branch on the refusal rather
    // than on the sentence. `stale_base` for a set the tree moved under, because
    // that is a different next move: rebuild, not "go and approve it".
    diff.stale ? 'stale_base' : 'not_approved',
  );
}
