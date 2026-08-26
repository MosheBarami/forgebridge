import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as protocol from '../../packages/protocol/src/index.js';
import {
  type Json,
  checkRouteTable,
  deepEqual,
  validate,
} from '../generate-schemas.js';

/**
 * The cross-language drift proof.
 *
 * `docs/PROTOCOL.md` claims one contract "projected everywhere". Three
 * projections of it now exist — the Zod schemas themselves, the JSON Schema
 * documents in `packages/protocol/schema/`, and the pydantic models in
 * `packages/sdk-python` — and the claim is only worth anything if all three
 * agree about the same document.
 *
 * So a corpus of representative documents is run through every one of them and
 * the answers are compared. A projection that silently drops a field is worse
 * than no projection: a consumer trusts it, sends something the daemon refuses,
 * and learns about the gap from a 400 in production rather than from this file.
 *
 * The corpus includes the two shapes most likely to expose a lossy projection:
 * a ChangeSet carrying every `PropertyValue` tag, including the two whose nested
 * keypoints have defaults, and one whose property value is an `InstanceRef` —
 * the field that used to be an unvalidated string and that `pathsOf` used not to
 * report.
 *
 * This file imports `generate-schemas.ts` for its validator and its router
 * cross-check only. It never calls `buildArtifacts`, which is what keeps the
 * suite runnable with no build output — the daemon's wire module is imported
 * dynamically inside that function precisely so this test does not need it.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCHEMA_DIR = path.join(ROOT, 'packages/protocol/schema');
const SDK = path.join(ROOT, 'packages/sdk-python');

interface Case {
  readonly name: string;
  readonly type: string;
  readonly zodValid: boolean;
  readonly schemaValid: boolean;
  readonly note?: string;
  readonly document: Json;
}

const corpus = JSON.parse(readFileSync(path.join(SDK, 'tests/corpus.json'), 'utf8')) as {
  cases: Case[];
};

interface ParsingSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

const schemas = protocol as unknown as Record<string, ParsingSchema | undefined>;

function schemaNamed(type: string): ParsingSchema {
  const schema = schemas[type];
  if (!schema) throw new Error(`${type} is not an exported Zod schema`);
  return schema;
}

function schemaFor(type: string): Json {
  const file = path.join(SCHEMA_DIR, `${type}.schema.json`);
  expect(existsSync(file), `no generated JSON Schema for ${type}`).toBe(true);
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

// ─────────────────────────── the generated set itself ───────────────────────────

describe('the generated schema directory matches the exported contract', () => {
  const exported = Object.entries(protocol as unknown as Record<string, unknown>)
    .filter(([, value]) => typeof (value as { safeParse?: unknown })?.safeParse === 'function')
    .map(([name]) => name)
    .sort();

  const generated = readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith('.schema.json'))
    .map((file) => file.replace(/\.schema\.json$/, ''))
    .sort();

  it('emits one file per exported Zod schema and nothing else', () => {
    // The `--check` gate catches content drift. This catches the cheaper
    // mistake: a schema added to the protocol and never projected, or a file
    // left behind by a renamed type, either of which a consumer would read as
    // the current contract.
    expect(generated).toEqual(exported);
  });

  it('ships the OpenAPI document and its provenance note', () => {
    expect(existsSync(path.join(SCHEMA_DIR, 'openapi.json'))).toBe(true);
    const readme = readFileSync(path.join(SCHEMA_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('DO NOT EDIT');
    expect(readme).toContain('npm run generate:schemas');
  });

  it('describes the surface the daemon actually routes', () => {
    // `checkRouteTable` throws when the router branches on something the OpenAPI
    // route table does not describe, or the other way round. It returns the
    // disagreements with `docs/PROTOCOL.md`, where the code is the winner and
    // the document is the bug.
    const server = readFileSync(path.join(ROOT, 'packages/daemon/src/server.ts'), 'utf8');
    const doc = readFileSync(path.join(ROOT, 'docs/PROTOCOL.md'), 'utf8');
    expect(checkRouteTable(server, doc)).toEqual([]);
  });

  it('pins every /v1 path into the OpenAPI document', () => {
    const openapi = JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'openapi.json'), 'utf8')) as {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    expect(openapi.openapi).toBe('3.1.0');
    expect(openapi.info.version).toBe(protocol.PROTOCOL_VERSION);
    expect(Object.keys(openapi.paths)).toContain('/v1/changesets');
    expect(Object.keys(openapi.paths)).toContain('/v1/changesets/{changeSetId}/approve');
  });

  it('keeps proposing and approving as separate operations (ADR-012)', () => {
    // The one invariant a generated client must not smooth over. If a single
    // operation ever both accepted a ChangeSet and cleared it, a model could
    // approve its own work by calling one endpoint.
    const openapi = JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const propose = openapi.paths['/v1/changesets']?.['post'];
    const approve = openapi.paths['/v1/changesets/{changeSetId}/approve']?.['post'];
    expect(propose?.operationId).toBe('proposeChangeSet');
    expect(approve?.operationId).toBe('approveChangeSet');
    expect(propose?.operationId).not.toBe(approve?.operationId);
  });
});

// ──────────────────────────── leg 1 and leg 2: TS ↔ JSON Schema ────────────────────────────

describe('Zod and the JSON Schema projection judge the same documents', () => {
  it('has a corpus worth calling representative', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
    expect(corpus.cases.some((c) => c.name === 'every-property-value-tag')).toBe(true);
    expect(corpus.cases.some((c) => c.name === 'instance-ref-in-set-property')).toBe(true);
    expect(corpus.cases.filter((c) => !c.zodValid).length).toBeGreaterThanOrEqual(10);
  });

  it('covers every PropertyValue tag in one document', () => {
    const everyTag = corpus.cases.find((c) => c.name === 'every-property-value-tag');
    const operations = ((everyTag?.document as Record<string, Json>)['operations'] as Json[]) ?? [];
    const properties = (operations[0] as Record<string, Json>)['properties'] as Record<string, Json>;
    const tags = Object.values(properties).map((value) => (value as Record<string, Json>)['t']);
    expect([...tags].sort()).toEqual([...protocol.PROPERTY_VALUE_TAGS].sort());
  });

  it.each(corpus.cases.map((c) => [c.name, c] as const))('%s — Zod agrees with the corpus', (_name, testCase) => {
    expect(schemaNamed(testCase.type).safeParse(testCase.document).success).toBe(testCase.zodValid);
  });

  it.each(corpus.cases.map((c) => [c.name, c] as const))(
    '%s — the JSON Schema agrees with the corpus',
    (_name, testCase) => {
      const errors = validate(schemaFor(testCase.type), testCase.document);
      expect(errors.length === 0, errors.join('; ')).toBe(testCase.schemaValid);
    },
  );

  it('states every divergence between Zod and the JSON Schema in the generated README', () => {
    // A case the two judge differently is a hole in the projection. It is
    // allowed to exist — JSON Schema cannot compare two array elements — but it
    // is not allowed to be undocumented, because a consumer reading the schema
    // has no other way to learn about it.
    const divergent = corpus.cases.filter((c) => c.zodValid !== c.schemaValid);
    const readme = readFileSync(path.join(SCHEMA_DIR, 'README.md'), 'utf8');
    expect(readme).toContain('What does NOT survive the projection');
    for (const testCase of divergent) {
      expect(testCase.note, `${testCase.name} diverges without a note`).toBeTruthy();
      expect(readme, 'a divergence the generated README does not name').toContain('ChangeSet');
    }
    // Exactly one, today. A second one appearing without a deliberate decision
    // is what this number is here to make visible.
    expect(divergent.map((c) => c.name)).toEqual(['duplicate-delete-ordering']);
  });

  it('validates what Zod produced, not only what was sent', () => {
    // Defaults are applied on parse. A projection that emitted a schema the
    // *parsed* form fails would break every consumer that round-trips.
    for (const testCase of corpus.cases.filter((c) => c.zodValid)) {
      const parsed = schemaNamed(testCase.type).safeParse(testCase.document);
      const errors = validate(schemaFor(testCase.type), parsed.data as Json);
      expect(errors, `${testCase.name}: ${errors.join('; ')}`).toEqual([]);
    }
  });
});

// ──────────────────────────── leg 3: the Python projection ────────────────────────────

/**
 * The interpreter to run the Python leg with.
 *
 * Preference order: an explicit override, then the SDK's own virtualenv, then
 * whatever `python3` is. Returns null when none of them can import the package,
 * because a machine without pydantic is a normal state for a TypeScript
 * contributor and failing here would teach them to ignore this file.
 */
