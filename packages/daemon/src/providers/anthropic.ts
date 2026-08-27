import {
  ModelClientError,
  type CompletionEvent,
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type ModelMessage,
  type ModelToolCall,
  type ModelUsage,
  type SecretRef,
  type SecretsPort,
} from '@forgebridge/core';
import { outcomeForStatus, readServerSentEvents, retryAfterFrom } from '../openrouter.js';
import type { RunModelClient } from '../wire.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  asArray,
  asNumber,
  asRecord,
  asString,
  clip,
  providerMessage,
  transportFailure,
  type ProviderSpec,
} from './openai-compatible.js';

/**
 * Strip trailing `/` in linear time.
 *
 * `replace(/\/+$/, '')` stood here and reads better, but `\/+$` is the textbook
 * polynomial-ReDoS shape — on a long run of slashes the engine backtracks
 * O(n^2), which is what CodeQL's `js/polynomial-redos` fires on. A base URL is a
 * caller-supplied string, so the loop is the honest answer rather than an
 * argument about who would ever pass one. Local to this file on purpose: it is
 * three lines, and a shared utility package for it would cross a boundary
 * `verify-boundaries.ts` is right to keep closed.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  // 47 is `/`. charCodeAt keeps this a scan, with no allocation per character.
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}


/**
 * The Anthropic adapter (M22) — and the reason it is a file of its own.
 *
 * **The Messages API is not OpenAI-compatible, and this does not pretend it is.**
 * Every difference below is a real difference, verified against Anthropic's own
 * documentation rather than assumed from the shape of the other providers:
 *
 *   - the credential goes in `x-api-key`, not `Authorization: Bearer`, and an
 *     `anthropic-version` header is required;
 *   - `max_tokens` is a **required** request field, where OpenAI's `max_tokens`
 *     is optional (see `DEFAULT_MAX_OUTPUT_TOKENS` for what that forces);
 *   - the system prompt is a top-level `system` field, not a message with
 *     `role: "system"`, and the remaining messages must alternate roles;
 *   - a tool is `{ name, description, input_schema }`, not
 *     `{ type: "function", function: { … } }`;
 *   - the answer is a `content` array of typed blocks (`text`, `tool_use`), not
 *     `choices[0].message`, and a tool call's arguments arrive as a parsed
 *     object rather than as JSON text;
 *   - generation stops with a `stop_reason`, whose vocabulary is its own;
 *   - usage is `input_tokens` / `output_tokens`, and no cost is reported;
 *   - the stream is a typed event stream (`message_start`, `content_block_delta`,
 *     …), not OpenAI's chunk-with-deltas, and it has no `[DONE]` sentinel.
 *
 * Documentation this was written against:
 *   - https://platform.claude.com/docs/en/api/messages
 *   - https://platform.claude.com/docs/en/build-with-claude/streaming
 *
 * **Classification is still by HTTP status only.** `outcomeForStatus` is shared
 * with every other adapter here. Anthropic documents 529 `overloaded_error` as
 * its own status, and it lands where the shared table puts anything it does not
 * recognise: `provider-error`, which is the outcome that says "we know only what
 * the status said". An error that arrives *inside* a stream has no status at
 * all, and is not promoted to something more specific by reading its `type` —
 * see `#streamError`.
 *
 * **It never holds the credential.** Read through the `SecretsPort` once per
 * request, into one local variable, for the length of one `fetch`.
 */

export const ANTHROPIC_PROVIDER = 'anthropic';

/** The documented API root. Messages hang off `/v1/messages`. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * The API version every request must name. Anthropic's versioning is a header,
 * not a URL segment, and a request without it is rejected.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

export const ANTHROPIC_SPEC: ProviderSpec = {
  provider: ANTHROPIC_PROVIDER,
  label: 'Anthropic',
  baseUrl: ANTHROPIC_BASE_URL,
  docsUrl: 'https://platform.claude.com/docs/en/api/messages',
  wellKnownEnvVar: 'ANTHROPIC_API_KEY',
  note:
    'Not OpenAI-compatible: /v1/messages, x-api-key + anthropic-version headers, required '
    + 'max_tokens, top-level system, typed content blocks, and its own streaming event names.',
};

export const ANTHROPIC_SECRET_REF: SecretRef = { scope: 'provider', name: ANTHROPIC_PROVIDER };

/**
 * What `max_tokens` becomes when the caller did not ask for one.
 *
 * The port's `maxOutputTokens` is optional and Anthropic's `max_tokens` is
 * required, so this adapter must supply a number — and it has none to compute
 * from. `ModelCandidate` carries `contextTokens` but not a per-model output
 * ceiling, so there is nothing here that knows what this model's maximum is.
 * 4096 is therefore a deliberately conservative floor, not a ceiling derived
 * from anything: it is small enough to be uncontroversial and large enough for a
 * ChangeSet, and a caller who needs more says so through `maxOutputTokens`.
 *
 * TODO(M22): the registry already records `maxCompletionTokens` per model
 * (`CatalogModel` in `@forgebridge/model-registry`) and `ModelCandidate` drops
 * it, so the router hands adapters a model whose output ceiling it knows and
 * does not pass on. Carrying it onto the candidate would let this be the model's
 * own limit rather than a constant. Owner: `packages/core/src/router.ts` plus
 * `candidateFor` in `../models.ts`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const MAX_PROVIDER_MESSAGE_CHARS = 300;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AnthropicOptions {
  secrets: SecretsPort;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Overridden only by a caller that has verified a different version string. */
  apiVersion?: string;
}

