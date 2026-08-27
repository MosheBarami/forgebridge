import { z } from 'zod';
import { ModelAttempt, attemptSummary } from '@forgebridge/protocol';
import type { RunResponse } from '@forgebridge/daemon';
import { approveCurl } from '../approve.js';
import type { Invocation } from '../args.js';
import { EXIT, type ExitCode } from '../exit.js';
import { emitJson, paint, truncate, type Io } from '../output.js';
import { printPosture } from '../posture.js';
import { CLI_VERSION } from '../version.js';
import type { RunStreamFrame, StartRunInput } from '../client.js';
import type { Deps } from './context.js';

/**
 * `forgebridge run "<prompt>"` — a prompt in, a proposal out.
 *
 * ── What this command is allowed to do ───────────────────────────────────────
 *
 * Exactly one thing: submit a prompt to `POST /v1/runs` and report what came
 * back. It does not apply, and there is no flag that makes it — a run leaves a
 * ChangeSet in `validated`, approval is a separate act on a route this
 * package's `Transport` does not declare, and the guarantee is structural
 * rather than a branch someone could later add an `--auto-approve` to
 * (ADR-012). What the command prints instead is the changeset id and the two
 * real ways to approve it, which is what the person reading the output needs.
 *
 * ── Why it streams by default ────────────────────────────────────────────────
 *
 * ADR-008's requirement is that fallback is *visible*, not merely recorded. A
 * run that spends ninety seconds on a rate-limited free model before falling
 * through to the next one is, from a terminal that prints nothing until it is
 * over, indistinguishable from a hung daemon — and a substitution nobody
 * watched is a silent one that happens to be written down afterwards. So each
 * model is named on stderr as it is reached, and the collapsed one-liner at the
 * end is a summary of a log the user already saw rather than the first they
 * hear of it.
 *
 * The outcomes arrive together rather than one by one, and that is the core's
 * shape rather than this command's: `model-attempt` carries the router's own
 * `ModelAttempt`, so it cannot be emitted until the router hands it back (see
 * `RunEvent` in `@forgebridge/core`). What streams live is which model is being
 * waited on, which is the half that tells a hung daemon from a slow one.
 *
 * ── Which stream each line lands on ──────────────────────────────────────────
 *
 * The live log, the posture and the next steps go to stderr; the result goes to
 * stdout. That is what lets `forgebridge run … --json | jq` work while the
 * person who typed it still sees which models were tried and what they have to
 * approve. A privacy notice or an approval instruction a pipe can swallow is
 * one that will be.
 */

/**
 * The frames this command renders.
 *
 * Narrow on purpose, and every one of them `.passthrough()`-shaped by being
 * partial: this package does not depend on `@forgebridge/core`, so the event
 * union is not importable, and what is written here is a reader for the fields
 * that are actually printed. A frame that does not parse is not an error — it
 * is an event this build has not been taught to render, and `--verbose` names
 * its type so the reader can see that something happened rather than nothing.
 */
const StageFrame = z.object({ from: z.string(), stage: z.string() });
const PlanFrame = z.object({ plan: z.object({ steps: z.array(z.string()) }) });
const AttemptStartedFrame = z.object({ modelId: z.string(), provider: z.string(), attemptIndex: z.number() });
const AttemptFrame = z.object({ attempt: ModelAttempt });
const SkippedFrame = z.object({
  skipped: z.object({
    modelId: z.string(),
    provider: z.string(),
    reason: z.string(),
    detail: z.string(),
    retryAfterMs: z.number().optional(),
  }),
});
const ValidationFrame = z.object({
  changeSetId: z.string(),
  validation: z.object({
    luau: z.object({ status: z.string() }),
    policy: z.object({ status: z.string() }),
    /**
     * Who computed it, and the reason this field is rendered rather than
     * skipped: a run emits *two* validation events for the same ChangeSet. The
     * core computes one over the sources it was handed, and the daemon
     * recomputes it over a superset — a `createInstance` carrying a `Source`
     * property installs Luau by a route the first pass does not see. Two
     * identical-looking lines read as a bug; two lines naming their author read
     * as what they are.
     */
    computedBy: z.string().optional(),
  }),
});
const FailedFrame = z.object({ failure: z.object({ code: z.string(), message: z.string() }) });
const CancelledFrame = z.object({ reason: z.string() });
const NoticeFrame = z.object({ reason: z.string() });

