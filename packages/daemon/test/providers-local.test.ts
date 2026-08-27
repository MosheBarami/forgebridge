import { describe, expect, it } from 'vitest';
import { ModelClientError, type ModelCandidate, type SecretsPort } from '@forgebridge/core';
import { LOCAL_FREE_REASON, UNKNOWN_CONTEXT_TOKENS } from '@forgebridge/model-registry';
import {
  LOCAL_RUNTIME_SPECS,
  LocalDiscovery,
  LocalModelClient,
  baseUrlFor,
  probeLocalRuntimes,
  readModelList,
  withLocalModels,
} from '../src/providers/local.js';
import type { ModelsPort, ModelsSnapshot } from '../src/wire.js';

/**
 * Local model discovery (M24).
 *
 * The two properties this file exists for:
 *
 *   1. **Finding nothing is normal, and normal is silent.** Most machines run
 *      none of these runtimes, so the no-runtime case must produce empty
 *      reports and no throw — every failure mode, not just a refused
 *      connection.
 *   2. **A port answering is not a runtime.** Ports 8000 and 8080 belong to
 *      whatever a developer started last. The controls below put an ordinary
 *      JSON API on one of them and require that it produces no models, next to
 *      a real model list on the same port that produces some.
 */

const NOTHING_LISTENING = () => Promise.reject(new Error('connect ECONNREFUSED'));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake network: a map from URL to whatever that URL answers. Anything else is refused. */
function network(routes: Record<string, () => Promise<Response>>) {
  const seen: string[] = [];
  const fetchLike = async (url: string): Promise<Response> => {
    seen.push(url);
    const route = routes[url];
    if (!route) return NOTHING_LISTENING() as Promise<Response>;
    return route();
  };
  return { seen, fetchLike };
}

function secrets(value: string | null = null): SecretsPort {
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
      return [];
    },
    describe() {
      return { kind: 'memory', label: 'test fixture', readableByOtherProcesses: false };
    },
  };
}

const OLLAMA = 'http://127.0.0.1:11434';
const LM_STUDIO = 'http://127.0.0.1:1234';
const LLAMA_CPP = 'http://127.0.0.1:8080';

describe('the runtime table', () => {
  it('names the four runtimes M24 asks for, on their documented ports', () => {
    expect(LOCAL_RUNTIME_SPECS.map((spec) => [spec.runtime, spec.defaultPort])).toEqual([
      ['ollama', 11434],
      ['lmstudio', 1234],
      ['llamacpp', 8080],
      ['vllm', 8000],
    ]);
  });

  it('addresses loopback by number, not by a name that may resolve elsewhere', () => {
    for (const spec of LOCAL_RUNTIME_SPECS) {
      expect(baseUrlFor(spec)).toBe(`http://127.0.0.1:${spec.defaultPort}/v1`);
    }
  });
});

describe('a machine with no local runtime', () => {
  it('reports nothing, throws nothing, and finds nothing', async () => {
    const reports = await probeLocalRuntimes({ fetch: NOTHING_LISTENING });
    expect(reports).toHaveLength(4);
    expect(reports.every((report) => !report.reachable)).toBe(true);
    expect(reports.flatMap((report) => report.models)).toEqual([]);
  });

  it('treats every kind of failure the same way — a 404, an HTML body, a hang-up', async () => {
    const { fetchLike } = network({
      [`${OLLAMA}/v1/models`]: async () => new Response('not found', { status: 404 }),
      [`${LM_STUDIO}/v1/models`]: async () => new Response('<html>hello</html>', { status: 200 }),
      [`${LLAMA_CPP}/v1/models`]: async () => {
        throw new Error('socket hang up');
      },
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike });
    expect(reports.flatMap((report) => report.models)).toEqual([]);
    expect(reports.every((report) => !report.reachable)).toBe(true);
  });
});

