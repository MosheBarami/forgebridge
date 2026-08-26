import { z } from 'zod';

/**
 * Which transport a link uses, and — critically — what that implies about who
 * can read the ChangeSets flowing over it. The UI renders this verbatim; a
 * padlock icon alone would be a lie in the `relay-tls` case.
 */
export const TransportKind = z.enum(['local-daemon', 'relay-tls', 'relay-e2e']);
export type TransportKind = z.infer<typeof TransportKind>;

export const PRIVACY_POSTURE: Record<TransportKind, string> = {
  'local-daemon': 'Local — nothing leaves this machine',
  'relay-tls': 'Relay — the relay operator can read your changes',
  'relay-e2e': 'Relay — end-to-end encrypted, the relay sees only ciphertext',
};

/**
 * 8 characters from an unambiguous alphabet: no I or L (confusable with 1), no
 * O (confusable with 0), no U (which turns short codes into words people will
 * not read aloud on a stream), and no 0 or 1.
 *
 * That leaves 30 symbols, so 8 characters carry log2(30^8) ≈ 39.2 bits. Brute
 * force is bounded by the 5-attempt limit and the 10-minute TTL, not by the
 * entropy alone — the entropy is there so a code cannot be *guessed*, and the
 * limits are there so it cannot be *searched*.
 */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * Derived from the alphabet rather than written out, because the two drifted:
 * a hand-written `[A-HJ-NP-TV-Z2-9]` silently readmitted `L`, so a code the
 * generator can never mint would have validated. A validator that accepts more
 * than the generator produces is a validator that is not checking anything.
 */
const PAIRING_PATTERN = new RegExp(`^[${PAIRING_ALPHABET}]{${8}}$`);
export const PairingCode = z.string().length(8).regex(PAIRING_PATTERN);

export const PAIRING = {
  TTL_SECONDS: 600,
  MAX_ATTEMPTS: 5,
  CODE_LENGTH: 8,
} as const;

export const LinkState = z.enum(['unpaired', 'pairing', 'paired', 'expired', 'revoked']);

export const Link = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  transport: TransportKind,
  state: LinkState,
  /** Identifier of the pairing-derived session key. Never the key itself. */
  sessionKeyId: z.string().max(64).nullable().default(null),
  pluginVersion: z.string().max(40).nullable().default(null),
  studioVersion: z.string().max(40).nullable().default(null),
  placeId: z.number().int().nullable().default(null),
  lastSeenAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type Link = z.infer<typeof Link>;

/**
 * Monotonic per-link counter. A ChangeSet delivery carrying a nonce at or below
 * the last one the plugin accepted is a replay and is dropped. Combined with
 * the baseVersion check this makes a captured delivery useless twice over.
 */
export const DeliveryEnvelope = z.object({
  linkId: z.string().uuid(),
  nonce: z.number().int().min(0),
  /** Base64 MAC over the canonical payload under the session key. */
  mac: z.string().max(200),
  /** JSON for `relay-tls` and `local-daemon`; base64 ciphertext for `relay-e2e`. */
  payload: z.string(),
  encrypted: z.boolean().default(false),
});
export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelope>;
