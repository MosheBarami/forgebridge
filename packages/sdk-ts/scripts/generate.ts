/**
 * Project the `/v1` surface into the two files this SDK is built on.
 *
 * `scripts/generate-schemas.ts` at the repository root already emits an OpenAPI
 * 3.1 document for `/v1`, checked against the daemon's own router on every
 * generation. This file reads that document and writes:
 *
 *   src/generated/wire.ts     one Zod schema per component, and the registry
 *                             the client looks a schema up in
 *   src/generated/routes.ts   the route table: method, path template, auth,
 *                             parameters, request body, per-status responses
 *
 * Both are committed, and `--check` regenerates them in memory and fails on any
 * difference. `test/generated.test.ts` runs that check, so an edit to the
 * protocol that was never projected here fails in this package rather than
 * reaching a user as a client that describes a surface the daemon does not
 * serve.
 *
 * ── Why some components are not projected at all ─────────────────────────────
 *
 * A component whose name `@forgebridge/protocol` already exports as a Zod schema
 * is **bound to that export**, not re-derived from its JSON Schema. The two
 * would agree today — the JSON Schema was projected from that very export — and
 * agreeing today is not the property worth having. A projection can only lose
 * constraints (`packages/protocol/schema/README.md` lists the ones it loses),
 * so a second Zod built from the lossy side would be a validator quietly weaker
 * than the contract, in a package whose whole job is to hold callers to it.
 * Binding makes that class of drift unrepresentable rather than tested for.
 *
 * What is left to project is exactly the daemon's own request and response
 * shapes — `packages/daemon/src/wire.ts` — which a client package must not
 * import, because importing them would make every consumer of this SDK depend
 * on a server. The OpenAPI document is the only place those shapes exist in a
 * form a client can read.
 *
 * ── Three rules, the same three the root generator states ────────────────────
 *
 * 1. A keyword this file has never heard of is an ERROR, not a silent drop. A
 *    projection that quietly loses a constraint is worse than no projection,
 *    because a caller trusts it. `KNOWN_KEYWORDS` is the whole vocabulary and
 *    anything outside it aborts, naming the component and the location.
 * 2. A `$ref` that does not resolve to a component aborts. The document does
 *    contain one such ref — `PropertyBag.propertyNames` points at `#/$defs/…`,
 *    which is meaningful in the per-type JSON Schema files and dangling here —
 *    and it is inside a bound component, so it is never walked. If it ever
 *    moves into a projected one, this stops rather than emitting a record whose
 *    keys are unchecked.
 * 3. `format` is documentation, and `pattern` is the constraint. The document
 *    carries both for uuids and timestamps; emitting `z.string().uuid()` would
 *    make this client stricter than the document it is generated from, and a
 *    client that refuses a value the server may legally send is a client that
 *    invents an error the server never made.
 *
 * Run:  npm run generate --workspace @forgebridge/sdk-ts
 * Check: npm run verify:generated --workspace @forgebridge/sdk-ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as protocol from '@forgebridge/protocol';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export interface JsonObject {
  [key: string]: Json;
}

/** Thrown by every refusal below, so a self-test can tell a refusal from a crash. */
export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationError';
  }
}

function fail(message: string): never {
  throw new GenerationError(message);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: Json | undefined, where: string): JsonObject {
  if (!isObject(value)) fail(`${where}: expected an object, found ${JSON.stringify(value)}`);
  return value;
}

const GENERATOR_ID = 'packages/sdk-ts/scripts/generate.ts';
const SOURCE_DOCUMENT = 'packages/protocol/schema/openapi.json';

// ────────────────────────────── JSON Schema → Zod ──────────────────────────────

/**
 * Every keyword this file knows how to project.
 *
 * `description` and `title` are listed because they carry no constraint and are
 * deliberately dropped; everything else changes what a value may be. A keyword
 * outside this set means the root generator learned to emit something this one
 * cannot read, and the honest answer to that is to stop.
 */
