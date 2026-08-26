import type { SkillId } from './skills.js';

/**
 * The approval boundary. This is the most important file in the package.
 *
 * ADR-012 makes propose and apply separate operations so that a model cannot
 * clear its own work. The daemon enforces that split at its endpoints, but it
 * enforces it against a *caller*, and it decides who that caller is with a
 * single process-wide producer token: whoever holds the token may submit a
 * ChangeSet, and whoever holds the token may approve one.
 *
 * This connector holds that token. It has to — it cannot propose without it.
 * Which means that if this package forwarded an A2A "apply" straight through to
 * `POST /v1/changesets/:id/approve`, every remote agent that could reach this
 * port would be holding the producer token by proxy, and the separation ADR-012
 * describes would exist in the daemon and be gone at the edge. The two calls
 * would still be two calls, made by the same principal, one after the other, on
 * that principal's own say-so. That is self-approval with extra steps.
 *
 * So the rule here is structural rather than procedural: **no code path exists
 * from an inbound A2A request to an approve or a rollback.** Those two daemon
 * endpoints are reachable only when holding an `ApprovalGrant`, grants are
 * minted only by an `ApprovalGate`, and no gate implementation takes any input
 * from the A2A request beyond the identifier of the thing being approved. The
 * request cannot name its approver, cannot confirm a bulk delete, and cannot
 * carry a grant of its own — `ApplyApprovedChangesetInput` is `.strict()`, so a
 * caller that tries to add such a field is refused outright rather than having
 * the field quietly dropped.
 *
 * A remote agent is less trusted than a local editor, not more. It may propose,
 * and it may read. Writing needs a human.
 */

/**
 * Proof that a human — or a local policy acting for one — cleared a specific
 * piece of work.
 *
 * `subject` is the ChangeSet id or the journal id, and a grant is good for that
 * one identifier: a grant is not a session, and holding one for ChangeSet A
 * confers nothing over ChangeSet B.
 */
export interface ApprovalGrant {
  readonly skill: Extract<SkillId, 'apply-approved-changeset' | 'rollback-apply'>;
  readonly subject: string;
  /**
   * Who cleared it. Recorded in the daemon's journal, so it must describe a
   * real approver. It is set by whoever records the approval and is never read
   * from the A2A request.
   */
  readonly approvedBy: string;
  /**
   * Set only by an approver who was shown the deletion count and said yes to it
   * (`LIMITS.BULK_DELETE_CONFIRM_THRESHOLD`). A remote caller has no way to
   * reach this field, which is the point: ADR-012 requires the approver to "say
   * the destructive part out loud", and a flag the requester can set is not the
   * approver saying anything.
   */
  readonly confirmBulkDelete?: boolean;
  readonly note?: string;
}

/**
 * The port through which an approval reaches this connector.
 *
 * `consume` takes the subject identifier and *nothing else*. That signature is
 * the boundary: there is no parameter here through which a request could
 * describe, hint at, or assert its own authorisation. An implementation that
 * added one would be re-opening the hole this file exists to close.
 */
export interface ApprovalGate {
  consume(
    skill: Extract<SkillId, 'apply-approved-changeset' | 'rollback-apply'>,
    subject: string,
  ): Promise<ApprovalGrant | null>;
}

/**
 * The default gate: nothing is ever approved.
 *
 * Chosen as the default for the same reason the daemon defaults to
 * `DENY_ALL_POLICY` — an operator who has not yet wired up an approval path has
 * an A2A endpoint that can propose and read and cannot write, which is a safe
 * thing to have left half-configured. The alternative default, "approve
 * everything", would be a connector that silently disables ADR-012 for anyone
 * who ran it before finishing the setup.
 */
export const DENY_ALL_APPROVALS: ApprovalGate = {
  async consume() {
    return null;
  },
};

/**
 * An in-memory gate a local process records approvals into.
 *
 * The asymmetry is deliberate and is the whole design: `record` is a method on
 * a JavaScript object, reachable only by code running inside this process —
 * the CLI (M28), a local approval UI, the Studio plugin's own confirmation
 * path. `consume` is what the A2A request path can reach. There is no JSON-RPC
 * method, no HTTP route and no message shape that reaches `record`, so a remote
 * agent cannot record an approval no matter what it sends.
 *
 * Grants are single-use. One human "yes" is one apply; a remote agent that
 * repeats a request it already got a grant for is back to
 * `TASK_STATE_AUTH_REQUIRED`, because otherwise a single approval would be a
 * standing permission to rewrite the same ChangeSet id forever.
 *
 * TODO(M28): this holds approvals in memory, so a connector restart discards
 * pending ones and a second connector process cannot see approvals recorded in
 * the first. A durable, cross-process gate belongs with the CLI that will
 * record the approvals — most likely reading the same store the daemon uses.
 * Owner: the CLI author. Until then an operator running more than one connector
 * process must know that approvals do not travel between them.
 */
export class LocalOperatorApprovalGate implements ApprovalGate {
  readonly #pending = new Map<string, ApprovalGrant>();

  /**
   * Record an approval. Callable only in-process, by design — see above.
   *
   * `approvedBy` is required rather than defaulted: a journal entry reading
   * "approved by local" when a named human clicked the button loses the one
   * fact a later audit wants.
   */
  record(grant: ApprovalGrant): void {
    this.#pending.set(keyOf(grant.skill, grant.subject), grant);
  }

  /** Withdraw an approval that has not been used yet. */
  revoke(skill: ApprovalGrant['skill'], subject: string): boolean {
    return this.#pending.delete(keyOf(skill, subject));
  }

  /** What is currently approved and unused. For a local UI to display. */
  get pending(): readonly ApprovalGrant[] {
    return [...this.#pending.values()];
  }

  async consume(skill: ApprovalGrant['skill'], subject: string): Promise<ApprovalGrant | null> {
    const key = keyOf(skill, subject);
    const grant = this.#pending.get(key);
    if (!grant) return null;
    this.#pending.delete(key);
    return grant;
  }
}

/**
 * The skill is part of the key, not just the subject.
 *
 * A ChangeSet id and a journal id are different namespaces today, but keying on
 * the subject alone would mean that the day they collide — or the day a third
 * writing skill is added — an approval for one operation would satisfy another.
 * Cheap to prevent now, invisible to get wrong later.
 */
function keyOf(skill: string, subject: string): string {
  return `${skill} ${subject}`;
}
