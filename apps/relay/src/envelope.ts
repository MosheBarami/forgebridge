import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeliveryEnvelope, ForgeBridgeError } from '@forgebridge/protocol';

/**
 * Envelope authentication for the relay transport.
 *
 * ── WHY THIS FILE IS A COPY, AND WHAT KEEPS IT HONEST ────────────────────────
 *
 * `packages/daemon/src/envelope.ts` is the reference implementation and its own
 * header says why this file has to agree with it byte for byte: "the same
 * scheme the relay uses, so the plugin has one code path". The plugin computes
 * one MAC in Luau and sends it to whichever transport it was pointed at; a
 * relay whose MAC differs by a single separator is a relay that authenticates
 * nothing and refuses everyone.
 *
 * The obvious move — `import { envelopeMac } from '@forgebridge/daemon'` — was
 * rejected. That package's entry point pulls in `@forgebridge/core`, the Luau
 * analyser, the model registry and the OpenRouter adapter, and its `exports`
 * map has no deep paths, so there is no way to take the 120 lines this needs
 * without taking all of it. A relay image containing a provider client is a
 * relay whose "holds no API keys" a self-hoster has to take on trust rather
 * than read off the dependency list, and ADR-004 puts the relay's small size
 * among the reasons the two-transport decision is affordable at all.
 *
 * So: a copy, and a gate that makes the copy fail loudly rather than silently.
 * `test/drift.test.ts` imports the daemon's implementation as a devDependency
 * and runs both over the same fixture matrix — canonical JSON, both MAC
 * domains, key derivation, seal and open in both directions. A divergence is a
 * red test in this app, not a field report of "pairing works locally and not
 * on the relay".
 *
 * TODO(M31): the conformance suite is the forcing function for promoting this
 * scheme into `@forgebridge/protocol`, where both transports would import it
 * and the copy could be deleted. Owner: the protocol maintainer — the crypto
 * would arrive with the pairing-handshake specification `docs/PROTOCOL.md`
 * already records as missing (TODO(M30)).
 */

const ENVELOPE_DOMAIN = 'forgebridge/v1/envelope';
const REQUEST_DOMAIN = 'forgebridge/v1/request';

/**
 * Nonce 0 is reserved as the "nothing delivered yet" poll cursor, so the first
 * real delivery is nonce 1 and a fresh plugin can honestly poll `?since=0`.
 */
export const NONCE_ORIGIN = 0;

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, no whitespace.
 *
 * The MAC is computed over bytes, but the two ends serialise the same object
 * independently — the relay in JS, the plugin in Luau, where table iteration
 * order is not defined at all. Without a canonical form a payload that both
 * sides agree on would still MAC differently roughly half the time, and the
 * failure would look like an attack rather than a bug.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new ForgeBridgeError('invalid_request', 'a non-finite number cannot be serialised canonically');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(serialise).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // Sorted by UTF-16 code unit, which is the one ordering both a JS
        // engine and a Luau string comparison agree on for ASCII keys.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v)}`).join(',')}}`;
    }
    default:
      throw new ForgeBridgeError('invalid_request', `a value of type ${typeof value} cannot be serialised canonically`);
  }
}

interface MacInput {
  linkId: string;
  nonce: number;
  encrypted: boolean;
  payload: string;
}

/**
 * The MAC covers every field that decides *where* a payload is allowed to land,
 * not just the payload: a set captured on one link must not verify on another,
 * and the nonce must not be editable without invalidating the MAC or replay
 * detection would be trivially bypassable.
 *
 * Fields are newline-framed with the only free-form field last, so no shuffling
 * of content between fields can produce the same signed string.
 */
export function envelopeMac(sessionKey: Buffer, input: MacInput): string {
  const hmac = createHmac('sha256', sessionKey);
  hmac.update(ENVELOPE_DOMAIN, 'utf8');
  hmac.update('\n');
  hmac.update(input.linkId, 'utf8');
  hmac.update('\n');
  hmac.update(String(input.nonce), 'utf8');
  hmac.update('\n');
  hmac.update(input.encrypted ? '1' : '0', 'utf8');
  hmac.update('\n');
  hmac.update(input.payload, 'utf8');
  return hmac.digest('base64');
}

/**
 * A MAC over a request that carries no body — the long-poll. Parts are
 * length-prefixed because they are free-form: without it, ("ab","c") and
 * ("a","bc") would sign identically.
 */
