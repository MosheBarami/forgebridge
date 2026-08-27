import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgeBridgeError, PROTOCOL_VERSION } from '@forgebridge/protocol';
import { createDaemon, type ForgeBridgeDaemon, type ModelsPort, type RunModelClient } from '@forgebridge/daemon';
import {
  assertConformant,
  connectStudioDouble,
  daemonHumanApproval,
  formatReport,
  runConformanceSuite,
  type ConnectorAdapter,
  type ConnectorApplyReport,
  type ConnectorDiff,
  type ConnectorErrorView,
  type ConnectorLinkStatus,
  type ConnectorProject,
  type ConnectorProposal,
  type ConnectorRun,
  type ConnectorSurface,
  type ConnectorTree,
  type ProposeInput,
  type RunInput,
} from '@forgebridge/conformance';
import { DENY_ALL_APPROVALS } from '../src/approval.js';
import { DaemonBackend } from '../src/backend.js';
import { classifyFailure } from '../src/errors.js';
import { A2AHandler } from '../src/jsonrpc.js';
import { SkillExecutor } from '../src/executor.js';
import { FORGEBRIDGE_SKILLS, SKILL_INVOCATION_EXTENSION_URI, type SkillId } from '../src/skills.js';
import { TaskStore } from '../src/tasks.js';
import type { Task } from '../src/spec.js';

/**
 * `@forgebridge/a2a` against the connector conformance suite, on a live daemon.
 *
 * Every adapter method below sends one A2A `SendMessage` through the real
 * handler — parsing the invocation, creating the task, running the executor,
 * reading the artifact back off the task. Calling `SkillExecutor` or
 * `DaemonBackend` directly would have been shorter and would have skipped the
 * layers a remote agent actually talks to.
 *
 * ── The gate is wired the way a deployment wires it ──────────────────────────
 *
 * `DENY_ALL_APPROVALS`. Not a gate this test can satisfy — the *whole* point of
 * `apply-after-human-approval` is that the approval arrives from somewhere the
 * connector cannot reach, and here it arrives through `daemonHumanApproval`,
 * which talks to the daemon directly. A gate this adapter could feed would
 * prove that `apply-approved-changeset` works and nothing at all about ADR-012.
 */

// ── the daemon this connector is pointed at ──────────────────────────────────

const DOWN_MODEL = 'conformance/down';
const UP_MODEL = 'conformance/up';

/** How the adapter asks the scripted model for a specific set of operations. */
const DRAFT_MARKER = 'CONFORMANCE-DRAFT';

const DEFAULT_DRAFT = JSON.stringify({
  summary: 'conformance: write a marker script',
  operations: [
    {
      op: 'writeScript',
      path: 'ServerScriptService.ForgeBridgeConformance',
      scriptType: 'Script',
      source: 'print("forgebridge conformance")\n',
    },
  ],
});

/**
 * A model that fails once and then answers.
 *
 * The first candidate always throws, so `run-reports-every-attempt` has a real
 * fallback to report. A scripted model that always succeeded would let a
 * connector reporting only the winner pass the case, because a one-attempt list
 * and a truncated one look identical (ADR-008).
 *
 * The failure is a plain `Error` rather than a classified `ModelClientError`,
 * so the core records `provider-error` — the outcome it uses for a throw it was
 * not told how to read. Deliberate: this package depends on neither
 * `@forgebridge/core` nor, at runtime, on the daemon, and importing an error
 * class to script a double would be a test reaching around that.
 */
class ScriptedModels implements RunModelClient {
  readonly providers: readonly string[] = ['conformance'];

  async configured(): Promise<boolean> {
    return true;
  }

  async complete(request: {
    model: { id: string };
    messages: readonly { role: string; content: string }[];
  }): Promise<unknown> {
    if (request.model.id === DOWN_MODEL) throw new Error('scripted: this model is not answering');
    return {
      text: draftFor(request.messages),
      finishReason: 'stop',
      usage: { promptTokens: 40, completionTokens: 80, costUsd: 0 },
    };
  }
}

function draftFor(messages: readonly { role: string; content: string }[]): string {
  for (const message of messages) {
    const at = message.content.indexOf(DRAFT_MARKER);
    if (at === -1) continue;
    return (message.content.slice(at + DRAFT_MARKER.length).split('\n')[0] ?? '').trim();
  }
  return DEFAULT_DRAFT;
}

