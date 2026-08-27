import type { CompletionEvent, CompletionRequest, CompletionResponse, SecretsPort } from '@forgebridge/core';
import { ModelClientError, type ModelCandidate } from '@forgebridge/core';
import {
  LOCAL_RUNTIMES,
  capabilitiesFromRuntime,
  localCandidate,
  localSnapshotRow,
  type Capability,
  type LocalModel,
  type LocalRuntime,
} from '@forgebridge/model-registry';
import type { ModelsPort, ModelsSnapshot, RunModelClient } from '../wire.js';
import {
  OpenAICompatibleClient,
  asArray,
  asNumber,
  asRecord,
  asString,
  type ProviderSpec,
} from './openai-compatible.js';

/**
 * Local model discovery (M24): probe the well-known loopback ports, and route to
 * whatever answered.
 *
 * Three rules shape everything below.
 *
 * **A probe that finds nothing is the normal case.** Most machines run none of
 * these. So every failure mode — connection refused, a timeout, a non-2xx, a
 * body that is not JSON, a body that is JSON but not a model list — produces the
 * same thing: no models, no throw, no log. `LocalProbeReport` records what
 * happened so a `--verbose` surface can show it if asked, and nothing on the
 * normal path ever reads it.
 *
 * **A port answering is not a runtime.** Ports 8000 and 8080 are the two most
 * contested numbers on a developer's machine, and reading whatever they return
 * as a model list is how a Django project becomes an inference provider. So a
 * response is only accepted when it has the shape of an OpenAI model list —
 * see `readModelList`, which fails closed on anything else, and the control
 * tests that pin both directions.
 *
 * **Nothing about a discovered model is invented.** A runtime that does not
 * report a context window leaves it null, and a runtime that does not report
 * capabilities leaves them empty — which means the router will not offer that
 * model for a ChangeSet run, because driving one needs `tools` and nothing said
 * this model has it. `@forgebridge/model-registry`'s `local.ts` carries the
 * reasoning for both.
 *
 * Endpoints and defaults were read from each runtime's own documentation; the
 * page is on the spec so a reviewer can check the row rather than trust it.
 */

/** Loopback by address, not by name: `localhost` resolves to ::1 first on some hosts. */
export const LOCAL_HOST = '127.0.0.1';

/**
 * Deliberately short. This runs before a run starts, four times, against ports
 * that are usually closed — a refused connection returns immediately, and this
 * bound only matters for a port that accepts and then says nothing.
 */
export const PROBE_TIMEOUT_MS = 1_500;

/** How long a probe result is reused before the ports are asked again. */
export const DISCOVERY_TTL_MS = 30_000;

export interface LocalRuntimeSpec {
  runtime: LocalRuntime;
  label: string;
  /** The port the runtime's own documentation gives as the default. */
  defaultPort: number;
  /** Path from the origin to the OpenAI-compatible root, no trailing slash. */
  openAiPath: string;
  docsUrl: string;
  /** What this runtime reports beyond the model list, and what it does not. */
  note: string;
}

export const LOCAL_RUNTIME_SPECS: readonly LocalRuntimeSpec[] = [
  {
    runtime: 'ollama',
    label: 'Ollama',
    defaultPort: 11434,
    openAiPath: '/v1',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    note:
      'The only runtime here that reports capabilities: POST /api/show answers a `capabilities` '
      + 'array, which is why an Ollama model can carry `tools` and the others cannot. It reports no '
      + 'context window this probe reads — /api/show returns a `model_info` object whose keys are '
      + 'architecture-prefixed, and guessing at their names is how a wrong context window gets '
      + 'published as a fact.',
  },
  {
    runtime: 'lmstudio',
    label: 'LM Studio',
    defaultPort: 1234,
    openAiPath: '/v1',
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    note:
      'Its native REST surface (GET /api/v0/models) reports `max_context_length` per model, which is '
      + 'the one context window any of these four runtimes hands over without being asked. No '
      + 'capability information, so tool support stays unknown.',
  },
  {
    runtime: 'llamacpp',
    label: 'llama.cpp server',
    defaultPort: 8080,
    openAiPath: '/v1',
    docsUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    note:
      'GET /v1/models carries a `meta.n_ctx_train`, which is the context the model was TRAINED at '
      + 'and not the window this server was started with (`-c` sets that, and can be smaller). '
      + 'Reading it as the context window would overstate what a run may send, so it is not read.',
  },
  {
    runtime: 'vllm',
    label: 'vLLM',
    defaultPort: 8000,
    openAiPath: '/v1',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    note:
      'Serves the OpenAI surface at /v1 on port 8000 by default. The fields of its model card '
      + 'beyond `id` are not documented on that page, so nothing beyond the id is read from it.',
  },
];

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What one probe of one runtime found, including when it found nothing. */
export interface LocalProbeReport {
  runtime: LocalRuntime;
  label: string;
  baseUrl: string;
  /** True when the runtime answered with something that is a model list. */
  reachable: boolean;
  models: LocalModel[];
  /**
   * Why, in words. Present on every report, including the successful ones, and
   * never logged by this module — a probe that found nothing is silent, and this
   * field exists so a surface that was *asked* can say what happened.
   */
  detail: string;
}

