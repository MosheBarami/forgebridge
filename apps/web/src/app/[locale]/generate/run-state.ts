import { attemptSummary, type ModelAttempt, type Run, type Validation } from '@forgebridge/protocol';

import type { RunResponse, SkippedModel } from '@/lib/daemon/wire';
import type { RunFrame } from './run-frames';

/**
 * A refusal, from either of the two places one can come from.
 *
 * `ProtocolError.code` is the protocol's closed `ErrorCode` enum, while
 * `RunResponse.failure.code` is a bare string — the daemon's run route reports
 * failures the enum does not name. Rather than cast one into the other and
 * pretend the closed set held, this widens to what both actually guarantee: a
 * code, a message, and optionally a remedy. Nothing in the view branches on the
 * code, so nothing loses anything by it.
 */
export interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly remedy?: string;
  readonly traceId?: string;
}

/**
 * The run, as the view needs it, folded from the frame stream (M35).
 *
 * A plain reducer rather than a hook so it can be tested without a DOM, and so
 * the ordering rules below are stated once in a place a reviewer can read them
 * end to end.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────
 *
 * ADR-008: every model the router tried, and why it moved on, is visible.
 * `attempts` is therefore append-only and nothing ever removes from it — not a
 * later success, not the final `run` frame. The final frame *replaces* the
 * attempt list only when it carries at least as many attempts as were streamed,
 * because the settled `RunResponse` is the daemon's own record and is the more
 * authoritative of the two; if it somehow carried fewer, the streamed list is
 * kept and the discrepancy is recorded. A run log that quietly shrank at the
 * end would be the exact failure the ADR is about, arriving one second late.
 */

export interface RunView {
  /** Assigned by the daemon; arrives on the first `run` frame and never changes. */
  readonly runId: string | null;
  readonly stage: Run['stage'];
  readonly status: Run['status'];
  readonly plan: readonly string[];
  /** Finished attempts, in the order the router made them. Append-only. */
  readonly attempts: readonly ModelAttempt[];
  /** The attempt currently in flight, if the stream has said one started. */
  readonly inFlight: { readonly modelId: string; readonly provider: string; readonly attemptIndex: number } | null;
  /** Candidates the breaker or the attempt budget kept out. Never attempts. */
  readonly skipped: readonly SkippedModel[];
  readonly validation: Validation | null;
  readonly changeSetId: string | null;
  readonly changeSetSummary: string | null;
  readonly failure: RunFailure | null;
  readonly cancelledReason: string | null;
  /** Set once a terminal frame has arrived. */
  readonly finished: boolean;
  /** The settled response, when the daemon sent one. */
  readonly final: RunResponse | null;
  /**
   * Frames this build could not model, kept as a count and a sample.
   *
   * Surfaced rather than swallowed: three dropped frames is a run log with
   * three holes in it, and a user comparing this app against a newer daemon
   * deserves to know that is what they are looking at.
   */
  readonly unrecognised: readonly { readonly type: string | null; readonly detail: string }[];
}

export function initialRunView(): RunView {
  return {
    runId: null,
    stage: 'queued',
    status: 'running',
    plan: [],
    attempts: [],
    inFlight: null,
    skipped: [],
    validation: null,
    changeSetId: null,
    changeSetSummary: null,
    failure: null,
    cancelledReason: null,
    finished: false,
    final: null,
    unrecognised: [],
  };
}

const TERMINAL_STAGES: ReadonlySet<Run['stage']> = new Set<Run['stage']>(['done', 'failed', 'cancelled']);

export function reduceRun(view: RunView, frame: RunFrame): RunView {
  switch (frame.kind) {
    case 'refused':
      // The daemon would not start the run. There is no run id and never will
      // be, so this is terminal on arrival.
      return { ...view, failure: frame.error, finished: true, status: 'failed', stage: 'failed' };

    case 'unrecognised':
      return {
        ...view,
        unrecognised: [...view.unrecognised, { type: frame.type, detail: frame.detail }],
      };

    case 'run': {
      const response = frame.response;
      // The streamed attempts and the daemon's own list should agree. When they
      // do not, keep whichever is longer — see the note at the top of this file.
      const attempts =
        response.run.attempts.length >= view.attempts.length ? response.run.attempts : view.attempts;
      const finished = TERMINAL_STAGES.has(response.run.stage) || response.run.status !== 'running';

      return {
        ...view,
        runId: response.run.id,
        stage: response.run.stage,
        status: response.run.status,
        plan: response.plan.steps.length > 0 ? response.plan.steps : view.plan,
        attempts,
        // A settled run has nothing in flight; a queued one has not started.
        inFlight: finished ? null : view.inFlight,
        skipped: response.skipped.length > 0 ? response.skipped : view.skipped,
        validation: response.validation ?? view.validation,
        changeSetId: response.changeSetId ?? view.changeSetId,
        failure: response.failure ?? view.failure,
        finished,
        final: finished ? response : view.final,
      };
    }

    case 'event':
      return reduceEvent(view, frame.event);
  }
}

function reduceEvent(view: RunView, event: Extract<RunFrame, { kind: 'event' }>['event']): RunView {
  switch (event.type) {
    case 'stage':
      return { ...view, stage: event.stage };

    case 'plan':
      return { ...view, plan: event.plan.steps };

    case 'model-attempt-started':
      return {
        ...view,
        inFlight: { modelId: event.modelId, provider: event.provider, attemptIndex: event.attemptIndex },
      };

    case 'output-delta':
      // Deliberately not rendered. See `run-frames.ts`.
      return view;

    case 'model-attempt':
      return {
        ...view,
        attempts: [...view.attempts, event.attempt],
        // The attempt that just finished is the one that was in flight. Clearing
        // it here rather than on the next `model-attempt-started` means the gap
        // between a failed attempt and the next model reads as "nothing running
        // yet", which is what is happening.
        inFlight: null,
      };

    case 'model-skipped':
      return { ...view, skipped: [...view.skipped, event.skipped] };

    case 'validation':
      return { ...view, validation: event.validation, changeSetId: event.changeSetId };

    case 'change-set':
      return {
        ...view,
        changeSetId: event.changeSet.id,
        changeSetSummary: event.changeSet.summary,
      };

    case 'cancelled':
      return { ...view, cancelledReason: event.reason, status: 'cancelled', stage: 'cancelled', inFlight: null };

    case 'failed':
      return { ...view, failure: event.failure, status: 'failed', stage: 'failed', inFlight: null };
  }
}

/**
 * The collapsed one-line fallback chain.
 *
 * `attemptSummary` in `@forgebridge/protocol` renders it, and this app does not
 * write its own: the one-line form appears in the CLI, in the MCP surface and
 * here, and three renderings of one fact is three chances for them to disagree
 * about what a fallback looked like. The in-flight model is appended so a line
 * being watched live does not stop at the last *finished* attempt and look as
 * though the run has stalled.
 */
export function attemptLine(view: RunView): string {
  const base = attemptSummary([...view.attempts]);
  if (!view.inFlight) return base;
  return view.attempts.length === 0 ? view.inFlight.modelId : `${base} → ${view.inFlight.modelId}`;
}

/** Whether anything about the routing is worth expanding — skips included. */
export function hasRoutingDetail(view: RunView): boolean {
  return view.attempts.length > 0 || view.skipped.length > 0 || view.inFlight !== null;
}
