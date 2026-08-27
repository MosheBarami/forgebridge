/**
 * The transport half of the Open Cloud package: one place that holds the
 * credential, builds a request, and decides what an answer means.
 *
 * Everything above it (`places.ts`, `datastores.ts`, `messaging.ts`) is a thin
 * translation of one documented endpoint into a typed call. Endpoint shapes are
 * quoted from the Roblox documentation in each of those files, with the URL the
 * shape came from, because "read the API documentation, do not guess" was the
 * instruction and a reader has to be able to check that it was followed.
 *
 * Three decisions in this file are load-bearing.
 *
 * **The key lives in a closure, not on a field.** `createOpenCloudClient`
 * returns an object with a `baseUrl` and a `send`; the credential is captured
 * by `send` and is reachable from nothing else. That is not decoration:
 * `JSON.stringify(client)` is what a debug log, an error reporter and a
 * `console.dir` all do to an object, and a credential on a public field
 * survives all three. `test/custody.test.ts` asserts the serialised client is
 * free of it.
 *
 * **Plain HTTP is refused.** The key travels in a request header, so a base URL
 * that is not `https:` is a credential disclosure with extra steps. There is an
 * explicit opt-out for a loopback mock, and it is loopback-only: an opt-out
 * that also permits `http://collector.internal` is the opt-out an operator
 * reaches for once and forgets.
 *
 * **A retry is a property of the request, not of the status.** Only requests
 * declared idempotent are retried, and only when the service *refused* them —
 * so a 429 on a read is repeated and a lost answer to `incrementEntry` is not.
 * The failure that lesson comes from is the one this repository has already
 * shipped a fix for once: a partial failure recorded as a success. Retrying a
 * write whose answer was lost is the same defect wearing a helpful face.
 */
import { OpenCloudError, parseRetryAfter, readErrorEnvelope } from './errors.js';

/** Where the three Open Cloud API families this package speaks all live. */
export const DEFAULT_BASE_URL = 'https://apis.roblox.com';

/**
 * The header Open Cloud authenticates an API key with.
 *
 * Documented at https://create.roblox.com/docs/cloud/guides/data-stores and on
 * every endpoint reference this package targets. OAuth 2.0 access tokens use
 * `Authorization: Bearer …` on the same endpoints instead — that is M48's
 * unfinished half, see the TODO at the bottom of this file.
 */
export const API_KEY_HEADER = 'x-api-key';

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  attempts: number;
  /** Base backoff in milliseconds; attempt n waits `baseDelayMs * 2 ** (n - 1)`. */
  baseDelayMs: number;
  /** Ceiling on any single wait, including one a `retry-after` header asked for. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 30_000 };

export interface OpenCloudClientOptions {
  /**
   * The Open Cloud API key, from the Creator Dashboard.
   *
   * Held in memory for the lifetime of the client and never written anywhere by
   * this package. Where it comes from is the caller's decision and deliberately
   * not this package's: `bin.ts` reads an environment variable, and a host that
   * has an OS keychain should hand one in from there instead.
   */
  apiKey: string;
  /** Defaults to `https://apis.roblox.com`. Must be https — see `allowInsecureLoopbackBaseUrl`. */
  baseUrl?: string;
  /** Injected for tests and for hosts with their own dispatcher. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  retry?: Partial<RetryPolicy>;
  /** Injected so the retry tests do not sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so `retry-after: <http-date>` is decidable in a test. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Permit a plain-HTTP base URL, and only on loopback.
   *
   * For a mock server in a test that wants a real socket. Anything that is not
   * `127.0.0.1`, `[::1]` or `localhost` is still refused with this set,
   * because the reason plain HTTP is refused — the key is in a header — does
   * not stop being true because someone passed a flag.
   */
  allowInsecureLoopbackBaseUrl?: boolean;
}

