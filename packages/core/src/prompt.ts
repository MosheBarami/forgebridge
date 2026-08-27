import {
  LIMITS,
  Operation,
  PROPERTY_VALUE_TAGS,
  ScriptType,
  STRUCTURAL_PROPERTIES,
} from '@forgebridge/protocol';
import type { ModelMessage, ToolDefinition } from './ports/model.js';

/**
 * The prompt that asks a model for a ChangeSet.
 *
 * Every list in it is read off the protocol's own schemas — the operation
 * names, their fields, which fields are optional, the value tags, the script
 * types, the structural properties `setProperty` refuses, the operation cap.
 * None of it is typed out here. A prompt that restates the schema from memory
 * is a second source of truth that drifts on the first additive change, and the
 * failure it produces is the worst kind: a model dutifully emitting the shape
 * it was told about, and a parser refusing it.
 *
 * It is also short on purpose. The model is told the vocabulary once, told the
 * two rules a Roblox model reliably gets wrong (structural properties, and
 * inventing a verdict), and told which paths this project will actually accept.
 * Saying any of it twice teaches a reader to skim.
 */

/** The tool an adapter offers when its provider does structured tool calls. */
export const CHANGE_SET_TOOL_NAME = 'emit_change_set';

export interface PromptContext {
  /** What the user asked for, verbatim. */
  prompt: string;
  /** The project's path allowlist — the gate this ChangeSet is measured against. */
  allowedPathPrefixes: readonly string[];
  /** The tree version the set is built against; the model does not choose it. */
  baseVersion: number;
  /** A description of the place, when the caller has one to give. */
  treeSummary?: string;
}

interface FieldLike {
  isOptional(): boolean;
}

/**
 * `{"op":"createInstance", path, className, properties?}` — one line per
 * operation, derived from the discriminated union the parser will use.
 *
 * The `op` field is written out literally rather than used as a heading, and
 * that is not cosmetic. The first live run against four free models produced no
 * ChangeSet at all, and three of the four failures were this one thing: the
 * models had the field names right and the discriminator wrong. One emitted
 * `{"createInstance": {…}}`, keying the object by the operation name; another
 * emitted a correct `writeScript` body with no `op` at all. A heading of the
 * form `createInstance { … }` reads as "an object under this key" to anything
 * that has seen more JSON than prose, and the parser then refuses a set the
 * model very nearly got right.
 *
 * Still derived, so it still cannot drift: the literal comes from
 * `schema.shape.op.value`, which is the same value `Operation` discriminates on.
 */
export function operationVocabulary(): string[] {
  return Operation.options.map((schema) => {
    const fields = Object.entries(schema.shape as Record<string, FieldLike>)
      .filter(([name]) => name !== 'op')
      .map(([name, field]) => (field.isOptional() ? `${name}?` : name));
    return `{"op":"${schema.shape.op.value}", ${fields.join(', ')}}`;
  });
}

/**
 * The reference example is built from the project's own first prefix. An
 * example path outside the allowlist stated four lines above it is one a model
 * will copy, and then be refused for.
 */
function valueExamples(prefixes: readonly string[]): string {
  const reference = `${prefixes[0] ?? 'Workspace.Example'}.Door`;
  return [
    '{"t":"String","v":"Buy"}',
    '{"t":"Number","v":12.5}',
    '{"t":"Bool","v":true}',
    '{"t":"Vector3","x":0,"y":5,"z":0}',
    `{"t":"InstanceRef","path":"${reference}"}`,
  ].join('  ');
}

export function systemPrompt(context: PromptContext): string {
  const prefixes = context.allowedPathPrefixes;
  const scope =
    prefixes.length === 0
      ? 'This project has no allowed path prefixes configured, so every path will be refused. Say so in `summary` and emit the smallest set you can.'
      : `Only these paths, and paths beneath them, are accepted:\n${prefixes.map((prefix) => `  ${prefix}`).join('\n')}\nAnything outside them is refused whole — it is not trimmed to fit.`;

  return [
    'You write changes to a Roblox place as a ChangeSet. You propose; a human approves. Nothing you emit is applied by you.',
    '',
    'Reply with one JSON object and nothing else:',
    '{"summary": "<one line, what this change does>", "operations": [ ... ]}',
    '',
    `Operations (a trailing ? marks an optional field, at most ${LIMITS.MAX_OPERATIONS} per set):`,
    ...operationVocabulary().map((line) => `  ${line}`),
    '',
    'Paths are dotted from a Roblox service root — "ServerScriptService.Shop.PurchaseHandler". Every segment must be an identifier: letters, digits and underscore, not starting with a digit.',
    scope,
    '',
    `Property values are tagged: ${valueExamples(prefixes)}`,
    `Tags: ${PROPERTY_VALUE_TAGS.join(', ')}.`,
    `scriptType is one of: ${ScriptType.options.join(', ')}.`,
    '',
    `setProperty may not write ${STRUCTURAL_PROPERTIES.join(' or ')}. Reparenting and renaming are moveInstance, which names where the instance came from and where it went, and which can be undone.`,
    'Do not send an id, a status, a timestamp, or a validation verdict. They are computed here, and anything you send for them is discarded.',
  ].join('\n');
}

export function userPrompt(context: PromptContext): string {
  const lines = [`Request: ${context.prompt}`, `Tree version: ${context.baseVersion}`];
  if (context.treeSummary) lines.push('', 'Place:', context.treeSummary);
  return lines.join('\n');
}

export function changeSetMessages(context: PromptContext): ModelMessage[] {
  return [
    { role: 'system', content: systemPrompt(context) },
    { role: 'user', content: userPrompt(context) },
  ];
}

/**
 * The tool definition for providers that take one.
 *
 * `operations` is described as an array of objects and no further: the full
 * operation schema lives in the protocol, and hand-writing a JSON Schema copy
 * of it here would be the drift this whole module exists to avoid. The prose
 * above carries the vocabulary; the protocol's parser carries the verdict.
 */
export function changeSetTool(context: PromptContext): ToolDefinition {
  return {
    name: CHANGE_SET_TOOL_NAME,
    description: 'Emit the ChangeSet that satisfies the request. Proposal only; it is not applied.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'operations'],
      properties: {
        summary: { type: 'string', description: 'One line, human-facing.', maxLength: 300 },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.MAX_OPERATIONS,
          items: { type: 'object' },
          description: operationVocabulary().join(' | '),
        },
      },
    },
  };
}
