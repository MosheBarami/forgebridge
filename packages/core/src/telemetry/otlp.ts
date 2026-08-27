/**
 * The OTLP adapter — the neutral half of ADR-011.
 *
 * OpenTelemetry semantics, spoken over OTLP/HTTP+JSON with `fetch` and nothing
 * else. There is no `@opentelemetry/*` dependency here, and that is the point
 * three times over:
 *
 *   1. ADR-011 chose OTel for its *semantics*, so that a trace id spanning
 *      producer to plugin survives a change of vendor. The wire format is the
 *      standard; the SDK is one implementation of it.
 *   2. `packages/core` has one dependency (`@forgebridge/protocol`) and B2 in
 *      `scripts/verify-boundaries.ts` exists to keep vendors out of it. An SDK
 *      that pulls a tree of exporters, propagators and instrumentation into the
 *      core would make "self-hostable" a claim about our dependency graph.
 *   3. A self-hoster points this at any collector — Jaeger, Tempo, Grafana
 *      Alloy, the OTel Collector, a vendor's ingest — because they all speak
 *      OTLP. That is the choice ADR-011 promised them.
 *
 * Off by default: nothing constructs this unless a host names an endpoint.
 * `telemetryFromEnvironment` returns `undefined` when the environment carries
 * no OTLP endpoint, so the default install has no adapter rather than a
 * disabled one. See `index.ts`.
 *
 * Flushing: this adapter starts no timers. A module-level interval keeps a Node
 * process alive, has to be unref'd on one runtime and cleared on another, and
 * is the classic way a library makes a CLI hang on exit. Instead: a batch
 * flushes when it fills, and the host calls `flush()` — on a schedule it owns,
 * and once at shutdown.
 */
import { systemClock, type Clock } from '../clock.js';
import {
  redactedTelemetry,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TelemetryPort,
} from '../ports/telemetry.js';
import { SAMPLED, newSpanId, newTraceId } from './ids.js';

/**
 * Strip trailing `/` in linear time.
 *
 * `replace(/\/+$/, '')` stood here and reads better, but `\/+$` is the textbook
 * polynomial-ReDoS shape — on a long run of slashes the engine backtracks
 * O(n^2), which is what CodeQL's `js/polynomial-redos` fires on. A base URL is a
 * caller-supplied string, so the loop is the honest answer rather than an
 * argument about who would ever pass one. Local to this file on purpose: it is
 * three lines, and a shared utility package for it would cross a boundary
 * `verify-boundaries.ts` is right to keep closed.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  // 47 is `/`. charCodeAt keeps this a scan, with no allocation per character.
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}


/** OTLP `Status.StatusCode`. */
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;
/** OTLP `SpanKind.SPAN_KIND_INTERNAL`. */
const KIND_INTERNAL = 1;
/** OTLP `AggregationTemporality.CUMULATIVE`. */
const CUMULATIVE = 2;

/**
 * Default histogram bucket bounds, in milliseconds.
 *
 * Chosen for what this project measures: a model call is seconds, an apply
 * round trip through Studio is tens of seconds, and the interesting question is
 * almost always "which tail". Override them per deployment if that stops being
 * true.
 */
export const DEFAULT_HISTOGRAM_BOUNDS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000,
];

export interface OtlpTelemetryOptions {
  /**
   * Collector base URL — `http://localhost:4318`. `/v1/traces` and
   * `/v1/metrics` are appended, per the OTLP/HTTP specification. A URL that
   * already ends in one of those paths is used as given for that signal.
   */
  endpoint: string;
  /** `service.name`, and the rest of the resource. Defaults to `forgebridge`. */
  serviceName?: string;
  resourceAttributes?: Attributes;
  /** Sent on every export. A collector behind an auth proxy needs this. */
  headers?: Readonly<Record<string, string>>;
  /** Spans buffered before an automatic export. */
  maxBatchSize?: number;
  /**
   * Hard cap on buffered spans. Past it the *oldest* are dropped and the count
   * is available from `droppedSpans()`. Telemetry that grows without bound
   * turns an unreachable collector into an out-of-memory kill, which is the
   * observability tool causing the outage.
   */
  maxQueueSize?: number;
  histogramBoundsMs?: readonly number[];
  clock?: Clock;
  /** Injected so a test can assert what would go on the wire. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Where an export failure is reported. Defaults to swallowing it: telemetry
   * that throws into the code it observes is the observation changing the
   * result, and this adapter sits behind an *optional* port precisely so that
   * a broken collector cannot fail a run.
   */
  onExportError?: (error: unknown) => void;
}

