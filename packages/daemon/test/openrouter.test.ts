import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelClientError,
  type CompletionRequest,
  type ModelCandidate,
  type SecretsPort,
} from '@forgebridge/core';
import { PRODUCER_TOKEN_HEADER } from '../src/auth.js';
import {
  OPENROUTER_PROVIDER,
  OpenRouterClient,
  chatCompletionBody,
  outcomeForStatus,
  readCompletion,
  readServerSentEvents,
  readUsage,
  retryAfterFrom,
} from '../src/openrouter.js';
import { createDaemon, type DaemonLogger, type ForgeBridgeDaemon } from '../src/server.js';
import type { ModelsPort, ModelsSnapshot, RunResponse } from '../src/wire.js';

/**
 * The OpenRouter adapter, and the promise it exists to keep.
 *
 * The load-bearing test in this file is the last one: a key-shaped string is
 * put in front of the adapter, the adapter is made to fail in the way most
 * likely to quote its own request back, and the key is then hunted for in every
 * direction it could have escaped — the JSON response, the streamed response,
 * the run record, and the daemon's log. `scripts/verify-no-key-storage.ts`
 * checks the shapes; this checks the behaviour.
 */

/**
 * Shaped like the real thing and belonging to nobody.
 *
 * Assembled from parts rather than written out, for the same reason
 * `scripts/verify-boundaries.ts` assembles the string it hunts for: a file that
 * has to contain a credential shape in order to prove nothing leaks one would
 * otherwise be caught by `npm run verify:no-secrets`, and a scanner somebody
 * had to add an exception to is a scanner with a hole in it.
 */
const FIXTURE_KEY = ['sk', 'or', 'v1', `${'0'.repeat(8)}${'deadbeef'.repeat(6)}`].join('-');

const ALLOWED_PREFIX = 'ServerScriptService.Shop';

function fixtureSecrets(value: string | null): SecretsPort {
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
      return value === null ? [] : [OPENROUTER_PROVIDER];
    },
    describe() {
      return { kind: 'memory', label: 'test fixture', readableByOtherProcesses: false };
    },
  };
}

function candidate(id = 'fixture/one', over: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    id,
    provider: OPENROUTER_PROVIDER,
    contextTokens: 128_000,
    capabilities: ['tools', 'structured_outputs', 'response_format'],
    free: true,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    ...over,
  };
}

function completionRequest(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: candidate(),
    messages: [{ role: 'user', content: 'build a shop' }],
    ...over,
  };
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

const draft = JSON.stringify({
  summary: 'add a purchase handler',
  operations: [
    {
      op: 'writeScript',
      path: `${ALLOWED_PREFIX}.Handler`,
      scriptType: 'Script',
      source: 'local total = 1\nreturn total\n',
    },
  ],
});

/** A stream that delivers the draft in two pieces, then usage, then the sentinel. */
function draftStream(): readonly string[] {
  const half = Math.floor(draft.length / 2);
  return [
    ': OPENROUTER PROCESSING\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: draft.slice(0, half) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: draft.slice(half) } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 22, cost: 0 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

describe('the request the adapter builds', () => {
  it('offers tools and a JSON response format only to a model that reports them', () => {
    const full = chatCompletionBody(completionRequest({
      tools: [{ name: 'emit_change_set', description: 'x', parameters: { type: 'object' } }],
      responseFormat: 'json',
    }), false);
    expect(full['tools']).toHaveLength(1);
    expect(full['response_format']).toEqual({ type: 'json_object' });
    // Never `tool_choice`: forcing the call needs a capability plenty of
    // tool-calling models do not report, and buys nothing the core needs.
    expect(full['tool_choice']).toBeUndefined();

    const plain = chatCompletionBody(
      completionRequest({
        model: candidate('fixture/plain', { capabilities: [] }),
        tools: [{ name: 'emit_change_set', description: 'x', parameters: { type: 'object' } }],
        responseFormat: 'json',
      }),
      true,
    );
    expect(plain['tools']).toBeUndefined();
    expect(plain['response_format']).toBeUndefined();
    expect(plain['stream']).toBe(true);
  });
});

describe('classification', () => {
  it('reads the status and nothing else', () => {
    expect(outcomeForStatus(429)).toBe('rate-limited');
    expect(outcomeForStatus(408)).toBe('timeout');
    expect(outcomeForStatus(504)).toBe('timeout');
    // A wrong credential, an exhausted balance and a broken provider are all
    // `provider-error`: the status does not separate them, and separating them
    // by reading the message is the error-string sniffing ADR-008 forbids.
    expect(outcomeForStatus(401)).toBe('provider-error');
    expect(outcomeForStatus(402)).toBe('provider-error');
    expect(outcomeForStatus(500)).toBe('provider-error');
  });

  it('reads Retry-After as seconds or as a date, and refuses to guess', () => {
    expect(retryAfterFrom('30')).toBe(30_000);
    expect(retryAfterFrom(null)).toBeNull();
    expect(retryAfterFrom('soon')).toBeNull();
    const now = Date.parse('2026-08-27T00:00:00Z');
    expect(retryAfterFrom('Thu, 27 Aug 2026 00:00:30 GMT', now)).toBe(30_000);
  });
});

describe('reading an answer', () => {
  it('keeps a tool call\'s arguments as the raw text the model wrote', () => {
    const response = readCompletion({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'emit_change_set', arguments: '{"summary":' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(response.finishReason).toBe('tool-calls');
    // Truncated JSON, unrepaired. The core records that as `invalid-output`;
    // an adapter that patched it would be inventing the model's answer.
    expect(response.toolCalls?.[0]?.arguments).toBe('{"summary":');
  });

  it('reports a refusal as a refusal rather than as empty content', () => {
    const response = readCompletion({
      choices: [{ message: { content: '', refusal: 'I will not' }, finish_reason: 'stop' }],
    });
    expect(response.finishReason).toBe('refusal');
    expect(response.text).toBe('I will not');
  });

  it('calls an unrecognised finish reason `other`, never `stop`', () => {
    expect(readCompletion({ choices: [{ message: {}, finish_reason: 'something_new' }] }).finishReason).toBe('other');
    expect(readCompletion({ choices: [{ message: {} }] }).finishReason).toBe('other');
  });

  it('omits usage the provider did not report', () => {
    expect(readUsage({})).toBeUndefined();
    expect(readUsage({ usage: { prompt_tokens: 3 } })).toEqual({ promptTokens: 3 });
    expect(readUsage({ usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0 } })).toEqual({
      promptTokens: 3,
      completionTokens: 4,
      costUsd: 0,
    });
  });
});

describe('the event stream', () => {
  it('skips keep-alive comments and stops at the sentinel', async () => {
    const frames: unknown[] = [];
    for await (const frame of readServerSentEvents(sseResponse(draftStream()).body!, undefined)) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(3);
  });

  it('tolerates a frame split across two reads', async () => {
    const encoder = new TextEncoder();
    const whole = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(whole.slice(0, 20)));
        controller.enqueue(encoder.encode(whole.slice(20)));
        controller.close();
      },
    });
    const frames: unknown[] = [];
    for await (const frame of readServerSentEvents(body, undefined)) frames.push(frame);
    expect(frames).toHaveLength(1);
  });
});

