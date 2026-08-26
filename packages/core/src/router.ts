import { attemptSummary } from '@forgebridge/protocol';
import type { AttemptOutcome, ModelAttempt, ProtocolError } from '@forgebridge/protocol';
import { CircuitBreaker } from './breaker.js';
import { systemClock, type Clock } from './clock.js';

/**
 * The capability router (ADR-008): filter by capability, order by policy,
 * attempt in order, fall back, and record every attempt.
 *
 * The honesty requirement is the whole point and it is structural here:
 *
 *   - `run()` returns, it does not throw. A thrown error would take the attempt
 *     list with it, and a run is not reproducible without knowing what actually
 *     ran.
 *   - Every invocation produces exactly one `ModelAttempt`, appended before any
 *     branch on its outcome. An adapter that throws gets a `provider-error`
 *     attempt, not silence.
 *   - A candidate the breaker suppressed is reported in `skipped`, not in
 *     `attempts` — it never received the prompt, and putting it in the run's
 *     permanent record as an attempt would be its own small lie.
 *   - `pinned` disables fallback outright.
 */

export type RoutingPolicy = 'free-first' | 'fastest' | 'cheapest' | 'best' | 'pinned';

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface ModelBenchmarks {
  intelligence?: number;
  coding?: number;
  agentic?: number;
}

/**
 * What the router needs to know about a model.
 *
 * Structural rather than imported from `@forgebridge/model-registry`: the daemon
 * merges locally-discovered models (M24) into the same list, and those never
 * appear in a synced catalog. Any object with these fields routes.
 */
export interface ModelCandidate {
  id: string;
  /** Keys the circuit breaker and lands in `ModelAttempt.providerSlug`. */
  provider: string;
  contextTokens: number;
  /** The registry's capability vocabulary, verbatim. The core never interprets these strings. */
  capabilities: readonly string[];
  free: boolean;
  pricing: ModelPricing;
  benchmarks?: ModelBenchmarks | null;
  /** Measured, not catalogued. Absent when nothing has been measured yet. */
  medianLatencyMs?: number | null;
  expiresAt?: string | null;
  /** The registry's own verdict, when it has one. Overrides the local derivation below. */
  expiringSoon?: boolean;
}

export interface RoutingRequirements {
  /** Every one must be present on the candidate. */
  capabilities?: readonly string[];
  minContextTokens?: number;
}

export interface RouterRequest {
  policy: RoutingPolicy;
  /** Required when policy is `pinned`, ignored otherwise. */
  pinnedModelId?: string;
  requirements?: RoutingRequirements;
  /** Caps how many models are tried. Forced to 1 under `pinned`. */
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface InvocationContext {
  /** Zero-based position in the fallback chain. Useful for prompt-level backoff. */
  attemptIndex: number;
  signal?: AbortSignal;
}

/**
 * What an adapter reports back. `outcome` is mandatory and is the adapter's
 * classification of what happened — the router does not sniff error strings to
 * guess whether a 429 was a rate limit.
 */
export interface InvocationResult<T> {
  outcome: AttemptOutcome;
  /** Required when `outcome` is `ok`. An `ok` with no output is downgraded to `invalid-output`. */
  output?: T;
  promptTokens?: number;
  completionTokens?: number;
  /** Zero for free models. Present so a self-hoster can see their own spend. */
  costUsd?: number;
  note?: string;
}

export type ModelInvoker<T> = (
  model: ModelCandidate,
  context: InvocationContext,
) => Promise<InvocationResult<T>>;

export type SkipReason = 'circuit-open' | 'attempt-budget';

export interface SkippedCandidate {
  modelId: string;
  provider: string;
  reason: SkipReason;
  detail: string;
  retryAfterMs?: number;
}

export interface OrderingReport {
  policy: RoutingPolicy;
  candidatesConsidered: number;
  candidatesEligible: number;
  /** Model ids in the order they would have been tried. */
  order: string[];
  /** Set when the ordering could not be computed as asked — e.g. `fastest` with nothing measured. */
  note?: string;
}

export interface RouterResult<T> {
  succeeded: boolean;
  output?: T;
  model?: ModelCandidate;
  /** The full list, always, success or failure. This is the run's permanent record. */
  attempts: ModelAttempt[];
  skipped: SkippedCandidate[];
  ordering: OrderingReport;
  cancelled: boolean;
  failure?: ProtocolError;
}

/**
 * ADR-007: a model that vanishes mid-run is worse than one never offered, so
 * entries close to expiry sort last. The registry flags them; this derivation is
 * the fallback for a candidate list assembled by hand or in a test.
 */
export const EXPIRING_SOON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Outcomes that count against a provider's health.
 *
 * `rate-limited` is in: continuing to hammer a provider that is shedding load is
 * how a soft limit becomes a hard block. `refused` and `invalid-output` are out —
 * those are the model declining or producing nonsense, which says nothing about
 * whether the provider is up, and suppressing a whole provider for them would
 * take working models offline. `context-exceeded` and `capability-missing` are
 * routing mistakes, not outages. `cancelled` is us.
 */
const PROVIDER_HEALTH_FAILURES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  'rate-limited',
  'provider-error',
  'timeout',
]);