export class AnthropicClient implements RunModelClient {
  readonly spec: ProviderSpec = ANTHROPIC_SPEC;
  readonly providers: readonly string[] = [ANTHROPIC_PROVIDER];

  readonly #secrets: SecretsPort;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #apiVersion: string;

  constructor(options: AnthropicOptions) {
    this.#secrets = options.secrets;
    this.#baseUrl = withoutTrailingSlashes(options.baseUrl ?? ANTHROPIC_BASE_URL);
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#apiVersion = options.apiVersion ?? ANTHROPIC_VERSION;
  }

  async configured(): Promise<boolean> {
    return (await this.#secrets.get(ANTHROPIC_SECRET_REF)) !== null;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.#post(request, false);
    const envelope = asRecord(await this.#json(response));
    this.#throwIfErrorEnvelope(envelope);
    return readMessage(envelope);
  }

  /**
   * Streamed generation over Anthropic's typed event stream.
   *
   * Two things this does not do. It does not reconstruct usage or a stop reason
   * from what it saw — both are read from the events that report them, and an
   * absent one stays absent. And it does not announce a tool call until its
   * block closes: the arguments arrive as `input_json_delta` fragments that are
   * not JSON until the last one lands.
   */
  async *stream(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const response = await this.#post(request, true);
    const body = response.body;
    if (!body) {
      throw new ModelClientError('provider-error', 'Anthropic returned a streaming response with no body');
    }

    let text = '';
    let stopReason: FinishReason | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    /** Open `tool_use` blocks by content-block index, in arrival order. */
    const open = new Map<number, { id?: string; name: string; partial: string; seed: string }>();
    const finished: ModelToolCall[] = [];

    for await (const payload of readServerSentEvents(body, request.signal)) {
      const event = asRecord(payload);
      const type = asString(event['type']);

      // An error can arrive as an event in the middle of an otherwise healthy
      // stream. Unchecked, the stream simply ends and the half-written answer
      // is reported as the whole one.
      if (type === 'error') throw this.#streamError(event);
      if (type === 'ping') continue;

      if (type === 'message_start') {
        const usage = asRecord(asRecord(event['message'])['usage']);
        const input = asNumber(usage['input_tokens']);
        if (input !== null && input >= 0) promptTokens = Math.trunc(input);
        continue;
      }

      if (type === 'content_block_start') {
        const index = asNumber(event['index']) ?? 0;
        const block = asRecord(event['content_block']);
        if (asString(block['type']) === 'tool_use') {
          const id = asString(block['id']);
          open.set(index, {
            ...(id ? { id } : {}),
            name: asString(block['name']) ?? '',
            partial: '',
            // What the provider already sent as the input, so a tool call with
            // no streamed fragments is `{}` — the provider's value — rather than
            // an empty string this adapter made up.
            seed: JSON.stringify(asRecord(block['input'])),
          });
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const index = asNumber(event['index']) ?? 0;
        const delta = asRecord(event['delta']);
        const deltaType = asString(delta['type']);
        if (deltaType === 'text_delta') {
          const chunk = asString(delta['text']);
          if (chunk) {
            text += chunk;
            yield { type: 'text', delta: chunk };
          }
        } else if (deltaType === 'input_json_delta') {
          const call = open.get(index);
          if (call) call.partial += asString(delta['partial_json']) ?? '';
        }
        // Any other delta type — thinking, and whatever versioning adds next —
        // is not part of the answer this port carries, and is skipped rather
        // than guessed at.
        continue;
      }

      if (type === 'content_block_stop') {
        const index = asNumber(event['index']) ?? 0;
        const call = open.get(index);
        if (call) {
          open.delete(index);
          finished.push({
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            // Raw text, unparsed and unrepaired — `ModelToolCall` requires it.
            arguments: call.partial.length > 0 ? call.partial : call.seed,
          });
        }
        continue;
      }

      if (type === 'message_delta') {
        const reason = readStopReason(asRecord(event['delta'])['stop_reason']);
        if (reason !== null) stopReason = reason;
        // Documented as cumulative, so the last one seen is the total rather
        // than a term in a sum.
        const output = asNumber(asRecord(event['usage'])['output_tokens']);
        if (output !== null && output >= 0) completionTokens = Math.trunc(output);
        continue;
      }
      // `message_stop` needs nothing done; unknown event types are ignored,
      // which is what Anthropic's versioning policy asks of a client.
    }

    for (const call of finished) yield { type: 'tool-call', call };

    const completion: CompletionResponse = {
      text,
      finishReason: stopReason ?? 'other',
    };
    if (finished.length > 0) completion.toolCalls = finished;
    const usage = assembleUsage(promptTokens, completionTokens);
    if (usage) completion.usage = usage;
    yield { type: 'done', response: completion };
  }

  async #post(request: CompletionRequest, stream: boolean): Promise<Response> {
    const value = await this.#secrets.get(ANTHROPIC_SECRET_REF);
    if (value === null) {
      throw new ModelClientError(
        'provider-error',
        'no Anthropic credential is configured for this daemon',
      );
    }

    const headers: Record<string, string> = {
      'x-api-key': value,
      'anthropic-version': this.#apiVersion,
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    };

    const signals: AbortSignal[] = [AbortSignal.timeout(this.#timeoutMs)];
    if (request.signal) signals.push(request.signal);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(messagesBody(request, stream)),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw transportFailure(error, request.signal, 'Anthropic');
    }

    if (!response.ok) throw await this.#httpFailure(response);
    return response;
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new ModelClientError('invalid-output', 'Anthropic did not return JSON', { cause: error });
    }
  }

  async #httpFailure(response: Response): Promise<ModelClientError> {
    let detail = '';
    try {
      detail = providerMessage(await response.text());
    } catch {
      // Unreadable body; the status has already said everything we know.
    }
    const outcome = outcomeForStatus(response.status);
    const retryAfterMs = retryAfterFrom(response.headers.get('retry-after'));
    const message = `Anthropic answered ${response.status}${detail ? `: ${detail}` : ''}`;
    return new ModelClientError(outcome, message, retryAfterMs === null ? {} : { retryAfterMs });
  }

  /**
   * An error the API sent on a 200, either as the whole body or as a stream
   * event.
   *
   * It is always `provider-error`. Anthropic's error `type` is a documented
   * enumeration, not free prose — but the rule is that an outcome comes from an
   * HTTP status, and a stream frame has none. Translating `overloaded_error`
   * into `rate-limited` because the docs say it corresponds to a 529 in a
   * non-streaming context would be deciding an outcome from a payload string;
   * the type is carried in the message instead, where a human reads it.
   */
  #streamError(event: Record<string, unknown>): ModelClientError {
    const error = asRecord(event['error']);
    const kind = asString(error['type']) ?? 'error';
    const message = asString(error['message']) ?? JSON.stringify(event['error'] ?? {});
    return new ModelClientError(
      'provider-error',
      `Anthropic sent ${kind} mid-stream: ${clip(message, MAX_PROVIDER_MESSAGE_CHARS)}`,
    );
  }