describe('telling a model server from whatever else is on that port', () => {
  it('accepts the OpenAI list shape, with the marker at the top level or on the entries', () => {
    expect(readModelList({ object: 'list', data: [{ id: 'qwen' }] })).toEqual(['qwen']);
    expect(readModelList({ data: [{ id: 'qwen', object: 'model' }] })).toEqual(['qwen']);
  });

  it('refuses everything that is not one', () => {
    // Each of these is a shape a real, unrelated service on port 8000 or 8080
    // could answer with. None of them may become a model.
    expect(readModelList({ items: [{ id: 'a' }] })).toBeNull();
    expect(readModelList({ data: [] })).toBeNull();
    expect(readModelList({ data: [{ name: 'a' }] })).toBeNull();
    expect(readModelList({ data: ['a'] })).toBeNull();
    expect(readModelList({ data: [{ id: '' }] })).toBeNull();
    expect(readModelList({ data: [{ id: 'ok' }] })).toBeNull();
    expect(readModelList({ status: 'ok', results: 3 })).toBeNull();
    expect(readModelList(null)).toBeNull();
    expect(readModelList('a string')).toBeNull();
  });

  it('does not turn a JSON API on port 8080 into llama.cpp', async () => {
    const { fetchLike } = network({
      // A perfectly ordinary paginated API. It has a `data` array. It is not a
      // model server, and the probe must not decide that it is.
      [`${LLAMA_CPP}/v1/models`]: async () =>
        jsonResponse({ data: [{ uuid: '1', title: 'first post' }], page: 1 }),
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike });
    const llamacpp = reports.find((report) => report.runtime === 'llamacpp');
    expect(llamacpp?.reachable).toBe(false);
    expect(llamacpp?.models).toEqual([]);
    expect(llamacpp?.detail).toContain('not treated as');
  });

  it('CONTROL: the same port answering a real model list is discovered', async () => {
    const { fetchLike } = network({
      [`${LLAMA_CPP}/v1/models`]: async () =>
        jsonResponse({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model' }] }),
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike, now: () => 0 });
    const llamacpp = reports.find((report) => report.runtime === 'llamacpp');
    expect(llamacpp?.reachable).toBe(true);
    expect(llamacpp?.models).toEqual([
      {
        id: 'qwen3-8b',
        provider: 'llamacpp',
        displayName: 'qwen3-8b',
        endpoint: 'http://127.0.0.1:8080/v1',
        // n_ctx_train is the training context, not the served window, so it is
        // not read — and nothing is invented in its place.
        contextTokens: null,
        capabilities: [],
        discoveredAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('what each runtime is asked for beyond the model list', () => {
  it('reads Ollama capabilities from /api/show and drops the ones that are not routing capabilities', async () => {
    const { fetchLike } = network({
      [`${OLLAMA}/v1/models`]: async () => jsonResponse({ object: 'list', data: [{ id: 'qwen3:8b' }] }),
      [`${OLLAMA}/api/show`]: async () =>
        jsonResponse({ capabilities: ['completion', 'tools', 'vision'], model_info: {} }),
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike });
    const ollama = reports.find((report) => report.runtime === 'ollama');
    // `completion` is not a capability the router branches on; `tools` and
    // `vision` are. An unrecognised name is dropped, never assumed.
    expect(ollama?.models[0]?.capabilities).toEqual(['tools', 'vision']);
  });

  it('leaves capabilities empty when /api/show cannot be read, because unknown is not yes', async () => {
    const { fetchLike } = network({
      [`${OLLAMA}/v1/models`]: async () => jsonResponse({ object: 'list', data: [{ id: 'qwen3:8b' }] }),
      [`${OLLAMA}/api/show`]: async () => new Response('nope', { status: 500 }),
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike });
    expect(reports.find((report) => report.runtime === 'ollama')?.models[0]?.capabilities).toEqual([]);
  });

  it('reads a context window from LM Studio, which is the one runtime that reports one', async () => {
    const { fetchLike } = network({
      [`${LM_STUDIO}/v1/models`]: async () => jsonResponse({ object: 'list', data: [{ id: 'qwen2-vl-7b' }] }),
      [`${LM_STUDIO}/api/v0/models`]: async () =>
        jsonResponse({ object: 'list', data: [{ id: 'qwen2-vl-7b', max_context_length: 32768 }] }),
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike });
    const model = reports.find((report) => report.runtime === 'lmstudio')?.models[0];
    expect(model?.contextTokens).toBe(32768);
    // Still no capabilities: LM Studio reports none, so tool support is unknown.
    expect(model?.capabilities).toEqual([]);
  });

  it('keeps the context window null when the native endpoint is not there', async () => {
    const { fetchLike } = network({
      [`${LM_STUDIO}/v1/models`]: async () => jsonResponse({ object: 'list', data: [{ id: 'qwen2-vl-7b' }] }),
    });
    const reports = await probeLocalRuntimes({ fetch: fetchLike });
    expect(reports.find((report) => report.runtime === 'lmstudio')?.models[0]?.contextTokens).toBeNull();
  });
});

describe('discovery caching', () => {
  function countingNetwork() {
    let probes = 0;
    const fetchLike = async (url: string): Promise<Response> => {
      if (url === `${OLLAMA}/v1/models`) {
        probes += 1;
        return jsonResponse({ object: 'list', data: [{ id: 'qwen3:8b' }] });
      }
      throw new Error('connect ECONNREFUSED');
    };
    return { fetchLike, probes: () => probes };
  }

  it('probes once inside the TTL and again after it', async () => {
    const { fetchLike, probes } = countingNetwork();
    let clock = 1_000;
    const discovery = new LocalDiscovery({ fetch: fetchLike, ttlMs: 500, now: () => clock });

    await discovery.models();
    await discovery.models();
    expect(probes()).toBe(1);

    clock += 600;
    await discovery.models();
    expect(probes()).toBe(2);
  });

  it('collapses concurrent callers onto one probe rather than opening the sockets twice', async () => {
    const { fetchLike, probes } = countingNetwork();
    const discovery = new LocalDiscovery({ fetch: fetchLike, now: () => 1_000 });
    await Promise.all([discovery.models(), discovery.models(), discovery.models()]);
    expect(probes()).toBe(1);
  });
});

describe('the local model client', () => {
  function withOllama() {
    const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
      if (url === `${OLLAMA}/v1/models`) {
        return jsonResponse({ object: 'list', data: [{ id: 'qwen3:8b' }] });
      }
      if (url === `${OLLAMA}/api/show`) return jsonResponse({ capabilities: ['tools'] });
      if (url === `${OLLAMA}/v1/chat/completions`) {
        return jsonResponse({
          choices: [{ message: { content: `answered ${String(init.method)}` }, finish_reason: 'stop' }],
        });
      }
      throw new Error('connect ECONNREFUSED');
    };
    return {
      discovery: new LocalDiscovery({ fetch: fetchLike, now: () => 1_000 }),
      // The same transport the probe used. `defaultProviderClients` passes one
      // `fetch` to every client it builds, which is what this mirrors.
      fetch: fetchLike,
    };
  }

  const candidate: ModelCandidate = {
    id: 'qwen3:8b',
    provider: 'ollama',
    contextTokens: 0,
    capabilities: ['tools'],
    free: true,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  };

  it('claims no provider until it has probed, and claims only what answered afterwards', async () => {
    const { discovery, fetch } = withOllama();
    const client = new LocalModelClient(discovery, secrets(), { fetch });
    expect(client.providers).toEqual([]);
    expect(await client.configured()).toBe(true);
    expect(client.providers).toEqual(['ollama']);
  });

  it('is not configured when nothing is running, which is the ordinary case', async () => {
    const client = new LocalModelClient(new LocalDiscovery({ fetch: NOTHING_LISTENING }), secrets());
    expect(await client.configured()).toBe(false);
    expect(client.providers).toEqual([]);
  });

  it('routes a candidate to the runtime that served it', async () => {
    const { discovery, fetch } = withOllama();
    const client = new LocalModelClient(discovery, secrets(), { fetch });
    await client.configured();
    const answer = await client.complete({
      model: candidate,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(answer.text).toBe('answered POST');
  });

  it('refuses a candidate for a runtime that is no longer there', async () => {
    const { discovery, fetch } = withOllama();
    const client = new LocalModelClient(discovery, secrets(), { fetch });
    await client.configured();
    const error = await client
      .complete({ model: { ...candidate, provider: 'vllm' }, messages: [{ role: 'user', content: 'hi' }] })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ModelClientError);
    expect((error as ModelClientError).outcome).toBe('provider-error');
  });
});

describe('serving local models beside the catalog', () => {
  const cataloguedSnapshot: ModelsSnapshot = {
    configured: true,
    source: 'OpenRouter model catalog (live)',
    verifiedAt: '2026-08-26T22:00:00.000Z',
    models: [{ id: 'z-ai/glm-5.2:free', provider: 'openrouter' }],
  };

  const inner: ModelsPort = {
    async snapshot() {
      return cataloguedSnapshot;
    },
    async candidates() {
      return [
        {
          id: 'z-ai/glm-5.2:free',
          provider: 'openrouter',
          contextTokens: 256_000,
          capabilities: ['tools'],
          free: true,
          pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        },
      ];
    },
  };

  function discoveryWith(id: string) {
    const fetchLike = async (url: string): Promise<Response> => {
      if (url === `${OLLAMA}/v1/models`) return jsonResponse({ object: 'list', data: [{ id }] });
      if (url === `${OLLAMA}/api/show`) return jsonResponse({ capabilities: ['tools'] });
      throw new Error('connect ECONNREFUSED');
    };
    return new LocalDiscovery({ fetch: fetchLike, now: () => 0 });
  }

  it('leaves the snapshot untouched when nothing is running locally', async () => {
    const port = withLocalModels(inner, new LocalDiscovery({ fetch: NOTHING_LISTENING }));
    expect(await port.snapshot()).toEqual(cataloguedSnapshot);
  });

  it('appends a local row marked local and carrying no pricing', async () => {
    const port = withLocalModels(inner, discoveryWith('qwen3:8b'));
    const snapshot = await port.snapshot();
    expect(snapshot.models).toHaveLength(2);
    expect(snapshot.models[1]).toMatchObject({
      id: 'qwen3:8b',
      provider: 'ollama',
      local: true,
      pricing: null,
      free: true,
      freeReason: LOCAL_FREE_REASON,
      // Unknown, and said so — a selector shows "unknown", not "0".
      contextTokens: null,
    });
    expect(snapshot.source).toContain('discovered locally');
    expect(snapshot.source.length).toBeLessThanOrEqual(200);
  });

  it('offers a local candidate beside a catalogued one, without merging the two', async () => {
    const port = withLocalModels(inner, discoveryWith('qwen3:8b'));
    const candidates = await port.candidates?.();
    expect(candidates?.map((entry) => [entry.id, entry.provider])).toEqual([
      ['z-ai/glm-5.2:free', 'openrouter'],
      ['qwen3:8b', 'ollama'],
    ]);
    // The router needs a number; an unreported window becomes the value that
    // fails a minimum-context requirement rather than a plausible invention.
    expect(candidates?.[1]?.contextTokens).toBe(UNKNOWN_CONTEXT_TOKENS);
  });

  it('does not collapse a local model that shares a catalogued name', async () => {
    const port = withLocalModels(inner, discoveryWith('z-ai/glm-5.2:free'));
    const candidates = (await port.candidates?.()) ?? [];
    expect(candidates).toHaveLength(2);
    expect(candidates.map((entry) => entry.provider)).toEqual(['openrouter', 'ollama']);
  });
});
