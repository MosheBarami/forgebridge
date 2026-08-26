import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/breaker.js';
import { fixedClock } from './helpers.js';

const CONFIG = { failureThreshold: 3, cooldownMs: 60_000, halfOpenSuccessesToClose: 1 };

function makeBreaker() {
  const clock = fixedClock();
  return { clock, breaker: new CircuitBreaker(CONFIG, clock.now) };
}

describe('closed', () => {
  it('starts closed for a key it has never seen', () => {
    const { breaker } = makeBreaker();
    expect(breaker.stateOf('openrouter')).toBe('closed');
    expect(breaker.allows('openrouter')).toBe(true);
  });

  it('stays closed below the failure threshold', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure('openrouter');
    breaker.recordFailure('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('closed');
  });

  it('requires the failures to be consecutive', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure('openrouter');
    breaker.recordFailure('openrouter');
    breaker.recordSuccess('openrouter');
    breaker.recordFailure('openrouter');
    breaker.recordFailure('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('closed');
  });

  it('keys are independent', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('open');
    expect(breaker.stateOf('ollama')).toBe('closed');
  });
});

describe('open', () => {
  it('opens on the Nth consecutive failure', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('open');
    expect(breaker.allows('openrouter')).toBe(false);
  });

  it('is still open one millisecond before the cooldown elapses', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(CONFIG.cooldownMs - 1);
    expect(breaker.stateOf('openrouter')).toBe('open');
    expect(breaker.retryAfterMs('openrouter')).toBe(1);
  });

  it('does not extend its own cooldown when a caller ignores it', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(30_000);
    breaker.recordFailure('openrouter');
    clock.advance(30_000);
    expect(breaker.stateOf('openrouter')).toBe('half-open');
  });
});

describe('half-open', () => {
  it('becomes half-open exactly at the cooldown boundary', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(CONFIG.cooldownMs);
    expect(breaker.stateOf('openrouter')).toBe('half-open');
    expect(breaker.allows('openrouter')).toBe(true);
    expect(breaker.retryAfterMs('openrouter')).toBe(0);
  });

  it('closes on a successful probe and forgets the failure streak', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(CONFIG.cooldownMs);
    breaker.recordSuccess('openrouter');

    expect(breaker.stateOf('openrouter')).toBe('closed');
    const [snapshot] = breaker.snapshot();
    expect(snapshot?.consecutiveFailures).toBe(0);
  });

  it('reopens with a full fresh cooldown when the probe fails', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(CONFIG.cooldownMs);
    expect(breaker.stateOf('openrouter')).toBe('half-open');

    breaker.recordFailure('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('open');

    clock.advance(CONFIG.cooldownMs - 1);
    expect(breaker.stateOf('openrouter')).toBe('open');
    clock.advance(1);
    expect(breaker.stateOf('openrouter')).toBe('half-open');
  });

  it('needs the configured number of probes when more than one is required', () => {
    const clock = fixedClock();
    const breaker = new CircuitBreaker({ ...CONFIG, halfOpenSuccessesToClose: 2 }, clock.now);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(CONFIG.cooldownMs);

    breaker.recordSuccess('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('half-open');
    breaker.recordSuccess('openrouter');
    expect(breaker.stateOf('openrouter')).toBe('closed');
  });
});

describe('snapshot and reset', () => {
  it('reports state and retry window for the UI', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    clock.advance(20_000);

    const [snapshot] = breaker.snapshot();
    expect(snapshot?.key).toBe('openrouter');
    expect(snapshot?.state).toBe('open');
    expect(snapshot?.retryAfterMs).toBe(40_000);
  });

  it('resets one key without touching the others', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('openrouter');
    for (let i = 0; i < 3; i += 1) breaker.recordFailure('groq');
    breaker.reset('openrouter');

    expect(breaker.stateOf('openrouter')).toBe('closed');
    expect(breaker.stateOf('groq')).toBe('open');
  });
});