export const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'additionalProperties',
  'anyOf',
  'const',
  'default',
  'description',
  'discriminator',
  'enum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
]);

export interface EmitContext {
  /** Every component in the document, by name. */
  readonly components: Readonly<Record<string, JsonObject>>;
  /** Component names bound to a `@forgebridge/protocol` export instead of projected. */
  readonly bound: ReadonlySet<string>;
  /** Names already emitted, in emission order. */
  readonly order: string[];
  /** Names currently being emitted — the cycle detector. */
  readonly active: Set<string>;
  /** `name -> the const's right-hand side`, for the names that are projected. */
  readonly blocks: Map<string, string>;
}

const REF_PREFIX = '#/components/schemas/';

export function componentOfRef(ref: string, where: string): string {
  if (!ref.startsWith(REF_PREFIX)) {
    fail(
      `${where}: $ref "${ref}" does not point into #/components/schemas. ` +
        'A reference this generator cannot resolve is a constraint it would have to drop.',
    );
  }
  return ref.slice(REF_PREFIX.length);
}

/**
 * Emit `name`, and everything it references, in dependency order.
 *
 * A bound name emits nothing and is simply referred to: it is imported from
 * `@forgebridge/protocol` at the top of the file.
 */
export function ensureComponent(name: string, ctx: EmitContext): void {
  if (ctx.bound.has(name)) return;
  if (ctx.blocks.has(name)) return;
  if (ctx.active.has(name)) {
    fail(
      `component "${name}" is part of a reference cycle (${[...ctx.active, name].join(' → ')}). ` +
        'Zod needs a lazy schema for that, and a lazy schema written by guesswork is not a projection.',
    );
  }
  const schema = ctx.components[name];
  if (schema === undefined) {
    fail(`$ref names component "${name}", which the document does not define`);
  }

  ctx.active.add(name);
  const expression = expressionFor(schema, ctx, `components.${name}`, 0);
  ctx.active.delete(name);

  ctx.blocks.set(name, expression);
  ctx.order.push(name);
}

const INDENT = '  ';

function pad(depth: number): string {
  return INDENT.repeat(depth);
}

/** A JSON value as a TypeScript literal. Only used for `const` and `default`. */
function literal(value: Json): string {
  return JSON.stringify(value);
}

/**
 * The Zod expression for one JSON Schema node.
 *
 * `depth` is only formatting: object bodies are broken across lines so a
 * reviewer can read the generated file, and everything else stays inline.
 */