export interface OtlpTelemetry extends TelemetryPort {
  /** Export everything buffered. Resolves when the collector has answered, or the attempt failed. */
  flush(): Promise<void>;
  /** Flush, then refuse further spans. Idempotent. */
  shutdown(): Promise<void>;
  /** Spans dropped because the queue was full. Exposed so a host can alert on it. */
  droppedSpans(): number;
}

interface RecordedEvent {
  name: string;
  timeUnixNano: string;
  attributes: Record<string, unknown>;
}

interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  events: RecordedEvent[];
  statusCode: number;
  statusMessage: string | undefined;
}

interface CounterState {
  name: string;
  points: Map<string, { attributes: Attributes; value: number }>;
}

interface HistogramState {
  name: string;
  points: Map<string, { attributes: Attributes; count: number; sum: number; buckets: number[] }>;
}

/**
 * Build the OTLP adapter, already wrapped in the port's redactor.
 *
 * The wrapping happens here rather than being left to the caller because a
 * caller who forgets produces an adapter that works — and exports keys. The
 * unwrapped class is not exported from this module for the same reason.
 */
export function otlpTelemetry(options: OtlpTelemetryOptions): OtlpTelemetry {
  const inner = new OtlpExporter(options);
  const redacted = redactedTelemetry(inner);
  return {
    startSpan: (name, attributes, spanOptions) => redacted.startSpan(name, attributes, spanOptions),
    counter: (name, value, attributes) => redacted.counter(name, value, attributes),
    histogram: (name, value, attributes) => redacted.histogram(name, value, attributes),
    flush: () => inner.flush(),
    shutdown: () => inner.shutdown(),
    droppedSpans: () => inner.droppedSpans(),
  };
}

class OtlpExporter implements TelemetryPort {
  readonly #endpoint: string;
  readonly #maxBatchSize: number;
  readonly #maxQueueSize: number;
  readonly #headers: Record<string, string>;
  readonly #resource: Attributes;
  readonly #bounds: readonly number[];
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;
  readonly #onExportError: (error: unknown) => void;

  readonly #spans: RecordedSpan[] = [];
  readonly #counters = new Map<string, CounterState>();
  readonly #histograms = new Map<string, HistogramState>();
  readonly #startedAtNano: string;

  #dropped = 0;
  #closed = false;
  /** Serialises exports so two flushes cannot interleave and reorder a batch. */
  #inFlight: Promise<void> = Promise.resolve();

