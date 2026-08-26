import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  ForgeBridgeError,
  HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  type ProtocolError,
} from '@forgebridge/protocol';

/** The only interface this daemon ever binds. Not configurable, by design. */
export const LOOPBACK_HOST = '127.0.0.1' as const;

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
 * a bare `internal` with no detail attached — a message that leaks a path or a
 * stack out of a process that holds the user's keys is a finding, not a
 * debugging convenience.
 */
export function writeError(res: ServerResponse, error: unknown, extraHeaders: Record<string, string> = {}): void {
  if (error instanceof ForgeBridgeError) {
    writeJson(res, error.status, error.toPayload(), extraHeaders);
    return;
  }
  const body: ProtocolError = { code: 'internal', message: 'the daemon failed to handle this request' };
  writeJson(res, HTTP_STATUS.internal, body, extraHeaders);
}

/**
 * `ProtocolError.message` is capped at 500 characters by the schema. An error
 * that overflows its own contract is one a strict client rejects instead of
 * showing, so the cap is enforced here rather than hoped for.
 */
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
 * messages quote the input: `operation.ts` interpolates the offending property
 * key and `path.ts` a path segment, and neither is bounded before it is
 * rejected. One 5,000-character property name would otherwise push this error
 * past the schema that describes it — a caller choosing the size of the error
 * it gets back is the shape of a resource-exhaustion bug, not a formatting one.
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
 * The declared length is checked first so an 8 GiB upload is refused on its
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
 * sends it with no preflight, so a page on any site could drive this daemon if
 * the content type were not checked. `application/json` cannot be sent
 * cross-origin without a preflight the origin check below will refuse.
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

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Reject any Host the daemon did not expect.
 *
 * Binding loopback keeps remote packets out; it does not keep *browsers* out.
 * A page on any website can point a hostname it controls at 127.0.0.1 (DNS
 * rebinding) and have the user's own browser deliver requests here, with that
 * attacker hostname in the Host header. Refusing anything that is not a
 * loopback name closes that door and costs a legitimate client nothing.
 */
export function hostIsLoopback(hostHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!raw) return false;
  const hostname = raw.startsWith('[')
    ? raw.slice(1, raw.indexOf(']'))
    : (raw.split(':')[0] ?? '');
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Cross-origin browser callers are refused unless the operator named them.
 *
 * Roblox Studio's HttpService sends no Origin, so the consumer is unaffected.
 * A web app that wants to reach the daemon for BYOK (ADR-006) is opting in
 * explicitly via `--allow-origin`, which is the only honest way to widen the
 * hole: the daemon holds the user's provider keys.
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
