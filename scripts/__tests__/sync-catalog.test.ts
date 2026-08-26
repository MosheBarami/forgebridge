import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { classifyModels, perMillion, renderCatalog, toDerivable } from '../sync-catalog.js';
import { FREE_REASON } from '../../packages/model-registry/src/derive.js';
import { CatalogModel, Catalog as CatalogSchema } from '../../packages/model-registry/src/types.js';

/**
 * The seam between this script and `@forgebridge/model-registry`.
 *
 * The script decides which models are free; the registry re-derives that verdict on every
 * read and refuses a catalog it cannot parse. Both halves were written against the same
 * ADR and can still disagree about a *shape* — and the failure mode of disagreeing is not
 * a crash, it is a plausible-looking catalog with the wrong models in it. These tests are
 * pointed at that seam rather than at either half's internals.
 */

const CATALOG_PATH = fileURLToPath(
  new URL('../../packages/model-registry/data/catalog.json', import.meta.url),
);

type Raw = Record<string, unknown>;

function rawModel(overrides: Partial<Raw> & { id: string }): Raw {
  return {
    name: 'Test Model',
    context_length: 128_000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'tool_choice', 'structured_outputs', 'temperature'],
    pricing: { prompt: '0', completion: '0', request: '0' },
    top_provider: { max_completion_tokens: 32_768, is_moderated: false },
    ...overrides,
  };
}

/** OpenRouter's own field for "this model bills per song", flattened into the payload. */
function pricedPerUnit(id: string, unit: string, usd: string, outputModality: string): Raw {
  return rawModel({
    id,
    architecture: { input_modalities: ['text'], output_modalities: [outputModality] },
    supported_parameters: [],
    pricing: { prompt: '0', completion: '0', [unit]: usd },
  });
}

describe('toDerivable — the shape deriveFree actually judges', () => {
  it('converts token prices per million and names the unit', () => {
    const raw = rawModel({ id: 'a/b', pricing: { prompt: '0.0000016', completion: '0.000008' } });
    expect(toDerivable(raw, raw['pricing'] as Record<string, string>)).toEqual({
      pricing: { inputPerMTok: 1.6, outputPerMTok: 8, unit: 'token', perUnitUsd: null },
      outputModalities: ['text'],
      expiresAt: null,
    });
  });

  it('carries a non-token charge through as a number, not as prose', () => {
    const raw = pricedPerUnit('g/lyria', 'song', '0.08', 'audio');
    const derivable = toDerivable(raw, raw['pricing'] as Record<string, string>);
    expect(derivable?.pricing.perUnitUsd).toBe(0.08);
  });

  it('is null — not a guess — when a price cannot be read as a number', () => {
    const raw = rawModel({ id: 'a/b', pricing: { prompt: 'free', completion: '0' } });
    expect(toDerivable(raw, raw['pricing'] as Record<string, string>)).toBeNull();
  });
});

describe('classifyModels — the free list', () => {
  it('lists a token-priced, text-only, tool-capable model as free', () => {
    const catalog = classifyModels([rawModel({ id: 'z-ai/glm-5.2:free' })], null);

    expect(catalog.models.map((model) => model.id)).toEqual(['z-ai/glm-5.2:free']);
    expect(catalog.excluded).toEqual([]);
    const [model] = catalog.models;
    expect(model?.free).toBe(true);
    // Verbatim from the registry's rule. A drifted copy of this string here would be the
    // first sign that the two halves had stopped agreeing on what "free" means.
    expect(model?.freeReason).toBe(FREE_REASON);
  });

  /**
   * The regression this file exists for. `deriveFree` judges a catalog row; passing it
   * the raw provider payload made every model read as "billed per undefined, not per
   * token", which silently emptied the free list rather than failing.
   */
  it('does not report every model as paid', () => {
    const catalog = classifyModels(
      [rawModel({ id: 'a/one' }), rawModel({ id: 'a/two' }), rawModel({ id: 'a/three' })],
      null,
    );
    expect(catalog.models).toHaveLength(3);
  });

  it('excludes the per-unit-priced media model a price === 0 check would have shipped', () => {
    const catalog = classifyModels([pricedPerUnit('google/lyria-3-pro-preview', 'song', '0.08', 'audio')], null);

    expect(catalog.models).toEqual([]);
    expect(catalog.excluded).toEqual([
      {
        id: 'google/lyria-3-pro-preview',
        reason: 'per-unit-pricing',
        detail:
          "Reports $0/M tokens but is billed $0.08 per song. Token price is not this model's price.",
      },
    ]);
  });

  it('excludes a genuinely free model that cannot call tools', () => {
    const catalog = classifyModels(
      [rawModel({ id: 'nvidia/guardrail:free', supported_parameters: ['temperature'] })],
      null,
    );

    expect(catalog.models).toEqual([]);
    expect(catalog.excluded[0]).toMatchObject({ id: 'nvidia/guardrail:free', reason: 'no-tool-calling' });
  });

  it('leaves an ordinary paid model out of both lists', () => {
    const catalog = classifyModels(
      [rawModel({ id: 'a/paid', pricing: { prompt: '0.000003', completion: '0.000015' } })],
      null,
    );

    expect(catalog.models).toEqual([]);
    expect(catalog.excluded).toEqual([]);
    expect(catalog.catalogTotal).toBe(1);
  });

  it('refuses to call a model free when its price will not parse', () => {
    const catalog = classifyModels([rawModel({ id: 'a/b', pricing: { prompt: 'n/a', completion: '0' } })], null);
    expect(catalog.models).toEqual([]);
  });

  it('produces rows the registry will accept', () => {
    const catalog = classifyModels(
      [rawModel({ id: 'a/one' }), rawModel({ id: 'a/two', context_length: 1_048_576 })],
      null,
    );
    for (const model of catalog.models) {
      expect(CatalogModel.safeParse(model).success).toBe(true);
    }
  });
});

describe('perMillion', () => {
  it('shifts the decimal point instead of multiplying, so no float noise reaches the diff', () => {
    expect(perMillion('0.0000016')).toBe(1.6);
    // 0.0000016 * 1e6 is 1.5999999999999999 in binary floating point.
    expect(String(perMillion('0.0000016'))).toBe('1.6');
    expect(perMillion('0')).toBe(0);
    expect(perMillion('1e-6')).toBe(1);
  });
});

describe('the committed snapshot', () => {
  const raw = readFileSync(CATALOG_PATH, 'utf8');

  it('is what this script would render — the format is a contract, not a preference', () => {
    const parsed = JSON.parse(raw) as {
      syncedAt: string;
      catalogTotal: number;
      models: never[];
      excluded: never[];
    };
    const rendered = renderCatalog(
      { catalogTotal: parsed.catalogTotal, models: parsed.models, excluded: parsed.excluded },
      parsed.syncedAt,
    );
    // Byte-for-byte: `--check` compares rendered output against the committed file, so a
    // renderer that drifts by one space makes the drift job fail on every run forever.
    expect(rendered).toBe(raw);
  });

  it('parses against the schema the registry loads it with', () => {
    expect(CatalogSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  });
});
