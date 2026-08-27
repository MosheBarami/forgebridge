/**
 * Project the frozen Zod contract into the languages that cannot read it.
 *
 * `docs/PROTOCOL.md` opens with "one contract, authored once in Zod, projected
 * everywhere". Until this script existed only the TypeScript arm was real, and
 * it is real by construction — the types are `z.infer` of the schemas, so that
 * arm cannot drift. Every other arm can, which is the whole reason this file is
 * a generator with a `--check` mode rather than a one-off conversion someone
 * ran once and committed.
 *
 * What it emits, all under `packages/protocol/schema/`:
 *
 *   <Name>.schema.json   one self-contained JSON Schema (draft 2020-12) per
 *                        top-level type exported by `@forgebridge/protocol`
 *   openapi.json         one OpenAPI 3.1 document for the `/v1` surface
 *   README.md            provenance, and the list of constraints that do NOT
 *                        survive the projection
 *
 * and, under `packages/sdk-python/`:
 *
 *   src/forgebridge/models.py   pydantic v2 models generated from those schemas
 *
 * Three rules govern everything below.
 *
 * 1. **Nothing is transcribed without being checked.** A Zod `.superRefine()`
 *    body cannot be read at runtime, so the few constraints that must be
 *    restated in JSON Schema — the shape of an `InstancePath`, the reserved
 *    property names — are restated in `REFINEMENTS` *and* probed: every probe
 *    value is run through the real Zod schema and through the emitted JSON
 *    Schema, and a disagreement fails generation. A transcription that is only
 *    asserted is the defect this repository has a gate for in four other places.
 *
 * 2. **A refinement this file has never heard of is an error, not a silent
 *    drop.** Hitting a `ZodEffects` at a location with no `REFINEMENTS` entry
 *    aborts. A projection that quietly loses a constraint is worse than no
 *    projection, because a consumer trusts it.
 *
 * 3. **Where `docs/PROTOCOL.md` and `packages/daemon/src/server.ts` disagree
 *    about the wire, the code wins** — and the disagreement is reported rather
 *    than papered over. `checkRouteTable` compares the two and fails.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as protocol from '../packages/protocol/src/index.js';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_DIR = 'packages/protocol/schema';
const PYTHON_MODELS = 'packages/sdk-python/src/forgebridge/models.py';
const SERVER_SOURCE = 'packages/daemon/src/server.ts';

/** Bumped when the *shape* of the emitted artefacts changes, not on every edit. */
const GENERATOR_ID = 'scripts/generate-schemas.ts';

// ─────────────────────────────── JSON values ───────────────────────────────

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * A Zod schema seen from the outside.
 *
 * Deliberately structural rather than `import { z } from 'zod'`: `zod` is a
 * dependency of `packages/protocol`, not of the repository scripts, and a
 * script that reaches for a package no manifest declares is a hoisting accident
 * waiting to become a broken CI run.
 */
interface ZodLike {
  readonly _def: { readonly typeName: string; readonly [key: string]: unknown };
  safeParse(value: unknown): { success: boolean };
}

function isZodLike(value: unknown): value is ZodLike {
  if (typeof value !== 'object' || value === null) return false;
  const def = (value as { _def?: unknown })._def;
  return (
    typeof def === 'object' &&
    def !== null &&
    typeof (def as { typeName?: unknown }).typeName === 'string' &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

function def<T = unknown>(schema: ZodLike, key: string): T {
  return schema._def[key] as T;
}

// ────────────────────────── string formats, restated ──────────────────────────

/**
 * Zod's `.uuid()` and `.datetime()` compile to regexes it does not expose, so
 * the equivalent `pattern` has to be written here. Both are probed in
 * `FORMAT_PROBES`, which is what keeps "equivalent" a fact rather than a hope:
 * a Zod release that tightens either check fails generation instead of silently
 * widening the JSON Schema.
 */
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const DATETIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';

/** Probe values for the two restated formats. `[value, acceptedByZod]`. */
const FORMAT_PROBES: Readonly<Record<'uuid' | 'datetime', ReadonlyArray<string>>> = {
  uuid: [
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    '00000000-0000-0000-0000-000000000000',
    '018f3a5c-7c1e-7c9a-9a0c-0305e82c3301',
    '3F2504E0-4F89-41D3-9A0C-0305E82C3301',
    '3f2504e0-4f89-41d3-9a0c-0305e82c330',
    '3f2504e0-4f89-41d3-9a0c-0305e82c33012',
    'not-a-uuid',
    '',
  ],
  datetime: [
    '2026-08-26T12:00:00Z',
    '2026-08-26T12:00:00.123Z',
    '2026-08-26T12:00:00+02:00',
    '2026-08-26T12:00:00',
    '2026-08-26',
    'yesterday',
    '',
  ],
};

// ─────────────────────────── declared refinements ───────────────────────────

/**
 * Every `ZodEffects` in the contract, by location, and what becomes of it.
 *
 * `projection` is merged into the JSON Schema produced for the effect's inner
 * schema. `probes` are `[value, expected]` pairs asserted to be judged the same
 * way by Zod and by the emitted schema. `lost` records, in the generated
 * README, a constraint JSON Schema cannot express — stating it is the only
 * honest alternative to expressing it.
 */
interface Refinement {
  readonly projection?: JsonObject;
  readonly probes?: ReadonlyArray<readonly [Json, boolean]>;
  readonly lost?: string;
}

const SEGMENT = '[A-Za-z_][A-Za-z0-9_]{0,' + (protocol.LIMITS.MAX_SEGMENT_LENGTH - 1) + '}';

/**
 * `^(root)(\.segment){0,depth-1}$`.
 *
 * Built from the exported `SERVICE_ROOTS` and `LIMITS` rather than written out,
 * so adding a service root or changing the depth bound regenerates a correct
 * pattern. Only the segment character class is restated, and `probes` below
 * includes the cases that class exists to reject — a dot inside a name, a
 * leading digit, an over-long segment — because that class is what stops a name
 * smuggling a separator past a policy prefix check.
 */
const INSTANCE_PATH_PATTERN =
  '^(?:' +
  protocol.SERVICE_ROOTS.join('|') +
  ')(?:\\.' +
  SEGMENT +
  '){0,' +
  (protocol.LIMITS.MAX_PATH_DEPTH - 1) +
  '}$';

const RESERVED_PROPERTY_NAMES = ['__index', '__newindex', '__metatable', 'constructor', 'prototype'];

const LONG_SEGMENT = 'A'.repeat(protocol.LIMITS.MAX_SEGMENT_LENGTH + 1);
const DEEP_PATH = ['Workspace', ...Array.from({ length: protocol.LIMITS.MAX_PATH_DEPTH }, () => 'a')].join('.');

const REFINEMENTS: Readonly<Record<string, Refinement>> = {
  InstancePath: {
    projection: { pattern: INSTANCE_PATH_PATTERN },
    probes: [
      ['ServerScriptService.Shop.PurchaseHandler', true],
      ['Workspace', true],
      ['Workspace._private0', true],
      ['NotAService.Thing', false],
      ['Workspace.', false],
      ['Workspace..Thing', false],
      ['Workspace.0Thing', false],
      ['Workspace.Thing-With-Dashes', false],
      [`Workspace.${LONG_SEGMENT}`, false],
      [DEEP_PATH, false],
      ['', false],
    ],
  },

  PropertyName: {
    // The regex already refuses every `__`-prefixed name, so only `constructor`
    // and `prototype` need the extra clause — but the whole reserved list is
    // emitted, because a schema that names what it refuses is readable and this
    // one is read by people writing producers.
    projection: { not: { enum: RESERVED_PROPERTY_NAMES } },
    probes: [
      ['Transparency', true],
      ['Size', true],
      ['_leading', false],
      ['__index', false],
      ['constructor', false],
      ['prototype', false],
      ['has space', false],
    ],
  },

  PropertyBag: {
    projection: { propertyNames: { $ref: '#/$defs/PropertyName' } },
    probes: [
      [{ Transparency: { t: 'Number', v: 0.5 } }, true],
      [{}, true],
      [{ constructor: { t: 'Number', v: 1 } }, false],
      [{ '0bad': { t: 'Number', v: 1 } }, false],
    ],
  },

  'SetPropertyOp.property': {
    projection: { not: { enum: [...protocol.STRUCTURAL_PROPERTIES] } },
    probes: [
      ['Transparency', true],
      ['Parent', false],
      ['Name', false],
      ['constructor', false],
    ],
  },

  'WriteScriptOp.source': {
    // `maxLength` counts UTF-16 code units; the Zod check counts UTF-8 bytes.
    // They agree for every ASCII source and the JSON Schema is the *looser* of
    // the two above the BMP, which is recorded in the README rather than fudged.
    projection: { maxLength: protocol.LIMITS.MAX_SCRIPT_BYTES },
    probes: [
      ['print("hi")', true],
      ['', true],
    ],
    lost:
      'bounded in UTF-8 *bytes* by the Zod schema and in UTF-16 code units by `maxLength`. ' +
      'A non-ASCII source between the two bounds is accepted by the JSON Schema and refused ' +
      'by the protocol. Nothing in JSON Schema counts bytes, so the schema is the looser of ' +
      'the two above the BMP.',
  },

  ChangeSet: {
    lost:
      'carries a cross-operation refinement: a `deleteInstance` on a path an earlier ' +
      'operation in the same set also touches is refused, because the ordering is then ' +
      'load-bearing in a way no reviewer notices in a diff. JSON Schema has no way to compare ' +
      'two elements of the same array, so a set with that shape validates here and is refused ' +
      'by the protocol. The Python SDK re-checks it in ' +
      '`forgebridge.checks.check_changeset_ordering`; every other consumer of these schemas ' +
      'has to re-check it itself.',
  },
};

// ─────────────────────────────── conversion ───────────────────────────────

interface Ctx {
  /** Named schema object → the name it is `$ref`d under. */
  readonly names: Map<ZodLike, string>;
  /** Name → emitted schema. Filled lazily as refs are followed. */
  readonly defs: Map<string, JsonObject>;
  readonly refPrefix: string;
  /** Locations whose `REFINEMENTS` entry was used, so unused entries are caught. */
  readonly usedRefinements: Set<string>;
  /** Names currently being converted, so a self-reference does not recurse. */
  readonly inFlight: Set<string>;
}

class ProjectionError extends Error {}

function fail(message: string): never {
  throw new ProjectionError(message);
}

function refFor(ctx: Ctx, schema: ZodLike, name: string): JsonObject {
  if (!ctx.defs.has(name) && !ctx.inFlight.has(name)) {
    ctx.inFlight.add(name);
    ctx.defs.set(name, convert(schema, name, ctx, true));
    ctx.inFlight.delete(name);
  }
  return { $ref: `${ctx.refPrefix}${name}` };
}

/**
 * Convert one Zod schema at `loc`.
 *
 * `asDefinition` is true only when converting a named type into `$defs` — it is
 * what stops `refFor` from immediately turning the definition back into a `$ref`
 * to itself.
 */
function convert(schema: ZodLike, loc: string, ctx: Ctx, asDefinition = false): JsonObject {
  const named = ctx.names.get(schema);
  if (named && !asDefinition) return refFor(ctx, schema, named);

  const typeName = schema._def.typeName;

  switch (typeName) {
    case 'ZodBranded':
      return convert(def<ZodLike>(schema, 'type'), loc, ctx, asDefinition);

    case 'ZodOptional':
    case 'ZodReadonly':
      return convert(def<ZodLike>(schema, 'innerType'), loc, ctx, asDefinition);

    case 'ZodDefault': {
      const inner = convert(def<ZodLike>(schema, 'innerType'), loc, ctx, asDefinition);
      const value = def<() => unknown>(schema, 'defaultValue')();
      return { ...inner, default: value as Json };
    }

    case 'ZodNullable': {
      const inner = convert(def<ZodLike>(schema, 'innerType'), loc, ctx, asDefinition);
      return nullable(inner);
    }

    case 'ZodEffects': {
      const key = named ?? loc;
      const declared = REFINEMENTS[key];
      if (!declared) {
        fail(
          `no REFINEMENTS entry for the refinement at "${key}". A refinement this generator ` +
            `has never seen is a constraint the projection would silently drop; add an entry ` +
            `with a projection and probes, or with \`lost\` if JSON Schema cannot express it.`,
        );
      }
      ctx.usedRefinements.add(key);
      const inner = convert(def<ZodLike>(schema, 'schema'), loc, ctx, asDefinition);
      return mergeProjection(inner, declared.projection ?? {}, key);
    }

    case 'ZodString':
      return stringSchema(schema);

    case 'ZodNumber':
      return numberSchema(schema);

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodLiteral': {
      const value = def<Json>(schema, 'value');
      return { type: jsonTypeOf(value), const: value };
    }

    case 'ZodEnum':
      return { type: 'string', enum: [...def<string[]>(schema, 'values')] };

    case 'ZodUnknown':
    case 'ZodAny':
      return {};

    case 'ZodNull':
      return { type: 'null' };

    case 'ZodArray': {
      const out: JsonObject = { type: 'array', items: convert(def<ZodLike>(schema, 'type'), `${loc}[]`, ctx) };
      const min = def<{ value: number } | null>(schema, 'minLength');
      const max = def<{ value: number } | null>(schema, 'maxLength');
      const exact = def<{ value: number } | null>(schema, 'exactLength');
      if (exact) {
        out['minItems'] = exact.value;
        out['maxItems'] = exact.value;
      }
      if (min) out['minItems'] = min.value;
      if (max) out['maxItems'] = max.value;
      return out;
    }

    case 'ZodTuple': {
      const items = def<ZodLike[]>(schema, 'items');
      if (def<ZodLike | null>(schema, 'rest')) fail(`variadic tuple at "${loc}" is not projected`);
      return {
        type: 'array',
        prefixItems: items.map((item, index) => convert(item, `${loc}[${index}]`, ctx)),
        items: false,
        minItems: items.length,
        maxItems: items.length,
      };
    }

    case 'ZodRecord': {
      const keyType = def<ZodLike>(schema, 'keyType');
      const valueType = def<ZodLike>(schema, 'valueType');
      const out: JsonObject = {
        type: 'object',
        additionalProperties: convert(valueType, `${loc}{}`, ctx),
      };
      const keySchema = convert(keyType, `${loc}{key}`, ctx);
      if (Object.keys(keySchema).length > 1 || keySchema['type'] !== 'string') {
        out['propertyNames'] = keySchema;
      }
      return out;
    }

    case 'ZodObject': {
      const shape = def<() => Record<string, ZodLike>>(schema, 'shape')();
      const properties: JsonObject = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        const field = shape[key] as ZodLike;
        properties[key] = convert(field, `${loc}.${key}`, ctx);
        if (!acceptsAbsence(field)) required.push(key);
      }
      const unknownKeys = def<string>(schema, 'unknownKeys');
      const out: JsonObject = { type: 'object', properties };
      if (required.length > 0) out['required'] = required;
      // Zod's default object mode is `strip`: an unknown key is accepted and
      // then removed. `additionalProperties: false` would be a stricter contract
      // than the one the protocol actually enforces, and the first producer to
      // send a forward-compatible extra field would be rejected by a document
      // this repository published.
      out['additionalProperties'] = unknownKeys !== 'strict';
      return out;
    }

    case 'ZodDiscriminatedUnion': {
      const discriminator = def<string>(schema, 'discriminator');
      const options = [...def<Map<unknown, ZodLike> | ZodLike[]>(schema, 'options') as Iterable<ZodLike>];
      const branches = options.map((option, index) =>
        convert(option, `${loc}|${index}`, ctx),
      );
      const out: JsonObject = { oneOf: branches };
      const mapping: JsonObject = {};
      let everyBranchIsRef = true;
      options.forEach((option, index) => {
        const branch = branches[index] as JsonObject;
        const ref = branch['$ref'];
        const tag = discriminantOf(option, discriminator);
        if (typeof ref === 'string' && typeof tag === 'string') mapping[tag] = ref;
        else everyBranchIsRef = false;
      });
      // `discriminator` is an OpenAPI keyword and an annotation elsewhere. It is
      // emitted in both documents because the Python projection reads it to pick
      // pydantic's discriminated-union representation, and a mapping is only
      // legal when every branch is a reference.
      out['discriminator'] = everyBranchIsRef
        ? { propertyName: discriminator, mapping }
        : { propertyName: discriminator };
      return out;
    }

    case 'ZodUnion': {
      const options = def<ZodLike[]>(schema, 'options');
      return { anyOf: options.map((option, index) => convert(option, `${loc}|${index}`, ctx)) };
    }

    default:
      return fail(`no projection for ${typeName} at "${loc}"`);
  }
}

