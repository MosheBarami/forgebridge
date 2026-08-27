import { z } from 'zod';
import {
  ChangeSetStatus,
  Link,
  Run,
  TransportKind,
  Validation,
} from '@forgebridge/protocol';

/**
 * The `/v1` envelope shapes, as this app parses them.
 *
 * `@forgebridge/protocol` is frozen and owns the *domain* — ChangeSet, Link,
 * Run, Validation, the error set. It does not yet own the *envelopes* those
 * ride in: `HealthResponse`, `LinkStatusResponse`, `ChangeSetDiff` and friends
 * live in `packages/daemon/src/wire.ts`, which carries its own TODO(M31)
 * saying they should be promoted into the protocol so the daemon and the relay
 * cannot drift.
 *
 * Until that happens this app has two options and both have a cost. Importing
 * `@forgebridge/daemon` for its types would couple a browser bundle to a Node
 * HTTP server package, and would make this app unbuildable whenever the daemon
 * is mid-edit. Restating the shapes here costs a second definition that can go
 * stale. This file takes the second cost and pays it down two ways:
 *
 *   - every shape is built out of protocol primitives, never out of loose
 *     `z.string()`s, so the parts that matter are still single-source;
 *   - every response is *parsed*, not cast. A daemon that answers with a shape
 *     this app does not recognise produces `invalid-response`, which the UI
 *     shows, rather than `undefined` reaching a component three renders later.
 *
 * TODO(M31): delete this file and import from `@forgebridge/protocol` once the
 * envelopes land there. Owner: the protocol maintainer.
 */