export interface ProbeOptions {
  fetch?: FetchLike;
  host?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Overrides the ports probed. Tests use it; so would an operator with a custom port. */
  specs?: readonly LocalRuntimeSpec[];
}

/** The OpenAI-compatible base URL for one runtime on one host. */
export function baseUrlFor(spec: LocalRuntimeSpec, host: string = LOCAL_HOST): string {
  return `http://${host}:${spec.defaultPort}${spec.openAiPath}`;
}

/**
 * Probe every runtime. Never throws, never logs, and resolves to one report per
 * runtime whether or not anything was there.
 */
export async function probeLocalRuntimes(options: ProbeOptions = {}): Promise<LocalProbeReport[]> {
  const specs = options.specs ?? LOCAL_RUNTIME_SPECS;
  return Promise.all(specs.map((spec) => probeRuntime(spec, options)));
}

async function probeRuntime(spec: LocalRuntimeSpec, options: ProbeOptions): Promise<LocalProbeReport> {
  const host = options.host ?? LOCAL_HOST;
  const baseUrl = baseUrlFor(spec, host);
  const empty = (detail: string): LocalProbeReport => ({
    runtime: spec.runtime,
    label: spec.label,
    baseUrl,
    reachable: false,
    models: [],
    detail,
  });

  const listed = await getJson(`${baseUrl}/models`, options);
  if (listed.error !== undefined) return empty(listed.error);

  const ids = readModelList(listed.value);
  if (ids === null) {
    // Something answered and it was not this runtime. Reported, not logged: on a
    // developer's machine port 8080 usually belongs to something else entirely.
    return empty(`answered, but not with an OpenAI model list — not treated as ${spec.label}`);
  }
  if (ids.length === 0) return empty(`answered with an empty model list`);

  const discoveredAt = new Date(options.now ? options.now() : Date.now()).toISOString();
  const contexts = await contextWindows(spec, host, options);
  const capabilities = await capabilitiesOf(spec, host, ids, options);

  const models: LocalModel[] = ids.map((id) => ({
    id,
    provider: spec.runtime,
    displayName: id,
    endpoint: baseUrl,
    contextTokens: contexts.get(id) ?? null,
    capabilities: capabilities.get(id) ?? [],
    discoveredAt,
  }));

  return {
    runtime: spec.runtime,
    label: spec.label,
    baseUrl,
    reachable: true,
    models,
    detail: `${models.length} model(s)`,
  };
}

/**
 * An OpenAI model list, or null for anything that is not one.
 *
 * The test is deliberately narrow, because the thing being distinguished is "a
 * model server" from "any JSON endpoint on a common port": the body must be an
 * object carrying a non-empty `data` array, every entry must be an object with a
 * non-empty string `id`, and the payload must identify itself as a list either
 * at the top level (`object: "list"`) or on every entry (`object: "model"`).
 * A body that fails any of those is not almost-a-model-list; it is somebody
 * else's API, and returning null for it is the whole point.
 */
export function readModelList(payload: unknown): string[] | null {
  const body = asRecord(payload);
  const data = body['data'];
  if (!Array.isArray(data) || data.length === 0) return null;

  const ids: string[] = [];
  let everyEntryIsAModel = true;
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    const id = asString(entry['id']);
    if (id === null || id.length === 0) return null;
    if (asString(entry['object']) !== 'model') everyEntryIsAModel = false;
    ids.push(id);
  }

  if (asString(body['object']) !== 'list' && !everyEntryIsAModel) return null;
  return ids;
}

/**
 * Context windows, for the one runtime that reports one.
 *
 * LM Studio's `GET /api/v0/models` carries `max_context_length` per model. The
 * other three are documented above: Ollama's is behind architecture-prefixed
 * keys this probe will not guess at, llama.cpp's is the *training* context
 * rather than the served window, and vLLM's model card fields are not documented
 * on the page this was written against. Where the runtime did not say, the
 * answer stays unknown.
 *
 * TODO(M24): llama.cpp's server exposes `/props`, and vLLM's model card is said
 * to carry `max_model_len`. Either would give a real served window for two more
 * runtimes — read the documentation for both before adding them, because a
 * context window read from the wrong field is a wrong number presented as an
 * observed one.
 */
