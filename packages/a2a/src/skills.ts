import { z } from 'zod';
import { ChangeSet } from '@forgebridge/protocol';
import { type AgentSkill, type Message, type Part } from './spec.js';

/**
 * ForgeBridge's skills, in A2A's vocabulary — and the convention by which a
 * caller says which one it wants.
 *
 * That second half needs stating plainly, because it is the one place this
 * connector goes beyond the specification. **A2A has no skill-invocation
 * mechanism.** §4.4.5 describes a skill as an identifier, a description and
 * some tags; the proto carries no "call this skill" field anywhere in
 * `SendMessageRequest`, and §4.4.5's own framing is that skills are "largely a
 * descriptive concept". An agent is expected to work out from the message what
 * is being asked.
 *
 * ForgeBridge cannot work that out from prose, and should not try: the
 * operations here write into a Roblox place, and inferring "you probably meant
 * apply" from free text is the exact failure mode ADR-012 exists to prevent. So
 * the invocation is explicit and structured, declared on the Agent Card as an
 * A2A extension (§4.6.1) so that a client discovers it from the card rather than
 * from documentation it may never read.
 *
 * The convention: **exactly one `data` Part** whose value is
 *
 *     { "skill": "<skill id>", "input": { ... } }
 *
 * Other parts may accompany it — an agent that also wants to send a sentence of
 * prose is not doing anything wrong — but exactly one carries the invocation, so
 * there is never a question of which of two data parts was meant.
 */

/**
 * The extension URI. A URI here is an identifier, not necessarily a fetchable
 * document (§5.8 uses the same convention for binding identifiers), but this one
 * resolves to the section of this package's README that defines the convention,
 * so a client author who pastes it into a browser lands on the answer.
 */
export const SKILL_INVOCATION_EXTENSION_URI =
  'https://github.com/MPROGAMING/forgebridge/tree/main/packages/a2a#skill-invocation-v1' as const;

export const SKILL_IDS = [
  'propose-changeset',
  'review-changeset-diff',
  'apply-approved-changeset',
  'rollback-apply',
  'query-models',
  'studio-link-status',
] as const;

export const SkillId = z.enum(SKILL_IDS);
export type SkillId = z.infer<typeof SkillId>;

/**
 * Input schemas.
 *
 * Every one of these is `.strict()`, which is a security property rather than
 * tidiness. `apply-approved-changeset` in particular must never grow a field
 * that lets the caller describe its own approval: an unknown key there is a
 * caller trying something, and the right answer is a loud refusal, not a
 * silently ignored field. See `approval.ts`.
 */
export const ProposeChangesetInput = z.object({ changeSet: ChangeSet }).strict();

export const ReviewChangesetDiffInput = z.object({ changeSetId: z.string().uuid() }).strict();

export const ApplyApprovedChangesetInput = z.object({ changeSetId: z.string().uuid() }).strict();

export const RollbackApplyInput = z
  .object({
    journalId: z.string().uuid(),
    /** Guards against reversing onto a tree that has moved since (ADR-012). */
    expectedVersion: z.number().int().min(0),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const QueryModelsInput = z.object({}).strict();

export const StudioLinkStatusInput = z.object({}).strict();

export const SKILL_INPUTS = {
  'propose-changeset': ProposeChangesetInput,
  'review-changeset-diff': ReviewChangesetDiffInput,
  'apply-approved-changeset': ApplyApprovedChangesetInput,
  'rollback-apply': RollbackApplyInput,
  'query-models': QueryModelsInput,
  'studio-link-status': StudioLinkStatusInput,
} as const satisfies Record<SkillId, z.ZodTypeAny>;

export type SkillInput<K extends SkillId> = z.infer<(typeof SKILL_INPUTS)[K]>;

/** The envelope carried in the invocation `data` Part. */
export const SkillInvocation = z
  .object({
    skill: SkillId,
    /** Absent is the same as `{}`, for the two skills that take no input. */
    input: z.unknown().optional(),
  })
  .strict();
export type SkillInvocation = z.infer<typeof SkillInvocation>;

/** A parsed, schema-checked invocation, narrowed to one skill. */
export type ParsedInvocation = {
  [K in SkillId]: { skill: K; input: SkillInput<K> };
}[SkillId];

export class InvocationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'InvocationError';
  }
}

function isDataPart(part: Part): boolean {
  return Object.prototype.hasOwnProperty.call(part, 'data');
}

/**
 * Read the invocation out of a message.
 *
 * Throws `InvocationError` on anything ambiguous. The caller turns that into a
 * rejected task rather than a JSON-RPC error: the message was a well-formed A2A
 * message, and this agent has decided not to perform what it asked for, which
 * is `TASK_STATE_REJECTED` by the proto's own definition of that state.
 */
export function parseInvocation(message: Message): ParsedInvocation {
  const dataParts = message.parts.filter(isDataPart);
  if (dataParts.length === 0) {
    throw new InvocationError(
      'this message carries no data Part, so it names no ForgeBridge skill. ' +
        `Send one data Part shaped { "skill": …, "input": … } — see ${SKILL_INVOCATION_EXTENSION_URI}`,
      'message.parts',
    );
  }
  if (dataParts.length > 1) {
    throw new InvocationError(
      `this message carries ${dataParts.length} data Parts and exactly one may name the skill`,
      'message.parts',
    );
  }

  const envelope = SkillInvocation.safeParse(dataParts[0]?.data);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    throw new InvocationError(
      `the invocation Part is not a ForgeBridge skill invocation: ${issue?.message ?? 'unrecognised shape'}`,
      `message.parts[].data.${(issue?.path ?? []).join('.') || 'skill'}`,
    );
  }

  const skill = envelope.data.skill;
  const schema = SKILL_INPUTS[skill];
  const parsed = schema.safeParse(envelope.data.input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = (issue?.path ?? []).join('.');
    throw new InvocationError(
      `input for skill "${skill}" is invalid${path ? ` at ${path}` : ''}: ${issue?.message ?? 'unrecognised shape'}`,
      `message.parts[].data.input${path ? `.${path}` : ''}`,
    );
  }

  return { skill, input: parsed.data } as ParsedInvocation;
}

