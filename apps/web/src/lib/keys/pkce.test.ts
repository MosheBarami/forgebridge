import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CODE_CHALLENGE_METHOD,
  base64url,
  createPkcePair,
  deriveCodeChallenge,
  generateCodeVerifier,
  beginFlow,
  endFlow,
  readFlow,
} from './pkce';

/**
 * PKCE against RFC 7636, including its own worked example.
 *
 * The appendix vector is the one test here that would catch the mistake that
 * actually happens: base64url encoding that keeps its `=` padding. A padded
 * challenge is accepted by every local check, travels fine on the URL, and
 * fails at redemption as an opaque "invalid grant" — long after the mistake,
 * against a live server, where it is hardest to diagnose.
 */
beforeAll(() => {
  // This file is a `.test.ts`, so it runs in the `gates` project under the node
  // environment (see `vitest.config.ts`) — no `window`, no `sessionStorage`.
  // Both are stubbed rather than the file being renamed to `.tsx`: nothing here
  // renders, and the two properties this module touches are small enough to
  // model exactly.
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  if (typeof globalThis.window === 'undefined') {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
          removeItem: (key: string) => void store.delete(key),
        },
      },
    });
  }
});

describe('base64url', () => {
  it('drops padding and uses the URL-safe alphabet', () => {
    // Bytes chosen so the standard alphabet would emit both `+` and `/`.
    expect(base64url(new Uint8Array([0xfb, 0xef, 0xff]))).toBe('--__');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
    expect(base64url(new Uint8Array([1, 2]))).toBe('AQI');
  });
});

describe('RFC 7636 appendix B', () => {
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('derives the published challenge from the published verifier', async () => {
    await expect(deriveCodeChallenge(VERIFIER)).resolves.toBe(CHALLENGE);
  });
});

describe('the generated pair', () => {
  it('produces a 43-character verifier from the unreserved set', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    // RFC 7636 §4.1: ALPHA / DIGIT / "-" / "." / "_" / "~". base64url emits a
    // subset of that, so anything outside it is an encoding bug.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('is different every time', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it('only ever offers S256', async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe(CODE_CHALLENGE_METHOD);
    expect(pair.method).toBe('S256');
    await expect(deriveCodeChallenge(pair.codeVerifier)).resolves.toBe(pair.codeChallenge);
  });
});

describe('the pending flow', () => {
  const flow = {
    codeVerifier: 'verifier',
    state: 'state',
    returnTo: '/en/settings/keys',
    startedAt: '2026-01-01T00:00:00.000Z',
  };

  it('round-trips and is single use', () => {
    beginFlow(flow);
    expect(readFlow()).toEqual(flow);
    endFlow();
    expect(readFlow()).toBeNull();
  });

  it('refuses a protocol-relative returnTo', () => {
    // sessionStorage is editable by anything on this origin, and `returnTo`
    // becomes an href — `//evil.example` would leave the site entirely.
    beginFlow({ ...flow, returnTo: '//evil.example/steal' });
    expect(readFlow()).toBeNull();
    endFlow();
  });

  it('refuses an absolute returnTo', () => {
    beginFlow({ ...flow, returnTo: 'https://evil.example/steal' });
    expect(readFlow()).toBeNull();
    endFlow();
  });

  it('refuses a record missing a field rather than filling one in', () => {
    window.sessionStorage.setItem('fb-oauth-flow', JSON.stringify({ codeVerifier: 'only' }));
    expect(readFlow()).toBeNull();
    endFlow();
  });
});
