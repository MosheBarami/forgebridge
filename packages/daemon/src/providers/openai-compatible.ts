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
import {
  chatCompletionBody,
  outcomeForStatus,
  readCompletion,
  readFinishReason,
  readServerSentEvents,
  readUsage,
  retryAfterFrom,
} from '../openrouter.js';
import type { RunModelClient } from '../wire.js';

/**
 * One adapter for every provider that serves OpenAI's `/chat/completions` shape
 * (M22), and the reasons it is written this way.
 *
 * **It reuses the OpenRouter adapter's readers rather than copying them.**
 * `chatCompletionBody`, `readCompletion`, `readUsage`, `readFinishReason` and
 * `readServerSentEvents` are imported from `../openrouter.js` and are the same
 * functions that file runs. That import direction is backwards — a generic
 * module depending on a vendor-named one — and it is the deliberate lesser evil:
 * the alternative is a second copy of the OpenAI request and response mapping,
 * and two copies of a parser drift, silently, in opposite directions. The
 * fix is an extraction, not a fork.
 *
 * TODO(M22): move those readers from `packages/daemon/src/openrouter.ts` into
 * this file and leave `openrouter.ts` importing them, so the dependency points
 * the way the layering says it should. Owner: whoever owns `openrouter.ts` —
 * it is a move, not a rewrite, and the drift block in `test/providers.test.ts`
 * (same SSE bytes through both adapters, same assembled response) is the test
 * that must still pass afterwards.
 *
 * **It classifies by HTTP status and by nothing else.** `outcomeForStatus` is
 * imported for that reason too: one table, shared, so "429 is rate-limited" is a
 * single fact in this repository rather than eight copies of an opinion. The
 * ban on reading a provider's prose is ADR-008's, and the comment in
 * `openrouter.ts` explains what it costs and why it is still right.
 *
 * **It never holds a credential.** The key is read through the `SecretsPort` per
 * request and lives in one local variable for the length of one `fetch`. There
 * is no field on this object that could hold one, which is the shape
 * `scripts/verify-no-key-storage.ts` checks for.
 *
 * **It is not a claim that these providers are identical.** Every provider below
 * was checked against its own published documentation, and the differences that
 * survive are recorded on each `ProviderSpec`. Anthropic is not here at all: the
 * Messages API is a different protocol, so it gets `anthropic.ts` rather than a
 * pretence of compatibility.
 */

/** Bounds a provider's own error text before it becomes a `ModelAttempt.note` (capped at 500 by the protocol). */
const MAX_PROVIDER_MESSAGE_CHARS = 300;

/**
 * The same generous default `openrouter.ts` uses, for the same reason: a timeout
 * that fires under a slow-but-working provider is recorded as a `timeout`
 * attempt and moves the router on.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One provider's facts. Everything here was read from the provider's own
 * documentation — `docsUrl` is the page, so a reviewer can check the row rather
 * than trust it.
 */
export interface ProviderSpec {
  /** Router-facing provider id: keys the breaker, lands in `ModelAttempt.providerSlug`. */
  provider: string;
  /** Used in messages a human reads. */
  label: string;
  /** No trailing slash. `/chat/completions` is appended. */
  baseUrl: string;
  /** The page these fields were read from. */
  docsUrl: string;
  /**
   * The variable this provider's own tooling reads.
   *
   * Recorded so the daemon can tell a user which one to export. It is NOT yet
   * consulted: `WELL_KNOWN_VARIABLE_NAMES` in `../secrets.ts` lists only
   * `OPENROUTER_API_KEY`, so today the environment backend finds these keys
   * under `FORGEBRIDGE_PROVIDER_<SLUG>` and under nothing else.
   *
   * TODO(M22): add each of these to `WELL_KNOWN_VARIABLE_NAMES` so a user who
   * has already exported `OPENAI_API_KEY` does not have to export a second
   * variable saying the same thing. Owner: whoever owns `../secrets.ts`; this
   * field is the list to copy.
   */
  wellKnownEnvVar: string;
  /** Notes on where this provider is not OpenAI, when there is one worth carrying. */
  note?: string;
}

/** Where a provider's credential is looked up: `provider` scope, the provider's own slug. */
export function secretRefFor(spec: ProviderSpec): SecretRef {
  return { scope: 'provider', name: spec.provider };
}

