import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SecretRef, SecretsPort } from '@forgebridge/core';
import {
  AUTHORIZATION_CODE_TTL_MS,
  OPENROUTER_AUTHORIZE_URL,
  OPENROUTER_KEY_EXCHANGE_URL,
  OpenRouterOAuthError,
  assertLoopbackCallback,
  beginAuthorization,
  codeChallengeFor,
  completeAuthorization,
} from '../src/providers/openrouter-oauth.js';

/**
 * OpenRouter's PKCE flow (M23).
 *
 * The thing worth testing here is not that a URL gets built. It is that the key
 * this flow obtains goes into the `SecretsPort` and comes back out of no other
 * door — not as a return value, not in an error, not in a log — and that the
 * three ways the flow can go wrong (a callback pointing off this machine, an
 * expired code, a 200 with no key in it) are each refused rather than treated as
 * a success.
 */

/** A key-shaped fixture, assembled so `verify:no-secrets` has nothing to find. */
const ISSUED_KEY = ['sk', 'or', 'v1', `${'0'.repeat(8)}${'abadcafe'.repeat(6)}`].join('-');

const CALLBACK = 'http://127.0.0.1:7317/v1/providers/openrouter/callback';
/** 43 characters of the unreserved set — the shortest RFC 7636 allows. */
const VERIFIER = 'a'.repeat(43);

function recordingSecrets() {
  const written: { ref: SecretRef; length: number }[] = [];
  const port: SecretsPort = {
    async get() {
      return null;
    },
    async set(ref, value) {
      // The length, never the value: a test fixture that hoards credentials is
      // the same mistake as a store that does.
      written.push({ ref, length: value.length });
    },
    async delete() {
      // Nothing to do.
    },
    async listNames() {
      return [];
    },
    describe() {
      return { kind: 'memory', label: 'test fixture', readableByOtherProcesses: false };
    },
  };
  return { port, written };
}

function refusingSecrets(message: string): SecretsPort {
  return {
    ...recordingSecrets().port,
    async set() {
      throw new Error(message);
    },
  };
}

describe('the authorization URL', () => {
  it('is OpenRouter’s documented endpoint carrying the callback and an S256 challenge', () => {
    const pending = beginAuthorization({ callbackUrl: CALLBACK, randomVerifier: () => VERIFIER });
    const url = new URL(pending.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe(OPENROUTER_AUTHORIZE_URL);
    expect(url.searchParams.get('callback_url')).toBe(CALLBACK);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pending.codeChallenge);
  });

  it('derives the challenge as base64url(sha256(verifier)), which is what the docs specify', () => {
    const expected = createHash('sha256').update(VERIFIER, 'ascii').digest().toString('base64url');
    expect(codeChallengeFor(VERIFIER)).toBe(expected);
    // base64url: no padding, and none of the three characters base64 uses that
    // a URL would have to escape.
    expect(expected).not.toMatch(/[+/=]/);
  });

  it('never puts the verifier in the URL — that is the half of PKCE that must not travel', () => {
    const pending = beginAuthorization({ callbackUrl: CALLBACK, randomVerifier: () => VERIFIER });
    expect(pending.authorizationUrl).not.toContain(pending.codeVerifier);
  });

  it('generates a verifier RFC 7636 accepts when it is not given one', () => {
    const pending = beginAuthorization({ callbackUrl: CALLBACK });
    expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // Two flows must not share a verifier.
    expect(beginAuthorization({ callbackUrl: CALLBACK }).codeVerifier).not.toBe(pending.codeVerifier);
  });

  it('refuses a verifier outside the shape the spec allows', () => {
    expect(() => codeChallengeFor('too-short')).toThrow(OpenRouterOAuthError);
    expect(() => codeChallengeFor(`${'a'.repeat(42)}!`)).toThrow(OpenRouterOAuthError);
  });

  it('records the ten-minute window the documentation gives for redeeming a code', () => {
    const pending = beginAuthorization({ callbackUrl: CALLBACK, now: () => 0 });
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.startedAt)).toBe(AUTHORIZATION_CODE_TTL_MS);
  });
});

describe('the callback URL', () => {
  it('accepts the loopback forms a daemon actually listens on', () => {
    expect(assertLoopbackCallback('http://127.0.0.1:7317/callback').hostname).toBe('127.0.0.1');
    expect(assertLoopbackCallback('http://localhost:7317/callback').hostname).toBe('localhost');
    expect(assertLoopbackCallback('https://127.0.0.1:7317/callback').protocol).toBe('https:');
  });

  it('refuses a callback that would hand the authorization code to somebody else', () => {
    // Each of these is a way to make the redirect land off this machine. The
    // last is the one that reads as local and is not.
    for (const url of [
      'https://example.com/callback',
      'http://192.168.1.10:7317/callback',
      'http://localhost.example.com/callback',
      'ftp://127.0.0.1/callback',
      'not a url at all',
    ]) {
      expect(() => assertLoopbackCallback(url)).toThrow(OpenRouterOAuthError);
    }
  });

  it('refuses to even build an authorization URL for a non-loopback callback', () => {
    expect(() => beginAuthorization({ callbackUrl: 'https://example.com/callback' })).toThrow(
      OpenRouterOAuthError,
    );
  });
});

