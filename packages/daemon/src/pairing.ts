import { createHash, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { ForgeBridgeError, PAIRING, PAIRING_ALPHABET, PairingCode } from '@forgebridge/protocol';

/**
 * Pairing: a short code the human carries from the daemon's terminal to the
 * Studio plugin, turned into a session key both ends can derive.
 *
 * The code is the shared secret. It is small on purpose — people have to read
 * it aloud and type it — so its strength comes from the three limits the
 * protocol fixes rather than from entropy: a 10-minute TTL, five attempts, and
 * single use. Every one of those is enforced here, and none of them is
 * configurable.
 */

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const KEY_ID_CHARS = 22;

export interface IssuedPairingCode {
  code: string;
  expiresAt: string;
}

export interface PairingStatus {
  expiresAt: string;
  attemptsRemaining: number;
}

export interface RedeemedPairing {
  /** The symmetric key both ends MAC under. Never persisted, never logged. */
  sessionKey: Buffer;
  /** A public handle for the key — safe to store and to show in a UI. */
  sessionKeyId: string;
  /** Returned to the consumer so it can derive the same key from the code. */
  salt: Buffer;
}

interface PendingPairing {
  codeHash: Buffer;
  salt: Buffer;
  expiresAtMs: number;
  attempts: number;
}

/**
 * Generate a code with `crypto.randomInt`, which rejection-samples to stay
 * uniform over the alphabet. `Math.random` is a non-cryptographic PRNG whose
 * internal state is recoverable from a handful of outputs — this is the one
 * secret that stands between a stranger's process and the user's place.
 */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING.CODE_LENGTH; i += 1) {
    code += PAIRING_ALPHABET.charAt(randomInt(PAIRING_ALPHABET.length));
  }
  return code;
}

/** Uppercase and strip the separators people insert when reading a code aloud. */
export function normalisePairingCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * HKDF-SHA256 over the code, salted per pairing.
 *
 * Deriving from the code alone means an attacker who guesses the code holds the
 * session key — which is exactly the security level pairing already has, so it
 * adds no weakness, and it lets a Luau consumer derive the key with the
 * HMAC-SHA256 it already needs for the MAC. The salt stops a precomputed table
 * over the 8-character space from being reusable across daemons.
 */
export function deriveSessionKey(code: string, salt: Buffer, linkId: string): Buffer {
  const info = Buffer.from(`forgebridge/v1 session key|${linkId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', Buffer.from(normalisePairingCode(code), 'utf8'), salt, info, KEY_BYTES));
}

/** A non-secret name for a key: a hash, so it can be shown and stored freely. */
export function sessionKeyIdOf(sessionKey: Buffer): string {
  return createHash('sha256')
    .update('forgebridge/v1/session-key-id', 'utf8')
    .update(sessionKey)
    .digest('base64url')
    .slice(0, KEY_ID_CHARS);
}

export class PairingService {
  /**
   * At most one code is outstanding. Issuing a second replaces the first, so a
   * user who clicks "new code" cannot leave an older one alive behind them.
   */
  #pending: PendingPairing | null = null;
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  issue(): IssuedPairingCode {
    const code = generatePairingCode();
    const expiresAtMs = this.#now() + PAIRING.TTL_SECONDS * 1000;
    this.#pending = {
      // Hashed so the plaintext code does not sit in the heap for its whole
      // TTL. This is not a password hash and does not pretend to be one — an
      // 8-character code falls to an offline search instantly. The defences
      // that matter are the TTL, the attempt cap, and single use.
      codeHash: hashCode(code),
      salt: randomBytes(SALT_BYTES),
      expiresAtMs,
      attempts: 0,
    };
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  status(): PairingStatus | null {
    const pending = this.#pending;
    if (!pending) return null;
    if (this.#now() >= pending.expiresAtMs) {
      this.#pending = null;
      return null;
    }
    return {
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
      attemptsRemaining: PAIRING.MAX_ATTEMPTS - pending.attempts,
    };
  }

  revoke(): void {
    this.#pending = null;
  }

  redeem(rawCode: string, linkId: string): RedeemedPairing {
    const pending = this.#pending;
    if (!pending) {
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'no pairing code is outstanding',
        'Issue a new pairing code from the daemon and try again.',
      );
    }

    if (this.#now() >= pending.expiresAtMs) {
      this.#pending = null;
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'the pairing code has expired',
        `Codes are valid for ${PAIRING.TTL_SECONDS} seconds. Issue a new one.`,
      );
    }

    // Counted before the comparison: an exception thrown between comparing and
    // counting would hand an attacker an unlimited number of free guesses.
    pending.attempts += 1;
    const correct = timingSafeEqual(hashCode(normalisePairingCode(rawCode)), pending.codeHash);

    if (!correct) {
      if (pending.attempts >= PAIRING.MAX_ATTEMPTS) {
        this.#pending = null;
        throw new ForgeBridgeError(
          'link_unauthenticated',
          'too many incorrect pairing attempts; this code has been revoked',
          'Issue a new pairing code from the daemon.',
        );
      }
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'incorrect pairing code',
        `${PAIRING.MAX_ATTEMPTS - pending.attempts} attempt(s) remain before this code is revoked.`,
      );
    }

    // Single use: burn it before deriving, so a concurrent second redeem of the
    // same code loses the race rather than getting a second link.
    this.#pending = null;

    const sessionKey = deriveSessionKey(rawCode, pending.salt, linkId);
    return { sessionKey, sessionKeyId: sessionKeyIdOf(sessionKey), salt: pending.salt };
  }
}

function hashCode(code: string): Buffer {
  return createHash('sha256').update(code, 'utf8').digest();
}

/** True when a string is shaped like a pairing code the protocol would accept. */
export function isWellFormedPairingCode(input: string): boolean {
  return PairingCode.safeParse(input).success;
}
