/**
 * The error-reporter adapter — the vendor half of ADR-011, without the vendor.
 *
 * ADR-011 keeps Sentry because "Sentry's error grouping is genuinely better
 * than raw OTel for triage" — but as *a choice, at the edge*. Two rules follow
 * from that, and this file is what satisfies both at once:
 *
 *   - `scripts/verify-boundaries.ts` B2 bans `@sentry/*` from `packages/core`,
 *     and it is right to: a self-hoster who wanted the OTLP path would still
 *     inherit the dependency.
 *   - An edge deployment that has already initialised its reporting SDK should
 *     not have to reimplement a `TelemetryPort` to use it.
 *
 * So the client is *injected*, structurally typed. `Sentry` — the module object
 * from `@sentry/node`, `@sentry/nextjs` or `@sentry/bun` — satisfies
 * `ErrorReporterClient` as it stands, which means the official instance writes
 *
 *     const telemetry = errorReporterTelemetry({ client: Sentry });
 *
 * in its own tree, where its own dependency lives, and this package never
 * names the vendor in an import.
 *
 * What this adapter is *not*: a tracing backend. It records spans as
 * breadcrumbs and exceptions as captures, because that is what an error
 * reporter is good at. A deployment that wants the full producer-to-plugin
 * trace runs the OTLP adapter as well — the two are independent, and
 * `combinedTelemetry` composes them.
 */
import { systemClock, type Clock } from '../clock.js';
import { SAMPLED, newSpanId, newTraceId } from './ids.js';
import {
  redactedTelemetry,
  type Attributes,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TelemetryPort,
} from '../ports/telemetry.js';

/**
 * The shape an error-reporting SDK has to present. Every member is one Sentry
 * already exports at module scope with these names and these argument
 * positions; `captureMessage` and `addBreadcrumb` are optional so a smaller
 * reporter can satisfy this with one method.
 */
export interface ErrorReporterClient {
  captureException(error: unknown, hint?: ErrorReporterHint): unknown;
  captureMessage?(message: string, level?: string): unknown;
  addBreadcrumb?(breadcrumb: ErrorReporterBreadcrumb): unknown;
}

export interface ErrorReporterHint {
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
}

export interface ErrorReporterBreadcrumb {
  category?: string;
  message?: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface ErrorReporterTelemetryOptions {
  client: ErrorReporterClient;
  /**
   * Attribute keys promoted to tags, because a reporter's search is built on
   * tags and a context blob is not searchable. Defaults to the ids that answer
   * "what happened to this ChangeSet".
   */
  tagAttributes?: readonly string[];
  clock?: Clock;
}

const DEFAULT_TAG_ATTRIBUTES: readonly string[] = [
  'forgebridge.run.id',
  'forgebridge.project.id',
  'forgebridge.changeset.id',
  'forgebridge.error.code',
];

/**
 * Build the adapter, already wrapped in the port's redactor.
 *
 * Wrapped here, not by the caller, for the same reason the OTLP adapter wraps
 * itself: THREAT-MODEL T1's whole claim is that a key never reaches a vendor's
 * SDK, and an adapter that depends on its caller remembering is a claim about
 * discipline rather than about code. Note that this is also why the vendor's
 * own `beforeSend` is not the answer — by the time it runs, the value is
 * already inside the process that exports it.
 */
export function errorReporterTelemetry(options: ErrorReporterTelemetryOptions): TelemetryPort {
  return redactedTelemetry(new ErrorReporterTelemetry(options));
}

class ErrorReporterTelemetry implements TelemetryPort {
  readonly #client: ErrorReporterClient;
  readonly #tagAttributes: ReadonlySet<string>;
  readonly #clock: Clock;

  constructor(options: ErrorReporterTelemetryOptions) {
    this.#client = options.client;
    this.#tagAttributes = new Set(options.tagAttributes ?? DEFAULT_TAG_ATTRIBUTES);
    this.#clock = options.clock ?? systemClock;
  }

  startSpan(name: string, attributes?: Attributes, options?: SpanOptions): Span {
    const parent = options?.parent ?? null;
    const context: SpanContext = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      traceFlags: parent?.traceFlags ?? SAMPLED,
    };
    const collected: Record<string, unknown> = { ...(attributes ?? {}), 'trace.id': context.traceId };
    const startedAt = this.#clock();
    const client = this.#client;
    const tagKeys = this.#tagAttributes;
    const clock = this.#clock;
    let ended = false;