function discriminantOf(option: ZodLike, discriminator: string): string | null {
  let current: ZodLike = option;
  while (current._def.typeName !== 'ZodObject') {
    const next = (current._def['schema'] ?? current._def['innerType'] ?? current._def['type']) as ZodLike | undefined;
    if (!next || !isZodLike(next)) return null;
    current = next;
  }
  const shape = def<() => Record<string, ZodLike>>(current, 'shape')();
  const field = shape[discriminator];
  if (!field || field._def.typeName !== 'ZodLiteral') return null;
  const value = def<unknown>(field, 'value');
  return typeof value === 'string' ? value : null;
}

/** True when the wire may omit this field entirely: `.optional()` or `.default()`. */
function acceptsAbsence(schema: ZodLike): boolean {
  const typeName = schema._def.typeName;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return true;
  if (typeName === 'ZodEffects') return acceptsAbsence(def<ZodLike>(schema, 'schema'));
  if (typeName === 'ZodBranded') return acceptsAbsence(def<ZodLike>(schema, 'type'));
  if (typeName === 'ZodNullable') return acceptsAbsence(def<ZodLike>(schema, 'innerType'));
  return false;
}

function nullable(inner: JsonObject): JsonObject {
  const type = inner['type'];
  if (typeof type === 'string') return { ...inner, type: [type, 'null'] };
  if (Array.isArray(type)) return { ...inner, type: [...(type as string[]), 'null'] };
  return { anyOf: [inner, { type: 'null' }] };
}

function jsonTypeOf(value: Json): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  return Array.isArray(value) ? 'array' : 'object';
}

/**
 * Merge a declared projection onto a converted schema.
 *
 * A `$ref` cannot carry sibling constraints in a way every validator agrees on,
 * so refining a named type becomes `allOf` rather than a merge that some readers
 * would honour and others ignore.
 */
function mergeProjection(inner: JsonObject, projection: JsonObject, key: string): JsonObject {
  if (Object.keys(projection).length === 0) return inner;
  if (typeof inner['$ref'] === 'string') return { allOf: [inner, projection] };
  for (const field of Object.keys(projection)) {
    if (field in inner) fail(`REFINEMENTS["${key}"] overwrites "${field}", which the base schema already sets`);
  }
  return { ...inner, ...projection };
}

function stringSchema(schema: ZodLike): JsonObject {
  const out: JsonObject = { type: 'string' };
  for (const check of def<ReadonlyArray<Record<string, unknown>>>(schema, 'checks') ?? []) {
    switch (check['kind']) {
      case 'min':
        out['minLength'] = check['value'] as number;
        break;
      case 'max':
        out['maxLength'] = check['value'] as number;
        break;
      case 'length':
        out['minLength'] = check['value'] as number;
        out['maxLength'] = check['value'] as number;
        break;
      case 'regex':
        out['pattern'] = (check['regex'] as RegExp).source;
        break;
      case 'uuid':
        out['format'] = 'uuid';
        out['pattern'] = UUID_PATTERN;
        break;
      case 'datetime':
        out['format'] = 'date-time';
        out['pattern'] = DATETIME_PATTERN;
        break;
      default:
        fail(`no projection for string check "${String(check['kind'])}"`);
    }
  }
  return out;
}

function numberSchema(schema: ZodLike): JsonObject {
  const out: JsonObject = { type: 'number' };
  for (const check of def<ReadonlyArray<Record<string, unknown>>>(schema, 'checks') ?? []) {
    switch (check['kind']) {
      case 'int':
        out['type'] = 'integer';
        break;
      case 'min':
        if (check['inclusive'] === false) out['exclusiveMinimum'] = check['value'] as number;
        else out['minimum'] = check['value'] as number;
        break;
      case 'max':
        if (check['inclusive'] === false) out['exclusiveMaximum'] = check['value'] as number;
        else out['maximum'] = check['value'] as number;
        break;
      case 'finite':
        // JSON has no Infinity and no NaN, so this check is already implied by
        // `type: number`. Recorded here so the `default:` branch stays a real
        // "this generator has not been taught that constraint" error.
        break;
      default:
        fail(`no projection for number check "${String(check['kind'])}"`);
    }
  }
  return out;
}

// ─────────────────────── a validator for what we emit ───────────────────────

/**
 * A JSON Schema validator covering exactly the keywords this generator emits.
 *
 * There is no schema validator in this repository's dependency tree, and adding
 * one to run a gate is a supply-chain decision, not a convenience. The
 * alternative — asserting the emitted schemas are correct — is the failure mode
 * the whole file is written against, so the keywords get an implementation
 * whose surface is bounded by `assertSupportedKeywords`: meeting a keyword this
 * function does not implement is an error, never a silent pass.
 *
 * Returns the list of failure paths; empty means valid.
 */
