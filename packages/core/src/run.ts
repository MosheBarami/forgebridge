import { ChangeSet, withinSizeLimit } from '@forgebridge/protocol';
import type {
  ChangeSet as ChangeSetType,
  ModelAttempt,
  ProtocolError,
  Run,
  Validation,
} from '@forgebridge/protocol';
import { systemClock, type Clock } from './clock.js';
import { assertTransition, isTerminal, type DraftChangeSet, type RunPlan } from './pipeline.js';
import { checkPolicy, DENY_ALL_POLICY, type PolicyDecision, type ProjectPolicy } from './policy.js';
import {
  meetsRequirements,
  ModelRouter,
  orderCandidates,
  type InvocationResult,
  type ModelCandidate,
  type OrderingReport,
  type RoutingPolicy,
  type RoutingRequirements,
  type SkippedCandidate,
} from './router.js';
import {
  CHANGE_SET_TOOL_NAME,
  changeSetMessages,
  changeSetTool,
  type PromptContext,
} from './prompt.js';
import {
  analyseChangeSet,
  firstErrorFinding,
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  MAX_SANDBOX_OUTPUT_BYTES,
  type LuauAnalysisPort,
} from './validate.js';
import {
  ModelClientError,
  outcomeOf,
  type CompletionRequest,
  type CompletionResponse,
  type ModelClient,
} from './ports/model.js';

/**
 * `executeRun` — a prompt in, a validated ChangeSet out, and nothing applied.
 *
 *   queued → planning → generating → validating → awaiting-approval
 *
 * It stops there. Not "stops there by default": there is no argument, no flag
 * and no branch in this file that reaches `applying`, because approval is an
 * act a model cannot perform and the surest way to keep that true is to give
 * this code path nowhere to do it (ADR-012). The apply half lives in
 * `RunPipeline`, behind `approve()`, which a human calls.
 *
 * Three more things it will not do, each because the alternative is a quiet lie:
 *
 *   - It never swaps a model without recording a `ModelAttempt`. The router owns
 *     that invariant; this file's only job is to hand it a classification of
 *     what went wrong instead of swallowing an error (ADR-008). Under `pinned`
 *     there is no swap at all.
 *   - It never repairs a model's JSON. A ChangeSet the core edited into shape is
 *     a ChangeSet no test covers, so a malformed one is an `invalid-output`
 *     attempt and the next candidate gets its turn.
 *   - It never reads a validation verdict off a model. `DraftChangeSet` has
 *     nowhere to put one, and the verdict on the returned set is computed here,
 *     from `checkPolicy` and the analyser port.
 *
 * `RunPipeline` in `pipeline.ts` drives the same stages when it also owns
 * storage, transport and the apply. This is the half a caller with its own
 * store — the daemon's `/v1/runs` — needs: no `StoragePort`, no side effects
 * beyond the model call, and a returned `Run` the caller persists itself.
 */

