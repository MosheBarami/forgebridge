import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RELAY_LIMITS, type RelayLimits } from '../src/abuse/limits.js';
import { InMemoryAbuseStore } from '../src/abuse/store.js';
import { BudgetBreaker } from '../src/abuse/budget.js';
import { SponsoredRunGate, type AsnLookupPort, type UserVerificationPort } from '../src/abuse/sponsored.js';
import type { RunDispatchPort } from '../src/dispatch.js';
import { json, pairSession, producerHeaders, startRelay } from './helpers.js';

/**
 * The sponsored run — 1 per day per verified user, per address and per network
 * (ADR-010) — and the daily budget breaker in front of it.
 *
 * Every gate here has the same shape: it answers one question, and if it cannot
 * answer it, it refuses. That is the rule this repository keeps re-learning.
 * Every bypass found so far shared one shape — a check looked for a pattern,
 * did not find one, and returned the same answer it returns for safety — so
 * "I could not verify this caller" and "this caller is verified" must not be
 * the same answer, and neither must "I could not attribute this address to a
 * network" and "this network is under its allowance".
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function verifier(overrides: { accountAgeDays?: number; userId?: string; fail?: boolean; throws?: boolean } = {}): UserVerificationPort {
  return {
    name: 'test-verifier',
    async verify() {
      if (overrides.throws) throw new Error('identity provider is down');
      if (overrides.fail) return null;
      return { userId: overrides.userId ?? 'user-1', accountAgeDays: overrides.accountAgeDays ?? 400 };
    },
  };
}

function asnPort(answer: string | null = '64500'): AsnLookupPort {
  return { name: 'test-asn', async lookup() { return answer; } };
}

function gate(options: {
  verification?: UserVerificationPort;
  asn?: AsnLookupPort;
  limits?: RelayLimits;
  dailyBudget?: number;
  store?: InMemoryAbuseStore;
} = {}): { gate: SponsoredRunGate; store: InMemoryAbuseStore } {
  const store = options.store ?? new InMemoryAbuseStore();
  const limits = options.limits ?? DEFAULT_RELAY_LIMITS;
  const budget = new BudgetBreaker({
    store,
    dailyBudget: options.dailyBudget ?? limits.sponsored.dailyBudget,
    now: () => 0,
  });
  return {
    gate: new SponsoredRunGate({
      store,
      limits,
      budget,
      verification: options.verification,
      asn: options.asn,
      now: () => 0,
    }),
    store,
  };
}

describe('the gate refuses what it cannot resolve', () => {
  it('grants nothing at all when no verification port is wired (M23)', async () => {
    const { gate: g } = gate({ asn: asnPort() });
    await expect(g.reserve({ address: '203.0.113.1', proof: 'anything' })).rejects.toMatchObject({
      code: 'provider_unconfigured',
    });
    expect(g.available).toBe(false);
  });

  it('grants nothing when the caller cannot be attributed to a network', async () => {
    // Two-out-of-three is not "all three required". A caller cycling addresses
    // inside one hosting provider is exactly who the ASN counter exists for,
    // and an unresolvable address is the shape that would let them through.
    const { gate: g } = gate({ verification: verifier(), asn: asnPort(null) });
    await expect(g.reserve({ address: '203.0.113.1', proof: 'p' })).rejects.toMatchObject({
      code: 'provider_unconfigured',
    });
  });

  it('grants nothing when no ASN port is wired at all', async () => {
    const { gate: g } = gate({ verification: verifier() });
    await expect(g.reserve({ address: '203.0.113.1', proof: 'p' })).rejects.toMatchObject({
      code: 'provider_unconfigured',
    });
  });

  it('treats a verifier that throws exactly like one that said no', async () => {
    // "The identity provider is down" is not a reason to skip verification. It
    // is the reason verification exists.
    const { gate: g } = gate({ verification: verifier({ throws: true }), asn: asnPort() });
    await expect(g.reserve({ address: '203.0.113.1', proof: 'p' })).rejects.toMatchObject({
      code: 'policy_violation',
    });
  });

  it('refuses an unverified caller', async () => {
    const { gate: g } = gate({ verification: verifier({ fail: true }), asn: asnPort() });
    await expect(g.reserve({ address: '203.0.113.1', proof: undefined })).rejects.toMatchObject({
      code: 'policy_violation',
    });
  });

  it('refuses an account younger than the floor', async () => {
    const { gate: g } = gate({ verification: verifier({ accountAgeDays: 3 }), asn: asnPort() });
    await expect(g.reserve({ address: '203.0.113.1', proof: 'p' })).rejects.toMatchObject({
      code: 'policy_violation',
    });
  });

  it('grants a verified, attributable, first-of-the-day caller — CONTROL', async () => {
    const { gate: g } = gate({ verification: verifier(), asn: asnPort() });
    const reservation = await g.reserve({ address: '203.0.113.1', proof: 'p' });
    expect(reservation.user.userId).toBe('user-1');
    expect(reservation.asn).toBe('64500');
    expect(g.available).toBe(true);
  });
});

describe('all three counters, and all three required', () => {
  it('refuses the same user a second run the same day', async () => {
    const { gate: g } = gate({ verification: verifier(), asn: asnPort() });
    await g.reserve({ address: '203.0.113.1', proof: 'p' });
    await expect(g.reserve({ address: '198.51.100.9', proof: 'p' })).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
  });

  it('refuses a second account behind the same address', async () => {
    const store = new InMemoryAbuseStore();
    const first = gate({ verification: verifier({ userId: 'a' }), asn: asnPort(), store });
    const second = gate({ verification: verifier({ userId: 'b' }), asn: asnPort('64501'), store });
    await first.gate.reserve({ address: '203.0.113.1', proof: 'p' });
    await expect(second.gate.reserve({ address: '203.0.113.1', proof: 'p' })).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
  });

  it('refuses a second address inside the same network', async () => {
    const store = new InMemoryAbuseStore();
    const first = gate({ verification: verifier({ userId: 'a' }), asn: asnPort('64500'), store });
    const second = gate({ verification: verifier({ userId: 'b' }), asn: asnPort('64500'), store });
    await first.gate.reserve({ address: '203.0.113.1', proof: 'p' });
    // Different user, different address, same network — the case the IP counter
    // alone cannot see.
    await expect(second.gate.reserve({ address: '198.51.100.9', proof: 'p' })).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
  });

  it('grants two different users on two different networks — CONTROL', async () => {
    const store = new InMemoryAbuseStore();
    const first = gate({ verification: verifier({ userId: 'a' }), asn: asnPort('64500'), store });
    const second = gate({ verification: verifier({ userId: 'b' }), asn: asnPort('64501'), store });
    await expect(first.gate.reserve({ address: '203.0.113.1', proof: 'p' })).resolves.toBeTruthy();
    await expect(second.gate.reserve({ address: '198.51.100.9', proof: 'p' })).resolves.toBeTruthy();
  });

  it('gives every counter back when a later one refuses', async () => {
    // A caller refused by the third counter must not have silently spent the
    // first two: they would lose tomorrow's run for a run they never got.
    const store = new InMemoryAbuseStore();
    const blocker = gate({ verification: verifier({ userId: 'a' }), asn: asnPort('64500'), store });
    await blocker.gate.reserve({ address: '198.51.100.1', proof: 'p' });

    const victim = gate({ verification: verifier({ userId: 'b' }), asn: asnPort('64500'), store });
    await expect(victim.gate.reserve({ address: '203.0.113.5', proof: 'p' })).rejects.toMatchObject({
      code: 'budget_exhausted',
    });

    // Their user counter and their address counter are untouched, and the
    // global budget is back to one.
    expect(await store.dailyCount('relay:sponsored:user:b', '1970-01-01')).toBe(0);
    expect(await store.dailyCount('relay:sponsored:ip:203.0.113.5', '1970-01-01')).toBe(0);
    expect(await store.dailyCount('relay:sponsored:daily-budget', '1970-01-01')).toBe(1);
  });

  it('releases everything when the caller releases the reservation', async () => {
    const { gate: g, store } = gate({ verification: verifier(), asn: asnPort() });
    const reservation = await g.reserve({ address: '203.0.113.1', proof: 'p' });
    await reservation.release();
    expect(await store.dailyCount('relay:sponsored:user:user-1', '1970-01-01')).toBe(0);
    expect(await store.dailyCount('relay:sponsored:daily-budget', '1970-01-01')).toBe(0);
  });
});

describe('the daily budget breaker', () => {
  it('says so plainly when the day’s budget is spent, and points at BYOK and the daemon', async () => {
    const store = new InMemoryAbuseStore();
    const first = gate({ verification: verifier({ userId: 'a' }), asn: asnPort('1'), dailyBudget: 1, store });
    const second = gate({ verification: verifier({ userId: 'b' }), asn: asnPort('2'), dailyBudget: 1, store });
    await first.gate.reserve({ address: '203.0.113.1', proof: 'p' });

    await expect(second.gate.reserve({ address: '198.51.100.2', proof: 'p' })).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
    try {
      await second.gate.reserve({ address: '198.51.100.3', proof: 'p' });
      expect.fail('the breaker should have refused');
    } catch (error) {
      const refusal = error as { message: string; remedy?: string };
      // The published number is quoted, and nothing was queued or downgraded.
      expect(refusal.message).toContain('1 runs');
      expect(refusal.remedy).toMatch(/BYOK/);
      expect(refusal.remedy).toMatch(/daemon/);
      expect(refusal.remedy).toMatch(/Nothing is queued/);
    }
  });

  it('charges the global breaker before a user’s own counter', async () => {
    // Otherwise a user turned away by an exhausted relay would have paid their
    // personal allowance for the privilege.
    const store = new InMemoryAbuseStore();
    const spender = gate({ verification: verifier({ userId: 'a' }), asn: asnPort('1'), dailyBudget: 1, store });
    await spender.gate.reserve({ address: '203.0.113.1', proof: 'p' });

    const turnedAway = gate({ verification: verifier({ userId: 'z' }), asn: asnPort('9'), dailyBudget: 1, store });
    await expect(turnedAway.gate.reserve({ address: '198.51.100.9', proof: 'p' })).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
    expect(await store.dailyCount('relay:sponsored:user:z', '1970-01-01')).toBe(0);
  });

  it('publishes the number on /v1/health before anyone hits it', async () => {
    const started = await startRelay({
      limits: { ...DEFAULT_RELAY_LIMITS, sponsored: { ...DEFAULT_RELAY_LIMITS.sponsored, dailyBudget: 42 } },
    });
    open.push(started.close);
    const health = await json(await fetch(`${started.base}/v1/health`));
    const sponsored = health.sponsored as Record<string, unknown>;
    expect(sponsored.dailyBudget).toBe(42);
    expect(sponsored.spentToday).toBe(0);
    // No verification port and no run service: honest about being unavailable.
    expect(sponsored.available).toBe(false);
  });
});

describe('POST /v1/runs is gated before it is dispatched', () => {
  it('refuses before any counter moves when nothing is wired behind the port', async () => {
    const store = new InMemoryAbuseStore();
    const started = await startRelay({
      abuseStore: store,
      verification: verifier(),
      asn: asnPort(),
    });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const refused = await fetch(`${started.base}/v1/runs`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(refused.status).toBe(503);
    // Charging a caller's daily allowance on the way to telling them the relay
    // cannot run anything would cost them tomorrow's run for nothing.
    expect(await store.dailyCount('relay:sponsored:daily-budget', new Date().toISOString().slice(0, 10))).toBe(0);
  });

  it('forwards the run when every gate passes, and does not read the answer — CONTROL', async () => {
    const seen: unknown[] = [];
    const port: RunDispatchPort = {
      name: 'test-run-service',
      async startRun(request) {
        seen.push(request.body);
        return { status: 201, body: { anything: 'the relay does not parse this', run: { id: 'r1' } } };
      },
      async runStatus() {
        return { status: 200, body: { run: { id: 'r1' } } };
      },
    };
    const started = await startRelay({ verification: verifier(), asn: asnPort(), runDispatch: port });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const answered = await fetch(`${started.base}/v1/runs`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ prompt: 'build a shop', policy: 'a-policy-the-relay-has-never-heard-of' }),
    });
    expect(answered.status).toBe(201);
    expect(await json(answered)).toEqual({ anything: 'the relay does not parse this', run: { id: 'r1' } });
    // The relay validated the prompt and the project and passed the rest
    // through untouched — including a routing policy it does not know.
    expect(seen[0]).toMatchObject({ policy: 'a-policy-the-relay-has-never-heard-of' });
  });

  it('gives the sponsored run back when the dispatch fails', async () => {
    const store = new InMemoryAbuseStore();
    const port: RunDispatchPort = {
      name: 'test-run-service',
      async startRun() {
        throw new Error('the run service is down');
      },
      async runStatus() {
        return { status: 200, body: {} };
      },
    };
    const started = await startRelay({ abuseStore: store, verification: verifier(), asn: asnPort(), runDispatch: port });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const failed = await fetch(`${started.base}/v1/runs`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(failed.status).toBe(500);
    const day = new Date().toISOString().slice(0, 10);
    // Reserve-then-release: the run did not happen, so the capacity was not
    // spent. Counting it anyway would be a tax on the relay's own failures.
    expect(await store.dailyCount('relay:sponsored:daily-budget', day)).toBe(0);
    expect(await store.dailyCount('relay:sponsored:user:user-1', day)).toBe(0);
  });

  it('answers the event stream with a reason rather than hanging up', async () => {
    const port: RunDispatchPort = {
      name: 'test-run-service',
      async startRun() {
        return { status: 201, body: {} };
      },
      async runStatus() {
        return { status: 200, body: {} };
      },
      // No `runEvents`: a run service that cannot stream is not a broken one.
    };
    const started = await startRelay({ verification: verifier(), asn: asnPort(), runDispatch: port });
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const stream = await fetch(`${started.base}/v1/runs/abc/events`, { headers: producerHeaders(session) });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const text = await stream.text();
    expect(text).toContain('event: closed');
    expect(text).toContain('does not stream events');
  });
});
