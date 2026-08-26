import { z } from 'zod';
import {
  ChangeSet,
  Link,
  PairingCode,
  TransportKind,
  Validation,
} from '@forgebridge/protocol';

/**
 * Request and response shapes for the `/v1` endpoints that `PROTOCOL.md` names
 * but does not yet schematise (pair, output, approve, diff, models).
 *
 * They live here, built out of protocol primitives, rather than being invented
 * inline in a handler — a shape a handler makes up is a shape the relay will
 * make up differently.
 *
 * TODO(M31): the connector conformance suite is the forcing function for
 * promoting these into `@forgebridge/protocol` so the daemon and `apps/relay`
 * cannot drift. Owner: the protocol maintainer, as an additive `/v1` change.
 */

export const PairRequest = z.object({
  pairingCode: PairingCode,
  /** Which project this Studio session is bound to; the daemon's default if omitted. */
  projectId: z.string().uuid().optional(),
  pluginVersion: z.string().max(40).optional(),
  studioVersion: z.string().max(40).optional(),
  placeId: z.number().int().nullable().optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  linkId: z.string().uuid(),
  sessionKeyId: z.string().max(64),
  projectId: z.string().uuid(),
  transport: TransportKind,
  privacyPosture: z.string(),
  /** Base64. The consumer derives the same session key from this and the code. */
  sessionSalt: z.string(),
  /** The poll cursor to start from. Always the nonce origin for a fresh link. */
  since: z.number().int().min(0),
  protocolVersion: z.string(),
});
export type PairResponse = z.infer<typeof PairResponse>;

export const LinkStatusResponse = z.object({
  transport: TransportKind,
  privacyPosture: z.string(),
  protocolVersion: z.string(),
  defaultProjectId: z.string().uuid(),
  links: z.array(Link),
  pairing: z
    .object({ expiresAt: z.string().datetime(), attemptsRemaining: z.number().int().min(0) })
    .nullable(),
});
export type LinkStatusResponse = z.infer<typeof LinkStatusResponse>;

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

export const ApproveRequest = z.object({
  /** Who cleared it. "local" when the daemon operator approved at the terminal. */
  approvedBy: z.string().max(120).default('local'),
  note: z.string().max(500).optional(),
  /**
   * Required when the set removes more instances than the protocol's bulk
   * threshold. A separate flag rather than a bigger button: the approver has to
   * say the destructive part out loud.
   */
  confirmBulkDelete: z.boolean().default(false),
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const ApproveResponse = z.object({
  changeSetId: z.string().uuid(),
  status: z.string(),
  /** The delivery nonce the consumer will see this set under. */
  nonce: z.number().int().min(0),
});
export type ApproveResponse = z.infer<typeof ApproveResponse>;

export const OperationDiff = z.object({
  index: z.number().int().min(0),
  op: z.string(),
  paths: z.array(z.string()),
  summary: z.string(),
  destructive: z.boolean(),
  /**
   * The value the operation writes — a script's new source, a property's new
   * value. There is no matching `before`: see `treeAware` below.
   */
  after: z.string().optional(),
});
export type OperationDiff = z.infer<typeof OperationDiff>;

export const ChangeSetDiff = z.object({
  changeSetId: z.string().uuid(),
  projectId: z.string().uuid(),
  summary: z.string(),
  status: z.string(),
  baseVersion: z.number().int().min(0),
  currentVersion: z.number().int().min(0),
  /** True when the tree moved after this set was built; it must be rebased. */
  stale: z.boolean(),
  counts: z.object({
    total: z.number().int().min(0),
    creates: z.number().int().min(0),
    setProperties: z.number().int().min(0),
    scripts: z.number().int().min(0),
    moves: z.number().int().min(0),
    deletes: z.number().int().min(0),
  }),
  operations: z.array(OperationDiff),
  validation: Validation.optional(),
  /**
   * The daemon renders the diff from the ChangeSet alone: it holds no tree
   * snapshot, so it can say what an operation *will* do but not what the
   * property or source was before.
   *
   * TODO(M09): the before/after diff belongs to `@forgebridge/core`, which owns
   * the tree snapshot. The daemon should render whatever core hands it rather
   * than growing a second, weaker implementation.
   */
  treeAware: z.literal(false),
});
export type ChangeSetDiff = z.infer<typeof ChangeSetDiff>;

export const RollbackResponse = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  status: z.literal('dispatched'),
  nonce: z.number().int().min(0),
});
export type RollbackResponse = z.infer<typeof RollbackResponse>;

export const OutputLevel = z.enum(['print', 'info', 'warning', 'error']);
export type OutputLevel = z.infer<typeof OutputLevel>;

export const OutputMessage = z.object({
  level: OutputLevel,
  message: z.string().max(10_000),
  at: z.string().datetime(),
  /** Where it came from in Studio, when the plugin can tell. */
  source: z.string().max(200).optional(),
});
export type OutputMessage = z.infer<typeof OutputMessage>;

export const OutputBatch = z.object({
  messages: z.array(OutputMessage).min(1).max(200),
});
export type OutputBatch = z.infer<typeof OutputBatch>;

export const OutputResponse = z.object({
  messages: z.array(OutputMessage),
});
export type OutputResponse = z.infer<typeof OutputResponse>;

export const ModelsSnapshot = z.object({
  /**
   * Whether a registry is wired in at all. An empty list from a configured
   * registry and an empty list because nothing is configured are different
   * facts, and a selector that cannot tell them apart shows the wrong message.
   */
  configured: z.boolean(),
  source: z.string().max(200),
  verifiedAt: z.string().datetime().nullable(),
  models: z.array(z.record(z.string(), z.unknown())),
});
export type ModelsSnapshot = z.infer<typeof ModelsSnapshot>;

/**
 * A registry is a port, not an import.
 *
 * `@forgebridge/model-registry` (M20) owns the catalog and its live health;
 * the daemon only serves whatever that port returns. Wiring it in here would
 * put catalog logic in the transport, which is exactly the layering the
 * component map forbids.
 */
export interface ModelsPort {
  snapshot(): Promise<ModelsSnapshot>;
}

/**
 * What a consumer receives on a poll.
 *
 * `PROTOCOL.md` describes the poll as "next ChangeSet for the plugin", and also
 * limits the plugin to `poll`, `apply-result` and `output`. A rollback the user
 * requested therefore has no other way to reach the plugin, so the delivery is
 * tagged rather than being a bare ChangeSet.
 */
export const DeliveryPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changeset'), changeSet: ChangeSet }),
  z.object({
    kind: z.literal('rollback'),
    journalId: z.string().uuid(),
    changeSetId: z.string().uuid(),
    /** Refused by the consumer if its tree has moved on. */
    expectedVersion: z.number().int().min(0),
    reason: z.string().max(500).optional(),
  }),
]);
export type DeliveryPayload = z.infer<typeof DeliveryPayload>;
