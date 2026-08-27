import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@forgebridge/protocol';
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
import { DaemonClient } from '../src/daemon-client.js';
import { classifyFailure, type ToolResult } from '../src/errors.js';
import { registerForgeBridgeTools } from '../src/register.js';
import { TOOLS, type ToolContext } from '../src/tools.js';

/**
 * `@forgebridge/mcp` against the connector conformance suite, on a live daemon.
 *
 * The adapter below is a shim and nothing more: every method is one tool call,
 * made through `registerForgeBridgeTools` rather than by reaching into a
 * handler. That indirection is the point — the registration wrapper is what
 * turns a thrown refusal into an `isError` tool result, and a result is what a
 * calling model actually receives. An adapter that called the handlers directly
 * would be testing a path no client uses.
 *
 * **There is no approve call here, and there is none to make.** The suite's
 * approval arrives through `daemonHumanApproval`, an object this adapter cannot
 * reach, for the reason ADR-012 gives: an approval the connector could arrange
 * for itself would prove that apply works and nothing at all about the gate.
 */

// ── the daemon this connector is pointed at ──────────────────────────────────

/**
 * A model that fails once and then answers.
 *
 * Two candidates on one provider, and the first always throws. That is what
 * makes `run-reports-every-attempt` worth running: a scripted model that always
 * succeeded would let a connector reporting only the winner pass the case,
 * because a one-attempt list and a truncated one look identical (ADR-008).
 *
 * The failure is a plain `Error` rather than a classified `ModelClientError`,
 * so the core records `provider-error` — the outcome it uses for a throw it was
 * not told how to read. That is deliberate: this package does not depend on
 * `@forgebridge/core`, and importing its error class to script a test double
 * would be a test reaching around the layering the connector is built on.
 */
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

class ScriptedModels implements RunModelClient {
  readonly providers: readonly string[] = ['conformance'];
  readonly asked: string[] = [];

  async configured(): Promise<boolean> {
    return true;
  }

  async complete(request: {
    model: { id: string };
    messages: readonly { role: string; content: string }[];
  }): Promise<unknown> {
    this.asked.push(request.model.id);
    if (request.model.id === DOWN_MODEL) throw new Error('scripted: this model is not answering');
    return {
      text: draftFor(request.messages),
      finishReason: 'stop',
      usage: { promptTokens: 40, completionTokens: 80, costUsd: 0 },
    };
  }
}

/**
 * What the scripted model "writes".
 *
 * The prompt carries the draft when the caller had one in mind, which is how
 * the run route stands in for a propose: see `propose` on the adapter. A prompt
 * without one — the run case's own, which is prose — gets the marker script the
 * suite's fixture would have written.
 */