/**
 * The direct OpenAI-compatible providers ADR-005's adapter set names, minus
 * Anthropic, which is not one.
 *
 * Each `baseUrl` is the documented root such that `${baseUrl}/chat/completions`
 * is the documented endpoint. Note DeepSeek: its documentation gives the base as
 * `https://api.deepseek.com` with the endpoint at `/chat/completions` — no `/v1`
 * segment — so the row carries what the docs carry rather than the `/v1` every
 * other row happens to have.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: readonly ProviderSpec[] = [
  {
    provider: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    wellKnownEnvVar: 'OPENAI_API_KEY',
    note:
      'OpenAI documents a newer Responses API alongside Chat Completions and publishes a migration '
      + 'guide between them. This adapter speaks Chat Completions, which is the surface every other '
      + 'provider in this file shares.',
  },
  {
    provider: 'google',
    label: 'Google Gemini',
    // Google serves an OpenAI-compatible surface at this path; the native
    // `generateContent` API is a different shape and is not what this speaks.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    wellKnownEnvVar: 'GEMINI_API_KEY',
    note:
      'This is Google\'s OpenAI-compatibility layer, not the native Gemini API. Google documents it '
      + 'as compatible rather than identical, so a parameter that works elsewhere may be ignored here.',
  },
  {
    provider: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://docs.mistral.ai/api/',
    wellKnownEnvVar: 'MISTRAL_API_KEY',
  },
  {
    provider: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/docs/openai',
    wellKnownEnvVar: 'GROQ_API_KEY',
    note:
      'Groq documents deviations from OpenAI: `logprobs`, `logit_bias` and `top_logprobs` are '
      + 'unsupported, `n` must be 1, and a `temperature` of 0 is converted to 1e-8. This adapter '
      + 'sends none of the unsupported fields; the temperature substitution is the provider\'s and is '
      + 'not corrected here.',
  },
  {
    provider: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    docsUrl: 'https://docs.together.ai/reference/chat-completions-1',
    wellKnownEnvVar: 'TOGETHER_API_KEY',
  },
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com/',
    wellKnownEnvVar: 'DEEPSEEK_API_KEY',
  },
];

/**
 * Whether this provider needs a credential at all.
 *
 * `required` is every hosted provider: no key, no request, and the refusal says
 * so before a run starts. `optional` exists for the locally-served runtimes
 * (M24), which document the key as accepted and ignored (Ollama) or as an
 * opt-in flag the operator may not have set (llama.cpp's `--api-key`). For
 * those, a stored credential is sent and a missing one is not an error — and
 * "is this client usable" is answered by whether a probe found the runtime,
 * which `local.ts` owns, not by whether a key exists.
 */
export type CredentialRequirement = 'required' | 'optional';

export interface OpenAICompatibleOptions {
  spec: ProviderSpec;
  /** The only route to the credential. Read once per request, never held. */
  secrets: SecretsPort;
  /** Overridden by tests, and by a self-hosted deployment of the same surface. */
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  credential?: CredentialRequirement;
}

export class OpenAICompatibleClient implements RunModelClient {
  readonly spec: ProviderSpec;
  readonly providers: readonly string[];

  readonly #secrets: SecretsPort;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #credential: CredentialRequirement;

  constructor(options: OpenAICompatibleOptions) {
    this.spec = options.spec;
    this.providers = [options.spec.provider];
    this.#secrets = options.secrets;
    this.#baseUrl = (options.baseUrl ?? options.spec.baseUrl).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#credential = options.credential ?? 'required';
  }

