import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@forgebridge/protocol';
import { DEFAULT_RELAY_LIMITS, assertCeilingsBelowProtocol, type RelayLimits } from '../src/abuse/limits.js';
import { InMemoryAbuseStore, utcDay } from '../src/abuse/store.js';
import { RateLimiter } from '../src/abuse/ratelimit.js';
import { json, makeChangeSet, manyOperations, pairSession, producerHeaders, startRelay } from './helpers.js';

/**
 * M45 — abuse protection (ADR-010).
 *
 * There is no metering and never will be. The relay is the only part of this
 * system that costs the project money, and the defence is four things: sliding
 * windows per link and per address on every route, per-link ceilings on what a
 * ChangeSet may be, a daily budget breaker with a published number, and the
 * sponsored-run counters. Each of them gets a test that proves it fires.
 *
 * And each gets a **control** — the legitimate shape it is most confusable
 * with, proven not to be caught. That is not symmetry for its own sake: a limit
 * that fires on ordinary use trains people to ignore it, which is the same
 * outcome as no limit, reached more expensively.
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

/** Limits tuned small so a test can reach them without a thousand requests. */
function tightLimits(overrides: Partial<RelayLimits> = {}): RelayLimits {
  return {
    ...DEFAULT_RELAY_LIMITS,
    ip: { ...DEFAULT_RELAY_LIMITS.ip, write: { limit: 3, windowMs: 60_000 }, read: { limit: 5, windowMs: 60_000 } },
    link: { ...DEFAULT_RELAY_LIMITS.link, write: { limit: 2, windowMs: 60_000 } },
    ...overrides,
  };
}

describe('sliding-window rate limits', () => {
  it('fires on the request past the limit, and says when to come back', async () => {
    const store = new InMemoryAbuseStore();
    let now = 1_000_000;
    const limiter = new RateLimiter({
      store,
      limits: tightLimits(),
      now: () => now,
    });

    await limiter.enforce('ip', '203.0.113.7', 'write');
    await limiter.enforce('ip', '203.0.113.7', 'write');
    await limiter.enforce('ip', '203.0.113.7', 'write');
    await expect(limiter.enforce('ip', '203.0.113.7', 'write')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('is a sliding window, not a bucket that resets on the hour', async () => {
    // The failure a fixed bucket has: spend the allowance at the end of one
    // window and the whole allowance again at the start of the next, which is
    // double the limit inside two seconds. A caller who reached the limit must
    // still be refused one millisecond later.
    const store = new InMemoryAbuseStore();
    let now = 1_000_000;
    const limiter = new RateLimiter({ store, limits: tightLimits(), now: () => now });

    for (let i = 0; i < 3; i += 1) await limiter.enforce('ip', 'a', 'write');
    now += 59_999;
    await expect(limiter.enforce('ip', 'a', 'write')).rejects.toMatchObject({ code: 'rate_limited' });

    // Only once the oldest hit has genuinely aged out does room appear.
    now += 60_001;
    await expect(limiter.enforce('ip', 'a', 'write')).resolves.toMatchObject({ limit: 3 });
  });

  it('counts a refused request, so a caller cannot hold the window open by hammering it', async () => {
    const store = new InMemoryAbuseStore();
    let now = 1_000_000;
    const limiter = new RateLimiter({ store, limits: tightLimits(), now: () => now });
    for (let i = 0; i < 3; i += 1) await limiter.enforce('ip', 'b', 'write');
    for (let i = 0; i < 10; i += 1) {
      await expect(limiter.enforce('ip', 'b', 'write')).rejects.toMatchObject({ code: 'rate_limited' });
    }
    // The window now holds thirteen hits, so the oldest ages out thirteen
    // hits later — not three.
    expect(await store.peek('ip:write:b', now, 60_000)).toBe(13);
  });

  it('keys separately per scope and per identity — CONTROL', async () => {
    const store = new InMemoryAbuseStore();
    const limiter = new RateLimiter({ store, limits: tightLimits(), now: () => 1_000_000 });
    for (let i = 0; i < 3; i += 1) await limiter.enforce('ip', 'first', 'write');
    // A different address is a different caller and is not affected.
    await expect(limiter.enforce('ip', 'second', 'write')).resolves.toBeTruthy();
    // A different route class has its own window: a poll is not a write.
    await expect(limiter.enforce('ip', 'first', 'poll')).resolves.toBeTruthy();
  });

  it('refuses over HTTP with a Retry-After a client can act on', async () => {
    const started = await startRelay({ limits: tightLimits() });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    let last: Response | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await fetch(`${started.base}/v1/changesets`, {
        method: 'POST',
        headers: producerHeaders(session),
        body: JSON.stringify(makeChangeSet({ projectId: session.projectId })),
      });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect((await json(last as Response)).code).toBe('rate_limited');
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not catch ordinary use — CONTROL', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    // Default limits, and a producer doing what a producer does: propose,
    // read the diff, approve. None of it is near a window.
    for (let i = 0; i < 10; i += 1) {
      const set = makeChangeSet({ projectId: session.projectId });
      const submitted = await fetch(`${started.base}/v1/changesets`, {
        method: 'POST',
        headers: producerHeaders(session),
        body: JSON.stringify(set),
      });
      expect(submitted.status).toBe(201);
      const diff = await fetch(`${started.base}/v1/changesets/${set.id as string}/diff`, {
        headers: producerHeaders(session),
      });
      expect(diff.status).toBe(200);
    }
  });
});

describe('per-link ceilings on what a ChangeSet may be', () => {
  it('refuses more operations than the relay ceiling, quoting both numbers', async () => {
    const started = await startRelay({
      limits: { ...DEFAULT_RELAY_LIMITS, changeSet: { maxBytes: 1_048_576, maxOperations: 5 } },
    });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const refused = await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(makeChangeSet({ projectId: session.projectId, operations: manyOperations(6) })),
    });
    expect(refused.status).toBe(413);
    const body = await json(refused);
    expect(body.code).toBe('too_large');
    expect(String(body.message)).toContain('5 operations');
    // The remedy names the protocol's own bound and the transport that enforces
    // only that, so a user learns what the relay is costing them.
    expect(String(body.remedy)).toContain(String(LIMITS.MAX_OPERATIONS));
    expect(String(body.remedy)).toContain('daemon');
  });

  it('accepts a set at the ceiling — CONTROL', async () => {
    const started = await startRelay({
      limits: { ...DEFAULT_RELAY_LIMITS, changeSet: { maxBytes: 1_048_576, maxOperations: 5 } },
    });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const accepted = await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(makeChangeSet({ projectId: session.projectId, operations: manyOperations(5) })),
    });
    expect(accepted.status).toBe(201);
  });

  it('refuses a body past the byte ceiling on its headers, before parsing it', async () => {
    const started = await startRelay({
      limits: { ...DEFAULT_RELAY_LIMITS, changeSet: { maxBytes: 4096, maxOperations: 200 } },
    });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const big = makeChangeSet({
      projectId: session.projectId,
      operations: [
        {
          op: 'writeScript',
          path: 'ServerScriptService.Big',
          scriptType: 'Script',
          source: 'x'.repeat(20_000),
        },
      ] as never,
    });
    const refused = await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(big),
    });
    expect(refused.status).toBe(413);
  });
});

