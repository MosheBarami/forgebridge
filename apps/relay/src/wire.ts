import { z } from 'zod';
import {
  ChangeSet,
  ChangeSetStatus,
  InverseOperation,
  LIMITS,
  Link,
  PairingCode,
  RollbackResult,
  TransportKind,
  Validation,
} from '@forgebridge/protocol';

/**
 * Request and response shapes for the `/v1` endpoints `docs/PROTOCOL.md` names
 * but does not schematise.
 *
 * `packages/daemon/src/wire.ts` says exactly what this file is at risk of
 * being: "a shape a handler makes up is a shape the relay will make up
 * differently". So these are not made up here — they are the daemon's, copied,
 * with the copy held in place by `test/drift.test.ts`, which parses the same
 * fixtures through both packages' schemas and fails when one accepts what the
 * other refuses. The daemon's own TODO(M31) is the fix that deletes both
 * copies: promote these into `@forgebridge/protocol`.
 *
 * Two shapes here are NOT the daemon's, and are marked where they appear:
 * `RelayRunRequest`, because the relay must not restate the core's routing
 * vocabulary it has no way to check, and `RelaySessionResponse`, because
 * provisioning has no daemon equivalent at all.
 */

export const PairRequest = z.object({
  pairingCode: PairingCode,
  /** Which project this Studio session is bound to; the session's default if omitted. */
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
  /**
   * `attemptsRemaining` is nullable here where the daemon's is a number. See
   * the header of `pairing.ts`: a per-code attempt cap cannot fire behind a
   * digest lookup, and reporting one would describe a defence this transport
   * does not have.
   */
  pairing: z
    .object({ expiresAt: z.string().datetime(), attemptsRemaining: z.number().int().min(0).nullable() })
    .nullable(),
});
export type LinkStatusResponse = z.infer<typeof LinkStatusResponse>;

export const ApproveRequest = z.object({
  /**
   * The `contentDigest` the diff reported for the set being approved.
   *
   * Required, with no default: an approval names a ChangeSet id, and an id is
   * not content. Echoing the digest is what turns "I approve set X" into "I
   * approve the operations I was shown for set X", which is the only version of
   * the sentence ADR-012 can rest on.
   */
  contentDigest: z.string().min(1).max(200),
  /** Who cleared it. */
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

export const OperationDiff = z.object({
  index: z.number().int().min(0),
  op: z.string(),
  paths: z.array(z.string()),
  summary: z.string(),
  destructive: z.boolean(),
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
  counts: z.object({
    total: z.number().int().min(0),
    creates: z.number().int().min(0),
    setProperties: z.number().int().min(0),
    scripts: z.number().int().min(0),
    moves: z.number().int().min(0),
    deletes: z.number().int().min(0),
  }),
  contentDigest: z.string().min(1).max(200),
  operations: z.array(OperationDiff),
  validation: Validation.optional(),
  treeAware: z.literal(false),
  /**
   * Not a daemon field, and the one addition this transport genuinely needs.
   *
   * The daemon computes the verdict it serves, inside its own trust boundary,
   * and `Validation.computedBy` names it. The relay computes nothing — it
   * carries whatever verdict the producer attached — so a reviewer reading a
   * diff on this transport has to be told, on the page, that the verdict below
   * is a claim the relay is relaying rather than one it made. Leaving it out
   * would let the same page mean two different things depending on which base
   * URL rendered it.
   */
  validationWitnessedHere: z.literal(false),
});
export type ChangeSetDiff = z.infer<typeof ChangeSetDiff>;

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

export const ApproveResponse = z.object({
  changeSetId: z.string().uuid(),
  status: z.string(),
  /** The delivery nonce the consumer will see this set under. */
  nonce: z.number().int().min(0),
});
export type ApproveResponse = z.infer<typeof ApproveResponse>;

/**
 * `POST /v1/changesets` — accepted, with the verdict it arrived carrying.
 *
 * The daemon has no schema for this response; `scripts/generate-schemas.ts`
 * transcribes it by hand and carries a TODO(M31) asking for one. This app
 * declares it and parses through it, so the shape a handler writes and the shape
 * this file describes cannot disagree — a response the relay could not validate
 * against its own wire schema is one a strict client is entitled to reject, and
 * finding that out here beats finding it out there.
 *
 * `validationWitnessedHere` is the field with no daemon counterpart, for the
 * reason given on `ChangeSetDiff`.
 */
export const SubmitChangeSetResponse = z.object({
  changeSetId: z.string().uuid(),
  status: ChangeSetStatus,
  baseVersion: z.number().int().min(0),
  contentDigest: z.string().min(1).max(200),
  validation: Validation,
  validationWitnessedHere: z.literal(false),
});
export type SubmitChangeSetResponse = z.infer<typeof SubmitChangeSetResponse>;

export const ModelsSnapshot = z.object({
  configured: z.boolean(),
  source: z.string().max(200),
  verifiedAt: z.string().datetime().nullable(),
  models: z.array(z.record(z.string(), z.unknown())),
});
export type ModelsSnapshot = z.infer<typeof ModelsSnapshot>;

/**
 * What a consumer receives on a poll. Tagged rather than a bare ChangeSet
 * because a rollback the user requested has no other route to the plugin —
 * `PROTOCOL.md` limits it to `poll`, `apply-result` and `output`.
 */
export const RollbackDelivery = z.object({
  kind: z.literal('rollback'),
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  /** Refused by the consumer if its tree has moved on. */
  expectedVersion: z.number().int().min(0),
  reason: z.string().max(500).optional(),
  /** The version to restore to. A consumer reports this back as `newVersion`. */
  restoresToVersion: z.number().int().min(0),
  /**
   * The inverses to replay, already in replay order.
   *
   * `index` is an index into the journal's `inverses`, NOT into the ChangeSet's
   * operations. The two lists differ whenever an apply was partial, and a
   * consumer that reports outcomes against the wrong one names the wrong
   * operation as the failure.
   */
  steps: z
    .array(z.object({ index: z.number().int().min(0), inverse: InverseOperation }))
    .max(LIMITS.MAX_OPERATIONS),
});
export type RollbackDelivery = z.infer<typeof RollbackDelivery>;

export const DeliveryPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changeset'), changeSet: ChangeSet }),
  RollbackDelivery,
]);
export type DeliveryPayload = z.infer<typeof DeliveryPayload>;

