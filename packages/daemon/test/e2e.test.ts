import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ForgeBridgeError } from '@forgebridge/protocol';
import {
  RELAY_E2E_AVAILABLE,
  RELAY_E2E_BLOCKER,
  agreeSharedSecret,
  assertRelayE2eAvailable,
  deriveE2eKey,
  generateEphemeralKeyPair,
  openPayload,
  publicKeyFromPrivate,
  sealPayload,
} from '../src/e2e.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (s: string) => Buffer.from(s, 'hex');

describe('relay-e2e is not implemented, and says so', () => {
  it('reports itself unavailable', () => {
    expect(RELAY_E2E_AVAILABLE).toBe(false);
    expect(RELAY_E2E_BLOCKER).toMatch(/CSPRNG/);
  });

  it('throws rather than falling back', () => {
    // The failure this prevents: a surface rendering "the relay sees only
    // ciphertext" over a transport that is sending plaintext with a MAC on it.
    expect(() => assertRelayE2eAvailable()).toThrow(ForgeBridgeError);
    expect(() => assertRelayE2eAvailable()).toThrow(/not implemented/);
  });

  /**
   * `index.ts` is the package's whole public surface, and it is `export *` per
   * file. Adding one line there would put an unfinished mode into the API of a
   * published package, so the absence of that line is asserted rather than
   * trusted to review.
   */
  it('is not re-exported from the package entry point', () => {
    const index = readFileSync(path.join(REPO_ROOT, 'packages/daemon/src/index.ts'), 'utf8');
    expect(index).not.toMatch(/['"]\.\/e2e\.js['"]/);
  });

  /**
   * The existing envelope path must keep refusing encrypted payloads. If this
   * ever goes green by accident, the daemon has started accepting a payload it
   * cannot decrypt.
   */
  it('leaves the envelope path refusing encrypted deliveries', () => {
    const envelope = readFileSync(path.join(REPO_ROOT, 'packages/daemon/src/envelope.ts'), 'utf8');
    expect(envelope).toMatch(/this transport does not accept encrypted payloads/);
  });
});

describe('X25519 (RFC 7748)', () => {
  it('reproduces the §6.1 Diffie-Hellman vector', () => {
    const alice = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const bob = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    const alicePublic = publicKeyFromPrivate(alice);
    const bobPublic = publicKeyFromPrivate(bob);
    expect(alicePublic.toString('hex')).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(bobPublic.toString('hex')).toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    const expected = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(agreeSharedSecret(alice, bobPublic).toString('hex')).toBe(expected);
    expect(agreeSharedSecret(bob, alicePublic).toString('hex')).toBe(expected);
  });

  it('agrees on a fresh ephemeral pair in both directions', () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    expect(publicKeyFromPrivate(a.privateKey)).toEqual(a.publicKey);
    expect(agreeSharedSecret(a.privateKey, b.publicKey)).toEqual(agreeSharedSecret(b.privateKey, a.publicKey));
  });

  it('refuses a small-order peer key instead of agreeing on zero', () => {
    const a = generateEphemeralKeyPair();
    // The Luau implementation returns 32 zero bytes for these, per RFC 7748 §6.1.
    // Both must be refusals here, or "all zeros" becomes a key an attacker chose.
    expect(() => agreeSharedSecret(a.privateKey, Buffer.alloc(32))).toThrow(ForgeBridgeError);
    expect(() => agreeSharedSecret(a.privateKey, Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]))).toThrow(
      ForgeBridgeError,
    );
    // The control: an honest peer key still agrees.
    expect(agreeSharedSecret(a.privateKey, generateEphemeralKeyPair().publicKey)).toHaveLength(32);
  });

  it('refuses keys of the wrong length', () => {
    const a = generateEphemeralKeyPair();
    expect(() => agreeSharedSecret(a.privateKey.subarray(0, 31), a.publicKey)).toThrow(/32 bytes/);
    expect(() => agreeSharedSecret(a.privateKey, a.publicKey.subarray(0, 31))).toThrow(/32 bytes/);
  });
});

describe('ChaCha20-Poly1305 (RFC 8439)', () => {
  it('reproduces the §2.8.2 AEAD vector', () => {
    const { ciphertext, tag } = sealPayload(
      hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'),
      hex('070000004041424344454647'),
      Buffer.from(
        "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
        'utf8',
      ),
      hex('50515253c0c1c2c3c4c5c6c7'),
    );
    expect(ciphertext.toString('hex')).toBe(
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116',
    );
    expect(tag.toString('hex')).toBe('1ae10b594f09e26a7e902ecbd0600691');
  });

  it('returns null for every way a delivery can be tampered with', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 3);
    const aad = Buffer.from('lnk_7Q2W|1', 'utf8');
    const plaintext = Buffer.from('{"op":"setProperty"}', 'utf8');
    const sealed = sealPayload(key, nonce, plaintext, aad);

    const flip = (b: Buffer) => Buffer.concat([Buffer.from([b[0]! ^ 1]), b.subarray(1)]);
    expect(openPayload(key, nonce, { ...sealed, tag: flip(sealed.tag) }, aad)).toBeNull();
    expect(openPayload(key, nonce, { ...sealed, ciphertext: flip(sealed.ciphertext) }, aad)).toBeNull();
    expect(openPayload(key, nonce, sealed, Buffer.from('lnk_ZZZZ|1', 'utf8'))).toBeNull();
    expect(openPayload(Buffer.alloc(32, 8), nonce, sealed, aad)).toBeNull();
    expect(openPayload(key, Buffer.alloc(12, 4), sealed, aad)).toBeNull();
    expect(openPayload(key, nonce, { ...sealed, tag: sealed.tag.subarray(0, 15) }, aad)).toBeNull();

    // The control: none of the above rejected the legitimate delivery.
    expect(openPayload(key, nonce, sealed, aad)).toEqual(plaintext);
  });
});