// ────────────────────────────────── the Agent Card's skill list ──────────────────────────────────

const JSON_MODE = 'application/json';
const TEXT_MODE = 'text/plain';

/**
 * An example, in the form §4.4.5 asks for: "example prompts or scenarios". The
 * sample card in §8.5 shows both prose and a JSON string in the same
 * `examples` array, so a serialised invocation is a use the specification
 * already demonstrates — and it is the only form that is actually copyable here.
 */
function example(skill: SkillId, input: unknown): string {
  return JSON.stringify({ skill, input });
}

/**
 * The six skills, in the order a run uses them.
 *
 * Read together they are a deliberate statement of the trust boundary: propose
 * and read are here as ordinary work, apply is described as requiring an
 * approval the caller cannot issue, and the description says so on the card so
 * that an orchestrator planning a run learns the constraint at discovery time
 * rather than by getting a task back in `TASK_STATE_AUTH_REQUIRED`.
 */
export const FORGEBRIDGE_SKILLS: readonly AgentSkill[] = Object.freeze([
  {
    id: 'propose-changeset',
    name: 'Propose a change',
    description:
      'Submit a ChangeSet describing edits to a Roblox place — instances created, properties set, scripts written, ' +
      'subtrees moved or deleted. The set is validated against the project path policy and stored; nothing is written ' +
      'to the place. Proposing is always safe: a proposal that is never approved never reaches Studio.',
    tags: ['roblox', 'changeset', 'propose', 'edit', 'forgebridge'],
    examples: [
      example('propose-changeset', {
        changeSet: {
          id: '00000000-0000-4000-8000-000000000001',
          projectId: '00000000-0000-4000-8000-0000000000aa',
          baseVersion: 7,
          summary: 'Add a respawn handler',
          operations: [
            {
              op: 'writeScript',
              path: 'ServerScriptService.Respawn',
              scriptType: 'Script',
              source: 'print("respawn")',
            },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE, TEXT_MODE],
  },
  {
    id: 'review-changeset-diff',
    name: 'Review a diff',
    description:
      'Read the rendered diff of a previously proposed ChangeSet: per-operation summaries, which operations are ' +
      'destructive, the counts by kind, whether the set has gone stale against the current tree version, and the ' +
      'validation verdict the daemon computed. This is a read; it changes nothing.',
    tags: ['roblox', 'changeset', 'diff', 'review', 'forgebridge'],
    examples: [example('review-changeset-diff', { changeSetId: '00000000-0000-4000-8000-000000000001' })],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE, TEXT_MODE],
  },
  {
    id: 'apply-approved-changeset',
    name: 'Apply an approved change',
    description:
      'Dispatch an already-approved ChangeSet to the paired Roblox Studio session. Approval is NOT part of this ' +
      'request and cannot be supplied by the caller: a human or a local policy must approve the ChangeSet out of ' +
      'band first. Until that happens this skill returns a task in TASK_STATE_AUTH_REQUIRED naming the ChangeSet ' +
      'that is waiting. Re-send the same request after approval to proceed.',
    tags: ['roblox', 'changeset', 'apply', 'approval-gated', 'forgebridge'],
    examples: [example('apply-approved-changeset', { changeSetId: '00000000-0000-4000-8000-000000000001' })],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE, TEXT_MODE],
  },
  {
    id: 'rollback-apply',
    name: 'Roll back an apply',
    description:
      'Request reversal of a journalled apply, using the inverse operations captured before it ran. Rollback writes ' +
      'to the place, so it carries the same approval requirement as apply: the caller cannot authorise its own ' +
      'rollback, and an unapproved request returns TASK_STATE_AUTH_REQUIRED. expectedVersion must match the current ' +
      'tree version, which guards against reversing onto a tree that has moved on.',
    tags: ['roblox', 'rollback', 'journal', 'approval-gated', 'forgebridge'],
    examples: [
      example('rollback-apply', {
        journalId: '00000000-0000-4000-8000-0000000000bb',
        expectedVersion: 8,
        reason: 'the respawn handler broke spawn points',
      }),
    ],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE, TEXT_MODE],
  },
  {
    id: 'query-models',
    name: 'Query models',
    description:
      'Read the model catalog this ForgeBridge instance can route to: which models are configured, where the ' +
      'catalog came from, and when it was last verified. Reports honestly when no registry is wired in, which is a ' +
      'different fact from an empty catalog.',
    tags: ['models', 'catalog', 'routing', 'forgebridge'],
    examples: [example('query-models', {})],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE, TEXT_MODE],
  },
  {
    id: 'studio-link-status',
    name: 'Check the Studio link',
    description:
      'Report whether a Roblox Studio session is paired and reachable, which project it is bound to, the transport ' +
      'in use and its privacy posture. Call this before proposing: a proposal against a project with no paired ' +
      'Studio session can be approved but never delivered.',
    tags: ['studio', 'link', 'status', 'health', 'forgebridge'],
    examples: [example('studio-link-status', {})],
    inputModes: [JSON_MODE],
    outputModes: [JSON_MODE, TEXT_MODE],
  },
] satisfies AgentSkill[]);

/** The skills that write to the user's place, and so pass through the approval gate. */
export const WRITING_SKILLS: ReadonlySet<SkillId> = new Set<SkillId>(['apply-approved-changeset', 'rollback-apply']);
