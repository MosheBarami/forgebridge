import { z } from 'zod';

/**
 * The closed set of protocol errors. Closed on purpose: a consumer must be able
 * to branch on the code, and "some string the server felt like" is not
 * branchable. New codes are an additive protocol change.
 */
export const ErrorCode = z.enum([
  'invalid_request',      // 400 — failed schema validation
  'stale_base',           // 409 — baseVersion no longer current; rebase and resubmit
  'not_approved',         // 403 — apply attempted before approval
  'policy_violation',     // 403 — outside the project's allowed paths
  'link_unpaired',        // 409 — no Studio session on the other end
  'link_unauthenticated', // 401 — bad or missing MAC
  'replay_detected',      // 409 — nonce at or below the last accepted
  'too_large',            // 413 — exceeds a protocol limit
  'rate_limited',         // 429 — slow down
  'budget_exhausted',     // 429 — the day's sponsored capacity is spent
  'provider_unconfigured',// 503 — no usable model for this request
  'unsupported_version',  // 426 — plugin and server disagree on protocol version
  'not_found',            // 404
  'internal',             // 500 — never carries an internal detail
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  stale_base: 409,
  not_approved: 403,
  policy_violation: 403,
  link_unpaired: 409,
  link_unauthenticated: 401,
  replay_detected: 409,
  too_large: 413,
  rate_limited: 429,
  budget_exhausted: 429,
  provider_unconfigured: 503,
  unsupported_version: 426,
  not_found: 404,
  internal: 500,
};

/**
 * Errors say what happened and what to do about it. No stack traces reach a
 * client, and `internal` never carries a detail — a message that leaks a query
 * or a path is a security finding, not a debugging convenience.
 */
export const ProtocolError = z.object({
  code: ErrorCode,
  message: z.string().max(500),
  /** What the caller should do next, in plain language. */
  remedy: z.string().max(500).optional(),
  /** Correlates with the OpenTelemetry trace, for support. */
  traceId: z.string().max(64).optional(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

export class ForgeBridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'ForgeBridgeError';
  }
  get status(): number { return HTTP_STATUS[this.code]; }
  toPayload(): ProtocolError {
    return { code: this.code, message: this.message, ...(this.remedy ? { remedy: this.remedy } : {}) };
  }
}
