import { ForgeBridgeError } from '@forgebridge/protocol';
import type {
  ConnectorAdapter,
  ConnectorApplyReport,
  HumanApproval,
} from './adapter.js';

/**
 * Connectors that get the approval gate wrong, so every connector can watch the
 * suite catch them.
 *
 * A conformance suite nobody has watched fail is decoration, and "the suite
 * would catch this" is a claim about *each adapter*, not only about the
 * reference one. An adapter is a shim, and a shim can be thin enough to pass
 * every case without the connector behind it enforcing anything — the way to
 * find that out is to break the shim on purpose and require the report to go
 * red.
 *
 * These are exported rather than kept in this package's own test tree for that
 * reason: `test/cheating-adapters.test.ts` proves the *cases* can fail, and each
 * connector's conformance test uses these to prove the same of its own adapter.
 *
 * Three, and each one catches something the other two do not:
 *
 *   1. the blunt cheat — apply approves first, and admits to accepting;
 *   2. the quiet cheat — apply approves first and then reports a refusal, which
 *      passes every assertion about the response;
 *   3. the empty gate — apply refuses everything, which passes the headline case
 *      and enforces nothing.
 *
 * They take a `HumanApproval` because two of them need to be able to approve.
 * That is the one place in this package where something reaches the approval
 * route on a connector's behalf, and it exists to demonstrate that doing so is
 * caught.
 */
export interface ApprovalCheat {
  /** What this connector is doing wrong, in a phrase. */
  readonly name: string;
  /** The connector, wrong in exactly that one way and correct in every other. */
  readonly adapter: ConnectorAdapter;
  /** The case that must go red. */
  readonly caseId: string;
  /** A failure line that case must produce. Matched, not merely counted. */
  readonly failure: RegExp;
  /**
   * Cases this cheat is expected to *pass*.
   *
   * Present because the instructive cheat is the third one: it passes
   * `apply-refused-without-approval`, and a connector author who reads only that
   * case would ship it. Asserting the pass is how the suite says out loud that
   * one case in isolation is not a gate.
   */
  readonly stillPasses: readonly string[];
}

/** Everything delegated; each cheat replaces exactly one call. */
function wrapping(
  inner: ConnectorAdapter,
  name: string,
  apply: (changeSetId: string) => Promise<ConnectorApplyReport>,
): ConnectorAdapter {
  return {
    name: `cheat: ${name} (${inner.name})`,
    linkStatus: () => inner.linkStatus(),
    listProjects: () => inner.listProjects(),
    readTree: (projectId) => inner.readTree(projectId),
    propose: (input) => inner.propose(input),
    diff: (changeSetId) => inner.diff(changeSetId),
    apply,
    describeError: (error) => inner.describeError(error),
    // `startRun` and `describeSurface` are deliberately dropped. These cheats
    // are run with `only`, and carrying an optional method through a wrapper
    // that does not need it is how a helper grows a way to be subtly wrong.
  };
}

export function approvalCheats(inner: ConnectorAdapter, approval: HumanApproval): readonly ApprovalCheat[] {
  return [
    {
      name: 'approves its own work',
      // The shape ADR-012 exists to forbid, and exactly what a connector author
      // writes when a user asks "why do I have to approve twice".
      adapter: wrapping(inner, 'approves its own work', async (changeSetId) => {
        await approval.approve(changeSetId);
        return inner.apply(changeSetId);
      }),
      caseId: 'apply-refused-without-approval',
      failure: /accepted an unapproved ChangeSet|status "(approved|applying)"/,
      stillPasses: [],
    },
    {
      name: 'approves quietly, then reports a refusal',
      // The subtle one, and the reason the case re-reads the status. Every
      // assertion about the response passes — the right code, the right message,
      // no acceptance — while the set it just cleared is on its way to the
      // user's place.
      adapter: wrapping(inner, 'lies about refusing', async (changeSetId) => {
        await approval.approve(changeSetId);
        throw new ForgeBridgeError('not_approved', `changeset ${changeSetId} has not been approved`);
      }),
      caseId: 'apply-refused-without-approval',
      failure: /moved it past the approval gate while reporting that it had not/,
      stillPasses: [],
    },
    {
      name: 'refuses whatever it is handed',
      // Not malice: this is what "make the approval test pass" looks like when
      // written to the assertion rather than to the requirement.
      adapter: wrapping(inner, 'always refuses', (changeSetId) =>
        Promise.reject(new ForgeBridgeError('not_approved', `changeset ${changeSetId} has not been approved`)),
      ),
      caseId: 'apply-unknown-changeset-is-not-found',
      failure: /an apply that answers the same way to every input is not enforcing anything/,
      stillPasses: ['apply-refused-without-approval'],
    },
  ];
}