export async function runCommand(
  invocation: Extract<Invocation, { command: 'run' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);
  const { io } = deps;

  // Read before the prompt is sent, not after: the posture is a statement about
  // who can read what you are *about* to send, and printing it afterwards would
  // be telling someone about the window after they had already opened it.
  const link = await transport.linkStatus();
  printPosture(io, link.transport);

  const request: StartRunInput = {
    prompt: invocation.prompt,
    ...(invocation.projectId ? { projectId: invocation.projectId } : {}),
    ...(invocation.policy ? { policy: invocation.policy } : {}),
    ...(invocation.pinnedModel ? { pinnedModel: invocation.pinnedModel } : {}),
    ...(invocation.baseVersion === null ? {} : { baseVersion: invocation.baseVersion }),
    ...(invocation.maxAttempts === null ? {} : { maxAttempts: invocation.maxAttempts }),
    // `Run.producer` reserves a `cli` variant, and naming the client is what
    // lets a daemon's run log say which of several producers asked for this.
    producer: { kind: 'cli', client: `forgebridge-cli/${CLI_VERSION}` },
  };

  const response = await transport.startRun(request, (frame) => renderFrame(io, frame, invocation.verbose));

  if (invocation.global.json) {
    emitJson(io, response);
  } else {
    report(io, response);
  }
  if (invocation.verbose) reportVerbose(io, response);

  nextSteps(io, response, invocation.global.baseUrl);

  // A run that failed is a failed operation even though the request succeeded.
  // The daemon answers 201 with the attempt list on a run that tried five
  // models and got five refusals — because a ProtocolError body has nowhere to
  // put that list — so the outcome has to be read off the body, not the status.
  return response.failure === null ? EXIT.OK : EXIT.FAILED;
}

// ── the live log ─────────────────────────────────────────────────────────────