export const RollbackResponse = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  /**
   * Still `dispatched`, and deliberately still only that: the consumer has not
   * polled yet, let alone replayed anything. `GET /v1/journal/{journalId}` is
   * where the outcome shows up.
   */
  status: z.literal('dispatched'),
  nonce: z.number().int().min(0),
  /** How many inverses were dispatched. The count a consumer will report on. */
  steps: z.number().int().min(0),
});
export type RollbackResponse = z.infer<typeof RollbackResponse>;

/** `POST /v1/journal/{journalId}/entry` — the consumer's inverses are recorded. */
export const JournalEntryAck = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  /** How many inverse operations this relay now holds for that apply. */
  inverses: z.number().int().min(0),
});
export type JournalEntryAck = z.infer<typeof JournalEntryAck>;

/**
 * What a journal is, in one word, wherever it is asked.
 *
 * `rollback_partial` is not a decoration on `rolled_back`. A partial reversal
 * leaves the tree in a state neither the user nor the journal describes, and the
 * inverses that would have finished the job are spent — so it is its own answer,
 * and no surface may round it up.
 */
export const JournalState = z.enum([
  'applied',
  'rollback_requested',
  'rolled_back',
  'rollback_partial',
  'rollback_failed',
]);
export type JournalState = z.infer<typeof JournalState>;

/** `POST /v1/journal/{journalId}/rollback-result` — the consumer's report, acknowledged. */
export const RollbackResultAck = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  state: JournalState,
  version: z.number().int().min(0),
});
export type RollbackResultAck = z.infer<typeof RollbackResultAck>;

/** `GET /v1/journal/{journalId}` — what happened to one apply, and to any reversal. */
export const JournalStateResponse = z.object({
  journalId: z.string().uuid(),
  changeSetId: z.string().uuid(),
  projectId: z.string().uuid(),
  summary: z.string(),
  state: JournalState,
  versionBefore: z.number().int().min(0),
  versionAfter: z.number().int().min(0),
  appliedAt: z.string().datetime(),
  rollbackRequestedAt: z.string().datetime().nullable(),
  rolledBackAt: z.string().datetime().nullable(),
  /**
   * How many inverses this relay holds, or null when it holds none. Null and 0
   * are different facts: 0 is an apply with nothing to undo, null is an apply
   * whose only route back stayed inside a Studio session.
   */
  inverses: z.number().int().min(0).nullable(),
  result: RollbackResult.nullable(),
});
export type JournalStateResponse = z.infer<typeof JournalStateResponse>;

// ── shapes with no daemon counterpart ────────────────────────────────────────

/**
 * `POST /v1/runs`, as far as the relay is entitled to read it.
 *
 * The daemon's `StartRunRequest` enumerates the core's routing policies and
 * pins that enum to the core's TypeScript union so the two cannot drift. The
 * relay has no core to pin against, and a hand-copied `['free-first', …]` here
 * would be a list that goes stale silently and starts refusing policies the
 * pipeline understands.
 *
 * So the relay validates only what it *gates on* — the prompt is capped where
 * `Run.prompt` is capped, and the project must be a project — and passes the
 * rest through untouched to whatever is wired behind `RunDispatchPort`. Reading
 * less is the pipe's job; a relay that understood the routing vocabulary would
 * be a relay with an opinion about which model runs.
 */
export const RelayRunRequest = z
  .object({
    prompt: z.string().min(1).max(50_000),
    projectId: z.string().uuid().optional(),
  })
  .passthrough();
export type RelayRunRequest = z.infer<typeof RelayRunRequest>;

/**
 * What `POST /control/sessions` returns — the relay's provisioning surface,
 * which is deliberately outside `/v1`.
 *
 * ADR-004 freezes the `/v1` surface so the plugin has one implementation; it
 * says nothing about paths that are not `/v1`, and provisioning cannot be one
 * of them. On the daemon the producer token is printed to the terminal of the
 * person who started the process and the pairing code beside it; there is no
 * terminal here and no such person, so the relay has to hand both to a caller
 * over HTTP. Putting that under `/v1` would add a route to a frozen protocol
 * that the daemon does not serve and the plugin must never call.
 */
export const RelaySessionResponse = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  /**
   * Returned exactly once, in this response, and never served again. It is the
   * relay's equivalent of the secret the daemon prints at startup.
   */
  producerToken: z.string().min(1),
  pairingCode: PairingCode,
  pairingExpiresAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  transport: TransportKind,
  privacyPosture: z.string(),
});
export type RelaySessionResponse = z.infer<typeof RelaySessionResponse>;
