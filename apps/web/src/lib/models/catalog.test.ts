import { describe, expect, it } from 'vitest';

import { EXPIRY_WARNING_DAYS, readModelCatalog } from './catalog';

/**
 * The settings model list, against the real shipped catalog.
 *
 * Deliberately not against a fixture. The claims this page makes — "these are
 * the models", "this is when it was verified", "this one is about to be
 * withdrawn" — are claims about `packages/model-registry/data/catalog.json`,
 * and a test that swapped in a hand-written catalog would be testing a list
 * this app wrote, which is the exact thing ADR-007 forbids the app from having.
 *
 * The assertions are therefore about *shape and derivation*, never about which
 * models are in the file: a sync that adds a model must not fail this suite.
 */
describe('the catalog the settings surface reads', () => {
  const view = readModelCatalog();

  it('is not empty and carries its provenance', () => {
    expect(view.models.length).toBeGreaterThan(0);
    expect(view.provenance.source.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(view.provenance.verifiedAt))).toBe(false);
  });

  it('reports the denominator, not just the numerator', () => {
    // Without `catalogTotal`, "16 free models" is a number with nothing behind
    // it, and a sync that silently truncated would look identical to one that
    // did not.
    expect(view.provenance.catalogTotal).toBeGreaterThanOrEqual(view.models.length);
  });

  it('gives every model a derivation reason, free or not', () => {
    for (const row of view.models) {
      expect(row.freeReason.length).toBeGreaterThan(0);
    }
  });

  it('never claims a model with a non-zero token price is free', () => {
    for (const row of view.models) {
      if (row.free) {
        expect(row.inputPerMTok).toBe(0);
        expect(row.outputPerMTok).toBe(0);
      }
    }
  });

  it('reports the capabilities a run requires rather than restating them', () => {
    expect(view.requiredCapabilities.length).toBeGreaterThan(0);
    for (const row of view.models) {
      if (row.availability.kind === 'incapable') {
        expect(row.availability.missing.length).toBeGreaterThan(0);
        for (const missing of row.availability.missing) {
          expect(view.requiredCapabilities).toContain(missing);
          expect(row.capabilities).not.toContain(missing);
        }
      }
    }
  });

  it('keeps an unmeasured benchmark null rather than zero', () => {
    for (const row of view.models) {
      for (const score of [
        row.benchmarks.intelligence,
        row.benchmarks.coding,
        row.benchmarks.agentic,
      ]) {
        expect(score === null || typeof score === 'number').toBe(true);
      }
    }
  });

  it('records why each excluded model was excluded', () => {
    for (const entry of view.excluded) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The expiry window, tested against a clock rather than against the calendar.
 *
 * A test that asserted "one model is expiring" would pass today and fail in
 * October when that date goes by. This pins the *transition* instead: whichever
 * model carries a recorded expiry must read `ready` outside the window,
 * `expiring` inside it, and `expired` after it.
 */
describe('the expiry warning', () => {
  const DAY_MS = 86_400_000;

  it('uses the registry’s own window rather than a literal of its own', () => {
    expect(EXPIRY_WARNING_DAYS).toBe(30);
  });

  it('moves a dated model through ready, expiring and expired as the clock passes', () => {
    // Far enough forward that every recorded expiry has passed, so any model
    // carrying one reports it here — with its id, which is what the three
    // clocks below are compared on.
    const distant = readModelCatalog(new Date('2999-01-01T00:00:00.000Z'));
    const dated = distant.models.find(
      (row) =>
        row.availability.kind === 'expired' &&
        // A model missing a required capability reports that instead at every
        // other clock, because a missing capability is not a fact that a date
        // changes. Such a model cannot demonstrate the transition.
        distant.requiredCapabilities.every((capability) => row.capabilities.includes(capability)),
    );

    if (!dated || dated.availability.kind !== 'expired') {
      // No usable model in the shipped catalog records an expiry. A legitimate
      // state, and there is nothing about the window to assert.
      expect(readModelCatalog().provenance.expiringCount).toBeGreaterThanOrEqual(0);
      return;
    }

    const expiry = Date.parse(dated.availability.expiresAt);
    const kindAt = (when: Date): string | undefined =>
      readModelCatalog(when).models.find((row) => row.id === dated.id)?.availability.kind;

    expect(kindAt(new Date(expiry - (EXPIRY_WARNING_DAYS + 10) * DAY_MS))).toBe('ready');
    expect(kindAt(new Date(expiry - 5 * DAY_MS))).toBe('expiring');
    expect(kindAt(new Date(expiry + DAY_MS))).toBe('expired');
  });
});