export function expressionFor(schema: JsonObject, ctx: EmitContext, where: string, depth: number): string {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      fail(
        `${where}: JSON Schema keyword "${keyword}" is not one this generator projects. ` +
          'Teach it the keyword, or stop emitting the keyword — dropping it silently would ' +
          'produce a schema that accepts more than the contract does.',
      );
    }
  }

  const withDefault = (expression: string): string =>
    'default' in schema ? `${expression}.default(${literal(schema['default'] as Json)})` : expression;

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = componentOfRef(ref, where);
    ensureComponent(name, ctx);
    return withDefault(name);
  }

  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const options = oneOf.map((option, index) =>
      expressionFor(asObject(option, `${where}.oneOf[${index}]`), ctx, `${where}.oneOf[${index}]`, depth + 1),
    );
    if (options.length < 2) fail(`${where}: oneOf with ${options.length} option(s) is not a union`);
    const discriminator = schema['discriminator'];
    if (isObject(discriminator)) {
      const property = discriminator['propertyName'];
      if (typeof property !== 'string') fail(`${where}: discriminator without a propertyName`);
      return withDefault(`z.discriminatedUnion(${literal(property)}, [${options.join(', ')}])`);
    }
    return withDefault(`z.union([${options.join(', ')}])`);
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const parts = anyOf.map((option, index) => asObject(option, `${where}.anyOf[${index}]`));
    const nulls = parts.filter((part) => part['type'] === 'null');
    const rest = parts.filter((part) => part['type'] !== 'null');
    const expressions = rest.map((part, index) =>
      expressionFor(part, ctx, `${where}.anyOf[${index}]`, depth + 1),
    );
    if (expressions.length === 0) fail(`${where}: anyOf of nothing but null`);
    const base =
      expressions.length === 1 ? (expressions[0] as string) : `z.union([${expressions.join(', ')}])`;
    return withDefault(nulls.length > 0 ? `${base}.nullable()` : base);
  }

  if ('const' in schema) {
    return withDefault(`z.literal(${literal(schema['const'] as Json)})`);
  }

  const enumeration = schema['enum'];
  if (Array.isArray(enumeration)) {
    if (enumeration.length === 0) fail(`${where}: an empty enum accepts nothing and says so nowhere`);
    if (enumeration.every((member) => typeof member === 'string')) {
      return withDefault(`z.enum([${enumeration.map((member) => literal(member)).join(', ')}])`);
    }
    return withDefault(
      `z.union([${enumeration.map((member) => `z.literal(${literal(member)})`).join(', ')}])`,
    );
  }

  const type = schema['type'];

  if (Array.isArray(type)) {
    const named = type.filter((member) => member !== 'null');
    if (type.length !== named.length + 1 || named.length !== 1) {
      fail(
        `${where}: type ${JSON.stringify(type)} is a union of types this generator does not project. ` +
          'Only "<something> or null" is understood.',
      );
    }
    const inner = expressionFor({ ...schema, type: named[0] as Json }, ctx, where, depth);
    // `default` is applied by the inner call; re-applying it here would emit it twice.
    return `${inner}.nullable()`;
  }

  if (typeof type !== 'string') {
    // A schema with no `type` and none of the combinators above constrains
    // nothing. `previous: {}` on a restoreProperty inverse is exactly this.
    return withDefault('z.unknown()');
  }

  switch (type) {
    case 'object':
      return withDefault(objectExpression(schema, ctx, where, depth));
    case 'array': {
      const items = schema['items'];
      const inner = isObject(items) ? expressionFor(items, ctx, `${where}.items`, depth + 1) : 'z.unknown()';
      let expression = `z.array(${inner})`;
      if (typeof schema['minItems'] === 'number') expression += `.min(${schema['minItems']})`;
      if (typeof schema['maxItems'] === 'number') expression += `.max(${schema['maxItems']})`;
      return withDefault(expression);
    }
    case 'string': {
      let expression = 'z.string()';
      if (typeof schema['minLength'] === 'number') expression += `.min(${schema['minLength']})`;
      if (typeof schema['maxLength'] === 'number') expression += `.max(${schema['maxLength']})`;
      if (typeof schema['pattern'] === 'string') {
        expression += `.regex(new RegExp(${literal(schema['pattern'])}))`;
      }
      return withDefault(expression);
    }
    case 'integer':
    case 'number': {
      let expression = type === 'integer' ? 'z.number().int()' : 'z.number()';
      if (typeof schema['minimum'] === 'number') expression += `.min(${schema['minimum']})`;
      if (typeof schema['maximum'] === 'number') expression += `.max(${schema['maximum']})`;
      return withDefault(expression);
    }
    case 'boolean':
      return withDefault('z.boolean()');
    case 'null':
      return withDefault('z.null()');
    default:
      fail(`${where}: JSON Schema type "${type}" is not one this generator projects`);
  }
}

/**
 * An object node.
 *
 * `additionalProperties` decides the tail. Absent or `true` becomes
 * `.passthrough()` rather than Zod's default strip, and that is a decision
 * rather than a convenience: the protocol is additive, so a field a newer daemon
 * sends must survive a round trip through an older client instead of being
 * silently deleted by it.
 */
