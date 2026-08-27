import { describe, expect, it } from 'vitest';
import {
  ModelClientError,
  type CompletionEvent,
  type CompletionRequest,
  type CompletionResponse,
  type ModelCandidate,
  type SecretsPort,
} from '@forgebridge/core';
import { OpenRouterClient } from '../src/openrouter.js';
import {
  ANTHROPIC_SECRET_REF,
  ANTHROPIC_VERSION,
  AnthropicClient,
  DEFAULT_MAX_OUTPUT_TOKENS,
  messagesBody,
  readMessage,
  readStopReason,
} from '../src/providers/anthropic.js';
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  OpenAICompatibleClient,
  openAiCompatibleClients,
  type ProviderSpec,
} from '../src/providers/openai-compatible.js';
import { MultiProviderClient } from '../src/providers/multi.js';
import type { RunModelClient } from '../src/wire.js';

/**
 * The direct provider adapters (M22).
 *
 * Three things this file is trying to keep true, in order of how expensive they
 * are to get wrong:
 *
 *   1. A credential goes into one header and reaches nothing else. The hunt at
 *      the bottom of this file is the same one `openrouter.test.ts` runs, for
 *      the same reason: the gate checks shapes, a test has to check behaviour.
 *   2. An outcome comes from an HTTP status. The controls here are the shapes
 *      most likely to tempt someone into reading prose instead — an error
 *      envelope with a *string* code, and Anthropic's `overloaded_error`
 *      arriving mid-stream where there is no status at all.
 *   3. The OpenAI-compatible adapter and the OpenRouter adapter agree, because
 *      they run the same readers. The drift test proves it on the same bytes
 *      rather than asserting it in a comment.
 */

/** Shaped like the real thing and belonging to nobody — assembled so `verify:no-secrets` has nothing to find. */
const FIXTURE_KEY = ['sk', 'test', `${'0'.repeat(8)}${'deadbeef'.repeat(6)}`].join('-');

function fixtureSecrets(value: string | null, names: string[] = []): SecretsPort {
  return {
    async get() {
      return value;
    },
    async set() {
      throw new Error('the fixture backend does not write');
    },
    async delete() {
      throw new Error('the fixture backend does not write');
    },
    async listNames() {
      return names;
    },
    describe() {
      return { kind: 'memory', label: 'test fixture', readableByOtherProcesses: false };
    },
  };
}

function candidate(over: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    id: 'fixture/one',
    provider: 'openai',
    contextTokens: 128_000,
    capabilities: ['tools', 'structured_outputs', 'response_format'],
    free: false,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    ...over,
  };
}

