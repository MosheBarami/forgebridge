/**
 * The generated client, and the generator that writes it.
 *
 * Two jobs, and the second is the one that matters. The first is a drift check:
 * regenerate both files in memory and require them to equal what is committed,
 * so a protocol change that was never projected here fails in this package
 * rather than reaching a user as a client describing a surface the daemon does
 * not serve.
 *
 * The second is the generator's own self-tests. A gate that cannot fail is
 * decoration, so every refusal the generator makes is planted here and shown to
 * reject — and each one is paired with the legitimate shape it is most
 * confusable with, shown to pass. A fail-closed generator that also refuses the
 * ordinary case is not safer, it is just broken in the other direction.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as protocol from '@forgebridge/protocol';
import {
  GenerationError,
  ROUTES_PATH,
  WIRE_PATH,
  boundComponents,
  collectRoutes,
  ensureComponent,
  expressionFor,
  generate,
  readOpenApi,
  type EmitContext,
  type JsonObject,
} from '../scripts/generate.js';
import { WIRE_SCHEMAS } from '../src/generated/wire.js';
import { OPENAPI_PROTOCOL_VERSION, OPERATION_IDS, ROUTES } from '../src/generated/routes.js';

const document = readOpenApi();

function context(components: Record<string, JsonObject>, bound: Iterable<string> = []): EmitContext {
  return { components, bound: new Set(bound), order: [], active: new Set(), blocks: new Map() };
}

describe('the committed client is what the OpenAPI document projects', () => {
  it('regenerates byte for byte', () => {
    const regenerated = generate(document, boundComponents(document));
    expect(readFileSync(WIRE_PATH, 'utf8')).toBe(regenerated.wire);
    expect(readFileSync(ROUTES_PATH, 'utf8')).toBe(regenerated.routes);
  });

  it('declares the protocol version the document was generated at', () => {
    expect(OPENAPI_PROTOCOL_VERSION).toBe(protocol.PROTOCOL_VERSION);
  });

  it('covers every route the document declares', () => {
    const fromDocument = collectRoutes(document).map((route) => route.operationId).sort();
    expect([...OPERATION_IDS].sort()).toEqual(fromDocument);
  });

  /**
   * The bound half is bound by identity, not by resemblance.
   *
   * This is the property the whole binding decision rests on: a caller that
   * parses a ChangeSet with this SDK is running the protocol's own schema —
   * `.superRefine()` bodies, brands and all — rather than a projection of it
   * that lost whatever JSON Schema cannot say.
   */
  it('binds contract schemas to the protocol package itself', () => {
    const bound = boundComponents(document);
    expect(bound.size).toBeGreaterThan(0);
    for (const name of bound) {
      expect(WIRE_SCHEMAS[name as keyof typeof WIRE_SCHEMAS]).toBe(
        (protocol as unknown as Record<string, unknown>)[name],
      );
    }
  });

  it('projects the shapes the protocol package does not export', () => {
    // The daemon's own wire module, which a client may not import.
    for (const name of ['ChangeSetDiff', 'RunResponse', 'JournalStateResponse', 'ApproveRequest']) {
      expect(WIRE_SCHEMAS[name as keyof typeof WIRE_SCHEMAS]).toBeDefined();
      expect((protocol as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

describe('the generated schemas keep the constraints that matter', () => {
  it('leaves contentDigest required, with no default to opt out of', () => {
    // ADR-012: an approval names operations a human read, not an id. A default
    // here would be a caller opting out of that binding.
    expect(WIRE_SCHEMAS.ApproveRequest.safeParse({ approvedBy: 'alex' }).success).toBe(false);
    expect(WIRE_SCHEMAS.ApproveRequest.safeParse({ contentDigest: 'sha256:abc' }).success).toBe(true);
  });

  it('applies a default instead of leaving the field undefined', () => {
    // `.default(x).optional()` would pass `undefined` straight through and never
    // apply the default, so the client and the daemon would disagree about a
    // value neither of them sent.
    const parsed = WIRE_SCHEMAS.ApproveRequest.parse({ contentDigest: 'sha256:abc' });
    expect(parsed).toMatchObject({ approvedBy: 'local', confirmBulkDelete: false });
    expect(WIRE_SCHEMAS.StartRunRequest.parse({ prompt: 'hello' })).toMatchObject({
      policy: 'free-first',
      stream: false,
    });
  });

  it('keeps unknown fields rather than deleting them', () => {
    // The protocol is additive. A field a newer daemon sends must survive a
    // round trip through an older client instead of being silently dropped.
    const parsed = WIRE_SCHEMAS.HealthResponse.parse({
      ok: true,
      service: 'forgebridge-daemon',
      version: '0.1.0',
      protocolVersion: '1.0.0',
      transport: 'local-daemon',
      boundTo: '127.0.0.1:7317',
      uptimeSeconds: 1,
      somethingAddedLater: 'kept',
    });
    expect(parsed).toMatchObject({ somethingAddedLater: 'kept' });
  });

  it('distinguishes null from absent where the protocol does', () => {
    // `inverses: null` means the inverses never left the Studio session; `0`
    // would mean an apply with nothing to undo. A schema that accepted only one
    // of them would make a UI unable to tell those apart.
    const base = {
      journalId: '11111111-1111-4111-8111-111111111111',
      changeSetId: '22222222-2222-4222-8222-222222222222',
      projectId: '33333333-3333-4333-8333-333333333333',
      summary: 'a summary',
      state: 'applied',
      versionBefore: 1,
      versionAfter: 2,
      appliedAt: '2026-01-01T00:00:00Z',
      rollbackRequestedAt: null,
      rolledBackAt: null,
      result: null,
    };
    expect(WIRE_SCHEMAS.JournalStateResponse.safeParse({ ...base, inverses: null }).success).toBe(true);
    expect(WIRE_SCHEMAS.JournalStateResponse.safeParse({ ...base, inverses: 0 }).success).toBe(true);
    expect(WIRE_SCHEMAS.JournalStateResponse.safeParse({ ...base }).success).toBe(false);
  });
});

// ── the generator's own refusals, each with its control ──────────────────────

describe('a keyword the generator has never heard of is an error', () => {
  it('refuses it rather than dropping it', () => {
    expect(() =>
      expressionFor({ type: 'array', items: { type: 'string' }, uniqueItems: true }, context({}), 'planted', 0),
    ).toThrow(/uniqueItems/);
    expect(() =>
      expressionFor({ type: 'array', items: { type: 'string' }, uniqueItems: true }, context({}), 'planted', 0),
    ).toThrow(GenerationError);
  });

  it('and still projects the keyword next to it that it does know', () => {
    // The control. A fail-closed generator that also refuses `maxItems` would
    // not be safer, it would be unusable.
    expect(expressionFor({ type: 'array', items: { type: 'string' }, maxItems: 3 }, context({}), 'control', 0)).toBe(
      'z.array(z.string()).max(3)',
    );
  });
});

describe('a $ref the generator cannot resolve is an error', () => {
  it('refuses a ref that points outside #/components/schemas', () => {
    // The document really contains one of these: `PropertyBag.propertyNames`
    // points at `#/$defs/PropertyName`, which resolves in the per-type JSON
    // Schema files and dangles here. It sits inside a bound component today, so
    // it is never walked — and if it moves, this is what stops.
    expect(() => expressionFor({ $ref: '#/$defs/PropertyName' }, context({}), 'planted', 0)).toThrow(
      /does not point into #\/components\/schemas/,
    );
  });

  it('refuses a ref to a component the document does not define', () => {
    expect(() => expressionFor({ $ref: '#/components/schemas/Absent' }, context({}), 'planted', 0)).toThrow(
      /which the document does not define/,
    );
  });

  it('and resolves an ordinary one', () => {
    const ctx = context({ Known: { type: 'string' } });
    expect(expressionFor({ $ref: '#/components/schemas/Known' }, ctx, 'control', 0)).toBe('Known');
    expect(ctx.order).toEqual(['Known']);
  });
});

describe('a reference cycle is an error', () => {
  it('refuses to emit schemas that reference each other', () => {
    const ctx = context({
      A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
      B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
    });
    expect(() => ensureComponent('A', ctx)).toThrow(/reference cycle/);
  });

  it('and emits a diamond, which is not one', () => {
    // The control: C is reached twice by two different paths and is emitted
    // once, before both of them.
    const ctx = context({
      A: {
        type: 'object',
        properties: { b: { $ref: '#/components/schemas/B' }, c: { $ref: '#/components/schemas/C' } },
      },
      B: { type: 'object', properties: { c: { $ref: '#/components/schemas/C' } } },
      C: { type: 'string' },
    });
    ensureComponent('A', ctx);
    expect(ctx.order).toEqual(['C', 'B', 'A']);
  });
});

describe('a type union the generator cannot project is an error', () => {
  it('refuses a two-way union that is not "something or null"', () => {
    expect(() => expressionFor({ type: ['string', 'integer'] }, context({}), 'planted', 0)).toThrow(
      /is a union of types this generator does not project/,
    );
  });

  it('and projects a nullable', () => {
    expect(expressionFor({ type: ['integer', 'null'], minimum: 0 }, context({}), 'control', 0)).toBe(
      'z.number().int().min(0).nullable()',
    );
  });
});

describe('an object whose required list names an undeclared property is an error', () => {
  it('refuses it', () => {
    expect(() =>
      expressionFor({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, context({}), 'planted', 0),
    ).toThrow(/"b" is required and is not a declared property/);
  });

  it('and accepts the same object with the property declared', () => {
    expect(
      expressionFor(
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: true },
        context({}),
        'control',
        0,
      ),
    ).toContain('"b": z.string(),');
  });
});

describe('a route the client could not read is an error', () => {
  const path = (responses: JsonObject, extra: JsonObject = {}): JsonObject => ({
    paths: {
      '/v1/thing': {
        get: { operationId: 'getThing', summary: 's', security: [], responses, ...extra },
      },
    },
  });

  it('refuses two different 2xx JSON bodies on one route', () => {
    expect(() =>
      collectRoutes(
        path({
          '200': { description: 'a', content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } },
          '201': { description: 'b', content: { 'application/json': { schema: { $ref: '#/components/schemas/B' } } } },
        }),
      ),
    ).toThrow(/a client cannot know which one it is holding/);
  });

  it('and accepts a JSON body beside an empty 2xx, which is what a long poll answers', () => {
    // The control, and it is a real route: `GET /v1/link/poll` answers 200 with
    // an envelope and 204 when the poll window closed with nothing queued.
    const routes = collectRoutes(
      path({
        '200': { description: 'a', content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } },
        '204': { description: 'nothing queued' },
      }),
    );
    expect(routes[0]?.successSchema).toBe('A');
    expect(routes[0]?.successStatus).toBe(200);
  });

  it('refuses an inline JSON response body, rather than recording it as no body', () => {
    // The fail-open shape: `schema: null` is how a 204 is recorded, so an inline
    // JSON body filed the same way would be read by the client as "this route
    // answers with nothing" — a check finding no pattern it recognises and
    // reporting success.
    expect(() =>
      collectRoutes(
        path({
          '200': { description: 'a', content: { 'application/json': { schema: { type: 'object' } } } },
        }),
      ),
    ).toThrow(/has no name for the client to look up/);
  });

  it('and accepts an inline body on a content type that is not JSON', () => {
    // The control, and it is the real run stream: `POST /v1/runs` answers 200
    // `text/event-stream` with an inline string schema, which is exactly right —
    // there is no component for "a stream of frames".
    const routes = collectRoutes(
      path({
        '200': { description: 'the stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        '201': { description: 'the run', content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } },
      }),
    );
    expect(routes[0]?.successSchema).toBe('A');
    expect(routes[0]?.successStatus).toBe(201);
  });

  it('refuses a request body with no name to look up', () => {
    expect(() =>
      collectRoutes(
        path(
          { '204': { description: 'done' } },
          { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } },
        ),
      ),
    ).toThrow(/no name for the client to look up/);
  });

  it('refuses a security requirement it cannot satisfy', () => {
    expect(() =>
      collectRoutes({
        paths: {
          '/v1/thing': {
            get: {
              operationId: 'getThing',
              summary: 's',
              security: [{ oauth2: [] }],
              responses: { '204': { description: 'done' } },
            },
          },
        },
      }),
    ).toThrow(/is not one this client knows how to satisfy/);
  });

  it('refuses a route that declares no security at all', () => {
    // Fail-closed: an unstated auth requirement is one a client gets wrong, and
    // defaulting it to "none" is how a producer route ends up called without a
    // token and reported as a 401 nobody expected.
    expect(() =>
      collectRoutes({
        paths: { '/v1/thing': { get: { operationId: 'getThing', summary: 's', responses: { '204': { description: 'd' } } } } },
      }),
    ).toThrow(/no security declared/);
  });

  it('and reads the two schemes the daemon actually uses', () => {
    const routes = collectRoutes(document);
    const byId = new Map(routes.map((route) => [route.operationId, route]));
    expect(byId.get('proposeChangeSet')?.auth).toBe('producer');
    expect(byId.get('pollDeliveries')?.auth).toBe('consumer');
    expect(byId.get('getHealth')?.auth).toBe('none');
  });
});

describe('the route table says what the daemon says', () => {
  it('keeps approve a route of its own, with its own body', () => {
    // ADR-012 in the shape the generated table records it: nothing about
    // proposing reaches approval, and approving takes a digest.
    expect(ROUTES.proposeChangeSet.path).toBe('/v1/changesets');
    expect(ROUTES.approveChangeSet.path).toBe('/v1/changesets/{changeSetId}/approve');
    expect(ROUTES.approveChangeSet.requestBody).toBe('ApproveRequest');
    expect(ROUTES.startRun.requestBody).toBe('StartRunRequest');
  });

  it('records the run stream as an event stream and not as JSON', () => {
    const streamed = ROUTES.startRun.responses.find((response) => response.status === 200);
    expect(streamed?.contentType).toBe('text/event-stream');
    expect(ROUTES.startRun.successSchema).toBe('RunResponse');
    expect(ROUTES.startRun.successStatus).toBe(201);
  });
});
