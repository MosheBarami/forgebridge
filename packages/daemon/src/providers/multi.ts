import {
  ModelClientError,
  type CompletionEvent,
  type CompletionRequest,
  type CompletionResponse,
  type ModelCandidate,
  type SecretsPort,
} from '@forgebridge/core';
import { OpenRouterClient } from '../openrouter.js';
import type { RunModelClient } from '../wire.js';
import { AnthropicClient } from './anthropic.js';
import { LocalDiscovery, LocalModelClient } from './local.js';
import { openAiCompatibleClients } from './openai-compatible.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One `RunModelClient` over several adapters, dispatching by the candidate's
 * provider.
 *
 * The daemon holds a single model client (`../server.ts`), and M22 gives it more
 * than one provider to reach. This is the seam that reconciles those without the
 * server learning what a provider is.
 *
 * **`providers` reports what is configured, not what exists**, and that is the
 * whole design. The run route filters the candidate list by this list before
 * routing, so listing an adapter whose credential is missing would put its
 * models into the fallback chain to fail one at a time — writing identical
 * `provider-error` attempts into the run log and opening the breaker on a
 * provider that was never down. That is the exact failure `configured()` exists
 * to prevent, and a composite that reported the union would reintroduce it.
 *
 * **Before the first `configured()` call the list is empty**, so an unrefreshed
 * composite claims nothing and a run against it is refused with
 * `provider_unconfigured` rather than routed into an adapter nobody has checked.
 * The daemon calls `configured()` immediately before reading `providers`, which
 * is what keeps the list current; the fail-closed default is what makes any
 * other caller safe.
 *
 * **An adapter whose `configured()` throws is treated exactly as one that said
 * no.** "I could not find out" and "yes" must never be the same answer — the
 * rule the sponsored-run gate in `apps/relay` is built on, applied here: a
 * keychain that times out must not silently promote its provider into the
 * routing set.
 */
export class MultiProviderClient implements RunModelClient {
  #configured: string[] = [];

  constructor(readonly clients: readonly RunModelClient[]) {}

  /** The providers whose adapters answered `configured()` at the last refresh. */
  get providers(): readonly string[] {
    return this.#configured;
  }

  /**
   * Refresh the configured set, and report whether anything at all can be
   * reached. Every adapter is asked, in parallel, and each answer stands only
   * for itself.
   */
  async configured(): Promise<boolean> {
    const answers = await Promise.all(
      this.clients.map(async (client) => {
        try {
          return (await client.configured()) ? client.providers : [];
        } catch {
          // Unreachable backend, throwing keychain, adapter bug — all of them
          // mean the same thing here, which is that this provider is not known
          // to be usable.
          return [];
        }
      }),
    );

    const seen = new Set<string>();
    const configured: string[] = [];
    for (const providers of answers) {
      for (const provider of providers) {
        if (seen.has(provider)) continue;
        seen.add(provider);
        configured.push(provider);
      }
    }
    this.#configured = configured;
    return configured.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.#route(request.model).complete(request);
  }

  async *stream(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const client = this.#route(request.model);
    if (!client.stream) {
      // An adapter without streaming still owes the caller a `done` carrying the
      // whole response, which is what the port promises.
      yield { type: 'done', response: await client.complete(request) };
      return;
    }
    yield* client.stream(request);
  }

  /**
   * The adapter for a candidate's provider.
   *
   * Searched across every adapter rather than only the configured ones: an
   * adapter that has lost its credential since the last refresh should refuse
   * with its own message ("no OpenAI credential is configured"), which is more
   * use than this class's generic one. Two adapters claiming one provider is a
   * wiring mistake; the first wins, deterministically, rather than the request
   * going to whichever the iteration order happened to reach.
   */
  #route(model: ModelCandidate): RunModelClient {
    const client = this.clients.find((entry) => entry.providers.includes(model.provider));
    if (!client) {
      throw new ModelClientError(
        'provider-error',
        `this daemon has no adapter for provider ${model.provider}, so ${model.id} cannot be called`,
      );
    }
    return client;
  }
}

export interface DefaultClientOptions {
  /** Include the locally-discovered runtimes (M24). Off unless asked for. */
  local?: LocalDiscovery;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Every adapter this package ships, in one composite.
 *
 * Order is the routing order for a provider claimed twice, and there is no such
 * provider here: OpenRouter, the six direct OpenAI-compatible providers,
 * Anthropic, and — only when a `LocalDiscovery` is passed — whatever is running
 * on this machine.
 *
 * TODO(M22): nothing calls this yet. `../bin.ts` wires `new OpenRouterClient(…)`
 * directly, so a daemon started from the shipped binary still reaches exactly
 * one provider. Swapping that line for this function is the whole of the wiring,
 * and it belongs to whoever owns the composition root.
 *
 * TODO(M22): the shipped catalog contains only `openrouter` rows —
 * `scripts/sync-catalog.ts` reads the OpenRouter catalog and nothing else — so
 * even once this is wired, the run route will filter every direct provider out
 * for want of a candidate served by it. These adapters are reachable and tested;
 * they are not yet *routable*. Making them so means teaching the sync script to
 * emit rows for the direct providers, with the capability metadata the router
 * filters on. That is a change to `scripts/sync-catalog.ts`, not to this file.
 */
export function defaultProviderClients(
  secrets: SecretsPort,
  options: DefaultClientOptions = {},
): MultiProviderClient {
  const shared = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const clients: RunModelClient[] = [
    new OpenRouterClient({ secrets, ...shared }),
    ...openAiCompatibleClients(secrets, shared),
    new AnthropicClient({ secrets, ...shared }),
  ];
  if (options.local) clients.push(new LocalModelClient(options.local, secrets, shared));
  return new MultiProviderClient(clients);
}
