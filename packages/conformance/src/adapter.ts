import type { z } from 'zod';
import { RunStage, RunStatus } from '@forgebridge/protocol';
import type {
  AttemptOutcome,
  ChangeSetStatus,
  ErrorCode,
  ModelAttempt,
  Operation,
  OperationOutcome,
  TransportKind,
  Validation,
} from '@forgebridge/protocol';

/**
 * `packages/protocol` exports these two as schemas without a companion type
 * alias, so the alias is derived here rather than restated as a string union —
 * a hand-written copy of an enum is a copy that goes stale.
 */
export type RunStageName = z.infer<typeof RunStage>;
export type RunStatusName = z.infer<typeof RunStatus>;

/**
 * What a connector has to implement to be tested.
 *
 * Six calls and an error classifier. That is the whole cost of inheriting the
 * suite, and the number is deliberate: MCP, A2A, the CLI and the SDKs each
 * already do all six things against the daemon's `/v1` surface, so an adapter
 * is a shim over code that exists rather than a second implementation of it.
 *
 * ── What is missing from this interface, and why ──────────────────────────────
 *
 * There is no `approve()`.
 *
 * Not "there is one and the suite never calls it" — it is not declared. ADR-012
 * makes approval an act a model cannot perform, and a conformance interface
 * that offered an approve method would let a connector pass this suite while
 * holding the handle on both sides of the gate. The suite still needs a set to
 * become approved in order to prove that `apply()` is not merely a function
 * that always throws — so approval arrives from `HumanApproval` in the options,
 * a separate object the adapter never sees, standing in for the human. The
 * separation in the test harness mirrors the separation in the system.
 *
 * ── On adapters that cannot do something ─────────────────────────────────────
 *
 * `startRun` and `describeSurface` are optional: a connector that does not
 * expose runs is not a broken connector, and the suite records those cases as
 * `unsupported` rather than failing them. `readTree` is *not* optional, but a
 * transport that holds no tree snapshot satisfies it by refusing in the
 * protocol's own words — a `not_found` carrying a remedy. Refusing well is a
 * conformance behaviour; throwing a bare string is not.
 */
export interface ConnectorAdapter {
  /** Named in the report. The connector's package name is the useful answer. */
  readonly name: string;

  linkStatus(): Promise<ConnectorLinkStatus>;
  listProjects(): Promise<ConnectorProject[]>;
  readTree(projectId: string): Promise<ConnectorTree>;
  propose(input: ProposeInput): Promise<ConnectorProposal>;
  diff(changeSetId: string): Promise<ConnectorDiff>;

  /**
   * Report on a ChangeSet a human has already approved.
   *
   * It must reject an unapproved set, and rejecting is not enough on its own:
   * the set must still be unapproved afterwards. An adapter that quietly
   * approves and then reports a refusal is the exact cheat this suite exists to
   * catch, and `apply-refused-without-approval` re-reads the status to catch it.
   */
  apply(changeSetId: string): Promise<ConnectorApplyReport>;

  /**
   * Translate a failure — one thrown by this adapter, or a raw `ProtocolError`
   * off the wire — into the protocol code the caller branches on.
   *
   * The suite feeds this every member of `ErrorCode`, twice: once as a thrown
   * `ForgeBridgeError` and once as the JSON payload the daemon actually sends.
   * A connector whose mapping is partial has a code its callers cannot branch
   * on, which is the same as not having the code (ADR-008 §errors, and the
   * comment on `ErrorCode` itself: "some string the server felt like" is not
   * branchable).
   */
  describeError(error: unknown): ConnectorErrorView;

  /** Optional: connectors that can start a run from a prompt. */
  startRun?(input: RunInput): Promise<ConnectorRun>;

  /** Optional: the tool list, skill list or Agent Card this connector advertises. */
  describeSurface?(): ConnectorSurface | Promise<ConnectorSurface>;
}

export interface ConnectorLink {
  linkId: string;
  projectId: string;
  /** A `LinkState` member. Checked against the protocol enum, not a free string. */
  state: string;
}

export interface ConnectorLinkStatus {
  transport: TransportKind;
  /**
   * What the transport implies about who can read the changes crossing it.
   * Checked byte for byte against `PRIVACY_POSTURE[transport]`: this is one of
   * the few strings in the protocol whose *wording* is the contract, because a
   * connector that paraphrases "the relay operator can read your changes" into
   * a padlock icon has told the user something false.
   */
  privacyPosture: string;
  protocolVersion: string;
  defaultProjectId?: string | null;
  links: ConnectorLink[];
}

export interface ConnectorProject {
  projectId: string;
  isDefault?: boolean;
  /** The project's current tree version, when the transport publishes one. */
  currentVersion?: number;
  links?: ConnectorLink[];
}

