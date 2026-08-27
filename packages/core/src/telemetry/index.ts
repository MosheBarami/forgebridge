/**
 * Telemetry adapters, and the one function that decides whether there are any.
 *
 * ADR-011: "Telemetry is **off by default** for local and self-hosted
 * installs", and "a privacy promise that the core itself violates is not a
 * promise. Off-by-default has to be structural."
 *
 * `telemetryFromEnvironment` is the structure. It returns `undefined` unless an
 * operator named a collector, and every `TelemetryPort` in the core is optional
 * so that `undefined` is a complete answer rather than a disabled feature. There
 * is no `enabled: false` anywhere in this package, because a boolean is a thing
 * a later refactor can default the other way.
 */
export {
  DEFAULT_HISTOGRAM_BOUNDS_MS,
  encodeAttributes,
  otlpTelemetry,
  type OtlpTelemetry,
  type OtlpTelemetryOptions,
} from './otlp.js';
export {
  combinedTelemetry,
  errorReporterTelemetry,
  type ErrorReporterBreadcrumb,
  type ErrorReporterClient,
  type ErrorReporterHint,
  type ErrorReporterTelemetryOptions,
} from './reporter.js';
export { SAMPLED, newSpanId, newTraceId } from './ids.js';

import { namesCredential, registerKnownSecret } from '../ports/redact.js';
import { otlpTelemetry, type OtlpTelemetry, type OtlpTelemetryOptions } from './otlp.js';

/** The subset of `process.env` this reads. Passed in so the core touches no global. */
export type TelemetryEnvironment = Readonly<Record<string, string | undefined>>;

export interface TelemetryFromEnvironmentOptions {
  /** Forwarded to the OTLP adapter. `endpoint` comes from the environment and cannot be overridden here. */
  overrides?: Omit<Partial<OtlpTelemetryOptions>, 'endpoint'>;
}

/**
 * Build an OTLP adapter if — and only if — the environment names a collector.
 *
 * Reads the standard OpenTelemetry variables, so an operator who already runs a
 * collector configures this the way they configure everything else:
 *
 *   `OTEL_SDK_DISABLED=true`             turn it off however else it is configured
 *   `OTEL_EXPORTER_OTLP_ENDPOINT`        e.g. http://localhost:4318
 *   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` wins over the general one when set
 *   `OTEL_SERVICE_NAME`                  defaults to `forgebridge`
 *   `OTEL_EXPORTER_OTLP_HEADERS`         `key=value,key2=value2`
 *
 * A malformed endpoint throws rather than returning `undefined`. The two
 * outcomes must stay distinguishable: "no telemetry was asked for" and "you
 * asked for telemetry and it is silently not happening" are different facts,
 * and a function that answered `undefined` to both would make the second one
 * invisible for as long as it took someone to notice an empty dashboard.
 */
export function telemetryFromEnvironment(
  environment: TelemetryEnvironment,
  options: TelemetryFromEnvironmentOptions = {},
): OtlpTelemetry | undefined {
  if (isTrue(environment['OTEL_SDK_DISABLED'])) return undefined;

  const raw = first(
    environment['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    environment['OTEL_EXPORTER_OTLP_ENDPOINT'],
  );
  if (raw === undefined) return undefined;

  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    // The value is not echoed. An endpoint can carry credentials in its
    // userinfo, and an error message is a log line.
    throw new Error(
      'telemetry: OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL. ' +
        'Set it to a collector base URL such as http://localhost:4318, or unset it to run without telemetry.',
    );
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(
      `telemetry: OTEL_EXPORTER_OTLP_ENDPOINT must be http or https; "${endpoint.protocol}" is neither. ` +
        'This adapter speaks OTLP/HTTP, not OTLP/gRPC.',
    );
  }

  const headers = parseHeaders(environment['OTEL_EXPORTER_OTLP_HEADERS']);
  for (const [name, value] of Object.entries(headers)) {
    // A collector behind an auth proxy is configured with a bearer token here.
    // Registering it means the redactor scrubs that exact value out of any span
    // it later appears in — an error message quoting the request that failed,
    // most obviously.
    //
    // Only credential-named headers are registered, and that restraint is the
    // point: `content-type=application/json` is sixteen characters and would
    // otherwise be registered as a secret, turning every span that mentions a
    // content type into `[redacted]`. A redactor that fires on ordinary values
    // trains people to ignore it, which is the same outcome as no redactor.
    if (namesCredential(name)) registerKnownSecret(value);
  }

  const serviceName = environment['OTEL_SERVICE_NAME'];
  return otlpTelemetry({
    ...(options.overrides ?? {}),
    endpoint: endpoint.toString(),
    ...(serviceName ? { serviceName } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}

function first(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function isTrue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` is a comma-separated `key=value` list. A pair
 * with no `=` is dropped rather than guessed at: half a header is not a header,
 * and inventing an empty value for it would send a request the operator did not
 * describe.
 */
function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value) return headers;
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const entry = pair.slice(at + 1).trim();
    if (name === '' || entry === '') continue;
    headers[name.toLowerCase()] = entry;
  }
  return headers;
}
