import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual } from 'node:crypto';
import { ForgeBridgeError } from '@forgebridge/protocol';

/**
 * The producer half of ADR-014's `relay-e2e` mode: X25519 key agreement and
 * ChaCha20-Poly1305 payload encryption, so that a relay would hold ciphertext.
 *
 * READ THIS BEFORE WIRING ANYTHING HERE INTO A ROUTE.
 *
 * `relay-e2e` DOES NOT EXIST and this module does not make it exist. M19 was a
 * spike, and its outcome was that the mode cannot be completed — not because
 * the mathematics is out of reach, but because of the *other* end:
 *
 *   A Studio plugin has no documented source of cryptographic randomness, so
 *   the consumer cannot generate an X25519 private key.
 *
 * The spike went most of the way before hitting that. `plugin/src/Crypto.luau`
 * now contains a pure-Luau ChaCha20-Poly1305 and X25519 that agree with every
 * published RFC 8439 and RFC 7748 vector and with this file, byte for byte, at
 * ten payload sizes and four key agreements — those cross-checks are the
 * vectors committed in `plugin/tests/CryptoSpec.luau`, and they were produced
 * by `node:crypto` here rather than by the Luau code proving itself right. So
 * the arithmetic on both ends is real. What is missing is a secret the consumer
 * can keep, and no amount of further work on the arithmetic supplies one.
 *
 * Deriving the consumer's key from the pairing code instead does not work: the
 * code is about 39 bits, the relay is the adversary, and 2^39 offline X25519
 * trials is hours of ordinary compute. A PAKE does not rescue it either — every
 * PAKE still needs both sides to draw an unpredictable ephemeral scalar.
 *
 * This module is therefore deliberately NOT re-exported from `index.ts`. It is
 * reachable from inside this package and from its tests, and from nowhere else.
 * `assertRelayE2eAvailable` is the gate: any code path that would advertise
 * `relay-e2e` to a user must call it, and it always throws.
 *
 * See docs/architecture/adr-014-staged-pairing-crypto.md for the full outcome.
 */

/**
 * False, and not a configuration knob.
 *
 * The blocker is a property of the Roblox platform, not of this repository, so
 * there is nothing an operator could set that would make it true. It is a
 * constant rather than an env var precisely so that nobody can turn on a
 * privacy claim that the consumer end cannot honour.
 */
export const RELAY_E2E_AVAILABLE = false as const;

export const RELAY_E2E_BLOCKER =
  'the Studio plugin has no documented CSPRNG, so it cannot generate an X25519 private key (ADR-014, M19)';

/**
 * Fail closed. Called by anything that is about to treat a link as end-to-end
 * encrypted.
 *
 * This throws unconditionally today. It is written as a runtime guard rather
 * than as a comment because the failure it prevents is the one ADR-014 cares
 * about most: a surface that says "the relay sees only ciphertext" over a
 * transport that is sending plaintext with a MAC on it. A silent fallback to
 * `relay-tls` would be worse than an error, because the posture string would
 * still be wrong and nobody would be told.
 *
 * `invalid_request` rather than `internal` so that if it is ever reached
 * through an HTTP route the caller gets a 400 naming the reason, not a 500.
 */
export function assertRelayE2eAvailable(): never {
  throw new ForgeBridgeError(
    'invalid_request',
    `end-to-end encrypted relay links are not implemented: ${RELAY_E2E_BLOCKER}`,
    'Use the local daemon for a private link, or a relay-tls link and accept that the relay operator can read changes.',
  );
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * X25519 keys on the wire are 32 raw bytes. Node's KeyObject API speaks DER, so
 * these two prefixes wrap and unwrap raw scalars: the PKCS#8 header for an
 * X25519 private key and the SPKI header for a public one. They are constants
 * of those encodings, not of this protocol.
 */
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface E2eKeyPair {
  /** 32 raw bytes. Never logged, never persisted, never leaves this process. */
  privateKey: Buffer;
  /** 32 raw bytes; safe to send. */
  publicKey: Buffer;
}

/**
 * A fresh ephemeral X25519 keypair, from the platform CSPRNG.
 *
 * This half of the handshake is not the problem — Node has `getrandom(2)`. It
 * is here so the asymmetry is visible in code: the producer can do this and the
 * consumer cannot, and that asymmetry is the whole M19 finding.
 */
export function generateEphemeralKeyPair(): E2eKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(PKCS8_X25519_PREFIX.length),
    publicKey: Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(SPKI_X25519_PREFIX.length),
  };
}

/** Raw 32-byte private scalar to the public key it implies. */
export function publicKeyFromPrivate(privateKey: Buffer): Buffer {
  assertLength(privateKey, KEY_BYTES, 'private key');
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  return Buffer.from(createPublicKey(key).export({ format: 'der', type: 'spki' })).subarray(SPKI_X25519_PREFIX.length);
}