function request(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: candidate(),
    messages: [{ role: 'user', content: 'build a shop' }],
    ...over,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Recorded {
  url: string;
  init: RequestInit;
}

function recorder(responses: Response[] | ((url: string, init: RequestInit) => Response)) {
  const calls: Recorded[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (queue) {
      const next = queue.shift();
      if (!next) throw new Error(`no fixture response left for ${url}`);
      return next;
    }
    return (responses as (u: string, i: RequestInit) => Response)(url, init);
  };
  return { calls, fetchLike };
}

function headersOf(call: Recorded): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

async function collect(events: AsyncIterable<CompletionEvent>): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function doneOf(events: readonly CompletionEvent[]): CompletionResponse {
  const done = events.find((event) => event.type === 'done');
  if (!done || done.type !== 'done') throw new Error('the stream produced no done event');
  return done.response;
}

const SPEC: ProviderSpec = {
  provider: 'fixture',
  label: 'Fixture Provider',
  baseUrl: 'https://provider.invalid/v1',
  docsUrl: 'https://provider.invalid/docs',
  wellKnownEnvVar: 'FIXTURE_API_KEY',
};

function compatible(fetchLike: (url: string, init: RequestInit) => Promise<Response>, value: string | null = FIXTURE_KEY) {
  return new OpenAICompatibleClient({ spec: SPEC, secrets: fixtureSecrets(value), fetch: fetchLike });
}

// ── The provider table ───────────────────────────────────────────────────────

describe('the provider table', () => {
  it('names every direct provider M22 asks for, and Anthropic is not one of them', () => {
    expect(OPENAI_COMPATIBLE_PROVIDERS.map((spec) => spec.provider)).toEqual([
      'openai',
      'google',
      'mistral',
      'groq',
      'together',
      'deepseek',
    ]);
  });

  it('carries each documented base URL verbatim, including the one without /v1', () => {
    // Pinned deliberately. DeepSeek documents its base as `https://api.deepseek.com`
    // with the endpoint at `/chat/completions`; "tidying" it to `/v1` to match its
    // neighbours would produce a URL nobody documented.
    const byId = Object.fromEntries(OPENAI_COMPATIBLE_PROVIDERS.map((spec) => [spec.provider, spec.baseUrl]));
    expect(byId).toEqual({
      openai: 'https://api.openai.com/v1',
      google: 'https://generativelanguage.googleapis.com/v1beta/openai',
      mistral: 'https://api.mistral.ai/v1',
      groq: 'https://api.groq.com/openai/v1',
      together: 'https://api.together.ai/v1',
      deepseek: 'https://api.deepseek.com',
    });
  });

  it('gives every provider a slug the registry would accept and a documentation page', () => {
    for (const spec of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(spec.provider).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(spec.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('builds one client per provider, each claiming only its own', () => {
    const clients = openAiCompatibleClients(fixtureSecrets(null));
    expect(clients.map((client) => client.providers)).toEqual(
      OPENAI_COMPATIBLE_PROVIDERS.map((spec) => [spec.provider]),
    );
  });
});

// ── The request an OpenAI-compatible adapter builds ──────────────────────────

describe('the OpenAI-compatible request', () => {
  it('posts to the documented chat-completions path with the credential in one header', async () => {
    const { calls, fetchLike } = recorder([
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    ]);
    await compatible(fetchLike).complete(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://provider.invalid/v1/chat/completions');
    const headers = headersOf(calls[0] as Recorded);
    expect(headers['authorization']).toBe(`Bearer ${FIXTURE_KEY}`);
    // The key is in the authorization header and in nothing else on the request.
    const body = String((calls[0] as Recorded).init.body);
    expect(body).not.toContain(FIXTURE_KEY);
    expect(calls[0]?.url).not.toContain(FIXTURE_KEY);
  });

  it('refuses before reaching the network when no credential is configured', async () => {
    const { calls, fetchLike } = recorder([]);
    await expect(compatible(fetchLike, null).complete(request())).rejects.toBeInstanceOf(ModelClientError);
    expect(calls).toHaveLength(0);
  });

  it('answers configured() from the credential, and an optional-credential client without one', async () => {
    const { fetchLike } = recorder([]);
    expect(await compatible(fetchLike, null).configured()).toBe(false);
    expect(await compatible(fetchLike).configured()).toBe(true);

    const optional = new OpenAICompatibleClient({
      spec: SPEC,
      secrets: fixtureSecrets(null),
      fetch: fetchLike,
      credential: 'optional',
    });
    expect(await optional.configured()).toBe(true);
  });

  it('sends no authorization header at all when the credential is optional and absent', async () => {
    const { calls, fetchLike } = recorder([
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    ]);
    const optional = new OpenAICompatibleClient({
      spec: SPEC,
      secrets: fixtureSecrets(null),
      fetch: fetchLike,
      credential: 'optional',
    });
    await optional.complete(request());
    expect(headersOf(calls[0] as Recorded)['authorization']).toBeUndefined();
  });
});

// ── Classification ───────────────────────────────────────────────────────────

describe('classification comes from the status', () => {
  const cases: [number, string][] = [
    [429, 'rate-limited'],
    [408, 'timeout'],
    [504, 'timeout'],
    [401, 'provider-error'],
    [402, 'provider-error'],
    [500, 'provider-error'],
    [529, 'provider-error'],
  ];

  for (const [status, outcome] of cases) {
    it(`records ${status} as ${outcome}`, async () => {
      const { fetchLike } = recorder([
        new Response(JSON.stringify({ error: { message: 'upstream said so' } }), { status }),
      ]);
      const error = await compatible(fetchLike)
        .complete(request())
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ModelClientError);
      expect((error as ModelClientError).outcome).toBe(outcome);
    });
  }

  it('carries Retry-After from a 429 so the router can wait rather than guess', async () => {
    const { fetchLike } = recorder([
      new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    ]);
    const error = (await compatible(fetchLike)
      .complete(request())
      .catch((thrown: unknown) => thrown)) as ModelClientError;
    expect(error.retryAfterMs).toBe(30_000);
  });

  it('throws on an error envelope returned with a 200, which would otherwise read as an empty answer', async () => {
    const { fetchLike } = recorder([jsonResponse({ error: { message: 'no capacity', code: 429 } })]);
    const error = (await compatible(fetchLike)
      .complete(request())
      .catch((thrown: unknown) => thrown)) as ModelClientError;
    expect(error.outcome).toBe('rate-limited');
  });

  it('does NOT interpret a string error code — that would be prose-sniffing in a field name', async () => {
    // The control that keeps ADR-008 honest: `insufficient_quota` looks like a
    // rate limit to a human and must not be classified as one, because nothing
    // with a status said so.
    const { fetchLike } = recorder([
      jsonResponse({ error: { message: 'You exceeded your quota', code: 'insufficient_quota' } }),
    ]);
    const error = (await compatible(fetchLike)
      .complete(request())
      .catch((thrown: unknown) => thrown)) as ModelClientError;
    expect(error.outcome).toBe('provider-error');
    expect(error.message).toContain('You exceeded your quota');
  });

  it('CONTROL: an ordinary answer with no error member is not treated as a failure', async () => {
    const { fetchLike } = recorder([
      jsonResponse({
        choices: [{ message: { content: 'a shop' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    ]);
    const answer = await compatible(fetchLike).complete(request());
    expect(answer.text).toBe('a shop');
    expect(answer.finishReason).toBe('stop');
    expect(answer.usage).toEqual({ promptTokens: 10, completionTokens: 4 });
  });
});

// ── Drift: one set of readers, two adapters ──────────────────────────────────

describe('the OpenAI-compatible adapter and the OpenRouter adapter do not drift', () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    ': OPENROUTER PROCESSING\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"apply","arguments":"{\\"a\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"cost":0}}\n\n',
    'data: [DONE]\n\n',
  ];

  it('assembles the same response from the same bytes', async () => {
    const compatibleClient = compatible(async () => sseResponse(frames));
    const openRouter = new OpenRouterClient({
      secrets: fixtureSecrets(FIXTURE_KEY),
      fetch: async () => sseResponse(frames),
    });

    const fromCompatible = doneOf(await collect(compatibleClient.stream(request())));
    const fromOpenRouter = doneOf(await collect(openRouter.stream(request())));

    expect(fromCompatible).toEqual(fromOpenRouter);
    expect(fromCompatible).toEqual({
      text: 'Hello',
      finishReason: 'tool-calls',
      toolCalls: [{ id: 'call_1', name: 'apply', arguments: '{"a":1}' }],
      usage: { promptTokens: 7, completionTokens: 3, costUsd: 0 },
    });
  });

  it('announces a tool call once, complete, rather than as fragments', async () => {
    const events = await collect(compatible(async () => sseResponse(frames)).stream(request()));
    const toolEvents = events.filter((event) => event.type === 'tool-call');
    expect(toolEvents).toHaveLength(1);
    expect(JSON.parse((toolEvents[0] as { call: { arguments: string } }).call.arguments)).toEqual({ a: 1 });
  });
});

// ── Anthropic: the request ───────────────────────────────────────────────────

describe('the Anthropic request', () => {
  it('uses x-api-key and anthropic-version, never Authorization', async () => {
    const { calls, fetchLike } = recorder([
      jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    ]);
    const client = new AnthropicClient({ secrets: fixtureSecrets(FIXTURE_KEY), fetch: fetchLike });
    await client.complete(request({ model: candidate({ provider: 'anthropic' }) }));

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = headersOf(calls[0] as Recorded);
    expect(headers['x-api-key']).toBe(FIXTURE_KEY);
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headers['authorization']).toBeUndefined();
  });

  it('hoists system messages into the top-level field and merges consecutive turns', () => {
    const body = messagesBody(
      request({
        messages: [
          { role: 'system', content: 'you build Roblox places' },
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'a shop' },
          { role: 'user', content: 'with a till' },
          { role: 'assistant', content: 'on it' },
        ],
      }),
      false,
    );
    expect(body['system']).toBe('you build Roblox places\n\nbe terse');
    expect(body['messages']).toEqual([
      { role: 'user', content: 'a shop\n\nwith a till' },
      { role: 'assistant', content: 'on it' },
    ]);
  });

  it('always sends max_tokens, because the API requires it', () => {
    expect(messagesBody(request(), false)['max_tokens']).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(messagesBody(request({ maxOutputTokens: 200 }), false)['max_tokens']).toBe(200);
  });

  it('maps tools onto input_schema, and sends none to a model that does not report tool calling', () => {
    const tools = [{ name: 'apply', description: 'apply a set', parameters: { type: 'object' } }];
    const withTools = messagesBody(request({ tools }), false);
    expect(withTools['tools']).toEqual([
      { name: 'apply', description: 'apply a set', input_schema: { type: 'object' } },
    ]);

    const withoutCapability = messagesBody(
      request({ tools, model: candidate({ capabilities: ['reasoning'] }) }),
      false,
    );
    expect(withoutCapability['tools']).toBeUndefined();
  });

  it('sends no response_format, because the Messages API has no such field', () => {
    const body = messagesBody(request({ responseFormat: 'json' }), false);
    expect(body['response_format']).toBeUndefined();
    expect(Object.keys(body)).not.toContain('response_format');
  });

  it('refuses a request with nothing but system messages rather than posting a body the API rejects', () => {
    expect(() => messagesBody(request({ messages: [{ role: 'system', content: 'only this' }] }), false)).toThrow(
      ModelClientError,
    );
  });
});

// ── Anthropic: reading an answer ─────────────────────────────────────────────

describe('reading an Anthropic answer', () => {
  it('reads text and tool_use blocks, and re-serialises the tool input as JSON text', () => {
    const answer = readMessage({
      content: [
        { type: 'text', text: 'building' },
        { type: 'tool_use', id: 'toolu_1', name: 'apply', input: { path: 'Shop' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    expect(answer.text).toBe('building');
    expect(answer.finishReason).toBe('tool-calls');
    expect(answer.toolCalls).toEqual([{ id: 'toolu_1', name: 'apply', arguments: '{"path":"Shop"}' }]);
    expect(answer.usage).toEqual({ promptTokens: 12, completionTokens: 5 });
  });

  it('omits usage entirely when the provider reported none', () => {
    expect(readMessage({ content: [], stop_reason: 'end_turn' }).usage).toBeUndefined();
  });

  it('throws on an error body returned with a 200', async () => {
    const { fetchLike } = recorder([
      jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
    ]);
    const client = new AnthropicClient({ secrets: fixtureSecrets(FIXTURE_KEY), fetch: fetchLike });
    const error = (await client.complete(request()).catch((thrown: unknown) => thrown)) as ModelClientError;
    expect(error).toBeInstanceOf(ModelClientError);
    expect(error.message).toContain('bad model');
  });

  it('CONTROL: an answer carrying an explicitly null error is an answer, not a failure', async () => {
    // The legitimate shape the check above is most confusable with. A body that
    // says "error: null" has told us there was no error.
    const { fetchLike } = recorder([
      jsonResponse({ type: 'message', error: null, content: [{ type: 'text', text: 'fine' }], stop_reason: 'end_turn' }),
    ]);
    const client = new AnthropicClient({ secrets: fixtureSecrets(FIXTURE_KEY), fetch: fetchLike });
    expect((await client.complete(request())).text).toBe('fine');
  });

  it('maps every documented stop reason, and anything else to other rather than stop', () => {
    expect(readStopReason('end_turn')).toBe('stop');
    expect(readStopReason('stop_sequence')).toBe('stop');
    expect(readStopReason('max_tokens')).toBe('length');
    expect(readStopReason('tool_use')).toBe('tool-calls');
    expect(readStopReason('refusal')).toBe('refusal');
    expect(readStopReason('pause_turn')).toBe('other');
    expect(readStopReason('something_added_next_year')).toBe('other');
    expect(readStopReason(null)).toBeNull();
    expect(readStopReason(undefined)).toBeNull();
  });
});

// ── Anthropic: the event stream ──────────────────────────────────────────────

describe('the Anthropic event stream', () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Buil"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ding"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"apply","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Shop\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":89}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  function streamingClient(responseFrames: readonly string[]): AnthropicClient {
    return new AnthropicClient({
      secrets: fixtureSecrets(FIXTURE_KEY),
      fetch: async () => sseResponse(responseFrames),
    });
  }

  it('assembles text, a completed tool call, and the usage the events reported', async () => {
    const events = await collect(streamingClient(frames).stream(request()));
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { delta: string }).delta)).toEqual([
      'Buil',
      'ding',
    ]);
    expect(doneOf(events)).toEqual({
      text: 'Building',
      finishReason: 'tool-calls',
      toolCalls: [{ id: 'toolu_1', name: 'apply', arguments: '{"path":"Shop"}' }],
      // input_tokens from message_start, output_tokens from the last (cumulative)
      // message_delta — read, never reconstructed from what arrived.
      usage: { promptTokens: 25, completionTokens: 89 },
    });
  });

  it('falls back to the input the provider sent when a tool call streamed no fragments', async () => {
    const noDeltas = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"apply","input":{"ready":true}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ];
    const done = doneOf(await collect(streamingClient(noDeltas).stream(request())));
    expect(done.toolCalls).toEqual([{ id: 'toolu_2', name: 'apply', arguments: '{"ready":true}' }]);
  });

  it('a stream that ended without a stop reason is other, not stop', async () => {
    const truncated = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}}\n\n',
    ];
    expect(doneOf(await collect(streamingClient(truncated).stream(request()))).finishReason).toBe('other');
  });

  it('throws on an error event rather than ending the stream with half an answer', async () => {
    const interrupted = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ];
    const thrown = await collect(streamingClient(interrupted).stream(request())).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ModelClientError);
    // And it is provider-error, NOT rate-limited: `overloaded_error` corresponds
    // to a 529 in a non-streaming context, and a stream frame carries no status.
    // Promoting it would be deciding an outcome from a payload string.
    expect((thrown as ModelClientError).outcome).toBe('provider-error');
    expect((thrown as ModelClientError).message).toContain('overloaded_error');
  });

  it('ignores delta types it does not carry rather than flattening them into the answer', async () => {
    const thinking = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ];
    expect(doneOf(await collect(streamingClient(thinking).stream(request()))).text).toBe('answer');
  });
});