function objectExpression(schema: JsonObject, ctx: EmitContext, where: string, depth: number): string {
  const properties = schema['properties'];
  const additional = schema['additionalProperties'];

  if (!isObject(properties)) {
    // A bag: no declared keys, so the value schema is the whole contract.
    if (additional === false) fail(`${where}: an object with no properties and no additionalProperties is empty`);
    const inner =
      additional === undefined || additional === true
        ? 'z.unknown()'
        : expressionFor(asObject(additional, `${where}.additionalProperties`), ctx, `${where}.additionalProperties`, depth + 1);
    return `z.record(z.string(), ${inner})`;
  }

  const required = new Set(
    Array.isArray(schema['required']) ? schema['required'].filter((name): name is string => typeof name === 'string') : [],
  );
  for (const name of required) {
    if (!(name in properties)) fail(`${where}: "${name}" is required and is not a declared property`);
  }

  const lines = Object.entries(properties).map(([key, sub]) => {
    const node = asObject(sub, `${where}.properties.${key}`);
    const expression = expressionFor(node, ctx, `${where}.properties.${key}`, depth + 1);
    // A property that is not required and carries a default is already optional
    // on input and present on output — that is what `z.default()` means. Adding
    // `.optional()` on top of it would produce `ZodOptional<ZodDefault<…>>`,
    // which passes `undefined` straight through and never applies the default:
    // the field would be absent from a parsed value that the daemon's own schema
    // fills in, so the client and the server would disagree about a value
    // neither of them ever sent.
    const suffix = required.has(key) || 'default' in node ? '' : '.optional()';
    return `${pad(depth + 1)}${literal(key)}: ${expression}${suffix},`;
  });

  const body = lines.length === 0 ? 'z.object({})' : `z.object({\n${lines.join('\n')}\n${pad(depth)}})`;

  if (additional === false) return `${body}.strict()`;
  if (additional === undefined || additional === true) return `${body}.passthrough()`;
  const inner = expressionFor(asObject(additional, `${where}.additionalProperties`), ctx, `${where}.additionalProperties`, depth + 1);
  return `${body}.catchall(${inner})`;
}

// ─────────────────────────────── the route table ───────────────────────────────

export type Auth = 'producer' | 'consumer' | 'none';

export interface RouteParameter {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
}

export interface RouteResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** A component name, or null when the body is empty or is not a named schema. */
  readonly schema: string | null;
  readonly description: string;
}

