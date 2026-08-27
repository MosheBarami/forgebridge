/**
 * The counters M45 rests on, behind one interface.
 *
 * ADR-010 names Upstash Redis. This app does not depend on it, and that is the
 * decision rather than an omission: a hard vendor dependency in the relay would
 * make "self-hosting it is realistic" (ADR-004) false, and a dependency that
 * cannot be exercised in this repository's tests is a dependency whose failure
 * modes nobody here has seen. So the port is the contract, the in-memory
 * implementation below is the one that ships and is tested, and a deployment
 * that needs counters shared across processes supplies its own.
 *
 * TODO(M45): a Redis-backed implementation of this interface — `hit` as a
 * sorted-set window (`ZREMRANGEBYSCORE` + `ZADD` + `ZCARD` in one MULTI),
 * `reserveDaily` as `INCR` with a compare against the limit and a `DECR` on
 * overshoot, both under a key that expires with the day. Owner: whoever runs
 * the public deployment. Until it exists, a multi-process relay counts per
 * process and its limits are per process — which is why `relay.ts` refuses to
 * start with more than one worker unless a shared store is supplied.
 */

export interface AbuseStore {
  /**
   * Record one hit against `key` and return how many hits fall inside the
   * trailing `windowMs`, this one included.
   *
   * One call, not a read followed by a write: two concurrent requests that both
   * read "9 of 10" before either writes both pass a limit of 10. The counter
   * has to be the thing that decides, not a value the caller read a moment ago.
   */
  hit(key: string, nowMs: number, windowMs: number): Promise<number>;

  /** How many hits fall inside the window, recording none. For reporting only. */
  peek(key: string, nowMs: number, windowMs: number): Promise<number>;

  /** When the oldest hit in the window ages out, or null when there are none. */
  resetAtMs(key: string, nowMs: number, windowMs: number): Promise<number | null>;

  /**
   * Take one unit of a date-keyed budget, or refuse.
   *
   * Atomic for the same reason `hit` is, and the stakes are higher: this is the
   * counter that decides whether the day's sponsored capacity is spent, and two
   * requests that both read "0 of 1" is exactly the shape of the bug that makes
   * "1 per day" mean "as many as arrive in the same millisecond".
   */
  reserveDaily(key: string, day: string, limit: number): Promise<boolean>;

  /**
   * Give a reserved unit back. Never drops below zero.
   *
   * The relay reserves before it dispatches and releases when the dispatch did
   * not happen. The other order — dispatch, then count — spends capacity it
   * cannot refuse and counts it afterwards, which is metering rather than a
   * limit.
   */
  releaseDaily(key: string, day: string): Promise<void>;

  dailyCount(key: string, day: string): Promise<number>;
}

/**
 * A ceiling on how many distinct keys are held.
 *
 * Every key is attacker-chosen — an address, a link id — so an unbounded map is
 * an unbounded allocation driven from outside. Reached, the least recently
 * touched key is dropped, which forgives one caller's history rather than
 * exhausting the process's memory for everyone.
 */
export const MAX_TRACKED_KEYS = 100_000;

interface WindowEntry {
  hits: number[];
  touchedAtMs: number;
}

interface DailyEntry {
  day: string;
  count: number;
  touchedAtMs: number;
}

/**
 * Per-process counters. Correct on one process, and honest about being no more
 * than that: two relay processes behind a load balancer each enforce the limits
 * they can see, so the effective limit is per process until a shared store is
 * supplied.
 */
export class InMemoryAbuseStore implements AbuseStore {
  readonly #windows = new Map<string, WindowEntry>();
  readonly #daily = new Map<string, DailyEntry>();
  readonly #maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    this.#maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
  }

  get trackedKeys(): number {
    return this.#windows.size + this.#daily.size;
  }

  async hit(key: string, nowMs: number, windowMs: number): Promise<number> {
    const entry = this.#window(key, nowMs, windowMs);
    entry.hits.push(nowMs);
    entry.touchedAtMs = nowMs;
    return entry.hits.length;
  }

  async peek(key: string, nowMs: number, windowMs: number): Promise<number> {
    const existing = this.#windows.get(key);
    if (!existing) return 0;
    prune(existing, nowMs, windowMs);
    return existing.hits.length;
  }

  async resetAtMs(key: string, nowMs: number, windowMs: number): Promise<number | null> {
    const existing = this.#windows.get(key);
    if (!existing) return null;
    prune(existing, nowMs, windowMs);
    const oldest = existing.hits[0];
    return oldest === undefined ? null : oldest + windowMs;
  }

  async reserveDaily(key: string, day: string, limit: number): Promise<boolean> {
    const entry = this.#dailyEntry(key, day);
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  async releaseDaily(key: string, day: string): Promise<void> {
    const entry = this.#daily.get(key);
    // A release for a different day is a release for a counter that no longer
    // exists; silently resetting today's would be giving back capacity that was
    // never taken from it.
    if (!entry || entry.day !== day) return;
    entry.count = Math.max(0, entry.count - 1);
  }

  async dailyCount(key: string, day: string): Promise<number> {
    const entry = this.#daily.get(key);
    return entry && entry.day === day ? entry.count : 0;
  }

  #window(key: string, nowMs: number, windowMs: number): WindowEntry {
    const existing = this.#windows.get(key);
    if (existing) {
      prune(existing, nowMs, windowMs);
      return existing;
    }
    this.#evictIfFull(this.#windows, nowMs);
    const fresh: WindowEntry = { hits: [], touchedAtMs: nowMs };
    this.#windows.set(key, fresh);
    return fresh;
  }

  #dailyEntry(key: string, day: string): DailyEntry {
    const existing = this.#daily.get(key);
    if (existing && existing.day === day) {
      existing.touchedAtMs = Date.now();
      return existing;
    }
    if (!existing) this.#evictIfFull(this.#daily, Date.now());
    const fresh: DailyEntry = { day, count: 0, touchedAtMs: Date.now() };
    this.#daily.set(key, fresh);
    return fresh;
  }

  #evictIfFull(map: Map<string, { touchedAtMs: number }>, nowMs: number): void {
    if (this.trackedKeys < this.#maxKeys) return;
    let oldestKey: string | null = null;
    let oldestAt = nowMs + 1;
    for (const [key, entry] of map) {
      if (entry.touchedAtMs < oldestAt) {
        oldestAt = entry.touchedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) map.delete(oldestKey);
  }
}

function prune(entry: WindowEntry, nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs;
  let drop = 0;
  while (drop < entry.hits.length && (entry.hits[drop] as number) <= cutoff) drop += 1;
  if (drop > 0) entry.hits.splice(0, drop);
  entry.touchedAtMs = nowMs;
}

/**
 * The date a daily counter is keyed by, in UTC.
 *
 * UTC rather than the operator's local time, and stated rather than implied: a
 * counter keyed on local time rolls over twice a year in the places that
 * observe daylight saving, and one of those two rollovers hands every user a
 * second sponsored run.
 */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