// ── The composite ────────────────────────────────────────────────────────────

function stubClient(provider: string, configured: boolean | 'throws'): RunModelClient {
  return {
    providers: [provider],
    async configured() {
      if (configured === 'throws') throw new Error(`the ${provider} backend is unreachable`);
      return configured;
    },
    async complete() {
      return { text: provider, finishReason: 'stop' as const };
    },
  };
}

describe('the composite client', () => {
  it('claims nothing until it has been asked, so an unrefreshed composite routes nowhere', () => {
    const multi = new MultiProviderClient([stubClient('openai', true)]);
    expect(multi.providers).toEqual([]);
  });

  it('reports only the providers whose adapters are configured', async () => {
    const multi = new MultiProviderClient([
      stubClient('openrouter', false),
      stubClient('openai', true),
      stubClient('anthropic', false),
    ]);
    expect(await multi.configured()).toBe(true);
    expect(multi.providers).toEqual(['openai']);
  });

  it('is not configured when no adapter is', async () => {
    const multi = new MultiProviderClient([stubClient('openai', false), stubClient('groq', false)]);
    expect(await multi.configured()).toBe(false);
    expect(multi.providers).toEqual([]);
  });

  it('treats an adapter whose configured() throws exactly as one that said no', async () => {
    const multi = new MultiProviderClient([stubClient('openai', 'throws')]);
    expect(await multi.configured()).toBe(false);
    expect(multi.providers).toEqual([]);
  });

  it('CONTROL: a throwing adapter does not suppress a healthy one beside it', async () => {
    const multi = new MultiProviderClient([stubClient('openai', 'throws'), stubClient('groq', true)]);
    expect(await multi.configured()).toBe(true);
    expect(multi.providers).toEqual(['groq']);
  });

  it('dispatches a candidate to the adapter that claims its provider', async () => {
    const multi = new MultiProviderClient([stubClient('openai', true), stubClient('groq', true)]);
    const answer = await multi.complete(request({ model: candidate({ provider: 'groq' }) }));
    expect(answer.text).toBe('groq');
  });

  it('refuses a candidate whose provider no adapter serves, rather than sending it somewhere', async () => {
    const multi = new MultiProviderClient([stubClient('openai', true)]);
    const error = await multi
      .complete(request({ model: candidate({ provider: 'somebody-else' }) }))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ModelClientError);
    expect((error as ModelClientError).outcome).toBe('provider-error');
    expect((error as ModelClientError).message).toContain('somebody-else');
  });
});