function renderFrame(io: Io, frame: RunStreamFrame, verbose: boolean): void {
  switch (frame.name) {
    case 'plan': {
      const parsed = PlanFrame.safeParse(frame.data);
      if (!parsed.success) break;
      for (const step of parsed.data.plan.steps) io.err(paint(io, 'dim', `  · ${step}`));
      return;
    }

    case 'model-attempt-started': {
      const parsed = AttemptStartedFrame.safeParse(frame.data);
      if (!parsed.success) break;
      // Printed before the call rather than only after it, so a caller watching
      // a slow model sees which one it is waiting on rather than a gap.
      io.err(paint(io, 'dim', `  → ${parsed.data.modelId} (${parsed.data.provider}) …`));
      return;
    }

    case 'model-attempt': {
      const parsed = AttemptFrame.safeParse(frame.data);
      if (!parsed.success) break;
      const { modelId, outcome, durationMs, note } = parsed.data.attempt;
      const colour = outcome === 'ok' ? 'green' : outcome === 'cancelled' ? 'dim' : 'yellow';
      const suffix = note && verbose ? ` — ${truncate(note, 120)}` : '';
      io.err(`  ${paint(io, colour, outcome.padEnd(18))} ${modelId} (${seconds(durationMs)})${suffix}`);
      return;
    }

    case 'model-skipped': {
      const parsed = SkippedFrame.safeParse(frame.data);
      if (!parsed.success) break;
      const { modelId, reason, detail } = parsed.data.skipped;
      // A skip is not an attempt and is never counted as one (ADR-008). Saying
      // "skipped" in the same column the outcomes use is what keeps a reader
      // from reading it as a model that was tried and failed.
      io.err(paint(io, 'dim', `  ${'skipped'.padEnd(18)} ${modelId} — ${reason}: ${truncate(detail, 100)}`));
      return;
    }

    case 'stage': {
      const parsed = StageFrame.safeParse(frame.data);
      if (!parsed.success) break;
      if (verbose) io.err(paint(io, 'dim', `  ${parsed.data.from} → ${parsed.data.stage}`));
      return;
    }

    case 'validation': {
      const parsed = ValidationFrame.safeParse(frame.data);
      if (!parsed.success) break;
      const { luau, policy, computedBy } = parsed.data.validation;
      const by = computedBy === undefined ? '' : ` (${computedBy})`;
      io.err(paint(io, 'dim', `  validation luau ${luau.status}, policy ${policy.status}${by}`));
      return;
    }

    case 'failed': {
      const parsed = FailedFrame.safeParse(frame.data);
      if (!parsed.success) break;
      io.err(paint(io, 'yellow', `  ${parsed.data.failure.code}: ${truncate(parsed.data.failure.message, 160)}`));
      return;
    }

    case 'cancelled': {
      const parsed = CancelledFrame.safeParse(frame.data);
      if (!parsed.success) break;
      io.err(paint(io, 'yellow', `  cancelled: ${truncate(parsed.data.reason, 160)}`));
      return;
    }

    case 'truncated':
    case 'closed': {
      // The daemon says so rather than stopping quietly, because a stream that
      // ends without a word is indistinguishable from one with more to say.
      const parsed = NoticeFrame.safeParse(frame.data);
      io.err(paint(io, 'yellow', `  ${parsed.success ? truncate(parsed.data.reason, 200) : frame.name}`));
      return;
    }

    // One fragment of a model's answer, and there are thousands of them. Not
    // rendered, and not counted under `--verbose` either: the answer itself is
    // the ChangeSet the run reports at the end, and streaming it here would put
    // unreviewed generated source on a terminal as if it were progress — while
    // burying the attempt log this command exists to show.
    case 'output-delta':
      return;

    default:
      break;
  }

  // An event this build has not been taught to render. Named rather than
  // dropped under `--verbose`, so a reader can see that something happened.
  if (verbose) io.err(paint(io, 'dim', `  · ${frame.name}`));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── the result ───────────────────────────────────────────────────────────────

function report(io: Io, response: RunResponse): void {
  const { run } = response;
  io.out(`run        ${run.id}`);
  io.out(`stage      ${run.stage} (${run.status})`);
  // The collapsed attempt log, in the protocol's own words. `attemptSummary`
  // lives in `packages/protocol` precisely so that every surface renders the
  // same sentence about which models were tried.
  io.out(`models     ${attemptSummary(run.attempts)}`);

  if (response.skipped.length > 0) {
    io.out(`skipped    ${response.skipped.map((entry) => `${entry.modelId} (${entry.reason})`).join(', ')}`);
  }

  if (response.changeSetId === null) {
    io.out(`changeset  ${paint(io, 'yellow', 'none — this run produced no ChangeSet')}`);
  } else {
    io.out(`changeset  ${response.changeSetId}  ${response.changeSetStatus ?? 'unknown'}`);
    if (response.contentDigest !== null) io.out(`digest     ${response.contentDigest}`);
  }

  if (response.validation) {
    const tint = (status: string): string =>
      paint(io, status === 'ok' ? 'green' : status === 'warn' ? 'yellow' : 'red', status);
    io.out(
      `validation luau ${tint(response.validation.luau.status)}, policy ${tint(response.validation.policy.status)}`,
    );
    // Named, because a verdict's author is the whole of what makes it worth
    // anything: the daemon recomputes it, and a model-authored one is discarded.
    io.out(paint(io, 'dim', `           computed by ${response.validation.computedBy}`));
  }

  if (response.failure) {
    io.err(paint(io, 'red', `${response.failure.code}: ${response.failure.message}`));
    if (response.failure.remedy) io.err(paint(io, 'yellow', response.failure.remedy));
  }
}

/**
 * The full log, behind `--verbose`.
 *
 * Every field of every attempt, the candidates the router never invoked, and
 * the order it meant to try them in. The collapsed one-liner above is a
 * summary; this is the record, and the two must never disagree — which is why
 * both are rendered from `run.attempts` rather than from anything this command
 * accumulated while watching the stream.
 */
function reportVerbose(io: Io, response: RunResponse): void {
  const { run } = response;
  io.err('');
  io.err(paint(io, 'bold', 'attempts'));
  if (run.attempts.length === 0) io.err(paint(io, 'dim', '  none — no model was invoked'));
  run.attempts.forEach((attempt, index) => {
    const tokens =
      attempt.promptTokens === undefined && attempt.completionTokens === undefined
        ? ''
        : ` tokens ${attempt.promptTokens ?? '?'}/${attempt.completionTokens ?? '?'}`;
    // Zero for a free model, and printed rather than hidden: a self-hoster can
    // see their own spend, and "free" is a claim worth being able to check.
    const cost = attempt.costUsd === undefined ? '' : ` $${attempt.costUsd.toFixed(4)}`;
    const provider = attempt.providerSlug === undefined ? '' : ` via ${attempt.providerSlug}`;
    io.err(
      `  ${String(index + 1).padStart(2)}  ${attempt.modelId}${provider}  ${attempt.outcome}  ${seconds(attempt.durationMs)}${tokens}${cost}`,
    );
    if (attempt.note) io.err(paint(io, 'dim', `      ${attempt.note}`));
    io.err(paint(io, 'dim', `      started ${attempt.startedAt}`));
  });

  if (response.ordering) {
    io.err('');
    io.err(paint(io, 'bold', 'ordering'));
    io.err(
      `  ${response.ordering.policy}: ${response.ordering.candidatesEligible} eligible of ${response.ordering.candidatesConsidered} considered`,
    );
    io.err(paint(io, 'dim', `  ${response.ordering.order.join(' → ')}`));
    if (response.ordering.note) io.err(paint(io, 'yellow', `  ${response.ordering.note}`));
  }

  if (response.skipped.length > 0) {
    io.err('');
    io.err(paint(io, 'bold', 'skipped'));
    for (const entry of response.skipped) {
      const retry = entry.retryAfterMs === undefined ? '' : ` (retry in ${seconds(entry.retryAfterMs)})`;
      io.err(`  ${entry.modelId} (${entry.provider})  ${entry.reason}: ${entry.detail}${retry}`);
    }
  }

  if (response.plan.steps.length > 0) {
    io.err('');
    io.err(paint(io, 'bold', 'plan'));
    for (const step of response.plan.steps) io.err(`  · ${step}`);
  }
}

/**
 * What to do next — including, in full, how to approve.
 *
 * This block is the reason the command can refuse to apply without stranding
 * anyone. It states the boundary in one sentence, then gives the two real ways
 * across it: the Studio plugin's diff view, and the approve endpoint for a
 * person who holds the producer token. Neither is something this command does
 * on the user's behalf.
 */
function nextSteps(io: Io, response: RunResponse, baseUrl: string): void {
  io.err('');
  if (response.changeSetId === null) {
    io.err(
      paint(io, 'dim', 'Nothing was proposed, so there is nothing to review — no change reached the place.'),
    );
    return;
  }

  io.err(
    paint(
      io,
      'dim',
      'Nothing has been applied. A run proposes; approving is a separate act a model cannot perform (ADR-012).',
    ),
  );
  io.err(`Review it:  forgebridge diff ${response.changeSetId}`);

  if (response.changeSetStatus !== 'validated') {
    // A set the daemon stored `rejected` or `stale` cannot be approved at all,
    // so printing an approve command for it would be printing a command that is
    // going to fail. Say which state it is in and where the reasons are.
    io.err(
      paint(
        io,
        'yellow',
        `This changeset is "${response.changeSetStatus ?? 'unknown'}", not "validated", so it cannot be approved as it stands — the diff carries the findings.`,
      ),
    );
    return;
  }

  io.err('Approve it in the Studio plugin diff view, or from a shell with the producer token:');
  io.err(
    approveCurl({
      baseUrl,
      changeSetId: response.changeSetId,
      contentDigest: response.contentDigest,
    }),
  );
}
