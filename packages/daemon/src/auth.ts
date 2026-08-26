import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ForgeBridgeError } from '@forgebridge/protocol';

/**
 * Producer-side authentication for the local transport.
 *
 * The MAC in `envelope.ts` separates the Studio session we paired with from
 * anything else that found the port — but only in the consumer→daemon
 * direction. The producer direction had no such separation at all: any process
 * on the box, and any web page the user has open that can be made to POST
 * loopback, could submit a ChangeSet, approve it, and dispatch a rollback.
 * Approval is the layer ADR-012 puts between a model and the user's place, and
 * an unauthenticated approve endpoint is that layer switched off.
 *
 * So: one secret, minted per daemon process, printed once where the pairing
 * code is printed, and required on every producer route. It is deliberately not
 * a session key — it never derives anything, it is never used to sign, and it
 * is only ever compared. Its whole job is to answer "is this the caller the
 * human started this daemon for".
 */

const TOKEN_BYTES = 32;

export const PRODUCER_TOKEN_HEADER = 'X-ForgeBridge-Token';

/**
 * The environment variable a client and the daemon can share a token through,
 * for the case where reading it off the terminal is not practical (a CLI
 * spawning its own daemon, a test harness). Absent, a token is minted.
 */
export const PRODUCER_TOKEN_ENV = 'FORGEBRIDGE_PRODUCER_TOKEN';

/** 256 bits from the CSPRNG, base64url so it survives a copy-paste intact. */
export function mintProducerToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time comparison. `===` on a secret leaks its prefix through timing,
 * and `timingSafeEqual` throws outright on a length mismatch — which would turn
 * a wrong-length token into a 500 and, worse, into a length oracle.
 */
export function producerTokenMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reject a producer request that does not carry the token.
 *
 * `link_unauthenticated` is the protocol's only 401 and its comment describes
 * it as "bad or missing MAC", which this is not.
 *
 * TODO(M31): a distinct `unauthenticated` code, as an additive protocol change,
 * so a client can tell "your token is wrong" from "your MAC is wrong" without
 * reading the message. Owner: the protocol maintainer — `packages/protocol` is
 * frozen to this package.
 */
export function assertProducerToken(expected: string, provided: string | undefined): void {
  if (!producerTokenMatches(expected, provided)) {
    throw new ForgeBridgeError(
      'link_unauthenticated',
      `${PRODUCER_TOKEN_HEADER} is missing or does not match this daemon's producer token`,
      'Copy the producer token the daemon printed when it started and send it on this header.',
    );
  }
}
