import {
  ModelClientError,
  type CompletionEvent,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type ModelToolCall,
  type ModelUsage,
  type SecretRef,
  type SecretsPort,
} from '@forgebridge/core';
import type { RunModelClient } from './wire.js';

/**
 * The OpenRouter adapter — one vendor's HTTP, held outside the engine.
 *
 * It lives in the daemon rather than in `packages/core` because B2 in
 * `scripts/verify-boundaries.ts` forbids the core naming a vendor at all, and
 * the reason behind that rule is ADR-005/011: self-hosting against a different
 * provider has to be a second adapter, not a fork of the pipeline. Everything
 * OpenRouter-shaped is therefore in this file — the URL, the header, the
 * OpenAI-compatible request body, the SSE framing, and the mapping from an HTTP
 * status onto the protocol's `AttemptOutcome`.
 *
 * Three things it will not do:
 *
 *   - It never logs, returns, or persists the credential. It takes a
 *     `SecretsPort` rather than a string so there is no field on this object
 *     holding a key between calls, and every error it raises is built from a
 *     status code and the provider's own message, never from the request it
 *     sent. `scripts/verify-no-key-storage.ts` is the gate; this is the intent
 *     the gate exists to keep true.
 *   - It never guesses an outcome from an error string. The classification is
 *     the adapter's job (ADR-008, `ports/model.ts`), and it is made from the
 *     HTTP status — the one thing the provider states unambiguously. A 429 is
 *     `rate-limited`; anything the status does not settle is `provider-error`,
 *     which is the outcome that says "we do not know more than that".
 *   - It never repairs the model's output. A tool call's arguments cross this
 *     boundary as the raw JSON text the provider sent, and the core parses it
 *     through the protocol's own schema.
 */

export const OPENROUTER_PROVIDER = 'openrouter';

/** The OpenAI-compatible root. Chat completions hang off `/chat/completions`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Where the credential is looked up. `provider` scope, the provider's own slug. */
export const OPENROUTER_SECRET_REF: SecretRef = { scope: 'provider', name: OPENROUTER_PROVIDER };

/**
 * A generation can legitimately take minutes on a large model, and a timeout
 * that fires under a slow-but-working provider is recorded as a `timeout`
 * attempt and moves the router on — so this is deliberately generous. The
 * caller's own `AbortSignal` is what a user-facing cancel rides on.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

/** Bounds the provider's own error text before it becomes a `ModelAttempt.note`. */
const MAX_PROVIDER_MESSAGE_CHARS = 300;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterOptions {
  /** The only route to the credential. Read once per request, never held. */
  secrets: SecretsPort;
  /** Overridden by tests and by an OpenAI-compatible gateway that is not OpenRouter. */
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /**
   * OpenRouter's optional attribution headers. Absent by default: sending a
   * referring URL the operator did not ask us to send is telling a third party
   * something about them for our benefit.
   */
  appUrl?: string;
  appTitle?: string;
}

export class OpenRouterClient implements RunModelClient {
  /**
   * The provider slugs this client can reach. The run route filters the
   * candidate list by it, so a catalog entry served by somebody else is never
   * handed to this adapter and recorded as its failure.
   */
  readonly providers: readonly string[] = [OPENROUTER_PROVIDER];

  readonly #secrets: SecretsPort;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #appUrl: string | undefined;
  readonly #appTitle: string | undefined;

  constructor(options: OpenRouterOptions) {
    this.#secrets = options.secrets;
    this.#baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#appUrl = options.appUrl;
    this.#appTitle = options.appTitle;
  }