  /**
   * An error returned on a 200 — either as `{"type":"error", …}` or as an
   * `error` member on an otherwise ordinary body.
   *
   * A *present but null* `error` is absence, not a failure. That is the
   * legitimate shape this check is most confusable with, and treating it as an
   * error would turn a perfectly good answer into a failed attempt.
   */
  #throwIfErrorEnvelope(envelope: Record<string, unknown>): void {
    const error = envelope['error'];
    if (asString(envelope['type']) !== 'error' && (error === undefined || error === null)) return;
    throw this.#streamError(envelope);
  }
}

/**
 * The Messages request body.
 *
 * Two transformations happen here and both are lossy in a way worth stating.
 *
 * `system` messages are hoisted out of the conversation into the top-level
 * `system` field and joined with a blank line, because the Messages API has no
 * `system` role in `messages`. A system instruction the caller placed *after* a
 * user turn therefore moves to the front. The core sends its system prompt
 * first, so this is a faithful translation of what it actually sends rather
 * than of everything the port's type permits.
 *
 * Consecutive same-role messages are merged, because the API requires the roles
 * in `messages` to alternate and rejects a request whose roles do not — the
 * merge keeps every word, joined with a blank line, rather than dropping a turn.
 */
export function messagesBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const turns = alternating(request.messages.filter((message) => message.role !== 'system'));
  if (turns.length === 0) {
    throw new ModelClientError(
      'provider-error',
      'the request carried no user or assistant message, and Anthropic requires at least one',
    );
  }

  const capabilities = new Set(request.model.capabilities);
  const body: Record<string, unknown> = {
    model: request.model.id,
    // Required by the API. See DEFAULT_MAX_OUTPUT_TOKENS for why this is a
    // constant rather than something derived from the model.
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages: turns,
  };
  if (system.length > 0) body['system'] = system;
  if (stream) body['stream'] = true;

  if (request.tools && request.tools.length > 0 && capabilities.has('tools')) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Anthropic's name for the same JSON Schema OpenAI calls `parameters`.
      input_schema: tool.parameters,
    }));
    // No `tool_choice`, for the reason `chatCompletionBody` gives: the core
    // reads a ChangeSet out of a plain JSON body just as happily as out of a
    // tool call, so forcing the call buys nothing.
  }

  // `responseFormat: 'json'` is advisory (see `ports/model.ts`) and is ignored
  // here rather than translated. The Messages API has no `response_format`
  // field; its structured-output surface is a different, versioned parameter
  // this adapter has not verified, and sending an invented one would turn a
  // model that would have answered into a 400.
  //
  // TODO(M22): wire Anthropic structured outputs once the parameter and its
  // model support have been read from the documentation rather than assumed.

  // Sent only when the caller asked. Anthropic's newest models reject sampling
  // parameters outright, which arrives as a 400 and is recorded as
  // `provider-error` with the provider's own explanation attached — a true
  // record of what happened, and the reason this is not sent by default.
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  return body;
}

