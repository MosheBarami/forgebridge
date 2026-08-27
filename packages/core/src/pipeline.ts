import {
  ApplyResult,
  ChangeSet,
  ForgeBridgeError,
  isFullyApplied,
  withinSizeLimit,
} from '@forgebridge/protocol';
import type {
  ApplyResult as ApplyResultType,
  ChangeSet as ChangeSetType,
  ModelAttempt,
  ProtocolError,
  Run,
  Validation,
} from '@forgebridge/protocol';
import { systemClock, type Clock } from './clock.js';
import { checkPolicy, DENY_ALL_POLICY, type PolicyDecision } from './policy.js';
import {
  analyseChangeSet,
  firstErrorFinding,
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  MAX_SANDBOX_OUTPUT_BYTES,
} from './validate.js';
import {
  ModelRouter,
  type InvocationContext,
  type InvocationResult,
  type ModelCandidate,
  type RoutingPolicy,
  type RoutingRequirements,
} from './router.js';
import type {
  Attributes,
  SandboxPort,
  Span,
  SpanContext,
  StoragePort,
  TelemetryPort,
  TestReport,
  TransportPort,
} from './ports/index.js';
import { TELEMETRY } from './ports/telemetry.js';

/**
 * The run pipeline, as a state machine over the protocol's `RunStage`.
 *
 *   queued → planning → generating → validating → awaiting-approval
 *          → applying → testing → done
 *
 * with `failed` and `cancelled` reachable from every non-terminal stage. The
 * transitions are data (`LEGAL_TRANSITIONS`) rather than a pile of `if`s, so the
 * illegal ones are refused by one check in one place and can be tested directly.
 *
 * Two edges are worth reading twice:
 *
 *   - `validating → applying` exists only for the project's opt-in auto-apply
 *     (ADR-012). It is the sole path that skips the human gate.
 *   - `validating → failed` is taken when the policy or the Luau analysis says
 *     `fail`. A set that was never going to be legal is not shown to an approver;
 *     asking a human to reject something the machine already rejected is how a
 *     review gate becomes a rubber stamp.
 */

type RunStage = Run['stage'];

