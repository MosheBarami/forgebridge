/**
 * This package's own version.
 *
 * A literal rather than a read of `package.json`: the manifest is not in
 * `rootDir`, so importing it would either widen the compiled output or need a
 * runtime file read whose path differs between `dist/` and a test. The manifest
 * is the source of truth for npm; this is what the binary prints.
 *
 * TODO(M28 follow-up): pin the two together in the docs-claims gate, the way
 * `scripts/docs-claims-rules.ts` already pins manifest facts, so this cannot
 * drift from `package.json` silently. Owner: this package.
 */
export const CLI_VERSION = '0.1.0';