const MAX_NOTE_CHARS = 500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isExpiringSoon(model: ModelCandidate, now: number): boolean {
  if (typeof model.expiringSoon === 'boolean') return model.expiringSoon;
  if (!model.expiresAt) return false;
  const expiry = Date.parse(model.expiresAt);
  // An unparseable date is not evidence of anything. Guessing would deprioritise
  // a healthy model on the strength of a typo.
  if (Number.isNaN(expiry)) return false;
  return expiry - now <= EXPIRING_SOON_WINDOW_MS;
}

export function meetsRequirements(
  model: ModelCandidate,
  requirements: RoutingRequirements | undefined,
): { ok: true } | { ok: false; outcome: AttemptOutcome; detail: string } {
  if (!requirements) return { ok: true };

  if (requirements.minContextTokens !== undefined && model.contextTokens < requirements.minContextTokens) {
    return {
      ok: false,
      outcome: 'context-exceeded',
      detail: `context window ${model.contextTokens} is below the required ${requirements.minContextTokens}`,
    };
  }

  const missing = (requirements.capabilities ?? []).filter(
    (capability) => !model.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      outcome: 'capability-missing',
      detail: `does not report ${missing.join(', ')}`,
    };
  }

  return { ok: true };
}

/** Sum of both token prices. The token mix is unknown at routing time, and pretending otherwise would be a made-up weighting. */
function priceOf(model: ModelCandidate): number {
  return model.pricing.inputPerMTok + model.pricing.outputPerMTok;
}

/**
 * Benchmarks compared in the order that matters for this product: this is a
 * codegen tool, so `coding` leads, then `agentic` (the pipeline is tool-driven),
 * then general `intelligence`. A missing score sorts last rather than counting
 * as zero, so an unbenchmarked model is deprioritised, not condemned.
 */
function compareQuality(a: ModelCandidate, b: ModelCandidate): number {
  const keys: (keyof ModelBenchmarks)[] = ['coding', 'agentic', 'intelligence'];
  for (const key of keys) {
    const left = a.benchmarks?.[key];
    const right = b.benchmarks?.[key];
    if (left === right) continue;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left;
  }
  return 0;
}

interface Ranked {
  model: ModelCandidate;
  index: number;
  expiring: boolean;
}

export function orderCandidates(
  models: readonly ModelCandidate[],
  policy: RoutingPolicy,
  now: number,
): { ordered: ModelCandidate[]; note?: string } {
  const ranked: Ranked[] = models.map((model, index) => ({
    model,
    index,
    expiring: isExpiringSoon(model, now),
  }));

  let note: string | undefined;
  let compare: (a: Ranked, b: Ranked) => number;

  switch (policy) {
    case 'cheapest':
      compare = (a, b) => priceOf(a.model) - priceOf(b.model);
      break;
    case 'best':
      compare = (a, b) => compareQuality(a.model, b.model);
      break;
    case 'fastest': {
      const measured = models.filter((model) => typeof model.medianLatencyMs === 'number').length;
      if (measured === 0) {
        // Say so rather than silently ordering by something else and calling it
        // "fastest" — that would be a claim about the models we cannot support.
        note = 'no latency has been measured for any candidate; the given order was preserved';
      }
      compare = (a, b) => {
        const left = a.model.medianLatencyMs;
        const right = b.model.medianLatencyMs;
        if (typeof left !== 'number' && typeof right !== 'number') return 0;
        if (typeof left !== 'number') return 1;
        if (typeof right !== 'number') return -1;
        return left - right;
      };
      break;
    }
    case 'free-first':
      compare = (a, b) => {
        if (a.model.free !== b.model.free) return a.model.free ? -1 : 1;
        // Free models against each other: the best one first, since price is not
        // a tiebreak when everything costs nothing.
        if (a.model.free) return compareQuality(a.model, b.model);
        return priceOf(a.model) - priceOf(b.model);
      };
      break;
    case 'pinned':
      // Ordering is meaningless for a single pinned model; `run` never calls
      // this for `pinned`, but leaving it undefined would be a trap.
      compare = () => 0;
      break;
  }

  const ordered = ranked
    .slice()
    .sort((a, b) => {
      if (a.expiring !== b.expiring) return a.expiring ? 1 : -1;
      const primary = compare(a, b);
      if (primary !== 0) return primary;
      // Explicit index tiebreak: the caller's order is a real signal and the
      // result must not depend on the engine's sort being stable.
      return a.index - b.index;
    })
    .map((entry) => entry.model);

  return note === undefined ? { ordered } : { ordered, note };
}

