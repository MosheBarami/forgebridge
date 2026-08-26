import { describe, expect, it } from 'vitest';
import { assertProducerToken, mintProducerToken, producerTokenMatches } from '../src/auth.js';

describe('producer token', () => {
  it('mints a distinct 256-bit token each time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintProducerToken()));
    expect(tokens.size).toBe(50);
    // base64url of 32 bytes, with no padding to be mangled in a copy-paste.
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('matches only the exact token', () => {
    const token = mintProducerToken();
    expect(producerTokenMatches(token, token)).toBe(true);
    expect(producerTokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(producerTokenMatches(token, `${token}x`)).toBe(false);
    expect(producerTokenMatches(token, token.toUpperCase())).toBe(false);
  });

  it('refuses a missing or empty presentation instead of throwing on the length', () => {
    // `timingSafeEqual` throws on a length mismatch: unguarded, a wrong-length
    // token would be a 500 and a length oracle rather than a clean 401.
    const token = mintProducerToken();
    expect(producerTokenMatches(token, undefined)).toBe(false);
    expect(producerTokenMatches(token, '')).toBe(false);
    expect(producerTokenMatches('', '')).toBe(false);
  });

  it('raises the protocol 401 with something to do about it', () => {
    const token = mintProducerToken();
    expect(() => assertProducerToken(token, token)).not.toThrow();
    expect(() => assertProducerToken(token, 'nope')).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated', status: 401 }),
    );
  });
});