  constructor(options: OtlpTelemetryOptions) {
    this.#endpoint = withoutTrailingSlashes(options.endpoint);
    this.#maxBatchSize = options.maxBatchSize ?? 128;
    this.#maxQueueSize = options.maxQueueSize ?? 2048;
    this.#headers = { 'content-type': 'application/json', ...(options.headers ?? {}) };
    this.#resource = { 'service.name': options.serviceName ?? 'forgebridge', ...(options.resourceAttributes ?? {}) };
    this.#bounds = options.histogramBoundsMs ?? DEFAULT_HISTOGRAM_BOUNDS_MS;
    this.#clock = options.clock ?? systemClock;
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!options.fetchImpl && typeof globalFetch !== 'function') {
      throw new Error('telemetry: no fetch is available; pass fetchImpl, or install no OTLP adapter.');
    }
    this.#fetch = options.fetchImpl ?? (globalFetch as typeof fetch);
    this.#onExportError = options.onExportError ?? (() => {});
    this.#startedAtNano = nanosOf(this.#clock());
  }

  droppedSpans(): number {
    return this.#dropped;
  }

  startSpan(name: string, attributes?: Attributes, options?: SpanOptions): Span {
    const parent = options?.parent ?? null;
    const context: SpanContext = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      traceFlags: parent?.traceFlags ?? SAMPLED,
    };
    const record: RecordedSpan = {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: parent?.spanId ?? null,
      name,
      startTimeUnixNano: nanosOf(this.#clock()),
      endTimeUnixNano: '',
      attributes: { ...(attributes ?? {}) },
      events: [],
      statusCode: STATUS_UNSET,
      statusMessage: undefined,
    };

    let ended = false;
    const clock = this.#clock;
    const enqueue = (): void => this.#enqueue(record);

    return {
      setAttributes(next) {
        if (ended) return;
        Object.assign(record.attributes, next);
      },
      addEvent(eventName, eventAttributes) {
        if (ended) return;
        record.events.push({
          name: eventName,
          timeUnixNano: nanosOf(clock()),
          attributes: { ...(eventAttributes ?? {}) },
        });
      },
      recordException(error) {
        if (ended) return;
        // The value arriving here has already been through `redactError` in the
        // port wrapper, so it is a `RedactedError` and not the thrown object.
        // Mapped onto OpenTelemetry's `exception` event so a backend groups it
        // the way it groups every other language's exceptions.
        const shape = error as { name?: unknown; message?: unknown; stack?: unknown };
        const eventAttributes: Record<string, string> = {
          'exception.type': typeof shape?.name === 'string' ? shape.name : 'Error',
          'exception.message': typeof shape?.message === 'string' ? shape.message : String(error),
        };
        if (typeof shape?.stack === 'string') eventAttributes['exception.stacktrace'] = shape.stack;
        record.events.push({ name: 'exception', timeUnixNano: nanosOf(clock()), attributes: eventAttributes });
        record.statusCode = STATUS_ERROR;
      },
      setStatus(status: SpanStatus, message) {
        if (ended) return;
        record.statusCode = status === 'error' ? STATUS_ERROR : STATUS_OK;
        record.statusMessage = message;
      },
      end() {
        // Idempotent: a `finally { span.end() }` under a path that already
        // ended it must not queue the span twice, and a double-counted span is
        // a duplicated latency sample nobody can explain later.
        if (ended) return;
        ended = true;
        record.endTimeUnixNano = nanosOf(clock());
        enqueue();
      },
      context() {
        return context;
      },
    };
  }

  counter(name: string, value: number, attributes?: Attributes): void {
    if (this.#closed || !Number.isFinite(value)) return;
    const state = this.#counters.get(name) ?? { name, points: new Map() };
    const key = pointKey(attributes);
    const point = state.points.get(key) ?? { attributes: attributes ?? {}, value: 0 };
    point.value += value;
    state.points.set(key, point);
    this.#counters.set(name, state);
  }

  histogram(name: string, value: number, attributes?: Attributes): void {
    if (this.#closed || !Number.isFinite(value)) return;
    const state = this.#histograms.get(name) ?? { name, points: new Map() };
    const key = pointKey(attributes);
    const point = state.points.get(key) ?? {
      attributes: attributes ?? {},
      count: 0,
      sum: 0,
      buckets: new Array<number>(this.#bounds.length + 1).fill(0),
    };
    point.count += 1;
    point.sum += value;
    let index = this.#bounds.findIndex((bound) => value <= bound);
    if (index === -1) index = this.#bounds.length;
    point.buckets[index] = (point.buckets[index] ?? 0) + 1;
    state.points.set(key, point);
    this.#histograms.set(name, state);
  }

  #enqueue(record: RecordedSpan): void {
    if (this.#closed) return;
    this.#spans.push(record);
    if (this.#spans.length > this.#maxQueueSize) {
      const overflow = this.#spans.length - this.#maxQueueSize;
      this.#spans.splice(0, overflow);
      this.#dropped += overflow;
    }
    if (this.#spans.length >= this.#maxBatchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    const batch = this.#spans.splice(0, this.#spans.length);
    const metrics = this.#drainMetrics();
    if (batch.length === 0 && metrics === null) return await this.#inFlight;

    const run = async (): Promise<void> => {
      // Nothing in here may reject. `#enqueue` fires an automatic flush with
      // `void this.flush()`, so a rejection would surface as an unhandled
      // rejection — telemetry taking the process down is the observability tool
      // causing the outage, one level up from the queue cap that guards the
      // same failure.
      try {
        if (batch.length > 0) await this.#post('/v1/traces', this.#traceBody(batch));
        if (metrics !== null) await this.#post('/v1/metrics', metrics);
      } catch (error) {
        this.#onExportError(error);
      }
    };
    this.#inFlight = this.#inFlight.then(run, run);
    return await this.#inFlight;
  }

  async shutdown(): Promise<void> {
    await this.flush();
    this.#closed = true;
  }

  async #post(pathSuffix: string, body: unknown): Promise<void> {
    const url = this.#endpoint.endsWith(pathSuffix) ? this.#endpoint : `${this.#endpoint}${pathSuffix}`;
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: this.#headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // The status only. A collector's error body can echo the request, which
        // would put the very attributes we just redacted back into whatever the
        // host does with this error.
        this.#onExportError(new Error(`telemetry: the collector answered ${response.status} for ${pathSuffix}`));
      }
    } catch (error) {
      this.#onExportError(error);
    }
  }

  #traceBody(batch: readonly RecordedSpan[]): unknown {
    return {
      resourceSpans: [
        {
          resource: { attributes: encodeAttributes(this.#resource) },
          scopeSpans: [
            {
              scope: { name: 'forgebridge-core' },
              spans: batch.map((record) => {
                const span: Record<string, unknown> = {
                  traceId: record.traceId,
                  spanId: record.spanId,
                  name: record.name,
                  kind: KIND_INTERNAL,
                  startTimeUnixNano: record.startTimeUnixNano,
                  endTimeUnixNano: record.endTimeUnixNano || record.startTimeUnixNano,
                  attributes: encodeAttributes(record.attributes),
                  events: record.events.map((event) => ({
                    name: event.name,
                    timeUnixNano: event.timeUnixNano,
                    attributes: encodeAttributes(event.attributes),
                  })),
                  status:
                    record.statusMessage === undefined
                      ? { code: record.statusCode }
                      : { code: record.statusCode, message: record.statusMessage },
                };
                if (record.parentSpanId) span['parentSpanId'] = record.parentSpanId;
                return span;
              }),
            },
          ],
        },
      ],
    };
  }

  #drainMetrics(): unknown | null {
    if (this.#counters.size === 0 && this.#histograms.size === 0) return null;
    const now = nanosOf(this.#clock());
    const metrics: unknown[] = [];

    for (const state of this.#counters.values()) {
      metrics.push({
        name: state.name,
        sum: {
          aggregationTemporality: CUMULATIVE,
          isMonotonic: true,
          dataPoints: [...state.points.values()].map((point) => ({
            attributes: encodeAttributes(point.attributes),
            startTimeUnixNano: this.#startedAtNano,
            timeUnixNano: now,
            asDouble: point.value,
          })),
        },
      });
    }

    for (const state of this.#histograms.values()) {
      metrics.push({
        name: state.name,
        histogram: {
          aggregationTemporality: CUMULATIVE,
          dataPoints: [...state.points.values()].map((point) => ({
            attributes: encodeAttributes(point.attributes),
            startTimeUnixNano: this.#startedAtNano,
            timeUnixNano: now,
            count: String(point.count),
            sum: point.sum,
            bucketCounts: point.buckets.map((count) => String(count)),
            explicitBounds: [...this.#bounds],
          })),
        },
      });
    }

    // Cumulative temporality: the accumulators are deliberately not reset here.
    // A collector reading a cumulative sum that restarts at zero on every
    // export reports a rate of nothing.
    return {
      resourceMetrics: [
        {
          resource: { attributes: encodeAttributes(this.#resource) },
          scopeMetrics: [{ scope: { name: 'forgebridge-core' }, metrics }],
        },
      ],
    };
  }
}

/** Milliseconds to the OTLP int64-as-string nanosecond timestamp. */
function nanosOf(millis: number): string {
  return `${Math.trunc(millis)}000000`;
}

function pointKey(attributes: Attributes | undefined): string {
  if (!attributes) return '';
  return Object.keys(attributes)
    .sort()
    .map((name) => `${name}=${String(attributes[name])}`)
    .join(' ');
}

/** OTLP `KeyValue[]`. Integers go out as int64-as-string, per the proto3 JSON mapping. */
export function encodeAttributes(attributes: Record<string, unknown>): unknown[] {
  return Object.entries(attributes).map(([name, value]) => {
    if (typeof value === 'boolean') return { key: name, value: { boolValue: value } };
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key: name, value: { intValue: String(value) } }
        : { key: name, value: { doubleValue: value } };
    }
    return { key: name, value: { stringValue: String(value) } };
  });
}
