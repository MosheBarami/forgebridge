import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelClientError,
  type CompletionRequest,
  type CompletionResponse,
  type ModelCandidate,
} from '@forgebridge/core';
import { PRODUCER_TOKEN_HEADER } from '../src/auth.js';
import { createDaemon, type DaemonLogger, type ForgeBridgeDaemon } from '../src/server.js';
import type { ModelsPort, ModelsSnapshot, RunModelClient, RunResponse } from '../src/wire.js';

/**
 * `POST /v1/runs`, from the outside.
 *
 * Every test here drives a real daemon over a real socket with a scripted model
 * client, because the four properties this route has to hold are properties of
 * the *wire*: what an unauthenticated caller gets, what status the ChangeSet is
 * left in, what the caller is told about the models that were tried, and what
 * happens when the tree moved. A test that called the handler directly could
 * pass while any of them was broken over HTTP.
 */

const ALLOWED_PREFIX = 'ServerScriptService.Shop';

function candidate(id: string, over: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    id,
    provider: 'test',
    contextTokens: 128_000,
    capabilities: ['tools', 'structured_outputs', 'response_format'],
    free: true,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    ...over,
  };
}

function modelsPort(candidates: readonly ModelCandidate[]): ModelsPort {
  return {
    async snapshot(): Promise<ModelsSnapshot> {
      return { configured: true, source: 'test fixture', verifiedAt: null, models: [] };
    },
    async candidates() {
      return [...candidates];
    },
  };
}

/** The two fields a model is allowed to contribute, and nothing else. */
function draft(source = 'local total = 1\nreturn total\n'): string {
  return JSON.stringify({
    summary: 'add a purchase handler',
    operations: [
      { op: 'writeScript', path: `${ALLOWED_PREFIX}.Handler`, scriptType: 'Script', source },
    ],
  });
}

const answered = (text: string): CompletionResponse => ({
  text,
  finishReason: 'stop',
  usage: { promptTokens: 12, completionTokens: 34, costUsd: 0 },
});

type Step = () => CompletionResponse;

/** A model client with a scripted answer per model id, recording what it was asked. */
class ScriptedClient implements RunModelClient {
  readonly providers: readonly string[] = ['test'];
  readonly asked: string[] = [];
  #configured = true;

  constructor(private readonly script: Record<string, Step>) {}

  unconfigure(): void {
    this.#configured = false;
  }

  async configured(): Promise<boolean> {
    return this.#configured;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.asked.push(request.model.id);
    const step = this.script[request.model.id];
    if (!step) throw new ModelClientError('provider-error', `no scripted answer for ${request.model.id}`);
    return step();
  }
}

function collectingLogger(): { logger: DaemonLogger; lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
    };
  return { logger: { info: record('info'), warn: record('warn'), error: record('error') }, lines };
}

const open: ForgeBridgeDaemon[] = [];