export function validate(schema: Json, value: Json, root: Json = schema, at = '$'): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: schema is false`];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${at}: not a schema`];
  }

  const s = schema as JsonObject;
  assertSupportedKeywords(s, at);
  const errors: string[] = [];

  const ref = s['$ref'];
  if (typeof ref === 'string') {
    return validate(resolveRef(root, ref), value, root, at);
  }

  const type = s['type'];
  if (type !== undefined) {
    const allowed = Array.isArray(type) ? (type as string[]) : [type as string];
    if (!allowed.some((candidate) => matchesType(candidate, value))) {
      errors.push(`${at}: expected ${allowed.join(' | ')}`);
      return errors;
    }
  }

  if ('const' in s && !deepEqual(s['const'] as Json, value)) errors.push(`${at}: not the required constant`);
  if (Array.isArray(s['enum']) && !(s['enum'] as Json[]).some((option) => deepEqual(option, value))) {
    errors.push(`${at}: not one of the permitted values`);
  }
  if (s['not'] !== undefined && validate(s['not'] as Json, value, root, at).length === 0) {
    errors.push(`${at}: matched a forbidden schema`);
  }
  for (const sub of (s['allOf'] as Json[] | undefined) ?? []) {
    errors.push(...validate(sub, value, root, at));
  }
  if (Array.isArray(s['oneOf'])) {
    const matches = (s['oneOf'] as Json[]).filter((sub) => validate(sub, value, root, at).length === 0);
    if (matches.length !== 1) errors.push(`${at}: matched ${matches.length} of the oneOf branches, expected 1`);
  }
  if (Array.isArray(s['anyOf'])) {
    const matches = (s['anyOf'] as Json[]).filter((sub) => validate(sub, value, root, at).length === 0);
    if (matches.length === 0) errors.push(`${at}: matched none of the anyOf branches`);
  }

  if (typeof value === 'string') {
    const min = s['minLength'];
    const max = s['maxLength'];
    if (typeof min === 'number' && [...value].length < min) errors.push(`${at}: shorter than ${min}`);
    if (typeof max === 'number' && value.length > max) errors.push(`${at}: longer than ${max}`);
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'] as string).test(value)) {
      errors.push(`${at}: does not match ${s['pattern'] as string}`);
    }
  }

  if (typeof value === 'number') {
    const min = s['minimum'];
    const max = s['maximum'];
    const exMin = s['exclusiveMinimum'];
    const exMax = s['exclusiveMaximum'];
    if (typeof min === 'number' && value < min) errors.push(`${at}: below ${min}`);
    if (typeof max === 'number' && value > max) errors.push(`${at}: above ${max}`);
    if (typeof exMin === 'number' && value <= exMin) errors.push(`${at}: not above ${exMin}`);
    if (typeof exMax === 'number' && value >= exMax) errors.push(`${at}: not below ${exMax}`);
  }

  if (Array.isArray(value)) {
    const min = s['minItems'];
    const max = s['maxItems'];
    if (typeof min === 'number' && value.length < min) errors.push(`${at}: fewer than ${min} items`);
    if (typeof max === 'number' && value.length > max) errors.push(`${at}: more than ${max} items`);
    const prefix = (s['prefixItems'] as Json[] | undefined) ?? [];
    prefix.forEach((sub, index) => {
      if (index < value.length) errors.push(...validate(sub, value[index] as Json, root, `${at}[${index}]`));
    });
    if (s['items'] !== undefined) {
      for (let index = prefix.length; index < value.length; index += 1) {
        errors.push(...validate(s['items'] as Json, value[index] as Json, root, `${at}[${index}]`));
      }
    }
  }

  if (isPlainObject(value)) {
    const properties = (s['properties'] as JsonObject | undefined) ?? {};
    for (const key of (s['required'] as string[] | undefined) ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: required`);
    }
    if (s['propertyNames'] !== undefined) {
      for (const key of Object.keys(value)) {
        errors.push(...validate(s['propertyNames'] as Json, key, root, `${at}{${key}}`));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        errors.push(...validate(properties[key] as Json, child, root, `${at}.${key}`));
      } else if (s['additionalProperties'] !== undefined) {
        errors.push(...validate(s['additionalProperties'] as Json, child, root, `${at}.${key}`));
      }
    }
  }

  return errors;
}

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', 'title', 'description', 'default', 'examples',
  'type', 'const', 'enum', 'not', 'allOf', 'oneOf', 'anyOf', 'discriminator',
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'items', 'prefixItems', 'minItems', 'maxItems',
  'properties', 'required', 'additionalProperties', 'propertyNames',
]);

function assertSupportedKeywords(schema: JsonObject, at: string): void {
  for (const keyword of Object.keys(schema)) {
    if (keyword.startsWith('x-')) continue;
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      fail(`validate() met the unimplemented keyword "${keyword}" at ${at}; it must not silently pass`);
    }
  }
}

function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith('#/')) fail(`only local $refs are supported, got "${ref}"`);
  let current: Json = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(current) || !(segment in current)) fail(`unresolvable $ref "${ref}"`);
    current = (current as JsonObject)[segment] as Json;
  }
  return current;
}

function matchesType(type: string, value: Json): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return fail(`unknown type "${type}"`);
  }
}

function isPlainObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== undefined && value !== null && !Array.isArray(value);
}

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index] as Json));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => key in b && deepEqual(a[key] as Json, b[key] as Json));
  }
  return false;
}

// ──────────────────────────── the /v1 route table ────────────────────────────

type Auth = 'producer' | 'consumer' | 'none';

interface Response {
  readonly status: number;
  readonly description: string;
  /** A component name, or a literal schema, or nothing for an empty body. */
  readonly schema?: string | JsonObject;
  /**
   * Defaults to `application/json`, which every route answered with until the
   * run stream. Describing a `text/event-stream` as JSON would be this
   * generator's one job — projecting the wire faithfully — done wrong.
   */
  readonly contentType?: string;
}

interface Parameter {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonObject;
}

interface Route {
  readonly method: 'get' | 'post' | 'options';
  /** OpenAPI template form: `/v1/changesets/{changeSetId}/approve`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly auth: Auth;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: { readonly schema: string | JsonObject; readonly description: string };
  readonly responses: readonly Response[];
  /** Set when `docs/PROTOCOL.md` does not list this route. Reported, not hidden. */
  readonly undocumentedInProtocolMd?: string;
}

const UUID_SCHEMA: JsonObject = { type: 'string', format: 'uuid', pattern: UUID_PATTERN };

/** Every error response the daemon can produce carries this body. */
const ERROR_RESPONSES: readonly Response[] = [
  { status: 400, description: 'invalid_request — the body failed schema validation, or a path and body disagree', schema: 'ProtocolError' },
  { status: 401, description: 'link_unauthenticated — missing or wrong producer token, link header or MAC', schema: 'ProtocolError' },
  { status: 403, description: 'not_approved or policy_violation', schema: 'ProtocolError' },
  { status: 404, description: 'not_found', schema: 'ProtocolError' },
  { status: 409, description: 'stale_base, link_unpaired or replay_detected', schema: 'ProtocolError' },
  { status: 413, description: 'too_large — beyond a protocol limit', schema: 'ProtocolError' },
  { status: 426, description: 'unsupported_version — the caller declared an incompatible protocol major', schema: 'ProtocolError' },
  { status: 500, description: 'internal — never carries an internal detail', schema: 'ProtocolError' },
];

/**
 * The `/v1` surface, read off `packages/daemon/src/server.ts`.
 *
 * `checkRouteTable` asserts, against the source of that file, that every
 * resource, sub-path and method the router branches on appears here and vice
 * versa — so this table cannot fall behind the router without failing the gate.
 * It then compares the result with the endpoint table in `docs/PROTOCOL.md`,
 * and the code wins.
 */
const ROUTES: readonly Route[] = [
  {
    method: 'get',
    path: '/v1/health',
    operationId: 'getHealth',
    summary: 'Liveness and protocol version',
    description: 'Unauthenticated. The only route that answers before a link exists.',
    auth: 'none',
    responses: [{ status: 200, description: 'The daemon is up', schema: 'HealthResponse' }],
  },
  {
    method: 'get',
    path: '/v1/link',
    operationId: 'getLinkStatus',
    summary: 'Link status, transport and privacy posture',
    description:
      'Reports that a pairing code is outstanding, never the code itself: serving it would ' +
      'hand it to anything that can reach the port.',
    auth: 'none',
    responses: [{ status: 200, description: 'Current links and pairing state', schema: 'LinkStatusResponse' }],
  },
  {
    method: 'post',
    path: '/v1/link/pair',
    operationId: 'pairLink',
    summary: 'Redeem a pairing code',
    description:
      'The consumer redeems the code the daemon printed and receives the salt it needs to ' +
      'derive the same session key. The key itself never crosses the wire.',
    auth: 'none',
    requestBody: { schema: 'PairRequest', description: 'The pairing code carried by hand from the daemon' },
    responses: [
      { status: 200, description: 'Paired', schema: 'PairResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/link/poll',
    operationId: 'pollDeliveries',
    summary: 'Long-poll for the next delivery',
    description:
      'Consumer surface. Authenticated by a MAC over the method, path and cursor under the ' +
      'session key. Answers 204 when the poll times out with nothing queued.',
    auth: 'consumer',
    parameters: [
      {
        name: 'since',
        in: 'query',
        required: false,
        description: 'The last nonce this consumer accepted. Absent means the nonce origin.',
        schema: { type: 'integer', minimum: 0 },
      },
    ],
    responses: [
      { status: 200, description: 'A sealed delivery envelope', schema: 'DeliveryEnvelope' },
      { status: 204, description: 'Nothing queued before the poll timed out' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/changesets',
    operationId: 'proposeChangeSet',
    summary: 'Propose a ChangeSet',
    description:
      'Proposing is not applying (ADR-012). The daemon overwrites any producer-supplied ' +
      '`status` and `validation` with what it computed itself, so a set cannot arrive ' +
      'pre-approved or carrying its own verdict. Nothing reaches the place until ' +
      '`POST /v1/changesets/{changeSetId}/approve` is called separately.',
    auth: 'producer',
    requestBody: { schema: 'ChangeSet', description: 'The proposed set, built against a current baseVersion' },
    responses: [
      { status: 201, description: 'Stored and validated; not approved and not applied', schema: 'SubmitChangeSetResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/changesets/{changeSetId}/diff',
    operationId: 'getChangeSetDiff',
    summary: 'Rendered diff for review',
    description:
      'Producer surface rather than public surface: it serves script source and property ' +
      'values out of the user\'s place.',
    auth: 'producer',
    parameters: [
      { name: 'changeSetId', in: 'path', required: true, description: 'The ChangeSet id', schema: UUID_SCHEMA },
    ],
    responses: [
      { status: 200, description: 'The diff', schema: 'ChangeSetDiff' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/changesets/{changeSetId}/approve',
    operationId: 'approveChangeSet',
    summary: 'Approve a ChangeSet for delivery',
    description:
      'The gate ADR-012 exists for, and a separate operation from proposing on purpose: a ' +
      'producer that could approve its own work is a model approving its own work. Refuses a ' +
      'set with no validation, a set whose validation failed, a stale baseVersion, and a bulk ' +
      'delete without `confirmBulkDelete`.',
    auth: 'producer',
    parameters: [
      { name: 'changeSetId', in: 'path', required: true, description: 'The ChangeSet id', schema: UUID_SCHEMA },
    ],
    requestBody: { schema: 'ApproveRequest', description: 'Who approved, and whether a bulk delete was confirmed' },
    responses: [
      { status: 202, description: 'Approved and queued for the consumer', schema: 'ApproveResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/changesets/{changeSetId}/apply-result',
    operationId: 'reportApplyResultForChangeSet',
    summary: 'Consumer reports what it applied',
    description:
      'Enveloped and MAC\'d. The body is a DeliveryEnvelope whose payload is an ApplyResult. ' +
      'A partial apply is a legal outcome and is recorded as `partial`.',
    auth: 'consumer',
    parameters: [
      { name: 'changeSetId', in: 'path', required: true, description: 'Must equal the ApplyResult\'s own changeSetId', schema: UUID_SCHEMA },
    ],
    requestBody: { schema: 'DeliveryEnvelope', description: 'A sealed envelope whose payload is an ApplyResult' },
    responses: [
      { status: 200, description: 'Recorded, with the new project version and the rollback handle', schema: 'ApplyResultAck' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/apply-result',
    operationId: 'reportApplyResult',
    summary: 'Consumer reports what it applied, without the ChangeSet in the path',
    description:
      'The unparameterised form. Accepted because an ApplyResult already names its own ' +
      '`changeSetId`, and a consumer holding the result but not the path is otherwise stuck.',
    auth: 'consumer',
    requestBody: { schema: 'DeliveryEnvelope', description: 'A sealed envelope whose payload is an ApplyResult' },
    responses: [
      { status: 200, description: 'Recorded', schema: 'ApplyResultAck' },
      ...ERROR_RESPONSES,
    ],
    undocumentedInProtocolMd: 'accepted by the router since M14; add it to the endpoint table',
  },
  {
    method: 'post',
    path: '/v1/journal/{journalId}/rollback',
    operationId: 'requestRollback',
    summary: 'Dispatch a rollback of a journalled apply',
    description:
      'Dispatched, not done: the delivery carries the inverse operations, and the consumer ' +
      'replays them and reports separately to POST /v1/journal/{journalId}/rollback-result. ' +
      'Refused when this transport holds no inverses for the apply — a reversal it cannot ' +
      'send is not one it will pretend to dispatch.',
    auth: 'producer',
    parameters: [
      { name: 'journalId', in: 'path', required: true, description: 'Must equal the request body\'s journalId', schema: UUID_SCHEMA },
    ],
    requestBody: { schema: 'RollbackRequest', description: 'The journal to reverse and the version it expects' },
    responses: [
      { status: 202, description: 'Queued for the consumer', schema: 'RollbackResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/journal/{journalId}',
    operationId: 'getJournal',
    summary: 'What happened to one apply, and to any reversal of it',
    description:
      'Producer surface: it names what was changed in the user\'s place and carries the ' +
      'consumer\'s own report of what a rollback did or did not undo. `rollback_partial` is a ' +
      'state of its own and must not be rounded to either neighbour — some inverses replayed ' +
      'and some did not, and the ones that would have finished the job are spent.',
    auth: 'producer',
    parameters: [
      { name: 'journalId', in: 'path', required: true, description: 'The journal id an ApplyResult reported', schema: UUID_SCHEMA },
    ],
    responses: [
      { status: 200, description: 'The journal, and the rollback result if one was reported', schema: 'JournalStateResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/journal/{journalId}/entry',
    operationId: 'recordJournalEntry',
    summary: 'Consumer uploads the inverse operations it captured',
    description:
      'Enveloped and MAC\'d. The body is a DeliveryEnvelope whose payload is a JournalEntry. ' +
      'This is what takes the inverses off the session that captured them, so a rollback can ' +
      'outlive it. The entry is checked against the apply this transport witnessed rather ' +
      'than believed, and validated as a replay at upload rather than weeks later when it is ' +
      'needed.',
    auth: 'consumer',
    parameters: [
      { name: 'journalId', in: 'path', required: true, description: 'Must equal the JournalEntry\'s own id', schema: UUID_SCHEMA },
    ],
    requestBody: { schema: 'DeliveryEnvelope', description: 'A sealed envelope whose payload is a JournalEntry' },
    responses: [
      { status: 200, description: 'Recorded, with the number of inverses now held', schema: 'JournalEntryAck' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/journal/{journalId}/rollback-result',
    operationId: 'reportRollbackResult',
    summary: 'Consumer reports how far a reversal got',
    description:
      'Enveloped and MAC\'d. The body is a DeliveryEnvelope whose payload is a RollbackResult. ' +
      'A partial reversal is a legal outcome and is recorded as `rollback_partial`, which ' +
      'leaves `rolledBackAt` null: the entry is neither reversed nor intact. Refused when no ' +
      'rollback was dispatched — a consumer does not start one.',
    auth: 'consumer',
    parameters: [
      { name: 'journalId', in: 'path', required: true, description: 'Must equal the RollbackResult\'s own journalId', schema: UUID_SCHEMA },
    ],
    requestBody: { schema: 'DeliveryEnvelope', description: 'A sealed envelope whose payload is a RollbackResult' },
    responses: [
      { status: 200, description: 'Recorded, with the journal\'s new state', schema: 'RollbackResultAck' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'post',
    path: '/v1/output',
    operationId: 'mirrorOutput',
    summary: 'Consumer mirrors the Studio console up',
    description: 'Enveloped and MAC\'d. The payload is an OutputBatch.',
    auth: 'consumer',
    requestBody: { schema: 'DeliveryEnvelope', description: 'A sealed envelope whose payload is an OutputBatch' },
    responses: [
      { status: 204, description: 'Appended' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/output',
    operationId: 'readOutput',
    summary: 'Producer reads the mirrored console back',
    description: 'Producer surface: the console is place content.',
    auth: 'producer',
    parameters: [
      {
        name: 'link',
        in: 'query',
        required: false,
        description: 'Which link to read. Absent means the daemon\'s default project\'s paired link.',
        schema: UUID_SCHEMA,
      },
    ],
    responses: [
      { status: 200, description: 'The most recent messages', schema: 'OutputResponse' },
      ...ERROR_RESPONSES,
    ],
    undocumentedInProtocolMd: 'served by the router since M14; add it to the endpoint table',
  },
  {
    method: 'post',
    path: '/v1/runs',
    operationId: 'startRun',
    summary: 'Turn a prompt into a proposed ChangeSet',
    description:
      'Runs the pipeline in `@forgebridge/core`: plan, route over the candidate models, generate, ' +
      'validate. It stops at `awaiting-approval` and there is no argument that takes it further — ' +
      'the set it stores is `validated`, and applying it means calling ' +
      '`POST /v1/changesets/{changeSetId}/approve` with the digest of a diff a human read (ADR-012).\n\n' +
      'The response carries `run.attempts`: every model the router tried, in order, with why it moved ' +
      'on. That list is the run\'s permanent record and is returned in full whether the run succeeded, ' +
      'failed or was cancelled — a fallback the caller cannot see is a silent substitution (ADR-008).\n\n' +
      'A run that produced nothing still answers 201 with `failure` set, because a `ProtocolError` body ' +
      'has nowhere to carry the attempt list. The 4xx and 5xx below are the things that stopped a run ' +
      'from starting: no model client, no reachable candidate, a stale `baseVersion`.\n\n' +
      'With `stream: true` the answer is a `text/event-stream` instead. Its frames are `run` (a whole ' +
      'RunResponse, first and last), one frame per core `RunEvent` under that event\'s own type — ' +
      '`stage`, `plan`, `model-attempt-started`, `output-delta`, `model-attempt`, `model-skipped`, ' +
      '`validation`, `change-set`, `cancelled`, `failed` — each carrying its index as the SSE id, and ' +
      '`error` carrying a ProtocolError if the request itself fails after the stream opened. Two ' +
      '`validation` frames are normal: the core computes one through its analyser port, and the daemon ' +
      'computes the one it stands behind over every source the set carries. `computedBy` says which.',
    auth: 'producer',
    requestBody: { schema: 'StartRunRequest', description: 'The prompt, and how to route it' },
    responses: [
      { status: 200, description: 'The streamed form, when `stream` is true', schema: { type: 'string' }, contentType: 'text/event-stream' },
      { status: 201, description: 'The run, with its full attempt list. Nothing has been applied', schema: 'RunResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/runs/{runId}',
    operationId: 'getRun',
    summary: 'A run and every model it tried',
    description:
      'Answers during a run as well as after it. `changeSetStatus` is read from the ChangeSet itself ' +
      'rather than copied onto the run, so a set that has since been approved and applied reports that.',
    auth: 'producer',
    parameters: [
      { name: 'runId', in: 'path', required: true, description: 'The run id', schema: UUID_SCHEMA },
    ],
    responses: [
      { status: 200, description: 'The run', schema: 'RunResponse' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/runs/{runId}/events',
    operationId: 'watchRun',
    summary: 'Replay and follow a run as it happens',
    description:
      'Same frames as the streamed form of `POST /v1/runs`. Opens with a `run` frame so a client that ' +
      'arrives late knows what the events are about, replays the retained events from `?since=`, then ' +
      'follows until the run ends.\n\n' +
      'The log is in memory and capped: `output-delta` frames are broadcast and never retained, and a ' +
      'run old enough to have been evicted answers with the run record and a `closed` frame rather than ' +
      'stopping quietly. Nothing the stream can lose is missing from the record — the attempt list is on ' +
      'the `run` frame.',
    auth: 'producer',
    parameters: [
      { name: 'runId', in: 'path', required: true, description: 'The run id', schema: UUID_SCHEMA },
      {
        name: 'since',
        in: 'query',
        required: false,
        description: 'Replay retained events from this index. Absent means from the beginning.',
        schema: { type: 'integer', minimum: 0 },
      },
    ],
    responses: [
      { status: 200, description: 'The event stream', schema: { type: 'string' }, contentType: 'text/event-stream' },
      ...ERROR_RESPONSES,
    ],
  },
  {
    method: 'get',
    path: '/v1/models',
    operationId: 'getModels',
    summary: 'Registry snapshot',
    description:
      'Whatever the registry port returns. `configured: false` and an empty list are ' +
      'different facts and are reported as such.',
    auth: 'none',
    responses: [{ status: 200, description: 'The snapshot', schema: 'ModelsSnapshot' }],
  },
];

/**
 * Schemas the daemon's handlers build inline, with no counterpart in
 * `packages/daemon/src/wire.ts`.
 *
 * Written out here because the OpenAPI document would otherwise describe two
 * responses as "some object". They are the only part of this file that is a
 * transcription of a handler rather than a projection of a schema, which is
 * exactly why the TODO below exists.
 *
 * TODO(M31): `#submitChangeSet` and `#applyResult` should build their responses
 * from a schema in `wire.ts` like every other handler does, at which point these
 * two definitions are deleted and generated instead. Owner: the daemon
 * maintainer — `packages/daemon` is not this script's to edit.
 */
const HANDLER_SHAPED_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  SubmitChangeSetResponse: {
    type: 'object',
    title: 'SubmitChangeSetResponse',
    description:
      'Transcribed from ForgeBridgeDaemon#submitChangeSet. Not generated from a Zod schema — ' +
      'the handler has none. TODO(M31).',
    properties: {
      changeSetId: UUID_SCHEMA,
      status: { $ref: '#/components/schemas/ChangeSetStatus' },
      baseVersion: { type: 'integer', minimum: 0 },
      validation: { $ref: '#/components/schemas/Validation' },
    },
    required: ['changeSetId', 'status', 'baseVersion', 'validation'],
    additionalProperties: true,
  },
  ApplyResultAck: {
    type: 'object',
    title: 'ApplyResultAck',
    description:
      'Transcribed from ForgeBridgeDaemon#applyResult. Not generated from a Zod schema — ' +
      'the handler has none. TODO(M31).',
    properties: {
      changeSetId: UUID_SCHEMA,
      status: { $ref: '#/components/schemas/ChangeSetStatus' },
      version: { type: 'integer', minimum: 0 },
      journalId: UUID_SCHEMA,
    },
    required: ['changeSetId', 'status', 'version', 'journalId'],
    additionalProperties: true,
  },
};

// ───────────────────── router / documentation cross-check ─────────────────────

/** The body of `ForgeBridgeDaemon#route`, which is where every branch lives. */
function routerBody(source: string): string {
  const start = source.indexOf('  async #route(');
  if (start < 0) fail(`could not find #route in ${SERVER_SOURCE}; the router moved`);
  const end = source.indexOf("\n  // ── endpoints ──", start);
  if (end < 0) fail(`could not find the end of #route in ${SERVER_SOURCE}`);
  return source.slice(start, end);
}

function literalsComparedTo(body: string, variable: string): Set<string> {
  const pattern = new RegExp(`${variable.replace(/[\\[\]]/g, '\\$&')}\\s*===\\s*'([^']+)'`, 'g');
  return new Set([...body.matchAll(pattern)].map((match) => match[1] as string));
}

/**
 * Assert this file's `ROUTES` still describes the router, then compare both
 * with the endpoint table in `docs/PROTOCOL.md`.
 *
 * Returns the discrepancies with the documentation; an inconsistency with the
 * *code* is not returned, it throws — a generated OpenAPI document that
 * describes a surface the server does not serve is worse than none.
 */
export function checkRouteTable(serverSource: string, protocolDoc: string): string[] {
  const body = routerBody(serverSource);

  const declaredResources = new Set(ROUTES.map((route) => route.path.split('/')[2] as string));
  const routerResources = literalsComparedTo(body, 'resource');
  for (const resource of routerResources) {
    if (!declaredResources.has(resource)) {
      fail(`the router branches on resource "${resource}", which ROUTES does not describe`);
    }
  }
  for (const resource of declaredResources) {
    if (!routerResources.has(resource)) {
      fail(`ROUTES describes /v1/${resource}, on which the router never branches`);
    }
  }

  const declaredSegments = new Set(
    ROUTES.flatMap((route) => route.path.split('/').slice(3).filter((segment) => !segment.startsWith('{'))),
  );
  for (const segment of [
    ...literalsComparedTo(body, 'rest[0]'),
    ...literalsComparedTo(body, 'rest[1]'),
  ]) {
    if (!declaredSegments.has(segment)) {
      fail(`the router branches on the sub-path "${segment}", which ROUTES does not describe`);
    }
  }

  const declaredMethods = new Set(ROUTES.map((route) => route.method.toUpperCase()));
  for (const method of literalsComparedTo(body, 'method')) {
    if (!declaredMethods.has(method)) {
      fail(`the router branches on method ${method}, which ROUTES does not use`);
    }
  }
  if (!/req\.method === 'OPTIONS'/.test(serverSource)) {
    fail(`${SERVER_SOURCE} no longer answers OPTIONS; the CORS preflight route in ROUTES is stale`);
  }

  return compareWithProtocolDoc(protocolDoc);
}

/** `GET /v1/changesets/:id/diff` in the doc ↔ `get /v1/changesets/{changeSetId}/diff` here. */
function normalisePath(raw: string): string {
  return raw
    .replace(/\?.*$/, '')
    .split('/')
    .map((segment) => (segment.startsWith(':') || segment.startsWith('{') ? '{}' : segment))
    .join('/');
}

function compareWithProtocolDoc(protocolDoc: string): string[] {
  const start = protocolDoc.indexOf('## Transport endpoints');
  if (start < 0) fail('docs/PROTOCOL.md has no "## Transport endpoints" section');
  const section = protocolDoc.slice(start, protocolDoc.indexOf('\n## ', start + 1));

  const documented = new Set(
    // The table's arrows sit flush against the path on some rows, so the path
    // stops at whitespace or at an arrow rather than at "any non-space".
    [...section.matchAll(/^\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/v1[^\s\u2192]*)/gm)].map(
      (match) => `${(match[1] as string).toLowerCase()} ${normalisePath(match[2] as string)}`,
    ),
  );
  const served = new Set(ROUTES.map((route) => `${route.method} ${normalisePath(route.path)}`));

  const discrepancies: string[] = [];
  for (const route of [...served].sort()) {
    if (!documented.has(route)) discrepancies.push(`served but not in the PROTOCOL.md table: ${route.toUpperCase()}`);
  }
  for (const route of [...documented].sort()) {
    if (!served.has(route)) discrepancies.push(`in the PROTOCOL.md table but not served: ${route.toUpperCase()}`);
  }
  return discrepancies;
}