/**
 * What a request body may be here.
 *
 * Written out rather than reaching for the DOM's `BodyInit`: this package
 * compiles with `lib: ES2023` and `types: node` — no DOM lib — and the two
 * shapes it actually sends are a JSON string and a place file's bytes. A union
 * of exactly those is also a small guard against a caller handing in a stream
 * whose length nothing has checked.
 */
export type RequestBody = string | Uint8Array;

export interface RequestSpec {
  /** Method and path for error messages. Never includes the query string, which carries entry keys. */
  operation: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path beneath the base URL, already percent-encoded by the caller. */
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  headers?: Readonly<Record<string, string>>;
  body?: RequestBody;
  /**
   * Whether sending this exact request twice is indistinguishable from sending
   * it once. Only these are retried. Stated per call site because only the call
   * site knows — `incrementEntry` is a POST that is emphatically not idempotent,
   * and `setEntry` with `exclusiveCreate` is a POST that fails the second time
   * on purpose.
   */
  idempotent: boolean;
}

export interface OpenCloudResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
}

export interface OpenCloudClient {
  readonly baseUrl: string;
  send(spec: RequestSpec): Promise<OpenCloudResponse>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Reject a key this client cannot put in a header safely, without ever quoting
 * it back.
 *
 * A newline in a header value is a request-splitting primitive, and undici
 * throws on one anyway — but it throws with the value in the message. Catching
 * it here means the failure a user sees names the *problem* rather than
 * printing their credential into their terminal scrollback.
 */
function assertUsableApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('opencloud: an API key is required. Create one at https://create.roblox.com/dashboard/credentials');
  }
  if (/[\r\n\0]/.test(apiKey) || apiKey !== apiKey.trim()) {
    // Length is safe to report and is almost always the diagnosis: a key copied
    // out of a file arrives with a trailing newline.
    throw new Error(
      `opencloud: the API key contains whitespace or control characters it cannot carry in a header (${apiKey.length} characters). ` +
        'A trailing newline from `cat keyfile` is the usual cause; trim it at the source rather than here, so the fix survives the next read.',
    );
  }
}

function resolveBaseUrl(raw: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`opencloud: baseUrl "${raw}" is not a URL`);
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol !== 'http:') {
    throw new Error(`opencloud: baseUrl must be http(s); "${url.protocol}" is neither`);
  }
  if (!allowInsecureLoopback) {
    throw new Error(
      `opencloud: refusing to send the API key to ${url.origin} over plain HTTP. ` +
        'Pass allowInsecureLoopbackBaseUrl only for a loopback mock in a test.',
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `opencloud: allowInsecureLoopbackBaseUrl permits plain HTTP on loopback only, and "${url.hostname}" is not loopback. ` +
        'The key travels in a request header; that does not stop being true because a flag was set.',
    );
  }
  return url.origin;
}

