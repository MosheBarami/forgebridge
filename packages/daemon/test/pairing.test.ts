import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PAIRING, PairingCode } from '@forgebridge/protocol';
import {
  PairingService,
  deriveSessionKey,
  generatePairingCode,
  normalisePairingCode,
  sessionKeyIdOf,
} from '../src/pairing.js';

function clock(startMs = 1_700_000_000_000): { now: () => number; advance: (seconds: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (seconds) => { current += seconds * 1000; } };
}

describe('generatePairingCode', () => {
  it('produces codes the protocol schema accepts', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(PairingCode.safeParse(generatePairingCode()).success).toBe(true);
    }
  });

  it('does not repeat — a generator that did would not be random', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generatePairingCode()));
    expect(codes.size).toBe(500);
  });
});

describe('PairingService', () => {
  it('redeems a correct code exactly once', () => {
    const service = new PairingService();
    const { code } = service.issue();
    const linkId = randomUUID();

    const redeemed = service.redeem(code, linkId);
    expect(redeemed.sessionKey).toHaveLength(32);
    expect(redeemed.sessionKeyId).not.toContain('=');

    // Single use: a shoulder-surfed code is worthless the moment it is spent.
    expect(() => service.redeem(code, randomUUID())).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('expires a code at the protocol TTL', () => {
    const time = clock();
    const service = new PairingService({ now: time.now });
    const { code } = service.issue();

    time.advance(PAIRING.TTL_SECONDS - 1);
    expect(service.status()).not.toBeNull();

    time.advance(1);
    expect(service.status()).toBeNull();
    expect(() => service.redeem(code, randomUUID())).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('revokes the code after the protocol attempt limit', () => {
    const service = new PairingService();
    const { code } = service.issue();

    for (let attempt = 1; attempt < PAIRING.MAX_ATTEMPTS; attempt += 1) {
      expect(() => service.redeem('AAAAAAAA', randomUUID())).toThrow();
      expect(service.status()?.attemptsRemaining).toBe(PAIRING.MAX_ATTEMPTS - attempt);
    }

    // The last wrong guess burns the code, so the correct one no longer works.
    expect(() => service.redeem('AAAAAAAA', randomUUID())).toThrow();
    expect(service.status()).toBeNull();
    expect(() => service.redeem(code, randomUUID())).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('counts a malformed guess as an attempt, not as a free retry', () => {
    const service = new PairingService();
    service.issue();
    expect(() => service.redeem('', randomUUID())).toThrow();
    expect(service.status()?.attemptsRemaining).toBe(PAIRING.MAX_ATTEMPTS - 1);
  });

  it('replaces any outstanding code when a new one is issued', () => {
    const service = new PairingService();
    const first = service.issue();
    service.issue();
    expect(() => service.redeem(first.code, randomUUID())).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('refuses to redeem when nothing is outstanding', () => {
    const service = new PairingService();
    expect(() => service.redeem('ABCDEFGH', randomUUID())).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });
});

describe('session key derivation', () => {
  it('is deterministic, so both ends derive the same key from the code', () => {
    const salt = Buffer.alloc(32, 3);
    const linkId = randomUUID();
    expect(deriveSessionKey('ABCDEFGH', salt, linkId)).toEqual(deriveSessionKey('abcdefgh', salt, linkId));
  });

  it('binds the key to the link, so one code cannot key two links', () => {
    const salt = Buffer.alloc(32, 3);
    expect(deriveSessionKey('ABCDEFGH', salt, randomUUID())).not.toEqual(
      deriveSessionKey('ABCDEFGH', salt, randomUUID()),
    );
  });

  it('binds the key to the salt, so a precomputed table does not transfer', () => {
    const linkId = randomUUID();
    expect(deriveSessionKey('ABCDEFGH', Buffer.alloc(32, 1), linkId)).not.toEqual(
      deriveSessionKey('ABCDEFGH', Buffer.alloc(32, 2), linkId),
    );
  });

  it('names a key without revealing it', () => {
    const key = Buffer.alloc(32, 5);
    const id = sessionKeyIdOf(key);
    expect(id).toHaveLength(22);
    expect(id).not.toContain(key.toString('base64url'));
  });
});

describe('normalisePairingCode', () => {
  it('accepts what people actually type', () => {
    expect(normalisePairingCode(' abcd-efgh ')).toBe('ABCDEFGH');
  });
});