export interface ConnectorTreeNode {
  path: string;
  className?: string;
  children?: ConnectorTreeNode[];
}

export interface ConnectorTree {
  projectId: string;
  /** The version this snapshot is of — the `baseVersion` a set built on it carries. */
  version: number;
  root: ConnectorTreeNode;
}

export interface ProposeInput {
  projectId: string;
  baseVersion: number;
  summary: string;
  operations: Operation[];
  /**
   * A verdict the *producer* claims, for the connector to forward untouched.
   *
   * Present so the suite can check PROTOCOL invariant 4 end to end: whatever a
   * producer sends here, the verdict that comes back must be one the core
   * computed. An adapter is free to drop this field — dropping it is a fine
   * answer, and the case passes either way; what the case refuses is a verdict
   * that came back wearing the producer's name.
   */
  claimedValidation?: Validation;
}

export interface ConnectorProposal {
  changeSetId: string;
  status: ChangeSetStatus | string;
  validation?: Validation | null;
  /** Rendered here when the connector returns one from propose; else read via `diff`. */
  diff?: ConnectorDiff | null;
}

export interface ConnectorDiffOperation {
  index: number;
  op: string;
  summary?: string;
  destructive?: boolean;
}

export interface ConnectorDiff {
  changeSetId: string;
  projectId?: string;
  status: ChangeSetStatus | string;
  baseVersion: number;
  currentVersion?: number;
  stale?: boolean;
  summary?: string;
  operations: ConnectorDiffOperation[];
  counts?: { total: number };
  validation?: Validation | null;
  contentDigest?: string;
}

export interface ConnectorApplyReport {
  changeSetId: string;
  status: ChangeSetStatus | string;
  /** True when the connector accepted the set as cleared to reach the consumer. */
  accepted: boolean;
  message?: string;
  /** Per-operation results, where the transport serves them. */
  outcomes?: OperationOutcome[];
}

export interface ConnectorErrorView {
  code: ErrorCode;
  /**
   * Whether the connector recognised this failure as a protocol error, as
   * opposed to defaulting it. An unrecognised failure reported as `internal` is
   * correct; an unrecognised failure reported as `not_approved` would be a
   * connector inventing an approval decision out of a socket timeout.
   */
  recognised: boolean;
  /** The value a caller of *this* transport branches on: an HTTP status, a JSON-RPC code, an MCP error name. */
  transportCode?: string | number;
  message?: string;
  remedy?: string;
}

export interface RunInput {
  projectId: string;
  prompt: string;
}

export interface ConnectorRun {
  runId: string;
  stage: RunStageName | string;
  status: RunStatusName | string;
  /**
   * Every model the router tried, in order, with why it moved on — the whole
   * array, never the last entry (ADR-008). A run is not reproducible without it.
   */
  attempts: ModelAttempt[];
  changeSetIds?: string[];
  /** The model whose output the run stands behind, when the run names one. */
  resolvedModelId?: string | null;
}

export interface ConnectorSurfaceEntry {
  id: string;
  description?: string;
}

export interface ConnectorSurface {
  name: string;
  version?: string;
  protocolVersion: string;
  /** Tools, skills or methods — whatever this connector advertises to a caller. */
  operations: ConnectorSurfaceEntry[];
}

/**
 * The human's half of ADR-012, supplied to the runner rather than to the
 * adapter. In a real deployment this is a person clicking approve in Studio;
 * here it is whatever the operator running the suite wires up.
 */
export interface HumanApproval {
  approve(changeSetId: string): Promise<void>;
}

export interface RunExpectation {
  modelId: string;
  outcome: AttemptOutcome;
}

export interface ConformanceOptions {
  /** Project to run against. Defaults to the one the connector calls default. */
  projectId?: string;
  /** Version the fixtures are built on. Defaults to what the connector reports, else 0. */
  baseVersion?: number;
  /**
   * The ChangeSet the suite proposes. Overridable because a project's policy
   * decides which paths are writable, and a fixture outside the allowlist would
   * fail cases that are not about policy at all.
   */
  fixture?: { summary: string; operations: Operation[] };
  humanApproval?: HumanApproval;
  run?: {
    input?: Partial<RunInput>;
    /**
     * What the model port was scripted to do, when the harness knows.
     *
     * This is how the run case catches a connector that reports only the model
     * that succeeded: without it the suite can check the shape of the attempt
     * list but not its completeness, and a truncated list has a perfectly
     * well-formed shape.
     */
    expectedAttempts?: RunExpectation[];
  };
  /** Case ids to run. Absent means all of them. */
  only?: readonly string[];
  now?: () => Date;
  newId?: () => string;
}
