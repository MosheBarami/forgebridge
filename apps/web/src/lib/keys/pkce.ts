/**
 * PKCE (RFC 7636), the part of an OAuth flow that is entirely ours.
 *
 * Everything in this file is fixed by the RFC rather than by any provider, so
 * it is the half of M23 that can be written correctly without access to a
 * provider's live documentation — which is why it is a separate module from
 * `openrouter-oauth.ts`, where the endpoints live and where the uncertainty is.
 *
 * Why PKCE at all, for a page with no client secret: the authorization code
 * comes back on a URL, and a URL is visible to the browser's history, to
 * anything that can read a referrer, and to any other script on the page. PKCE
 * makes the code useless on its own — redemption requires the verifier, which
 * never leaves this tab until it is sent, once, in a POST body.
 *
 * S256 only. RFC 7636 §4.2 permits `plain` for clients that cannot compute
 * SHA-256; a browser can, so offering `plain` would only give an attacker a
 * downgrade to ask for.
 */

/** The transform this module produces. There is deliberately no second value. */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

export interface PkcePair {
  /** The secret. Held in this tab, sent once, in a request body. */
  readonly codeVerifier: string;
  /** The public commitment. Safe to put on a URL — that is its whole design. */
  readonly codeChallenge: string;
  readonly method: typeof CODE_CHALLENGE_METHOD;
}

/**
 * base64url without padding, per RFC 7636 §A.
 *
 * The padding matters: an `=` on the end of a challenge is a character the
 * authorization server will percent-encode, compare against its own unpadded
 * derivation, and reject — a failure that surfaces at redemption time, long
 * after the mistake, as an opaque "invalid grant".
 */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 32 random bytes, base64url-encoded to 43 characters.
 *
 * RFC 7636 §4.1 allows 43–128 characters and recommends 32 octets of output
 * from a cryptographic random number generator. `crypto.getRandomValues` is
 * that; `Math.random` is a non-cryptographic PRNG whose state is recoverable
 * from a handful of outputs, and this value is the only thing standing between
 * an intercepted authorization code and a usable provider credential.
 */
export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}

export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: await deriveCodeChallenge(codeVerifier),
    method: CODE_CHALLENGE_METHOD,
  };
}

/**
 * Where the verifier waits while the browser is away at the provider.
 *
 * `sessionStorage`, not `localStorage` and not IndexedDB, for three reasons
 * that all point the same way: it is scoped to this tab, so a second tab
 * cannot redeem a flow it did not start; it is cleared when the tab closes, so
 * an abandoned flow leaves nothing behind; and the value's whole lifetime is
 * one redirect, which is shorter than any durable store is designed for.
 *
 * It is deliberately *not* the vault: the vault holds credentials, and a
 * verifier is not one — it is a nonce that is worthless the moment the flow
 * completes or is abandoned. `endFlow` deletes it on both paths.
 */
const FLOW_STORAGE_KEY = 'fb-oauth-flow';

export interface PendingFlow {
  readonly codeVerifier: string;
  /** Round-tripped through the provider so the callback can prove it is ours. */
  readonly state: string;
  /** Where to return the user afterwards, so a flow started on one page ends there. */
  readonly returnTo: string;
  readonly startedAt: string;
}

export function generateState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function beginFlow(flow: PendingFlow): void {
  try {
    window.sessionStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Storage can throw outright in a private window. The flow will fail at the
    // callback with "no flow in progress", which is the correct diagnosis and
    // is what the callback page shows.
  }
}

export function readFlow(): PendingFlow | null {
  try {
    const raw = window.sessionStorage.getItem(FLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record['codeVerifier'] !== 'string' ||
      typeof record['state'] !== 'string' ||
      typeof record['returnTo'] !== 'string' ||
      typeof record['startedAt'] !== 'string'
    ) {
      return null;
    }
    // `returnTo` becomes an `href` on the callback page, so it is checked
    // rather than trusted. It is a value this app wrote — but it wrote it to a
    // store anything on this origin can edit, and a `returnTo` of
    // `//evil.example` is a protocol-relative URL that leaves the site. A
    // single leading slash, and no second one, is the whole rule.
    if (!record['returnTo'].startsWith('/') || record['returnTo'].startsWith('//')) return null;
    return {
      codeVerifier: record['codeVerifier'],
      state: record['state'],
      returnTo: record['returnTo'],
      startedAt: record['startedAt'],
    };
  } catch {
    return null;
  }
}

/** Called on success, on failure, and on abandonment. A verifier is single-use. */
export function endFlow(): void {
  try {
    window.sessionStorage.removeItem(FLOW_STORAGE_KEY);
  } catch {
    // Nothing to do: the value expires with the tab regardless.
  }
}
