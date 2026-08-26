/**
 * Small renderers shared by the commands.
 *
 * Every one of these takes something the protocol guarantees and turns it into
 * something a person reads at a glance. None of them decide anything.
 */

/** `3s`, `4m`, `2h 10m`, `6d`. Rounded, because nobody reads uptime to the second. */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  if (whole < 86_400) {
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  return `${Math.floor(whole / 86_400)}d`;
}

/**
 * "12s ago" for an ISO timestamp.
 *
 * A clock skew between this machine and the transport shows up here as a
 * negative age. It is reported as `in the future` rather than clamped to `0s
 * ago`, because a link whose last-seen is ahead of now is a fact worth seeing,
 * not a rounding error worth hiding.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return 'never';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const deltaSeconds = (now - at) / 1000;
  if (deltaSeconds < -1) return `in the future (${humanDuration(-deltaSeconds)})`;
  return `${humanDuration(Math.max(0, deltaSeconds))} ago`;
}

/** Thousands separators, so a 200000-token context window is readable. */
export function humanCount(value: number): string {
  return value.toLocaleString('en-US');
}
