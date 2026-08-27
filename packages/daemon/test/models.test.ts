import { describe, expect, it } from 'vitest';
import { CatalogModel, ModelRegistry } from '@forgebridge/model-registry';
import { CatalogModels, candidateFor } from '../src/models.js';

/**
 * The catalog, projected onto what the router reads.
 *
 * The two things worth pinning are the two ADR-007 is about: `free` is derived
 * from the price rather than read from the field that claims it, and a
 * benchmark nobody measured stays unmeasured instead of becoming a zero.
 */

const SYNCED_AT = '2026-08-01T00:00:00Z';

/** Parsed through the catalog's own schema, so a fixture cannot drift from it. */
function model(over: Record<string, unknown> = {}): CatalogModel {
  return CatalogModel.parse({
    id: 'vendor/model:free',
    provider: 'openrouter',
    author: 'vendor',
    displayName: 'Vendor Model (free)',
    contextTokens: 128_000,
    maxCompletionTokens: 8_192,
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: ['tools', 'structured_outputs'],
    pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'token' },
    free: true,
    freeReason: 'token-priced at 0 in/out; text output',
    benchmarks: { intelligence: 50, coding: null, agentic: null },
    moderated: false,
    expiresAt: null,
    ...over,
  });
}

function registryOf(models: readonly CatalogModel[]): ModelRegistry {
  return ModelRegistry.fromCatalog({
    generator: 'test',
    source: 'test fixture',
    syncedAt: SYNCED_AT,
    catalogTotal: models.length,
    models,
    excluded: [],
  });
}

describe('candidateFor', () => {
  it('derives `free` from the price rather than believing the field', () => {
    // A catalog row that asserts `free: true` and charges $2/M. The registry's
    // own rule is that this is derived, never asserted — including when the
    // assertion is our own file.
    const lying = candidateFor(
      model({ free: true, pricing: { inputPerMTok: 2, outputPerMTok: 4, unit: 'token' } }),
    );
    expect(lying.free).toBe(false);
    expect(lying.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 4 });
  });

  it('leaves an unmeasured benchmark unmeasured', () => {
    const candidate = candidateFor(model());
    expect(candidate.benchmarks).toEqual({ intelligence: 50 });
    expect(candidate.benchmarks?.coding).toBeUndefined();
  });

  it('reports a model close to withdrawal so the router can sort it last', () => {
    const soon = candidateFor(model({ expiresAt: '2026-08-10' }), new Date('2026-08-01T00:00:00Z'));
    expect(soon.expiringSoon).toBe(true);
    expect(soon.expiresAt).toBe('2026-08-10');
    expect(candidateFor(model()).expiringSoon).toBe(false);
  });

  it('never invents a latency', () => {
    // `fastest` ordering is only honest when something has been measured, and
    // nothing here has. The router says so in its own note; this must not
    // silently supply a number to order by.
    expect(candidateFor(model()).medianLatencyMs).toBeUndefined();
  });
});

describe('CatalogModels', () => {
  it('offers every model the provider has not withdrawn', async () => {
    const models = new CatalogModels({
      registry: registryOf([
        model({ id: 'vendor/live:free' }),
        model({ id: 'vendor/gone:free', expiresAt: '2026-07-01' }),
      ]),
      now: () => Date.parse('2026-08-05T00:00:00Z'),
    });

    expect((await models.candidates()).map((candidate) => candidate.id)).toEqual(['vendor/live:free']);
  });

  it('reports the snapshot\'s age as part of its provenance', async () => {
    const registry = registryOf([model()]);
    const fresh = new CatalogModels({ registry, now: () => Date.parse('2026-08-02T00:00:00Z') });
    expect((await fresh.snapshot()).source).toBe('test fixture');

    const old = new CatalogModels({ registry, now: () => Date.parse('2026-10-01T00:00:00Z') });
    const snapshot = await old.snapshot();
    expect(snapshot.source).toContain('stale');
    expect(snapshot.verifiedAt).toBe(SYNCED_AT);
    expect(snapshot.configured).toBe(true);
  });
});
