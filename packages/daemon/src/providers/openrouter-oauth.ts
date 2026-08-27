import { createHash, randomBytes } from 'node:crypto';
import type { SecretsPort } from '@forgebridge/core';
import { OPENROUTER_SECRET_REF } from '../openrouter.js';
import { asRecord, asString, clip, providerMessage } from './openai-compatible.js';

/**
 * OpenRouter's PKCE flow (M23), so a user never pastes a key.
 *
 * ── What was verified, and where ──────────────────────────────────────────────
 *
 * Read from OpenRouter's own documentation at
 * https://openrouter.ai/docs/guides/overview/auth/oauth and its API reference
 * page for the exchange endpoint:
 *
 *   - the authorization URL is `https://openrouter.ai/auth`, taking
 *     `callback_url`, and optionally `code_challenge` and
 *     `code_challenge_method` (`S256` or `plain`);
 *   - `code_challenge` for `S256` is the base64url encoding of the SHA-256 hash
 *     of the verifier — the documentation's own example uses
 *     `Buffer.from(hash).toString('base64url')`;
 *   - the user returns to the callback with a `code` query parameter;
 *   - the exchange is `POST https://openrouter.ai/api/v1/auth/keys` with
 *     `Content-Type: application/json` and a body of `{ code, code_verifier,
 *     code_challenge_method }`, answering `{ key, user_id }` on 200 and
 *     documented 400 / 403 / 500 error shapes;
 *   - authorization codes expire ten minutes after issuance.
 *
 * ── What was NOT established, and is therefore not implemented ────────────────
 *
 * TODO(M23): OpenRouter's `/auth` documents no `state` parameter, and no
 * anti-CSRF token of any other name. This module therefore does not send one,
 * because sending an invented parameter is worse than sending none: it would
 * read as a check that is happening. What stands in its place is narrower and
 * has to be enforced by whoever opens the callback — the callback must be a
 * loopback URL (`assertLoopbackCallback` below refuses anything else), the
 * daemon must accept a code only on a listener it opened for this flow, and the
 * verifier never leaves the process. If OpenRouter documents a `state`
 * parameter, this is the module that must start sending and checking one.
 *
 * TODO(M23): nothing here opens the callback listener or handles the redirect —
 * that is an HTTP route, and it belongs to `../server.ts`, which owns the
 * daemon's surface. This module is the whole of the flow that can be written
 * and tested without one: build the URL, hold the verifier, exchange the code,
 * store the key.
 *
 * ── Where the key goes ────────────────────────────────────────────────────────
 *
 * Into the `SecretsPort`, and nowhere else. `completeAuthorization` returns the
 * user id and never the key: a function that returned it would be a function
 * whose result someone eventually logs. Note that this needs a *writable*
 * backend, which the daemon does not have yet — both shipped backends refuse
 * `set` (see `../secrets.ts` and its TODO(M38)), so this flow's last step fails
 * loudly today rather than appearing to work.
 */

export const OPENROUTER_AUTHORIZE_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

/** Documented: a code expires ten minutes after issuance. */
export const AUTHORIZATION_CODE_TTL_MS = 600_000;

/**
 * 32 random bytes, base64url-encoded, is 43 characters — the shortest verifier
 * RFC 7636 allows and comfortably inside its 128-character ceiling.
 */
const VERIFIER_BYTES = 32;

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const MAX_ERROR_CHARS = 300;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenRouterOAuthError extends Error {
  /** The HTTP status, when the failure was an HTTP one. */
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenRouterOAuthError';
    this.status = options.status;
  }
}

/**
 * One authorization in progress.
 *
 * Held in memory by whoever started it, for as long as the user is away in a
 * browser. `codeVerifier` is the half of PKCE that must not travel: it is sent
 * once, to the exchange endpoint, and it is what proves the code was redeemed by
 * the process that asked for it.
 */
export interface PendingAuthorization {
  authorizationUrl: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  callbackUrl: string;
  startedAt: string;
  /** When the code OpenRouter is about to issue will stop being redeemable. */
  expiresAt: string;
}

/**
 * A loopback callback, or a refusal.
 *
 * The callback URL is where OpenRouter sends the authorization code, so a URL
 * pointing anywhere but this machine is a URL that hands somebody else's server
 * the code. Refusing here rather than at redemption is the point: by redemption
 * the code has already been delivered.
 */
