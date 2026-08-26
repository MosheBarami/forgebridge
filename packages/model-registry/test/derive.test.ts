import { describe, it, expect } from 'vitest';
import { deriveFree, EXPIRING_SOON_DAYS, FREE_REASON, type DerivableModel } from '../src/derive.js';
import { loadCatalog } from '../src/registry.js';

const catalog = loadCatalog();
const DAY_MS = 86_400_000;

const excludedFor = (id: string) => {
  const entry = catalog.excluded.find((model) => model.id === id);
  expect(entry, `${id} is no longer in the catalog's excluded list`).toBeDefined();
  return entry!;
};

describe('deriveFree — the per-unit-pricing counterexample', () => {
  /**
   * The case that forces the rule to be more than a price check. Both facts in
   * the fixture below are asserted against the catalog's own recorded detail
   * first, so this stays a test about the real model rather than an invented one:
   * if a re-sync changes what Lyria charges, this fails and a human updates both.
   */
  it('refuses google/lyria-3-pro-preview, which reports $0/M tokens and bills $0.08 per song', () => {
    const excluded = excludedFor('google/lyria-3-pro-preview');
    expect(excluded.reason).toBe('per-unit-pricing');
    expect(excluded.detail).toContain('$0/M tokens');
    expect(excluded.detail).toContain('$0.08 per generated song');

    const lyria: DerivableModel = {
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'song', perUnitUsd: 0.08 },
      outputModalities: ['audio'],
      expiresAt: null,
    };

    // The trap is real: the naive rule really does say "free" here.
    const naiveRule = lyria.pricing.inputPerMTok === 0 && lyria.pricing.outputPerMTok === 0;
    expect(naiveRule).toBe(true);

    // And the actual rule does not fall into it.
    const derived = deriveFree(lyria);
    expect(derived.free).toBe(false);
    expect(derived.reason).toContain('per song');
  });

  it('refuses google/lyria-3-clip-preview, billed $0.04 per 30-second clip', () => {
    const excluded = excludedFor('google/lyria-3-clip-preview');
    expect(excluded.reason).toBe('per-unit-pricing');
    expect(excluded.detail).toContain('$0.04 per 30-second clip');

    const derived = deriveFree({
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'clip', perUnitUsd: 0.04 },
      outputModalities: ['audio'],
      expiresAt: null,
    });
    expect(derived.free).toBe(false);
  });

  it('refuses any non-token billing unit, including ones nobody has seen yet', () => {
    for (const unit of ['request', 'image', 'song', 'clip', 'per-hologram']) {
      const derived = deriveFree({
        pricing: { inputPerMTok: 0, outputPerMTok: 0, unit },
        outputModalities: ['text'],
        expiresAt: null,
      });
      expect(derived.free, `unit "${unit}" must not derive as free`).toBe(false);
    }
  });

  it('refuses a token-priced model that also carries a per-unit charge', () => {
    const derived = deriveFree({
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'token', perUnitUsd: 0.01 },
      outputModalities: ['text'],
      expiresAt: null,
    });
    expect(derived.free).toBe(false);
  });
});

describe('deriveFree — the token-price clauses', () => {
  const tokenPriced = (inputPerMTok: number, outputPerMTok: number): DerivableModel => ({
    pricing: { inputPerMTok, outputPerMTok, unit: 'token' },
    outputModalities: ['text'],
    expiresAt: null,
  });

  it('requires both rates to be zero', () => {
    expect(deriveFree(tokenPriced(0, 0)).free).toBe(true);
    expect(deriveFree(tokenPriced(0.4186, 0)).free).toBe(false);
    expect(deriveFree(tokenPriced(0, 1.25)).free).toBe(false);
    expect(deriveFree(tokenPriced(0.4186, 1.25)).free).toBe(false);
  });

  it('requires text-only output, not merely text-inclusive output', () => {
    const withOutputs = (outputModalities: string[]): DerivableModel => ({
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'token' },
      outputModalities,
      expiresAt: null,
    });
    expect(deriveFree(withOutputs(['text'])).free).toBe(true);
    expect(deriveFree(withOutputs(['audio'])).free).toBe(false);
    expect(deriveFree(withOutputs(['text', 'image'])).free).toBe(false);
  });

  it('judges output modality, not input modality', () => {
    const multimodalIn = catalog.models.find((model) => model.inputModalities.length > 1);
    expect(multimodalIn).toBeDefined();
    expect(multimodalIn!.outputModalities).toEqual(['text']);
    expect(deriveFree(multimodalIn!).free).toBe(true);
  });
});