// ── The credential ───────────────────────────────────────────────────────────

describe('the credential', () => {
  it('does not appear in an adapter error built from the provider’s own reply', async () => {
    // The failure most likely to quote a request back: a provider that echoes
    // what it was sent. Nothing the adapter raises may carry the key.
    const { fetchLike } = recorder([
      new Response(JSON.stringify({ error: { message: `bad key: ${FIXTURE_KEY}` } }), { status: 401 }),
    ]);
    const error = (await compatible(fetchLike)
      .complete(request())
      .catch((thrown: unknown) => thrown)) as ModelClientError;

    // The provider quoted it back, so the message legitimately contains what the
    // provider said — what must never happen is the adapter adding it from its
    // own state. This asserts the adapter's own contribution is clean.
    const withoutProviderText = error.message.replace(/bad key: .*/, '');
    expect(withoutProviderText).not.toContain(FIXTURE_KEY);
  });

  it('is read through the port on every request and held on no field', async () => {
    let reads = 0;
    const secrets: SecretsPort = {
      ...fixtureSecrets(FIXTURE_KEY),
      async get() {
        reads += 1;
        return FIXTURE_KEY;
      },
    };
    const { fetchLike } = recorder([
      jsonResponse({ choices: [{ message: { content: 'a' }, finish_reason: 'stop' }] }),
      jsonResponse({ choices: [{ message: { content: 'b' }, finish_reason: 'stop' }] }),
    ]);
    const client = new OpenAICompatibleClient({ spec: SPEC, secrets, fetch: fetchLike });
    await client.complete(request());
    await client.complete(request());
    expect(reads).toBe(2);

    // Nothing on the instance holds it. Private fields are not enumerable, so
    // this is a check on the public surface a caller could serialise.
    expect(JSON.stringify(client)).not.toContain(FIXTURE_KEY);
  });

  it('looks the Anthropic key up under its own provider scope', () => {
    expect(ANTHROPIC_SECRET_REF).toEqual({ scope: 'provider', name: 'anthropic' });
  });
});