export interface ModelRouterDeps {
  breaker?: CircuitBreaker;
  clock?: Clock;
}

export class ModelRouter {
  readonly #breaker: CircuitBreaker | undefined;
  readonly #clock: Clock;

  constructor(deps: ModelRouterDeps = {}) {
    this.#breaker = deps.breaker;
    this.#clock = deps.clock ?? systemClock;
  }

  get breaker(): CircuitBreaker | undefined {
    return this.#breaker;
  }

  async run<T>(
    catalog: readonly ModelCandidate[],
    request: RouterRequest,
    invoke: ModelInvoker<T>,
  ): Promise<RouterResult<T>> {
    const attempts: ModelAttempt[] = [];
    const skipped: SkippedCandidate[] = [];
    const now = this.#clock();

    const plan =
      request.policy === 'pinned'
        ? this.#planPinned(catalog, request, attempts, now)
        : this.#planFallback(catalog, request, now);

    const ordering: OrderingReport = plan.ordering;

    if (plan.failure) {
      return { succeeded: false, attempts, skipped, ordering, cancelled: false, failure: plan.failure };
    }

    // `pinned` means one model and no substitutions, whatever the caller asked
    // for in maxAttempts (ADR-008).
    const budget =
      request.policy === 'pinned'
        ? 1
        : Math.max(0, Math.min(request.maxAttempts ?? plan.ordered.length, plan.ordered.length));

    let cancelled = false;

    for (const model of plan.ordered) {
      if (request.signal?.aborted) {
        cancelled = true;
        break;
      }

      if (this.#breaker && !this.#breaker.allows(model.provider)) {
        const retryAfterMs = this.#breaker.retryAfterMs(model.provider);
        skipped.push({
          modelId: model.id,
          provider: model.provider,
          reason: 'circuit-open',
          detail: `provider "${model.provider}" is circuit-broken after repeated failures`,
          retryAfterMs,
        });
        continue;
      }

      // The budget counts invocations, not positions: a candidate the breaker
      // suppressed never reached a provider and must not consume the run's
      // allowance to actually try something.
      if (attempts.length >= budget) {
        skipped.push({
          modelId: model.id,
          provider: model.provider,
          reason: 'attempt-budget',
          detail: `not tried: the run's attempt budget of ${budget} was already spent`,
        });
        continue;
      }

      const startedAtMs = this.#clock();
      const context: InvocationContext = { attemptIndex: attempts.length };
      if (request.signal) context.signal = request.signal;

      let result: InvocationResult<T>;
      try {
        result = await invoke(model, context);
      } catch (error) {
        // The one path that could lose an attempt. It does not.
        result = { outcome: 'provider-error', note: clip(messageOf(error), MAX_NOTE_CHARS) };
      }

      // An adapter reporting success with nothing to show for it is a bug in the
      // adapter, and recording it as `ok` would put a lie in the run log.
      const outcome: AttemptOutcome =
        result.outcome === 'ok' && result.output === undefined ? 'invalid-output' : result.outcome;
      const downgraded = outcome !== result.outcome;

      const attempt: ModelAttempt = {
        modelId: model.id,
        providerSlug: model.provider,
        outcome,
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Math.max(0, this.#clock() - startedAtMs),
      };
      if (result.promptTokens !== undefined) attempt.promptTokens = result.promptTokens;
      if (result.completionTokens !== undefined) attempt.completionTokens = result.completionTokens;
      if (result.costUsd !== undefined) attempt.costUsd = result.costUsd;
      const note = downgraded
        ? `adapter reported ok with no output${result.note ? `: ${result.note}` : ''}`
        : result.note;
      if (note !== undefined) attempt.note = clip(note, MAX_NOTE_CHARS);

      attempts.push(attempt);

      if (this.#breaker) {
        if (outcome === 'ok') this.#breaker.recordSuccess(model.provider);
        else if (PROVIDER_HEALTH_FAILURES.has(outcome)) this.#breaker.recordFailure(model.provider);
      }

      if (outcome === 'ok') {
        return {
          succeeded: true,
          output: result.output as T,
          model,
          attempts,
          skipped,
          ordering,
          cancelled: false,
        };
      }

      if (outcome === 'cancelled') {
        cancelled = true;
        break;
      }
    }

    return {
      succeeded: false,
      attempts,
      skipped,
      ordering,
      cancelled,
      failure: this.#describeFailure(request, attempts, skipped, cancelled),
    };
  }

  #planPinned(
    catalog: readonly ModelCandidate[],
    request: RouterRequest,
    attempts: ModelAttempt[],
    now: number,
  ): { ordered: ModelCandidate[]; ordering: OrderingReport; failure?: ProtocolError } {
    const ordering: OrderingReport = {
      policy: 'pinned',
      candidatesConsidered: catalog.length,
      candidatesEligible: 0,
      order: [],
    };

    if (!request.pinnedModelId) {
      return {
        ordered: [],
        ordering,
        failure: {
          code: 'invalid_request',
          message: "routing policy 'pinned' requires pinnedModelId",
          remedy: 'name the model to pin, or choose another routing policy',
        },
      };
    }

    const model = catalog.find((candidate) => candidate.id === request.pinnedModelId);
    if (!model) {
      return {
        ordered: [],
        ordering,
        failure: {
          code: 'provider_unconfigured',
          message: `pinned model "${clip(request.pinnedModelId, 200)}" is not in the candidate list`,
          remedy: 'the model may have been withdrawn from the catalog; pin another or unpin to allow fallback',
        },
      };
    }

    // A pinned model that fails the capability filter is recorded as a real
    // attempt with a zero duration. It is the one case where a model the user
    // named did not run, and the run log has to show that rather than an empty
    // list — the unpinned path filters silently because recording hundreds of
    // never-considered models would drown the signal.
    const check = meetsRequirements(model, request.requirements);
    if (!check.ok) {
      attempts.push({
        modelId: model.id,
        providerSlug: model.provider,
        outcome: check.outcome,
        startedAt: new Date(now).toISOString(),
        durationMs: 0,
        note: clip(`not invoked: ${check.detail}`, MAX_NOTE_CHARS),
      });
      return {
        ordered: [],
        ordering,
        failure: {
          code: 'provider_unconfigured',
          message: `pinned model "${model.id}" ${check.detail}`,
          remedy: 'unpin to allow fallback, or pin a model that meets this run’s requirements',
        },
      };
    }

    ordering.candidatesEligible = 1;
    ordering.order = [model.id];
    return { ordered: [model], ordering };
  }

