import { afterEach, describe, expect, it } from 'vitest';
import { limitsFromEnv } from '../src/bin.js';
import { DEFAULT_RELAY_LIMITS } from '../src/abuse/limits.js';

/**
 * Startup configuration, and the reason every reader here fails closed.
 *
 * These numbers decide what the relay spends and who it lets in. A value that
 * did not parse and silently became the default would be an operator who
 * believes they set a budget of 50 running one of 200 — and the only signal
 * would be the bill. So an unparseable value is a startup error.
 */

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('RELAY_')) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe('limits from the environment', () => {
  it('uses the shipped defaults when nothing is set — CONTROL', () => {
    expect(limitsFromEnv()).toEqual(DEFAULT_RELAY_LIMITS);
  });

  it('reads the published budget and the per-link ceilings', () => {
    process.env.RELAY_SPONSORED_DAILY_BUDGET = '50';
    process.env.RELAY_MAX_OPERATIONS = '25';
    process.env.RELAY_MAX_CHANGESET_BYTES = '4096';
    const limits = limitsFromEnv();
    expect(limits.sponsored.dailyBudget).toBe(50);
    expect(limits.changeSet.maxOperations).toBe(25);
    expect(limits.changeSet.maxBytes).toBe(4096);
  });

  it('refuses a value that is not a non-negative integer rather than falling back', () => {
    process.env.RELAY_SPONSORED_DAILY_BUDGET = 'lots';
    expect(() => limitsFromEnv()).toThrow(/not a non-negative integer/);

    process.env.RELAY_SPONSORED_DAILY_BUDGET = '-1';
    expect(() => limitsFromEnv()).toThrow(/not a non-negative integer/);

    process.env.RELAY_SPONSORED_DAILY_BUDGET = '1.5';
    expect(() => limitsFromEnv()).toThrow(/not a non-negative integer/);
  });

  it('treats an empty value as unset — CONTROL', () => {
    // A container that passes `RELAY_SPONSORED_DAILY_BUDGET=` through an unset
    // compose variable is a container asking for the default, not a container
    // asking for a startup failure.
    process.env.RELAY_SPONSORED_DAILY_BUDGET = '';
    expect(limitsFromEnv().sponsored.dailyBudget).toBe(DEFAULT_RELAY_LIMITS.sponsored.dailyBudget);
  });
});
