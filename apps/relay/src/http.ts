import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  ForgeBridgeError,
  HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  type ProtocolError,
} from '@forgebridge/protocol';

/**
 * HTTP plumbing for the relay.
 *
 * The body-reading, error-shaping and content-type halves are a copy of
 * `packages/daemon/src/http.ts`, for the reason given at the top of
 * `envelope.ts`: the daemon package cannot be imported without importing a
 * model router, and two transports answering the same protocol must shape their
 * refusals identically or a client has learned two error formats.
 * `test/drift.test.ts` runs both over the same inputs.
 *
 * What is NOT copied is everything the daemon derives from being on loopback.
 * `hostIsLoopback` is the daemon's whole network trust story and it has no
 * relay equivalent — this process is meant to be reachable from the internet.
 * In its place are the two questions a public deployment has to answer and a
 * loopback one never does, both below and both failing closed: was this hop
 * actually TLS, and whose address is this really.
 */

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  [PROTOCOL_VERSION_HEADER.toLowerCase()]: PROTOCOL_VERSION,
};

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...extraHeaders,
    'content-length': Buffer.byteLength(payload, 'utf8'),
  });
  res.end(payload);
}

export function writeEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    [PROTOCOL_VERSION_HEADER.toLowerCase()]: PROTOCOL_VERSION,
    ...extraHeaders,
  });
  res.end();
}

/**
 * Every failure leaves as a `ProtocolError`, and an unrecognised throw becomes
 * a bare `internal` with no detail attached. On a shared host this is stricter
 * than a debugging preference: a stack trace or a path from a relay is a
 * message about somebody else's tenancy as often as about the caller's own.
 */
export function writeError(res: ServerResponse, error: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = errorPayload(error);
  writeJson(res, error instanceof ForgeBridgeError ? error.status : HTTP_STATUS.internal, body, extraHeaders);
}

export function errorPayload(error: unknown): ProtocolError {
  if (error instanceof ForgeBridgeError) return error.toPayload();
  return { code: 'internal', message: 'the relay failed to handle this request' };
}

/** `ProtocolError.message` is capped at 500 characters by the schema. */
export const MAX_ERROR_MESSAGE_CHARS = 500;

/** Room enough to name the offending field, short enough that three fit. */
const MAX_ISSUE_CHARS = 120;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Turn a Zod failure into a message a human can act on without dumping the
 * whole issue tree, which for a ChangeSet can be thousands of entries.
 *
 * Both the individual issues and the composed message are clipped, because Zod
 * messages quote the input and the input is not bounded before it is rejected.
 * A caller choosing the size of the error it gets back is the shape of a
 * resource-exhaustion bug, not a formatting one.
 */
export function invalidRequest(what: string, error: z.ZodError): ForgeBridgeError {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.join('.');
    return clip(path ? `${path}: ${issue.message}` : issue.message, MAX_ISSUE_CHARS);
  });
  const more = error.issues.length > issues.length ? ` (+${error.issues.length - issues.length} more)` : '';
  return new ForgeBridgeError(
    'invalid_request',
    clip(`${clip(what, MAX_ISSUE_CHARS)} failed schema validation — ${issues.join('; ')}${more}`, MAX_ERROR_MESSAGE_CHARS),
    'Fix the fields named above and resubmit.',
  );
}

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidRequest(what, result.error);
  return result.data;
}

/**
 * Read a body with a hard ceiling.
 *
 * The declared length is checked first so an oversized upload is refused on its
 * headers, and the running total is checked too because `Content-Length` is a
 * claim by the sender, not a fact.
 */
export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      throw new ForgeBridgeError('invalid_request', 'Content-Length is not a valid length');
    }
    if (length > limitBytes) {
      throw new ForgeBridgeError('too_large', `body exceeds the ${limitBytes} byte limit`, 'Split the work into staged ChangeSets.');
    }
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', fail);
      reject(error);
    };

    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > limitBytes) {
        fail(new ForgeBridgeError('too_large', `body exceeds the ${limitBytes} byte limit`, 'Split the work into staged ChangeSets.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    }

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', fail);
    req.once('aborted', () => fail(new ForgeBridgeError('invalid_request', 'the client aborted the request')));
  });
}

export async function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  requireJsonContentType(req);
  const body = await readBody(req, limitBytes);
  if (body.length === 0) {
    throw new ForgeBridgeError('invalid_request', 'a JSON body is required');
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ForgeBridgeError('invalid_request', 'body is not valid JSON');
  }
}