  #planFallback(
    catalog: readonly ModelCandidate[],
    request: RouterRequest,
    now: number,
  ): { ordered: ModelCandidate[]; ordering: OrderingReport; failure?: ProtocolError } {
    const eligible = catalog.filter((model) => meetsRequirements(model, request.requirements).ok);
    const { ordered, note } = orderCandidates(eligible, request.policy, now);

    const ordering: OrderingReport = {
      policy: request.policy,
      candidatesConsidered: catalog.length,
      candidatesEligible: eligible.length,
      order: ordered.map((model) => model.id),
    };
    if (note !== undefined) ordering.note = note;

    if (ordered.length === 0) {
      return {
        ordered,
        ordering,
        failure: {
          code: 'provider_unconfigured',
          message:
            catalog.length === 0
              ? 'no models were offered to the router'
              : `none of the ${catalog.length} available models meet this run’s requirements`,
          remedy: 'configure a provider key, start a local model, or relax the run requirements',
        },
      };
    }

    return { ordered, ordering };
  }

  #describeFailure(
    request: RouterRequest,
    attempts: ModelAttempt[],
    skipped: SkippedCandidate[],
    cancelled: boolean,
  ): ProtocolError {
    if (cancelled) {
      return { code: 'invalid_request', message: 'the run was cancelled before a model produced output' };
    }

    if (attempts.length === 0) {
      const circuitOpen = skipped.filter((entry) => entry.reason === 'circuit-open');
      if (circuitOpen.length > 0) {
        const soonest = circuitOpen.reduce(
          (min, entry) => Math.min(min, entry.retryAfterMs ?? 0),
          Number.POSITIVE_INFINITY,
        );
        return {
          code: 'provider_unconfigured',
          message: `every candidate provider is circuit-broken (${circuitOpen.length} suppressed)`,
          remedy: `retry in about ${Math.ceil(soonest / 1000)}s, or add a provider that is not currently failing`,
        };
      }
      return { code: 'provider_unconfigured', message: 'no model was attempted' };
    }

    const allRateLimited = attempts.every((attempt) => attempt.outcome === 'rate-limited');
    if (allRateLimited) {
      return {
        code: 'rate_limited',
        message: `every model tried was rate limited: ${attemptSummary(attempts)}`,
        remedy: 'wait and retry, or add a paid provider so the router has somewhere to fall back to',
      };
    }

    return {
      code: 'provider_unconfigured',
      message: `no model produced usable output: ${clip(attemptSummary(attempts), 400)}`,
      remedy:
        request.policy === 'pinned'
          ? 'unpin the model to allow fallback'
          : 'check provider health, or widen the model selection',
    };
  }
}