/**
 * X25519 agreement, with the RFC 7748 §6.1 small-order check.
 *
 * Node refuses a small-order peer key inside `diffieHellman` and throws; the
 * Luau implementation follows the RFC letter instead and *returns* 32 zero
 * bytes. The two ends therefore disagree about how this failure surfaces, which
 * is exactly the kind of divergence that becomes a vulnerability when one side
 * treats "all zeros" as a key. Both branches are collapsed into one error here
 * so that a caller cannot proceed either way.
 */
export function agreeSharedSecret(privateKey: Buffer, peerPublicKey: Buffer): Buffer {
  assertLength(privateKey, KEY_BYTES, 'private key');
  assertLength(peerPublicKey, KEY_BYTES, 'peer public key');

  let shared: Buffer;
  try {
    shared = Buffer.from(
      diffieHellman({
        privateKey: createPrivateKey({
          key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]),
          format: 'der',
          type: 'pkcs8',
        }),
        publicKey: createPublicKey({
          key: Buffer.concat([SPKI_X25519_PREFIX, peerPublicKey]),
          format: 'der',
          type: 'spki',
        }),
      }),
    );
  } catch {
    // Node's own small-order rejection lands here. The message is deliberately
    // not forwarded: it is an OpenSSL string, and it says nothing a caller can act on.
    throw new ForgeBridgeError('invalid_request', 'X25519 agreement failed: the peer public key is not usable');
  }

  if (timingSafeEqual(shared, Buffer.alloc(KEY_BYTES))) {
    throw new ForgeBridgeError('invalid_request', 'X25519 agreement produced the all-zero secret; the peer key has small order');
  }
  return shared;
}

/**
 * The proposed session key derivation for `relay-e2e`.
 *
 * PROPOSED, not settled: nothing has implemented the other end of it, so it has
 * never been run against an independent implementation the way the M18
 * derivation was. It is written down because "what remains" is more useful as
 * executable code than as prose, and because the shape is the uncontroversial
 * part — the shared secret as IKM, both public keys as the salt in a fixed
 * order so a swapped key changes the output, and the link id in the info so a
 * key cannot be carried to another link.
 *
 * What it does NOT settle, and what M19 did not get to: the nonce discipline.
 * ChaCha20-Poly1305 fails catastrophically on nonce reuse, and neither option
 * is free — a random 96-bit nonce has a birthday bound that a long-lived link
 * has to be argued about, and a counter needs state that survives a Studio
 * restart. That decision belongs with whoever completes the mode. TODO(M19).
 */
export function deriveE2eKey(input: {
  sharedSecret: Buffer;
  producerPublicKey: Buffer;
  consumerPublicKey: Buffer;
  linkId: string;
}): Buffer {
  assertLength(input.sharedSecret, KEY_BYTES, 'shared secret');
  assertLength(input.producerPublicKey, KEY_BYTES, 'producer public key');
  assertLength(input.consumerPublicKey, KEY_BYTES, 'consumer public key');
  const salt = Buffer.concat([input.producerPublicKey, input.consumerPublicKey]);
  const info = Buffer.from(`forgebridge/v2 e2e key|${input.linkId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', input.sharedSecret, salt, info, KEY_BYTES));
}

export interface SealedPayload {
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * ChaCha20-Poly1305 seal. `aad` is authenticated but not encrypted, and is
 * where the envelope's link id and nonce would go so that a ciphertext cannot
 * be replayed onto another link.
 *
 * The caller owns nonce uniqueness. This function cannot check it — it holds no
 * state — and a repeated nonce under the same key loses both confidentiality
 * and authenticity, so see the TODO in `deriveE2eKey` before using it.
 */
export function sealPayload(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): SealedPayload {
  assertLength(key, KEY_BYTES, 'key');
  assertLength(nonce, NONCE_BYTES, 'nonce');
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

/**
 * ChaCha20-Poly1305 open. Returns null when the tag does not verify.
 *
 * Null and not a throw, and never a partial plaintext: a caller that received
 * bytes alongside a failure flag would eventually use the bytes. Everything
 * that fails authentication — a flipped tag, a flipped ciphertext byte,
 * substituted AAD, the wrong key — takes this one path.
 */
export function openPayload(key: Buffer, nonce: Buffer, sealed: SealedPayload, aad: Buffer): Buffer | null {
  assertLength(key, KEY_BYTES, 'key');
  assertLength(nonce, NONCE_BYTES, 'nonce');
  if (sealed.tag.length !== TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: sealed.ciphertext.length });
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function assertLength(value: Buffer, expected: number, what: string): void {
  if (value.length !== expected) {
    throw new ForgeBridgeError('invalid_request', `${what} must be ${expected} bytes, got ${value.length}`);
  }
}