/**
 * Header names read out of the daemon rather than restated.
 *
 * `X-ForgeBridge-Link` and `X-ForgeBridge-Mac` are module-private constants in
 * `server.ts`, so there is nothing to import; extracting them from the source
 * means renaming one fails this generator instead of quietly publishing a
 * security scheme nobody can authenticate against.
 */
export function extractHeaderNames(serverSource: string, authSource: string): Record<string, string> {
  const grab = (source: string, name: string): string => {
    const match = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source);
    if (!match) fail(`could not read ${name} out of the daemon source`);
    return match[1] as string;
  };
  return {
    link: grab(serverSource, 'const LINK_HEADER'),
    mac: grab(serverSource, 'const MAC_HEADER'),
    producerToken: grab(authSource, 'PRODUCER_TOKEN_HEADER'),
    plugin: protocol.PLUGIN_VERSION_HEADER,
    protocol: protocol.PROTOCOL_VERSION_HEADER,
  };
}

/**
 * The daemon's default port, imported rather than restated.
 *
 * The OpenAPI server URL used to carry a hand-typed `8787`; the daemon has only
 * ever bound `DEFAULT_DAEMON_PORT`, which is a different number. That is worse
 * than a typo in a document nobody generates. This file's claim — the one
 * `packages/protocol/schema/README.md` repeats — is that the `/v1` surface is
 * read off the implementation and therefore cannot drift from it, and a private
 * second copy of the implementation's most user-visible number is exactly the
 * drift the claim denies. Roblox scopes a plugin's HttpService permission to an
 * address, so a wrong port reads to a user as "the bridge is broken" long before
 * anyone suspects a schema.
 *
 * Unlike the header names above there is something to import — the constant is
 * exported, and nothing in `scripts/verify-boundaries.ts` scopes `scripts/` — so
 * it is imported, and a rename or a retype fails generation here instead of
 * publishing a URL no daemon answers on.
 */