function modelsPort(): ModelsPort {
  const candidate = (id: string): Record<string, unknown> => ({
    id,
    provider: 'conformance',
    contextTokens: 128_000,
    capabilities: ['tools', 'structured_outputs', 'response_format'],
    free: true,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  });
  return {
    async snapshot() {
      return { configured: true, source: 'conformance fixture', verifiedAt: null, models: [] };
    },
    async candidates() {
      return [candidate(DOWN_MODEL), candidate(UP_MODEL)] as never;
    },
  };
}

interface Harness {
  daemon: ForgeBridgeDaemon;
  adapter: ConnectorAdapter;
  approve: { approve(changeSetId: string): Promise<void> };
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const daemon = createDaemon({
    port: 0,
    policy: {
      allowedPathPrefixes: ['Workspace', 'ServerScriptService', 'ReplicatedStorage'],
      autoApply: null,
    },
    models: modelsPort(),
    modelClient: new ScriptedModels(),
  });
  await daemon.listen();

  // The daemon refuses to approve a set for a project with no paired link, so
  // something has to be on the consumer end for the approval half to run.
  const { code } = daemon.issuePairingCode();
  await connectStudioDouble({ baseUrl: daemon.url, pairingCode: code });

  const tasks = new TaskStore();
  const handler = new A2AHandler({
    tasks,
    executor: new SkillExecutor({
      backend: new DaemonBackend({ baseUrl: daemon.url, producerToken: daemon.producerToken }),
      gate: DENY_ALL_APPROVALS,
      tasks,
    }),
  });

  return {
    daemon,
    adapter: a2aAdapter(handler, daemon.defaultProjectId),
    approve: daemonHumanApproval({ baseUrl: daemon.url, producerToken: daemon.producerToken }),
    close: () => daemon.close(),
  };
}

// ── the adapter ──────────────────────────────────────────────────────────────

/** A task that did not complete, thrown so the suite's classifier can read it. */
class SkillRefused extends Error {
  constructor(
    readonly task: Task,
    readonly detail: unknown,
  ) {
    super(task.status.message?.parts[0]?.text ?? `task ended in ${task.status.state}`);
    this.name = 'SkillRefused';
  }
}

