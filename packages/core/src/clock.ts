/**
 * Epoch milliseconds, as a function.
 *
 * Every time-dependent decision in the core — a circuit breaker's cooldown, an
 * attempt's duration, a model's expiry window — takes one of these. Reaching for
 * `Date.now()` directly would make those decisions untestable except by sleeping,
 * and a test that sleeps is a test that is flaky on a loaded CI runner.
 */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** ISO-8601, the only timestamp format the protocol accepts on the wire. */
export function isoAt(clock: Clock): string {
  return new Date(clock()).toISOString();
}
