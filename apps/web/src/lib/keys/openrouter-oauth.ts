import {
  CODE_CHALLENGE_METHOD,
  beginFlow,
  createPkcePair,
  generateState,
  type PendingFlow,
} from './pkce';

/**
 * OpenRouter OAuth (M23) — the flow that means a user never pastes a credential.
 *
 * ── What is certain, and what is transcribed ─────────────────────────────────
 *
 * The PKCE half is certain: it is RFC 7636, it lives in `pkce.ts`, and nothing
 * about it depends on OpenRouter. This file is the other half — the two
 * endpoints and the two payload shapes — and those are **transcribed from
 * OpenRouter's published flow, not verified against a live server from inside
 * this repository**. Nothing here has been exercised against openrouter.ai in
 * CI or by hand.
 *
 * The brief for this milestone says: implement what you are sure of, and mark
 * the rest. So the shape of this module follows that split exactly —
 *
 *   - `startAuthorization()` is complete and correct. It generates the pair,
 *     stores the verifier for one tab, and builds the authorization URL. If the
 *     query parameter names below are wrong, the user lands on an OpenRouter
 *     error page and comes back with nothing, which is recoverable and visible.
 *   - `exchangeCode()` is implemented as documented and **fails loudly and
 *     specifically** rather than pretending. Every failure it can have names
 *     itself, including "this build's transcription of the endpoint may be
 *     out of date", because a transcription that has drifted looks from the
 *     inside exactly like a network problem.
 *
 * TODO(M23): verify both endpoints, both payload shapes and the CORS behaviour
 * of the exchange against OpenRouter's current documentation, then add a case
 * to `packages/conformance` so the transcription cannot drift silently again.
 * Until that lands, the keys surface presents this as the *convenient* path and
 * the OS keychain as the *reliable* one, and does not claim otherwise.
 *
 * ── Why the exchange runs in the browser ─────────────────────────────────────
 *
 * Because ADR-006 leaves it nowhere else to run. Redeeming the code server-side
 * would mean the credential materialising on an apple.gg process, which is the
 * one thing the key-custody promise forbids — and `apps/web` ships no route
 * handler for it to materialise in. The consequence is that the exchange is
 * subject to CORS: if OpenRouter does not permit this origin, the request fails
 * and the surface says so and offers the paste path. That is the honest
 * failure, and it is better than the alternative design.
 */

/** The authorization page a user is sent to. */
export const AUTHORIZE_URL = 'https://openrouter.ai/auth';

/** Where an authorization code is redeemed for a credential. */
export const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

/**
 * The callback path, relative to a locale root. It is a page in this app rather
 * than a route handler on purpose: a route handler would be a server endpoint
 * that receives an authorization code, and a code plus a verifier is a
 * credential in two pieces.
 */
export function callbackPath(locale: string): string {
  return `/${locale}/settings/keys/callback`;
}

export function callbackUrl(locale: string, origin: string): string {
  return `${origin}${callbackPath(locale)}`;
}

/**
 * Build the authorization URL and remember the verifier for this tab.
 *
 * Returns the URL rather than navigating, so the caller decides when the
 * navigation happens — and so this function is testable without a browser
 * deciding to leave the page in the middle of the test.
 */
export async function startAuthorization(options: {
  readonly locale: string;
  readonly origin: string;
  readonly returnTo: string;
}): Promise<string> {
  const pair = await createPkcePair();
  const flow: PendingFlow = {
    codeVerifier: pair.codeVerifier,
    state: generateState(),
    returnTo: options.returnTo,
    startedAt: new Date().toISOString(),
  };
  beginFlow(flow);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('callback_url', callbackUrl(options.locale, options.origin));
  url.searchParams.set('code_challenge', pair.codeChallenge);
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  // Round-tripped so the callback can refuse a code that arrived without a flow
  // this tab started. OpenRouter is not documented to echo `state`; the
  // callback therefore treats a missing echo as "unverified" rather than as a
  // failure, and says which of the two it got.
  url.searchParams.set('state', flow.state);
  return url.toString();
}

export type ExchangeResult =
  | { readonly ok: true; readonly credential: string }
  | {
      readonly ok: false;
      /**
       * Which failure this is, so the surface can give the matching remedy
       * rather than one apology for five different problems.
       *
       *   blocked        the browser refused the cross-origin request, or
       *                  nothing answered. Includes the CORS case, which is
       *                  indistinguishable from a network failure by design.
       *   refused        OpenRouter answered and rejected the redemption.
       *   unrecognised   it answered 2xx with a body this build cannot read —
       *                  the shape most likely to mean the transcription above
       *                  has drifted.
       */
      readonly reason: 'blocked' | 'refused' | 'unrecognised';
      readonly detail: string;
    };

/**
 * Redeem an authorization code.
 *
 * The response body is read defensively: a credential is looked for under the
 * documented field and under one obvious alternative, and anything else is
 * reported as `unrecognised` with the field names that *were* present. A parser
 * that silently returned `undefined` here would seal an empty credential into
 * the vault and the user would learn about it on their next run.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: CODE_CHALLENGE_METHOD,
      }),
      // No cookies. This is a bearer exchange against a third party and has no
      // business carrying ambient authority from this browser.
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'blocked',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `the provider answered ${String(response.status)}`;
    return { ok: false, reason: 'refused', detail: message };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'unrecognised', detail: 'the response body was not an object' };
  }

  const record = payload as Record<string, unknown>;
  // `key` is the documented field. `user_key` appears in some transcriptions of
  // the same flow; both are accepted, and anything else is reported rather than
  // guessed at.
  const found = [record['key'], record['user_key']].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (found === undefined) {
    return {
      ok: false,
      reason: 'unrecognised',
      detail: `no credential field in the response; it carried: ${Object.keys(record).join(', ') || '(nothing)'}`,
    };
  }

  return { ok: true, credential: found };
}