export function assertLoopbackCallback(callbackUrl: string): URL {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch (cause) {
    throw new OpenRouterOAuthError(`callback URL is not a URL: ${clip(callbackUrl, 120)}`, { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenRouterOAuthError(`callback URL must be http or https, not ${url.protocol}`);
  }
  // The set the OS resolves to this machine and nothing else. A hostname that
  // merely *looks* local ("localhost.example.com") is not on it.
  const loopback = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
  if (!loopback.has(url.hostname)) {
    throw new OpenRouterOAuthError(
      `callback URL must be a loopback address; ${url.hostname} is somewhere else`,
    );
  }
  return url;
}

/** base64url, without padding — the encoding both PKCE and OpenRouter's example use. */
function base64Url(input: Buffer): string {
  return input.toString('base64url');
}

/** `code_challenge` for `S256`: base64url(SHA-256(verifier)). */
export function codeChallengeFor(codeVerifier: string): string {
  if (!VERIFIER_PATTERN.test(codeVerifier)) {
    throw new OpenRouterOAuthError(
      'code verifier must be 43–128 unreserved characters (RFC 7636 §4.1)',
    );
  }
  return base64Url(createHash('sha256').update(codeVerifier, 'ascii').digest());
}

export interface BeginOptions {
  /** Where OpenRouter sends the user back. Must be loopback. */
  callbackUrl: string;
  now?: () => number;
  /** Overridden only by tests, which need a verifier they can predict. */
  randomVerifier?: () => string;
}

/**
 * Step one: the URL to open in the user's browser, and the verifier to keep.
 *
 * Nothing is sent from here. The caller opens the URL, the user authorises in
 * their own browser session, and OpenRouter redirects to `callbackUrl` with a
 * `code`.
 */
export function beginAuthorization(options: BeginOptions): PendingAuthorization {
  const callback = assertLoopbackCallback(options.callbackUrl);
  const codeVerifier = options.randomVerifier
    ? options.randomVerifier()
    : base64Url(randomBytes(VERIFIER_BYTES));
  const codeChallenge = codeChallengeFor(codeVerifier);

  const url = new URL(OPENROUTER_AUTHORIZE_URL);
  // `URL.searchParams` percent-encodes, which matters: the callback carries a
  // scheme and a port, and a hand-built query string is how one of those ends up
  // truncated at the first `:`.
  url.searchParams.set('callback_url', callback.toString());
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const startedAtMs = options.now ? options.now() : Date.now();
  return {
    authorizationUrl: url.toString(),
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
    callbackUrl: callback.toString(),
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + AUTHORIZATION_CODE_TTL_MS).toISOString(),
  };
}

export interface CompleteOptions {
  pending: PendingAuthorization;
  /** The `code` query parameter from the callback. */
  code: string;
  /** Where the key is written. The only place it goes. */
  secrets: SecretsPort;
  fetch?: FetchLike;
  exchangeUrl?: string;
  now?: () => number;
}

/** What the caller is told. Deliberately not the key. */
export interface CompletedAuthorization {
  /** OpenRouter's own id for the account that authorised, when it returned one. */
  userId: string | null;
  /** Where the key was written, so a caller can say so without reading it. */
  storedAt: { scope: string; name: string };
}

/**
 * Step two: redeem the code and store the key.
 *
 * The key is written straight into the `SecretsPort` and is never returned,
 * logged, or included in a thrown error. A failure to *store* is raised rather
 * than swallowed: a flow that reported success while the key went nowhere would
 * send the user back to a browser they had already used correctly.
 */
export async function completeAuthorization(options: CompleteOptions): Promise<CompletedAuthorization> {
  const { pending, code } = options;
  if (code.trim().length === 0) {
    throw new OpenRouterOAuthError('the callback carried no authorization code');
  }

  const now = options.now ? options.now() : Date.now();
  if (now > Date.parse(pending.expiresAt)) {
    // Checked before the request. A code past its ten minutes is refused by
    // OpenRouter anyway; failing here says why, in words that name the fix.
    throw new OpenRouterOAuthError(
      'this authorization code has expired — OpenRouter codes are redeemable for ten minutes. Start the flow again.',
    );
  }

  const doFetch = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  let response: Response;
  try {
    response = await doFetch(options.exchangeUrl ?? OPENROUTER_KEY_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: pending.codeVerifier,
        code_challenge_method: pending.codeChallengeMethod,
      }),
    });
  } catch (cause) {
    throw new OpenRouterOAuthError('OpenRouter could not be reached to exchange the code', { cause });
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = providerMessage(await response.text());
    } catch {
      // Unreadable body; the status is what we know.
    }
    throw new OpenRouterOAuthError(
      `OpenRouter refused the code exchange with ${response.status}${detail ? `: ${clip(detail, MAX_ERROR_CHARS)}` : ''}`,
      { status: response.status },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new OpenRouterOAuthError('OpenRouter did not answer the exchange with JSON', { cause });
  }

  const body = asRecord(payload);
  const issued = asString(body['key']);
  if (issued === null || issued.length === 0) {
    // A 200 with no key is a failure, not an empty success — the one shape that
    // would otherwise be recorded as "authorised" with nothing stored.
    throw new OpenRouterOAuthError('OpenRouter answered the exchange without a key');
  }

  try {
    await options.secrets.set(OPENROUTER_SECRET_REF, issued);
  } catch (cause) {
    // The message from a read-only backend already names what to do instead
    // (see `../secrets.ts`); it is passed through rather than replaced, and the
    // key is not in it.
    throw new OpenRouterOAuthError(
      `OpenRouter issued a key and this daemon could not store it: ${clip(
        cause instanceof Error ? cause.message : String(cause),
        MAX_ERROR_CHARS,
      )}`,
      { cause },
    );
  }

  return {
    userId: asString(body['user_id']),
    storedAt: { scope: OPENROUTER_SECRET_REF.scope, name: OPENROUTER_SECRET_REF.name },
  };
}
