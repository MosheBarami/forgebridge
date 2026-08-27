import { z } from 'zod';
import { ModelAttempt, ProtocolError, RunStage, Validation } from '@forgebridge/protocol';

import { RunResponse, SkippedModel } from '@/lib/daemon/wire';

/**
 * What comes down the run stream, parsed (M35).
 *
 * `DaemonClient.startRunStreaming` yields `unknown` on purpose — the channel
 * carries three different shapes and the client is not the place to invent a
 * union over them. This is that place, because this is where it is known which
 * frames the run view needs.
 *
 * The three shapes, from `packages/daemon/src/server.ts#streamRun`:
 *
 *   1. a `run` frame carrying a full `RunResponse` — written once when the run
 *      is queued (this is where the run id arrives, and the only place it does)
 *      and once more when the run settles;
 *   2. one frame per `RunEvent` from `packages/core/src/run.ts` — stage
 *      changes, the plan, each model attempt started and finished, each
 *      candidate skipped, the validation verdict, the ChangeSet;
 *   3. a bare `ProtocolError`, which is what `startRunStreaming` yields when
 *      the daemon refused before the stream opened.
 *
 * ── Why this parses rather than casts ─────────────────────────────────────
 *
 * ADR-008 says the run log must name every model the router tried and why it
 * moved on. A cast that let a malformed `model-attempt` frame through would put
 * `undefined` where a model id belongs and render a fallback chain with a hole
 * in it — which is exactly the silent substitution the ADR exists to prevent,
 * arrived at from the other direction. An unparseable frame is dropped *and
 * counted*, and the run view says how many were dropped, because "we did not
 * understand three frames" is a fact a user is entitled to instead of a gap.
 *
 * ── Why the union is open at the bottom ───────────────────────────────────
 *
 * `unrecognised` is a member. The daemon may emit a `RunEvent` type this build
 * has never heard of — the protocol is additive — and the honest response to
 * that is to keep the frame's type name and show it as an unrecognised entry,
 * not to drop it as though it never happened.
 */

/** The `RunEvent` union from `@forgebridge/core`, as it arrives on the wire. */
const StageFrame = z.object({
  type: z.literal('stage'),
  at: z.string(),
  from: RunStage,
  stage: RunStage,
});

const PlanFrame = z.object({
  type: z.literal('plan'),
  at: z.string(),
  plan: z.object({ steps: z.array(z.string()) }),
});

const AttemptStartedFrame = z.object({
  type: z.literal('model-attempt-started'),
  at: z.string(),
  modelId: z.string(),
  provider: z.string(),
  attemptIndex: z.number().int().min(0),
});

/**
 * Token deltas. Parsed so the frame is not counted as unrecognised, and then
 * deliberately not rendered: the run view shows *what the router did*, and a
 * wall of streaming JSON from a model mid-tool-call is not that. The generated
 * Luau reaches the user through the diff, where it is reviewable, rather than
 * through a transcript that scrolls past before it can be read.
 */
const OutputDeltaFrame = z.object({
  type: z.literal('output-delta'),
  at: z.string(),
  modelId: z.string(),
  delta: z.string(),
});

const AttemptFrame = z.object({
  type: z.literal('model-attempt'),
  at: z.string(),
  attempt: ModelAttempt,
});

const SkippedFrame = z.object({
  type: z.literal('model-skipped'),
  at: z.string(),
  skipped: SkippedModel,
});

const ValidationFrame = z.object({
  type: z.literal('validation'),
  at: z.string(),
  changeSetId: z.string(),
  validation: Validation,
});

/**
 * The ChangeSet itself.
 *
 * Only `id` and `summary` are read from it here. The full set is not parsed
 * with the protocol's `ChangeSet` schema on purpose: the diff is fetched from
 * `GET /v1/changesets/:id/diff` and that is what the approver reads, because
 * the diff carries the `contentDigest` an approval must echo back. Approving
 * from a copy that arrived over a side channel would be approving something
 * whose digest this app computed itself, which is not what ADR-012 asks for.
 */
const ChangeSetFrame = z.object({
  type: z.literal('change-set'),
  at: z.string(),
  changeSet: z.object({ id: z.string(), summary: z.string() }).passthrough(),
});

const CancelledFrame = z.object({
  type: z.literal('cancelled'),
  at: z.string(),
  reason: z.string(),
});

const FailedFrame = z.object({
  type: z.literal('failed'),
  at: z.string(),
  failure: ProtocolError,
});

const RunEventFrame = z.discriminatedUnion('type', [
  StageFrame,
  PlanFrame,
  AttemptStartedFrame,
  OutputDeltaFrame,
  AttemptFrame,
  SkippedFrame,
  ValidationFrame,
  ChangeSetFrame,
  CancelledFrame,
  FailedFrame,
]);

export type RunEventFrame = z.infer<typeof RunEventFrame>;

export type RunFrame =
  | { readonly kind: 'event'; readonly event: RunEventFrame }
  | { readonly kind: 'run'; readonly response: RunResponse }
  | { readonly kind: 'refused'; readonly error: z.infer<typeof ProtocolError> }
  /** A frame this build does not model. Kept, named, and shown as such. */
  | { readonly kind: 'unrecognised'; readonly type: string | null; readonly detail: string };

/**
 * Classify one payload from the stream.
 *
 * The discriminator is structural rather than the SSE `event:` name, because
 * the foundation's stream reader keeps only `data:` lines — deliberately, since
 * the payload is self-describing and a parser that depended on a header field
 * would be depending on the one part of the frame that carries no data. A
 * `RunEvent` has `type`; a `RunResponse` has `run`; a `ProtocolError` has
 * `code` and `message` and neither of the others.
 */
export function classifyFrame(payload: unknown): RunFrame {
  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'unrecognised', type: null, detail: 'frame was not an object' };
  }

  const record = payload as Record<string, unknown>;

  if (typeof record['type'] === 'string') {
    const parsed = RunEventFrame.safeParse(payload);
    if (parsed.success) return { kind: 'event', event: parsed.data };
    return {
      kind: 'unrecognised',
      type: record['type'],
      detail: issueSummary(parsed.error),
    };
  }

  if ('run' in record) {
    const parsed = RunResponse.safeParse(payload);
    if (parsed.success) return { kind: 'run', response: parsed.data };
    return { kind: 'unrecognised', type: 'run', detail: issueSummary(parsed.error) };
  }

  const refused = ProtocolError.safeParse(payload);
  if (refused.success) return { kind: 'refused', error: refused.data };

  return { kind: 'unrecognised', type: null, detail: 'frame matched no known shape' };
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
