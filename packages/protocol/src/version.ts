/**
 * The protocol version. Frozen at the v1.0.0 tag; additive fields only.
 *
 * The plugin sends its own version in `X-ForgeBridge-Plugin`. When a server
 * holds operations a plugin cannot understand, it refuses the delivery and the
 * plugin surfaces "update required" — it never applies the subset it recognises.
 * A half-applied ChangeSet from a version mismatch is exactly the failure the
 * journal cannot cleanly reverse.
 */
export const PROTOCOL_VERSION = '1.0.0' as const;
export const PROTOCOL_MAJOR = 1 as const;
export const PLUGIN_VERSION_HEADER = 'X-ForgeBridge-Plugin' as const;
export const PROTOCOL_VERSION_HEADER = 'X-ForgeBridge-Protocol' as const;

/** A consumer at `pluginMajor` can safely apply sets from `serverMajor`. */
export function isCompatible(serverMajor: number, pluginMajor: number): boolean {
  return serverMajor === pluginMajor;
}
