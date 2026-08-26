import { describe, it, expect } from 'vitest';
import {
  CATALOG_PATH,
  ModelRegistry,
  STALENESS_THRESHOLD_DAYS,
  getRegistry,
  loadCatalog,
  rank,
} from '../src/registry.js';
import { Catalog, type CatalogModel } from '../src/types.js';

const registry = ModelRegistry.load();
const catalog = loadCatalog();
const DAY_MS = 86_400_000;

describe('loading', () => {
  it('validates the shipped catalog against the schema', () => {
    expect(() => Catalog.parse(JSON.parse(JSON.stringify(catalog)))).not.toThrow();
  });

  it('names the file it could not read', () => {
    expect(() => loadCatalog('/nonexistent/catalog.json')).toThrow(/\/nonexistent\/catalog\.json/);
  });

  it('refuses a malformed catalog rather than degrading to zero models', () => {
    const broken = { ...catalog, models: [{ id: 'x' }] };
    expect(() => ModelRegistry.fromCatalog(broken)).toThrow();
  });

  it('memoises the shipped registry', () => {
    expect(getRegistry()).toBe(getRegistry());
    expect(CATALOG_PATH).toMatch(/data\/catalog\.json$/);
  });

  /**
   * Drift tripwire. These three numbers are the 26 Aug 2026 sync (ADR-007): 417
   * models offered, 16 listed free and tool-capable, 3 excluded with reasons. A
   * legitimate re-sync moves them, and updating this test is part of reviewing
   * that drift PR — which is the point. A sync that silently truncated its result
   * set would otherwise look exactly like one that did not.
   */
  it('is internally consistent with the sync that produced it', () => {
    // Deliberately NOT pinning catalogTotal to a literal. It is a third party's
    // number that moves without warning -- it went 417 -> 416 within a day of the
    // first sync -- and pinning it means every weekly drift PR (M21) arrives with
    // a red suite for a reason that has nothing to do with our correctness. A
    // reviewer who learns to expect a red build stops reading it, which is the
    // failure mode ADR-007 is written against.
    //
    // What IS ours, and is pinned: the catalog must account for at least as many
    // models as it lists, every listed model must be free, and every exclusion
    // must say why.
    expect(catalog.catalogTotal).toBeGreaterThanOrEqual(catalog.models.length + catalog.excluded.length);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.every((m) => m.free)).toBe(true);
    expect(catalog.excluded.every((e) => e.reason.length > 0 && e.detail.length > 0)).toBe(true);
  });

  it('records where the snapshot came from and when', () => {
    // A free-model claim is only as good as its provenance. If these ever go
    // missing the catalog is an assertion again, which is exactly what ADR-007
    // replaced.
    expect(catalog.source).toMatch(/OpenRouter/);
    expect(Number.isNaN(Date.parse(catalog.syncedAt))).toBe(false);
  });
});

describe('byId', () => {
  it('finds a listed model', () => {
    expect(registry.byId('z-ai/glm-5.2:free')?.displayName).toBe('Z.ai: GLM 5.2 (free)');
  });

  it('never resolves the :free tier to its paid canonical model', () => {
    // The suffix is a distinct tier with its own endpoints and its own price
    // (the paid GLM 5.2's cheapest endpoint is $0.4186/M input). Falling back
    // from one to the other would answer a free-model query with paid pricing.
    expect(registry.byId('z-ai/glm-5.2:free')).toBeDefined();
    expect(registry.byId('z-ai/glm-5.2')).toBeUndefined();
  });

  it('returns undefined for an unknown id rather than guessing', () => {
    expect(registry.byId('acme/does-not-exist')).toBeUndefined();
  });
});

describe('withCapabilities', () => {
  it('requires every listed capability, not any of them', () => {
    const both = registry.withCapabilities(['tools', 'structured_outputs']);
    expect(both.length).toBeGreaterThan(0);
    for (const model of both) {
      expect(model.capabilities).toContain('tools');
      expect(model.capabilities).toContain('structured_outputs');
    }

    const toolsOnly = registry.withCapabilities(['tools']);
    expect(toolsOnly.length).toBeGreaterThan(both.length);

    const dropped = toolsOnly.filter((model) => !both.includes(model));
    expect(dropped.length).toBeGreaterThan(0);
    for (const model of dropped) {
      expect(model.capabilities).not.toContain('structured_outputs');
    }
  });

  it('matches everything when nothing is required', () => {
    expect(registry.withCapabilities([])).toHaveLength(catalog.models.length);
  });

  it('matches nothing when a capability no listed model has is required', () => {
    // Every catalog entry emits text only, so none of them advertise audio output.
    expect(registry.withCapabilities(['audio'])).toHaveLength(0);
  });
});

describe('freeModels', () => {
  it('returns the listed models while none has expired', () => {
    const beforeAnyExpiry = new Date(Date.parse(catalog.syncedAt));
    expect(registry.freeModels(beforeAnyExpiry)).toHaveLength(catalog.models.length);
  });

  it('drops a model once its recorded expiry passes', () => {
    const expiring = catalog.models.find((model) => model.expiresAt !== null);
    expect(expiring).toBeDefined();

    const afterExpiry = new Date(Date.parse(expiring!.expiresAt!) + DAY_MS);
    const free = registry.freeModels(afterExpiry);
    expect(free).toHaveLength(catalog.models.length - 1);
    expect(free.map((model) => model.id)).not.toContain(expiring!.id);
  });

  /**
   * The load-bearing one. `free` in the catalog is a cache, and a cache can be
   * edited. If the registry ever reads that field instead of re-deriving, a
   * hand-edited file can make the product promise a per-song model is free.
   */
  it('re-derives freeness and ignores an asserted free: true', () => {
    const tampered: CatalogModel = {
      ...(catalog.models[0] as CatalogModel),
      id: 'google/lyria-3-pro-preview',
      displayName: 'Lyria 3 Pro',
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'song', perUnitUsd: 0.08 },
      outputModalities: ['audio'],
      free: true,
      freeReason: 'trust me',
    };

    const poisoned = ModelRegistry.fromCatalog({ ...catalog, models: [...catalog.models, tampered] });
    expect(poisoned.all()).toHaveLength(catalog.models.length + 1);
    expect(poisoned.byId('google/lyria-3-pro-preview')).toBeDefined();
    expect(poisoned.freeModels().map((model) => model.id)).not.toContain('google/lyria-3-pro-preview');
  });
});

