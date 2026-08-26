import { systemClock, type Clock } from './clock.js';

/**
 * A per-provider circuit breaker (ADR-008).
 *
 * Pure and deterministic: it holds counters and timestamps, and every time
 * question it asks goes through the injected clock. `stateOf` derives the state
 * from those rather than storing it, so an `open` breaker becomes `half-open`
 * because time passed, not because someone remembered to run a timer.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  /** Consecutive failures that trip a closed breaker open. */
  failureThreshold: number;
  /** How long an open breaker refuses traffic before it allows one probe. */
  cooldownMs: number;
  /** Successful probes needed to close again. */
  halfOpenSuccessesToClose: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  halfOpenSuccessesToClose: 1,
};

export interface BreakerSnapshot {
  key: string;
  state: BreakerState;
  consecutiveFailures: number;
  /** Milliseconds until the next probe is allowed. Zero unless the state is `open`. */
  retryAfterMs: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

interface BreakerEntry {
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenSuccesses: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

function freshEntry(): BreakerEntry {
  return {
    consecutiveFailures: 0,
    openedAt: null,
    halfOpenSuccesses: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
}

export class CircuitBreaker {
  readonly #config: BreakerConfig;
  readonly #clock: Clock;
  readonly #entries = new Map<string, BreakerEntry>();

  constructor(config: Partial<BreakerConfig> = {}, clock: Clock = systemClock) {
    this.#config = { ...DEFAULT_BREAKER_CONFIG, ...config };
    this.#clock = clock;
  }

  get config(): BreakerConfig {
    return this.#config;
  }

  stateOf(key: string): BreakerState {
    const entry = this.#entries.get(key);
    if (!entry || entry.openedAt === null) return 'closed';
    return this.#clock() - entry.openedAt >= this.#config.cooldownMs ? 'half-open' : 'open';
  }

  /** False only while a breaker is fully open. A half-open breaker allows the probe. */
  allows(key: string): boolean {
    return this.stateOf(key) !== 'open';
  }

  retryAfterMs(key: string): number {
    const entry = this.#entries.get(key);
    if (!entry || entry.openedAt === null) return 0;
    const remaining = entry.openedAt + this.#config.cooldownMs - this.#clock();
    return remaining > 0 ? remaining : 0;
  }

  recordSuccess(key: string): void {
    const state = this.stateOf(key);
    const entry = this.#entryFor(key);
    entry.lastSuccessAt = this.#clock();

    if (state === 'closed') {
      // Consecutive means consecutive: one success wipes the streak, so a
      // provider that fails intermittently never accumulates its way open.
      entry.consecutiveFailures = 0;
      return;
    }

    // Probe path. A success recorded while the breaker still reads `open` means
    // the caller ignored `allows()` — treated as a probe anyway, because
    // suppressing a provider that just demonstrably worked helps nobody.
    entry.halfOpenSuccesses += 1;
    if (entry.halfOpenSuccesses >= this.#config.halfOpenSuccessesToClose) {
      entry.consecutiveFailures = 0;
      entry.openedAt = null;
      entry.halfOpenSuccesses = 0;
    }
  }

  recordFailure(key: string): void {
    const state = this.stateOf(key);
    const entry = this.#entryFor(key);
    entry.consecutiveFailures += 1;
    entry.lastFailureAt = this.#clock();

    if (state === 'open') {
      // Already open and someone called anyway. Count it, but do not extend the
      // cooldown: a caller that ignores the breaker must not be able to keep a
      // recovered provider suppressed indefinitely.
      return;
    }

    if (state === 'half-open') {
      // The probe failed. Straight back to open, with a full fresh cooldown.
      entry.openedAt = this.#clock();
      entry.halfOpenSuccesses = 0;
      return;
    }

    if (entry.consecutiveFailures >= this.#config.failureThreshold) {
      entry.openedAt = this.#clock();
      entry.halfOpenSuccesses = 0;
    }
  }

  /** Clears one key, or every key when called with no argument. */
  reset(key?: string): void {
    if (key === undefined) this.#entries.clear();
    else this.#entries.delete(key);
  }

  /** Provider health, for the UI (ADR-008) and for support. */
  snapshot(): BreakerSnapshot[] {
    return [...this.#entries.entries()].map(([key, entry]) => ({
      key,
      state: this.stateOf(key),
      consecutiveFailures: entry.consecutiveFailures,
      retryAfterMs: this.retryAfterMs(key),
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
    }));
  }

  #entryFor(key: string): BreakerEntry {
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const created = freshEntry();
    this.#entries.set(key, created);
    return created;
  }
}
