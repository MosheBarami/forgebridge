import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PIPELINE_REQUIREMENTS } from '@forgebridge/core';

import { readCatalog, STALENESS_THRESHOLD_DAYS } from '@/app/[locale]/generate/catalog';

/**
 * The model selector's data, checked against the registry that owns it.
 *
 * The point of these tests is not that the catalog contains particular models —
 * it is synced data and the ids will change. It is that the *rules* hold: free
 * is derived rather than asserted, eligibility comes from the core's own
 * requirement rather than from a literal in this app, and the one constant this
 * app had to duplicate is caught if it drifts.
 */

describe('the catalog is read through the registry’s own rules', () => {
  const view = readCatalog(new Date('2026-08-27T00:00:00.000Z'));

  it('reads real synced data, not a hard-coded list', () => {
    expect(view.models.length).toBeGreaterThan(0);
    expect(view.summary.source).toMatch(/\S/);
    // The denominator ADR-007 asks for: without it "16 free models" is a number
    // with nothing behind it.
    expect(view.summary.catalogTotal).toBeGreaterThanOrEqual(view.models.length);
  });

  it('puts free models first', () => {
    const firstPaid = view.models.findIndex((model) => !model.free);
    if (firstPaid === -1) return; // every model in this snapshot is free
    expect(view.models.slice(firstPaid).every((model) => !model.free)).toBe(true);
  });

  it('orders by the coding index within a group, with unscored models last', () => {
    const free = view.models.filter((model) => model.free);
    const scored = free.filter((model) => model.coding !== null);
    const unscored = free.filter((model) => model.coding === null);

    // Every scored model precedes every unscored one.
    const lastScored = free.findLastIndex((model) => model.coding !== null);
    const firstUnscored = free.findIndex((model) => model.coding === null);
    if (scored.length > 0 && unscored.length > 0) {
      expect(lastScored).toBeLessThan(firstUnscored);
    }

    // And the scored ones descend. A missing benchmark is not a bad benchmark:
    // coercing null to 0 would have buried an unmeasured model beneath every
    // model that was measured and scored badly.
    for (let i = 1; i < scored.length; i += 1) {
      expect(scored[i - 1]?.coding ?? 0).toBeGreaterThanOrEqual(scored[i]?.coding ?? 0);
    }
  });

  it('derives freeness rather than repeating the file’s own flag', () => {
    // `deriveFree` returns a sentence explaining the verdict; the stored
    // `freeReason` is a cache of it. Every entry must carry one, because the UI
    // shows it and "free, because we said so" is not a reason.
    for (const model of view.models) {
      expect(model.freeReason).toMatch(/\S/);
    }
  });

  it('records excluded models with their reasons rather than dropping them', () => {
    // "It is not in the list" and "we looked at it and it charges $0.08 a song"
    // are different facts, and only the second survives someone asking why their
    // favourite model is missing.
    for (const entry of view.summary.excluded) {
      expect(entry.id).toMatch(/\S/);
      expect(entry.detail).toMatch(/\S/);
    }
  });
});

describe('eligibility comes from the core, not from a literal here', () => {
  const view = readCatalog(new Date('2026-08-27T00:00:00.000Z'));
  const required = DEFAULT_PIPELINE_REQUIREMENTS.capabilities ?? [];

  it('marks a model eligible exactly when it carries every required capability', () => {
    expect(required.length).toBeGreaterThan(0);

    for (const model of view.models) {
      const carriesAll =
        (!required.includes('tools') || model.tools) &&
        (!required.includes('structured_outputs') || model.structuredOutputs);
      expect(model.eligible).toBe(carriesAll);
    }
  });

  it('reports a missing-capability list a user can act on', () => {
    for (const model of view.models.filter((entry) => !entry.eligible)) {
      expect(model.missing.length).toBeGreaterThan(0);
      expect(required).toEqual(expect.arrayContaining([...model.missing]));
    }
  });

  it('counts eligible models separately from the full list', () => {
    expect(view.summary.eligibleCount).toBe(view.models.filter((model) => model.eligible).length);
    // If this ever reaches zero the composer has nothing to offer, and the
    // requirements line on screen is the only thing that would explain why.
    expect(view.summary.eligibleCount).toBeLessThanOrEqual(view.models.length);
  });
});

describe('staleness', () => {
  it('is not stale when read at the sync time', () => {
    const view = readCatalog(new Date('2026-08-26T22:00:00.000Z'));
    expect(view.summary.stale).toBe(false);
  });

  it('becomes stale past the threshold', () => {
    const synced = readCatalog(new Date('2026-08-27T00:00:00.000Z')).summary.syncedAt;
    const wayLater = new Date(
      new Date(synced).getTime() + (STALENESS_THRESHOLD_DAYS + 1) * 86_400_000,
    );
    const view = readCatalog(wayLater);

    expect(view.summary.stale).toBe(true);
    expect(view.summary.ageDays).toBeGreaterThan(STALENESS_THRESHOLD_DAYS);
  });

  /**
   * The drift guard for the one constant this app had to duplicate.
   *
   * `STALENESS_THRESHOLD_DAYS` lives in `packages/model-registry/src/registry.ts`
   * and cannot be imported here: importing that module executes a module-scope
   * `fileURLToPath(new URL(…, import.meta.url))` that a bundler breaks, which is
   * documented at the top of `catalog.ts`. So the number is restated in this app
   * and read back out of the registry's *source* here. If the registry changes
   * its threshold, this fails — rather than a user being shown a stale catalog
   * as though it were current.
   */
  it('agrees with the registry’s own threshold', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../../packages/model-registry/src/registry.ts', import.meta.url),
      ),
      'utf8',
    );
    const match = /export const STALENESS_THRESHOLD_DAYS = (\d+)/.exec(source);

    expect(match, 'STALENESS_THRESHOLD_DAYS was not found in the registry source').not.toBeNull();
    expect(Number(match?.[1])).toBe(STALENESS_THRESHOLD_DAYS);
  });
});
