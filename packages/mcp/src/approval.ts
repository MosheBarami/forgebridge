/**
 * The gate in front of `forge.rollback`.
 *
 * ADR-012 splits propose from apply so that a model cannot clear its own work,
 * and on this connector that split is enforced by reading the daemon's own
 * verdict: `forge.apply_changeset` refuses anything a human has not marked
 * `approved`. A rollback has no such verdict to read. `POST /v1/journal/:id/
 * rollback` is gated on the producer token and nothing else, and this process
 * holds the producer token — it has to, or it could not propose at all. So a
 * rollback tool that forwarded straight through would be a model-callable write
 * into the user's place with no human anywhere in it, which is the one thing
 * ADR-012 exists to prevent. A rollback is a mutation: it reverses an apply the
 * user may well have wanted.
 *
 * The obvious weaker answers both fail the case that matters — *the agent
 * proposes a change, the user approves that change, the agent then rolls back
 * something else*:
 *
 *   - a start-up flag (`--allow-rollback`) is a standing permission, so one
 *     "yes" months ago authorises every rollback since;
 *   - inferring consent from a recent approval is inferring consent for
 *     journal B from a human who said yes to ChangeSet A.
 *
 * So a grant is per journal id, single use, and minted only in-process. This is
 * `packages/a2a/src/approval.ts`'s design, narrowed to the one skill this
 * connector has: `record` is a method on a JavaScript object and there is no
 * tool, no argument and no JSON-RPC method that reaches it, so nothing a model
 * can send records an approval.
 *
 * TODO(M28): this and A2A's gate are now two hand-copies of one idea, and they
 * will drift. They belong in one shared package once M28's approval path exists
 * to be shared — the CLI is the process that will record grants for both. Owner:
 * the CLI author. Hoisting it today would mean adding a workspace dependency
 * between two connectors that have no other reason to know about each other.
 */

/**
 * Proof that a human cleared the reversal of one specific apply.
 *
 * `journalId` is the whole scope of it. A grant is not a session and not a mode:
 * holding one for journal A confers nothing over journal B, which is exactly the
 * case a standing permission gets wrong.
 */
export interface RollbackGrant {
  readonly journalId: string;
  /**
   * Who cleared it. Required rather than defaulted, because it is the one fact
   * a later audit of "who reversed this?" actually wants, and a record reading
   * "approved by local" when a named human clicked the button has lost it.
   */
  readonly approvedBy: string;
  /** The human's own words, where the recorder has them. */
  readonly note?: string;
}

/**
 * The port an approval reaches this connector through.
 *
 * `consume` takes the journal id and *nothing else*. That signature is the
 * boundary: there is no parameter here through which a tool call could describe,
 * hint at, or assert its own authorisation. An implementation that added one
 * would be reopening the hole this file exists to close.
 */
export interface RollbackGate {
  consume(journalId: string): Promise<RollbackGrant | null>;
}

/**
 * The default: nothing is ever cleared.
 *
 * Chosen for the same reason the daemon defaults to `DENY_ALL_POLICY` and A2A
 * to `DENY_ALL_APPROVALS` — a connector someone has not finished wiring up can
 * propose and read and cannot reverse anything, which is a safe thing to have
 * left half-configured. The opposite default would silently switch ADR-012 off
 * for everyone who ran the server before finishing the setup, and they would
 * have no way to tell.
 *
 * `forgebridge-mcp` run from the command line has no approval path to offer, so
 * this is what it uses and `forge.rollback` refuses every call — the same honest
 * shape `forge.read_tree` and `forge.run_tests` already take, and the tool's
 * description says so, because that text is what the model reads before it
 * decides to try. The way a human reverses an apply today is
 * `forgebridge rollback <journal-id> --expected-version <n>`, which is the human
 * doing it themselves rather than authorising an agent to.
 */
export const DENY_ALL_ROLLBACKS: RollbackGate = {
  async consume() {
    return null;
  },
};

/**
 * An in-memory gate a local process records approvals into.
 *
 * The asymmetry is the design: `record` is reachable only by code running inside
 * this process — an embedder that has its own confirmation UI, or the CLI once
 * M28 gives it one. `consume` is all the tool-call path can reach.
 *
 * Grants are single use. One human "yes" is one rollback; a standing grant would
 * let an agent that got cleared once reverse the same journal entry again after
 * the user had re-applied it.
 *
 * TODO(M28): held in memory, so a restart discards pending grants and a second
 * connector process cannot see grants recorded in the first. Owner: the CLI
 * author, alongside A2A's identical note. Until then an operator running more
 * than one connector must know approvals do not travel between them.
 */
export class LocalOperatorRollbackGate implements RollbackGate {
  readonly #pending = new Map<string, RollbackGrant>();

  /** Record an approval. Callable only in-process, by design — see above. */
  record(grant: RollbackGrant): void {
    this.#pending.set(grant.journalId, grant);
  }

  /** Withdraw an approval that has not been used yet. */
  revoke(journalId: string): boolean {
    return this.#pending.delete(journalId);
  }

  /** What is cleared and unused, for a local UI to display. */
  get pending(): readonly RollbackGrant[] {
    return [...this.#pending.values()];
  }

  async consume(journalId: string): Promise<RollbackGrant | null> {
    const grant = this.#pending.get(journalId);
    if (!grant) return null;
    this.#pending.delete(journalId);
    return grant;
  }
}