export function daemonDefaultPort(server: Record<string, unknown>): string {
  const port = server['DEFAULT_DAEMON_PORT'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(
      `packages/daemon/src/server.ts does not export DEFAULT_DAEMON_PORT as a port number ` +
        `(got ${JSON.stringify(port)}). The OpenAPI server URL is built from it and has no default to fall back on.`,
    );
  }
  return String(port);
}

// ──────────────────────────────── projection ────────────────────────────────

function namedSchemas(module: Record<string, unknown>): Map<string, ZodLike> {
  const out = new Map<string, ZodLike>();
  for (const key of Object.keys(module).sort()) {
    const value = module[key];
    if (isZodLike(value)) out.set(key, value);
  }
  return out;
}

function project(schemas: Map<string, ZodLike>, refPrefix: string): { defs: Map<string, JsonObject>; used: Set<string> } {
  const names = new Map<ZodLike, string>();
  for (const [name, schema] of schemas) if (!names.has(schema)) names.set(schema, name);
  const ctx: Ctx = { names, defs: new Map(), refPrefix, usedRefinements: new Set(), inFlight: new Set() };
  for (const [name, schema] of schemas) {
    if (ctx.defs.has(name)) continue;
    ctx.inFlight.add(name);
    ctx.defs.set(name, convert(schema, name, ctx, true));
    ctx.inFlight.delete(name);
  }
  return { defs: ctx.defs, used: ctx.usedRefinements };
}

/** Every `$ref` target name reachable from `value`. */
function refsIn(value: Json, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, out);
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') out.add(child.slice(child.lastIndexOf('/') + 1));
      else refsIn(child, out);
    }
  }
  return out;
}

function transitiveRefs(name: string, defs: Map<string, JsonObject>): Set<string> {
  const seen = new Set<string>();
  const queue = [...refsIn(defs.get(name) as Json)];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next) || next === name) continue;
    seen.add(next);
    const target = defs.get(next);
    if (!target) fail(`"${name}" references "${next}", which is not a top-level type`);
    queue.push(...refsIn(target as Json));
  }
  return seen;
}

// ────────────────────────────────── probes ──────────────────────────────────

/** Sub-schema at a `REFINEMENTS` location, resolved out of the bundle. */
function schemaAtLocation(location: string, defs: Map<string, JsonObject>): Json {
  const [head, ...rest] = location.split('.');
  let current: Json = defs.get(head as string) as Json;
  if (current === undefined) fail(`probe location "${location}" names no top-level type`);
  for (const field of rest) {
    if (!isPlainObject(current)) fail(`probe location "${location}" does not resolve`);
    const properties = current['properties'];
    if (!isPlainObject(properties) || !(field in properties)) fail(`probe location "${location}" does not resolve`);
    current = (properties as JsonObject)[field] ?? fail(`probe location "${location}" does not resolve`);
  }
  return current;
}