/** Merge consecutive same-role turns so the roles in `messages` alternate. */
function alternating(messages: readonly ModelMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`;
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

/** A whole non-streamed Message, read defensively out of unknown JSON. */
export function readMessage(envelope: Record<string, unknown>): CompletionResponse {
  let text = '';
  const toolCalls: ModelToolCall[] = [];

  for (const raw of asArray(envelope['content'])) {
    const block = asRecord(raw);
    const type = asString(block['type']);
    if (type === 'text') {
      text += asString(block['text']) ?? '';
    } else if (type === 'tool_use') {
      const id = asString(block['id']);
      toolCalls.push({
        ...(id ? { id } : {}),
        name: asString(block['name']) ?? '',
        // The port carries arguments as raw JSON *text*, and Anthropic sends a
        // parsed object — so unlike every other adapter here, this string is
        // this adapter's serialisation rather than the model's own bytes. It is
        // re-serialised once, never repaired: the protocol's schema still does
        // the parsing, and a set that had to be patched first is a set no test
        // covers.
        arguments: JSON.stringify(block['input'] ?? {}),
      });
    }
    // Other block types (thinking, and whatever is added next) carry nothing
    // this port can represent, and are skipped rather than flattened into text.
  }

  const response: CompletionResponse = {
    text,
    finishReason: readStopReason(envelope['stop_reason']) ?? 'other',
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;

  const usage = asRecord(envelope['usage']);
  const assembled = assembleUsage(
    asNumber(usage['input_tokens']),
    asNumber(usage['output_tokens']),
  );
  if (assembled) response.usage = assembled;
  return response;
}

/**
 * Anthropic's vocabulary for why generation stopped, mapped onto the port's.
 *
 * An unrecognised value is `other`, never `stop`: "we do not know why it
 * stopped" and "it finished" are different facts in a run log, and Anthropic's
 * versioning policy says new values may appear.
 */
export function readStopReason(raw: unknown): FinishReason | null {
  switch (asString(raw)) {
    case 'end_turn':
      return 'stop';
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case 'refusal':
      return 'refusal';
    case null:
      return null;
    default:
      return 'other';
  }
}

/**
 * Usage as the provider reported it, and only as it reported it. No cost:
 * Anthropic does not return one, and multiplying a catalog price by a token
 * count would put a number in the run log that nobody charged.
 */
function assembleUsage(promptTokens: number | null, completionTokens: number | null): ModelUsage | undefined {
  const usage: ModelUsage = {};
  if (promptTokens !== null && promptTokens >= 0) usage.promptTokens = Math.trunc(promptTokens);
  if (completionTokens !== null && completionTokens >= 0) {
    usage.completionTokens = Math.trunc(completionTokens);
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
