/**
 * What this package raises when Open Cloud says no — and the one rule that
 * governs every string in this file.
 *
 * **An error may name the endpoint, the status and whatever the service said.
 * It may never name the credential.** An API key that reaches a stack trace
 * reaches a log aggregator, a bug report and a screenshot, and the promise in
 * `README.md` that keys stay with the user does not survive any of those. So
 * the key is not a field on this class, is not interpolated into any message
 * here, and `test/custody.test.ts` pushes a key through every failure path in
 * the package and asserts it comes out of none of them.
 *
 * The second rule is the one five rounds of review keep re-teaching this
 * repository: *a check that does not understand a response must not report
 * success*. `OpenCloudError` is therefore raised for three different things
 * that all end the same way — the service refused, the service answered in a
 * shape this package cannot read, or the transport never got an answer — and
 * `kind` distinguishes them so a caller can retry the third without pretending
 * the second was fine.
 */

/** Which of the three failure modes this is. */
export type OpenCloudErrorKind =
  /** The service answered, with a status this package treats as a refusal. */
  | 'refused'
  /**
   * The service answered with a status that usually means success, and a body
   * or header set this package cannot read as the documented shape. Never
   * treated as success: an unreadable "OK" and a real "OK" must not be the
   * same answer.
   */
  | 'unreadable'
  /** `fetch` rejected, or the request was abandoned before an answer arrived. */
  | 'transport';

export interface OpenCloudErrorInit {
  kind: OpenCloudErrorKind;
  /** Method and path, e.g. `POST /universes/v1/1/places/2/versions`. Never the query string: it carries entry keys. */
  operation: string;
  /** HTTP status, when there was one. */
  status?: number;
  /** The service's own error code, when it sent one this package could read. */
  code?: string;
  /** Seconds from a `retry-after` header, when the service sent a usable one. */
  retryAfterSeconds?: number;
  /** The service's message, truncated. Never contains the key: it is the service's text, not ours. */
  detail?: string;
  cause?: unknown;
}

/**
 * The only error type this package throws on purpose.
 *
 * `TypeError` and friends from a caller's own bad arguments are thrown by the
 * argument validators as plain `Error`s, because those are programming faults
 * in the calling code rather than answers from a service, and conflating the
 * two would let a caller `catch (OpenCloudError)` and swallow their own bug.
 */
export class OpenCloudError extends Error {
  readonly kind: OpenCloudErrorKind;
  readonly operation: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly detail: string | undefined;

  constructor(init: OpenCloudErrorInit) {
    super(formatMessage(init), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'OpenCloudError';
    this.kind = init.kind;
    this.operation = init.operation;
    this.status = init.status;
    this.code = init.code;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.detail = init.detail;
  }

  /**
   * Whether *this exact request* may be sent again unchanged.
   *
   * Deliberately narrow, and deliberately not a property of the status alone.
   * A 429 on a read is safe to repeat; a 429 on `incrementEntry` is safe to
   * repeat only because the service refused it outright. A *transport* failure
   * on `incrementEntry` is not safe to repeat at all — the counter may have
   * moved and the answer was lost — so `retryable` is false for transport
   * failures and the decision is made per call site in `client.ts`, where
   * idempotence is known, rather than guessed at here.
   */
  get retryable(): boolean {
    if (this.kind !== 'refused') return false;
    return this.status === 429 || (this.status !== undefined && this.status >= 500 && this.status <= 599);
  }
}

function formatMessage(init: OpenCloudErrorInit): string {
  const parts = [`${init.operation}:`];
  switch (init.kind) {
    case 'refused':
      parts.push(`Open Cloud refused with HTTP ${init.status ?? 0}`);
      break;
    case 'unreadable':
      parts.push(
        `Open Cloud answered HTTP ${init.status ?? 0} in a shape this client cannot read, ` +
          'so the call is reported as failed rather than as a success nobody verified',
      );
      break;
    case 'transport':
      parts.push('the request did not reach Open Cloud, or its answer did not come back');
      break;
  }
  if (init.code !== undefined && init.code !== '') parts.push(`(code ${init.code})`);
  if (init.detail !== undefined && init.detail !== '') parts.push(`— ${init.detail}`);
  if (init.retryAfterSeconds !== undefined) parts.push(`— retry after ${init.retryAfterSeconds}s`);
  return parts.join(' ');
}

/**
 * The most a body is allowed to contribute to an error message.
 *
 * Bounded because the body is attacker-influenced in the general case (an entry
 * key echoed back, a proxy's HTML error page), and an unbounded string
 * concatenated into an exception is how a log line becomes a megabyte.
 */
export const MAX_DETAIL_LENGTH = 400;

/**
 * Read whatever the service said into `code` and `detail`, treating every field
 * as absent until proven present.
 *
 * The legacy `/v1` families document an error envelope with `error`, `message`
 * and `errorDetails`, and the newer `/cloud/v2` surface uses a different one.
 * Rather than encode a taxonomy this package cannot verify end to end, it reads
 * the field names it has seen and falls back to the raw text — and it never
 * lets the *absence* of a recognised shape turn a refusal into anything other
 * than a refusal.
 *
 * TODO(M48): the exact `errorDetails[].datastoreErrorCode` enumeration is not
 * reproduced here. It is documented per-endpoint rather than in one place, and
 * this client has no way to exercise every branch of it without a live
 * universe, so the codes are passed through as strings instead of being
 * narrowed to a union that would be wrong the first time Roblox adds one.
 */
export function readErrorEnvelope(status: number, bodyText: string): { code?: string; detail?: string } {
  const trimmed = bodyText.trim();
  if (trimmed === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON. An HTML error page from a proxy in front of Open Cloud lands
    // here, and the first line of it is more use to a reader than nothing.
    return { detail: truncate(trimmed) };
  }

  if (typeof parsed !== 'object' || parsed === null) return { detail: truncate(trimmed) };
  const record = parsed as Record<string, unknown>;

  const code = firstString(record['code'], record['error'], record['errorCode']);
  const detail = firstString(record['message'], record['errorMessage'], record['detail']);

  const nested = record['errorDetails'];
  const nestedCode = Array.isArray(nested)
    ? firstString(...nested.map((entry) => (isRecord(entry) ? entry['datastoreErrorCode'] : undefined)))
    : undefined;

  const out: { code?: string; detail?: string } = {};
  const chosenCode = code ?? nestedCode;
  if (chosenCode !== undefined) out.code = truncate(chosenCode, 120);
  out.detail = detail === undefined ? truncate(trimmed) : truncate(detail);
  if (status === 0) delete out.detail;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

function truncate(value: string, limit: number = MAX_DETAIL_LENGTH): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/**
 * Seconds from a `retry-after` header, or undefined when the header is absent
 * or says something this client cannot act on.
 *
 * Undefined rather than a default, on purpose. A caller that invents "wait 60
 * seconds" because the header was unparseable has invented a number the service
 * never sent, and the retry loop in `client.ts` falls back to its own declared
 * backoff instead — which is a number the operator chose.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((at - now) / 1000));
}