/** The Zod schema at a `REFINEMENTS` location, for the other half of the probe. */
function zodAtLocation(location: string, schemas: Map<string, ZodLike>): ZodLike {
  const [head, ...rest] = location.split('.');
  let current = schemas.get(head as string);
  if (!current) fail(`probe location "${location}" names no exported schema`);
  for (const field of rest) {
    let cursor: ZodLike = current;
    while (cursor._def.typeName !== 'ZodObject') {
      const next = (cursor._def['schema'] ?? cursor._def['innerType'] ?? cursor._def['type']) as unknown;
      if (!isZodLike(next)) fail(`probe location "${location}" does not resolve in Zod`);
      cursor = next;
    }
    const shape = def<() => Record<string, ZodLike>>(cursor, 'shape')();
    const child = shape[field];
    if (!child) fail(`probe location "${location}" does not resolve in Zod`);
    current = child;
  }
  return current;
}

/**
 * Run every declared probe through both sides and report disagreements.
 *
 * This is the load-bearing part of the file. `INSTANCE_PATH_PATTERN` and the
 * reserved-name list are the only places where a Zod refinement is restated by
 * hand, and a restatement that is not checked is exactly the class of claim this
 * repository gates elsewhere.
 */
function runProbes(schemas: Map<string, ZodLike>, defs: Map<string, JsonObject>): string[] {
  const bundle: Json = { $defs: Object.fromEntries(defs) as unknown as Json };
  const problems: string[] = [];

  for (const [location, refinement] of Object.entries(REFINEMENTS)) {
    const probes = refinement.probes ?? [];
    if (probes.length === 0 && !refinement.lost) {
      problems.push(`REFINEMENTS["${location}"] projects a constraint but declares no probes`);
      continue;
    }
    const zod = zodAtLocation(location, schemas);
    const json = schemaAtLocation(location, defs);
    for (const [value, expected] of probes) {
      const byZod = zod.safeParse(value).success;
      const bySchema = validate(json, value, bundle).length === 0;
      if (byZod !== expected) {
        problems.push(`probe ${JSON.stringify(value)} at ${location}: Zod says ${byZod}, the probe expected ${expected}`);
      }
      if (byZod !== bySchema) {
        problems.push(
          `probe ${JSON.stringify(value)} at ${location}: Zod says ${byZod}, the JSON Schema says ${bySchema}`,
        );
      }
    }
  }

  // The two restated string formats, probed against a schema that actually uses
  // each of them rather than against a hand-built copy.
  const formatHosts: ReadonlyArray<readonly ['uuid' | 'datetime', string]> = [
    ['uuid', 'RollbackRequest.journalId'],
    ['datetime', 'ApplyResult.appliedAt'],
  ];
  for (const [format, location] of formatHosts) {
    const zod = zodAtLocation(location, schemas);
    const json = schemaAtLocation(location, defs);
    for (const value of FORMAT_PROBES[format]) {
      const byZod = zod.safeParse(value).success;
      const bySchema = validate(json, value, bundle).length === 0;
      if (byZod !== bySchema) {
        problems.push(
          `${format} probe ${JSON.stringify(value)} at ${location}: Zod says ${byZod}, the JSON Schema says ${bySchema}`,
        );
      }
    }
  }

  return problems;
}

// ─────────────────────────── serialisation helpers ───────────────────────────

/** Two-space JSON with a trailing newline. Byte-stable, so `--check` is a real diff. */
function stableJson(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ───────────────────────── the Python projection ─────────────────────────

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield',
]);

interface PyType {
  readonly base: string;
  /** `Annotated[...]` metadata: constraints and validators. */
  readonly meta: readonly string[];
}

interface PyCtx {
  readonly components: Readonly<Record<string, JsonObject>>;
  readonly blocks: string[];
  readonly done: Set<string>;
  readonly building: Set<string>;
}

function pascal(raw: string): string {
  return raw
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function pyLiteral(value: Json): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return fail(`no Python literal for ${JSON.stringify(value)}`);
}

function annotate(type: PyType): string {
  return type.meta.length === 0 ? type.base : `Annotated[${[type.base, ...type.meta].join(', ')}]`;
}

function componentNameOf(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function ensureComponent(name: string, ctx: PyCtx): void {
  if (ctx.done.has(name)) return;
  if (ctx.building.has(name)) fail(`the Python projection met a cycle at "${name}"`);
  const schema = ctx.components[name];
  if (!schema) fail(`"${name}" is referenced but is not a component`);
  ctx.building.add(name);

  if (isObjectWithProperties(schema)) {
    emitModel(name, schema, ctx);
  } else {
    const type = pyType(schema, name, ctx);
    ctx.blocks.push(`${name} = ${annotate(type)}\n`);
  }

  ctx.building.delete(name);
  ctx.done.add(name);
}

function isObjectWithProperties(schema: JsonObject): boolean {
  return schema['type'] === 'object' && isPlainObject(schema['properties'] as Json);
}

function emitModel(name: string, schema: JsonObject, ctx: PyCtx): void {
  const properties = schema['properties'] as JsonObject;
  const required = new Set(((schema['required'] as string[] | undefined) ?? []));
  const lines: string[] = [];
  const omitIfNone: string[] = [];

  lines.push(`class ${name}(_Model):`);
  const description = schema['description'];
  if (typeof description === 'string') {
    lines.push(`    """${description.replace(/"""/g, "'''")}"""`, '');
  }

  for (const [wireName, rawField] of Object.entries(properties)) {
    const field = rawField as JsonObject;
    const type = pyType(field, `${name}${pascal(wireName)}`, ctx);
    const isRequired = required.has(wireName);
    const hasDefault = 'default' in field;
    if (!isRequired && !hasDefault) omitIfNone.push(wireName);

    const pythonName = PYTHON_KEYWORDS.has(wireName) ? `${wireName}_` : wireName;
    const alias = pythonName === wireName ? null : wireName;

    // `| None` marks *absence*, not nullability — nullability already comes from
    // the schema's own `type: [..., "null"]`. A field with a default is never
    // absent after parsing, so widening it here would accept a null the protocol
    // refuses.
    const rendered = annotate(type);
    const annotation =
      isRequired || hasDefault || rendered.endsWith('| None') ? rendered : `${rendered} | None`;
    const args: string[] = [];
    if (hasDefault) {
      const value = field['default'] as Json;
      if (Array.isArray(value) && value.length === 0) args.push('default_factory=list');
      else if (isPlainObject(value) && Object.keys(value).length === 0) args.push('default_factory=dict');
      else args.push(`default=${pyLiteral(value)}`);
    } else if (!isRequired) {
      args.push('default=None');
    }
    if (alias) args.push(`alias=${JSON.stringify(alias)}`);

    lines.push(args.length === 0
      ? `    ${pythonName}: ${annotation}`
      : `    ${pythonName}: ${annotation} = Field(${args.join(', ')})`);
  }

  if (omitIfNone.length > 0) {
    const members = omitIfNone.map((n) => JSON.stringify(n)).join(', ');
    lines.push(
      '',
      '    # Absent on the wire rather than null: Zod leaves an `.optional()` field off the',
      '    # parsed object entirely, and a projection that emitted `null` instead would not',
      '    # round-trip.',
      `    _omit_if_none: ClassVar[frozenset[str]] = frozenset({${members}})`,
    );
  }

  ctx.blocks.push(`${lines.join('\n')}\n`);
}

function pyType(schema: JsonObject, hint: string, ctx: PyCtx): PyType {
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = componentNameOf(ref);
    ensureComponent(name, ctx);
    return { base: name, meta: [] };
  }

  if (Array.isArray(schema['allOf'])) {
    const parts = schema['allOf'] as JsonObject[];
    const [head, ...rest] = parts;
    const base = pyType(head as JsonObject, hint, ctx);
    const meta = [...base.meta];
    for (const extra of rest) meta.push(...constraintsFor(extra, hint));
    return { base: base.base, meta };
  }

  if (Array.isArray(schema['oneOf'])) {
    const discriminator = isPlainObject(schema['discriminator'] as Json)
      ? ((schema['discriminator'] as JsonObject)['propertyName'] as string)
      : null;
    const members = (schema['oneOf'] as JsonObject[]).map((branch) => {
      const tag = discriminator ? constOf(branch, discriminator, ctx) : null;
      const branchHint = tag ? `${hint}${pascal(tag)}` : `${hint}Option`;
      return annotate(pyType(branch, branchHint, ctx));
    });
    const union = members.join(' | ');
    return discriminator
      ? { base: `(${union})`, meta: [`Field(discriminator=${JSON.stringify(discriminator)})`] }
      : { base: `(${union})`, meta: [] };
  }

  const rawType = schema['type'];
  const types = Array.isArray(rawType) ? (rawType as string[]) : rawType === undefined ? [] : [rawType as string];
  const nullable = types.includes('null');
  const concrete = types.filter((t) => t !== 'null');

  if (concrete.length === 0 && !('const' in schema) && !('enum' in schema)) {
    return { base: nullable ? 'None' : 'Any', meta: [] };
  }

  const inner = pyConcrete(schema, concrete[0] as string | undefined, hint, ctx);
  if (!nullable) return inner;
  return { base: `${annotate(inner)} | None`, meta: [] };
}

function pyConcrete(schema: JsonObject, type: string | undefined, hint: string, ctx: PyCtx): PyType {
  if ('const' in schema) return { base: `Literal[${pyLiteral(schema['const'] as Json)}]`, meta: [] };
  if (Array.isArray(schema['enum'])) {
    const members = (schema['enum'] as Json[]).map(pyLiteral).join(', ');
    return { base: `Literal[${members}]`, meta: [] };
  }

  switch (type) {
    case 'string':
      return { base: 'str', meta: constraintsFor(schema, hint) };
    case 'integer':
      return { base: 'int', meta: constraintsFor(schema, hint) };
    case 'number':
      return { base: 'float', meta: constraintsFor(schema, hint) };
    case 'boolean':
      return { base: 'bool', meta: [] };
    case 'array': {
      if (Array.isArray(schema['prefixItems'])) {
        const members = (schema['prefixItems'] as JsonObject[]).map((item, index) =>
          annotate(pyType(item, `${hint}${index}`, ctx)),
        );
        return { base: `tuple[${members.join(', ')}]`, meta: [] };
      }
      const items = isPlainObject(schema['items'] as Json)
        ? annotate(pyType(schema['items'] as JsonObject, `${hint}Item`, ctx))
        : 'Any';
      return { base: `list[${items}]`, meta: constraintsFor(schema, hint) };
    }
    case 'object': {
      if (isObjectWithProperties(schema)) {
        emitModel(hint, schema, ctx);
        ctx.done.add(hint);
        return { base: hint, meta: [] };
      }
      const additional = schema['additionalProperties'];
      const value = isPlainObject(additional as Json)
        ? annotate(pyType(additional as JsonObject, `${hint}Value`, ctx))
        : 'Any';
      const key = isPlainObject(schema['propertyNames'] as Json)
        ? annotate(pyType(schema['propertyNames'] as JsonObject, `${hint}Key`, ctx))
        : 'str';
      return { base: `dict[${key}, ${value}]`, meta: [] };
    }
    default:
      return fail(`no Python projection for type "${String(type)}" at ${hint}`);
  }
}

