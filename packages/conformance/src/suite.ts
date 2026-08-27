import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  ForgeBridgeError,
  PRIVACY_POSTURE,
  PROTOCOL_MAJOR,
  type ChangeSetStatus,
  type Validation,
} from '@forgebridge/protocol';
import type {
  ConformanceOptions,
  ConnectorAdapter,
  ConnectorDiff,
  ConnectorErrorView,
} from './adapter.js';
import { FORGED_COMPUTED_BY, defaultFixture, forgedValidation } from './fixtures.js';
import {
  summarise,
  type CaseResult,
  type ConformanceCase,
  type ConformanceReport,
} from './report.js';
import {
  ConnectorApplyReportShape,
  ConnectorDiffShape,
  ConnectorLinkStatusShape,
  ConnectorProjectShape,
  ConnectorProposalShape,
  ConnectorRunShape,
  ConnectorSurfaceShape,
  ConnectorTreeShape,
  issueLines,
} from './shapes.js';

/**
 * The statuses that mean "no human has cleared this yet".
 *
 * Read as the complement of the five that mean a set reached, or is reaching,
 * someone's place: `approved`, `applying`, `applied` and `partial` — and
 * `failed`, which belongs with them because a set that failed to apply was
 * still dispatched, so finding one after a refused apply means the refusal was
 * theatre.
 */
const UNAPPROVED_STATUSES: readonly ChangeSetStatus[] = ['draft', 'proposed', 'validated', 'rejected', 'stale'];

/** What `apply()` may report once a human has actually approved. */
const CLEARED_STATUSES: readonly ChangeSetStatus[] = ['approved', 'applying', 'applied', 'partial', 'failed'];

/**
 * Identifiers a connector advertises. Permissive on purpose — see the note the
 * surface case attaches about the stricter function-name grammar some clients
 * impose, which is a real constraint that nobody has yet verified any shipping
 * client actually enforces (`packages/mcp/src/config.ts`, TODO(M31)).
 */
const PORTABLE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Returned by `t.unsupported` for a case to throw: `throw t.unsupported(reason)`.
 * Returning rather than throwing keeps the call an expression TypeScript can see
 * ends the branch, which is what lets a case narrow an optional adapter method
 * on the line after the guard.
 */
class Unsupported extends Error {}

interface SuiteState {
  projectId?: string;
  baseVersion?: number;
  proposal?: { changeSetId: string; diff: ConnectorDiff; validation?: Validation | null };
  approved?: string;
}

interface CaseContext {
  readonly adapter: ConnectorAdapter;
  readonly options: ConformanceOptions;
  readonly state: SuiteState;
  now(): Date;
  newId(): string;
  /** Records a failure when the condition is false. Returns the condition. */
  check(condition: boolean, message: string): boolean;
  fail(message: string): void;
  note(message: string): void;
  /** Marks the case as skipped rather than failed. Always used as `throw t.unsupported(…)`. */
  unsupported(reason: string): Unsupported;
  /** `describeError`, guarded: an adapter whose classifier throws is a failure, not a crash. */
  classify(error: unknown, label: string): ConnectorErrorView | null;
}