export interface RouteDescription {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly auth: Auth;
  readonly parameters: readonly RouteParameter[];
  readonly requestBody: string | null;
  readonly responses: readonly RouteResponse[];
  /** The single 2xx JSON body this route answers with, or null when it has none. */
  readonly successSchema: string | null;
  readonly successStatus: number | null;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function authOf(security: Json | undefined, where: string): Auth {
  if (!Array.isArray(security)) fail(`${where}: no security declared. An unstated auth requirement is one a client will get wrong.`);
  if (security.length === 0) return 'none';
  if (security.length !== 1) fail(`${where}: ${security.length} security alternatives; this client understands one`);
  const scheme = asObject(security[0], `${where}.security[0]`);
  const names = Object.keys(scheme).sort().join('+');
  if (names === 'producerToken') return 'producer';
  if (names === 'linkId+linkMac') return 'consumer';
  fail(`${where}: security requirement "${names}" is not one this client knows how to satisfy`);
}

export function collectRoutes(document: JsonObject): RouteDescription[] {
  const paths = asObject(document['paths'], 'paths');
  const routes: RouteDescription[] = [];

  for (const [templatePath, item] of Object.entries(paths)) {
    const operations = asObject(item, `paths.${templatePath}`);
    for (const method of METHODS) {
      const operation = operations[method];
      if (operation === undefined) continue;
      const where = `paths.${templatePath}.${method}`;
      const op = asObject(operation, where);

      const operationId = op['operationId'];
      if (typeof operationId !== 'string') fail(`${where}: no operationId. The client keys its route table on it.`);

      const parameters: RouteParameter[] = [];
      const declared = op['parameters'];
      if (declared !== undefined) {
        if (!Array.isArray(declared)) fail(`${where}.parameters: expected an array`);
        for (const [index, raw] of declared.entries()) {
          const parameter = asObject(raw, `${where}.parameters[${index}]`);
          const location = parameter['in'];
          if (location !== 'path' && location !== 'query') {
            fail(`${where}.parameters[${index}]: parameters in "${String(location)}" are not projected`);
          }
          const name = parameter['name'];
          if (typeof name !== 'string') fail(`${where}.parameters[${index}]: no name`);
          parameters.push({ name, in: location, required: parameter['required'] === true });
        }
      }

      let requestBody: string | null = null;
      const body = op['requestBody'];
      if (body !== undefined) {
        const content = asObject(asObject(body, `${where}.requestBody`)['content'], `${where}.requestBody.content`);
        const json = content['application/json'];
        if (!isObject(json)) fail(`${where}.requestBody: this client sends application/json and the route takes something else`);
        const schema = asObject(json['schema'], `${where}.requestBody.content.application/json.schema`);
        const ref = schema['$ref'];
        if (typeof ref !== 'string') {
          fail(`${where}.requestBody: an inline request schema has no name for the client to look up`);
        }
        requestBody = componentOfRef(ref, `${where}.requestBody`);
      }

      const responses: RouteResponse[] = [];
      const declaredResponses = asObject(op['responses'], `${where}.responses`);
      for (const [status, raw] of Object.entries(declaredResponses)) {
        const code = Number(status);
        if (!Number.isInteger(code)) fail(`${where}.responses: "${status}" is not a status code`);
        const response = asObject(raw, `${where}.responses.${status}`);
        const description = typeof response['description'] === 'string' ? response['description'] : '';
        const content = response['content'];
        if (content === undefined) {
          responses.push({ status: code, contentType: null, schema: null, description });
          continue;
        }
        const entries = Object.entries(asObject(content, `${where}.responses.${status}.content`));
        if (entries.length !== 1) fail(`${where}.responses.${status}: ${entries.length} content types`);
        const [contentType, media] = entries[0] as [string, Json];
        const schema = asObject(media, `${where}.responses.${status}.content.${contentType}`)['schema'];
        const ref = isObject(schema) ? schema['$ref'] : undefined;
        if (typeof ref !== 'string' && contentType === 'application/json') {
          // Fail closed. Recording this as `schema: null` would make an inline
          // JSON body indistinguishable from a response with no body at all —
          // and the client reads that as "this route answers with nothing",
          // which is the shape of a check that finds no pattern it recognises
          // and reports success.
          fail(
            `${where}.responses.${status}: an inline application/json body has no name for the client to look up. ` +
              'Give it a component, or this client cannot say what it just parsed.',
          );
        }
        responses.push({
          status: code,
          contentType,
          schema: typeof ref === 'string' ? componentOfRef(ref, `${where}.responses.${status}`) : null,
          description,
        });
      }
      responses.sort((a, b) => a.status - b.status);

      const jsonSuccesses = responses.filter(
        (response) => response.status >= 200 && response.status < 300 && response.contentType === 'application/json',
      );
      const distinct = new Set(jsonSuccesses.map((response) => response.schema));
      if (distinct.size > 1) {
        fail(`${where}: ${distinct.size} different 2xx JSON bodies; a client cannot know which one it is holding`);
      }
      const success = jsonSuccesses[0] ?? null;

      routes.push({
        method,
        path: templatePath,
        operationId,
        summary: typeof op['summary'] === 'string' ? op['summary'] : '',
        auth: authOf(op['security'], where),
        parameters,
        requestBody,
        responses,
        successSchema: success?.schema ?? null,
        successStatus: success?.status ?? null,
      });
    }
  }

  routes.sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  return routes;
}

// ──────────────────────────────── file emission ────────────────────────────────

function banner(what: string): string {
  return [
    '/**',
    ` * ${what}`,
    ' *',
    ` * GENERATED by \`${GENERATOR_ID}\` from \`${SOURCE_DOCUMENT}\`.`,
    ' * Do not edit by hand: `npm run generate --workspace @forgebridge/sdk-ts` rewrites this',
    ' * file, and `test/generated.test.ts` fails on any difference between it and the document.',
    ' */',
  ].join('\n');
}

export interface Generated {
  readonly wire: string;
  readonly routes: string;
}

export function generate(document: JsonObject, bound: ReadonlySet<string>): Generated {
  const components = asObject(asObject(document['components'], 'components')['schemas'], 'components.schemas');
  const typed: Record<string, JsonObject> = {};
  for (const [name, schema] of Object.entries(components)) {
    typed[name] = asObject(schema, `components.schemas.${name}`);
  }

  const routes = collectRoutes(document);
  const ctx: EmitContext = { components: typed, bound, order: [], active: new Set(), blocks: new Map() };

  // Emit in the document's own order so the file is stable, and let each name
  // pull its dependencies in ahead of it.
  for (const name of Object.keys(typed)) ensureComponent(name, ctx);

  /** Names used as a request body, which callers construct and therefore want the input type of. */
  const requestBodies = new Set(routes.map((route) => route.requestBody).filter((name): name is string => name !== null));

  const boundNames = Object.keys(typed).filter((name) => bound.has(name)).sort();
  const unknownBound = [...bound].filter((name) => !(name in typed));
  if (unknownBound.length > 0) {
    fail(
      `@forgebridge/protocol exports schemas named ${unknownBound.join(', ')} that the OpenAPI document does not ` +
        'define. Binding a name the document never mentions would put a schema in the registry that no route uses.',
    );
  }

  const wireLines: string[] = [
    banner('The `/v1` wire schemas: one Zod schema per OpenAPI component.'),
    '',
    "import { z } from 'zod';",
    "import * as protocol from '@forgebridge/protocol';",
    '',
    '/**',
    ' * Components bound to `@forgebridge/protocol` rather than projected.',
    ' *',
    ' * These names are the contract itself. Their JSON Schema was projected FROM the Zod',
    ' * below, and a projection can only lose constraints — so re-deriving Zod from the lossy',
    ' * side would give this SDK a validator quietly weaker than the protocol it enforces.',
    ' * `tsc` fails here if the protocol package stops exporting one of them.',
    ' */',
    ...boundNames.flatMap((name) => [
      `export const ${name} = protocol.${name};`,
      `export type ${name} = z.infer<typeof ${name}>;`,
      ...(requestBodies.has(name)
        ? [
            '/** What a caller passes in: the fields the schema defaults are optional here. */',
            `export type ${name}Input = z.input<typeof ${name}>;`,
          ]
        : []),
    ]),
    '',
    '/**',
    ' * Components projected from the document.',
    ' *',
    " * These are the daemon's own request and response shapes. They live in",
    ' * `packages/daemon/src/wire.ts`, which a client package must not import — importing it',
    ' * would make everything that embeds this SDK depend on a server — so the OpenAPI',
    ' * document is the only form of them a client can read.',
    ' */',
  ];

  for (const name of ctx.order) {
    const expression = ctx.blocks.get(name) as string;
    wireLines.push(`export const ${name} = ${expression};`);
    wireLines.push(`export type ${name} = z.infer<typeof ${name}>;`);
    if (requestBodies.has(name)) {
      wireLines.push(
        `/** What a caller passes in: the fields the schema defaults are optional here. */`,
        `export type ${name}Input = z.input<typeof ${name}>;`,
      );
    }
  }

  const allNames = [...boundNames, ...ctx.order].sort();
  wireLines.push(
    '',
    '/**',
    ' * Every wire schema, by the name the route table and the OpenAPI document use.',
    ' *',
    ' * The client looks a response schema up here by the name its route names, which is what',
    ' * keeps "what this method parses" and "what the document says this route answers" from',
    ' * being two separate opinions.',
    ' */',
    `export const WIRE_SCHEMAS = {`,
    ...allNames.map((name) => `  ${name},`),
    `} as const satisfies Record<string, z.ZodTypeAny>;`,
    '',
    'export type WireSchemaName = keyof typeof WIRE_SCHEMAS;',
    '',
  );

  for (const name of requestBodies) {
    if (!allNames.includes(name)) fail(`route table names request body "${name}", which is not a component`);
  }

  const routeLines: string[] = [
    banner('The `/v1` route table, and the header names its two auth schemes use.'),
    '',
    "import type { WireSchemaName } from './wire.js';",
    '',
    "export type Auth = 'producer' | 'consumer' | 'none';",
    '',
    'export interface RouteParameter {',
    '  readonly name: string;',
    "  readonly in: 'path' | 'query';",
    '  readonly required: boolean;',
    '}',
    '',
    'export interface RouteResponse {',
    '  readonly status: number;',
    '  /** null when the response has no body at all. */',
    '  readonly contentType: string | null;',
    '  /** A wire schema name, or null when the body is empty or is not a named schema. */',
    '  readonly schema: WireSchemaName | null;',
    '  readonly description: string;',
    '}',
    '',
    'export interface Route {',
    '  readonly method: string;',
    '  /** OpenAPI template form: `/v1/changesets/{changeSetId}/approve`. */',
    '  readonly path: string;',
    '  readonly operationId: string;',
    '  readonly summary: string;',
    '  readonly auth: Auth;',
    '  readonly parameters: readonly RouteParameter[];',
    '  readonly requestBody: WireSchemaName | null;',
    '  readonly responses: readonly RouteResponse[];',
    '  /**',
    '   * The one 2xx JSON body this route answers with, or null when it answers with none.',
    '   * Generation fails if a route has two different ones: a client that could not tell',
    '   * which body it was holding would be guessing at the shape it just parsed.',
    '   */',
    '  readonly successSchema: WireSchemaName | null;',
    '  readonly successStatus: number | null;',
    '}',
    '',
    '/** The protocol version the document was generated at. */',
    `export const OPENAPI_PROTOCOL_VERSION = ${literal(asObject(document['info'], 'info')['version'] as Json)};`,
    '',
    '/** Header names, read off the document\'s own security schemes rather than restated. */',
    'export const AUTH_HEADERS = {',
    ...securityHeaderLines(document),
    '} as const;',
    '',
    'export const ROUTES = {',
  ];

  for (const route of routes) {
    routeLines.push(`  ${route.operationId}: {`);
    routeLines.push(`    method: ${literal(route.method)},`);
    routeLines.push(`    path: ${literal(route.path)},`);
    routeLines.push(`    operationId: ${literal(route.operationId)},`);
    routeLines.push(`    summary: ${literal(route.summary)},`);
    routeLines.push(`    auth: ${literal(route.auth)},`);
    routeLines.push(
      route.parameters.length === 0
        ? '    parameters: [],'
        : `    parameters: [\n${route.parameters
            .map((parameter) => `      { name: ${literal(parameter.name)}, in: ${literal(parameter.in)}, required: ${parameter.required} },`)
            .join('\n')}\n    ],`,
    );
    routeLines.push(`    requestBody: ${route.requestBody === null ? 'null' : literal(route.requestBody)},`);
    routeLines.push('    responses: [');
    for (const response of route.responses) {
      routeLines.push(
        `      { status: ${response.status}, contentType: ${response.contentType === null ? 'null' : literal(response.contentType)}, ` +
          `schema: ${response.schema === null ? 'null' : literal(response.schema)}, description: ${literal(response.description)} },`,
      );
    }
    routeLines.push('    ],');
    routeLines.push(`    successSchema: ${route.successSchema === null ? 'null' : literal(route.successSchema)},`);
    routeLines.push(`    successStatus: ${route.successStatus === null ? 'null' : String(route.successStatus)},`);
    routeLines.push('  },');
  }

  routeLines.push(
    '} as const satisfies Record<string, Route>;',
    '',
    '/** Every operation the document declares. The client is checked against this set.  */',
    'export type OperationId = keyof typeof ROUTES;',
    '',
    'export const OPERATION_IDS = Object.keys(ROUTES) as OperationId[];',
    '',
  );

  return { wire: `${wireLines.join('\n')}\n`, routes: `${routeLines.join('\n')}\n` };
}

function securityHeaderLines(document: JsonObject): string[] {
  const schemes = asObject(
    asObject(document['components'], 'components')['securitySchemes'],
    'components.securitySchemes',
  );
  const lines: string[] = [];
  for (const scheme of ['producerToken', 'linkId', 'linkMac']) {
    const declared = asObject(schemes[scheme], `components.securitySchemes.${scheme}`);
    if (declared['type'] !== 'apiKey' || declared['in'] !== 'header') {
      fail(`components.securitySchemes.${scheme}: this client can only satisfy an apiKey carried in a header`);
    }
    const name = declared['name'];
    if (typeof name !== 'string') fail(`components.securitySchemes.${scheme}: no header name`);
    lines.push(`  ${scheme}: ${literal(name)},`);
  }
  return lines;
}

// ────────────────────────────────── the entry point ──────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

export const OPENAPI_PATH = path.join(REPO_ROOT, 'packages', 'protocol', 'schema', 'openapi.json');
export const WIRE_PATH = path.join(PACKAGE_ROOT, 'src', 'generated', 'wire.ts');
export const ROUTES_PATH = path.join(PACKAGE_ROOT, 'src', 'generated', 'routes.ts');

export function readOpenApi(file: string = OPENAPI_PATH): JsonObject {
  return asObject(JSON.parse(readFileSync(file, 'utf8')) as Json, 'openapi.json');
}

/**
 * The component names `@forgebridge/protocol` already exports as Zod schemas.
 *
 * Read off the module rather than listed here, because a list would be one more
 * thing that can fall behind the contract — which is the failure this whole file
 * exists to make impossible.
 */
export function protocolSchemaNames(module: Record<string, unknown> = protocol as Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(module)) {
    if (value !== null && typeof value === 'object' && typeof (value as { safeParse?: unknown }).safeParse === 'function') {
      names.add(name);
    }
  }
  return names;
}

