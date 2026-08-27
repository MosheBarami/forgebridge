/**
 * Telemetry port — OpenTelemetry semantics, no OpenTelemetry dependency (ADR-011).
 *
 * The core emits through this interface and nothing else. An edge deployment
 * installs an error-reporting adapter behind it; a self-hoster installs the OTLP
 * adapter, or none at all. Every `TelemetryPort` in the core is optional for
 * exactly that reason: "telemetry is off by default" has to be structural, not a
 * config flag that a later refactor can quietly invert.
 *
 * `telemetryFromEnvironment` in `../telemetry/index.js` is the other half of
 * that promise: with no endpoint configured it returns `undefined`, so the
 * default install has no adapter to turn off.
 */
import {
  REDACTED,
  redactAttributes,
  redactError,
  redactText,
  type RedactedError,
} from './redact.js';

/** Deliberately narrow. Objects and arrays invite dumping a whole ChangeSet — or a key — into a span. */
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export type SpanStatus = 'ok' | 'error';

/**
 * A span's identity, in W3C Trace Context terms.
 *
 * Present on the port rather than buried in an adapter because the whole point
 * of M44 is that one trace answers "what happened to this ChangeSet" across
 * four processes: producer → core → transport → plugin. A trace that stops at a
 * process boundary is four traces, and correlating them by timestamp is the
 * guesswork ADR-011 rejected option B for.
 */
export interface SpanContext {
  /** 32 lowercase hex characters, never all zeroes. */
  traceId: string;
  /** 16 lowercase hex characters, never all zeroes. */
  spanId: string;
  /** W3C trace flags. Bit 0 is "sampled". */
  traceFlags: number;
}

export interface SpanOptions {
  /**
   * The parent this span continues. `null` and absent both mean "start a new
   * trace" — a caller that could not parse an incoming `traceparent` passes
   * null rather than a fabricated one, because an invented parent id links this
   * work to a trace that does not exist.
   */
  parent?: SpanContext | null;
}

export interface Span {
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  recordException(error: unknown): void;
  setStatus(status: SpanStatus, message?: string): void;
  end(): void;
  /**
   * This span's identity, for propagation to the next process.
   *
   * Required, not optional: an adapter that cannot name its own span cannot be
   * propagated to, and a port where propagation is optional produces traces
   * that are whole on some deployments and broken on others — which is worse
   * than no propagation, because nobody can tell which they are looking at.
   */
  context(): SpanContext;
}

/**
 * Adapters MUST NOT be handed to the core directly. `redactedTelemetry` below
 * wraps one so that every attribute, event, exception and metric label is
 * scrubbed before it reaches a vendor's SDK, and both adapters in
 * `../telemetry/` wrap themselves in their own constructors.
 *
 * Redaction belongs at the port rather than in each vendor's defaults: a key
 * that has reached a vendor's SDK has already left the machine (THREAT-MODEL
 * T1), so `beforeSend` is too late by construction. See `redact.ts` for the
 * three rules and for what they do not cover.
 */
export interface TelemetryPort {
  /** The returned span must be ended by the caller on every path, throws included. */
  startSpan(name: string, attributes?: Attributes, options?: SpanOptions): Span;
  counter(name: string, value: number, attributes?: Attributes): void;
  histogram(name: string, value: number, attributes?: Attributes): void;
}

/**
 * The attribute keys the core emits, in one place.
 *
 * Two call sites spelling `forgebridge.changeset.id` two ways produce two
 * columns in every backend and no way to join them — which is the failure this
 * milestone exists to prevent. The names follow OpenTelemetry's convention:
 * lowercase, dot-separated, namespaced by this project rather than by a vendor.
 */