export interface RunRequest {
  runId: string;
  projectId: string;
  prompt: string;
  /** The tree version this set is built against. The caller reads it; a model never chooses it. */
  baseVersion: number;
  /** Absent means `DENY_ALL_POLICY`: an unconfigured project permits nothing. */
  policy?: ProjectPolicy;
  routingPolicy: RoutingPolicy;
  pinnedModelId?: string;
  requirements?: RoutingRequirements;
  /**
   * Assembled by the caller — from the synced registry, from locally discovered
   * models, or both. Keeping the registry out of the core means a daemon can
   * offer a local model no catalog has heard of.
   */
  candidates: readonly ModelCandidate[];
  /** Hosts scripts in this ChangeSet may reach. Empty means none. */
  allowedHttpHosts?: readonly string[];
  /**
   * A description of the place, passed to the model as context.
   *
   * TODO(M09): core does not render one. `StoragePort.trees.get` returns a
   * `TreeSnapshot`, and the caller that holds the store builds the string. A
   * shared renderer belongs here the moment a second caller needs one — until
   * then, writing a summariser nobody calls would be guessing at what a model
   * needs to see, and the first real caller will know.
   */
  treeSummary?: string;
  producer?: Run['producer'];
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface RunDeps {
  models: ModelClient;
  /** Shares a breaker and a clock across runs. One is made per run if none is given. */
  router?: ModelRouter;
  /** Absent means the Luau verdict is `warn` and says why — see `analyseChangeSet`. */
  analyser?: LuauAnalysisPort;
  clock?: Clock;
  /** Must return a uuid: the core picks neither a uuid library nor a global. */
  newId: () => string;
  /** Written into `Validation.computedBy`. The build that computed the verdict. */
  computedBy?: string;
  onEvent?: RunEventSink;
  analysisTimeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * Progress, as it happens.
 *
 * `model-attempt` carries the router's own `ModelAttempt` and so can only be
 * emitted once the router hands it back; `model-attempt-started` is emitted
 * before the call, so a caller watching a slow model sees which one it is
 * waiting on rather than a gap.
 */
export type RunEvent =
  | { type: 'stage'; at: string; from: Run['stage']; stage: Run['stage'] }
  | { type: 'plan'; at: string; plan: RunPlan }
  | { type: 'model-attempt-started'; at: string; modelId: string; provider: string; attemptIndex: number }
  | { type: 'output-delta'; at: string; modelId: string; delta: string }
  | { type: 'model-attempt'; at: string; attempt: ModelAttempt }
  | { type: 'model-skipped'; at: string; skipped: SkippedCandidate }
  | { type: 'validation'; at: string; changeSetId: string; validation: Validation }
  | { type: 'change-set'; at: string; changeSet: ChangeSetType }
  | { type: 'cancelled'; at: string; reason: string }
  | { type: 'failed'; at: string; failure: ProtocolError };

export type RunEventSink = (event: RunEvent) => void;

export interface RunResult {
  run: Run;
  /** The run's plan for itself. Present even when generation never produced anything. */
  plan: RunPlan;
  /** Present once a model produced one the protocol accepts, failed validation included. */
  changeSet?: ChangeSetType;
  validation?: Validation;
  decision?: PolicyDecision;
  /** Candidates the breaker or the attempt budget kept out of the run. Never counted as attempts. */
  skipped: SkippedCandidate[];
  ordering?: OrderingReport;
  failure?: ProtocolError;
}

const MAX_PARSE_ISSUES_REPORTED = 20;
const MAX_NOTE_CHARS = 500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeRun(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const clock = deps.clock ?? systemClock;
  const now = (): string => new Date(clock()).toISOString();
  const router = deps.router ?? new ModelRouter({ clock });
  const policy = request.policy ?? DENY_ALL_POLICY;

  const run: Run = {
    id: request.runId,
    projectId: request.projectId,
    prompt: request.prompt,
    stage: 'queued',
    status: 'running',
    attempts: [],
    changeSetIds: [],
    startedAt: now(),
    finishedAt: null,
  };
  if (request.producer) run.producer = request.producer;

  let plan: RunPlan = { steps: [] };
  let skipped: SkippedCandidate[] = [];

  const emit = (event: RunEvent): void => {
    if (!deps.onEvent) return;
    try {
      deps.onEvent(event);
    } catch {
      // A sink is an observer. A run that died because something watching it
      // threw would be the observation changing the result, and there is no
      // telemetry port in this signature to report it to.
    }
  };

  const advance = (to: Run['stage']): void => {
    const from = run.stage;
    assertTransition(from, to);
    run.stage = to;
    emit({ type: 'stage', at: now(), from, stage: to });
  };

  const fail = (failure: ProtocolError, partial: Partial<RunResult> = {}): RunResult => {
    if (!isTerminal(run.stage)) advance('failed');
    run.status = 'failed';
    run.finishedAt = now();
    emit({ type: 'failed', at: now(), failure });
    return { run, plan, skipped, ...partial, failure };
  };

  /**
   * A cancelled run is `cancelled`, not `failed`. The protocol has both stages
   * and both statuses, and collapsing them would put "this model could not do
   * it" in the record of a run somebody stopped on purpose.
   */
  const cancel = (reason: string, partial: Partial<RunResult> = {}): RunResult => {
    if (!isTerminal(run.stage)) advance('cancelled');
    run.status = 'cancelled';
    run.finishedAt = now();
    emit({ type: 'cancelled', at: now(), reason });
    return { run, plan, skipped, ...partial, failure: { code: 'invalid_request', message: reason } };
  };

  try {
    advance('planning');
    plan = planFor(request, policy, deps, clock());
    emit({ type: 'plan', at: now(), plan });

    advance('generating');

    const promptContext: PromptContext = {
      prompt: request.prompt,
      allowedPathPrefixes: policy.allowedPathPrefixes,
      baseVersion: request.baseVersion,
    };
    if (request.treeSummary) promptContext.treeSummary = request.treeSummary;

    const routed = await router.run<ChangeSetType>(
      request.candidates,
      {
        policy: request.routingPolicy,
        ...(request.pinnedModelId ? { pinnedModelId: request.pinnedModelId } : {}),
        ...(request.requirements ? { requirements: request.requirements } : {}),
        ...(request.maxAttempts !== undefined ? { maxAttempts: request.maxAttempts } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      },
      async (model, context) => {
        emit({
          type: 'model-attempt-started',
          at: now(),
          modelId: model.id,
          provider: model.provider,
          attemptIndex: context.attemptIndex,
        });
        return await generateChangeSet(model, {
          request,
          promptContext,
          deps,
          now,
          signal: context.signal ?? request.signal,
          createdAt: now(),
        });
      },
    );

    run.attempts = [...run.attempts, ...routed.attempts];
    skipped = [...skipped, ...routed.skipped];
    for (const attempt of routed.attempts) emit({ type: 'model-attempt', at: now(), attempt });
    for (const entry of routed.skipped) emit({ type: 'model-skipped', at: now(), skipped: entry });

    if (routed.cancelled) {
      return cancel(routed.failure?.message ?? 'the run was cancelled', { ordering: routed.ordering });
    }

    if (!routed.succeeded || !routed.output) {
      return fail(routed.failure ?? noOutputFailure(), { ordering: routed.ordering });
    }

    const set = routed.output;
    const ordering = routed.ordering;

    advance('validating');

    if (!withinSizeLimit(set)) {
      // Checked after the shape, because a set that fails the schema is not a
      // set whose size means anything.
      return fail(
        {
          code: 'too_large',
          message: 'the ChangeSet exceeds the protocol size limit',
          remedy: 'stage the work across several smaller ChangeSets',
        },
        { changeSet: set, ordering },
      );
    }

    const decision = checkPolicy(set, policy);
    const luau = await analyseChangeSet(set, {
      analyser: deps.analyser,
      allowedHttpHosts: request.allowedHttpHosts ?? [],
      budget: {
        timeoutMs: deps.analysisTimeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
        maxOutputBytes: MAX_SANDBOX_OUTPUT_BYTES,
      },
    });

    const validation: Validation = {
      luau,
      policy: decision.policy,
      computedAt: now(),
      computedBy: deps.computedBy ?? 'forgebridge-core',
    };

    run.changeSetIds = [...run.changeSetIds, set.id];
    emit({ type: 'validation', at: now(), changeSetId: set.id, validation });

    if (decision.policy.status === 'fail' || luau.status === 'fail') {
      // A set that was never going to be legal is not shown to an approver:
      // asking a human to reject what the machine already rejected is how a
      // review gate becomes a rubber stamp.
      const rejected: ChangeSetType = { ...set, validation, status: 'rejected' };
      const failure: ProtocolError =
        decision.policy.status === 'fail'
          ? {
              code: 'policy_violation',
              message: `this ChangeSet is outside the project's allowed paths: ${decision.policy.violations[0] ?? ''}`.slice(0, 500),
              remedy: 'widen the project path policy, or ask for a change inside it',
            }
          : {
              code: 'invalid_request',
              message: 'static analysis rejected the generated Luau',
              remedy: firstErrorFinding(luau) ?? 'open the findings for detail',
            };
      return fail(failure, { changeSet: rejected, validation, decision, ordering });
    }

    const validated: ChangeSetType = { ...set, validation, status: 'validated' };
    emit({ type: 'change-set', at: now(), changeSet: validated });

    advance('awaiting-approval');
    // `status` stays `running`: the run has not finished, it is waiting for a
    // person. A run marked succeeded here would claim work that never happened.
    return { run, plan, changeSet: validated, validation, decision, skipped, ordering };
  } catch (error) {
    // `internal` never carries an internal detail on the wire (protocol/errors.ts);
    // the real message belongs in the caller's telemetry, not in a response.
    void error;
    return fail({ code: 'internal', message: 'the run failed unexpectedly' });
  }
}

/**
 * The run's plan for itself: which models it will try, against what, and what
 * happens to the result. Not a model-authored design document — the steps are
 * facts about this run that are true before any model is called, which is what
 * makes them safe to stream first.
 *
 * The ordering is previewed with the router's own exported `meetsRequirements`
 * and `orderCandidates`, not a second implementation of them. The router
 * recomputes it, and `RunResult.ordering` carries what it actually did.
 */
function planFor(
  request: RunRequest,
  policy: ProjectPolicy,
  deps: RunDeps,
  now: number,
): RunPlan {
  const steps: string[] = [];

  if (request.routingPolicy === 'pinned') {
    steps.push(
      `route: pinned to ${request.pinnedModelId ?? '(no model named)'} — no fallback, this run stands or falls with it`,
    );
  } else {
    const eligible = request.candidates.filter(
      (model) => meetsRequirements(model, request.requirements).ok,
    );
    const { ordered, note } = orderCandidates(eligible, request.routingPolicy, now);
    const order = ordered.map((model) => model.id);
    steps.push(
      `route: ${eligible.length} of ${request.candidates.length} candidates meet this run's requirements; ` +
        `${request.routingPolicy} order — ${order.join(' → ') || 'none'}${note ? ` (${note})` : ''}`,
    );
  }

  steps.push(`generate: one ChangeSet against tree version ${request.baseVersion}`);
  steps.push(
    `validate: ${policy.allowedPathPrefixes.length} allowed path prefix(es), and Luau analysis ` +
      `${deps.analyser ? 'by the configured analyser' : 'unavailable — scripts will be reported unchecked'}`,
  );
  steps.push('await approval: this run proposes a ChangeSet, it never applies one');

  return { steps };
}

interface GenerationContext {
  request: RunRequest;
  promptContext: PromptContext;
  deps: RunDeps;
  now: () => string;
  signal: AbortSignal | undefined;
  createdAt: string;
}

/**
 * One model's turn.
 *
 * Everything that can go wrong here comes back as an `InvocationResult` with an
 * outcome the router records and moves on from — including the malformed-output
 * cases, which is the whole point: a model that emits operations the protocol
 * refuses has failed this attempt exactly as surely as one that timed out, and
 * the run log should say which of the two happened.
 */
async function generateChangeSet(
  model: ModelCandidate,
  context: GenerationContext,
): Promise<InvocationResult<ChangeSetType>> {
  const { request, deps } = context;

  const completion: CompletionRequest = {
    model,
    messages: changeSetMessages(context.promptContext),
    tools: [changeSetTool(context.promptContext)],
    responseFormat: 'json',
  };
  if (deps.maxOutputTokens !== undefined) completion.maxOutputTokens = deps.maxOutputTokens;
  if (deps.temperature !== undefined) completion.temperature = deps.temperature;
  if (context.signal) completion.signal = context.signal;

  let response: CompletionResponse;
  try {
    response = await complete(deps.models, completion, (delta) => {
      if (!deps.onEvent) return;
      try {
        deps.onEvent({ type: 'output-delta', at: context.now(), modelId: model.id, delta });
      } catch {
        // As above: an observer must not take the run with it.
      }
    });
  } catch (error) {
    // The adapter's own classification, or `provider-error` when it did not
    // give one. Never a guess from the message text (ADR-008).
    return { outcome: outcomeOf(error), note: clip(messageOf(error), MAX_NOTE_CHARS) };
  }

  const usage: Pick<InvocationResult<ChangeSetType>, 'promptTokens' | 'completionTokens' | 'costUsd'> = {};
  if (response.usage?.promptTokens !== undefined) usage.promptTokens = response.usage.promptTokens;
  if (response.usage?.completionTokens !== undefined) usage.completionTokens = response.usage.completionTokens;
  if (response.usage?.costUsd !== undefined) usage.costUsd = response.usage.costUsd;

  // A refusal is the model declining, not the provider failing. Recorded as
  // `refused` so the breaker leaves the provider alone (router.ts).
  if (response.finishReason === 'refusal' || response.finishReason === 'content-filter') {
    return {
      ...usage,
      outcome: 'refused',
      note: clip(`${response.finishReason}: ${response.text}`, MAX_NOTE_CHARS),
    };
  }

  const envelope = envelopeOf(response);
  if ('missing' in envelope) {
    return { ...usage, outcome: 'invalid-output', note: clip(envelope.missing, MAX_NOTE_CHARS) };
  }

  const draft = parseDraft(envelope.text);
  if (typeof draft === 'string') {
    const truncated = response.finishReason === 'length' ? ' (the response hit its output limit)' : '';
    return { ...usage, outcome: 'invalid-output', note: clip(`${draft}${truncated}`, MAX_NOTE_CHARS) };
  }

  // Only the two fields a model is allowed to contribute are read off the
  // draft. Everything else — id, baseVersion, status, timestamps, validation —
  // is the core's, which is what makes "a model-authored verdict is discarded"
  // true rather than merely intended: there is nowhere to put one.
  const parsed = ChangeSet.safeParse({
    id: deps.newId(),
    projectId: request.projectId,
    runId: request.runId,
    baseVersion: request.baseVersion,
    summary: draft.summary,
    operations: draft.operations,
    status: 'proposed',
    createdAt: context.createdAt,
    metadata: {},
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_PARSE_ISSUES_REPORTED)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ...usage, outcome: 'invalid-output', note: clip(`the protocol refuses this set: ${issues}`, MAX_NOTE_CHARS) };
  }

  return { ...usage, outcome: 'ok', output: parsed.data };
}

/**
 * Prefer `stream` when the adapter has one, so a caller sees output arriving.
 *
 * The stream's `done` event is the response — nothing here rebuilds one from
 * the deltas it happened to see, because usage and finish reason are facts the
 * provider reports and a reconstructed one would be a plausible invention.
 */
async function complete(
  models: ModelClient,
  request: CompletionRequest,
  onDelta: (delta: string) => void,
): Promise<CompletionResponse> {
  if (!models.stream) return await models.complete(request);

  let response: CompletionResponse | undefined;
  for await (const event of models.stream(request)) {
    if (event.type === 'text') onDelta(event.delta);
    // `tool-call` events are not accumulated: `done` carries the completed
    // calls, and a half-streamed argument string is not JSON.
    else if (event.type === 'done') response = event.response;
  }

  if (!response) {
    throw new ModelClientError('invalid-output', 'the model stream ended without a final response');
  }
  return response;
}

/** The JSON text to parse: a tool call's arguments, or the message body. */
function envelopeOf(response: CompletionResponse): { text: string } | { missing: string } {
  const calls = response.toolCalls ?? [];
  const named = calls.find((call) => call.name === CHANGE_SET_TOOL_NAME);
  const call = named ?? (calls.length === 1 ? calls[0] : undefined);
  if (call) return { text: call.arguments };
  if (calls.length > 1) {
    return {
      missing: `the model made ${calls.length} tool calls and none of them was ${CHANGE_SET_TOOL_NAME}`,
    };
  }

  const text = response.text.trim();
  if (text.length === 0) return { missing: 'the model returned no content' };
  return { text: unfence(text) };
}

/**
 * Strip a fence when the whole response is one fenced block.
 *
 * This unwraps; it does not repair. The bytes between the fences reach the
 * parser exactly as the model wrote them.
 */
function unfence(text: string): string {
  if (!text.startsWith('```') || !text.endsWith('```') || text.length < 7) return text;
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return text;
  const infoString = text.slice(3, firstBreak).trim();
  // Anything but a bare language tag means this is not a wrapper we recognise,
  // and guessing where the JSON starts would be editing the model's output.
  if (infoString !== '' && !/^[A-Za-z]+$/.test(infoString)) return text;
  return text.slice(firstBreak + 1, text.length - 3).trim();
}

/**
 * The two fields a model contributes, or a sentence saying why there are none.
 *
 * The shape check is here rather than left to the protocol because "operations
 * is not an array" reads better in a run log than a Zod path, and because
 * `DraftChangeSet` is the type the rest of the core has agreed to.
 */
function parseDraft(text: string): DraftChangeSet | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `the model did not return JSON: ${messageOf(error)}`;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `the model returned ${Array.isArray(value) ? 'an array' : typeof value}, not a ChangeSet object`;
  }

  const envelope = value as { summary?: unknown; operations?: unknown };
  if (typeof envelope.summary !== 'string') {
    return `"summary" is ${envelope.summary === undefined ? 'missing' : `a ${typeof envelope.summary}`}, and must be one line of text`;
  }
  if (!Array.isArray(envelope.operations)) {
    return `"operations" is ${envelope.operations === undefined ? 'missing' : `a ${typeof envelope.operations}`}, and must be an array`;
  }

  return { summary: envelope.summary, operations: envelope.operations as unknown[] };
}

function noOutputFailure(): ProtocolError {
  return {
    code: 'provider_unconfigured',
    message: 'the generating stage produced no output and no reason',
    remedy: 'this is a router or adapter bug; the attempt list on the run shows what was tried',
  };
}
