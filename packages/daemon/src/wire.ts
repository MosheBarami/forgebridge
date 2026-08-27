import { z } from 'zod';
import {
  ChangeSet,
  ChangeSetStatus,
  Link,
  PairingCode,
  ProtocolError,
  Run,
  TransportKind,
  Validation,
} from '@forgebridge/protocol';
import type { ModelCandidate, ModelClient, RoutingPolicy, SkipReason } from '@forgebridge/core';

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
  /**
   * The `contentDigest` the diff reported for the set being approved.
   *
   * Required, with no default, and that is the point: an approval names a
   * ChangeSet id, and an id is not content. Echoing the digest is what turns
   * "I approve set X" into "I approve the operations I was shown for set X",
   * which is the only version of the sentence ADR-012 can rest on. A default
   * here — or an optional field the daemon skipped when absent — would be a
   * caller opting out of the binding, so a caller that has not read a diff is
   * refused rather than trusted.
   *
   * Both connectors satisfy this the same way, and neither could route it from
   * a request even if it wanted to: `packages/a2a` carries the digest on
   * `ApplyApprovalGrant`, which is minted only by `LocalOperatorApprovalGate.
   * record` from the human who read the diff, and `packages/mcp` never approves
   * at all — `forge.apply_changeset` reads the daemon's own verdict instead.
   */
  contentDigest: z.string().min(1).max(200),
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
   *
   * Luau source appears here verbatim whichever operation installs it, so a
   * reviewer reads the same thing whether it arrived as `writeScript` or as a
   * `createInstance` carrying `Source`.
   */
  after: z.string().optional(),
  /**
   * The rest of a `createInstance` property bag, each value as its JSON.
   * Present only when the operation carries properties beyond the `Source`
   * already rendered in `after`; a diff that showed the class and the path and
   * silently dropped the bag was hiding half of what the operation does.
   */
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
  /** True when the tree moved after this set was built; it must be rebased. */
  stale: z.boolean(),
  /**
   * The shape of the set at a glance.
   *
   * `scripts` is a cross-cut of the others rather than one more slice of the
   * same pie: it counts every operation that installs Luau, and such an
   * operation is also counted under `creates` or `setProperties` when that is
   * how it arrived. So these do not sum to `total`, and a UI that adds them up
   * is asking the wrong question — `scripts` answers "is there code in here",
   * which is what decides whether a human reads the diff line by line.
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
   * A fingerprint of the operations on this page, which `POST
   * /v1/changesets/:id/approve` requires back. It is what binds an approval to
   * what was reviewed rather than to an id — see `changeSetContentDigest`.
   */
  contentDigest: z.string().min(1).max(200),
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
  /**
   * The candidates `POST /v1/runs` may offer the router, already carrying the
   * context window, capabilities, price and benchmarks the ordering reads.
   *
   * Optional, and its absence is a real answer rather than an empty list: a
   * daemon with no registry wired in cannot start a run and says so with
   * `provider_unconfigured`, which is a different fact from "the registry is
   * configured and knows of no model you can use". The port returns
   * `ModelCandidate` — a structural type in `@forgebridge/core` that any object
   * with those fields satisfies — so a locally discovered model (M24) that no
   * catalog has heard of routes beside a catalogued one.
   */
  candidates?(): Promise<ModelCandidate[]>;
}

/**
 * A `ModelClient` that says which providers it can actually reach.
 *
 * The run route filters the candidate list by this before handing it to the
 * router. Without it, a catalog entry served by a provider this daemon has no
 * adapter for would be attempted, fail, and be recorded as that provider's
 * failure — a `ModelAttempt` describing something that never happened, which is
 * the one thing the attempt list must never contain (ADR-008).
 */