async function start(options: {
  client?: RunModelClient;
  candidates?: readonly ModelCandidate[];
  logger?: DaemonLogger;
  allowedPathPrefixes?: readonly string[];
}): Promise<ForgeBridgeDaemon> {
  const daemon = createDaemon({
    port: 0,
    policy: {
      allowedPathPrefixes: [...(options.allowedPathPrefixes ?? [ALLOWED_PREFIX])],
      autoApply: null,
    },
    models: modelsPort(options.candidates ?? [candidate('fixture/one')]),
    ...(options.client ? { modelClient: options.client } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  await daemon.listen();
  open.push(daemon);
  return daemon;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((daemon) => daemon.close()));
});

function startRun(
  daemon: ForgeBridgeDaemon,
  body: Record<string, unknown>,
  token: string | null = daemon.producerToken,
): Promise<Response> {
  return fetch(`${daemon.url}/v1/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { [PRODUCER_TOKEN_HEADER]: token }),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/runs', () => {
  it('is producer surface: an unauthenticated caller never reaches a model', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });

    const response = await startRun(daemon, { prompt: 'build a shop' }, null);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'link_unauthenticated' });
    // The point of the check is that it happens before anything is spent.
    expect(client.asked).toEqual([]);
  });

  it('leaves the ChangeSet validated and unapproved', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });

    const response = await startRun(daemon, { prompt: 'build a shop' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as RunResponse;

    // The run stops at the human gate and says so: `awaiting-approval`, and
    // still `running`, because it is waiting for a person (ADR-012).
    expect(body.run.stage).toBe('awaiting-approval');
    expect(body.run.status).toBe('running');
    expect(body.changeSetStatus).toBe('validated');
    expect(body.changeSetId).not.toBeNull();
    expect(body.contentDigest).not.toBeNull();
    expect(body.failure).toBeNull();

    // And the stored set agrees. Nothing on this path can produce `approved`.
    const stored = await daemon.store.getChangeSet(body.changeSetId as string);
    expect(stored?.status).toBe('validated');
    expect(stored?.validation?.computedBy).toMatch(/^forgebridge-daemon@/);
    // Nothing was queued for a consumer either: delivery happens on approval.
    expect(await daemon.store.lastOutboundNonce('any-link')).toBe(0);
  });

  it('returns every model it tried, in order, with why it moved on', async () => {
    const client = new ScriptedClient({
      'fixture/one': () => {
        throw new ModelClientError('rate-limited', 'slow down');
      },
      'fixture/two': () => answered(draft()),
    });
    const daemon = await start({
      client,
      candidates: [candidate('fixture/one'), candidate('fixture/two')],
    });

    const body = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;

    expect(client.asked).toEqual(['fixture/one', 'fixture/two']);
    expect(body.run.attempts.map((attempt) => [attempt.modelId, attempt.outcome])).toEqual([
      ['fixture/one', 'rate-limited'],
      ['fixture/two', 'ok'],
    ]);
    // The ordering the router actually used is reported beside the attempts, so
    // a reader can tell "tried second" from "never reached".
    expect(body.ordering?.order).toEqual(['fixture/one', 'fixture/two']);
    expect(body.ordering?.candidatesConsidered).toBe(2);
    expect(body.run.attempts[1]?.completionTokens).toBe(34);
  });

  it('pinned tries exactly the pinned model and does not substitute', async () => {
    const client = new ScriptedClient({
      'fixture/one': () => {
        throw new ModelClientError('rate-limited', 'slow down');
      },
      'fixture/two': () => answered(draft()),
    });
    const daemon = await start({
      client,
      candidates: [candidate('fixture/one'), candidate('fixture/two')],
    });

    const body = (await (
      await startRun(daemon, { prompt: 'build a shop', policy: 'pinned', pinnedModel: 'fixture/one' })
    ).json()) as RunResponse;

    expect(client.asked).toEqual(['fixture/one']);
    expect(body.run.attempts).toHaveLength(1);
    expect(body.run.status).toBe('failed');
    expect(body.changeSetId).toBeNull();
  });

  it("refuses 'pinned' with no model named, before spending anything", async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });

    const response = await startRun(daemon, { prompt: 'build a shop', policy: 'pinned' });

    expect(response.status).toBe(400);
    expect(client.asked).toEqual([]);
  });

  it('refuses a stale baseVersion before a model is called', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });
    await daemon.store.setProjectVersion(daemon.defaultProjectId, 4);

    const response = await startRun(daemon, { prompt: 'build a shop', baseVersion: 0 });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_base' });
    expect(client.asked).toEqual([]);
  });

  it('refuses when nothing can reach a model, and says which half is missing', async () => {
    const withoutClient = await start({});
    const noClient = await startRun(withoutClient, { prompt: 'build a shop' });
    expect(noClient.status).toBe(503);
    expect(await noClient.json()).toMatchObject({ code: 'provider_unconfigured' });

    const client = new ScriptedClient({});
    client.unconfigure();
    const withoutKey = await start({ client });
    const noCredential = await startRun(withoutKey, { prompt: 'build a shop' });
    expect(noCredential.status).toBe(503);
    expect(client.asked).toEqual([]);
  });

  it('rejects a set whose Luau arrived as a property, which the core never sees', async () => {
    // `createInstance` carrying `Source` installs a script by another route.
    // The core's analyser port is handed one source per `writeScript`, so this
    // reaches the daemon looking clean; the daemon's own verdict reads it.
    const smuggled = JSON.stringify({
      summary: 'add a handler',
      operations: [
        {
          op: 'createInstance',
          path: `${ALLOWED_PREFIX}.Sneaky`,
          className: 'Script',
          properties: { Source: { t: 'String', v: 'loadstring("print(1)")()' } },
        },
      ],
    });
    const client = new ScriptedClient({ 'fixture/one': () => answered(smuggled) });
    const daemon = await start({ client });

    const body = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;

    expect(body.changeSetStatus).toBe('rejected');
    expect(body.run.status).toBe('failed');
    expect(body.validation?.luau.status).toBe('fail');
    expect(body.failure?.code).toBe('invalid_request');
  });

  it('fails a run whose set falls outside the project policy', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client, allowedPathPrefixes: ['Workspace.Elsewhere'] });

    const body = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;

    expect(body.failure?.code).toBe('policy_violation');
    expect(body.changeSetStatus).toBe('rejected');
    expect(body.run.status).toBe('failed');
  });
});

describe('GET /v1/runs/:id', () => {
  async function read(daemon: ForgeBridgeDaemon, path: string, token = daemon.producerToken): Promise<Response> {
    return await fetch(`${daemon.url}${path}`, { headers: { [PRODUCER_TOKEN_HEADER]: token } });
  }

  it('answers with the same run, and 404s for one it never ran', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });
    const started = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;

    const again = (await (await read(daemon, `/v1/runs/${started.run.id}`)).json()) as RunResponse;
    expect(again.run.id).toBe(started.run.id);
    expect(again.run.attempts).toEqual(started.run.attempts);

    const missing = await read(daemon, '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(missing.status).toBe(404);
  });

  it('is producer surface', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });
    const started = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;

    const anonymous = await fetch(`${daemon.url}/v1/runs/${started.run.id}`);
    expect(anonymous.status).toBe(401);
    const events = await fetch(`${daemon.url}/v1/runs/${started.run.id}/events`);
    expect(events.status).toBe(401);
  });

  it('replays a finished run over the event stream and closes', async () => {
    const client = new ScriptedClient({ 'fixture/one': () => answered(draft()) });
    const daemon = await start({ client });
    const started = (await (await startRun(daemon, { prompt: 'build a shop' })).json()) as RunResponse;

    const stream = await read(daemon, `/v1/runs/${started.run.id}/events`);
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await stream.text();

    expect(text).toContain('event: run');
    expect(text).toContain('event: stage');
    expect(text).toContain('event: model-attempt');
    expect(text).toContain('event: change-set');
  });
});

describe('POST /v1/runs with stream: true', () => {
  it('carries the plan, the stage changes and each attempt as it happens', async () => {
    const client = new ScriptedClient({
      'fixture/one': () => {
        throw new ModelClientError('rate-limited', 'slow down');
      },
      'fixture/two': () => answered(draft()),
    });
    const daemon = await start({
      client,
      candidates: [candidate('fixture/one'), candidate('fixture/two')],
    });

    const response = await startRun(daemon, { prompt: 'build a shop', stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await response.text();

    expect(text).toContain('event: plan');
    expect(text).toContain('event: model-attempt-started');
    // Both attempts, in order, which is the whole of the visible-fallback claim.
    expect(text.indexOf('rate-limited')).toBeGreaterThan(-1);
    expect(text.indexOf('fixture/one')).toBeLessThan(text.lastIndexOf('fixture/two'));

    // The last frame is the finished run, so a streaming caller ends up holding
    // exactly what the JSON form would have returned.
    const frames = text.split('\n\n').filter((frame) => frame.includes('event: run'));
    const last = frames[frames.length - 1] as string;
    const payload = JSON.parse(last.slice(last.indexOf('data: ') + 'data: '.length)) as RunResponse;
    expect(payload.run.attempts).toHaveLength(2);
    expect(payload.changeSetStatus).toBe('validated');
  });
});