describe('exchanging the code', () => {
  function pendingAt(startedAtMs = 0) {
    return beginAuthorization({
      callbackUrl: CALLBACK,
      randomVerifier: () => VERIFIER,
      now: () => startedAtMs,
    });
  }

  it('posts the documented body to the documented endpoint and stores the key it gets back', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const { port, written } = recordingSecrets();
    const result = await completeAuthorization({
      pending: pendingAt(),
      code: 'code-from-the-callback',
      secrets: port,
      now: () => 1_000,
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ key: ISSUED_KEY, user_id: 'user_42' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(calls[0]?.url).toBe(OPENROUTER_KEY_EXCHANGE_URL);
    expect(calls[0]?.body).toEqual({
      code: 'code-from-the-callback',
      code_verifier: VERIFIER,
      code_challenge_method: 'S256',
    });
    expect(written).toEqual([{ ref: { scope: 'provider', name: 'openrouter' }, length: ISSUED_KEY.length }]);
    expect(result.userId).toBe('user_42');
    expect(result.storedAt).toEqual({ scope: 'provider', name: 'openrouter' });
  });

  it('returns the user id and the location, and never the key itself', async () => {
    const { port } = recordingSecrets();
    const result = await completeAuthorization({
      pending: pendingAt(),
      code: 'code',
      secrets: port,
      now: () => 1_000,
      fetch: async () =>
        new Response(JSON.stringify({ key: ISSUED_KEY, user_id: null }), { status: 200 }),
    });
    // The whole returned value, serialised, must not contain it. A function that
    // returned the key would be a function whose result somebody logs.
    expect(JSON.stringify(result)).not.toContain(ISSUED_KEY);
  });

  it('refuses an expired code before making the request', async () => {
    let called = false;
    const { port } = recordingSecrets();
    const error = await completeAuthorization({
      pending: pendingAt(0),
      code: 'code',
      secrets: port,
      now: () => AUTHORIZATION_CODE_TTL_MS + 1,
      fetch: async () => {
        called = true;
        return new Response('{}');
      },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(OpenRouterOAuthError);
    expect(called).toBe(false);
  });

  it('refuses an empty code rather than asking OpenRouter about it', async () => {
    const { port } = recordingSecrets();
    await expect(
      completeAuthorization({ pending: pendingAt(), code: '   ', secrets: port, now: () => 1 }),
    ).rejects.toBeInstanceOf(OpenRouterOAuthError);
  });

  it('treats a 200 with no key as a failure, not as an empty success', async () => {
    const { port, written } = recordingSecrets();
    const error = await completeAuthorization({
      pending: pendingAt(),
      code: 'code',
      secrets: port,
      now: () => 1,
      fetch: async () => new Response(JSON.stringify({ user_id: 'user_42' }), { status: 200 }),
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(OpenRouterOAuthError);
    expect(written).toEqual([]);
  });

  it('carries the status of a refused exchange, with the provider’s own words', async () => {
    const { port } = recordingSecrets();
    const error = (await completeAuthorization({
      pending: pendingAt(),
      code: 'code',
      secrets: port,
      now: () => 1,
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 400, message: 'invalid code_verifier' } }), {
          status: 400,
        }),
    }).catch((thrown: unknown) => thrown)) as OpenRouterOAuthError;

    expect(error.status).toBe(400);
    expect(error.message).toContain('invalid code_verifier');
  });

  it('fails loudly when the key cannot be stored, rather than reporting a success that stored nothing', async () => {
    // This is today's ordinary outcome, not an edge case: both shipped secrets
    // backends refuse `set` (see ../src/secrets.ts and its TODO(M38)), so the
    // last step of this flow has nowhere to write yet. It must say so.
    const error = (await completeAuthorization({
      pending: pendingAt(),
      code: 'code',
      secrets: refusingSecrets('the environment secrets backend cannot store a value.'),
      now: () => 1,
      fetch: async () => new Response(JSON.stringify({ key: ISSUED_KEY, user_id: null }), { status: 200 }),
    }).catch((thrown: unknown) => thrown)) as OpenRouterOAuthError;

    expect(error).toBeInstanceOf(OpenRouterOAuthError);
    expect(error.message).toContain('could not store it');
    expect(error.message).toContain('cannot store a value');
    // And the key is not in the error either.
    expect(error.message).not.toContain(ISSUED_KEY);
  });
});