describe('deriveFree — expiry', () => {
  /** The catalog's one expiring entry, found rather than hardcoded. */
  const expiring = catalog.models.find((model) => model.expiresAt !== null);
  const expiresAt = expiring?.expiresAt ?? null;

  it('the catalog still carries an expiring model to test against', () => {
    expect(expiring).toBeDefined();
    expect(expiresAt).not.toBeNull();
  });

  /**
   * `now` is injected everywhere below. Reading the wall clock would make these
   * assertions flip on a calendar date, which is a test that fails for a reason
   * having nothing to do with the code.
   */
  const at = (offsetDays: number) => new Date(Date.parse(expiresAt!) + offsetDays * DAY_MS);

  it('does not flag a model further out than the window', () => {
    const derived = deriveFree(expiring!, at(-(EXPIRING_SOON_DAYS + 1)));
    expect(derived.expiringSoon).toBe(false);
    expect(derived.expired).toBe(false);
    expect(derived.free).toBe(true);
  });

  it('flags a model exactly at the window boundary, and inside it', () => {
    expect(deriveFree(expiring!, at(-EXPIRING_SOON_DAYS)).expiringSoon).toBe(true);
    expect(deriveFree(expiring!, at(-1)).expiringSoon).toBe(true);
  });

  it('reports expiry from the start of the named day, not the end', () => {
    const derived = deriveFree(expiring!, at(0));
    expect(derived.expired).toBe(true);
    expect(derived.expiringSoon).toBe(false);
  });

  it('keeps expiry out of the freeness claim', () => {
    // An expired model is still a free model; it is an unavailable one. Folding
    // the two together would make `reason` explain the wrong thing.
    const derived = deriveFree(expiring!, at(365));
    expect(derived.expired).toBe(true);
    expect(derived.free).toBe(true);
    expect(derived.reason).toBe(FREE_REASON);
  });

  it('treats a model with no expiry as neither expiring nor expired', () => {
    const derived = deriveFree({
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'token' },
      outputModalities: ['text'],
      expiresAt: null,
    });
    expect(derived.expiringSoon).toBe(false);
    expect(derived.expired).toBe(false);
  });
});

describe('deriveFree — round trip against the shipped catalog', () => {
  it('re-derives every listed model to exactly what the sync recorded', () => {
    for (const model of catalog.models) {
      const derived = deriveFree(model);
      expect(derived.free, `${model.id}: free`).toBe(model.free);
      expect(derived.reason, `${model.id}: freeReason`).toBe(model.freeReason);
    }
  });

  it('lists only free models', () => {
    expect(catalog.models.every((model) => model.free)).toBe(true);
  });

  it('never lists an excluded model', () => {
    const listed = new Set(catalog.models.map((model) => model.id));
    for (const excluded of catalog.excluded) {
      expect(listed.has(excluded.id), `${excluded.id} is both listed and excluded`).toBe(false);
    }
  });

  it('excludes the guardrail model for capability, not for price', () => {
    // Free and unusable are different failures, and the catalog records which.
    const excluded = excludedFor('nvidia/nemotron-3.5-content-safety:free');
    expect(excluded.reason).toBe('no-tool-calling');
    expect(catalog.models.every((model) => model.capabilities.includes('tools'))).toBe(true);
  });
});
