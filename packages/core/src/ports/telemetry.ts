/**
 * Telemetry port — OpenTelemetry semantics, no OpenTelemetry dependency (ADR-011).
 *
 * The core emits through this interface and nothing else. The official instance
 * installs a Sentry adapter behind it; a self-hoster installs an OTel adapter, or
 * none at all. Every `TelemetryPort` in the core is optional for exactly that reason:
 * "telemetry is off by default" has to be structural, not a config flag that a
 * later refactor can quietly invert.
 */

/** Deliberately narrow. Objects and arrays invite dumping a whole ChangeSet — or a key — into a span. */
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export type SpanStatus = 'ok' | 'error';

export interface Span {
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  recordException(error: unknown): void;
  setStatus(status: SpanStatus, message?: string): void;
  end(): void;
}

/**
 * Adapters MUST run every attribute, event, and exception through the shared
 * redactor before export. Redaction belongs at the port rather than in each
 * vendor's defaults: a key that has reached a vendor's SDK has already left the
 * machine (THREAT-MODEL T1).
 *
 * TODO(M44): the shared redactor, and the test that feeds known key formats
 * through every log path, do not exist yet. Owner: the observability milestone.
 */
export interface TelemetryPort {
  /** The returned span must be ended by the caller on every path, throws included. */
  startSpan(name: string, attributes?: Attributes): Span;
  counter(name: string, value: number, attributes?: Attributes): void;
  histogram(name: string, value: number, attributes?: Attributes): void;
}