describe('a client with no credential', () => {
  it('reports itself unconfigured rather than failing one candidate at a time', async () => {
    const client = new OpenRouterClient({ secrets: fixtureSecrets(null) });
    expect(await client.configured()).toBe(false);
    await expect(client.complete(completionRequest())).rejects.toBeInstanceOf(ModelClientError);
  });
});

// ── the key, end to end ──────────────────────────────────────────────────────

const open: ForgeBridgeDaemon[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((daemon) => daemon.close()));
});

interface Harness {
  daemon: ForgeBridgeDaemon;
  lines: string[];
  authorization: string[];
}

async function harness(answer: () => Response): Promise<Harness> {
  const authorization: string[] = [];
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
    };
  const logger: DaemonLogger = { info: record('info'), warn: record('warn'), error: record('error') };

  const modelClient = new OpenRouterClient({
    secrets: fixtureSecrets(FIXTURE_KEY),
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      authorization.push(headers.get('authorization') ?? '');
      return answer();
    },
  });

  const models: ModelsPort = {
    async snapshot(): Promise<ModelsSnapshot> {
      return { configured: true, source: 'test fixture', verifiedAt: null, models: [] };
    },
    async candidates() {
      return [candidate()];
    },
  };

  const daemon = createDaemon({
    port: 0,
    policy: { allowedPathPrefixes: [ALLOWED_PREFIX], autoApply: null },
    models,
    modelClient,
    logger,
  });
  await daemon.listen();
  open.push(daemon);
  return { daemon, lines, authorization };
}

function startRun(daemon: ForgeBridgeDaemon, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${daemon.url}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PRODUCER_TOKEN_HEADER]: daemon.producerToken },
    body: JSON.stringify(body),
  });
}

describe('the credential', () => {
  it('drives a whole run without appearing anywhere the caller can see', async () => {
    const { daemon, lines, authorization } = await harness(() => sseResponse(draftStream()));

    const response = await startRun(daemon, { prompt: 'build a shop' });
    const text = await response.text();
    const body = JSON.parse(text) as RunResponse;

    // It was really used: the test would otherwise pass against an adapter that
    // never sent it.
    expect(authorization).toEqual([`Bearer ${FIXTURE_KEY}`]);
    // The streamed adapter path assembled the answer, and the daemon validated it.
    expect(body.changeSetStatus).toBe('validated');
    expect(body.run.attempts[0]?.completionTokens).toBe(22);

    const streamed = await (await startRun(daemon, { prompt: 'build a shop again', stream: true })).text();
    const record = await (
      await fetch(`${daemon.url}/v1/runs/${body.run.id}`, {
        headers: { [PRODUCER_TOKEN_HEADER]: daemon.producerToken },
      })
    ).text();

    for (const surface of [text, streamed, record, lines.join('\n')]) {
      expect(surface).not.toContain(FIXTURE_KEY);
      expect(surface).not.toContain('sk-or-v1-');
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  it('is not quoted back when the provider rejects it', async () => {
    // The failure most likely to echo a request: the provider says the
    // credential is wrong, and the adapter puts the provider's message on the
    // attempt note that the caller reads.
    const { daemon, lines } = await harness(
      () =>
        new Response(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const text = await (await startRun(daemon, { prompt: 'build a shop' })).text();
    const body = JSON.parse(text) as RunResponse;

    expect(body.run.status).toBe('failed');
    expect(body.run.attempts[0]?.outcome).toBe('provider-error');
    expect(body.run.attempts[0]?.note).toContain('401');
    for (const surface of [text, lines.join('\n')]) {
      expect(surface).not.toContain(FIXTURE_KEY);
    }
  });

  it('records a rate limit as a rate limit, with the provider\'s own wait', async () => {
    const { daemon } = await harness(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '7' },
        }),
    );

    const body = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;
    expect(body.run.attempts[0]?.outcome).toBe('rate-limited');
    expect(body.failure?.code).toBe('rate_limited');
  });
});
