import { ForgeBridgeError } from '@forgebridge/protocol';
import type { AbuseStore } from './store.js';
import { utcDay } from './store.js';

/**
 * The daily budget circuit breaker.
 *
 * ADR-010 is specific about how this must behave, and each clause is a
 * requirement rather than a preference:
 *
 *   "sponsored capacity is a published number, not a mystery"
 *   "the breaker degrades loudly, never silently"
 *   "BYOK and local models carry the load"
 *
 * So: the number is on `GET /v1/health` before anyone hits it and quoted in the
 * refusal when they do; the refusal is a `budget_exhausted` a client can branch
 * on rather than a slow queue or a downgraded model; and the remedy names the
 * two ways to keep working today, because "come back tomorrow" is not one.
 *
 * What this deliberately is NOT: a queue, a soft limit, a smaller model, or a
 * delay. Every one of those is a way of spending money the breaker was opened
 * to stop spending while telling the user nothing happened.
 */
export interface BudgetState {
  /** The published daily figure. */
  dailyBudget: number;
  /** How much of today's budget is committed. */
  spentToday: number;
  /** UTC date the figures are for. */
  day: string;
  open: boolean;
}

const BUDGET_KEY = 'relay:sponsored:daily-budget';

export class BudgetBreaker {
  readonly #store: AbuseStore;
  readonly #dailyBudget: number;
  readonly #now: () => number;

  constructor(options: { store: AbuseStore; dailyBudget: number; now?: () => number }) {
    this.#store = options.store;
    this.#dailyBudget = options.dailyBudget;
    this.#now = options.now ?? Date.now;
  }

  get dailyBudget(): number {
    return this.#dailyBudget;
  }

  async state(): Promise<BudgetState> {
    const day = utcDay(this.#now());
    const spentToday = await this.#store.dailyCount(BUDGET_KEY, day);
    return { dailyBudget: this.#dailyBudget, spentToday, day, open: spentToday >= this.#dailyBudget };
  }

  /**
   * Commit one unit of today's budget, or refuse plainly.
   *
   * Committed *before* the work, and released if the work never happened. The
   * other order counts what was already spent, which is a report rather than a
   * breaker.
   */
  async reserve(): Promise<{ day: string; release: () => Promise<void> }> {
    const day = utcDay(this.#now());
    const taken = await this.#store.reserveDaily(BUDGET_KEY, day, this.#dailyBudget);
    if (!taken) {
      throw new ForgeBridgeError(
        'budget_exhausted',
        `the relay's sponsored budget for ${day} is spent — ${this.#dailyBudget} runs, all of them used`,
        'Nothing is queued and nothing was downgraded. Use your own API key (BYOK), or run the local ' +
          'daemon, which has no relay budget because it spends nothing of ours. Sponsored capacity ' +
          'resets at 00:00 UTC.',
      );
    }
    return { day, release: () => this.#store.releaseDaily(BUDGET_KEY, day) };
  }
}
