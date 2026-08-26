import type { Invocation } from '../args.js';
import { operationFailed, type ExitCode } from '../exit.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge run "<prompt>"` — submit a run.
 *
 * ── Why this refuses instead of working ──────────────────────────────────────
 *
 * There is nowhere to send a prompt. The transport surface in `PROTOCOL.md` is
 * health, link, pair, poll, changesets, diff, approve, apply-result, rollback,
 * output and models — there is no run endpoint on it, and
 * `packages/daemon/src/server.ts` routes none. `RunPipeline` exists in
 * `@forgebridge/core`, but nothing exposes it over `/v1`, so a producer cannot
 * reach it over any transport this CLI can speak to.
 *
 * The alternatives were both worse than saying so. Inventing `POST /v1/runs`
 * would put a wire format in a connector, where the relay would later invent a
 * different one — the exact drift the frozen contract exists to prevent, and
 * the thing a transport that "answers a different set of paths" turns into.
 * Importing `RunPipeline` and orchestrating locally would put the engine inside
 * a connector, which ADR-009 forbids in one sentence, and would hand a CLI the
 * model routing, validation and approval flow that the core owns.
 *
 * So the command exists, reaches the transport far enough to report who could
 * have read the prompt, and then refuses with the reason. A `run` that appeared
 * to work would be the worst of the three.
 *
 * TODO(M09): land the run surface. Two pieces, in this order — an additive
 * `/v1` route for submitting a run and streaming its stages and `ModelAttempt`
 * log, owned by the protocol maintainer since `packages/protocol` is frozen to
 * this package; then `RunPipeline` reachable behind it. When both exist this
 * command submits `{ prompt, producer: { kind: 'cli' } }` — `Run.producer`
 * already has a `cli` variant reserved for it — and streams the plan and the
 * attempt log, which is what `attemptSummary` in `run.ts` is shaped for.
 */
export async function runCommand(
  invocation: Extract<Invocation, { command: 'run' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);

  // Reached before refusing, deliberately: it proves there is a transport at
  // all (so an absent daemon still exits 3, not 1), and it prints the posture
  // that would have applied to the prompt. Nothing is sent.
  const link = await transport.linkStatus();
  printPosture(deps.io, link.transport);

  throw operationFailed(
    'no transport exposes a run endpoint yet, so there is nowhere to submit this prompt — nothing was sent',
    [
      'The /v1 surface has no run route (see docs/PROTOCOL.md, "Transport endpoints"); M09 lands the pipeline behind one.',
      'Until then a producer builds a ChangeSet itself and submits it to POST /v1/changesets, then reviews it with `forgebridge diff`.',
    ].join('\n'),
  );
}