    return {
      setAttributes(next) {
        if (!ended) Object.assign(collected, next);
      },
      addEvent(eventName, eventAttributes) {
        if (ended) return;
        client.addBreadcrumb?.({
          category: 'forgebridge',
          message: eventName,
          level: 'info',
          data: { ...(eventAttributes ?? {}) },
        });
      },
      recordException(error) {
        if (ended) return;
        client.captureException(rebuildError(error), {
          tags: tagsFrom(collected, tagKeys),
          contexts: { forgebridge: { span: name, ...collected } },
        });
      },
      setStatus(status: SpanStatus, message) {
        if (ended) return;
        collected['span.status'] = status;
        if (message !== undefined) collected['span.status.message'] = message;
      },
      end() {
        if (ended) return;
        ended = true;
        client.addBreadcrumb?.({
          category: 'forgebridge.span',
          message: name,
          level: collected['span.status'] === 'error' ? 'error' : 'info',
          data: { ...collected, 'duration.ms': clock() - startedAt },
        });
      },
      context() {
        return context;
      },
    };
  }

  counter(name: string, value: number, attributes?: Attributes): void {
    this.#client.addBreadcrumb?.({
      category: 'forgebridge.metric',
      message: name,
      level: 'info',
      data: { ...(attributes ?? {}), value },
    });
  }

  histogram(name: string, value: number, attributes?: Attributes): void {
    this.counter(name, value, attributes);
  }
}

function tagsFrom(collected: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of keys) {
    const value = collected[key];
    if (value !== undefined) tags[key] = String(value);
  }
  return tags;
}

/**
 * Turn the port's `RedactedError` back into an `Error`.
 *
 * The port hands adapters three redacted strings rather than the thrown object,
 * on purpose — an `Error` subclass can carry a response body or a set of
 * request headers, and a reporter handed the object serialises all of it. But
 * every reporting SDK groups on an `Error`'s constructor name and stack, and
 * given a plain object most of them fall back to "Non-Error exception
 * captured", which destroys exactly the grouping ADR-011 kept the vendor for.
 *
 * So the redacted fields are re-hydrated into a real `Error`. Nothing is
 * recovered that the redactor removed: this reads three strings that have
 * already been scrubbed and writes them onto a fresh object.
 */
function rebuildError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const shape = error as { name?: unknown; message?: unknown; stack?: unknown; causes?: unknown };
  if (typeof shape.message !== 'string' || typeof shape.name !== 'string') return error;

  const causes = Array.isArray(shape.causes) ? shape.causes.filter((entry) => typeof entry === 'string') : [];
  const rebuilt = new Error(causes.length > 0 ? `${shape.message} (caused by: ${causes.join(' <- ')})` : shape.message);
  rebuilt.name = shape.name;
  if (typeof shape.stack === 'string') rebuilt.stack = shape.stack;
  return rebuilt;
}

/**
 * Send the same signal to several adapters.
 *
 * The composition an edge deployment actually wants: OTLP for the trace that
 * crosses four processes, an error reporter for triage. Written here rather
 * than left to each host because getting it wrong — ending a span on one
 * adapter and not the other — produces a trace that is subtly incomplete in a
 * way nobody notices until they need it.
 *
 * Each member is called even if an earlier one throws; the first error is
 * rethrown after the rest have run, so a broken adapter cannot silently
 * suppress a working one.
 */
export function combinedTelemetry(members: readonly TelemetryPort[]): TelemetryPort {
  const fanOut = (act: (member: TelemetryPort) => void): void => {
    let first: unknown;
    for (const member of members) {
      try {
        act(member);
      } catch (error) {
        if (first === undefined) first = error;
      }
    }
    if (first !== undefined) throw first;
  };

  return {
    startSpan(name, attributes, options) {
      const spans: Span[] = [];
      fanOut((member) => {
        spans.push(member.startSpan(name, attributes, options));
      });
      const primary = spans[0];
      if (!primary) {
        throw new Error('combinedTelemetry: no adapters were given, so there is no span to return');
      }
      return {
        setAttributes: (next) => {
          for (const span of spans) span.setAttributes(next);
        },
        addEvent: (eventName, eventAttributes) => {
          for (const span of spans) span.addEvent(eventName, eventAttributes);
        },
        recordException: (error) => {
          for (const span of spans) span.recordException(error);
        },
        setStatus: (status, message) => {
          for (const span of spans) span.setStatus(status, message);
        },
        end: () => {
          for (const span of spans) span.end();
        },
        // The first member's identity is the one propagated. Members do not
        // share a span id, and inventing a fourth one that belongs to no
        // adapter would put a parent in the trace that never existed.
        context: () => primary.context(),
      };
    },
    counter(name, value, attributes) {
      fanOut((member) => member.counter(name, value, attributes));
    },
    histogram(name, value, attributes) {
      fanOut((member) => member.histogram(name, value, attributes));
    },
  };
}
