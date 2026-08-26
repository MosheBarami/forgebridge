/**
 * Hard bounds on the wire. These are protocol-level, not policy-level: a
 * ChangeSet that exceeds them is malformed, not merely disallowed.
 *
 * They exist because the consumer is a Roblox Studio plugin applying operations
 * synchronously on the main thread. An unbounded ChangeSet is a frozen Studio.
 */
export const LIMITS = {
  /** Maximum operations in one ChangeSet. Larger work must be staged. */
  MAX_OPERATIONS: 500,
  /** Maximum source length for a single script, in bytes. */
  MAX_SCRIPT_BYTES: 1_048_576,
  /** Maximum serialised size of one ChangeSet, in bytes. */
  MAX_CHANGESET_BYTES: 8_388_608,
  /** Maximum depth of an instance path (ancestors + self). */
  MAX_PATH_DEPTH: 32,
  /** Maximum length of a single path segment (Roblox Instance.Name limit). */
  MAX_SEGMENT_LENGTH: 100,
  /** Deleting more than this many instances always requires explicit confirmation. */
  BULK_DELETE_CONFIRM_THRESHOLD: 10,
} as const;