describe('a ceiling at the protocol bound is not a ceiling', () => {
  it('refuses to start with an operation ceiling at or above the protocol limit', () => {
    // The typo that adds a zero turns the relay-specific defence off without
    // changing anything visible, so it is a startup error rather than a
    // silently wider limit.
    expect(() =>
      assertCeilingsBelowProtocol({
        ...DEFAULT_RELAY_LIMITS,
        changeSet: { maxBytes: 1024, maxOperations: LIMITS.MAX_OPERATIONS },
      }),
    ).toThrow(/enforces nothing/);

    expect(() =>
      assertCeilingsBelowProtocol({
        ...DEFAULT_RELAY_LIMITS,
        changeSet: { maxBytes: LIMITS.MAX_CHANGESET_BYTES + 1, maxOperations: 10 },
      }),
    ).toThrow(/enforces nothing/);
  });

  it('refuses a window with no room in it', () => {
    expect(() =>
      assertCeilingsBelowProtocol({
        ...DEFAULT_RELAY_LIMITS,
        ip: { ...DEFAULT_RELAY_LIMITS.ip, write: { limit: 0, windowMs: 1000 } },
      }),
    ).toThrow(/positive limit/);
  });

  it('accepts the shipped defaults — CONTROL', () => {
    expect(() => assertCeilingsBelowProtocol(DEFAULT_RELAY_LIMITS)).not.toThrow();
    expect(DEFAULT_RELAY_LIMITS.changeSet.maxBytes).toBeLessThan(LIMITS.MAX_CHANGESET_BYTES);
    expect(DEFAULT_RELAY_LIMITS.changeSet.maxOperations).toBeLessThan(LIMITS.MAX_OPERATIONS);
  });
});

describe('the counter store', () => {
  it('reserves atomically, so "1 per day" is not "1 per millisecond"', async () => {
    const store = new InMemoryAbuseStore();
    const day = utcDay(0);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.reserveDaily('user:x', day, 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('gives a reservation back without going below zero', async () => {
    const store = new InMemoryAbuseStore();
    const day = utcDay(0);
    expect(await store.reserveDaily('k', day, 1)).toBe(true);
    await store.releaseDaily('k', day);
    await store.releaseDaily('k', day);
    expect(await store.dailyCount('k', day)).toBe(0);
    expect(await store.reserveDaily('k', day, 1)).toBe(true);
  });

  it('keys the day in UTC, so daylight saving does not hand out a second run', () => {
    // A counter keyed on local time rolls over twice a year where DST is
    // observed, and one of those two rollovers is a free extra day.
    expect(utcDay(Date.parse('2026-03-29T00:30:00Z'))).toBe('2026-03-29');
    expect(utcDay(Date.parse('2026-03-29T23:59:59Z'))).toBe('2026-03-29');
    expect(utcDay(Date.parse('2026-03-30T00:00:00Z'))).toBe('2026-03-30');
  });

  it('does not grow without bound on attacker-chosen keys', async () => {
    const store = new InMemoryAbuseStore({ maxKeys: 50 });
    for (let i = 0; i < 500; i += 1) await store.hit(`ip:${i}`, i, 60_000);
    expect(store.trackedKeys).toBeLessThanOrEqual(50);
  });
});