  /**
   * Whether a credential is reachable at all.
   *
   * Asked before a run starts so the daemon can answer `provider_unconfigured`
   * with something to do about it, rather than starting a run that will produce
   * one `provider-error` attempt per candidate and open the circuit breaker on
   * a provider that was never the problem.
   */
  async configured(): Promise<boolean> {
    return (await this.#secrets.get(OPENROUTER_SECRET_REF)) !== null;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.#post(request, false);
    const envelope = asRecord(await this.#json(response));
    throwIfErrorEnvelope(envelope);
    return readCompletion(envelope);
  }

  /**
   * Streamed generation, preferred by the run driver so a watcher sees output
   * arriving rather than a gap.
   *
   * `done` is assembled here, from every chunk this adapter read — not from the
   * deltas a caller happened to observe, which is the distinction
   * `ports/model.ts` draws. Where the provider never reported a fact, the
   * assembled response omits it: no usage is omitted usage, and a stream that
   * ended without a `finish_reason` is `other`, not `stop`.
   */
  async *stream(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const response = await this.#post(request, true);
    const body = response.body;
    if (!body) {
      throw new ModelClientError('provider-error', 'the provider returned a streaming response with no body');
    }

    let text = '';
    let refusal = '';
    let finishReason: FinishReason | null = null;
    let usage: ModelUsage | undefined;
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();

    for await (const payload of readServerSentEvents(body, request.signal)) {
      const chunk = asRecord(payload);
      // OpenRouter reports a mid-stream failure as an `error` member on a chunk
      // rather than by breaking the connection, so a stream that is not checked
      // for one ends "successfully" with half an answer.
      throwIfErrorEnvelope(chunk);

      const chunkUsage = readUsage(chunk);
      if (chunkUsage) usage = chunkUsage;

      const choice = asRecord(asArray(chunk['choices'])[0]);
      const reason = readFinishReason(choice['finish_reason']);
      if (reason !== null) finishReason = reason;

      const delta = asRecord(choice['delta']);
      const content = asString(delta['content']);
      if (content) {
        text += content;
        yield { type: 'text', delta: content };
      }
      const declined = asString(delta['refusal']);
      if (declined) refusal += declined;

      for (const raw of asArray(delta['tool_calls'])) {
        const entry = asRecord(raw);
        const index = asNumber(entry['index']) ?? 0;
        const fn = asRecord(entry['function']);
        const existing = calls.get(index) ?? { name: '', arguments: '' };
        const id = asString(entry['id']);
        if (id) existing.id = id;
        const name = asString(fn['name']);
        if (name) existing.name = name;
        existing.arguments += asString(fn['arguments']) ?? '';
        calls.set(index, existing);
      }
    }

    // Tool calls are announced once, complete. A `tool-call` event carrying a
    // half-streamed argument string would be an event whose payload is not
    // JSON, and the one thing this adapter must not hand upwards is a value the
    // protocol's parser would have to be lenient about.
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ ...(call.id ? { id: call.id } : {}), name: call.name, arguments: call.arguments }));
    for (const call of toolCalls) yield { type: 'tool-call', call };