function constraintsFor(schema: JsonObject, hint: string): string[] {
  const meta: string[] = [];

  const stringArgs: string[] = [];
  if (typeof schema['minLength'] === 'number') stringArgs.push(`min_length=${schema['minLength'] as number}`);
  if (typeof schema['maxLength'] === 'number') stringArgs.push(`max_length=${schema['maxLength'] as number}`);
  if (typeof schema['pattern'] === 'string') stringArgs.push(`pattern=${pyRegex(schema['pattern'] as string)}`);
  if (stringArgs.length > 0) meta.push(`StringConstraints(${stringArgs.join(', ')})`);

  if (typeof schema['minimum'] === 'number') meta.push(`Ge(${schema['minimum'] as number})`);
  if (typeof schema['maximum'] === 'number') meta.push(`Le(${schema['maximum'] as number})`);
  if (typeof schema['exclusiveMinimum'] === 'number') meta.push(`Gt(${schema['exclusiveMinimum'] as number})`);
  if (typeof schema['exclusiveMaximum'] === 'number') meta.push(`Lt(${schema['exclusiveMaximum'] as number})`);

  const minItems = schema['minItems'];
  const maxItems = schema['maxItems'];
  if (typeof minItems === 'number' || typeof maxItems === 'number') {
    meta.push(`Len(${typeof minItems === 'number' ? minItems : 0}${typeof maxItems === 'number' ? `, ${maxItems}` : ''})`);
  }

  const not = schema['not'];
  if (isPlainObject(not as Json)) {
    const forbidden = (not as JsonObject)['enum'];
    if (!Array.isArray(forbidden)) fail(`the Python projection only understands \`not: { enum }\` (at ${hint})`);
    const members = (forbidden as Json[]).map(pyLiteral).join(', ');
    meta.push(`AfterValidator(_reject((${members}${(forbidden as Json[]).length === 1 ? ',' : ''})))`);
  }

  return meta;
}

/** A JSON Schema `pattern` as a Python raw string. */
function pyRegex(pattern: string): string {
  if (pattern.includes("'") || pattern.includes('\\\n')) fail(`cannot express the pattern ${pattern} as a raw string`);
  return `r'${pattern}'`;
}

/** The discriminant value a `oneOf` branch pins, following one `$ref` if needed. */
function constOf(branch: JsonObject, discriminator: string, ctx: PyCtx): string | null {
  const ref = branch['$ref'];
  const target = typeof ref === 'string' ? ctx.components[componentNameOf(ref)] : branch;
  if (!target || !isPlainObject(target['properties'] as Json)) return null;
  const field = (target['properties'] as JsonObject)[discriminator];
  if (!isPlainObject(field as Json)) return null;
  const value = (field as JsonObject)['const'];
  return typeof value === 'string' ? value : null;
}

const PYTHON_PREAMBLE = `"""ForgeBridge wire models, generated from the Zod contract.

DO NOT EDIT. Regenerate with \`npm run generate:schemas\` from the repository root;
\`npm run verify:schemas\` fails CI when this file and the schemas disagree.

Source of truth: packages/protocol/src/*.ts
Generator:       ${GENERATOR_ID}

Every field name is the name on the wire. Where a wire name collides with a Python
keyword the attribute gains a trailing underscore and keeps the wire name as its
alias, so \`model_dump(by_alias=True)\` still produces the protocol's spelling.

Two things these models deliberately do not enforce; see
packages/protocol/schema/README.md for the full list:

* a ChangeSet's cross-operation ordering rule, which needs
  \`forgebridge.checks.check_changeset_ordering\`
* the UTF-8 *byte* bound on a script source, which is a UTF-16 code-unit bound here
"""

from typing import Annotated, Any, ClassVar, Literal

from annotated_types import Ge, Gt, Le, Len, Lt
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.functional_serializers import model_serializer

__all__ = ["ALL_MODELS"]


def _reject(forbidden: tuple[str, ...]):
    """Project a JSON Schema \`not: {enum: [...]}\` onto a string field."""

    def check(value: str) -> str:
        if value in forbidden:
            raise ValueError(f"{value!r} is not permitted here")
        return value

    return check


class _Model(BaseModel):
    # \`extra="ignore"\` mirrors Zod's default object mode, which strips unknown keys
    # rather than refusing them. A stricter setting here would refuse the
    # forward-compatible extra field the protocol's additive versioning promises.
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    _omit_if_none: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_absent_optionals(self, handler):
        data = handler(self)
        for name in type(self)._omit_if_none:
            if name in data and data[name] is None:
                del data[name]
        return data

`;

function pythonModels(components: Readonly<Record<string, JsonObject>>): string {
  const ctx: PyCtx = { components, blocks: [], done: new Set(), building: new Set() };
  for (const name of Object.keys(components)) ensureComponent(name, ctx);

  const exported = Object.keys(components);
  const registry = `\n\n#: Every wire type this module projects, by its protocol name.\nALL_MODELS: dict[str, Any] = {\n${exported
    .map((name) => `    ${JSON.stringify(name)}: ${name},`)
    .join('\n')}\n}\n`;

  return `${PYTHON_PREAMBLE}\n${ctx.blocks.join('\n')}${registry}`;
}

// ─────────────────────────────── OpenAPI 3.1 ───────────────────────────────

function schemaRef(schema: string | JsonObject): JsonObject {
  return typeof schema === 'string' ? { $ref: `#/components/schemas/${schema}` } : schema;
}

function buildOpenApi(
  components: Readonly<Record<string, JsonObject>>,
  headers: Record<string, string>,
  discrepancies: readonly string[],
  defaultPort: string,
): JsonObject {
  const paths: JsonObject = {};

  for (const route of ROUTES) {
    const item = (paths[route.path] as JsonObject | undefined) ?? {};
    const responses: JsonObject = {};
    for (const response of route.responses) {
      responses[String(response.status)] = response.schema === undefined
        ? { description: response.description }
        : {
            description: response.description,
            content: {
              [response.contentType ?? 'application/json']: { schema: schemaRef(response.schema) },
            },
          };
    }

    const operation: JsonObject = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      responses,
    };
    if (route.parameters && route.parameters.length > 0) {
      operation['parameters'] = route.parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: parameter.required,
        description: parameter.description,
        schema: parameter.schema,
      })) as unknown as Json;
    }
    if (route.requestBody) {
      operation['requestBody'] = {
        required: true,
        description: route.requestBody.description,
        content: { 'application/json': { schema: schemaRef(route.requestBody.schema) } },
      };
    }
    operation['security'] =
      route.auth === 'producer'
        ? [{ producerToken: [] }]
        : route.auth === 'consumer'
          ? [{ linkId: [], linkMac: [] }]
          : [];
    if (route.undocumentedInProtocolMd) {
      operation['x-forgebridge-undocumented'] = route.undocumentedInProtocolMd;
    }

    item[route.method] = operation;
    paths[route.path] = item;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ForgeBridge /v1',
      version: protocol.PROTOCOL_VERSION,
      license: { name: 'MIT', identifier: 'MIT' },
      summary: 'The ForgeBridge wire surface, projected from the Zod contract.',
      description: [
        'Generated by `' + GENERATOR_ID + '` from `packages/protocol/src/*.ts` and the route',
        'table in `packages/daemon/src/server.ts`. Do not edit by hand.',
        '',
        'Proposing a ChangeSet and approving one are separate operations, and no route',
        'exists that does both (ADR-012). A producer that could approve its own submission',
        'would be a model approving its own work, which is the single invariant a connector',
        'or a generated client must not smooth over for convenience.',
        '',
        'Served today by `packages/daemon` on loopback only. `apps/relay` (M17) does not',
        'exist yet and must serve this document identically when it does.',
        discrepancies.length === 0
          ? 'This document and the endpoint table in `docs/PROTOCOL.md` agree.'
          : `Known documentation discrepancies: ${discrepancies.join('; ')}.`,
      ].join('\n'),
    },
    servers: [
      {
        url: 'http://127.0.0.1:{port}/',
        description:
          'The local daemon. Loopback only, and it refuses any request whose Host header is ' +
          'not a loopback address.',
        variables: { port: { default: defaultPort } },
      },
    ],
    tags: [
      { name: 'link', description: 'Pairing and delivery. Consumer surface.' },
      { name: 'changesets', description: 'Propose, review, approve. Producer surface.' },
      { name: 'operations', description: 'Health and registry.' },
    ],
    paths,
    components: {
      securitySchemes: {
        producerToken: {
          type: 'apiKey',
          in: 'header',
          name: headers['producerToken'] as string,
          description:
            'The per-process producer token. Loopback is not an authentication boundary: any ' +
            'process on the machine, and any page the user has open, can reach these routes.',
        },
        linkId: {
          type: 'apiKey',
          in: 'header',
          name: headers['link'] as string,
          description: 'Which paired link is calling.',
        },
        linkMac: {
          type: 'apiKey',
          in: 'header',
          name: headers['mac'] as string,
          description:
            'Base64 MAC over the canonical request under the session key derived at pairing. ' +
            'Sent with the link header, never instead of it.',
        },
      },
      schemas: components as unknown as Json,
    },
  };
}

// ──────────────────────────── generated README ────────────────────────────

/** Hard-wrap a paragraph so the generated markdown reads like the hand-written kind. */
function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length > width && current !== '') {
      lines.push(current);
      current = indent + word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines.join('\n');
}