export const LEGAL_TRANSITIONS = {
  queued: ['planning', 'failed', 'cancelled'],
  planning: ['generating', 'failed', 'cancelled'],
  generating: ['validating', 'failed', 'cancelled'],
  validating: ['awaiting-approval', 'applying', 'failed', 'cancelled'],
  'awaiting-approval': ['applying', 'failed', 'cancelled'],
  applying: ['testing', 'done', 'failed', 'cancelled'],
  testing: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<RunStage, readonly RunStage[]>;

export function canTransition(from: RunStage, to: RunStage): boolean {
  return (LEGAL_TRANSITIONS[from] as readonly RunStage[]).includes(to);
}

export function assertTransition(from: RunStage, to: RunStage): void {
  if (!canTransition(from, to)) {
    throw new ForgeBridgeError(
      'invalid_request',
      `illegal run transition ${from} → ${to}`,
      `legal next stages from "${from}": ${LEGAL_TRANSITIONS[from].join(', ') || 'none, it is terminal'}`,
    );
  }
}

/** Stages from which no further transition is possible. */
export function isTerminal(stage: RunStage): boolean {
  return LEGAL_TRANSITIONS[stage].length === 0;
}

/**
 * The capability vocabulary is the model registry's, not the core's — these are
 * the strings that appear in `packages/model-registry/data/catalog.json`. The
 * pipeline needs both: it drives tools and it parses a structured ChangeSet out
 * of the response. Callers may override per run.
 */
export const DEFAULT_PIPELINE_REQUIREMENTS: RoutingRequirements = {
  capabilities: ['tools', 'structured_outputs'],
};

/** Human-readable steps, streamed to the UI before any operation exists. */
export interface RunPlan {
  steps: string[];
}

/**
 * What a model produced.
 *
 * `operations` is `unknown[]` because it is exactly that until the protocol
 * parses it. Note there is no `validation` field: a model-authored verdict is
 * discarded, and the surest way to discard it is to have nowhere to put it.
 */
export interface DraftChangeSet {
  summary: string;
  operations: unknown[];
}

export interface PlanRequest {
  projectId: string;
  prompt: string;
}

export interface GenerateRequest {
  projectId: string;
  prompt: string;
  plan: RunPlan;
  baseVersion: number;
}

/**
 * The model call, injected. This is the boundary that keeps the core free of
 * every vendor SDK (ADR-005, ADR-011): an adapter package owns the HTTP, the
 * prompt assembly, and the classification of what went wrong.
 */
export interface ModelClient {
  plan(
    request: PlanRequest,
    model: ModelCandidate,
    context: InvocationContext,
  ): Promise<InvocationResult<RunPlan>>;
  generate(
    request: GenerateRequest,
    model: ModelCandidate,
    context: InvocationContext,
  ): Promise<InvocationResult<DraftChangeSet>>;
}

export interface PipelineDeps {
  storage: StoragePort;
  transport: TransportPort;
  models: ModelClient;
  router: ModelRouter;
  sandbox?: SandboxPort;
  telemetry?: TelemetryPort;
  clock?: Clock;
  /** Injected so the core picks neither a uuid library nor a global. Must return a uuid. */
  newId: () => string;
  /** Written into `Validation.computedBy`. The build that computed the verdict. */
  computedBy?: string;
  /** How long to wait for a consumer to report an ApplyResult. */
  applyTimeoutMs?: number;
  /** Budget handed to the sandbox. */
  analysisTimeoutMs?: number;
  testTimeoutMs?: number;
}

export interface RunInput {
  runId: string;
  projectId: string;
  prompt: string;
  producer?: Run['producer'];
  routingPolicy: RoutingPolicy;
  pinnedModelId?: string;
  requirements?: RoutingRequirements;
  /**
   * Assembled by the caller — from the synced registry, from locally discovered
   * models (M24), or both. Keeping the registry out of the core means a daemon
   * can offer an Ollama model that no catalog has ever heard of.
   */
  candidates: readonly ModelCandidate[];
  /** Hosts scripts in this ChangeSet may reach. Empty means none. */
  allowedHttpHosts?: readonly string[];
  /**
   * The producer's span, when it sent one — the producer -> core edge of the
   * trace (M44). Parsed from an incoming `traceparent` with
   * `parseTraceparent`, which returns null for a header it cannot read; null
   * starts a new trace rather than inventing a parent.
   */
  parentTrace?: SpanContext | null;
  signal?: AbortSignal;
}

export interface ApprovalDecision {
  approvedBy: string;
  /** Required when the policy check set `requiresConfirmation`. */
  confirmBulkDelete?: boolean;
}

export interface RunState {
  run: Run;
  plan?: RunPlan;
  changeSet?: ChangeSetType;
  decision?: PolicyDecision;
  validation?: Validation;
  applyResult?: ApplyResultType;
  testReport?: TestReport;
  failure?: ProtocolError;
}

const DEFAULT_APPLY_TIMEOUT_MS = 300_000;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const MAX_PARSE_ISSUES_REPORTED = 20;

export class RunPipeline {
  readonly #deps: PipelineDeps;
  readonly #clock: Clock;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Drives a run from `queued` to whichever of `awaiting-approval`, `applying`
   * (auto-apply), `done`, or `failed` it reaches. Never throws for an expected
   * outcome — a failure comes back in `RunState.failure` with the run persisted,
   * because a run that vanished is a run nobody can explain afterwards.
   */
  async start(input: RunInput): Promise<RunState> {
    const run: Run = {
      id: input.runId,
      projectId: input.projectId,
      prompt: input.prompt,
      stage: 'queued',
      status: 'running',
      attempts: [],
      changeSetIds: [],
      startedAt: this.#now(),
      finishedAt: null,
    };
    if (input.producer) run.producer = input.producer;

    await this.#deps.storage.runs.create(run);

    const span = this.#deps.telemetry?.startSpan(
      'forgebridge.run',
      {
        [TELEMETRY.RUN_ID]: run.id,
        [TELEMETRY.PROJECT_ID]: run.projectId,
        [TELEMETRY.ROUTING_POLICY]: input.routingPolicy,
        ...(run.producer ? { [TELEMETRY.PRODUCER]: run.producer.kind } : {}),
      },
      { parent: input.parentTrace ?? null },
    );

    try {
      const requirements = input.requirements ?? DEFAULT_PIPELINE_REQUIREMENTS;

      await this.#advance(run, 'planning');
      const planned = await this.#deps.router.run<RunPlan>(
        input.candidates,
        this.#routerRequest(input, requirements),
        (model, context) => this.#deps.models.plan({ projectId: run.projectId, prompt: run.prompt }, model, context),
      );
      await this.#absorbAttempts(run, planned.attempts);
      if (!planned.succeeded || !planned.output) {
        return await this.#fail(run, planned.failure ?? unknownFailure('planning'), span);
      }
      const plan = planned.output;

      await this.#advance(run, 'generating');
      const baseVersion = await this.#deps.storage.trees.currentVersion(run.projectId);
      const generated = await this.#deps.router.run<DraftChangeSet>(
        input.candidates,
        this.#routerRequest(input, requirements),
        (model, context) =>
          this.#deps.models.generate(
            { projectId: run.projectId, prompt: run.prompt, plan, baseVersion },
            model,
            context,
          ),
      );
      await this.#absorbAttempts(run, generated.attempts);
      if (!generated.succeeded || !generated.output) {
        return await this.#fail(run, generated.failure ?? unknownFailure('generating'), span, { plan });
      }

      await this.#advance(run, 'validating');
      return await this.#validate(run, plan, generated.output, baseVersion, input, span);
    } catch (error) {
      span?.recordException(error);
      return await this.#fail(run, internalFailure(error), span);
    } finally {
      span?.end();
    }
  }

  /**
   * The human gate. Re-derives the policy decision from the stored ChangeSet
   * rather than trusting a flag written earlier: between validation and approval
   * the project's policy may have been tightened, and the tighter answer wins.
   */
  async approve(runId: string, decision: ApprovalDecision): Promise<RunState> {
    const run = await this.#loadRun(runId);
    if (run.stage !== 'awaiting-approval') {
      throw new ForgeBridgeError(
        'invalid_request',
        `run ${runId} is at stage "${run.stage}" and is not awaiting approval`,
      );
    }

    const set = await this.#loadChangeSet(run);
    const policy = (await this.#deps.storage.policies.get(run.projectId)) ?? DENY_ALL_POLICY;
    const policyDecision = checkPolicy(set, policy);

    if (policyDecision.policy.status !== 'ok') {
      return await this.#fail(run, {
        code: 'policy_violation',
        message: 'the project policy changed and this ChangeSet no longer passes it',
        remedy: policyDecision.policy.violations[0] ?? 'review the project path policy',
      });
    }

    if (policyDecision.requiresConfirmation && decision.confirmBulkDelete !== true) {
      // Not a transition: the run stays where it is, awaiting a real answer.
      throw new ForgeBridgeError(
        'not_approved',
        policyDecision.bulkDelete?.reason ?? 'this ChangeSet requires explicit deletion confirmation',
        'approve again with confirmBulkDelete set, after reading which instances are removed',
      );
    }

    // `baseVersion` is checked here as well as by the consumer. The place can
    // move while a diff sits open in front of somebody, and a rebase is cheaper
    // to explain before an apply than after a partial one.
    const currentVersion = await this.#deps.storage.trees.currentVersion(run.projectId);
    if (currentVersion !== set.baseVersion) {
      await this.#deps.storage.changeSets.setStatus(set.id, 'stale', set.status);
      return await this.#fail(run, {
        code: 'stale_base',
        message: `the place moved from version ${set.baseVersion} to ${currentVersion} while this set awaited approval`,
        remedy: 'rebase the run against the current tree and generate again',
      });
    }

    const claimed = await this.#deps.storage.changeSets.setStatus(set.id, 'approved', 'validated');
    if (!claimed) {
      throw new ForgeBridgeError(
        'invalid_request',
        `ChangeSet ${set.id} was no longer awaiting approval when the approval arrived`,
        'someone or something else approved, rejected, or applied it first',
      );
    }

    await this.#advance(run, 'applying');

    // A span of its own, and the reason is worth stating: approval arrives in a
    // different request — usually minutes later, from a human — so it cannot be
    // a child of the run span, which ended when the run reached the gate. The
    // two traces are joined by `forgebridge.changeset.id`, which both carry.
    // Presenting this as a child of a trace that has already ended would be a
    // parent link to a span nobody can fetch.
    const applySpan = this.#deps.telemetry?.startSpan('forgebridge.approve', {
      [TELEMETRY.RUN_ID]: run.id,
      [TELEMETRY.PROJECT_ID]: run.projectId,
      [TELEMETRY.CHANGE_SET_ID]: set.id,
      [TELEMETRY.OPERATION_COUNT]: set.operations.length,
    });
    try {
      return await this.#apply(run, { ...set, status: 'approved' }, policyDecision, undefined, applySpan);
    } finally {
      applySpan?.end();
    }
  }

  async reject(runId: string, reason: string): Promise<RunState> {
    const run = await this.#loadRun(runId);
    if (isTerminal(run.stage)) return { run };
    const id = run.changeSetIds[run.changeSetIds.length - 1];
    const set = id ? await this.#deps.storage.changeSets.get(id) : null;
    if (set) await this.#deps.storage.changeSets.setStatus(set.id, 'rejected', set.status);
    return await this.#fail(run, {
      code: 'not_approved',
      message: 'a reviewer rejected this ChangeSet',
      remedy: reason.slice(0, 500),
    });
  }

  async cancel(runId: string, reason?: string): Promise<RunState> {
    const run = await this.#loadRun(runId);
    if (isTerminal(run.stage)) return { run };
    await this.#advance(run, 'cancelled');
    run.status = 'cancelled';
    run.finishedAt = this.#now();
    await this.#deps.storage.runs.patch(run.id, { status: run.status, finishedAt: run.finishedAt });
    const failure: ProtocolError = { code: 'invalid_request', message: reason ?? 'the run was cancelled' };
    return { run, failure };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * A span beneath `parent`, or undefined when no telemetry is installed.
   *
   * `parent?.context() ?? null` and not `undefined`: the port reads null as
   * "start a new trace", and a caller that has no parent must say so rather
   * than let an adapter guess. See `SpanOptions` in `ports/telemetry.ts`.
   */
  #child(parent: Span | undefined, name: string, attributes: Attributes = {}): Span | undefined {
    return this.#deps.telemetry?.startSpan(name, attributes, { parent: parent?.context() ?? null });
  }

  #routerRequest(input: RunInput, requirements: RoutingRequirements) {
    return {
      policy: input.routingPolicy,
      ...(input.pinnedModelId ? { pinnedModelId: input.pinnedModelId } : {}),
      requirements,
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  async #validate(
    run: Run,
    plan: RunPlan,
    draft: DraftChangeSet,
    baseVersion: number,
    input: RunInput,
    span?: Span,
  ): Promise<RunState> {
    // Only the two fields the model is allowed to contribute are read off the
    // draft. Everything else — id, baseVersion, status, timestamps, validation —
    // is the core's, which is what makes "validation is never accepted from a
    // producer" true rather than merely intended.
    const candidate = {
      id: this.#deps.newId(),
      projectId: run.projectId,
      runId: run.id,
      baseVersion,
      summary: draft.summary,
      operations: draft.operations,
      status: 'proposed' as const,
      createdAt: this.#now(),
      metadata: {},
    };

    const parsed = ChangeSet.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, MAX_PARSE_ISSUES_REPORTED)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      return await this.#fail(
        run,
        {
          code: 'invalid_request',
          message: `the model produced a ChangeSet the protocol refuses: ${issues.join('; ')}`.slice(0, 500),
          remedy: 'this is a generation failure, not a user error; retry, or pick a model with structured output',
        },
        span,
        { plan },
      );
    }

    const set = parsed.data;

    // The join key: every span from here on names the ChangeSet, so a query on
    // this attribute answers "what happened to this ChangeSet" even across the
    // trace boundary that `approve()` — a later request — necessarily creates.
    span?.setAttributes({
      [TELEMETRY.CHANGE_SET_ID]: set.id,
      [TELEMETRY.OPERATION_COUNT]: set.operations.length,
      [TELEMETRY.BASE_VERSION]: set.baseVersion,
    });

    if (!withinSizeLimit(set)) {
      return await this.#fail(
        run,
        {
          code: 'too_large',
          message: 'the ChangeSet exceeds the protocol size limit',
          remedy: 'stage the work across several smaller ChangeSets',
        },
        span,
        { plan, changeSet: set },
      );
    }

    const policy = (await this.#deps.storage.policies.get(run.projectId)) ?? DENY_ALL_POLICY;
    const decision = checkPolicy(set, policy);
    const luau = await this.#analyse(set, input.allowedHttpHosts ?? []);

    const validation: Validation = {
      luau,
      policy: decision.policy,
      computedAt: this.#now(),
      computedBy: this.#deps.computedBy ?? 'forgebridge-core',
    };

    const validated: ChangeSetType = { ...set, validation, status: 'validated' };
    await this.#deps.storage.changeSets.save(validated);
    run.changeSetIds = [...run.changeSetIds, validated.id];
    await this.#deps.storage.runs.patch(run.id, { changeSetIds: run.changeSetIds });

    if (decision.policy.status === 'fail' || luau.status === 'fail') {
      await this.#deps.storage.changeSets.setStatus(validated.id, 'rejected', 'validated');
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
      return await this.#fail(run, failure, span, { plan, changeSet: validated, decision, validation });
    }

    // Auto-apply additionally requires a clean Luau verdict. Without an analyser
    // configured the verdict is `warn` (see `#analyse`), so a deployment with no
    // sandbox never auto-applies — the honest consequence of not having checked.
    const autoApply = decision.autoApply.eligible && luau.status === 'ok';

    if (autoApply) {
      const claimed = await this.#deps.storage.changeSets.setStatus(validated.id, 'approved', 'validated');
      if (claimed) {
        await this.#advance(run, 'applying');
        return await this.#apply(run, { ...validated, status: 'approved' }, decision, plan, span);
      }
    }

    await this.#advance(run, 'awaiting-approval');
    return { run, plan, changeSet: validated, decision, validation };
  }

  /**
   * Delegated to `validate.ts`, which both run drivers share. The rules it
   * enforces — an unconfigured analyser reports `warn`, a truncated pass never
   * reports `ok` — are the kind that rot when they are written twice.
   */
  async #analyse(set: ChangeSetType, allowedHttpHosts: readonly string[]): Promise<Validation['luau']> {
    return await analyseChangeSet(set, {
      analyser: this.#deps.sandbox,
      allowedHttpHosts,
      budget: {
        timeoutMs: this.#deps.analysisTimeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
        maxOutputBytes: MAX_SANDBOX_OUTPUT_BYTES,
      },
    });
  }

  async #apply(
    run: Run,
    set: ChangeSetType,
    decision: PolicyDecision,
    plan?: RunPlan,
    span?: Span,
  ): Promise<RunState> {
    const base: RunState = { run, changeSet: set, decision };
    if (plan) base.plan = plan;
    if (set.validation) base.validation = set.validation;

    const link = await this.#deps.transport.status(run.projectId);
    if (!link || link.state !== 'paired') {
      return await this.#fail(
        run,
        {
          code: 'link_unpaired',
          message: 'no Studio session is linked to this project',
          remedy: 'open Studio with the ForgeBridge plugin and pair it, then approve again',
        },
        undefined,
        base,
      );
    }

    await this.#deps.storage.changeSets.setStatus(set.id, 'applying', 'approved');

    // The core -> transport edge of M44's trace. Two spans and not one: a
    // delivery that was queued in four milliseconds and a Studio session that
    // took ninety seconds to answer are different facts, and a single
    // `forgebridge.apply` span would report their sum and let nobody tell
    // which happened.
    const transportInfo = this.#deps.transport.describe();
    const transportAttributes: Attributes = {
      [TELEMETRY.CHANGE_SET_ID]: set.id,
      [TELEMETRY.RUN_ID]: run.id,
      [TELEMETRY.LINK_ID]: link.id,
      [TELEMETRY.TRANSPORT_KIND]: transportInfo.kind,
    };
    const deliverSpan = this.#child(span, 'forgebridge.transport.deliver', transportAttributes);
    try {
      const receipt = await this.#deps.transport.deliver(link, set);
      deliverSpan?.setAttributes({ [TELEMETRY.DELIVERY_NONCE]: receipt.nonce });
    } catch (error) {
      deliverSpan?.recordException(error);
      deliverSpan?.setStatus('error');
      throw error;
    } finally {
      deliverSpan?.end();
    }

    const awaitSpan = this.#child(span, 'forgebridge.transport.await-apply', transportAttributes);
    let reported: unknown;
    try {
      reported = await this.#deps.transport.awaitApplyResult(set.id, {
        timeoutMs: this.#deps.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS,
      });
    } catch (error) {
      awaitSpan?.recordException(error);
      // `error` on the transport span, and a *failed run* below — but the
      // ChangeSet's status stays `applying`. All three are the same fact said
      // at three altitudes: we have no result, which is not the same as
      // nothing having been applied.
      awaitSpan?.setStatus('error');
      span?.recordException(error);
      // The status stays `applying`. A timeout tells us we have no result, not
      // that nothing was applied, and marking it `failed` would invent a fact
      // about the user's place.
      return await this.#fail(
        run,
        {
          code: 'internal',
          message: 'no apply result came back before the timeout',
          remedy: 'check the Studio session; the ChangeSet may still be applying there',
        },
        undefined,
        base,
      );
    } finally {
      awaitSpan?.end();
    }

    // The consumer is across a trust boundary like everything else.
    const parsedResult = ApplyResult.safeParse(reported);
    if (!parsedResult.success) {
      return await this.#fail(
        run,
        {
          code: 'invalid_request',
          message: 'the consumer reported an apply result the protocol refuses',
          remedy: 'the plugin may be a version this server does not understand',
        },
        undefined,
        base,
      );
    }

    const result = parsedResult.data;
    await this.#deps.storage.changeSets.recordApplyResult(set.id, result);
    await this.#deps.storage.trees.recordConsumerVersion(run.projectId, result.newVersion, result.appliedAt);

    // TODO(M11): the inverse operations that make rollback work are computed by
    // the consumer, and the frozen protocol's ApplyResult carries only the
    // `journalId` handle — not the entry. Until a transport method exists to
    // upload the JournalEntry itself, the core stores the handle and nothing
    // here writes `storage.journal`. Owner: the journal + rollback milestone.

    const fully = isFullyApplied(result);
    const applied = { ...base, applyResult: result };

    if (!fully) {
      await this.#deps.storage.changeSets.setStatus(
        set.id,
        result.outcomes.some((outcome) => outcome.ok) ? 'partial' : 'failed',
        'applying',
      );
      const failedCount = result.outcomes.filter((outcome) => !outcome.ok).length;
      return await this.#fail(
        run,
        {
          code: 'internal',
          message: `${failedCount} of ${result.outcomes.length} operations did not apply`,
          remedy: `roll back with journal ${result.journalId}, or fix the reported operations and generate again`,
        },
        undefined,
        applied,
      );
    }

    await this.#deps.storage.changeSets.setStatus(set.id, 'applied', 'applying');

    if (!this.#deps.sandbox) {
      // Straight to done, and the caller can see there is no test report rather
      // than a green one nobody produced.
      await this.#advance(run, 'done');
      return await this.#succeed(run, applied);
    }

    await this.#advance(run, 'testing');
    const testReport = await this.#deps.sandbox.test({
      projectId: run.projectId,
      changeSetId: set.id,
      budget: {
        timeoutMs: this.#deps.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
        maxOutputBytes: MAX_SANDBOX_OUTPUT_BYTES,
      },
    });

    const tested = { ...applied, testReport };
    if (testReport.outcome === 'failed' || testReport.outcome === 'errored') {
      // The changes are applied and stay applied; the run still did not achieve
      // what it set out to. Both facts are in the returned state.
      return await this.#fail(
        run,
        {
          code: 'internal',
          message: `the applied ChangeSet failed ${testReport.failed} of ${testReport.total} tests`,
          remedy: `roll back with journal ${result.journalId}, or generate a fix`,
        },
        undefined,
        tested,
      );
    }

    await this.#advance(run, 'done');
    return await this.#succeed(run, tested);
  }

  async #absorbAttempts(run: Run, attempts: readonly ModelAttempt[]): Promise<void> {
    if (attempts.length === 0) return;
    run.attempts = [...run.attempts, ...attempts];
    await this.#deps.storage.runs.patch(run.id, { attempts: run.attempts });
  }

  async #advance(run: Run, to: RunStage): Promise<void> {
    assertTransition(run.stage, to);
    run.stage = to;
    await this.#deps.storage.runs.patch(run.id, { stage: to });
  }

  async #succeed(run: Run, state: RunState): Promise<RunState> {
    run.status = 'succeeded';
    run.finishedAt = this.#now();
    await this.#deps.storage.runs.patch(run.id, { status: run.status, finishedAt: run.finishedAt });
    return { ...state, run };
  }

  async #fail(
    run: Run,
    failure: ProtocolError,
    span?: Span,
    state: Partial<RunState> = {},
  ): Promise<RunState> {
    if (!isTerminal(run.stage)) {
      await this.#advance(run, 'failed');
    }
    run.status = 'failed';
    run.finishedAt = this.#now();
    await this.#deps.storage.runs.patch(run.id, { status: run.status, finishedAt: run.finishedAt });
    span?.setStatus('error', failure.message);
    return { ...state, run, failure };
  }

  async #loadRun(runId: string): Promise<Run> {
    const run = await this.#deps.storage.runs.get(runId);
    if (!run) throw new ForgeBridgeError('not_found', `run ${runId} does not exist`);
    return run;
  }

  async #loadChangeSet(run: Run): Promise<ChangeSetType> {
    const id = run.changeSetIds[run.changeSetIds.length - 1];
    const set = id ? await this.#deps.storage.changeSets.get(id) : null;
    if (!set) throw new ForgeBridgeError('not_found', `run ${run.id} has no ChangeSet to approve`);
    return set;
  }

  #now(): string {
    return new Date(this.#clock()).toISOString();
  }
}

function unknownFailure(stage: string): ProtocolError {
  return {
    code: 'provider_unconfigured',
    message: `the ${stage} stage produced no output and no reason`,
    remedy: 'this is a router or adapter bug; the attempt list on the run shows what was tried',
  };
}

function internalFailure(error: unknown): ProtocolError {
  // `internal` never carries an internal detail on the wire (protocol/errors.ts).
  // The real message belongs in telemetry, not in a response.
  void error;
  return { code: 'internal', message: 'the run failed unexpectedly' };
}
