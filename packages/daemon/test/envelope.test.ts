import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForgeBridgeError } from '@forgebridge/protocol';
import {
  assertFreshNonce,
  canonicalJson,
  envelopeMac,
  macMatches,
  openEnvelope,
  requestMac,
  sealEnvelope,
  verifyRequestMac,
} from '../src/envelope.js';

const KEY = Buffer.alloc(32, 7);
const LINK = randomUUID();

describe('canonicalJson', () => {
  it('does not depend on key insertion order', () => {
    // The two ends serialise independently — the plugin in Luau, where table
    // order is undefined. If order changed the bytes, MACs would fail at random.
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it('preserves array order, which is semantic', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined members rather than emitting invalid JSON', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses a non-finite number instead of serialising it as null', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(ForgeBridgeError);
  });
});

describe('MAC', () => {
  it('is stable for the same object written two ways', () => {
    const one = sealEnvelope(KEY, { linkId: LINK, nonce: 1, payload: { a: 1, b: 2 } });
    const two = sealEnvelope(KEY, { linkId: LINK, nonce: 1, payload: { b: 2, a: 1 } });
    expect(one.mac).toBe(two.mac);
  });

  it('changes when the link changes, so a set cannot be moved between links', () => {
    const payload = { kind: 'x' };
    const mine = envelopeMac(KEY, { linkId: LINK, nonce: 1, encrypted: false, payload: canonicalJson(payload) });
    const theirs = envelopeMac(KEY, { linkId: randomUUID(), nonce: 1, encrypted: false, payload: canonicalJson(payload) });
    expect(mine).not.toBe(theirs);
  });

  it('changes when the nonce changes, so replay detection cannot be edited away', () => {
    const payload = canonicalJson({ kind: 'x' });
    expect(envelopeMac(KEY, { linkId: LINK, nonce: 1, encrypted: false, payload })).not.toBe(
      envelopeMac(KEY, { linkId: LINK, nonce: 2, encrypted: false, payload }),
    );
  });

  it('refuses a MAC of the wrong length without throwing', () => {
    expect(macMatches('abcd', '')).toBe(false);
    expect(macMatches('', '')).toBe(false);
  });

  it('length-prefixes request MAC parts so they cannot be re-split', () => {
    expect(requestMac(KEY, ['ab', 'c'])).not.toBe(requestMac(KEY, ['a', 'bc']));
    expect(verifyRequestMac(KEY, ['ab', 'c'], requestMac(KEY, ['ab', 'c']))).toBe(true);
  });
});

describe('openEnvelope', () => {
  const seal = (nonce: number, payload: unknown) => sealEnvelope(KEY, { linkId: LINK, nonce, payload });

  it('opens an envelope it sealed itself', () => {
    const opened = openEnvelope(KEY, seal(1, { hello: 'world' }), { linkId: LINK, lastAcceptedNonce: 0 });
    expect(opened.payload).toEqual({ hello: 'world' });
  });

  it('rejects a tampered payload', () => {
    const envelope = seal(1, { newVersion: 1 });
    const tampered = { ...envelope, payload: envelope.payload.replace('1', '9999') };
    expect(() => openEnvelope(KEY, tampered, { linkId: LINK, lastAcceptedNonce: 0 })).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('rejects an envelope signed with a different key', () => {
    const envelope = sealEnvelope(Buffer.alloc(32, 9), { linkId: LINK, nonce: 1, payload: { a: 1 } });
    expect(() => openEnvelope(KEY, envelope, { linkId: LINK, lastAcceptedNonce: 0 })).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('rejects an envelope addressed to another link', () => {
    const envelope = seal(1, { a: 1 });
    expect(() => openEnvelope(KEY, envelope, { linkId: randomUUID(), lastAcceptedNonce: 0 })).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('rejects a replayed nonce', () => {
    const envelope = seal(3, { a: 1 });
    expect(() => openEnvelope(KEY, envelope, { linkId: LINK, lastAcceptedNonce: 3 })).toThrow(
      expect.objectContaining({ code: 'replay_detected' }),
    );
    expect(() => openEnvelope(KEY, envelope, { linkId: LINK, lastAcceptedNonce: 4 })).toThrow(
      expect.objectContaining({ code: 'replay_detected' }),
    );
  });

  it('authenticates before it checks freshness', () => {
    // Otherwise an unauthenticated caller could push the watermark forward and
    // lock the real consumer out with a forged high nonce.
    const forged = { linkId: LINK, nonce: 9_000, payload: '{"a":1}', mac: 'AAAA', encrypted: false };
    expect(() => openEnvelope(KEY, forged, { linkId: LINK, lastAcceptedNonce: 0 })).toThrow(
      expect.objectContaining({ code: 'link_unauthenticated' }),
    );
  });

  it('refuses an encrypted payload on a transport that cannot decrypt one', () => {
    const envelope = seal(1, { a: 1 });
    const claimed = { ...envelope, encrypted: true };
    expect(() => openEnvelope(KEY, claimed, { linkId: LINK, lastAcceptedNonce: 0 })).toThrow(ForgeBridgeError);
  });
});

describe('assertFreshNonce', () => {
  it('accepts strictly increasing nonces only', () => {
    expect(() => assertFreshNonce(1, 0)).not.toThrow();
    expect(() => assertFreshNonce(1, 1)).toThrow(expect.objectContaining({ code: 'replay_detected' }));
    expect(() => assertFreshNonce(-1, 0)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => assertFreshNonce(1.5, 0)).toThrow(expect.objectContaining({ code: 'invalid_request' }));
  });
});
