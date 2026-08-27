import { createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { ForgeBridgeError, PAIRING, PAIRING_ALPHABET, PairingCode } from '@forgebridge/protocol';

/**
 * Pairing on the relay.
 *
 * The key-derivation half is a copy of `packages/daemon/src/pairing.ts` for the
 * reason given at the top of `envelope.ts`: the plugin derives one key from one
 * code, and a relay that derived a different one would be a second protocol.
 * `test/drift.test.ts` runs both implementations over the same fixtures.
 *
 * The *registry* half is not a copy, and cannot be, because the daemon's
 * assumption does not survive the move to a shared host:
 *
 *   the daemon holds AT MOST ONE outstanding pairing code, and gives that one
 *   code five attempts before revoking it.
 *
 * A relay holds one per waiting user, which breaks that defence in both
 * directions at once.
 *
 * It breaks the *cap*: an attacker no longer has to guess one particular code,
 * only *any* live code. Codes carry ~39 bits, so with `n` outstanding the
 * expected work is 2^39/n guesses, and every extra waiting user makes the
 * search cheaper. Nothing in a per-code counter notices a caller spending one
 * guess against each of a thousand codes.
 *
 * And it breaks the *counter itself*. A relay has to find which pending
 * pairing a submitted code belongs to; doing that by digest lookup means a
 * wrong code resolves to nothing at all, so there is no code to charge an
 * attempt against, and a per-code attempt cap can never fire. Keeping the
 * field and reporting `PAIRING.MAX_ATTEMPTS - 0` would be a number that
 * describes a defence this transport does not have — so `attemptsRemaining` is
 * reported as `null` here, meaning "not the mechanism guarding this", and the
 * mechanism that is guarding it is named below.
 *
 * What actually bounds guessing on the relay is the M45 sliding window: `POST
 * /v1/link/pair` is rate limited per source address like every other route,
 * and a redemption naming no live code consumes that budget exactly as any
 * other does. The TTL and single-use rules are unchanged and still enforced.
 *
 * Every failure is answered identically — same code, same message, same shape.
 * A relay that distinguished "no such code" from "expired code" would hand a
 * scanner a free oracle for which codes exist, and the daemon can only afford
 * to be specific because the person reading its error is the person reading its
 * terminal.
 */

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const KEY_ID_CHARS = 22;

/**
 * A ceiling on live codes, so a caller that hammers the session route cannot
 * turn this map into the process's memory ceiling. Reached, the oldest pending
 * code is dropped: an expired-looking pairing is a bad afternoon for one user,
 * and an out-of-memory relay is a bad afternoon for all of them.
 */
export const MAX_PENDING_CODES = 10_000;

export interface IssuedPairingCode {
  code: string;
  expiresAt: string;
}

export interface PairingStatus {
  expiresAt: string;
  /**
   * Always `null` on this transport. See the header: a per-code attempt cap
   * cannot fire behind a digest lookup, and a relay reporting five remaining
   * attempts would be describing the daemon's defence, not its own.
   */
  attemptsRemaining: null;
}

export interface RedeemedPairing {
  /** The symmetric key both ends MAC under. Never persisted, never logged. */
  sessionKey: Buffer;
  /** A public handle for the key — safe to store and to show in a UI. */
  sessionKeyId: string;
  /** Returned to the consumer so it can derive the same key from the code. */
  salt: Buffer;
  /** Which relay session this code belonged to. */
  sessionId: string;
}

interface PendingPairing {
  sessionId: string;
  salt: Buffer;
  expiresAtMs: number;
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
 * over the 8-character space from being reusable across relays.
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

/** Index key for a code. A digest, so the plaintext is not a map key. */
function codeIndex(code: string): string {
  return createHash('sha256')
    .update('forgebridge/v1/pairing-code-index', 'utf8')
    .update(normalisePairingCode(code), 'utf8')
    .digest('base64');
}

/**
 * Every pairing code this relay is currently willing to redeem, keyed by a
 * digest of the code.
 *
 * Looking a code up by digest rather than scanning a list is deliberate: a scan
 * whose cost depends on how many codes share a prefix is a timing channel over
 * the code space, and a map keyed on the full digest has no such structure.
 */
export class RelayPairingRegistry {
  readonly #pending = new Map<string, PendingPairing>();
  readonly #now: () => number;
  readonly #max: number;

  constructor(options: { now?: () => number; maxPending?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#max = options.maxPending ?? MAX_PENDING_CODES;
  }

  get size(): number {
    return this.#pending.size;
  }

  /**
   * Mint a code for a session, replacing any code that session already has.
   *
   * Replacing rather than adding: a user who clicks "new code" must not leave
   * the old one alive behind them, which is the same rule the daemon's
   * single-slot service enforces by construction.
   */
  issue(sessionId: string): IssuedPairingCode {
    this.#sweep();
    this.revokeFor(sessionId);
    if (this.#pending.size >= this.#max) this.#dropOldest();

    const code = generatePairingCode();
    const expiresAtMs = this.#now() + PAIRING.TTL_SECONDS * 1000;
    this.#pending.set(codeIndex(code), {
      sessionId,
      salt: randomBytes(SALT_BYTES),
      expiresAtMs,
    });
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  statusFor(sessionId: string): PairingStatus | null {
    this.#sweep();
    for (const pending of this.#pending.values()) {
      if (pending.sessionId !== sessionId) continue;
      return { expiresAt: new Date(pending.expiresAtMs).toISOString(), attemptsRemaining: null };
    }
    return null;
  }

  revokeFor(sessionId: string): void {
    for (const [key, pending] of this.#pending) {
      if (pending.sessionId === sessionId) this.#pending.delete(key);
    }
  }

  /**
   * Redeem a code for a link id.
   *
   * One lookup, one refusal. There is no branch here that a caller can learn
   * anything from: an unknown digest, an expired entry and a burned entry all
   * leave through the same `refusal()`, and the lookup itself is keyed on the
   * full digest so its cost carries no information about which codes are live.
   */
  redeem(rawCode: string, linkId: string): RedeemedPairing {
    this.#sweep();
    const key = codeIndex(rawCode);
    const pending = this.#pending.get(key);

    if (!pending || this.#now() >= pending.expiresAtMs) {
      if (pending) this.#pending.delete(key);
      throw refusal();
    }

    // Single use: burn it before deriving, so a concurrent second redeem of the
    // same code loses the race rather than getting a second link.
    this.#pending.delete(key);

    const sessionKey = deriveSessionKey(rawCode, pending.salt, linkId);
    return {
      sessionKey,
      sessionKeyId: sessionKeyIdOf(sessionKey),
      salt: pending.salt,
      sessionId: pending.sessionId,
    };
  }

  #sweep(): void {
    const now = this.#now();
    for (const [key, pending] of this.#pending) {
      if (now >= pending.expiresAtMs) this.#pending.delete(key);
    }
  }

  #dropOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, pending] of this.#pending) {
      if (pending.expiresAtMs < oldestAt) {
        oldestAt = pending.expiresAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.#pending.delete(oldestKey);
  }
}

function refusal(): ForgeBridgeError {
  return new ForgeBridgeError(
    'link_unauthenticated',
    'that pairing code is not redeemable',
    `Codes are single-use and valid for ${PAIRING.TTL_SECONDS} seconds. Ask the web app for a fresh one.`,
  );
}

/** True when a string is shaped like a pairing code the protocol would accept. */
export function isWellFormedPairingCode(input: string): boolean {
  return PairingCode.safeParse(input).success;
}
