import { z } from 'zod';
import { ChangeSet, InstancePath, LIMITS, Link, RollbackRequest } from '@forgebridge/protocol';
import { MAX_RUN_ATTEMPTS, StartRunRequest } from '@forgebridge/daemon';

/**
 * Tool input schemas, taken apart from the frozen contract rather than written
 * again.
 *
 * `ChangeSet` is a `ZodEffects` because of its `superRefine`, so its fields are
 * reached through `.innerType().shape`. That indirection is worth it: the bound
 * on `summary`, the 500-operation ceiling and the whole `Operation` union then
 * come from `packages/protocol` by reference. A hand-written `z.string().max(300)`
 * here would be a second copy of a contract that is only allowed to have one,
 * and the copy would be the one that goes stale.
 *
 * `.describe()` returns a clone, so annotating for the model cannot mutate the
 * protocol's own schema.
 */
const changeSetShape = ChangeSet.innerType().shape;
const rollbackShape = RollbackRequest.shape;

/**
 * The run request, taken apart the same way.
 *
 * `StartRunRequest` lives in `@forgebridge/daemon` rather than in the frozen
 * protocol — its own TODO(M31) says it belongs in `@forgebridge/protocol` and
 * names the conformance suite as the forcing function — so this is the same
 * projection as above, from wherever the shape currently lives. Two of its
 * fields are deliberately not offered to the calling model, below.
 */
const runShape = StartRunRequest.shape;

/** Optional everywhere: the daemon knows its own default project. */
export const projectIdArg = changeSetShape.projectId
  .optional()
  .describe('Project UUID. Omit to use the project this daemon defaults to — read it with forge.list_projects.');

export const changeSetIdArg = changeSetShape.id.describe('The changeset UUID returned by forge.propose_changeset.');

export const instancePathArg = InstancePath.describe(
  'Dotted instance path from a Roblox service root, e.g. "ServerScriptService.Shop.PurchaseHandler". Every segment must be a safe identifier; the protocol refuses anything else.',
);

/** `forge.list_projects`, `forge.list_models`, `forge.link_status`. */
export const emptyInput = {} satisfies z.ZodRawShape;

export const proposeChangeSetInput = {
  projectId: projectIdArg,
  baseVersion: changeSetShape.baseVersion.describe(
    'The tree version these operations were built against. A fresh project is 0. If it is wrong the call is refused with stale_base, and that refusal names the version the project is actually at — rebuild against that number and propose again.',
  ),
  summary: changeSetShape.summary.describe(
    'One line a human will read in the approval prompt. Say what changes and why, not how many operations there are.',
  ),
  operations: changeSetShape.operations.describe(
    'Ordered operations, applied in order and each reported individually. setProperty may not write Parent or Name — use moveInstance, which reports both endpoints and journals a reversible move.',
  ),
  runId: changeSetShape.runId.describe('Optional run UUID, when this ChangeSet belongs to a run you already started.'),
} satisfies z.ZodRawShape;

export const diffChangeSetInput = { changeSetId: changeSetIdArg } satisfies z.ZodRawShape;

export const applyChangeSetInput = {
  changeSetId: changeSetIdArg.describe(
    'The changeset a human has already approved. This tool cannot approve one; an unapproved id is refused with not_approved.',
  ),
} satisfies z.ZodRawShape;

export const readTreeInput = {
  projectId: projectIdArg,
  path: InstancePath.optional().describe('Subtree to read. Omit for the service roots.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.MAX_PATH_DEPTH)
    .optional()
    .describe(`How many levels below path to return. The protocol bounds path depth at ${LIMITS.MAX_PATH_DEPTH}.`),
} satisfies z.ZodRawShape;

export const readScriptInput = {
  projectId: projectIdArg,
  path: instancePathArg,
} satisfies z.ZodRawShape;

export const runTestsInput = {
  projectId: projectIdArg,
  changeSetId: changeSetIdArg.optional().describe('Test the state after this changeset, when one has been applied.'),
} satisfies z.ZodRawShape;

/**
 * `forge.start_run`.
 *
 * Two fields of `StartRunRequest` are missing on purpose, and neither is an
 * oversight:
 *
 *   - **`stream`.** An MCP tool call answers once. A tool that asked for a
 *     `text/event-stream` would have nowhere to put the frames, so this
 *     connector always asks for JSON and the field is not the model's to set.
 *   - **`producer`.** It records *which* connector asked, and a field the
 *     caller could set would let a model describe itself as the web app. It is
 *     stamped by `forge.start_run` as `{ kind: 'mcp' }`.
 *
 * There is no approval field, and there is nowhere one could go: `/v1/runs`
 * takes none, so a model cannot ask for its own work to be cleared even by
 * accident (ADR-012).
 */
export const startRunInput = {
  prompt: runShape.prompt.describe(
    'What you want built or changed, in plain language. A model behind the daemon plans it and writes the operations; this is the prompt that model is given, so say what should be true afterwards rather than naming instance paths you have not read.',
  ),
  projectId: projectIdArg,
  policy: runShape.policy
    .describe(
      'How the daemon orders the models it may use and falls back between them. free-first (the default) is the only one that cannot surprise the user with a bill. pinned disables fallback entirely and requires pinnedModel.',
    ),
  pinnedModel: runShape.pinnedModel.describe(
    'Pin one model id, from forge.list_models. Only meaningful with policy "pinned"; pinning means that model or nothing, and a failure fails the run rather than reaching for the next model.',
  ),
  baseVersion: runShape.baseVersion.describe(
    'The tree version this run must build against. Omit for "whatever the project is at now". A mismatch is refused with stale_base before a single token is spent.',
  ),
  maxAttempts: runShape.maxAttempts.describe(
    `How many models this run may try, at most ${MAX_RUN_ATTEMPTS}. Omit to let the router try every eligible candidate in order.`,
  ),
} satisfies z.ZodRawShape;

export const rollbackInput = {
  journalId: rollbackShape.journalId.describe('Journal entry to reverse. Every apply writes one.'),
  expectedVersion: rollbackShape.expectedVersion.describe(
    'The tree version you believe the project is at. If it has moved since, the rollback is refused with stale_base rather than replayed onto a tree it no longer fits.',
  ),
  reason: rollbackShape.reason.describe('Why, in the user’s words where you have them. It is journalled.'),
} satisfies z.ZodRawShape;

export const tailOutputInput = {
  link: Link.shape.id
    .optional()
    .describe('Link id, when more than one Studio session is paired. Omit for the default project’s session.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('How many of the most recent messages to return. The daemon serves at most its own ceiling regardless.'),
} satisfies z.ZodRawShape;

/** Every tool's input schema as one object, for validation and for tests. */
export function objectOf<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape> {
  return z.object(shape);
}
