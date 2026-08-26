import { describe, it, expect } from 'vitest';
import { attemptSummary } from '@forgebridge/protocol';
import { CircuitBreaker } from '../src/breaker.js';
import {
  ModelRouter,
  orderCandidates,
  type InvocationResult,
  type ModelCandidate,
  type ModelInvoker,
} from '../src/router.js';
import { fixedClock } from './helpers.js';

function model(id: string, over: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    id,
    provider: over.provider ?? 'openrouter',
    contextTokens: 256_000,
    capabilities: ['tools', 'structured_outputs'],
    free: true,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    ...over,
  };
}

/** Replies from a script, one per call, so the fallback chain is fully determined. */
function scripted<T>(replies: InvocationResult<T>[]): ModelInvoker<T> {
  let call = 0;
  return async () => {
    const reply = replies[call];
    call += 1;
    if (!reply) throw new Error('the router invoked more models than the test scripted');
    return reply;
  };
}

describe('fallback is recorded, never silent', () => {
  it('records BOTH models when the first is rate limited and the second succeeds', async () => {
    const clock = fixedClock();
    const router = new ModelRouter({ clock: clock.now });
    const catalog = [model('z-ai/glm-5.2:free'), model('minimax/minimax-m3:free', { provider: 'openrouter' })];

    const result = await router.run<string>(
      catalog,
      { policy: 'free-first' },
      scripted<string>([
        { outcome: 'rate-limited', note: '429 from upstream' },
        { outcome: 'ok', output: 'the code', promptTokens: 10, completionTokens: 20, costUsd: 0 },
      ]),
    );

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe('the code');
    expect(result.model?.id).toBe('minimax/minimax-m3:free');

    // The whole point of ADR-008: the caller can reconstruct what actually ran.
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      modelId: 'z-ai/glm-5.2:free',
      providerSlug: 'openrouter',
      outcome: 'rate-limited',
      note: '429 from upstream',
    });
    expect(result.attempts[1]).toMatchObject({ modelId: 'minimax/minimax-m3:free', outcome: 'ok' });
    expect(attemptSummary(result.attempts)).toBe('z-ai/glm-5.2:free → rate-limited → minimax/minimax-m3:free');
  });

  it('returns the full attempt list when every model fails', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('a'), model('b')],
      { policy: 'free-first' },
      scripted<string>([{ outcome: 'rate-limited' }, { outcome: 'rate-limited' }]),
    );

    expect(result.succeeded).toBe(false);
    expect(result.attempts.map((attempt) => attempt.modelId)).toEqual(['a', 'b']);
    expect(result.failure?.code).toBe('rate_limited');
  });

  it('records a thrown adapter error as a provider-error attempt rather than losing it', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    let call = 0;
    const result = await router.run<string>([model('a'), model('b')], { policy: 'free-first' }, async () => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      return { outcome: 'ok', output: 'done' };
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ modelId: 'a', outcome: 'provider-error', note: 'socket hang up' });
    expect(result.succeeded).toBe(true);
  });

  it('downgrades an adapter that claims ok with no output', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('a')],
      { policy: 'free-first' },
      scripted<string>([{ outcome: 'ok' }]),
    );

    expect(result.succeeded).toBe(false);
    expect(result.attempts[0]?.outcome).toBe('invalid-output');
    expect(result.attempts[0]?.note).toContain('reported ok with no output');
  });

  it('measures each attempt against the injected clock', async () => {
    const clock = fixedClock();
    const router = new ModelRouter({ clock: clock.now });
    const result = await router.run<string>([model('a')], { policy: 'free-first' }, async () => {
      clock.advance(1_500);
      return { outcome: 'ok', output: 'x' };
    });

    expect(result.attempts[0]?.durationMs).toBe(1_500);
    expect(result.attempts[0]?.startedAt).toBe('2026-08-26T00:00:00.000Z');
  });
});