describe('the proposed e2e key derivation', () => {
  /**
   * Property tests only, and deliberately labelled as such. Every other
   * derivation in this repository is pinned to an independent implementation;
   * this one cannot be, because the consumer half does not exist. These assert
   * that each input actually reaches the output — which is the most a single
   * implementation can honestly prove about itself.
   */
  const base = {
    sharedSecret: Buffer.alloc(32, 1),
    producerPublicKey: Buffer.alloc(32, 2),
    consumerPublicKey: Buffer.alloc(32, 3),
    linkId: 'lnk_7Q2W',
  };

  it('is deterministic and 32 bytes', () => {
    expect(deriveE2eKey(base)).toHaveLength(32);
    expect(deriveE2eKey(base)).toEqual(deriveE2eKey(base));
  });

  it('changes when any bound input changes', () => {
    const key = deriveE2eKey(base).toString('hex');
    expect(deriveE2eKey({ ...base, sharedSecret: Buffer.alloc(32, 9) }).toString('hex')).not.toBe(key);
    expect(deriveE2eKey({ ...base, linkId: 'lnk_ZZZZ' }).toString('hex')).not.toBe(key);
    // Swapping the two public keys must change the output, or the salt would
    // not bind which side is which.
    expect(
      deriveE2eKey({ ...base, producerPublicKey: base.consumerPublicKey, consumerPublicKey: base.producerPublicKey })
        .toString('hex'),
    ).not.toBe(key);
  });
});

/**
 * The Luau half of this protocol is verified against vectors that came out of
 * `node:crypto`, and `plugin/tests/CryptoSpec.luau` commits them as literals.
 * Nothing in CI runs Luau (see the TODO(M41) in .github/workflows/ci.yml), so
 * without this the committed expectations could be edited to match a broken
 * implementation and every gate in the repository would stay green.
 *
 * This recomputes them here. It does not prove the Luau code is right — only a
 * Luau runtime can do that — but it proves the numbers it is measured against
 * are still the ones Node produces.
 */
describe('the vectors committed in plugin/tests/CryptoSpec.luau', () => {
  const spec = readFileSync(path.join(REPO_ROOT, 'plugin/tests/CryptoSpec.luau'), 'utf8');

  const table = (name: string, columns: number): string[][] => {
    const start = spec.indexOf(`local ${name} = {`);
    expect(start, `${name} not found in CryptoSpec.luau`).toBeGreaterThan(-1);
    const body = spec.slice(start, spec.indexOf('\n\t\t}', start));
    const rows = [...body.matchAll(/\{ ((?:"[0-9a-f]*",? ?)+)\}/g)].map((m) =>
      [...m[1]!.matchAll(/"([0-9a-f]*)"/g)].map((q) => q[1]!),
    );
    expect(rows.length, `${name} has no rows`).toBeGreaterThan(0);
    for (const row of rows) expect(row).toHaveLength(columns);
    return rows;
  };

  it('still match node:crypto for X25519', () => {
    const rows = table('AGREEMENTS', 5);
    expect(rows).toHaveLength(4);
    for (const [alice, bob, alicePublic, bobPublic, shared] of rows) {
      expect(publicKeyFromPrivate(hex(alice!)).toString('hex')).toBe(alicePublic);
      expect(publicKeyFromPrivate(hex(bob!)).toString('hex')).toBe(bobPublic);
      expect(agreeSharedSecret(hex(alice!), hex(bobPublic!)).toString('hex')).toBe(shared);
      expect(agreeSharedSecret(hex(bob!), hex(alicePublic!)).toString('hex')).toBe(shared);
    }
  });

  it('still match node:crypto for ChaCha20-Poly1305', () => {
    const rows = table('SEALS', 6);
    expect(rows).toHaveLength(10);
    // The row set must keep covering the block boundaries it was chosen for:
    // empty, sub-block, exactly one block, and either side of a block edge.
    expect(rows.map((r) => r[3]!.length / 2)).toEqual([0, 1, 15, 16, 17, 63, 64, 65, 130, 500]);
    for (const [key, nonce, aad, plaintext, ciphertext, tag] of rows) {
      const sealed = sealPayload(hex(key!), hex(nonce!), hex(plaintext!), hex(aad!));
      expect(sealed.ciphertext.toString('hex')).toBe(ciphertext);
      expect(sealed.tag.toString('hex')).toBe(tag);
    }
  });
});
