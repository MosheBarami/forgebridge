import { ModelRegistry, deriveFree, type CatalogModel } from '@forgebridge/model-registry';
import type { ModelCandidate } from '@forgebridge/core';
import type { ModelsPort, ModelsSnapshot } from './wire.js';

/**
 * The registry, wired in behind the port `wire.ts` declares.
 *
 * `ModelsPort` exists so the daemon serves whatever a registry returns without
 * containing any catalog logic itself, and that boundary is what this file
 * respects rather than crosses: everything below is a *projection* of the
 * synced snapshot onto the shape the router needs, and there is no ranking, no
 * pricing arithmetic and no freshness policy in it. Those belong to
 * `@forgebridge/model-registry` (M20) and ADR-007, and each one that leaked in
 * here would be a second opinion about the catalog that the catalog's own
 * package could not correct.
 *
 * Two facts are re-derived rather than read, both for ADR-007's reason:
 *
 *   - `free` comes from `deriveFree`, never from the catalog's stored `free`
 *     field. That field is a cache the sync wrote; trusting it would mean a
 *     hand-edited catalog could assert that a model billed per song costs
 *     nothing and this daemon would repeat the claim while spending money.
 *   - `expiringSoon` comes from the same derivation, so a model days from
 *     withdrawal sorts last in the router rather than vanishing mid-run.
 *
 * And one is deliberately absent: `medianLatencyMs`. Nothing here has measured
 * a latency, the catalog does not carry one, and a made-up number would make
 * the `fastest` policy claim an ordering it cannot support — which is exactly
 * what the router's own `note` says when nothing has been measured.
 */

/** One catalog row as the router sees it. Nothing is invented; unmeasured stays unmeasured. */
export function candidateFor(model: CatalogModel, now: Date = new Date()): ModelCandidate {
  const derivation = deriveFree(model, now);
  const candidate: ModelCandidate = {
    id: model.id,
    provider: model.provider,
    contextTokens: model.contextTokens,
    capabilities: model.capabilities,
    free: derivation.free,
    pricing: {
      inputPerMTok: model.pricing.inputPerMTok,
      outputPerMTok: model.pricing.outputPerMTok,
    },
    expiringSoon: derivation.expiringSoon,
  };
  if (model.expiresAt !== null) candidate.expiresAt = model.expiresAt;
  if (model.benchmarks) {
    // Null in the catalog means *unmeasured*, and the router's `ModelBenchmarks`
    // says the same thing with an absent field. Mapping null onto zero would
    // bury an unbenchmarked model beneath every model that was measured and
    // scored badly — the failure `rank` in the registry is written against.
    const benchmarks: NonNullable<ModelCandidate['benchmarks']> = {};
    if (model.benchmarks.intelligence !== null) benchmarks.intelligence = model.benchmarks.intelligence;
    if (model.benchmarks.coding !== null) benchmarks.coding = model.benchmarks.coding;
    if (model.benchmarks.agentic !== null) benchmarks.agentic = model.benchmarks.agentic;
    candidate.benchmarks = benchmarks;
  }
  return candidate;
}

export interface CatalogModelsOptions {
  registry?: ModelRegistry;
  now?: () => number;
}

export class CatalogModels implements ModelsPort {
  readonly #registry: ModelRegistry;
  readonly #now: () => number;

  constructor(options: CatalogModelsOptions = {}) {
    this.#registry = options.registry ?? ModelRegistry.load();
    this.#now = options.now ?? Date.now;
  }

  async snapshot(): Promise<ModelsSnapshot> {
    const catalog = this.#registry.catalog;
    const staleness = this.#registry.staleness(new Date(this.#now()));
    return {
      configured: true,
      // The snapshot's age is part of its provenance: a selector showing
      // sixteen models from a catalog nobody has synced in a month is showing
      // sixteen claims about a market that moves weekly (ADR-007).
      source: `${catalog.source}${staleness.stale ? ` (stale: synced ${Math.floor(staleness.ageDays)} days ago)` : ''}`.slice(0, 200),
      verifiedAt: catalog.syncedAt,
      models: catalog.models.map((model) => ({ ...model })),
    };
  }

  async candidates(): Promise<ModelCandidate[]> {
    const now = new Date(this.#now());
    // An expired model is not a candidate at all: it is a model the provider
    // has already withdrawn, and offering it would spend an attempt to learn
    // what the catalog already recorded.
    return this.#registry
      .all()
      .filter((model) => !deriveFree(model, now).expired)
      .map((model) => candidateFor(model, now));
  }
}