describe('pinned', () => {
  it('never falls back, even when the pinned model fails and others would work', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const catalog = [model('pinned-one'), model('would-have-worked')];

    const result = await router.run<string>(
      catalog,
      { policy: 'pinned', pinnedModelId: 'pinned-one' },
      scripted<string>([{ outcome: 'provider-error', note: '500' }]),
    );

    expect(result.succeeded).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.modelId).toBe('pinned-one');
    expect(result.ordering.order).toEqual(['pinned-one']);
    expect(result.failure?.remedy).toContain('unpin');
  });

  it('ignores a maxAttempts that would re-enable fallback', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('pinned-one'), model('other')],
      { policy: 'pinned', pinnedModelId: 'pinned-one', maxAttempts: 5 },
      scripted<string>([{ outcome: 'timeout' }]),
    );

    expect(result.attempts).toHaveLength(1);
  });

  it('refuses a pinned id that is not in the candidate list', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('a')],
      { policy: 'pinned', pinnedModelId: 'ghost' },
      scripted<string>([]),
    );

    expect(result.attempts).toHaveLength(0);
    expect(result.failure?.code).toBe('provider_unconfigured');
    expect(result.failure?.message).toContain('ghost');
  });

  it('records a zero-duration attempt when the pinned model lacks a required capability', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('no-tools', { capabilities: ['reasoning'] })],
      { policy: 'pinned', pinnedModelId: 'no-tools', requirements: { capabilities: ['tools'] } },
      scripted<string>([]),
    );

    // Not invoked, but the user named this model, so the run log has to say so.
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ modelId: 'no-tools', outcome: 'capability-missing', durationMs: 0 });
    expect(result.attempts[0]?.note).toContain('tools');
  });

  it('requires a pinnedModelId', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>([model('a')], { policy: 'pinned' }, scripted<string>([]));
    expect(result.failure?.code).toBe('invalid_request');
  });
});

describe('capability filtering', () => {
  it('drops models that lack a required capability before ordering', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('no-tools', { capabilities: [] }), model('has-tools')],
      { policy: 'free-first', requirements: { capabilities: ['tools'] } },
      scripted<string>([{ outcome: 'ok', output: 'x' }]),
    );

    expect(result.ordering.candidatesConsidered).toBe(2);
    expect(result.ordering.candidatesEligible).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.modelId).toBe('has-tools');
  });

  it('fails clearly when nothing meets the context requirement', async () => {
    const router = new ModelRouter({ clock: fixedClock().now });
    const result = await router.run<string>(
      [model('small', { contextTokens: 8_000 })],
      { policy: 'free-first', requirements: { minContextTokens: 200_000 } },
      scripted<string>([]),
    );

    expect(result.attempts).toHaveLength(0);
    expect(result.failure?.code).toBe('provider_unconfigured');
  });
});