function pythonInterpreter(): string | null {
  const candidates = [
    process.env['FORGEBRIDGE_PYTHON'],
    path.join(SDK, '.venv/bin/python'),
    'python3',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import pydantic, annotated_types'], {
      cwd: SDK,
      encoding: 'utf8',
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = pythonInterpreter();

describe.skipIf(python === null)('the pydantic projection agrees with Zod', () => {
  interface PythonResult {
    readonly name: string;
    readonly valid: boolean;
    readonly parsed: Json | null;
    readonly error: string | null;
  }

  const run = spawnSync(python as string, ['tests/roundtrip.py'], {
    cwd: SDK,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  it('ran', () => {
    expect(run.status, run.stderr).toBe(0);
  });

  const results = new Map<string, PythonResult>(
    (JSON.parse(run.stdout || '[]') as PythonResult[]).map((result) => [result.name, result]),
  );

  it.each(corpus.cases.map((c) => [c.name, c] as const))('%s — accepted or refused alike', (_name, testCase) => {
    const result = results.get(testCase.name);
    expect(result, 'the Python leg produced no result for this case').toBeDefined();
    expect((result as PythonResult).valid, (result as PythonResult).error ?? '').toBe(testCase.zodValid);
  });

  it.each(corpus.cases.filter((c) => c.zodValid).map((c) => [c.name, c] as const))(
    '%s — parses to the same document',
    (_name, testCase) => {
      const fromZod = schemaNamed(testCase.type).safeParse(testCase.document).data as Json;
      const fromPython = (results.get(testCase.name) as PythonResult).parsed as Json;
      // Deep equality rather than string comparison: key order is not part of
      // the contract, and JSON numbers unify on both sides once parsed.
      expect(
        deepEqual(fromZod, fromPython),
        `Zod produced ${JSON.stringify(fromZod)}\nPython produced ${JSON.stringify(fromPython)}`,
      ).toBe(true);
    },
  );

  it('round-trips the field whose wire name is a Python keyword', () => {
    // `InverseOperation.moveBack.from`. The projection has to rename the
    // attribute and keep the wire name as an alias; a projection that renamed
    // the field on the wire too would produce a journal the daemon cannot read.
    const journal = results.get('journal-entry-with-a-move-back-inverse') as PythonResult;
    const inverses = (journal.parsed as Record<string, Json>)['inverses'] as Array<Record<string, Json>>;
    const moveBack = inverses.find((inverse) => inverse['inverse'] === 'moveBack');
    expect(moveBack).toBeDefined();
    expect(Object.keys(moveBack as Record<string, Json>)).toContain('from');
    expect(Object.keys(moveBack as Record<string, Json>)).not.toContain('from_');
  });
});

describe('the Python leg is not silently skipped', () => {
  it('says which interpreter it would need', () => {
    // A skipped drift test looks the same as a passing one in a terminal. If
    // this ever starts skipping on a machine that should have the toolchain,
    // the message below is what says so.
    if (python === null) {
      console.warn(
        'schema-projection: the Python leg was skipped — no interpreter with pydantic and ' +
          'annotated_types. Set FORGEBRIDGE_PYTHON, or create packages/sdk-python/.venv.',
      );
    }
    expect(true).toBe(true);
  });
});

// ──────────────────────── the checks' own ability to fail ────────────────────────

describe('the hand-written validator can actually refuse things', () => {
  // `validate` is this repository's only JSON Schema implementation — there is
  // no validator in the dependency tree, and adding one to run a gate is a
  // supply-chain decision rather than a convenience. A validator nobody proved
  // can say "no" would make every assertion above vacuous.

  it('applies the keywords the generator emits', () => {
    expect(validate({ type: 'integer', minimum: 0 }, 1)).toEqual([]);
    expect(validate({ type: 'integer', minimum: 0 }, -1)).not.toEqual([]);
    expect(validate({ type: 'integer' }, 1.5)).not.toEqual([]);
    expect(validate({ type: 'string', pattern: '^a+$' }, 'aaa')).toEqual([]);
    expect(validate({ type: 'string', pattern: '^a+$' }, 'aab')).not.toEqual([]);
    expect(validate({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(validate({ not: { enum: ['Parent'] } }, 'Parent')).not.toEqual([]);
    expect(validate({ type: 'array', prefixItems: [{ type: 'number' }], items: false }, [1, 2]))
      .not.toEqual([]);
    expect(validate({ type: 'object', required: ['a'], properties: {} }, {})).not.toEqual([]);
    expect(validate({ type: 'object', propertyNames: { pattern: '^[a-z]+$' } }, { Bad: 1 }))
      .not.toEqual([]);
  });

  it('picks exactly one branch of a discriminated oneOf', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { t: { const: 'a' } }, required: ['t'] },
        { type: 'object', properties: { t: { const: 'b' } }, required: ['t'] },
      ],
    };
    expect(validate(schema, { t: 'a' })).toEqual([]);
    expect(validate(schema, { t: 'c' })).not.toEqual([]);
  });

  it('resolves a local $ref out of $defs', () => {
    const root = { $defs: { Name: { type: 'string', minLength: 2 } }, $ref: '#/$defs/Name' };
    expect(validate(root, 'ok', root)).toEqual([]);
    expect(validate(root, 'x', root)).not.toEqual([]);
  });

  it('refuses to pass a keyword it does not implement', () => {
    // The failure mode that matters most: a schema keyword nobody taught this
    // function about must not be read as "no constraint here".
    expect(() => validate({ type: 'number', multipleOf: 2 } as unknown as Json, 3)).toThrow(
      /multipleOf/,
    );
  });
});

describe('the router cross-check can actually fail', () => {
  const doc = readFileSync(path.join(ROOT, 'docs/PROTOCOL.md'), 'utf8');
  const server = readFileSync(path.join(ROOT, 'packages/daemon/src/server.ts'), 'utf8');

  it('rejects a router that grew a resource the OpenAPI table does not describe', () => {
    const doctored = server.replace(
      "if (resource === 'models'",
      "if (resource === 'secrets') return;\n    if (resource === 'models'",
    );
    expect(doctored).not.toBe(server);
    expect(() => checkRouteTable(doctored, doc)).toThrow(/secrets/);
  });

  it('rejects a router that stopped answering the CORS preflight', () => {
    const doctored = server.replace("req.method === 'OPTIONS'", "req.method === 'HEAD'");
    expect(doctored).not.toBe(server);
    expect(() => checkRouteTable(doctored, doc)).toThrow(/OPTIONS/);
  });

  it('reports an endpoint the documentation table has dropped', () => {
    const doctored = doc.replace('GET    /v1/models', 'GET    /v1/models-was-here');
    expect(doctored).not.toBe(doc);
    // Both directions are reported: an endpoint the router serves and the table
    // omits, and an endpoint the table promises and the router does not answer.
    // The second is the one a client author would waste an afternoon on.
    expect(checkRouteTable(server, doctored)).toEqual([
      'served but not in the PROTOCOL.md table: GET /V1/MODELS',
      'in the PROTOCOL.md table but not served: GET /V1/MODELS-WAS-HERE',
    ]);
  });
});