function schemaReadme(names: readonly string[], discrepancies: readonly string[]): string {
  const losses = Object.entries(REFINEMENTS)
    .filter(([, refinement]) => refinement.lost)
    .map(([location, refinement]) => wrap(`- **\`${location}\`** — ${refinement.lost as string}`, 92, '  '));

  return [
    '# Generated schemas',
    '',
    'DO NOT EDIT ANYTHING IN THIS DIRECTORY. Every file here is written by',
    `\`${GENERATOR_ID}\` from \`packages/protocol/src/*.ts\`. Regenerate with`,
    '`npm run generate:schemas`; `npm run verify:schemas` regenerates into memory and fails',
    'on any difference, so an edit to a Zod schema that was never projected is caught before',
    'it merges.',
    '',
    'Editing a file here does not change the protocol. It changes a copy of the protocol,',
    'which is strictly worse than having no copy at all.',
    '',
    '## What is here',
    '',
    `- \`<Name>.schema.json\` — one self-contained JSON Schema (draft 2020-12) for each of the ${names.length}`,
    '  top-level types `@forgebridge/protocol` exports. Each file inlines the definitions it',
    '  references under `$defs`, so a consumer needs exactly one file and no resolver.',
    '- `openapi.json` — one OpenAPI 3.1 document for the `/v1` surface. Its paths are read off',
    '  `packages/daemon/src/server.ts`, which is the implementation, not off the endpoint table',
    '  in `docs/PROTOCOL.md`. Where the two disagree the code wins and the generator says so.',
    '  Its `servers` entry is built the same way: the `port` variable\'s default is that file\'s',
    '  exported `DEFAULT_DAEMON_PORT`, imported rather than transcribed, because a URL nobody',
    '  answers on is a worse lie than a missing one.',
    '',
    '## What does NOT survive the projection',
    '',
    'A Zod `.superRefine()` is arbitrary TypeScript. Some of it has no JSON Schema equivalent,',
    'and the honest response is to name each one rather than let a consumer assume that a',
    'schema-valid document is a protocol-valid document:',
    '',
    ...(losses.length > 0 ? losses : ['- Nothing. Every refinement in the contract is projected.']),
    '',
    'Everything else *is* projected, and is checked rather than asserted: each restated',
    'constraint carries probe values that are run through the real Zod schema and through the',
    'emitted JSON Schema, and generation fails if the two ever disagree.',
    '',
    '## Consumers',
    '',
    '- TypeScript — do not use these files. Import `@forgebridge/protocol` and get the Zod',
    '  schemas themselves; anything else is a copy that can drift.',
    '- Python — `packages/sdk-python` (M08) generates its pydantic v2 models from `openapi.json`',
    '  by the same run of the same generator, so the two cannot disagree.',
    '- Anything else — read `<Name>.schema.json`, and re-implement the unprojected constraints',
    '  listed above yourself.',
    '',
    ...(discrepancies.length === 0
      ? ['The endpoint table in `docs/PROTOCOL.md` and the daemon\'s router currently agree.']
      : ['Open discrepancies between `docs/PROTOCOL.md` and the router:', '', ...discrepancies.map((d) => `- ${d}`)]),
    '',
  ].join('\n');
}

// ──────────────────────────────── the build ────────────────────────────────

export interface Artifacts {
  /** Repository-relative path → exact file contents. */
  readonly files: ReadonlyMap<string, string>;
  /** Directories this generator owns entirely; a stray file in one is drift. */
  readonly ownedDirectories: readonly string[];
  readonly discrepancies: readonly string[];
}

/**
 * Produce every generated artefact in memory.
 *
 * The daemon's modules are imported dynamically rather than at the top of this
 * file for one reason: they resolve `@forgebridge/protocol` — and, in
 * `server.ts`'s case, `@forgebridge/core` and `@forgebridge/luau-analysis` —
 * through the workspace symlinks, which need those packages' `dist`. Keeping the
 * imports inside this function lets the gate's own test suite import `validate`,
 * `deepEqual` and `daemonDefaultPort` from here without a build, which is what
 * the repository-gates CI job does. That is also why the gate self-test that
 * pins the emitted server URL to `DEFAULT_DAEMON_PORT` reads the daemon's
 * *source* rather than importing it: it has to be able to run in that job, and
 * an auditor that reads the value by a different route than the generator is
 * the only kind whose agreement means anything.
 */
export async function buildArtifacts(): Promise<Artifacts> {
  const built = (await import('@forgebridge/protocol')) as unknown as Record<string, unknown>;
  const wire = (await import('../packages/daemon/src/wire.js')) as unknown as Record<string, unknown>;
  const server = (await import('../packages/daemon/src/server.js')) as unknown as Record<string, unknown>;

  const source = namedSchemas(protocol as unknown as Record<string, unknown>);
  const compiled = namedSchemas(built);
  for (const name of source.keys()) {
    if (!compiled.has(name)) {
      fail(
        `packages/protocol exports "${name}" from src but not from dist. Run \`npm run build\` — ` +
          `this generator reads the daemon's wire module, which resolves the built package.`,
      );
    }
  }

  const bundle = project(source, '#/$defs/');
  const unused = Object.keys(REFINEMENTS).filter((key) => !bundle.used.has(key));
  if (unused.length > 0) {
    fail(`REFINEMENTS has entries no schema reaches: ${unused.join(', ')}. A stale entry hides a real one.`);
  }

  const probeFailures = runProbes(source, bundle.defs);
  if (probeFailures.length > 0) {
    fail(`the projection disagrees with the Zod contract:\n  - ${probeFailures.join('\n  - ')}`);
  }

  const serverSource = readFileSync(path.join(REPO_ROOT, SERVER_SOURCE), 'utf8');
  const authSource = readFileSync(path.join(REPO_ROOT, 'packages/daemon/src/auth.ts'), 'utf8');
  const protocolDoc = readFileSync(path.join(REPO_ROOT, 'docs/PROTOCOL.md'), 'utf8');
  const discrepancies = checkRouteTable(serverSource, protocolDoc);
  const headers = extractHeaderNames(serverSource, authSource);

  const files = new Map<string, string>();
  const names = [...bundle.defs.keys()].sort();

  for (const name of names) {
    const dependencies = [...transitiveRefs(name, bundle.defs)].sort();
    const document: JsonObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${name}.schema.json`,
      title: name,
      $comment: `Generated from packages/protocol/src by ${GENERATOR_ID}. Do not edit.`,
      ...(bundle.defs.get(name) as JsonObject),
    };
    if (dependencies.length > 0) {
      document['$defs'] = Object.fromEntries(
        dependencies.map((dependency) => [dependency, bundle.defs.get(dependency) as Json]),
      );
    }
    files.set(`${SCHEMA_DIR}/${name}.schema.json`, stableJson(document));
  }

  // One projection for the OpenAPI document, whose refs live under
  // `#/components/schemas`. The daemon's wire schemas embed protocol schemas
  // loaded from `dist`; registering both object identities under one name is
  // what makes those come out as references to the definitions above rather
  // than as inlined duplicates.
  const openApiNames = new Map<string, ZodLike>([...source, ...wireOnly(wire, source, compiled)]);
  const aliasing = new Map<ZodLike, string>();
  for (const [name, schema] of openApiNames) aliasing.set(schema, name);
  for (const [name, schema] of compiled) if (!aliasing.has(schema)) aliasing.set(schema, name);
  const openApiCtx: Ctx = {
    names: aliasing,
    defs: new Map(),
    refPrefix: '#/components/schemas/',
    usedRefinements: new Set(),
    inFlight: new Set(),
  };
  for (const [name, schema] of openApiNames) {
    if (openApiCtx.defs.has(name)) continue;
    openApiCtx.inFlight.add(name);
    openApiCtx.defs.set(name, convert(schema, name, openApiCtx, true));
    openApiCtx.inFlight.delete(name);
  }

  const components: Record<string, JsonObject> = {};
  for (const name of [...openApiCtx.defs.keys(), ...Object.keys(HANDLER_SHAPED_SCHEMAS)].sort()) {
    components[name] = (HANDLER_SHAPED_SCHEMAS[name] ?? openApiCtx.defs.get(name)) as JsonObject;
  }

  files.set(
    `${SCHEMA_DIR}/openapi.json`,
    stableJson(buildOpenApi(components, headers, discrepancies, daemonDefaultPort(server))),
  );
  files.set(`${SCHEMA_DIR}/README.md`, schemaReadme(names, discrepancies));
  files.set(PYTHON_MODELS, pythonModels(components));

  return { files, ownedDirectories: [SCHEMA_DIR], discrepancies };
}

/** Wire schemas that are not simply a re-export of a protocol schema. */
function wireOnly(
  wire: Record<string, unknown>,
  source: Map<string, ZodLike>,
  compiled: Map<string, ZodLike>,
): Map<string, ZodLike> {
  const out = new Map<string, ZodLike>();
  for (const [name, schema] of namedSchemas(wire)) {
    if (source.has(name) || [...compiled.values()].includes(schema)) continue;
    out.set(name, schema);
  }
  return out;
}

// ────────────────────────────────── the gate ──────────────────────────────────

/**
 * Regenerate into memory and report every file that differs from the tree.
 *
 * The name is the one `docs/MILESTONES.md` promises on the M08 row.
 */
export async function verifyNoDrift(): Promise<string[]> {
  const artefacts = await buildArtifacts();
  const drifted: string[] = [];

  for (const [rel, expected] of artefacts.files) {
    const absolute = path.join(REPO_ROOT, rel);
    if (!existsSync(absolute)) {
      drifted.push(`${rel} — missing; the generator produces it`);
      continue;
    }
    if (readFileSync(absolute, 'utf8') !== expected) {
      drifted.push(`${rel} — differs from what the schemas project`);
    }
  }

  // A file nobody generates any more, left behind by a renamed type, is drift in
  // the other direction: a consumer would keep reading a schema that no longer
  // has a Zod counterpart.
  for (const directory of artefacts.ownedDirectories) {
    const absolute = path.join(REPO_ROOT, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute)) {
      const rel = `${directory}/${entry}`;
      if (!artefacts.files.has(rel)) drifted.push(`${rel} — no longer generated; delete it`);
    }
  }

  return drifted;
}

async function write(): Promise<Artifacts> {
  const artefacts = await buildArtifacts();

  for (const directory of artefacts.ownedDirectories) {
    const absolute = path.join(REPO_ROOT, directory);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (!artefacts.files.has(`${directory}/${entry}`)) {
          rmSync(path.join(absolute, entry), { recursive: true, force: true });
        }
      }
    }
  }

  for (const [rel, contents] of artefacts.files) {
    const absolute = path.join(REPO_ROOT, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }

  return artefacts;
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');

  try {
    if (check) {
      const drifted = await verifyNoDrift();
      if (drifted.length === 0) {
        console.log('schemas: the JSON Schema, OpenAPI and Python projections match the Zod contract.');
        return 0;
      }
      console.error('The generated projections are stale:\n');
      for (const entry of drifted) console.error(`  ${entry}`);
      console.error('\nRun `npm run generate:schemas` and commit the result.');
      return 1;
    }

    const artefacts = await write();
    console.log(`schemas: wrote ${artefacts.files.size} files.`);
    for (const discrepancy of artefacts.discrepancies) {
      console.warn(`  docs/PROTOCOL.md: ${discrepancy}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ProjectionError) {
      console.error(`schemas: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