export function requestMac(sessionKey: Buffer, parts: readonly string[]): string {
  const hmac = createHmac('sha256', sessionKey);
  hmac.update(REQUEST_DOMAIN, 'utf8');
  for (const part of parts) {
    hmac.update(`\n${Buffer.byteLength(part, 'utf8')}:`, 'utf8');
    hmac.update(part, 'utf8');
  }
  return hmac.digest('base64');
}

/** Constant-time comparison of two base64 MACs. Never `===`. */
export function macMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'base64');
  const b = Buffer.from(provided, 'base64');
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // (very coarse) oracle and, worse, a crash on malformed input.
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyRequestMac(sessionKey: Buffer, parts: readonly string[], provided: string): boolean {
  return macMatches(requestMac(sessionKey, parts), provided);
}

/** Wrap a payload for delivery to a paired consumer. */
export function sealEnvelope(
  sessionKey: Buffer,
  input: { linkId: string; nonce: number; payload: unknown },
): DeliveryEnvelope {
  const payload = canonicalJson(input.payload);
  return {
    linkId: input.linkId,
    nonce: input.nonce,
    payload,
    // `false`, and it stays false until M19 exists. This is the field ADR-014
    // is about: the relay is at `relay-tls`, which authenticates a payload the
    // operator can still read. Setting this true without shipping
    // ChaCha20-Poly1305 in the plugin would be the exact claim ADR-014 refuses
    // to let anyone make.
    encrypted: false,
    mac: envelopeMac(sessionKey, { linkId: input.linkId, nonce: input.nonce, encrypted: false, payload }),
  };
}

export interface OpenedEnvelope {
  envelope: DeliveryEnvelope;
  payload: unknown;
}

/**
 * Authenticate, then check freshness, then parse — in that order.
 *
 * Checking the nonce before the MAC would let an unauthenticated caller push
 * the accepted-nonce watermark forward and lock the real consumer out.
 *
 * `lastAcceptedNonce` is optional because this function cannot be the authority
 * on replay: it is synchronous and holds no state, so a watermark passed in has
 * already been read and could already be stale. The relay omits it and claims
 * the nonce atomically through `RelayStore.tryAdvanceInboundNonce` instead.
 */
export function openEnvelope(
  sessionKey: Buffer,
  raw: unknown,
  context: { linkId: string; lastAcceptedNonce?: number },
): OpenedEnvelope {
  const parsed = DeliveryEnvelope.safeParse(raw);
  if (!parsed.success) {
    throw new ForgeBridgeError(
      'invalid_request',
      'delivery envelope failed schema validation',
      'Send { linkId, nonce, mac, payload, encrypted }.',
    );
  }
  const envelope = parsed.data;

  if (envelope.linkId !== context.linkId) {
    // Cross-link injection: a valid envelope for someone else's link. On a
    // multi-tenant relay this is not a hypothetical — every link in the process
    // is somebody else's.
    throw new ForgeBridgeError('link_unauthenticated', 'envelope is addressed to a different link');
  }

  if (envelope.encrypted) {
    throw new ForgeBridgeError(
      'invalid_request',
      'this relay speaks relay-tls and cannot open an encrypted payload',
      'Encrypted payloads are the relay-e2e transport (M19), which is not built. Send canonical JSON.',
    );
  }

  const expected = envelopeMac(sessionKey, {
    linkId: envelope.linkId,
    nonce: envelope.nonce,
    encrypted: envelope.encrypted,
    payload: envelope.payload,
  });
  if (!macMatches(expected, envelope.mac)) {
    throw new ForgeBridgeError(
      'link_unauthenticated',
      'envelope MAC did not verify',
      'Re-pair the link; the session key on this end does not match.',
    );
  }

  if (context.lastAcceptedNonce !== undefined) {
    assertFreshNonce(envelope.nonce, context.lastAcceptedNonce);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    throw new ForgeBridgeError('invalid_request', 'envelope payload is not valid JSON');
  }

  return { envelope, payload };
}

/** Monotonic per link. Equal counts as a replay, not as a retry. */
export function assertFreshNonce(nonce: number, lastAccepted: number): void {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new ForgeBridgeError('invalid_request', 'nonce must be a non-negative integer');
  }
  if (nonce <= lastAccepted) {
    throw new ForgeBridgeError(
      'replay_detected',
      `nonce ${nonce} is at or below the last accepted nonce ${lastAccepted}`,
      'Read the link state and send the next nonce.',
    );
  }
}