    const completion: CompletionResponse = {
      text: refusal.length > 0 ? refusal : text,
      finishReason: refusal.length > 0 ? 'refusal' : (finishReason ?? 'other'),
    };
    if (toolCalls.length > 0) completion.toolCalls = toolCalls;
    if (usage) completion.usage = usage;
    yield { type: 'done', response: completion };
  }

  async #post(request: CompletionRequest, stream: boolean): Promise<Response> {
    const value = await this.#secrets.get(OPENROUTER_SECRET_REF);
    if (value === null) {
      throw new ModelClientError(
        'provider-error',
        'no OpenRouter credential is configured for this daemon',
      );
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${value}`,
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (this.#appUrl) headers['http-referer'] = this.#appUrl;
    if (this.#appTitle) headers['x-title'] = this.#appTitle;

    const signals: AbortSignal[] = [AbortSignal.timeout(this.#timeoutMs)];
    if (request.signal) signals.push(request.signal);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(chatCompletionBody(request, stream)),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw transportFailure(error, request.signal);
    }

    if (!response.ok) throw await this.#httpFailure(response);
    return response;
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new ModelClientError('invalid-output', 'the provider did not return JSON', { cause: error });
    }
  }

  /**
   * Turn a non-2xx into a classified failure.
   *
   * The classification comes from the status and nothing else. The body is read
   * only for the human-facing message, and the message is clipped: it ends up
   * on a `ModelAttempt.note`, which the protocol caps at 500 characters, and an
   * unbounded string from a third party deciding the size of our record is the
   * shape of a resource bug rather than a formatting one.
   */
  async #httpFailure(response: Response): Promise<ModelClientError> {
    let detail = '';
    try {
      detail = providerMessage(await response.text());
    } catch {
      // A body we could not read tells us nothing the status has not already
      // said. It is not worth failing differently over.
    }

    const outcome = outcomeForStatus(response.status);
    const retryAfterMs = retryAfterFrom(response.headers.get('retry-after'));
    const message = `OpenRouter answered ${response.status}${detail ? `: ${detail}` : ''}`;
    return new ModelClientError(outcome, message, retryAfterMs === null ? {} : { retryAfterMs });
  }
}

/**
 * The OpenAI-compatible request body.
 *
 * Two parameters are sent only when the candidate's own capability list says
 * the model takes them. The registry records those capabilities from the
 * provider's `supported_parameters` (see `scripts/sync-catalog.ts`), so this is
 * a fact about the model rather than a hope — and sending `tools` to a model
 * that does not do tool calling turns a model that would have answered in plain
 * JSON into a 400.
 */
export function chatCompletionBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
  const capabilities = new Set(request.model.capabilities);
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  };
  if (stream) body['stream'] = true;

  if (request.tools && request.tools.length > 0 && capabilities.has('tools')) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    // No `tool_choice`. Forcing the call would need the `tool_choice`
    // capability, which is a separate entry in the registry's vocabulary and
    // which plenty of tool-calling models do not report — and the core reads a
    // ChangeSet out of a plain JSON body just as happily as out of a tool call,
    // so forcing buys nothing and costs the models that would 400 on it.
  }
  if (request.responseFormat === 'json' && capabilities.has('response_format')) {
    body['response_format'] = { type: 'json_object' };
  }
  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  return body;
}

/**
 * Status → outcome, and nothing else decides it.
 *
 * `context-exceeded` and `capability-missing` are deliberately absent: both are
 * routing facts the router already checks against the candidate's declared
 * context window and capabilities before a request is made, and recovering
 * either from a provider's prose would be exactly the error-string sniffing
 * ADR-008 forbids. A provider that refuses for one of those reasons is recorded
 * as `provider-error` with its own message attached, which is true.
 */
export function outcomeForStatus(status: number): 'rate-limited' | 'timeout' | 'provider-error' {
  if (status === 429) return 'rate-limited';
  if (status === 408 || status === 504) return 'timeout';
  return 'provider-error';
}

/** `Retry-After` in seconds, or as an HTTP date. Absent and unreadable are both null. */
export function retryAfterFrom(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** A thrown fetch, classified without reading its message. */
function transportFailure(error: unknown, callerSignal: AbortSignal | undefined): ModelClientError {
  if (callerSignal?.aborted) {
    return new ModelClientError('cancelled', 'the run was cancelled before the provider answered', { cause: error });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ModelClientError('timeout', 'the provider did not answer before the request timed out', { cause: error });
  }
  return new ModelClientError('provider-error', 'the provider could not be reached', { cause: error });
}

/**
 * OpenRouter reports a failure as `{ "error": { "code": …, "message": … } }`,
 * on a 200 as well as on an error status and mid-stream as well as at the end.
 * Left unchecked, the first of those reads as a completion with no choices.
 */
function throwIfErrorEnvelope(envelope: Record<string, unknown>): void {
  const error = envelope['error'];
  if (error === undefined || error === null) return;
  const record = asRecord(error);
  const message = asString(record['message']) ?? JSON.stringify(error);
  const status = asNumber(record['code']);
  throw new ModelClientError(
    status === null ? 'provider-error' : outcomeForStatus(status),
    `OpenRouter reported an error${status === null ? '' : ` (${status})`}: ${clip(message, MAX_PROVIDER_MESSAGE_CHARS)}`,
  );
}

/** The whole of a non-streamed answer, read defensively out of unknown JSON. */
export function readCompletion(envelope: Record<string, unknown>): CompletionResponse {
  const choice = asRecord(asArray(envelope['choices'])[0]);
  const message = asRecord(choice['message']);

  const toolCalls: ModelToolCall[] = asArray(message['tool_calls']).map((raw) => {
    const entry = asRecord(raw);
    const fn = asRecord(entry['function']);
    const id = asString(entry['id']);
    return {
      ...(id ? { id } : {}),
      name: asString(fn['name']) ?? '',
      // Raw text, unparsed and unrepaired — see the note on `ModelToolCall`.
      arguments: asString(fn['arguments']) ?? '',
    };
  });

  const refusal = asString(message['refusal']) ?? '';
  const finishReason = readFinishReason(choice['finish_reason']);

  const response: CompletionResponse = {
    text: refusal.length > 0 ? refusal : (asString(message['content']) ?? ''),
    finishReason: refusal.length > 0 ? 'refusal' : (finishReason ?? 'other'),
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;
  const usage = readUsage(envelope);
  if (usage) response.usage = usage;
  return response;
}

/**
 * The provider's own vocabulary for why generation stopped, mapped onto the
 * port's. An unrecognised value is `other` rather than `stop`: "we do not know
 * why it stopped" and "it finished" are different facts in a run log.
 */
export function readFinishReason(raw: unknown): FinishReason | null {
  switch (asString(raw)) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls': return 'tool-calls';
    case 'function_call': return 'tool-calls';
    case 'content_filter': return 'content-filter';
    case 'error': return 'other';
    case null: return null;
    default: return 'other';
  }
}

/**
 * Usage as the provider reported it, and only as the provider reported it.
 *
 * `costUsd` is read from `usage.cost` when it is there and omitted when it is
 * not. The alternative — multiplying the catalog's per-million prices by the
 * token counts — would put a number in the run log that nobody charged, which
 * is worse than an absent one for the only person who reads it: a self-hoster
 * reconciling their own spend.
 */
export function readUsage(envelope: Record<string, unknown>): ModelUsage | undefined {
  const raw = envelope['usage'];
  if (raw === undefined || raw === null) return undefined;
  const record = asRecord(raw);
  const usage: ModelUsage = {};
  const prompt = asNumber(record['prompt_tokens']);
  if (prompt !== null && prompt >= 0) usage.promptTokens = Math.trunc(prompt);
  const completion = asNumber(record['completion_tokens']);
  if (completion !== null && completion >= 0) usage.completionTokens = Math.trunc(completion);
  const cost = asNumber(record['cost']);
  if (cost !== null && cost >= 0) usage.costUsd = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * The `data:` payloads of a text/event-stream, as parsed JSON.
 *
 * Framing per the SSE format: lines, `data:` fields, `[DONE]` as the sentinel
 * OpenAI-compatible endpoints close on, and lines beginning with `:` ignored —
 * OpenRouter sends `: OPENROUTER PROCESSING` comments to hold a slow connection
 * open, and a reader that fed those to `JSON.parse` would fail on a keep-alive.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new ModelClientError('cancelled', 'the run was cancelled while the provider was streaming');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');

        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch (error) {
          throw new ModelClientError('invalid-output', 'the provider sent a stream frame that is not JSON', {
            cause: error,
          });
        }
      }
    }
  } finally {
    // Releasing the lock is not enough: an abandoned generator leaves the
    // connection open, and a daemon that leaks one socket per cancelled run
    // dies quietly an hour later.
    await reader.cancel().catch(() => {});
  }
}

/** The message inside an error body, or the body itself when it is not one. */
function providerMessage(body: string): string {
  try {
    const record = asRecord(JSON.parse(body));
    const error = asRecord(record['error']);
    const message = asString(error['message']) ?? asString(record['message']);
    if (message) return clip(message, MAX_PROVIDER_MESSAGE_CHARS);
  } catch {
    // Not JSON. The raw body is still the most informative thing available.
  }
  return clip(body.trim(), MAX_PROVIDER_MESSAGE_CHARS);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