/**
 * The component names this document has that `@forgebridge/protocol` already
 * exports as a Zod schema.
 *
 * A protocol export the document never mentions is not a component, so binding
 * it would put a schema in the registry that no route can reach.
 */
export function boundComponents(
  document: JsonObject,
  module?: Record<string, unknown>,
): Set<string> {
  const components = asObject(asObject(document['components'], 'components')['schemas'], 'components.schemas');
  const exported = module === undefined ? protocolSchemaNames() : protocolSchemaNames(module);
  return new Set([...exported].filter((name) => name in components));
}

function main(): void {
  const check = process.argv.includes('--check');
  const document = readOpenApi();
  const generated = generate(document, boundComponents(document));
  const files: Array<[string, string]> = [
    [WIRE_PATH, generated.wire],
    [ROUTES_PATH, generated.routes],
  ];

  if (!check) {
    for (const [file, contents] of files) writeFileSync(file, contents, 'utf8');
    console.log(`sdk-ts: generated ${files.map(([file]) => path.relative(REPO_ROOT, file)).join(', ')}`);
    return;
  }

  const stale: string[] = [];
  for (const [file, contents] of files) {
    let onDisk = '';
    try {
      onDisk = readFileSync(file, 'utf8');
    } catch {
      stale.push(`${path.relative(REPO_ROOT, file)} does not exist`);
      continue;
    }
    if (onDisk !== contents) stale.push(`${path.relative(REPO_ROOT, file)} differs from the document`);
  }

  if (stale.length > 0) {
    console.error(`sdk-ts: the generated client is stale —\n  ${stale.join('\n  ')}`);
    console.error('Run: npm run generate --workspace @forgebridge/sdk-ts');
    process.exitCode = 1;
    return;
  }
  console.log('sdk-ts: generated client is in step with packages/protocol/schema/openapi.json');
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
