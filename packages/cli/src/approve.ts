import { LIMITS } from '@forgebridge/protocol';

/**
 * How a human approves, written out for them to paste.
 *
 * ── Why a connector prints the approve call at all ───────────────────────────
 *
 * Because "not approved" on its own strands the person reading it. There are
 * two real ways to approve — the Studio plugin's diff view, which is the
 * designed human gate, and `POST /v1/changesets/:id/approve`, which is what a
 * CI job or an operator without Studio open actually needs — and naming the
 * second is not a loophole. Calling it is a deliberate act by whoever holds the
 * producer token, which is the human who started the daemon. Doing it silently
 * from inside `apply` or `run` would be the loophole, and no command here does.
 *
 * ── Why the digest is in the body ────────────────────────────────────────────
 *
 * The daemon refuses an approve that does not echo the `contentDigest` of the
 * operations it is holding, which is what turns "I approve set X" into "I
 * approve the operations I was shown for set X" (ADR-012). The digest passed in
 * here is always the one the caller *just read* — off a diff, or off the run
 * response — so pasting this is approving what was on screen rather than an id
 * that content might later be swapped under.
 *
 * It lives in its own module because two commands print it. A second copy of
 * the request shape would be a second thing to update the day the body gains a
 * field, and the copy that got missed would be the one a user pasted.
 */
export interface ApproveHint {
  baseUrl: string;
  changeSetId: string;
  /** Null when the transport rendered none; the hint then says so rather than lying. */
  contentDigest: string | null;
  /** How many instances the set deletes, when the caller knows. */
  deletes?: number;
}

/** True when the protocol requires the approver to say the destructive part out loud. */
export function needsBulkDeleteConfirmation(deletes: number | undefined): boolean {
  return deletes !== undefined && deletes > LIMITS.BULK_DELETE_CONFIRM_THRESHOLD;
}

/** The JSON body `POST /v1/changesets/:id/approve` accepts, as a string. */
export function approveBody(hint: ApproveHint): string {
  return JSON.stringify({
    contentDigest: hint.contentDigest,
    approvedBy: 'your-name',
    ...(needsBulkDeleteConfirmation(hint.deletes) ? { confirmBulkDelete: true } : {}),
  });
}

/** The three lines of a curl that would approve this exact content. */
export function approveCurl(hint: ApproveHint): string {
  return [
    `  curl -fsS -X POST ${hint.baseUrl}/v1/changesets/${hint.changeSetId}/approve \\`,
    `    -H "X-ForgeBridge-Token: $FORGEBRIDGE_PRODUCER_TOKEN" \\`,
    `    -H 'content-type: application/json' -d '${approveBody(hint)}'`,
  ].join('\n');
}
