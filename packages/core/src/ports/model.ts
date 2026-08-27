import type { AttemptOutcome } from '@forgebridge/protocol';
import type { ModelCandidate } from '../router.js';

/**
 * Model port — the only way `packages/core` reaches a language model.
 *
 * Nothing in this file names a vendor, and nothing in it is shaped like one:
 * no `messages[].content` array of parts, no `tool_choice`, no provider ids.
 * The reason is B2 in `scripts/verify-boundaries.ts` and ADR-005/011 behind it
 * — an adapter package owns the HTTP, the retries, and the vocabulary of one
 * vendor, so that self-hosting against a different one is a new adapter rather
 * than a fork of the engine.
 *
 * The request carries the whole `ModelCandidate` the router chose rather than a
 * bare id: an adapter needs `contextTokens` to decide what it can send and
 * `provider` to decide where to send it, and re-deriving those from a string
 * would mean a second lookup table that can disagree with the router's.
 */

/** Everything a model can be told, in the two roles the core actually uses. */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A tool offered to the model. `parameters` is JSON Schema as an opaque object:
 * the core does not interpret it, and an adapter passes it through.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  model: ModelCandidate;
  messages: readonly ModelMessage[];
  tools?: readonly ToolDefinition[];
  /**
   * Advisory. An adapter whose provider has no JSON mode ignores it — which is
   * why the core parses the response defensively either way and treats a
   * failure to parse as `invalid-output` rather than as an adapter bug.
   */
  responseFormat?: 'text' | 'json';
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * A tool call as the model emitted it. `arguments` is the raw JSON *text*,
 * unparsed and unrepaired: the core parses it through the protocol's own schema
 * and a set it had to patch first is a set no test covers.
 */
export interface ModelToolCall {
  id?: string;
  name: string;
  arguments: string;
}

/** Zero-cost is reported as zero, not omitted — a free model has a real spend of 0. */
export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}

/**
 * Why generation stopped. `length` is called out because a truncated JSON
 * document parses as malformed, and "the model wrote nonsense" and "we cut the
 * model off" are different facts to put in a run log.
 */
export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'refusal' | 'other';

export interface CompletionResponse {
  text: string;
  toolCalls?: readonly ModelToolCall[];
  usage?: ModelUsage;
  finishReason: FinishReason;
}

/**
 * One event from a streaming completion.
 *
 * The stream must end with `done`, carrying the same response `complete` would
 * have returned. Nothing reconstructs a response from the deltas it happened to
 * see: usage and finish reason are facts the provider reports, and assembling a
 * plausible-looking one from fragments would be inventing them.
 */
export type CompletionEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'done'; response: CompletionResponse };

export interface ModelClient {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /**
   * Optional, and preferred where a provider supports it: the run driver uses
   * `stream` when an adapter implements it, so a caller watching a run sees
   * output as it arrives instead of after it stops.
   */
  stream?(request: CompletionRequest): AsyncIterable<CompletionEvent>;
}

/** Everything that is not success. `ok` is excluded because a failure is not one. */
export type ModelFailure = Exclude<AttemptOutcome, 'ok'>;

/**
 * The error an adapter throws, carrying its own classification.
 *
 * The classification belongs to the adapter and to nobody else: only the code
 * holding the HTTP response knows whether a 429 was a rate limit or a quota,
 * and the alternative — the core sniffing error strings — is how a router ends
 * up falling back for the wrong reason and recording it as the wrong outcome
 * (ADR-008).
 */
export class ModelClientError extends Error {
  readonly outcome: ModelFailure;
  readonly retryAfterMs: number | undefined;

  constructor(
    outcome: ModelFailure,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelClientError';
    this.outcome = outcome;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * What to record for a thrown error.
 *
 * An unclassified throw is `provider-error` and never something more specific:
 * guessing `rate-limited` from a message would open the circuit breaker on a
 * provider that was fine (see PROVIDER_HEALTH_FAILURES in router.ts).
 */
export function outcomeOf(error: unknown): ModelFailure {
  if (error instanceof ModelClientError) return error.outcome;
  // Both spellings of "the AbortSignal fired" that the platform produces.
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return error.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  }
  return 'provider-error';
}