  /**
   * Whether a credential is reachable at all — asked once before a run rather
   * than discovered once per candidate, so an unconfigured provider produces one
   * refusal with something to do about it instead of one `provider-error` per
   * model and an opened breaker on a provider that was never down.
   *
   * A client whose credential is `optional` answers true: for those there is no
   * key to be missing, and reachability is a different question, asked by
   * whoever probed for the runtime.
   */
  async configured(): Promise<boolean> {
    if (this.#credential === 'optional') return true;
    return (await this.#secrets.get(secretRefFor(this.spec))) !== null;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.#post(request, false);
    const envelope = asRecord(await this.#json(response));
    this.#throwIfErrorEnvelope(envelope);
    return readCompletion(envelope);
  }

  /**
   * Streamed generation.
   *
   * The assembled `done` response is built from every chunk this adapter read,
   * not from the deltas a caller happened to observe — the distinction
   * `ports/model.ts` draws. Where the provider never reported a fact, the
   * response omits it: absent usage stays absent, and a stream that ended with
   * no `finish_reason` is `other` rather than `stop`.
   */
  async *stream(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const response = await this.#post(request, true);
    const body = response.body;
    if (!body) {
      throw new ModelClientError(
        'provider-error',
        `${this.spec.label} returned a streaming response with no body`,
      );
    }

    let text = '';
    let refusal = '';
    let finishReason: FinishReason | null = null;
    let usage: ModelUsage | undefined;
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();

    for await (const payload of readServerSentEvents(body, request.signal)) {
      const chunk = asRecord(payload);
      // A mid-stream failure arrives as an `error` member on a chunk rather than
      // as a broken connection. Unchecked, such a stream ends "successfully"
      // with half an answer.
      this.#throwIfErrorEnvelope(chunk);

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

    // Announced once, complete: a `tool-call` event carrying a half-streamed
    // argument string would be an event whose payload is not JSON.
    const toolCalls: ModelToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        arguments: call.arguments,
      }));
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
    const value = await this.#secrets.get(secretRefFor(this.spec));
    if (value === null && this.#credential === 'required') {
      throw new ModelClientError(
        'provider-error',
        `no ${this.spec.label} credential is configured for this daemon`,
      );
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
    };
    // Absent only where the provider documents the credential as optional. The
    // value lives in this local for the length of one request and reaches
    // nothing else — no field, no log, no response body.
    if (value !== null) headers['authorization'] = `Bearer ${value}`;

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
      throw transportFailure(error, request.signal, this.spec.label);
    }

    if (!response.ok) throw await this.#httpFailure(response);
    return response;
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new ModelClientError('invalid-output', `${this.spec.label} did not return JSON`, {
        cause: error,
      });
    }
  }

  /**
   * A non-2xx, classified from the status and nothing else. The body is read
   * only for the message a human will see, and that message is clipped: an
   * unbounded string from a third party deciding the size of our record is a
   * resource bug rather than a formatting one.
   */
  async #httpFailure(response: Response): Promise<ModelClientError> {
    let detail = '';
    try {
      detail = providerMessage(await response.text());
    } catch {
      // A body we could not read tells us nothing the status has not said.
    }
    const outcome = outcomeForStatus(response.status);
    const retryAfterMs = retryAfterFrom(response.headers.get('retry-after'));
    const message = `${this.spec.label} answered ${response.status}${detail ? `: ${detail}` : ''}`;
    return new ModelClientError(outcome, message, retryAfterMs === null ? {} : { retryAfterMs });
  }

  /**
   * `{ "error": { … } }` on a 200, and mid-stream as well as at the end. Left
   * unchecked, the first of those reads as a completion with no choices.
   *
   * When the envelope carries a numeric `code`, it is an HTTP status the
   * provider is restating and is classified through the same table as a real
   * one. When it carries a string code — which several of these providers use —
   * it is NOT interpreted: reading `insufficient_quota` and deciding it means
   * `rate-limited` would be the error-string sniffing ADR-008 forbids, just
   * spelled in a field name. Such a failure is `provider-error`, with the
   * provider's own words attached.
   */
  #throwIfErrorEnvelope(envelope: Record<string, unknown>): void {
    const error = envelope['error'];
    if (error === undefined || error === null) return;
    const record = asRecord(error);
    const message = asString(record['message']) ?? JSON.stringify(error);
    const status = asNumber(record['code']);
    throw new ModelClientError(
      status === null ? 'provider-error' : outcomeForStatus(status),
      `${this.spec.label} reported an error${status === null ? '' : ` (${status})`}: ${clip(
        message,
        MAX_PROVIDER_MESSAGE_CHARS,
      )}`,
    );
  }
}

/** Every direct OpenAI-compatible client, one per provider in the table above. */
export function openAiCompatibleClients(
  secrets: SecretsPort,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): OpenAICompatibleClient[] {
  return OPENAI_COMPATIBLE_PROVIDERS.map(
    (spec) =>
      new OpenAICompatibleClient({
        spec,
        secrets,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
  );
}

/**
 * A thrown fetch, classified without reading its message.
 *
 * Exported because `anthropic.ts` and `local.ts` classify the same three cases
 * the same way, and a second copy would be a second opinion about what a
 * cancelled run looks like.
 */
export function transportFailure(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  label: string,
): ModelClientError {
  if (callerSignal?.aborted) {
    return new ModelClientError('cancelled', 'the run was cancelled before the provider answered', {
      cause: error,
    });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ModelClientError(
      'timeout',
      `${label} did not answer before the request timed out`,
      { cause: error },
    );
  }
  return new ModelClientError('provider-error', `${label} could not be reached`, { cause: error });
}

/** The message inside an error body, or the body itself when it is not one. */
export function providerMessage(body: string): string {
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

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