export interface RunModelClient extends ModelClient {
  readonly providers: readonly string[];
  /**
   * Whether this client has what it needs to make a call — for a hosted
   * provider, a credential. Asked once before a run rather than discovered once
   * per candidate, so an unconfigured daemon answers `provider_unconfigured`
   * instead of filling the run log with identical provider errors and opening
   * the circuit breaker on a provider that was never down.
   */
  configured(): Promise<boolean>;
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

// ── runs ─────────────────────────────────────────────────────────────────────

/**
 * The routing policies `@forgebridge/core` implements, as a wire enum.
 *
 * `RoutingPolicy` is a TypeScript union in the core rather than a Zod schema,
 * so there is nothing to import and re-project — this list has to be written
 * out. The two `Exclude`s below are what stop it being a transcription that
 * rots: adding a policy to the core without adding it here, or leaving one here
 * that the core has dropped, fails `tsc` in this package rather than reaching a
 * user as a request the daemon accepts and the router does not understand.
 */
export const ROUTING_POLICIES = ['free-first', 'fastest', 'cheapest', 'best', 'pinned'] as const;
type _UnlistedRoutingPolicy = Exclude<RoutingPolicy, (typeof ROUTING_POLICIES)[number]>;
type _UnknownRoutingPolicy = Exclude<(typeof ROUTING_POLICIES)[number], RoutingPolicy>;
const _routingPoliciesMatchTheCore: [_UnlistedRoutingPolicy, _UnknownRoutingPolicy] extends [never, never]
  ? true
  : never = true;
void _routingPoliciesMatchTheCore;

export const RoutingPolicyName = z.enum(ROUTING_POLICIES);
export type RoutingPolicyName = z.infer<typeof RoutingPolicyName>;

/** Why the router never invoked a candidate. Pinned to the core the same way. */
export const SKIP_REASONS = ['circuit-open', 'attempt-budget'] as const;
type _UnlistedSkipReason = Exclude<SkipReason, (typeof SKIP_REASONS)[number]>;
type _UnknownSkipReason = Exclude<(typeof SKIP_REASONS)[number], SkipReason>;
const _skipReasonsMatchTheCore: [_UnlistedSkipReason, _UnknownSkipReason] extends [never, never] ? true : never =
  true;
void _skipReasonsMatchTheCore;

export const SkipReasonName = z.enum(SKIP_REASONS);
export type SkipReasonName = z.infer<typeof SkipReasonName>;

/**
 * How many models one run may try. A cap, not a default: the router's own
 * default is "every eligible candidate, in order", and a run that quietly
 * stopped after three would be a fallback chain that lies about its own length.
 */
export const MAX_RUN_ATTEMPTS = 10;

/** `Run.producer`, projected off the protocol rather than restated beside it. */
const RunProducer = Run.shape.producer.unwrap();

export const StartRunRequest = z.object({
  /** Capped where `Run.prompt` is capped, so a prompt this accepts is one the protocol stores. */
  prompt: z.string().min(1).max(50_000),
  /** The daemon's default project when omitted, as everywhere else on this surface. */
  projectId: z.string().uuid().optional(),
  /**
   * How the router orders and falls back over the candidates (ADR-008).
   *
   * `free-first` by default because a daemon a user just started is a daemon
   * with a free key in it more often than not, and because it is the only
   * default that cannot surprise someone with a bill.
   */
  policy: RoutingPolicyName.default('free-first'),
  /** Required by `pinned`, ignored otherwise. Pinning disables fallback outright. */
  pinnedModel: z.string().min(1).max(200).optional(),
  /**
   * The tree version this run must build against.
   *
   * Optional, and when it is given it is a claim about what the producer
   * believes the project is at — a mismatch is `stale_base` before a single
   * token is spent, rather than a ChangeSet that generates fine and is refused
   * at submit. Omitted means "whatever the project is at now".
   */
  baseVersion: z.number().int().min(0).optional(),
  maxAttempts: z.number().int().min(1).max(MAX_RUN_ATTEMPTS).optional(),
  /**
   * Answer as `text/event-stream` instead of JSON, carrying every stage change
   * and every `ModelAttempt` as it happens. The final frame is the same
   * `RunResponse` the JSON form returns.
   */
  stream: z.boolean().default(false),
  producer: RunProducer.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/** A candidate the router never invoked. Never counted as an attempt. */
export const SkippedModel = z.object({
  modelId: z.string().max(200),
  provider: z.string().max(80),
  reason: SkipReasonName,
  detail: z.string().max(500),
  retryAfterMs: z.number().int().min(0).optional(),
});
export type SkippedModel = z.infer<typeof SkippedModel>;

/** What the router decided to try, and in what order, before it tried anything. */
export const ModelOrdering = z.object({
  policy: RoutingPolicyName,
  candidatesConsidered: z.number().int().min(0),
  candidatesEligible: z.number().int().min(0),
  order: z.array(z.string().max(200)),
  /** Set when the ordering could not be computed as asked — `fastest` with nothing measured. */
  note: z.string().max(500).optional(),
});
export type ModelOrdering = z.infer<typeof ModelOrdering>;

/**
 * What a run produced.
 *
 * `run.attempts` is the whole attempt list, always — success, failure and
 * cancellation alike. It is the field ADR-008 is about: a caller that cannot
 * see which models were tried and why the router moved on cannot reproduce the
 * run, and a fallback nobody can see is a silent substitution by another name.
 *
 * `changeSetId` names a ChangeSet stored in `validated`, never in `approved`.
 * Approval is `POST /v1/changesets/:id/approve`, it requires the content digest
 * this response carries, and no run reaches it (ADR-012).
 */
export const RunResponse = z.object({
  run: Run,
  /** The run's plan for itself: facts that were true before any model was called. */
  plan: z.object({ steps: z.array(z.string()) }),
  changeSetId: z.string().uuid().nullable(),
  /** `validated` when a set survived; null when the run produced none. */
  changeSetStatus: ChangeSetStatus.nullable(),
  /** The digest `POST /v1/changesets/:id/approve` requires back. Null with no set. */
  contentDigest: z.string().min(1).max(200).nullable(),
  /** Computed by this daemon over the generated set. Never a model's own verdict. */
  validation: Validation.nullable(),
  skipped: z.array(SkippedModel),
  ordering: ModelOrdering.nullable(),
  failure: ProtocolError.nullable(),
});
export type RunResponse = z.infer<typeof RunResponse>;