export function createOpenCloudClient(options: OpenCloudClientOptions): OpenCloudClient {
  const { apiKey } = options;
  assertUsableApiKey(apiKey);

  const baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL, options.allowInsecureLoopbackBaseUrl === true);
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('opencloud: no fetch implementation. Node 22 has one globally; pass options.fetch otherwise.');
  }
  const retry = normaliseRetry(options.retry);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  // The credential is captured here and reachable from nothing the returned
  // object exposes. See the header of this file.
  const send = async (spec: RequestSpec): Promise<OpenCloudResponse> => {
    const url = buildUrl(baseUrl, spec);
    const headers = new Headers(spec.headers ?? {});
    headers.set(API_KEY_HEADER, apiKey);

    let lastError: OpenCloudError | undefined;
    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      let response: Response;
      try {
        const init: RequestInit = { method: spec.method, headers };
        // `RequestInit` here is Node's, whose `body` type comes from undici and
        // is wider than this union; the cast narrows nothing and hides nothing.
        if (spec.body !== undefined) init.body = spec.body as RequestInit['body'];
        response = await doFetch(url, init);
      } catch (cause) {
        // The answer, if there was one, is lost. For a non-idempotent request
        // that is the ambiguous case, and ambiguity is reported as failure —
        // never retried, never reported as success.
        throw new OpenCloudError({ kind: 'transport', operation: spec.operation, cause });
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = decodeUtf8(bytes);

      if (response.status >= 200 && response.status <= 299) {
        return { status: response.status, headers: response.headers, bytes, text };
      }

      const envelope = readErrorEnvelope(response.status, text);
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now());
      lastError = new OpenCloudError({
        kind: 'refused',
        operation: spec.operation,
        status: response.status,
        ...(envelope.code === undefined ? {} : { code: envelope.code }),
        ...(envelope.detail === undefined ? {} : { detail: envelope.detail }),
        ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      });

      const canRetry = spec.idempotent && lastError.retryable && attempt < retry.attempts;
      if (!canRetry) throw lastError;

      const backoff = retry.baseDelayMs * 2 ** (attempt - 1);
      const asked = retryAfter === undefined ? backoff : retryAfter * 1000;
      await sleep(Math.min(Math.max(asked, backoff), retry.maxDelayMs));
    }

    /* c8 ignore next 2 -- the loop either returns, throws, or exhausts attempts into this line. */
    throw lastError ?? new OpenCloudError({ kind: 'transport', operation: spec.operation });
  };

  return { baseUrl, send };
}

function normaliseRetry(partial: Partial<RetryPolicy> | undefined): RetryPolicy {
  const merged = { ...DEFAULT_RETRY, ...(partial ?? {}) };
  if (!Number.isInteger(merged.attempts) || merged.attempts < 1) {
    throw new Error('opencloud: retry.attempts must be an integer of at least 1');
  }
  if (!(merged.baseDelayMs >= 0) || !(merged.maxDelayMs >= merged.baseDelayMs)) {
    throw new Error('opencloud: retry.baseDelayMs must be >= 0 and retry.maxDelayMs must be >= retry.baseDelayMs');
  }
  return merged;
}

/**
 * Build the request URL.
 *
 * `path` arrives already encoded because only the caller knows which segments
 * are identifiers and which are literals; `query` is encoded here, by
 * `URLSearchParams`, because every value in it is user data — a data store
 * name, an entry key, a topic — and hand-encoding user data one call site at a
 * time is how one call site ends up not doing it.
 */
export function buildUrl(baseUrl: string, spec: Pick<RequestSpec, 'path' | 'query'>): string {
  const url = new URL(spec.path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Strict UTF-8: a body that is not valid UTF-8 is a body this client will not guess at. */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Parse a JSON success body, or fail.
 *
 * The whole point of the `unreadable` error kind. A 200 whose body this package
 * cannot read is not a success — the operation may or may not have happened,
 * and reporting it as done is the exact defect shape this repository has
 * already had to fix three times.
 */
export function readJson(response: OpenCloudResponse, operation: string): unknown {
  if (response.text.trim() === '') {
    throw new OpenCloudError({
      kind: 'unreadable',
      operation,
      status: response.status,
      detail: 'the response body was empty, and this operation is documented to return one',
    });
  }
  try {
    return JSON.parse(response.text);
  } catch (cause) {
    throw new OpenCloudError({
      kind: 'unreadable',
      operation,
      status: response.status,
      detail: 'the response body is not JSON',
      cause,
    });
  }
}

// TODO(M48): OAuth 2.0. Open Cloud accepts `Authorization: Bearer <token>` in
// place of `x-api-key` on these same endpoints, which is what a third-party
// tool acting for another creator has to use. Not implemented here, and named
// rather than half-built: the exact authorisation-code + PKCE parameters, the
// token endpoint's URL and the mapping from these scope strings onto OAuth
// scope strings could not be verified from the documentation reachable while
// this package was written, and an auth flow guessed at is an auth flow that
// fails in the field with a credential already in play.
