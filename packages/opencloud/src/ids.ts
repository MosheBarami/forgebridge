/**
 * Universe and place ids, checked at the boundary they arrive on.
 *
 * A universe id that is `undefined`, `NaN` or `0` becomes the string
 * "undefined" in a URL path, and the request that follows is a 404 whose
 * message is about a universe rather than about the caller's mistake. The
 * daemon makes the same argument for `--project` needing to be a uuid: bad
 * input fails where it arrived, not four layers down wearing someone else's
 * error message.
 *
 * Ids are returned as strings because that is what goes into a path, and
 * because Roblox ids are already large enough that arithmetic on them is a
 * mistake waiting for `Number.MAX_SAFE_INTEGER`.
 */
export function assertRobloxId(value: number | string, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`opencloud: ${field} must be a positive integer (got ${String(value)})`);
    }
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    return value.trim();
  }
  throw new Error(`opencloud: ${field} must be a positive integer (got "${String(value)}")`);
}