async function contextWindows(
  spec: LocalRuntimeSpec,
  host: string,
  options: ProbeOptions,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (spec.runtime !== 'lmstudio') return out;

  const native = await getJson(`http://${host}:${spec.defaultPort}/api/v0/models`, options);
  if (native.error !== undefined) return out;

  for (const raw of asArray(asRecord(native.value)['data'])) {
    const entry = asRecord(raw);
    const id = asString(entry['id']);
    const context = asNumber(entry['max_context_length']);
    if (id !== null && context !== null && Number.isInteger(context) && context > 0) {
      out.set(id, context);
    }
  }
  return out;
}

/**
 * Capabilities, for the one runtime that reports them.
 *
 * Ollama's `POST /api/show` answers a `capabilities` array per model. Everything
 * else here reports nothing, and nothing is what those models get: an empty
 * capability list, which the router reads as "cannot be asked to call a tool".
 * A model that fails its own `/api/show` call is treated the same way — an
 * unreadable answer and an absent one say the same thing about what we know.
 */
async function capabilitiesOf(
  spec: LocalRuntimeSpec,
  host: string,
  ids: readonly string[],
  options: ProbeOptions,
): Promise<Map<string, Capability[]>> {
  const out = new Map<string, Capability[]>();
  if (spec.runtime !== 'ollama') return out;

  await Promise.all(
    ids.map(async (id) => {
      const shown = await getJson(`http://${host}:${spec.defaultPort}/api/show`, options, {
        method: 'POST',
        body: JSON.stringify({ model: id }),
      });
      if (shown.error !== undefined) return;
      const reported = asArray(asRecord(shown.value)['capabilities']);
      const mapped = capabilitiesFromRuntime(reported);
      if (mapped.length > 0) out.set(id, mapped);
    }),
  );
  return out;
}

/**
 * One request, with every failure folded into a string.
 *
 * This is the function that makes "found nothing" silent. Nothing below throws:
 * a refused connection, a timeout, a 404, a non-JSON body and a body that
 * happens to be `null` all come back as `{ error }`, and every caller treats
 * that as absence.
 */
