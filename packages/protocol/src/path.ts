import { z } from 'zod';
import { LIMITS } from './limits.js';

/**
 * A dotted path from a Roblox service root to an instance:
 *   "ServerScriptService.Shop.PurchaseHandler"
 *
 * Deliberately restrictive. Roblox permits almost any string as an
 * Instance.Name, including dots and quotes — which would make a dotted path
 * ambiguous and, worse, would let a model smuggle a path separator into a name
 * to escape a policy prefix check. ForgeBridge only addresses instances whose
 * names are safe identifiers; anything else must be renamed first, and the
 * plugin reports that as a clear error rather than guessing.
 */
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Roblox service roots a ChangeSet may address. */
export const SERVICE_ROOTS = [
  'Workspace',
  'ServerScriptService',
  'ServerStorage',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'Lighting',
  'SoundService',
  'Teams',
  'Chat',
  'TextChatService',
] as const;

export type ServiceRoot = (typeof SERVICE_ROOTS)[number];

export const InstancePath = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const segments = value.split('.');

    if (segments.length > LIMITS.MAX_PATH_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `path exceeds max depth ${LIMITS.MAX_PATH_DEPTH}`,
      });
      return;
    }

    for (const segment of segments) {
      if (segment.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'empty path segment' });
        return;
      }
      if (segment.length > LIMITS.MAX_SEGMENT_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `path segment "${segment.slice(0, 20)}…" exceeds ${LIMITS.MAX_SEGMENT_LENGTH} characters`,
        });
        return;
      }
      if (!SEGMENT.test(segment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `path segment "${segment}" is not a safe identifier`,
        });
        return;
      }
    }

    const root = segments[0];
    if (!(SERVICE_ROOTS as readonly string[]).includes(root as string)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${root}" is not an addressable service root`,
      });
    }
  })
  .brand<'InstancePath'>();

export type InstancePath = z.infer<typeof InstancePath>;

/** Split a validated path into its segments. */
export function segmentsOf(path: string): string[] {
  return path.split('.');
}

/** The parent path, or null for a service root. */
export function parentOf(path: string): string | null {
  const segments = segmentsOf(path);
  return segments.length <= 1 ? null : segments.slice(0, -1).join('.');
}

/** The final segment — the instance's own name. */
export function nameOf(path: string): string {
  const segments = segmentsOf(path);
  return segments[segments.length - 1] as string;
}

/**
 * True when `path` is `prefix` or lies beneath it.
 *
 * Segment-aware on purpose: a naive `startsWith` would report
 * "ServerScriptService.ShopAdmin" as being inside "ServerScriptService.Shop",
 * which is exactly the bug that turns a policy path allowlist into a hole.
 */
export function isWithin(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const p = segmentsOf(prefix);
  const c = segmentsOf(path);
  if (c.length <= p.length) return false;
  return p.every((segment, i) => c[i] === segment);
}