function draftFor(messages: readonly { role: string; content: string }[]): string {
  for (const message of messages) {
    const at = message.content.indexOf(DRAFT_MARKER);
    if (at === -1) continue;
    const rest = message.content.slice(at + DRAFT_MARKER.length);
    const line = rest.split('\n')[0] ?? '';
    return line.trim();
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
  // Port 0: a fixed one would make this suite fight a daemon the developer
  // already has running.
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

  // The daemon refuses to approve a ChangeSet for a project with no paired
  // link — an approval that could never be delivered is a lie told to the
  // approver — so something has to be on the consumer end.
  const { code } = daemon.issuePairingCode();
  await connectStudioDouble({ baseUrl: daemon.url, pairingCode: code });

  const context: ToolContext = {
    client: new DaemonClient({ baseUrl: daemon.url, producerToken: daemon.producerToken }),
    defaultProjectId: null,
  };

  return {
    daemon,
    adapter: mcpAdapter(context),
    approve: daemonHumanApproval({ baseUrl: daemon.url, producerToken: daemon.producerToken }),
    close: () => daemon.close(),
  };
}

// ── the adapter ──────────────────────────────────────────────────────────────

/** A tool that answered with `isError`, thrown so a caller can branch on it. */
class ToolCallFailed extends Error {
  constructor(readonly result: ToolResult) {
    super(result.content[0]?.text ?? 'the tool refused');
    this.name = 'ToolCallFailed';
  }
}

export function mcpAdapter(context: ToolContext): ConnectorAdapter {
  const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
  registerForgeBridgeTools(
    { registerTool: (name, _config, handler) => void handlers.set(name, handler) },
    context,
  );

  async function call(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`this server registers no tool named ${name}`);
    const result = await handler(args);
    if (result.isError === true) throw new ToolCallFailed(result);
    const text = result.content[0]?.text ?? '';
    return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>;
  }

  const linkStatus = async (): Promise<ConnectorLinkStatus> => {
    const status = (await call('forge.link_status')) as unknown as {
      transport: ConnectorLinkStatus['transport'];
      privacyPosture: string;
      protocolVersion: string;
      defaultProjectId?: string;
      links?: { id: string; projectId: string; state: string }[];
    };
    return {
      transport: status.transport,
      // Forwarded byte for byte. The posture is one of the few strings whose
      // wording is the contract, and a connector that paraphrased it would have
      // told the user something false about who can read their code.
      privacyPosture: status.privacyPosture,
      protocolVersion: status.protocolVersion,
      defaultProjectId: status.defaultProjectId ?? null,
      links: (status.links ?? []).map((link) => ({
        linkId: link.id,
        projectId: link.projectId,
        state: link.state,
      })),
    };
  };

  const diff = async (changeSetId: string): Promise<ConnectorDiff> =>
    (await call('forge.diff_changeset', { changeSetId })) as unknown as ConnectorDiff;

  return {
    name: '@forgebridge/mcp',
    linkStatus,

    async listProjects(): Promise<ConnectorProject[]> {
      const payload = (await call('forge.list_projects')) as unknown as {
        projects: { projectId: string; isDefault: boolean; links: { linkId: string; state: string }[] }[];
      };
      return payload.projects.map((project) => ({
        projectId: project.projectId,
        isDefault: project.isDefault,
        // The tool omits the project id inside each link — it is the key the
        // list is grouped by — so it is put back here rather than left out of a
        // shape the protocol describes.
        links: project.links.map((link) => ({ ...link, projectId: project.projectId })),
      }));
    },

    /**
     * Refused, in the protocol's own words, which is what the case accepts.
     *
     * `forge.read_tree` answers `not_found` with a remedy because no `/v1`
     * endpoint serves a tree snapshot. The suite reads that refusal and records
     * the case as unsupported; the day the endpoint lands, the tool returns a
     * tree and the case starts passing with no edit here.
     */
    readTree: async (projectId: string): Promise<ConnectorTree> =>
      (await call('forge.read_tree', { projectId })) as unknown as ConnectorTree,

    async propose(input: ProposeInput): Promise<ConnectorProposal> {
      // `claimedValidation` is not forwarded, and there is nowhere to forward
      // it to: `proposeChangeSetInput` has no validation field, so a producer's
      // own verdict cannot reach the wire through this tool at all. That is a
      // stronger answer to PROTOCOL invariant 4 than dropping it would be.
      const payload = (await call('forge.propose_changeset', {
        projectId: input.projectId,
        baseVersion: input.baseVersion,
        summary: input.summary,
        operations: input.operations,
      })) as unknown as { changeSetId: string; status: string; validation: unknown; diff: unknown };

      return {
        changeSetId: payload.changeSetId,
        status: payload.status as ConnectorProposal['status'],
        validation: payload.validation as ConnectorProposal['validation'],
        diff: payload.diff as ConnectorDiff,
      };
    },

    diff,

    async apply(changeSetId: string): Promise<ConnectorApplyReport> {
      const payload = (await call('forge.apply_changeset', { changeSetId })) as unknown as {
        changeSetId: string;
        status: string;
        approved: boolean;
        message?: string;
      };
      return {
        changeSetId: payload.changeSetId,
        status: payload.status as ConnectorApplyReport['status'],
        accepted: payload.approved === true,
        ...(payload.message ? { message: payload.message } : {}),
      };
    },

    async startRun(input: RunInput): Promise<ConnectorRun> {
      const payload = (await call('forge.start_run', {
        projectId: input.projectId,
        prompt: input.prompt,
      })) as unknown as {
        runId: string;
        stage: string;
        status: string;
        attempts: ConnectorRun['attempts'];
        changeSetId: string | null;
      };
      return {
        runId: payload.runId,
        stage: payload.stage,
        status: payload.status,
        // Whole and in order, exactly as the tool returned it. Trimming it to
        // the model that answered is the substitution ADR-008 exists to catch.
        attempts: payload.attempts,
        ...(payload.changeSetId ? { changeSetIds: [payload.changeSetId] } : {}),
      };
    },

    describeSurface(): ConnectorSurface {
      return {
        name: '@forgebridge/mcp',
        protocolVersion: PROTOCOL_VERSION,
        operations: TOOLS.map((tool) => ({ id: tool.name, description: tool.description })),
      };
    },

    /**
     * The connector's own classifier, not one written for the suite.
     *
     * `classifyFailure` is what an embedder calls; feeding the suite anything
     * else would prove that a test file can map error codes and nothing about
     * whether this package can.
     */
    describeError(error: unknown): ConnectorErrorView {
      const view = classifyFailure(error instanceof ToolCallFailed ? error.result : error);
      return {
        code: view.code,
        recognised: view.recognised,
        transportCode: view.httpStatus,
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

describe('@forgebridge/mcp is a conformant connector', () => {
  it('passes every case it supports, against a live daemon', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, {
      humanApproval: harness.approve,
      // What the router was scripted to do. Without it the run case can check
      // the shape and the order of the attempt list but not its completeness —
      // and a truncated list has a perfectly well-formed shape.
      run: {
        expectedAttempts: [
          { modelId: DOWN_MODEL, outcome: 'provider-error' },
          { modelId: UP_MODEL, outcome: 'ok' },
        ],
      },
    });

    // Rendered into the failure message rather than asserted field by field:
    // when this breaks, the reader needs the case, the requirement and the
    // source, not `expected true to be false`.
    expect(report.ok, formatReport(report)).toBe(true);
    expect(() => assertConformant(report)).not.toThrow();
  });

  it('reports both halves of the approval gate', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { humanApproval: harness.approve });
    const outcome = (id: string): string | undefined =>
      report.results.find((result) => result.case.id === id)?.outcome;

    expect(outcome('apply-refused-without-approval'), formatReport(report)).toBe('pass');
    expect(outcome('apply-unknown-changeset-is-not-found')).toBe('pass');
    // The half that proves the refusal is a gate and not a tool that always
    // throws: the identical ChangeSet applies once a human approves it.
    expect(outcome('apply-after-human-approval')).toBe('pass');
  });

  it('records the one gap it has as unsupported, not as a failure', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { humanApproval: harness.approve });
    const unsupported = report.results
      .filter((result) => result.outcome === 'unsupported')
      .map((result) => result.case.id);

    // `forge.read_tree` refuses because `/v1` serves no tree snapshot. That is
    // an honest refusal carrying a remedy, so the suite records the gap and
    // stays green — and the case starts passing the day the endpoint lands.
    expect(unsupported).toEqual(['tree-read']);
    expect(report.ok).toBe(true);
  });

  it('reports every model the run tried, through the tool a model calls', async () => {
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
    // And the notes say which models, so a reader of the report can see the
    // fallback rather than take the pass on trust.
    expect(formatReport(report)).toContain(`${DOWN_MODEL}→provider-error`);
  });
});
