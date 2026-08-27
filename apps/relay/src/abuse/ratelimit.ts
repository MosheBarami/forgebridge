import { ForgeBridgeError } from '@forgebridge/protocol';
import type { AbuseStore } from './store.js';
import type { LimitClass, RelayLimits, WindowLimit } from './limits.js';

/**
 * Sliding-window rate limiting, per source address and per link, on every
 * route.
 *
 * "Sliding" rather than fixed buckets, and the difference is not academic: a
 * fixed hourly bucket lets a caller spend a full allowance at 10:59 and another
 * at 11:00, which is twice the limit inside two minutes — and the two minutes
 * either side of a bucket boundary are exactly when an abuser arrives, because
 * that is what the limit taught them to do.
 *
 * Both scopes are enforced, and both are needed for a different reason:
 *
 *  - **per link** bounds one paired session, which is the unit a legitimate
 *    user has one of.
 *  - **per source address** bounds a caller with a thousand sessions, which is
 *    the unit an abuser has one of. Without it, the per-link limit is a limit
 *    on politeness.
 *
 * The address is only as good as `clientAddress` makes it; see `ProxyTrust` in
 * `http.ts` for why that function refuses to guess.
 */
export interface RateDecision {
  /** How many hits the window now holds, this one included. */
  count: number;
  limit: number;
  /** Epoch ms at which the oldest hit leaves the window. */
  resetAtMs: number | null;
}

export class RateLimiter {
  readonly #store: AbuseStore;
  readonly #limits: RelayLimits;
  readonly #now: () => number;

  constructor(options: { store: AbuseStore; limits: RelayLimits; now?: () => number }) {
    this.#store = options.store;
    this.#limits = options.limits;
    this.#now = options.now ?? Date.now;
  }

  windowFor(scope: 'ip' | 'link', limitClass: LimitClass): WindowLimit {
    return scope === 'ip' ? this.#limits.ip[limitClass] : this.#limits.link[limitClass];
  }

  /**
   * Charge one request against a scope, and refuse when the window is full.
   *
   * The hit is recorded even when it is refused. That is deliberate: a caller
   * hammering a limit they have already hit must not be able to keep the window
   * from filling by being refused, or the limit resets under exactly the load
   * it exists to shed.
   */
  async enforce(scope: 'ip' | 'link', identity: string, limitClass: LimitClass): Promise<RateDecision> {
    const window = this.windowFor(scope, limitClass);
    const key = `${scope}:${limitClass}:${identity}`;
    const now = this.#now();
    const count = await this.#store.hit(key, now, window.windowMs);
    const resetAtMs = await this.#store.resetAtMs(key, now, window.windowMs);

    if (count > window.limit) {
      throw rateLimited(scope, limitClass, window, resetAtMs, now);
    }
    return { count, limit: window.limit, resetAtMs };
  }

  /** Seconds a refused caller should wait, for the `Retry-After` header. */
  static retryAfterSeconds(resetAtMs: number | null, nowMs: number): number {
    if (resetAtMs === null) return 1;
    return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
  }
}

/**
 * `Retry-After` rides on the refusal because a 429 without one is a 429 a
 * client answers by retrying immediately, which is the request pattern the
 * limit was trying to stop.
 */
export function rateLimitHeaders(resetAtMs: number | null, nowMs: number): Record<string, string> {
  return { 'retry-after': String(RateLimiter.retryAfterSeconds(resetAtMs, nowMs)) };
}

function rateLimited(
  scope: 'ip' | 'link',
  limitClass: LimitClass,
  window: WindowLimit,
  resetAtMs: number | null,
  nowMs: number,
): ForgeBridgeError {
  const seconds = RateLimiter.retryAfterSeconds(resetAtMs, nowMs);
  const per = scope === 'ip' ? 'this address' : 'this link';
  return new RelayRateLimitError(
    `${limitClass} requests from ${per} are limited to ${window.limit} per ${Math.round(window.windowMs / 1000)}s`,
    `Wait ${seconds}s and retry. A local daemon has no relay limits at all — see the README.`,
    resetAtMs,
  );
}

/**
 * A `rate_limited` that remembers when the window reopens, so the handler can
 * put it on `Retry-After` without recomputing it from a second store read.
 */
export class RelayRateLimitError extends ForgeBridgeError {
  constructor(message: string, remedy: string, readonly resetAtMs: number | null) {
    super('rate_limited', message, remedy);
  }
}
