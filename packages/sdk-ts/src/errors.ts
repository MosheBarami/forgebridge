/**
 * The failure surface of this SDK: two kinds, and one total classifier.
 *
 * The split is the same one `packages/sdk-python` makes, for the same reason. A
 * `ForgeBridgeError` is an *answer* — the daemon read the request, decided, and
 * said so in a code from a closed set. A `TransportError` is the *absence* of
 * one — nothing answered, or what answered was not a `/v1` reply. Those two
 * demand different things of a caller: the first is branched on, the second is
 * retried or reported. Collapsing them into one class is how a socket timeout
 * ends up being read as a refusal.
 */
import { ForgeBridgeError, ProtocolError, type ErrorCode } from '@forgebridge/protocol';

export { ForgeBridgeError };
export type { ErrorCode };

/**
 * A `/v1` call that came back with a protocol error body.
 *
 * Extends the protocol's own error class rather than declaring a rival one, so
 * that `catch (e) { if (e instanceof ForgeBridgeError) … }` written against any
 * other ForgeBridge package catches this too.
 *
 * `httpStatus` is the status the answer actually arrived with, which is not
 * necessarily `ForgeBridgeError.status` — that one is the canonical status for
 * the code. They agree today; recording the observed one means a disagreement
 * shows up as a fact rather than being erased by the lookup.
 */
export class ForgeBridgeResponseError extends ForgeBridgeError {
  readonly httpStatus: number;

  constructor(payload: ProtocolError, httpStatus: number) {
    super(payload.code, payload.message, payload.remedy);
    this.name = 'ForgeBridgeResponseError';
    this.httpStatus = httpStatus;
  }
}

/**
 * The call never reached a `/v1` handler, or what came back was not a `/v1`
 * answer.
 *
 * A 2xx whose body does not match the contract lands here too, and that is
 * deliberate: a body this build cannot parse is not an answer it can act on, and
 * inventing an `ErrorCode` for it would put a refusal in the caller's hands that
 * the daemon never made.
 */
export class TransportError extends Error {
  /** Set when there was an answer, and it was unreadable rather than absent. */
  readonly httpStatus: number | undefined;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'TransportError';
    this.httpStatus = httpStatus;
  }
}

/**
 * A method and the generated route table disagree.
 *
 * Not a network condition and not a user error — a defect in this package,
 * raised loudly instead of parsing a response against the wrong schema. Every
 * call in `client.ts` names the schema it expects and the operation it is
 * calling, and the two are checked against `ROUTES` before a request goes out;
 * this is what that check throws.
 */
export class RouteContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteContractError';
  }
}

/** One failure, reduced to the thing a caller branches on. */
export interface ErrorView {
  /**
   * Always a member of `ErrorCode`. The set is closed so a caller can branch on
   * it, and a classifier that could answer with something else would hand back a
   * value no branch matches.
   */
  code: ErrorCode;
  /**
   * Whether this was *read* as a protocol error, or defaulted.
   *
   * An unrecognised failure reported as `internal` is correct. The same failure
   * reported as `not_approved` would be this SDK inventing an approval decision
   * out of a dropped connection, which is the difference this field exists to
   * keep visible.
   */
  recognised: boolean;
  /** The HTTP status the answer arrived with, when there was an answer. */
  httpStatus?: number;
  message?: string;
  remedy?: string;
}

/**
 * Classify anything this package can hand back.
 *
 * Two properties are load-bearing, and both are asserted in `test/errors.test.ts`.
 *
 * It is **total**: every input returns a view and none raises. A classifier that
 * can fail is one a caller cannot use inside the `catch` block that is the only
 * place it is ever called.
 *
 * And it reads a **raw `ProtocolError` payload** as well as a thrown error. A
 * classifier that only understands its own exception type has a mapping that
 * works in its own tests and nowhere else — which is exactly what the
 * conformance suite's `error-codes-total` case checks, by feeding every code
 * twice: once thrown, once as the JSON body the daemon actually sends.
 */
export function describeError(error: unknown): ErrorView {
  if (error instanceof ForgeBridgeError) {
    const httpStatus = error instanceof ForgeBridgeResponseError ? error.httpStatus : error.status;
    return {
      code: error.code,
      recognised: true,
      httpStatus,
      message: error.message,
      ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
    };
  }

  if (error instanceof TransportError) {
    // TODO(M31): `ErrorCode` has no member for "the transport is not reachable",
    // so this lands on `internal` and carries the truth in its remedy — the same
    // gap `packages/sdk-python/src/forgebridge/errors.py` names. Owner: the
    // protocol maintainer, as an additive change. `recognised` stays false: this
    // is not a protocol error, it is the absence of one.
    return {
      code: 'internal',
      recognised: false,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      message: error.message,
      remedy: 'The call did not produce a /v1 answer. Check that the daemon is running and that baseUrl points at it.',
    };
  }

  const parsed = ProtocolError.safeParse(error);
  if (parsed.success) {
    return {
      code: parsed.data.code,
      recognised: true,
      message: parsed.data.message,
      ...(parsed.data.remedy === undefined ? {} : { remedy: parsed.data.remedy }),
    };
  }

  return {
    code: 'internal',
    recognised: false,
    message: error instanceof Error ? `${error.name}: ${error.message}` : `an unrecognised failure: ${String(error)}`,
  };
}