export const TELEMETRY = {
  RUN_ID: 'forgebridge.run.id',
  PROJECT_ID: 'forgebridge.project.id',
  CHANGE_SET_ID: 'forgebridge.changeset.id',
  LINK_ID: 'forgebridge.link.id',
  STAGE: 'forgebridge.run.stage',
  PRODUCER: 'forgebridge.producer.kind',
  ROUTING_POLICY: 'forgebridge.routing.policy',
  MODEL_ID: 'forgebridge.model.id',
  MODEL_PROVIDER: 'forgebridge.model.provider',
  ATTEMPT_OUTCOME: 'forgebridge.attempt.outcome',
  OPERATION_COUNT: 'forgebridge.changeset.operations',
  BASE_VERSION: 'forgebridge.changeset.base_version',
  TRANSPORT_KIND: 'forgebridge.transport.kind',
  DELIVERY_NONCE: 'forgebridge.transport.nonce',
  ERROR_CODE: 'forgebridge.error.code',
} as const;

// ── W3C Trace Context ────────────────────────────────────────────────────────

export const TRACEPARENT_HEADER = 'traceparent';

const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Serialise a span's identity for the next process. */
export function formatTraceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * Parse an incoming `traceparent`, or return null.
 *
 * Fail closed in the sense this repository means it: an unparseable header is a
 * finding, not a pass. Every rejection path returns null — never a partially
 * salvaged context, never a fresh id presented as the caller's — so "I could
 * not read this" and "the caller sent nothing" produce the same, honest
 * outcome: a new trace, unlinked, rather than a link to a trace that does not
 * exist.
 *
 * The all-zero ids are rejected explicitly: the spec defines them as invalid,
 * and a backend joining on `00000000…` would merge every unrelated trace that
 * ever hit a buggy client.
 */
export function parseTraceparent(value: string | null | undefined): SpanContext | null {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match as unknown as [string, string, string, string, string];
  // `ff` is forbidden by the spec; any other version is a future one whose
  // first four fields are guaranteed to mean what they mean here.
  if (version === 'ff') return null;
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
}

// ── The redaction wrapper ────────────────────────────────────────────────────

/**
 * Wrap an adapter so nothing reaches it unscrubbed.
 *
 * This is the enforcement of the sentence above `TelemetryPort`. It is a
 * wrapper rather than a convention because a convention is a thing each adapter
 * author has to remember: ADR-011 says the redaction "must be implemented once
 * at the port", and once means here.
 *
 * Span *names* are scrubbed as well as attributes. A caller that builds a span
 * name out of a URL — `fetch https://user:pass@host/v1` — would otherwise put
 * the credential in the one field every backend indexes.
 */
export function redactedTelemetry(inner: TelemetryPort): TelemetryPort {
  return {
    startSpan(name, attributes, options) {
      return wrapSpan(inner.startSpan(redactText(name), redactAttributes(attributes), options));
    },
    counter(name, value, attributes) {
      inner.counter(redactText(name), value, redactAttributes(attributes));
    },
    histogram(name, value, attributes) {
      inner.histogram(redactText(name), value, redactAttributes(attributes));
    },
  };
}

function wrapSpan(inner: Span): Span {
  return {
    setAttributes(attributes) {
      inner.setAttributes(redactAttributes(attributes));
    },
    addEvent(name, attributes) {
      inner.addEvent(redactText(name), redactAttributes(attributes));
    },
    recordException(error) {
      // The adapter never sees the thrown object. An `Error` subclass can carry
      // a response body, a request, or a set of headers on it, and an adapter
      // handed the object will serialise all of them.
      inner.recordException(redactError(error));
    },
    setStatus(status, message) {
      inner.setStatus(status, message === undefined ? undefined : redactText(message));
    },
    end() {
      inner.end();
    },
    context() {
      return inner.context();
    },
  };
}

export { REDACTED, redactAttributes, redactError, redactText, type RedactedError };
export {
  MAX_ATTRIBUTE_CHARS,
  VALUE_RULES,
  forgetKnownSecrets,
  namesCredential,
  redactAttributeValue,
  registerKnownSecret,
  type RedactionRule,
} from './redact.js';