export const HealthResponse = z.object({
  ok: z.literal(true),
  service: z.literal('forgebridge-daemon'),
  version: z.string(),
  protocolVersion: z.string(),
  transport: TransportKind,
  boundTo: z.string(),
  uptimeSeconds: z.number().min(0),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const LinkStatusResponse = z.object({
  transport: TransportKind,
  /** The daemon echoes one of `PRIVACY_POSTURE`'s three strings. Rendered verbatim. */
  privacyPosture: z.string(),
  protocolVersion: z.string(),
  defaultProjectId: z.string().uuid(),
  links: z.array(Link),
  pairing: z
    .object({ expiresAt: z.string().datetime(), attemptsRemaining: z.number().int().min(0) })
    .nullable(),
});
export type LinkStatusResponse = z.infer<typeof LinkStatusResponse>;

export const ModelsSnapshot = z.object({
  /**
   * "No registry is wired in" and "the registry knows of no model you can use"
   * are different facts. A selector that cannot tell them apart shows the wrong
   * message, so the flag is separate from the list being empty.
   */
  configured: z.boolean(),
  source: z.string(),
  verifiedAt: z.string().datetime().nullable(),
  models: z.array(z.record(z.string(), z.unknown())),
});
export type ModelsSnapshot = z.infer<typeof ModelsSnapshot>;

export const OperationDiff = z.object({
  index: z.number().int().min(0),
  op: z.string(),
  paths: z.array(z.string()),
  summary: z.string(),
  destructive: z.boolean(),
  /**
   * The Luau this operation installs, or the value it writes.
   *
   * There is no `before`: the daemon holds no tree snapshot, which it declares
   * with `treeAware: false` below. A diff view must say so rather than implying
   * it has shown both sides.
   */
  after: z.string().optional(),
  properties: z.record(z.string(), z.string()).optional(),
});
export type OperationDiff = z.infer<typeof OperationDiff>;

export const ChangeSetDiff = z.object({
  changeSetId: z.string().uuid(),
  projectId: z.string().uuid(),
  summary: z.string(),
  status: z.string(),
  baseVersion: z.number().int().min(0),
  currentVersion: z.number().int().min(0),
  stale: z.boolean(),
  /**
   * `scripts` is a cross-cut of the other counts, not another slice: it counts
   * every operation that installs Luau, and such an operation is counted again
   * under `creates` or `setProperties`. These do not sum to `total`, and a UI
   * that adds them up is answering a question nobody asked.
   */
  counts: z.object({
    total: z.number().int().min(0),
    creates: z.number().int().min(0),
    setProperties: z.number().int().min(0),
    scripts: z.number().int().min(0),
    moves: z.number().int().min(0),
    deletes: z.number().int().min(0),
  }),
  /**
   * The fingerprint `approve` requires back. It is what turns "I approve set X"
   * into "I approve the operations I was shown for set X" (ADR-012). A UI that
   * lets a user approve without having loaded a diff cannot produce this value,
   * which is the intended shape of the gate rather than an inconvenience.
   */
  contentDigest: z.string(),
  operations: z.array(OperationDiff),
  validation: Validation.optional(),
  treeAware: z.literal(false),
});
export type ChangeSetDiff = z.infer<typeof ChangeSetDiff>;

export const ApproveRequest = z.object({
  contentDigest: z.string().min(1),
  approvedBy: z.string().max(120).default('local'),
  note: z.string().max(500).optional(),
  /** Required when the set deletes more than the protocol's bulk threshold. */
  confirmBulkDelete: z.boolean().default(false),
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const ApproveResponse = z.object({
  changeSetId: z.string().uuid(),
  status: z.string(),
  nonce: z.number().int().min(0),
});
export type ApproveResponse = z.infer<typeof ApproveResponse>;

export const RollbackResponse = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  status: z.literal('dispatched'),
  nonce: z.number().int().min(0),
});
export type RollbackResponse = z.infer<typeof RollbackResponse>;

export const OutputMessage = z.object({
  level: z.enum(['print', 'info', 'warning', 'error']),
  message: z.string(),
  at: z.string().datetime(),
  source: z.string().optional(),
});
export type OutputMessage = z.infer<typeof OutputMessage>;

export const OutputResponse = z.object({ messages: z.array(OutputMessage) });
export type OutputResponse = z.infer<typeof OutputResponse>;

export const ROUTING_POLICIES = ['free-first', 'fastest', 'cheapest', 'best', 'pinned'] as const;
export const RoutingPolicyName = z.enum(ROUTING_POLICIES);
export type RoutingPolicyName = z.infer<typeof RoutingPolicyName>;

export const SkippedModel = z.object({
  modelId: z.string(),
  provider: z.string(),
  reason: z.enum(['circuit-open', 'attempt-budget']),
  detail: z.string(),
  retryAfterMs: z.number().int().min(0).optional(),
});
export type SkippedModel = z.infer<typeof SkippedModel>;

export const ModelOrdering = z.object({
  policy: RoutingPolicyName,
  candidatesConsidered: z.number().int().min(0),
  candidatesEligible: z.number().int().min(0),
  order: z.array(z.string()),
  note: z.string().optional(),
});
export type ModelOrdering = z.infer<typeof ModelOrdering>;

export const StartRunRequest = z.object({
  prompt: z.string().min(1).max(50_000),
  projectId: z.string().uuid().optional(),
  policy: RoutingPolicyName.default('free-first'),
  pinnedModel: z.string().optional(),
  baseVersion: z.number().int().min(0).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  stream: z.boolean().default(false),
  producer: z.object({ kind: z.literal('web'), client: z.string().max(120).optional() }).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/**
 * What a run produced.
 *
 * `run.attempts` is the whole attempt list — success, failure and cancellation
 * alike — and it is the field ADR-008 is about. The run log must name every
 * model the router tried and why it moved on; a fallback nobody can see is a
 * silent substitution by another name. `attemptSummary` in
 * `@forgebridge/protocol` renders the one-line collapsed form.
 *
 * `changeSetId` names a set stored in `validated`, never `approved`. No run
 * reaches approval (ADR-012).
 */
export const RunResponse = z.object({
  run: Run,
  plan: z.object({ steps: z.array(z.string()) }),
  changeSetId: z.string().uuid().nullable(),
  changeSetStatus: ChangeSetStatus.nullable(),
  contentDigest: z.string().nullable(),
  validation: Validation.nullable(),
  skipped: z.array(SkippedModel),
  ordering: ModelOrdering.nullable(),
  failure: z
    .object({
      code: z.string(),
      message: z.string(),
      remedy: z.string().optional(),
      traceId: z.string().optional(),
    })
    .nullable(),
});
export type RunResponse = z.infer<typeof RunResponse>;

/**
 * What `POST /v1/changesets` answers with (201).
 *
 * Transcribed from the handler in `packages/daemon/src/server.ts`, which has no
 * schema of its own — its TODO(M31) asks for a `SubmitChangeSetResponse` in the
 * daemon's `wire.ts`, and notes that landing one there without also removing
 * the hand transcription in `scripts/generate-schemas.ts` would change nothing,
 * because the transcription wins. So this shape is checked against the handler,
 * not against a schema, and the parse below is what catches it moving.
 */
export const SubmitChangeSetResponse = z.object({
  changeSetId: z.string().uuid(),
  status: ChangeSetStatus,
  baseVersion: z.number().int().min(0),
  /** The digest `approve` requires back — carried from submit so a producer
   *  that submitted and then read the diff sees the same value both times. */
  contentDigest: z.string(),
  validation: Validation,
});
export type SubmitChangeSetResponse = z.infer<typeof SubmitChangeSetResponse>;