export function a2aAdapter(handler: A2AHandler, defaultProjectId: string): ConnectorAdapter {
  /**
   * One skill invocation, through the whole A2A surface.
   *
   * The extension is declared on every call because the card marks it
   * `required: true` and the handler enforces that — a message without it is
   * refused before any skill is chosen, which is what stops a prose message
   * from being guessed into an apply.
   */
  async function invoke(skill: SkillId, input: unknown): Promise<Record<string, unknown>> {
    const { task } = (await handler.call(
      'SendMessage',
      {
        message: {
          messageId: randomUUID(),
          role: 'ROLE_USER',
          parts: [{ data: { skill, input }, mediaType: 'application/json' }],
        },
      },
      { declaredExtensions: [SKILL_INVOCATION_EXTENSION_URI] },
    )) as { task: Task };

    if (task.status.state !== 'TASK_STATE_COMPLETED') {
      // Every non-completed state carries its reason as a data Part on the
      // status message: an `ErrorInfo` whose metadata names the protocol code
      // for a failure, or `APPROVAL_REQUIRED` for a task waiting on a human.
      throw new SkillRefused(task, task.status.message?.parts.find((part) => 'data' in part)?.data);
    }

    const artifact = task.artifacts?.[0];
    const payload = artifact?.parts.find((part) => 'data' in part)?.data;
    if (payload === undefined) throw new Error(`skill "${skill}" completed with no data artifact`);
    return payload as Record<string, unknown>;
  }

  const diff = async (changeSetId: string): Promise<ConnectorDiff> =>
    (await invoke('review-changeset-diff', { changeSetId })) as unknown as ConnectorDiff;

  return {
    name: '@forgebridge/a2a',

    async linkStatus(): Promise<ConnectorLinkStatus> {
      const status = (await invoke('studio-link-status', {})) as unknown as {
        transport: ConnectorLinkStatus['transport'];
        privacyPosture: string;
        protocolVersion: string;
        defaultProjectId: string;
        links: { id: string; projectId: string; state: string }[];
      };
      return {
        transport: status.transport,
        // Forwarded byte for byte: the posture is one of the few strings whose
        // wording is the contract, and this connector never rewords it.
        privacyPosture: status.privacyPosture,
        protocolVersion: status.protocolVersion,
        defaultProjectId: status.defaultProjectId,
        links: status.links.map((link) => ({
          linkId: link.id,
          projectId: link.projectId,
          state: link.state,
        })),
      };
    },

    /**
     * Assembled from the link status, because A2A has no list-projects skill
     * and inventing one for a conformance run would be advertising a surface
     * this connector does not serve.
     */
    async listProjects(): Promise<ConnectorProject[]> {
      const status = await this.linkStatus();
      const ids = new Set(status.links.map((link) => link.projectId));
      ids.add(status.defaultProjectId ?? defaultProjectId);
      return [...ids].map((projectId) => ({
        projectId,
        isDefault: projectId === (status.defaultProjectId ?? defaultProjectId),
        links: status.links.filter((link) => link.projectId === projectId),
      }));
    },

    /**
     * Refused in the protocol's own words, which is what the case accepts.
     *
     * This connector advertises no tree-reading skill, because `/v1` serves no
     * tree snapshot. Answering `not_found` with a remedy is the honest form of
     * that, and it is the same answer `forge.read_tree` gives.
     */
    async readTree(): Promise<ConnectorTree> {
      throw new ForgeBridgeError(
        'not_found',
        'this ForgeBridge connector advertises no skill that reads a tree snapshot',
        'Ask the user for the instance paths you need. A tree read needs a /v1 endpoint that does not exist yet (M09 owns the snapshot, M31 agrees the wire shape).',
      );
    },

    async propose(input: ProposeInput): Promise<ConnectorProposal> {
      // `claimedValidation` is dropped rather than forwarded. It could be
      // forwarded — `ProposeChangesetInput` carries a whole `ChangeSet`, whose
      // schema has a `validation` field — and the daemon would overwrite it
      // anyway; the suite proves that from the outside either way. Dropping it
      // is the behaviour a connector should have: a producer's own verdict is
      // not this connector's to relay as if it meant something.
      const payload = (await invoke('propose-changeset', {
        changeSet: {
          id: randomUUID(),
          projectId: input.projectId,
          baseVersion: input.baseVersion,
          summary: input.summary,
          operations: input.operations,
          createdAt: new Date().toISOString(),
        },
      })) as unknown as { changeSetId: string; status: string; validation: unknown };

      return {
        changeSetId: payload.changeSetId,
        status: payload.status as ConnectorProposal['status'],
        validation: payload.validation as ConnectorProposal['validation'],
        diff: await diff(payload.changeSetId),
      };
    },

    diff,

    /**
     * Report on a ChangeSet a human has already approved.
     *
     * The diff read first is not a formality: it is what makes an id that was
     * never proposed answer `not_found` instead of being refused by the gate
     * for a set that does not exist. The reference adapter and
     * `forge.apply_changeset` both do the same, and it is also what an A2A
     * caller does — read the diff, then act.
     *
     * When the set is not yet cleared, `apply-approved-changeset` is invoked
     * anyway. That call is the evidence: it reaches the gate, the gate has no
     * grant, and the task stops at `TASK_STATE_AUTH_REQUIRED` — a remote agent
     * asked to apply and was refused, which is precisely the claim ADR-012
     * makes about this connector.
     */
    async apply(changeSetId: string): Promise<ConnectorApplyReport> {
      const current = await diff(changeSetId);
      const status = current.status as ConnectorApplyReport['status'];

      if (['approved', 'applying', 'applied', 'partial', 'failed'].includes(status)) {
        return {
          changeSetId,
          status,
          accepted: true,
          message:
            'A human approved this ChangeSet out of band and the daemon has it queued for the paired Studio session.',
        };
      }

      await invoke('apply-approved-changeset', { changeSetId });
      // Unreachable in practice: with `DENY_ALL_APPROVALS` the call above always
      // stops at AUTH_REQUIRED and throws. Reported as a refusal rather than as
      // an acceptance if it ever is reached, because failing closed is the only
      // safe default for the gate between a model and someone's place.
      return { changeSetId, status, accepted: false, message: 'no human has cleared this ChangeSet' };
    },

    async startRun(input: RunInput): Promise<ConnectorRun> {
      const payload = (await invoke('start-run', {
        prompt: input.prompt,
        projectId: input.projectId,
      })) as unknown as {
        run: { id: string; stage: string; status: string; attempts: ConnectorRun['attempts']; changeSetIds: string[] };
        changeSetId: string | null;
      };
      return {
        runId: payload.run.id,
        stage: payload.run.stage,
        status: payload.run.status,
        // Whole and in order. The artifact carries what the daemon reported;
        // trimming it to the model that answered is the substitution ADR-008
        // exists to catch.
        attempts: payload.run.attempts,
        changeSetIds: payload.run.changeSetIds,
      };
    },

    describeSurface(): ConnectorSurface {
      return {
        name: '@forgebridge/a2a',
        protocolVersion: PROTOCOL_VERSION,
        operations: FORGEBRIDGE_SKILLS.map((skill) => ({ id: skill.id, description: skill.description })),
      };
    },

    /**
     * The connector's own classifier, not one written for the suite.
     *
     * A refused task carries its reason as a `google.rpc.ErrorInfo` detail, and
     * that detail is all a remote agent ever holds — so it is what
     * `classifyFailure` is fed here. `APPROVAL_REQUIRED` has no protocol code in
     * its metadata, because it is not a daemon refusal: it is this connector's
     * own gate, and it maps to `not_approved`, which is the code a caller
     * branches on to go and find a human.
     */
    describeError(error: unknown): ConnectorErrorView {
      if (error instanceof SkillRefused) {
        const detail = error.detail as { reason?: string } | undefined;
        if (detail?.reason === 'APPROVAL_REQUIRED') {
          return {
            code: 'not_approved',
            recognised: true,
            transportCode: error.task.status.state,
            message: error.message,
            remedy:
              'A human must approve this ChangeSet out of band; no message to this agent can do it (ADR-012). Re-send the request afterwards.',
          };
        }
        const view = classifyFailure(error.detail);
        return {
          code: view.code,
          recognised: view.recognised,
          transportCode: error.task.status.state,
          message: view.message || error.message,
          ...(view.remedy ? { remedy: view.remedy } : {}),
        };
      }

      const view = classifyFailure(error);
      return {
        code: view.code,
        recognised: view.recognised,
        transportCode: view.state,
        message: view.message,
        ...(view.remedy ? { remedy: view.remedy } : {}),
      };
    },
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('@forgebridge/a2a is a conformant connector', () => {
  it('passes every case it supports, against a live daemon', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, {
      humanApproval: harness.approve,
      // What the router was scripted to do. Without it the run case can check
      // the shape and order of the attempt list but not its completeness.
      run: {
        expectedAttempts: [
          { modelId: DOWN_MODEL, outcome: 'provider-error' },
          { modelId: UP_MODEL, outcome: 'ok' },
        ],
      },
    });

    expect(report.ok, formatReport(report)).toBe(true);
    expect(() => assertConformant(report)).not.toThrow();
  });

  it('refuses to apply what no human cleared, and the set stays unapproved', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { humanApproval: harness.approve });
    const outcome = (id: string): string | undefined =>
      report.results.find((result) => result.case.id === id)?.outcome;

    expect(outcome('apply-refused-without-approval'), formatReport(report)).toBe('pass');
    expect(outcome('apply-unknown-changeset-is-not-found')).toBe('pass');
    // And the same set applies once a human approves it, which is what makes
    // the refusal a gate rather than a skill that always says no.
    expect(outcome('apply-after-human-approval')).toBe('pass');
  });

  it('records the one gap it has as unsupported, not as a failure', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { humanApproval: harness.approve });
    const unsupported = report.results
      .filter((result) => result.outcome === 'unsupported')
      .map((result) => result.case.id);

    expect(unsupported).toEqual(['tree-read']);
    expect(report.ok).toBe(true);
  });

  it('reports every model the run tried, through the skill a remote agent invokes', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, {
      humanApproval: harness.approve,
      only: ['run-reports-every-attempt'],
      run: {
        expectedAttempts: [
          { modelId: DOWN_MODEL, outcome: 'provider-error' },
          { modelId: UP_MODEL, outcome: 'ok' },
        ],
      },
    });

    expect(report.ok, formatReport(report)).toBe(true);
    expect(formatReport(report)).toContain(`${DOWN_MODEL}→provider-error`);
  });
});