/**
 * Insisting on `application/json` is a CSRF control, not a formality.
 *
 * A form or `text/plain` POST is a *simple* cross-origin request: the browser
 * sends it with no preflight, so any page could drive this relay on a logged-in
 * user's behalf if the content type were not checked. `application/json` cannot
 * be sent cross-origin without a preflight the origin check will refuse.
 */
export function requireJsonContentType(req: IncomingMessage): void {
  const raw = req.headers['content-type'];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new ForgeBridgeError(
      'invalid_request',
      'Content-Type must be application/json',
      'Set Content-Type: application/json on requests with a body.',
    );
  }
}

/**
 * Cross-origin browser callers are refused unless the operator named them.
 *
 * Roblox Studio's HttpService sends no Origin, so the consumer is unaffected.
 * A relay serves a browser app, so this list is normally non-empty — but it is
 * still the operator's list, never `*`: the routes behind it carry a bearer
 * token, and `*` plus a bearer token is a token any page can spend.
 */
export function originIsAllowed(
  originHeader: string | string[] | undefined,
  allowed: readonly string[],
): boolean {
  const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!raw) return true;
  if (raw === 'null') return false;
  return allowed.includes(raw);
}

export function corsHeadersFor(origin: string | undefined, allowed: readonly string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers':
      'content-type, x-forgebridge-link, x-forgebridge-mac, x-forgebridge-token, x-forgebridge-plugin, x-forgebridge-protocol',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

// ── the two questions a public deployment has to answer ──────────────────────

/**
 * How many proxies sit in front of this process.
 *
 * `0` means none, and `0` is the default. It is the number that decides whether
 * `X-Forwarded-For` and `X-Forwarded-Proto` are evidence or decoration, and
 * getting it wrong in the permissive direction is the single cheapest way to
 * disable every per-IP limit in this app: a header any client can set, believed
 * by a relay that has no proxy, means every request can claim a fresh address.
 *
 * So the relay does not sniff for a proxy and does not guess. Absent an
 * explicit hop count from the operator, forwarded headers are ignored outright
 * and the socket address is the client address — which behind an unconfigured
 * proxy makes every request look like it came from the proxy and rate limits
 * the whole world as one caller. That failure is loud, uniform, and safe; the
 * opposite failure is silent and unlimited.
 */
export interface ProxyTrust {
  /** Number of trusted proxies between the client and this process. */
  hops: number;
}

export const NO_PROXY: ProxyTrust = { hops: 0 };

/**
 * The client address a rate limit is keyed on.
 *
 * With `hops: n`, the address is the n-th entry from the RIGHT of
 * `X-Forwarded-For` — the last `n` entries were written by proxies we trust,
 * and everything to the left of them was written by someone we do not. Reading
 * the left-most entry instead, which is the common shortcut, reads the value
 * the *client* supplied and is exactly the bypass described above.
 *
 * A header too short to satisfy the configured hop count is a misconfiguration
 * or a stripped header, and either way the honest answer is the socket address
 * rather than the best available guess.
 */
export function clientAddress(req: IncomingMessage, trust: ProxyTrust = NO_PROXY): string {
  const socketAddress = req.socket.remoteAddress ?? 'unknown';
  if (trust.hops <= 0) return socketAddress;

  const raw = headerValue(req, 'x-forwarded-for');
  if (!raw) return socketAddress;
  const chain = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const index = chain.length - trust.hops;
  if (index < 0 || index >= chain.length) return socketAddress;
  return chain[index] ?? socketAddress;
}

/**
 * Whether the hop that reached the client was TLS.
 *
 * `relay-tls` is the name of this transport and `PRIVACY_POSTURE` renders it to
 * a user, so it is a claim, and a claim gets checked. The process itself speaks
 * plain HTTP — TLS is terminated by the proxy in front of it — which means the
 * only evidence available is `X-Forwarded-Proto`, and that is evidence only
 * from a proxy the operator has vouched for.
 *
 * Three states, and the third is the one that matters: TLS confirmed, TLS
 * explicitly waived for local development, or *unknown* — and unknown is
 * refused. A relay that cannot tell whether it is behind TLS and serves anyway
 * is a relay whose transport name is a guess.
 */
export function tlsEvidence(req: IncomingMessage, trust: ProxyTrust): 'tls' | 'plaintext' | 'unknown' {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return 'tls';
  if (trust.hops <= 0) return 'unknown';
  const proto = headerValue(req, 'x-forwarded-proto');
  if (!proto) return 'unknown';
  // A proxy chain writes one entry per hop here too; the right-most is ours.
  const last = proto.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).pop();
  if (last === 'https') return 'tls';
  if (last === 'http') return 'plaintext';
  return 'unknown';
}