async function getJson(
  url: string,
  options: ProbeOptions,
  init: { method?: string; body?: string } = {},
): Promise<{ value?: unknown; error?: string }> {
  const doFetch = options.fetch ?? ((target: string, request: RequestInit) => fetch(target, request));
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const method = init.method ?? 'GET';
  try {
    const response = await doFetch(url, {
      method,
      headers: init.body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { error: `answered ${response.status}` };
    return { value: await response.json() };
  } catch {
    // Deliberately unclassified. Whether the port was closed, the host was
    // unreachable or the body was malformed, the answer to "is a local runtime
    // here" is the same: no.
    return { error: 'nothing answered' };
  }
}

/**
 * The probe result, cached for `DISCOVERY_TTL_MS`.
 *
 * A run asks twice — once for candidates and once to route — and a developer
 * starting Ollama mid-session should not have to restart the daemon. A short
 * TTL is the compromise: four loopback connection attempts every thirty seconds
 * at most, and a runtime that went away is noticed within the same window.
 */
export class LocalDiscovery {
  #reports: LocalProbeReport[] = [];
  #lastProbedAt = 0;
  #inFlight: Promise<LocalProbeReport[]> | null = null;

  constructor(private readonly options: ProbeOptions & { ttlMs?: number } = {}) {}

  /** Probe if the cache is cold or stale; otherwise answer from it. */
  async reports(): Promise<LocalProbeReport[]> {
    const now = this.options.now ? this.options.now() : Date.now();
    const ttl = this.options.ttlMs ?? DISCOVERY_TTL_MS;
    if (this.#lastProbedAt !== 0 && now - this.#lastProbedAt < ttl) return this.#reports;
    // One probe at a time: two concurrent runs must not each open eight sockets.
    this.#inFlight ??= probeLocalRuntimes(this.options)
      .then((reports) => {
        this.#reports = reports;
        this.#lastProbedAt = this.options.now ? this.options.now() : Date.now();
        return reports;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  async models(): Promise<LocalModel[]> {
    return (await this.reports()).flatMap((report) => report.models);
  }

  /** Runtime → the base URL it answered on. Only the runtimes that answered. */
  async endpoints(): Promise<Map<LocalRuntime, string>> {
    const out = new Map<LocalRuntime, string>();
    for (const report of await this.reports()) {
      if (report.reachable) out.set(report.runtime, report.baseUrl);
    }
    return out;
  }
}

/**
 * A `RunModelClient` for whatever the probe found.
 *
 * `providers` is the set of runtimes that answered the last probe, so a daemon
 * with no local runtime running offers none and the run route never hands it a
 * candidate. Before the first probe the set is empty and `configured()` is
 * false, which is the fail-closed direction: an unprobed client claims nothing.
 *
 * The daemon asks `configured()` immediately before reading `providers` (see
 * `#requireModelClient` / `#candidatesFor` in `../server.ts`), and `configured()`
 * is what refreshes the set — so by the time the list is read it describes a
 * probe from at most `DISCOVERY_TTL_MS` ago.
 */
export class LocalModelClient implements RunModelClient {
  #providers: LocalRuntime[] = [];
  readonly #clients = new Map<LocalRuntime, OpenAICompatibleClient>();

  constructor(
    private readonly discovery: LocalDiscovery,
    private readonly secrets: SecretsPort,
    private readonly options: { fetch?: FetchLike; timeoutMs?: number } = {},
  ) {}

  get providers(): readonly string[] {
    return this.#providers;
  }

  /**
   * True when at least one runtime answered — which for a local runtime is the
   * whole of "can this client make a call". There is no credential to be
   * missing: Ollama documents the key as accepted and ignored, and llama.cpp's
   * is an opt-in server flag. A stored one is still sent, by the client below.
   */
  async configured(): Promise<boolean> {
    const endpoints = await this.discovery.endpoints();
    this.#providers = [...endpoints.keys()];
    for (const [runtime, baseUrl] of endpoints) {
      const existing = this.#clients.get(runtime);
      if (existing) continue;
      this.#clients.set(runtime, this.#clientFor(runtime, baseUrl));
    }
    for (const runtime of [...this.#clients.keys()]) {
      if (!endpoints.has(runtime)) this.#clients.delete(runtime);
    }
    return this.#providers.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return (await this.#route(request.model)).complete(request);
  }

  async *stream(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const client = await this.#route(request.model);
    // `stream` is optional on `ModelClient`; `OpenAICompatibleClient` always has
    // it, and this narrows rather than assumes.
    if (!client.stream) {
      yield { type: 'done', response: await client.complete(request) };
      return;
    }
    yield* client.stream(request);
  }

  async #route(model: ModelCandidate): Promise<OpenAICompatibleClient> {
    const runtime = LOCAL_RUNTIMES.find((name) => name === model.provider);
    const client = runtime ? this.#clients.get(runtime) : undefined;
    if (!client) {
      // Reached only if a candidate for a runtime that is no longer there was
      // routed here. Classified as a provider error rather than retried
      // silently: the model this run was told it would use is not available.
      throw new ModelClientError(
        'provider-error',
        `no local runtime is serving ${model.provider} — it was reachable when the catalog was built and is not now`,
      );
    }
    return client;
  }

  #clientFor(runtime: LocalRuntime, baseUrl: string): OpenAICompatibleClient {
    const spec = LOCAL_RUNTIME_SPECS.find((entry) => entry.runtime === runtime);
    const providerSpec: ProviderSpec = {
      provider: runtime,
      label: spec?.label ?? runtime,
      baseUrl,
      docsUrl: spec?.docsUrl ?? '',
      // Not a well-known variable anybody exports; a local runtime that wants a
      // key is configured with one the operator chose, stored under this
      // provider's own slug.
      wellKnownEnvVar: `FORGEBRIDGE_PROVIDER_${runtime.toUpperCase()}`,
      ...(spec?.note ? { note: spec.note } : {}),
    };
    return new OpenAICompatibleClient({
      spec: providerSpec,
      secrets: this.secrets,
      baseUrl,
      credential: 'optional',
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
    });
  }
}

/**
 * A `ModelsPort` that serves the catalog plus whatever is running locally.
 *
 * Local models are appended rather than merged: a catalogued model and a local
 * one with the same name are different models served by different providers, and
 * collapsing them would answer a question about one with the other's facts —
 * the same mistake `ModelRegistry.byId` refuses to make with the `:free` suffix.
 */
export function withLocalModels(inner: ModelsPort, discovery: LocalDiscovery): ModelsPort {
  return {
    async snapshot(): Promise<ModelsSnapshot> {
      const base = await inner.snapshot();
      const models = await discovery.models();
      if (models.length === 0) return base;
      return {
        ...base,
        // The provenance of the added rows, kept inside the protocol's 200-char
        // bound. A selector showing local models must be able to say where they
        // came from; they were not in any synced catalog.
        source: `${base.source} + ${models.length} discovered locally`.slice(0, 200),
        models: [...base.models, ...models.map(localSnapshotRow)],
      };
    },
    async candidates(): Promise<ModelCandidate[]> {
      const catalogued = inner.candidates ? await inner.candidates() : [];
      const local = (await discovery.models()).map(localCandidate);
      return [...catalogued, ...local];
    },
  };
}