interface Case extends ConformanceCase {
  run(t: CaseContext): Promise<void>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

/**
 * Run a call that must not succeed.
 *
 * Returns the rejection, or null when the call resolved — and a call that
 * resolved is reported by the caller, because what a resolved value *means*
 * differs per case: `apply()` may legitimately answer with a refusal report
 * rather than by throwing, while `propose()` against a stale base may not.
 */
async function rejection<T>(thunk: () => Promise<T>): Promise<{ error: unknown } | { value: T }> {
  try {
    return { value: await thunk() };
  } catch (error) {
    return { error };
  }
}

function isRejection<T>(outcome: { error: unknown } | { value: T }): outcome is { error: unknown } {
  return 'error' in outcome;
}

/**
 * The project the suite runs against.
 *
 * Resolved lazily so that any case can be run on its own through
 * `ConformanceOptions.only` — a case that depended on an earlier case having
 * populated the state would be a suite that only works when run whole, and the
 * first thing a connector author does with a failing case is run it alone.
 */
async function ensureProject(t: CaseContext): Promise<string> {
  if (t.options.projectId) return t.options.projectId;
  if (t.state.projectId) return t.state.projectId;

  const projects = await t.adapter.listProjects();
  const chosen = projects.find((project) => project.isDefault) ?? projects[0];
  if (!chosen) {
    const status = await t.adapter.linkStatus();
    if (status.defaultProjectId) {
      t.state.projectId = status.defaultProjectId;
      return status.defaultProjectId;
    }
    throw new Error('this connector named no project to run against — pass ConformanceOptions.projectId');
  }
  t.state.projectId = chosen.projectId;
  if (chosen.currentVersion !== undefined) t.state.baseVersion = chosen.currentVersion;
  return chosen.projectId;
}

function baseVersionFor(t: CaseContext): number {
  return t.options.baseVersion ?? t.state.baseVersion ?? 0;
}

/**
 * Propose the suite's fixture, carrying a forged verdict.
 *
 * The forgery rides on every proposal rather than on a dedicated one because it
 * costs nothing and it means the invariant-4 case is checking the same call
 * path every other case uses, not a special one a connector could treat
 * differently.
 */
async function proposeFixture(t: CaseContext): Promise<{ changeSetId: string; diff: ConnectorDiff; validation?: Validation | null }> {
  const projectId = await ensureProject(t);
  const fixture = t.options.fixture ?? defaultFixture();
  const proposal = await t.adapter.propose({
    projectId,
    baseVersion: baseVersionFor(t),
    summary: fixture.summary,
    operations: fixture.operations,
    claimedValidation: forgedValidation(t.now()),
  });

  const parsed = ConnectorProposalShape.safeParse(proposal);
  if (!parsed.success) {
    throw new Error(`propose() returned a shape the protocol does not describe:\n  ${issueLines(parsed.error, 'proposal').join('\n  ')}`);
  }

  const diff = proposal.diff ?? (await t.adapter.diff(proposal.changeSetId));
  const parsedDiff = ConnectorDiffShape.safeParse(diff);
  if (!parsedDiff.success) {
    throw new Error(`the diff for ${proposal.changeSetId} is not protocol-shaped:\n  ${issueLines(parsedDiff.error, 'diff').join('\n  ')}`);
  }

  return { changeSetId: proposal.changeSetId, diff: diff as ConnectorDiff, validation: proposal.validation };
}

async function ensureProposal(t: CaseContext): Promise<{ changeSetId: string; diff: ConnectorDiff; validation?: Validation | null }> {
  if (t.state.proposal) return t.state.proposal;
  const proposal = await proposeFixture(t);
  t.state.proposal = proposal;
  return proposal;
}

// ── the cases ─────────────────────────────────────────────────────────────────

const linkPosture: Case = {
  id: 'link-posture',
  title: 'Link status carries the protocol’s own privacy posture',
  requirement:
    'linkStatus() reports a TransportKind and the exact PRIVACY_POSTURE string the protocol assigns it, plus a compatible protocol version.',
  source: 'packages/protocol/src/link.ts (PRIVACY_POSTURE), ADR-006',
  async run(t) {
    const status = await t.adapter.linkStatus();
    const parsed = ConnectorLinkStatusShape.safeParse(status);
    if (!parsed.success) {
      for (const line of issueLines(parsed.error, 'linkStatus')) t.fail(line);
      return;
    }

    const expected = PRIVACY_POSTURE[parsed.data.transport];
    t.check(
      parsed.data.privacyPosture === expected,
      `privacyPosture must be the protocol's own words for "${parsed.data.transport}" — expected ${JSON.stringify(expected)}, got ${JSON.stringify(parsed.data.privacyPosture)}. A connector that paraphrases this has editorialised the one sentence telling the user who can read their code.`,
    );

    t.check(
      majorOf(parsed.data.protocolVersion) === PROTOCOL_MAJOR,
      `protocolVersion "${parsed.data.protocolVersion}" is not major ${PROTOCOL_MAJOR}; a connector on a different major cannot safely speak to this one`,
    );

    if (parsed.data.defaultProjectId) t.state.projectId ??= parsed.data.defaultProjectId;
    t.note(`transport ${parsed.data.transport}: ${parsed.data.privacyPosture}`);
    t.note(`${parsed.data.links.length} link(s) reported`);
  },
};

const projectsListed: Case = {
  id: 'projects-listed',
  title: 'Projects are listable',
  requirement: 'listProjects() returns at least one project with a uuid id, and names at most one default.',
  source: 'docs/ARCHITECTURE.md §5 (forge.list_projects)',
  async run(t) {
    const projects = await t.adapter.listProjects();
    if (!t.check(projects.length > 0, 'listProjects() returned nothing; every other case needs a project id')) return;

    projects.forEach((project, index) => {
      const parsed = ConnectorProjectShape.safeParse(project);
      if (!parsed.success) for (const line of issueLines(parsed.error, `projects[${index}]`)) t.fail(line);
    });

    const defaults = projects.filter((project) => project.isDefault);
    t.check(defaults.length <= 1, `${defaults.length} projects claim to be the default; a caller that omits a project id cannot resolve one`);

    const chosen = defaults[0] ?? projects[0];
    if (chosen) {
      t.state.projectId ??= chosen.projectId;
      if (chosen.currentVersion !== undefined) t.state.baseVersion ??= chosen.currentVersion;
      t.note(`running against project ${t.state.projectId ?? chosen.projectId}`);
    }
    if (projects.every((project) => project.currentVersion === undefined)) {
      t.note(
        'no project reports a currentVersion — this transport publishes no per-project tree version, so baseVersion comes from ConformanceOptions or defaults to 0 (TODO(M31): an additive /v1 read closes this)',
      );
    }
  },
};

const treeRead: Case = {
  id: 'tree-read',
  title: 'The instance tree is readable, or the refusal is a protocol error',
  requirement:
    'readTree() returns a snapshot whose children are addressed beneath their parents, or refuses with a protocol ErrorCode carrying a remedy.',
  source: 'docs/ARCHITECTURE.md §5 (forge.read_tree), packages/protocol/src/errors.ts',
  async run(t) {
    const projectId = await ensureProject(t);
    const outcome = await rejection(() => t.adapter.readTree(projectId));

    if (isRejection(outcome)) {
      const view = t.classify(outcome.error, 'readTree');
      if (!view) return;
      if (!t.check(view.recognised, `readTree() failed with something this connector could not classify (reported as "${view.code}")`)) return;
      if (!t.check(Boolean(view.remedy && view.remedy.length > 0), `readTree() refused with "${view.code}" and no remedy; the protocol requires a refusal to say what to do next`)) return;
      throw t.unsupported(`this transport serves no tree snapshot: ${view.code} — ${view.remedy ?? view.message ?? ''}`);
    }

    const parsed = ConnectorTreeShape.safeParse(outcome.value);
    if (!parsed.success) {
      for (const line of issueLines(parsed.error, 'tree')) t.fail(line);
      return;
    }

    t.check(parsed.data.projectId === projectId, `readTree(${projectId}) returned a tree for project ${parsed.data.projectId}`);

    // A tree whose children are not addressed beneath their parents cannot be
    // used to build a path, which is the only reason a producer reads one.
    const walk = (node: { path: string; children?: unknown[] }, depth: number): void => {
      for (const raw of node.children ?? []) {
        const child = raw as { path: string; children?: unknown[] };
        t.check(
          child.path.startsWith(`${node.path}.`),
          `tree node "${child.path}" is not addressed beneath its parent "${node.path}"`,
        );
        if (depth < 8) walk(child, depth + 1);
      }
    };
    walk(parsed.data.root as { path: string; children?: unknown[] }, 0);

    t.state.baseVersion = parsed.data.version;
    t.note(`tree at version ${parsed.data.version}, rooted at ${parsed.data.root.path}`);
  },
};

const proposeReturnsIdAndDiff: Case = {
  id: 'propose-returns-id-and-diff',
  title: 'A proposal comes back with an id and a rendered diff',
  requirement:
    'propose() returns a uuid ChangeSet id and a diff that names the same id, the same baseVersion and one entry per operation — and the set is not approved by the act of proposing it.',
  source: 'ADR-012 (propose ≠ apply), packages/daemon/src/wire.ts (ChangeSetDiff)',
  async run(t) {
    const fixture = t.options.fixture ?? defaultFixture();
    const proposal = await proposeFixture(t);
    t.state.proposal = proposal;

    const { changeSetId, diff } = proposal;
    t.check(diff.changeSetId === changeSetId, `the diff names ${diff.changeSetId}, but propose() returned ${changeSetId}`);
    t.check(
      diff.operations.length === fixture.operations.length,
      `the diff renders ${diff.operations.length} operations for a ChangeSet of ${fixture.operations.length}`,
    );
    t.check(
      diff.baseVersion === baseVersionFor(t),
      `the diff reports baseVersion ${diff.baseVersion} for a set proposed against ${baseVersionFor(t)}`,
    );
    if (diff.counts) {
      t.check(
        diff.counts.total === fixture.operations.length,
        `counts.total is ${diff.counts.total} for ${fixture.operations.length} operations`,
      );
    }

    // The load-bearing half of this case: proposing must not approve.
    t.check(
      UNAPPROVED_STATUSES.includes(diff.status as ChangeSetStatus),
      `a freshly proposed ChangeSet is in status "${diff.status}"; proposing is not approving (ADR-012)`,
    );

    // Read back through `diff()` rather than trusting the copy `propose()`
    // bundled. They are two code paths in most connectors, and the one every
    // later call uses — including the approval gate's status re-read — is this
    // one. A bundled diff that is protocol-shaped tells us nothing about it.
    const reread = await t.adapter.diff(changeSetId);
    const parsed = ConnectorDiffShape.safeParse(reread);
    if (parsed.success) {
      t.check(parsed.data.changeSetId === changeSetId, `diff(${changeSetId}) returned a diff for ${parsed.data.changeSetId}`);
      t.check(
        parsed.data.status === diff.status,
        `propose() reported status "${diff.status}" and diff() reports "${parsed.data.status}" for the same untouched ChangeSet`,
      );
    } else {
      for (const line of issueLines(parsed.error, 'diff')) t.fail(line);
    }

    t.note(`proposed ${changeSetId} in status "${diff.status}"`);
  },
};

const verdictRecomputed: Case = {
  id: 'verdict-recomputed',
  title: 'The validation verdict is the core’s, not the producer’s',
  requirement:
    'The Validation returned for a proposal is one the core computed; a verdict supplied by the producer is discarded.',
  source: 'PROTOCOL invariant 4, packages/protocol/src/changeset.ts (Validation)',
  async run(t) {
    const proposal = await ensureProposal(t);
    const validation = proposal.validation ?? proposal.diff.validation;

    if (!t.check(Boolean(validation), 'no validation reached the caller; a producer cannot tell a validated set from an unvalidated one')) return;
    const verdict = validation as Validation;

    t.check(
      verdict.computedBy !== FORGED_COMPUTED_BY,
      `the verdict came back stamped ${JSON.stringify(FORGED_COMPUTED_BY)} — the producer's own claim was echoed back as the system's judgement`,
    );
    t.check(verdict.computedBy.length > 0, 'validation.computedBy is empty; a verdict nobody signed is a verdict nobody stands behind');
    t.check(
      !Number.isNaN(Date.parse(verdict.computedAt)),
      `validation.computedAt "${verdict.computedAt}" is not a timestamp`,
    );
    t.note(`verdict computed by ${verdict.computedBy}: luau ${verdict.luau.status}, policy ${verdict.policy.status}`);
  },
};

const staleBaseRefused: Case = {
  id: 'stale-base-refused',
  title: 'A stale baseVersion is refused, never merged',
  requirement: 'propose() against a baseVersion that is not current fails with stale_base (or comes back marked stale).',
  source: 'PROTOCOL invariant 1, packages/protocol/src/changeset.ts (baseVersion)',
  async run(t) {
    const projectId = await ensureProject(t);
    const fixture = t.options.fixture ?? defaultFixture();
    // Far enough ahead that it cannot be the real version on any project this
    // suite could plausibly be pointed at.
    const impossible = baseVersionFor(t) + 1_000;

    const outcome = await rejection(() =>
      t.adapter.propose({
        projectId,
        baseVersion: impossible,
        summary: `${fixture.summary} (stale)`,
        operations: fixture.operations,
      }),
    );

    if (isRejection(outcome)) {
      const view = t.classify(outcome.error, 'propose');
      if (!view) return;
      t.check(
        view.code === 'stale_base',
        `a set built against version ${impossible} was refused as "${view.code}"; the protocol has stale_base for exactly this and a caller branches on it to rebase`,
      );
      return;
    }

    // A connector may accept the submission and report the set as stale rather
    // than throwing. That is still a refusal — what it may not do is treat the
    // set as proposable against a version that is not current.
    const status = (outcome.value as { status?: string }).status;
    t.check(
      status === 'stale',
      `propose() accepted a ChangeSet built against version ${impossible} and reported status "${status ?? 'unknown'}"; there is no last-write-wins path in this protocol`,
    );
  },
};

const applyRefusedWithoutApproval: Case = {
  id: 'apply-refused-without-approval',
  title: 'Apply is refused without approval — and the set stays unapproved',
  requirement:
    'apply() on an unapproved ChangeSet fails with not_approved, and the ChangeSet is still unapproved afterwards.',
  source: 'ADR-012 (approval-gated apply)',
  async run(t) {
    const proposal = await ensureProposal(t);
    const { changeSetId } = proposal;

    const outcome = await rejection(() => t.adapter.apply(changeSetId));

    if (isRejection(outcome)) {
      const view = t.classify(outcome.error, 'apply');
      if (view) {
        t.check(
          view.code === 'not_approved',
          `apply() on an unapproved set failed with "${view.code}"; the caller has to be able to tell "nobody has approved this yet" from every other failure`,
        );
      }
    } else {
      // Refusing by answering rather than by throwing is legitimate — several
      // transports have no exception to raise. Claiming acceptance is not.
      const report = outcome.value;
      const parsed = ConnectorApplyReportShape.safeParse(report);
      if (!parsed.success) {
        for (const line of issueLines(parsed.error, 'applyReport')) t.fail(line);
      }
      t.check(
        report.accepted === false,
        'apply() accepted an unapproved ChangeSet. Propose and apply are separate acts precisely so that a model cannot clear its own work (ADR-012).',
      );
      t.check(
        UNAPPROVED_STATUSES.includes(report.status as ChangeSetStatus),
        `apply() reported an unapproved ChangeSet as "${report.status}"`,
      );
    }

    // The half that catches the cheat. A connector that approves on the caller's
    // behalf and then reports a refusal passes every check above; it cannot pass
    // this one, because the set it quietly cleared is no longer unapproved.
    const after = await t.adapter.diff(changeSetId);
    t.check(
      UNAPPROVED_STATUSES.includes(after.status as ChangeSetStatus),
      `after a refused apply, ${changeSetId} is in status "${after.status}" — the connector moved it past the approval gate while reporting that it had not`,
    );
  },
};

const applyUnknownIsNotFound: Case = {
  id: 'apply-unknown-changeset-is-not-found',
  title: 'Applying a ChangeSet that does not exist is not_found',
  requirement: 'apply() on an unknown id fails with not_found, not with not_approved.',
  source: 'packages/protocol/src/errors.ts (not_found)',
  async run(t) {
    const unknown = t.newId();
    const outcome = await rejection(() => t.adapter.apply(unknown));

    if (!isRejection(outcome)) {
      t.fail(`apply() reported on ChangeSet ${unknown}, which was never proposed: status "${(outcome.value as { status?: string }).status ?? 'unknown'}"`);
      return;
    }

    const view = t.classify(outcome.error, 'apply');
    if (!view) return;
    // This case exists to catch the cheapest way to pass the case above: an
    // apply() that throws not_approved unconditionally. That connector is not
    // enforcing a gate, it is broken — and only a second, differently-shaped
    // failure can tell the two apart.
    t.check(
      view.code === 'not_found',
      `apply() on an id that was never proposed reported "${view.code}"; an apply that answers the same way to every input is not enforcing anything`,
    );
  },
};

const applyAfterHumanApproval: Case = {
  id: 'apply-after-human-approval',
  title: 'The same ChangeSet applies once a human — not the connector — approves it',
  requirement:
    'After an out-of-band human approval, apply() accepts the identical ChangeSet it refused before.',
  source: 'ADR-012 (approval is an act a model cannot perform)',
  async run(t) {
    const approval = t.options.humanApproval;
    if (!approval) {
      throw t.unsupported(
        'no HumanApproval was supplied. Without it the suite can prove apply() refuses, but not that the refusal is a gate rather than a connector that always throws — supply one to close that hole.',
      );
    }

    const proposal = await ensureProposal(t);
    const verdict = proposal.validation ?? proposal.diff.validation;
    if (verdict && (verdict.luau.status === 'fail' || verdict.policy.status === 'fail')) {
      throw t.unsupported(
        `this project refuses the fixture on validation (luau ${verdict.luau.status}, policy ${verdict.policy.status}), so no approval could clear it. Pass ConformanceOptions.fixture with operations this project's policy permits.`,
      );
    }

    try {
      await approval.approve(proposal.changeSetId);
    } catch (error) {
      t.fail(`the supplied HumanApproval could not approve ${proposal.changeSetId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    t.state.approved = proposal.changeSetId;

    const outcome = await rejection(() => t.adapter.apply(proposal.changeSetId));
    if (isRejection(outcome)) {
      const view = t.classify(outcome.error, 'apply');
      t.fail(
        `apply() still refused ${proposal.changeSetId} after a human approved it (${view?.code ?? 'unclassifiable'}). An apply that refuses whatever it is handed is not enforcing the gate, it is standing in front of the door.`,
      );
      return;
    }

    const report = outcome.value;
    const parsed = ConnectorApplyReportShape.safeParse(report);
    if (!parsed.success) {
      for (const line of issueLines(parsed.error, 'applyReport')) t.fail(line);
      return;
    }

    t.check(parsed.data.accepted, `apply() still refused ${proposal.changeSetId} after a human approved it: ${parsed.data.message ?? 'no message'}`);
    t.check(
      CLEARED_STATUSES.includes(parsed.data.status),
      `an approved ChangeSet was reported as "${parsed.data.status}"`,
    );
    t.note(`approved out of band, then applied as "${parsed.data.status}"`);
  },
};

const errorCodesTotal: Case = {
  id: 'error-codes-total',
  title: 'Every protocol ErrorCode maps to something the caller can branch on',
  requirement:
    'describeError() classifies every ErrorCode — both as a thrown ForgeBridgeError and as the ProtocolError payload off the wire — and defaults an unrecognised failure to internal.',
  source: 'packages/protocol/src/errors.ts, ADR-008',
  async run(t) {
    for (const code of ErrorCode.options) {
      const thrown = new ForgeBridgeError(code, `synthetic ${code}`, 'synthetic remedy');
      const view = t.classify(thrown, `describeError(ForgeBridgeError ${code})`);
      if (view) {
        t.check(
          view.code === code,
          `a thrown ForgeBridgeError("${code}") was classified as "${view.code}"; a caller branching on the code would take the wrong branch`,
        );
        t.check(view.recognised, `a thrown ForgeBridgeError("${code}") was not recognised as a protocol error`);
      }

      // The same code as it actually arrives: a JSON body, not an instance of
      // anybody's class. A connector that only understands its own error type
      // has a mapping that works in its own tests and nowhere else.
      const wire = { code, message: `synthetic ${code}`, remedy: 'synthetic remedy' };
      const fromWire = t.classify(wire, `describeError(ProtocolError payload ${code})`);
      if (fromWire) {
        t.check(
          fromWire.code === code,
          `the wire payload {"code":"${code}"} was classified as "${fromWire.code}"`,
        );
      }
    }

    const unknown = t.classify(new Error('socket hang up'), 'describeError(unknown)');
    if (unknown) {
      t.check(
        unknown.code === 'internal',
        `an unrecognised failure was classified as "${unknown.code}"; the protocol's answer for "we do not know" is internal, and reporting it as anything else invents a decision nobody made`,
      );
      t.check(!unknown.recognised, 'an unrecognised failure was reported as recognised');
    }

    // Nothing is a plausible thing to be handed by a transport that timed out.
    t.classify(undefined, 'describeError(undefined)');
  },
};

const runReportsEveryAttempt: Case = {
  id: 'run-reports-every-attempt',
  title: 'A run reports every model attempt, in order',
  requirement:
    'startRun() returns the complete ModelAttempt list — every model tried, with why the router moved on — and never only the one that succeeded.',
  source: 'ADR-008 (capability router with visible fallback), packages/protocol/src/run.ts',
  async run(t) {
    // Captured before the guard so the narrowing survives the awaits below.
    const startRun = t.adapter.startRun?.bind(t.adapter);
    if (!startRun) {
      throw t.unsupported(
        'this connector exposes no run surface. Nothing can produce a ChangeSet from a prompt yet: there is no POST /v1/runs on the daemon (TODO(M09) in packages/cli/src/commands/run.ts), so this case is waiting on the route rather than on the connector.',
      );
    }

    const projectId = await ensureProject(t);
    const run = await startRun({
      projectId,
      prompt: 'conformance: add a marker script to ServerScriptService',
      ...(t.options.run?.input ?? {}),
    });

    const parsed = ConnectorRunShape.safeParse(run);
    if (!parsed.success) {
      for (const line of issueLines(parsed.error, 'run')) t.fail(line);
      return;
    }
    const { attempts, stage, status, resolvedModelId } = parsed.data;

    if (stage !== 'queued') {
      t.check(attempts.length > 0, `a run in stage "${stage}" reports no attempts; a run is not reproducible without the list of what was tried`);
    }

    attempts.forEach((attempt, index) => {
      t.check(attempt.modelId.trim().length > 0, `attempts[${index}] names no model`);
      const previous = attempts[index - 1];
      if (previous) {
        t.check(
          Date.parse(previous.startedAt) <= Date.parse(attempt.startedAt),
          `attempts[${index}] started before attempts[${index - 1}]; the array is the order the router tried them, not a set`,
        );
      }
    });

    if (status === 'succeeded') {
      const last = attempts[attempts.length - 1];
      t.check(
        last?.outcome === 'ok',
        `a succeeded run ends on attempt outcome "${last?.outcome ?? 'none'}"; the model whose output the run stands behind has to be in the list`,
      );
    }

    if (resolvedModelId) {
      t.check(
        attempts.some((attempt) => attempt.modelId === resolvedModelId && attempt.outcome === 'ok'),
        `the run credits "${resolvedModelId}" but no ok attempt names it — a model swapped in without an attempt appended (ADR-008)`,
      );
    }

    // The completeness check. Shape alone cannot catch a truncated list: a run
    // that fell back twice and reports only the winner is perfectly well-formed.
    // So when the harness knows what the router was made to do, the list must
    // match it exactly.
    const expected = t.options.run?.expectedAttempts;
    if (expected) {
      if (t.check(
        attempts.length === expected.length,
        `the run reports ${attempts.length} attempt(s) where the router made ${expected.length}: ${expected.map((e) => `${e.modelId}→${e.outcome}`).join(', ')}. A model was swapped without an attempt being appended (ADR-008).`,
      )) {
        expected.forEach((want, index) => {
          const got = attempts[index];
          t.check(
            got?.modelId === want.modelId && got?.outcome === want.outcome,
            `attempts[${index}] should be ${want.modelId}→${want.outcome}, got ${got?.modelId ?? 'nothing'}→${got?.outcome ?? 'nothing'}`,
          );
        });
      }
    } else {
      t.note('no expectedAttempts were supplied, so completeness of the list was not checked — only its shape and order');
    }

    t.note(attempts.map((attempt) => `${attempt.modelId}→${attempt.outcome}`).join(' · ') || 'no attempts');
  },
};

const surfacePortable: Case = {
  id: 'surface-portable',
  title: 'The advertised surface is self-describing and portable',
  requirement:
    'describeSurface() names a protocol-compatible connector whose advertised operation ids are unique and portable.',
  source: 'docs/ARCHITECTURE.md §5, packages/a2a/src/card.ts, packages/mcp/src/config.ts',
  async run(t) {
    const describeSurface = t.adapter.describeSurface?.bind(t.adapter);
    if (!describeSurface) {
      throw t.unsupported('this connector advertises no tool list, skill list or Agent Card');
    }

    const surface = await describeSurface();
    const parsed = ConnectorSurfaceShape.safeParse(surface);
    if (!parsed.success) {
      for (const line of issueLines(parsed.error, 'surface')) t.fail(line);
      return;
    }

    t.check(
      majorOf(parsed.data.protocolVersion) === PROTOCOL_MAJOR,
      `the advertised protocolVersion "${parsed.data.protocolVersion}" is not major ${PROTOCOL_MAJOR}`,
    );

    const seen = new Set<string>();
    for (const operation of parsed.data.operations) {
      t.check(!seen.has(operation.id), `the surface advertises "${operation.id}" twice; a caller cannot address either one`);
      seen.add(operation.id);
      t.check(PORTABLE_ID.test(operation.id), `"${operation.id}" is not a portable identifier (${PORTABLE_ID.source})`);
    }

    // Reported, never failed. Some clients project tools into an OpenAI-style
    // function schema whose grammar is [A-Za-z0-9_-], which a dot fails —
    // but whether any shipping client actually refuses one has not been
    // verified (TODO(M31) in packages/mcp/src/config.ts), and failing a
    // connector over an unverified claim would make this suite the thing that
    // is wrong.
    const dotted = parsed.data.operations.filter((operation) => operation.id.includes('.'));
    if (dotted.length > 0) {
      t.note(
        `${dotted.length} advertised id(s) contain a dot (e.g. "${dotted[0]?.id}"). Clients that project into an OpenAI-style function schema accept only [A-Za-z0-9_-]; if one refuses these, the connector's separator is the knob to turn.`,
      );
    }
    t.note(`${parsed.data.name}${parsed.data.version ? `@${parsed.data.version}` : ''} advertises ${parsed.data.operations.length} operation(s)`);
  },
};

/**
 * The suite, in the order it runs.
 *
 * Order is load-bearing in one place only: `apply-after-human-approval`
 * approves the very ChangeSet `apply-refused-without-approval` was refused, so
 * it has to come after it. Everything else is independent, and every case
 * resolves its own prerequisites so it can be run alone with
 * `ConformanceOptions.only`.
 */
export const CONFORMANCE_CASES: readonly Case[] = [
  linkPosture,
  projectsListed,
  treeRead,
  proposeReturnsIdAndDiff,
  verdictRecomputed,
  staleBaseRefused,
  applyRefusedWithoutApproval,
  applyUnknownIsNotFound,
  applyAfterHumanApproval,
  errorCodesTotal,
  runReportsEveryAttempt,
  surfacePortable,
];

export const CASE_IDS: readonly string[] = CONFORMANCE_CASES.map((testCase) => testCase.id);

/**
 * Run every case against a live connector and report what happened.
 *
 * This never throws for a failing connector — a failed case is data. It throws
 * only for a caller error, such as naming a case id that does not exist, since
 * a typo in `only` would otherwise silently run nothing and report success.
 */
export async function runConformanceSuite(
  adapter: ConnectorAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  if (options.only) {
    const unknown = options.only.filter((id) => !CASE_IDS.includes(id));
    if (unknown.length > 0) {
      throw new Error(`unknown conformance case id(s): ${unknown.join(', ')}. Known ids: ${CASE_IDS.join(', ')}`);
    }
  }

  const selected = options.only ? CONFORMANCE_CASES.filter((testCase) => options.only?.includes(testCase.id)) : CONFORMANCE_CASES;
  const state: SuiteState = {};
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const results: CaseResult[] = [];

  for (const testCase of selected) {
    const failures: string[] = [];
    const notes: string[] = [];
    const caseStart = Date.now();

    const t: CaseContext = {
      adapter,
      options,
      state,
      now: options.now ?? ((): Date => new Date()),
      newId: options.newId ?? randomUUID,
      check(condition, message) {
        if (!condition) failures.push(message);
        return condition;
      },
      fail(message) {
        failures.push(message);
      },
      note(message) {
        notes.push(message);
      },
      unsupported(reason) {
        return new Unsupported(reason);
      },
      classify(error, label) {
        let view: ConnectorErrorView;
        try {
          view = adapter.describeError(error);
        } catch (thrown) {
          failures.push(`${label}: describeError() threw ${thrown instanceof Error ? thrown.name : 'a non-error'} instead of classifying — a classifier that can fail is one a caller cannot use in a catch block`);
          return null;
        }
        if (!view || typeof view !== 'object') {
          failures.push(`${label}: describeError() returned ${String(view)} rather than a { code, recognised } view`);
          return null;
        }
        if (!ErrorCode.safeParse(view.code).success) {
          failures.push(`${label}: describeError() reported code ${JSON.stringify(view.code)}, which is not a protocol ErrorCode. The set is closed on purpose: a caller must be able to branch on it.`);
          return null;
        }
        return view;
      },
    };

    let outcome: CaseResult['outcome'] = 'pass';
    try {
      await testCase.run(t);
      if (failures.length > 0) outcome = 'fail';
    } catch (error) {
      if (error instanceof Unsupported) {
        outcome = 'unsupported';
        notes.push(error.message);
      } else {
        outcome = 'fail';
        failures.push(`the case threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      }
    }

    results.push({
      case: { id: testCase.id, title: testCase.title, requirement: testCase.requirement, source: testCase.source },
      outcome,
      failures,
      notes,
      durationMs: Date.now() - caseStart,
    });
  }

  return summarise(adapter.name, startedAt, results, Date.now() - startedAtMs);
}