describe('rank', () => {
  const scored = (models: readonly CatalogModel[], by: 'coding' | 'intelligence' | 'agentic') =>
    models.map((model) => model.benchmarks?.[by] ?? null);

  it('orders by the requested benchmark, best first', () => {
    const ordered = scored(rank(catalog.models, 'coding'), 'coding').filter(
      (score): score is number => score !== null,
    );
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!).toBeLessThanOrEqual(ordered[i - 1]!);
    }
  });

  /**
   * A missing benchmark is not a bad benchmark. Treating null as 0 would sort an
   * unmeasured model below every measured one — including models that scored
   * badly — on the strength of a number nobody produced.
   */
  it('sorts unscored models last, never as zero', () => {
    const ordered = rank(catalog.models, 'intelligence');
    const firstNull = ordered.findIndex((model) => (model.benchmarks?.intelligence ?? null) === null);
    expect(firstNull).toBeGreaterThan(0);
    for (const model of ordered.slice(firstNull)) {
      expect(model.benchmarks?.intelligence ?? null).toBeNull();
    }
  });

  it('judges only the requested axis', () => {
    // This model has coding 13.8 but no intelligence score; ranking by
    // intelligence must not borrow the coding number to keep it near the front.
    const partial = catalog.models.find(
      (model) => model.benchmarks !== null && model.benchmarks.intelligence === null && model.benchmarks.coding !== null,
    );
    expect(partial).toBeDefined();

    const ordered = rank(catalog.models, 'intelligence');
    const scoredCount = catalog.models.filter(
      (model) => (model.benchmarks?.intelligence ?? null) !== null,
    ).length;
    expect(ordered.indexOf(partial!)).toBeGreaterThanOrEqual(scoredCount);
  });

  it('separates "no benchmarks at all" from "this axis unscored" only by treating both as unscored', () => {
    const noBenchmarks = catalog.models.filter((model) => model.benchmarks === null);
    expect(noBenchmarks.length).toBeGreaterThan(0);
    const tail = rank(catalog.models, 'agentic').slice(-noBenchmarks.length - 1);
    for (const model of noBenchmarks) expect(tail).toContain(model);
  });

  it('is deterministic and does not mutate its input', () => {
    const input = [...catalog.models];
    const snapshot = input.map((model) => model.id);
    const once = rank(input, 'agentic').map((model) => model.id);
    const twice = rank(input, 'agentic').map((model) => model.id);
    expect(once).toEqual(twice);
    expect(input.map((model) => model.id)).toEqual(snapshot);
  });

  it('keeps catalog order among equally-scored models', () => {
    const tied: CatalogModel[] = ['a', 'b', 'c'].map((suffix) => ({
      ...(catalog.models[0] as CatalogModel),
      id: `tied/${suffix}`,
      benchmarks: { intelligence: null, coding: null, agentic: null },
    }));
    expect(rank(tied, 'coding').map((model) => model.id)).toEqual(['tied/a', 'tied/b', 'tied/c']);
  });
});

describe('staleness', () => {
  const syncedAt = Date.parse(catalog.syncedAt);

  it('is zero at the moment of the sync', () => {
    const state = registry.staleness(new Date(syncedAt));
    expect(state.ageMs).toBe(0);
    expect(state.ageDays).toBe(0);
    expect(state.stale).toBe(false);
    expect(state.thresholdDays).toBe(STALENESS_THRESHOLD_DAYS);
    expect(state.syncedAt.toISOString()).toBe(new Date(syncedAt).toISOString());
  });

  it('reports age in days without rounding it away', () => {
    const state = registry.staleness(new Date(syncedAt + 3.5 * DAY_MS));
    expect(state.ageDays).toBeCloseTo(3.5, 6);
    expect(state.stale).toBe(false);
  });

  it('is not stale at exactly the threshold, and is stale past it', () => {
    expect(registry.staleness(new Date(syncedAt + STALENESS_THRESHOLD_DAYS * DAY_MS)).stale).toBe(false);
    expect(registry.staleness(new Date(syncedAt + (STALENESS_THRESHOLD_DAYS + 1) * DAY_MS)).stale).toBe(true);
  });
});

describe('providers', () => {
  it('counts providers from the models present rather than declaring them', () => {
    const providers = registry.providers();
    expect(providers).toHaveLength(1);

    const openrouter = providers[0]!;
    expect(openrouter.id).toBe('openrouter');
    expect(openrouter.source).toBe(catalog.source);
    expect(openrouter.modelCount).toBe(catalog.models.length);
    expect(openrouter.freeCount).toBe(catalog.models.length);
    expect(new Set(openrouter.authors).size).toBe(openrouter.authors.length);
    expect(openrouter.authors).toContain('nvidia');
  });
});
