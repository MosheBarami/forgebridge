/**
 * The observability half of M44: the port's propagation rules, the OTLP
 * adapter's wire output, and the claim ADR-011 is actually for — that one trace
 * answers "what happened to this ChangeSet" from the producer, through the
 * core, to the transport.
 *
 * The redactor has its own file, `redact.test.ts`, because that is a
 * THREAT-MODEL claim rather than an observability one.
 */
import { describe, expect, it } from 'vitest';
import {
  TELEMETRY,
  formatTraceparent,
  parseTraceparent,
  redactedTelemetry,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TelemetryPort,
} from '../src/ports/telemetry.js';
import { combinedTelemetry } from '../src/telemetry/reporter.js';
import { otlpTelemetry } from '../src/telemetry/otlp.js';
import { telemetryFromEnvironment } from '../src/telemetry/index.js';
import { executeRun, type RunDeps, type RunRequest } from '../src/run.js';
import { ModelRouter, type ModelCandidate } from '../src/router.js';
import type { CompletionResponse, ModelClient } from '../src/ports/model.js';
import type { ProjectPolicy } from '../src/policy.js';
import { createOp, fixedClock, PROJECT_ID, uuid } from './helpers.js';

// ── Off by default ───────────────────────────────────────────────────────────

describe('telemetry is off unless an operator asked for it', () => {
  it('builds no adapter from an empty environment', () => {
    // ADR-011: "a privacy promise that the core itself violates is not a
    // promise. Off-by-default has to be structural." This is the structure —
    // there is no adapter to disable, because none was made.
    expect(telemetryFromEnvironment({})).toBeUndefined();
  });

  it('builds no adapter when the SDK is disabled, whatever else is set', () => {
    expect(
      telemetryFromEnvironment({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    ).toBeUndefined();
  });

  it('builds an adapter once an endpoint is named', () => {
    expect(telemetryFromEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBeDefined();
  });

  it('prefers the traces-specific endpoint over the general one', async () => {
    const urls: string[] = [];
    const telemetry = telemetryFromEnvironment(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://general.invalid:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces.invalid:4318',
      },
      { overrides: { fetchImpl: captureUrls(urls) } },
    );
    telemetry?.startSpan('x').end();
    await telemetry?.flush();
    expect(urls[0]).toContain('traces.invalid');
  });

  it('throws on a misconfigured endpoint instead of quietly doing nothing', () => {
    // The failure this guards against is not a crash, it is an empty
    // dashboard nobody can explain. "No telemetry was asked for" and "you
    // asked and it is silently not happening" have to stay distinguishable.
    expect(() => telemetryFromEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' })).toThrow(/valid URL/);
    expect(() => telemetryFromEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://localhost:4317' })).toThrow(
      /http or https/,
    );
  });
});

// ── W3C propagation ──────────────────────────────────────────────────────────

describe('trace context crosses a process boundary or is refused', () => {
  const valid: SpanContext = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
  };

  it('round-trips a context through the header', () => {
    expect(formatTraceparent(valid)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(parseTraceparent(formatTraceparent(valid))).toEqual(valid);
  });

  it.each([
    ['nothing at all', undefined],
    ['an empty string', ''],
    ['a truncated header', '00-4bf92f3577b34da6a3ce929d0e0e4736'],
    ['a short trace id', '00-4bf92f3577b34da6-00f067aa0ba902b7-01'],
    ['non-hex characters', '00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['the forbidden version', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['an all-zero trace id', '00-00000000000000000000000000000000-00f067aa0ba902b7-01'],
    ['an all-zero span id', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'],
  ])('returns null for %s rather than salvaging it', (_label, header) => {
    // Fail closed. A half-parsed context links this work to a trace that does
    // not exist, and an all-zero id joins every unrelated trace a buggy client
    // ever produced.
    expect(parseTraceparent(header as string | undefined)).toBeNull();
  });

  it('accepts a future version, whose first four fields the spec pins', () => {
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')).toEqual({
      ...valid,
      traceFlags: 0,
    });
  });

  it('continues the caller trace when a parent is given, and starts a new one otherwise', () => {
    const telemetry = otlpTelemetry({ endpoint: 'http://collector.invalid:4318', fetchImpl: captureUrls([]) });
    const child = telemetry.startSpan('child', {}, { parent: valid });
    expect(child.context().traceId).toBe(valid.traceId);
    expect(child.context().spanId).not.toBe(valid.spanId);

    const orphan = telemetry.startSpan('orphan', {}, { parent: null });
    expect(orphan.context().traceId).not.toBe(valid.traceId);
    expect(orphan.context().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(orphan.context().traceId).not.toMatch(/^0+$/);
  });
});

// ── The OTLP wire ────────────────────────────────────────────────────────────

describe('the OTLP adapter emits a document a collector accepts', () => {
  it('nests a child under its parent and shares one trace id', async () => {
    const bodies: string[] = [];
    const clock = fixedClock();
    const telemetry = otlpTelemetry({
      endpoint: 'http://collector.invalid:4318/',
      serviceName: 'forgebridge-daemon',
      clock: clock.now,
      fetchImpl: captureBodies(bodies),
    });

    const parent = telemetry.startSpan('forgebridge.run', { [TELEMETRY.RUN_ID]: uuid(1) });
    clock.advance(120);
    const child = telemetry.startSpan('forgebridge.transport.deliver', {}, { parent: parent.context() });
    child.end();
    parent.end();
    await telemetry.flush();

    const document = JSON.parse(bodies[0] ?? '{}') as Record<string, any>;
    const scope = document['resourceSpans'][0]['scopeSpans'][0];
    const [first, second] = scope['spans'];

    expect(document['resourceSpans'][0]['resource']['attributes']).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'forgebridge-daemon' },
    });
    expect(first['parentSpanId']).toBe(parent.context().spanId);
    expect(first['traceId']).toBe(parent.context().traceId);
    expect(second['traceId']).toBe(parent.context().traceId);
    expect(second['parentSpanId']).toBeUndefined();
    expect(second['startTimeUnixNano']).toMatch(/^\d+$/);
    expect(second['attributes']).toContainEqual({ key: TELEMETRY.RUN_ID, value: { stringValue: uuid(1) } });
  });

  it('appends the signal path once, and not twice for an endpoint that already carries it', async () => {
    const urls: string[] = [];
    const telemetry = otlpTelemetry({
      endpoint: 'http://collector.invalid:4318/v1/traces',
      fetchImpl: captureUrls(urls),
    });
    telemetry.startSpan('x').end();
    await telemetry.flush();
    expect(urls).toEqual(['http://collector.invalid:4318/v1/traces']);
  });

  it('records a metric as a cumulative sum and a bucketed histogram', async () => {
    const bodies: string[] = [];
    const telemetry = otlpTelemetry({
      endpoint: 'http://collector.invalid:4318',
      histogramBoundsMs: [10, 100],
      fetchImpl: captureBodies(bodies),
    });
    telemetry.counter('forgebridge.runs', 1, { [TELEMETRY.PROJECT_ID]: uuid(1) });
    telemetry.counter('forgebridge.runs', 2, { [TELEMETRY.PROJECT_ID]: uuid(1) });
    telemetry.histogram('forgebridge.latency', 5);
    telemetry.histogram('forgebridge.latency', 5000);
    await telemetry.flush();

    const metrics = (JSON.parse(bodies.at(-1) ?? '{}') as Record<string, any>)['resourceMetrics'][0][
      'scopeMetrics'
    ][0]['metrics'] as Array<Record<string, any>>;
    const sum = metrics.find((metric) => metric['name'] === 'forgebridge.runs');
    const histogram = metrics.find((metric) => metric['name'] === 'forgebridge.latency');

    expect(sum['sum']['dataPoints'][0]['asDouble']).toBe(3);
    expect(sum['sum']['isMonotonic']).toBe(true);
    // One count in the <=10 bucket, one in the overflow bucket, and one more
    // bucket than there are bounds — which is the invariant a collector
    // rejects the document for getting wrong.
    expect(histogram['histogram']['dataPoints'][0]['bucketCounts']).toEqual(['1', '0', '1']);
    expect(histogram['histogram']['dataPoints'][0]['count']).toBe('2');
  });

  it('ends a span once however many times end() is called', async () => {
    const bodies: string[] = [];
    const telemetry = otlpTelemetry({ endpoint: 'http://c.invalid:4318', fetchImpl: captureBodies(bodies) });
    const span = telemetry.startSpan('once');
    span.end();
    span.end();
    span.end();
    await telemetry.flush();
    const spans = (JSON.parse(bodies[0] ?? '{}') as Record<string, any>)['resourceSpans'][0]['scopeSpans'][0][
      'spans'
    ];
    expect(spans).toHaveLength(1);
  });

  it('drops the oldest spans rather than growing without bound, and says how many', async () => {
    // An unreachable collector must not become an out-of-memory kill. That is
    // the observability tool causing the outage.
    const telemetry = otlpTelemetry({
      endpoint: 'http://c.invalid:4318',
      maxQueueSize: 4,
      maxBatchSize: 1000,
      fetchImpl: captureBodies([]),
    });
    for (let i = 0; i < 10; i += 1) telemetry.startSpan(`span-${i}`).end();
    expect(telemetry.droppedSpans()).toBe(6);
  });

  it('does not throw into the code it observes when the collector is down', async () => {
    const seen: unknown[] = [];
    const telemetry = otlpTelemetry({
      endpoint: 'http://c.invalid:4318',
      onExportError: (error) => seen.push(error),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    telemetry.startSpan('x').end();
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('reports a rejecting collector by status, without echoing what it sent back', async () => {
    const seen: Error[] = [];
    const telemetry = otlpTelemetry({
      endpoint: 'http://c.invalid:4318',
      onExportError: (error) => seen.push(error as Error),
      fetchImpl: (async () => ({
        ok: false,
        status: 413,
        text: async () => 'rejected payload: <the whole request>',
      })) as unknown as typeof fetch,
    });
    telemetry.startSpan('x').end();
    await telemetry.flush();
    expect(seen[0]?.message).toContain('413');
    expect(seen[0]?.message).not.toContain('the whole request');
  });
});

// ── Fan-out ──────────────────────────────────────────────────────────────────

describe('combinedTelemetry', () => {
  it('sends one span to every adapter and propagates the first one identity', () => {
    const a = recorder();
    const b = recorder();
    const combined = combinedTelemetry([a.port, b.port]);
    const span = combined.startSpan('run');
    span.addEvent('e');
    span.end();
    expect(a.names).toEqual(['run']);
    expect(b.names).toEqual(['run']);
    expect(span.context()).toEqual(a.lastContext());
  });

  it('runs every member even when one throws, then rethrows the first failure', () => {
    const good = recorder();
    const bad: TelemetryPort = {
      startSpan() {
        throw new Error('adapter is broken');
      },
      counter() {},
      histogram() {},
    };
    expect(() => combinedTelemetry([bad, good.port]).startSpan('run')).toThrow('adapter is broken');
    expect(good.names).toEqual(['run']);
  });
});

// ── The claim ADR-011 is for ─────────────────────────────────────────────────

describe('one trace answers what happened to this ChangeSet', () => {
  it('runs producer to core to transport under a single trace id', async () => {
    const producer: SpanContext = {
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb',
      traceFlags: 1,
    };
    const clock = fixedClock();
    const collected = recorder();

    const candidate: ModelCandidate = {
      id: 'first/model:free',
      provider: 'alpha',
      contextTokens: 128_000,
      capabilities: ['tools', 'structured_outputs'],
      free: true,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    };
    const policy: ProjectPolicy = {
      allowedPathPrefixes: ['ServerScriptService.Shop'],
      autoApply: null,
    };
    const models: ModelClient = {
      async complete(): Promise<CompletionResponse> {
        return {
          text: JSON.stringify({
            summary: 'add a purchase handler',
            operations: [createOp('ServerScriptService.Shop.Handler')],
          }),
          finishReason: 'stop',
        };
      },
    };

    const request: RunRequest = {
      runId: uuid(20),
      projectId: PROJECT_ID,
      prompt: 'add a purchase handler to the shop',
      baseVersion: 4,
      policy,
      routingPolicy: 'free-first',
      candidates: [candidate],
      producer: { kind: 'mcp', name: 'test-producer' },
      // The producer -> core edge: a `traceparent` the daemon parsed and
      // passed through.
      parentTrace: producer,
    };
    let ids = 700;
    const deps: RunDeps = {
      models,
      router: new ModelRouter({ clock: clock.now }),
      clock: clock.now,
      newId: () => uuid((ids += 1)),
      telemetry: redactedTelemetry(collected.port),
    };

    const result = await executeRun(request, deps);

    expect(result.changeSet).toBeDefined();
    expect(result.trace?.traceId).toBe(producer.traceId);

    // Every span the run produced sits in the producer's trace…
    expect(collected.contexts.map((context) => context.traceId)).toEqual(
      collected.contexts.map(() => producer.traceId),
    );
    // …the run span is the producer span's child, not a root…
    expect(collected.parents[0]).toEqual(producer);
    // …and the stages are all there, each one a separate span.
    expect(collected.names).toEqual([
      'forgebridge.run',
      'forgebridge.run.plan',
      'forgebridge.model.attempt',
      'forgebridge.run.validate',
    ]);

    // The join key is on the run span and on the validate span, which is what
    // makes a query by ChangeSet id answer the question in this test's name.
    const withChangeSetId = collected.attributes.filter(
      (bag) => bag[TELEMETRY.CHANGE_SET_ID] === result.changeSet?.id,
    );
    expect(withChangeSetId.length).toBeGreaterThanOrEqual(2);

    const runAttributes = Object.assign({}, ...collected.attributesFor('forgebridge.run')) as Record<
      string,
      unknown
    >;
    expect(runAttributes[TELEMETRY.RUN_ID]).toBe(request.runId);
    expect(runAttributes[TELEMETRY.PROJECT_ID]).toBe(PROJECT_ID);
    expect(runAttributes[TELEMETRY.PRODUCER]).toBe('mcp');
    expect(runAttributes[TELEMETRY.CHANGE_SET_ID]).toBe(result.changeSet?.id);

    const attemptAttributes = Object.assign(
      {},
      ...collected.attributesFor('forgebridge.model.attempt'),
    ) as Record<string, unknown>;
    expect(attemptAttributes[TELEMETRY.MODEL_ID]).toBe(candidate.id);
    expect(attemptAttributes[TELEMETRY.ATTEMPT_OUTCOME]).toBe('ok');
  });

  it('starts a fresh trace when the producer sent no readable header', async () => {
    const collected = recorder();
    const clock = fixedClock();
    const request: RunRequest = {
      runId: uuid(21),
      projectId: PROJECT_ID,
      prompt: 'anything',
      baseVersion: 0,
      routingPolicy: 'free-first',
      candidates: [],
      // What `parseTraceparent` returns for a header it cannot read. It must
      // not become a parent id nobody can look up.
      parentTrace: parseTraceparent('nonsense'),
    };
    const deps: RunDeps = {
      models: { async complete() { throw new Error('never called'); } },
      router: new ModelRouter({ clock: clock.now }),
      clock: clock.now,
      newId: () => uuid(1),
      telemetry: collected.port,
    };

    const result = await executeRun(request, deps);
    expect(result.failure).toBeDefined();
    expect(collected.parents[0]).toBeNull();
    expect(result.trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    // A run that failed before it produced anything still produced a span
    // saying so, with the reason on it.
    const runAttributes = Object.assign({}, ...collected.attributesFor('forgebridge.run')) as Record<
      string,
      unknown
    >;
    expect(runAttributes[TELEMETRY.ERROR_CODE]).toBeDefined();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function captureBodies(into: string[]): typeof fetch {
  return (async (_url: string, init?: { body?: string }) => {
    into.push(String(init?.body ?? ''));
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
}

function captureUrls(into: string[]): typeof fetch {
  return (async (url: string) => {
    into.push(String(url));
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
}

/** A telemetry double that remembers structure, not just text. */
function recorder() {
  const names: string[] = [];
  const parents: Array<SpanContext | null> = [];
  const contexts: SpanContext[] = [];
  const attributes: Array<Record<string, unknown>> = [];
  const attributesBySpan = new Map<string, Array<Record<string, unknown>>>();
  let counter = 0;

  const port: TelemetryPort = {
    startSpan(name: string, initial?: Attributes, options?: SpanOptions): Span {
      counter += 1;
      const context: SpanContext = {
        traceId: options?.parent?.traceId ?? `${counter}`.padStart(32, 'c'),
        spanId: `${counter}`.padStart(16, 'd'),
        traceFlags: options?.parent?.traceFlags ?? 1,
      };
      names.push(name);
      parents.push(options?.parent ?? null);
      contexts.push(context);
      const bags = attributesBySpan.get(name) ?? [];
      attributesBySpan.set(name, bags);
      const remember = (bag: Record<string, unknown>): void => {
        attributes.push(bag);
        bags.push(bag);
      };
      if (initial) remember({ ...initial });
      return {
        setAttributes: (next) => remember({ ...next }),
        addEvent: (_eventName, eventAttributes) => {
          if (eventAttributes) remember({ ...eventAttributes });
        },
        recordException: () => {},
        setStatus: (_status: SpanStatus) => {},
        end: () => {},
        context: () => context,
      };
    },
    counter: () => {},
    histogram: () => {},
  };

  return {
    port,
    names,
    parents,
    contexts,
    attributes,
    lastContext: () => contexts[0],
    attributesFor: (name: string) => attributesBySpan.get(name) ?? [],
  };
}