describe('circuit breaker interaction', () => {
  it('skips a circuit-broken provider and reports it as skipped, not attempted', async () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 }, clock.now);
    breaker.recordFailure('flaky');
    const router = new ModelRouter({ breaker, clock: clock.now });

    const result = await router.run<string>(
      [model('flaky-model', { provider: 'flaky' }), model('healthy-model', { provider: 'healthy' })],
      { policy: 'free-first' },
      scripted<string>([{ outcome: 'ok', output: 'x' }]),
    );

    expect(result.attempts.map((attempt) => attempt.modelId)).toEqual(['healthy-model']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ modelId: 'flaky-model', reason: 'circuit-open' });
    expect(result.skipped[0]?.retryAfterMs).toBe(60_000);
  });

  it('opens the breaker on rate limits and provider errors, but not on a refusal', async () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 }, clock.now);
    const router = new ModelRouter({ breaker, clock: clock.now });

    await router.run<string>([model('a', { provider: 'p' })], { policy: 'free-first' }, scripted<string>([{ outcome: 'refused' }]));
    expect(breaker.stateOf('p')).toBe('closed');

    await router.run<string>([model('a', { provider: 'p' })], { policy: 'free-first' }, scripted<string>([{ outcome: 'rate-limited' }]));
    await router.run<string>([model('a', { provider: 'p' })], { policy: 'free-first' }, scripted<string>([{ outcome: 'provider-error' }]));
    expect(breaker.stateOf('p')).toBe('open');
  });

  it('explains itself when every provider is suppressed', async () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 }, clock.now);
    breaker.recordFailure('p');
    const router = new ModelRouter({ breaker, clock: clock.now });

    const result = await router.run<string>([model('a', { provider: 'p' })], { policy: 'free-first' }, scripted<string>([]));

    expect(result.attempts).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.failure?.message).toContain('circuit-broken');
    expect(result.failure?.remedy).toContain('30s');
  });

  it('does not let a suppressed provider consume the attempt budget', async () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 }, clock.now);
    breaker.recordFailure('down');
    const router = new ModelRouter({ breaker, clock: clock.now });

    const result = await router.run<string>(
      [model('a', { provider: 'down' }), model('b', { provider: 'up' })],
      { policy: 'free-first', maxAttempts: 1 },
      scripted<string>([{ outcome: 'ok', output: 'x' }]),
    );

    expect(result.succeeded).toBe(true);
    expect(result.attempts[0]?.modelId).toBe('b');
  });
});

describe('ordering', () => {
  const now = Date.parse('2026-08-26T00:00:00.000Z');

  it('free-first puts free models ahead of cheap paid ones', () => {
    const paid = model('paid', { free: false, pricing: { inputPerMTok: 0.1, outputPerMTok: 0.1 } });
    const free = model('free');
    expect(orderCandidates([paid, free], 'free-first', now).ordered.map((m) => m.id)).toEqual(['free', 'paid']);
  });

  it('best orders on coding score first', () => {
    const strong = model('strong', { benchmarks: { coding: 90, intelligence: 10 } });
    const clever = model('clever', { benchmarks: { coding: 40, intelligence: 99 } });
    expect(orderCandidates([clever, strong], 'best', now).ordered.map((m) => m.id)).toEqual(['strong', 'clever']);
  });

  it('best puts an unbenchmarked model last rather than treating it as zero', () => {
    const unknown = model('unknown');
    const weak = model('weak', { benchmarks: { coding: 1 } });
    expect(orderCandidates([unknown, weak], 'best', now).ordered.map((m) => m.id)).toEqual(['weak', 'unknown']);
  });

  it('cheapest sums both token prices', () => {
    const a = model('a', { free: false, pricing: { inputPerMTok: 1, outputPerMTok: 9 } });
    const b = model('b', { free: false, pricing: { inputPerMTok: 4, outputPerMTok: 4 } });
    expect(orderCandidates([a, b], 'cheapest', now).ordered.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('fastest says so when no latency has ever been measured', () => {
    const report = orderCandidates([model('a'), model('b')], 'fastest', now);
    expect(report.note).toContain('no latency has been measured');
    expect(report.ordered.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('deprioritises a model that expires within the ADR-007 window', () => {
    const expiring = model('expiring', { expiresAt: '2026-09-10T00:00:00.000Z', benchmarks: { coding: 99 } });
    const stable = model('stable', { benchmarks: { coding: 10 } });
    expect(orderCandidates([expiring, stable], 'best', now).ordered.map((m) => m.id)).toEqual(['stable', 'expiring']);
  });

  it('trusts the registry flag over the local derivation', () => {
    const flagged = model('flagged', { expiresAt: null, expiringSoon: true });
    const plain = model('plain');
    expect(orderCandidates([flagged, plain], 'best', now).ordered.map((m) => m.id)).toEqual(['plain', 'flagged']);
  });

  it('does not deprioritise on an unparseable expiry date', () => {
    const odd = model('odd', { expiresAt: 'soon-ish' });
    const plain = model('plain');
    expect(orderCandidates([odd, plain], 'best', now).ordered.map((m) => m.id)).toEqual(['odd', 'plain']);
  });
});
