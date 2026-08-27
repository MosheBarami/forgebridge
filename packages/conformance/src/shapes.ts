import { z } from 'zod';
import {
  ChangeSetStatus,
  LinkState,
  ModelAttempt,
  OperationOutcome,
  RunStage,
  RunStatus,
  TransportKind,
  Validation,
} from '@forgebridge/protocol';

/**
 * What the suite is willing to believe an adapter returned.
 *
 * Every one of these is assembled out of `@forgebridge/protocol` primitives
 * rather than re-typed as strings. That is the whole point: a connector that
 * invents its own status vocabulary, or reports a link state the protocol has
 * no member for, is exactly the drift the suite exists to catch — and it would
 * sail past a `z.string()`.
 *
 * They are loose about *extra* fields (a connector may carry more) and strict
 * about the fields the protocol names.
 *
 * TODO(M31): this is the third place the daemon's response shapes are written
 * down — `packages/daemon/src/wire.ts` and `packages/a2a/src/daemon-wire.ts`
 * are the other two, and both carry a TODO asking for them to be promoted into
 * `@forgebridge/protocol` so that the daemon, the connectors and `apps/relay`
 * cannot drift. When that lands, the shapes below become imports. What makes a
 * third transcription tolerable in the meantime is that it describes only the
 * fields the cases assert on, and it is the one transcription whose whole
 * purpose is to disagree loudly with the others. Owner: the protocol
 * maintainer, as an additive `/v1` change.
 */

export const ConnectorLinkShape = z.object({
  linkId: z.string().min(1),
  projectId: z.string().uuid(),
  state: LinkState,
});

export const ConnectorLinkStatusShape = z.object({
  transport: TransportKind,
  privacyPosture: z.string().min(1),
  protocolVersion: z.string().min(1),
  defaultProjectId: z.string().uuid().nullish(),
  links: z.array(ConnectorLinkShape),
});

export const ConnectorProjectShape = z.object({
  projectId: z.string().uuid(),
  isDefault: z.boolean().optional(),
  currentVersion: z.number().int().min(0).optional(),
  links: z.array(ConnectorLinkShape).optional(),
});

/** Recursive because a tree is; depth is the protocol's business, not this file's. */
export const ConnectorTreeNodeShape: z.ZodType<{ path: string; className?: string; children?: unknown[] }> = z.lazy(() =>
  z.object({
    path: z.string().min(1),
    className: z.string().min(1).optional(),
    children: z.array(ConnectorTreeNodeShape).optional(),
  }),
);

export const ConnectorTreeShape = z.object({
  projectId: z.string().uuid(),
  version: z.number().int().min(0),
  root: ConnectorTreeNodeShape,
});

export const ConnectorDiffShape = z.object({
  changeSetId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  status: ChangeSetStatus,
  baseVersion: z.number().int().min(0),
  currentVersion: z.number().int().min(0).optional(),
  stale: z.boolean().optional(),
  summary: z.string().optional(),
  operations: z.array(
    z.object({
      index: z.number().int().min(0),
      op: z.string().min(1),
      summary: z.string().optional(),
      destructive: z.boolean().optional(),
    }),
  ),
  counts: z.object({ total: z.number().int().min(0) }).passthrough().optional(),
  validation: Validation.nullish(),
  contentDigest: z.string().min(1).optional(),
});

export const ConnectorProposalShape = z.object({
  changeSetId: z.string().uuid(),
  status: ChangeSetStatus,
  validation: Validation.nullish(),
  diff: ConnectorDiffShape.nullish(),
});

export const ConnectorApplyReportShape = z.object({
  changeSetId: z.string().uuid(),
  status: ChangeSetStatus,
  accepted: z.boolean(),
  message: z.string().optional(),
  outcomes: z.array(OperationOutcome).optional(),
});

export const ConnectorRunShape = z.object({
  runId: z.string().uuid(),
  stage: RunStage,
  status: RunStatus,
  attempts: z.array(ModelAttempt),
  changeSetIds: z.array(z.string().uuid()).optional(),
  resolvedModelId: z.string().nullish(),
});

export const ConnectorSurfaceShape = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  protocolVersion: z.string().min(1),
  operations: z.array(z.object({ id: z.string().min(1), description: z.string().optional() })).min(1),
});

/**
 * A zod failure rendered as the lines a conformance report shows.
 *
 * `issue.path` matters more than the message here — "status: invalid enum
 * value" is unactionable, "operations.0.index: expected number" names the field
 * the connector has to fix.
 */
export function issueLines(error: z.ZodError, subject: string): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${subject}.${where}: ${issue.message}`;
  });
}
