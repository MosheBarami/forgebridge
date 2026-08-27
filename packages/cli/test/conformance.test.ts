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
import { COMMANDS, type GlobalOptions } from '../src/args.js';
import { DaemonClient } from '../src/client.js';
import { classifyFailure } from '../src/exit.js';
import { applyCommand } from '../src/commands/apply.js';
import { diffCommand } from '../src/commands/diff.js';
import { linkCommand } from '../src/commands/link.js';
import { runCommand } from '../src/commands/run.js';
import type { Deps } from '../src/commands/context.js';
import { captureIo } from './helpers.js';

/**
 * `@forgebridge/cli` against the connector conformance suite, on a live daemon.
 *
 * The adapter drives the command functions — `runCommand`, `diffCommand`,
 * `applyCommand`, `linkCommand` — under `--json`, and reads the document each
 * one puts on stdout. That is not a convenience: `--json` *is* this connector's
 * machine surface, so an adapter that reached past it into the transport client
 * would be testing something no script uses.
 *
 * ── Why `propose()` is a run ─────────────────────────────────────────────────
 *
 * Because this CLI has no propose command, and until tonight it had no producer
 * surface at all: a ChangeSet reached the daemon only from something else that
 * had built one. `forgebridge run` is the producer this package now has, so it
 * is what `propose()` maps onto — the suite hands operations, the scripted
 * model behind the daemon writes exactly those operations, and the ChangeSet
 * comes back through the same path a real prompt would take.
 *
 * That gives PROTOCOL invariant 4 a stronger answer here than anywhere else:
 * `claimedValidation` is not dropped by this adapter, it is *unrepresentable*.
 * The core's `DraftChangeSet` has no validation field, so a model — and
 * therefore this connector — has nowhere to put a verdict of its own.
 *
 * **There is no approve call here, and there is none to make.** `Transport`
 * declares no `approve` method. The suite's approval arrives through
 * `daemonHumanApproval`, an object this adapter cannot reach.
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
 * The first candidate always throws, so every run this suite makes has a real
 * fallback in it — which is what `run-reports-every-attempt` needs, since a
 * one-attempt list and a truncated one look identical (ADR-008).
 *
 * The failure is a plain `Error` rather than a classified `ModelClientError`,
 * so the core records `provider-error`: the outcome it uses for a throw it was
 * not told how to read. Deliberate — this package does not depend on
 * `@forgebridge/core`, and importing its error class to script a test double
 * would be a test reaching around the layering.
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

  return {
    daemon,
    adapter: cliAdapter({ json: true, baseUrl: daemon.url, token: daemon.producerToken }),
    approve: daemonHumanApproval({ baseUrl: daemon.url, producerToken: daemon.producerToken }),
    close: () => daemon.close(),
  };
}

// ── the adapter ──────────────────────────────────────────────────────────────

export function cliAdapter(global: GlobalOptions): ConnectorAdapter {
  /**
   * Run one command the way a script runs it, and read its stdout.
   *
   * Every command builds its own transport from the global options, which is
   * what a real invocation does; nothing here is injected past that. The
   * captured `Io` keeps the two streams apart, so the document this parses is
   * the one a `| jq` would have received and never a notice that belongs on
   * stderr.
   */
  async function json<T>(run: (deps: Deps) => Promise<unknown>): Promise<T> {
    const io = captureIo();
    const deps: Deps = {
      io,
      createTransport: (options) => new DaemonClient({ baseUrl: options.baseUrl, token: options.token }),
      now: () => Date.now(),
      // The commands that poll do so against a live daemon here, so a real
      // sleep would only add wall-clock time to a suite that is already
      // waiting on HTTP.
      sleep: async () => {},
    };
    await run(deps);
    const text = io.outText();
    if (text.trim() === '') throw new Error('the command printed no JSON document on stdout');
    return JSON.parse(text) as T;
  }

  const diff = async (changeSetId: string): Promise<ConnectorDiff> =>
    await json<ConnectorDiff>((deps) => diffCommand({ command: 'diff', global, changeSetId }, deps));

  /**
   * A run, which is this CLI's whole producer surface.
   *
   * `baseVersion` is passed through rather than left to the daemon: a run
   * requested against a version the project is not at is refused with
   * `stale_base` before a token is spent, and that refusal is what
   * `stale-base-refused` is about.
   */
  const startRun = async (prompt: string, projectId: string, baseVersion?: number): Promise<RunPayload> =>
    await json<RunPayload>((deps) =>
      runCommand(
        {
          command: 'run',
          global,
          prompt,
          projectId,
          policy: null,
          pinnedModel: null,
          baseVersion: baseVersion ?? null,
          maxAttempts: null,
          verbose: false,
        },
        deps,
      ),
    );

  const linkStatus = async (): Promise<ConnectorLinkStatus> => {
    const status = await json<{
      transport: ConnectorLinkStatus['transport'];
      privacyPosture: string;
      protocolVersion: string;
      defaultProjectId: string;
      links: { id: string; projectId: string; state: string }[];
    }>((deps) => linkCommand({ command: 'link', global, code: null }, deps));

    return {
      transport: status.transport,
      // Forwarded byte for byte. What the *human* sees is not this string at
      // all — `printPosture` looks the sentence up locally from the transport
      // kind, so a lying transport cannot put words in this CLI's mouth.
      privacyPosture: status.privacyPosture,
      protocolVersion: status.protocolVersion,
      defaultProjectId: status.defaultProjectId,
      links: status.links.map((link) => ({
        linkId: link.id,
        projectId: link.projectId,
        state: link.state,
      })),
    };
  };

  return {
    name: '@forgebridge/cli',
    linkStatus,

    /** Assembled from the link status: this CLI advertises no project list. */
    async listProjects(): Promise<ConnectorProject[]> {
      const status = await linkStatus();
      const ids = new Set(status.links.map((link) => link.projectId));
      if (status.defaultProjectId) ids.add(status.defaultProjectId);
      return [...ids].map((projectId) => ({
        projectId,
        isDefault: projectId === status.defaultProjectId,
        links: status.links.filter((link) => link.projectId === projectId),
      }));
    },

    /**
     * Refused in the protocol's own words, which is what the case accepts.
     *
     * There is no `forgebridge tree`, because `/v1` serves no tree snapshot to
     * render. A command that printed an empty tree would be worse than none.
     */
    async readTree(): Promise<ConnectorTree> {
      throw new ForgeBridgeError(
        'not_found',
        'this ForgeBridge CLI has no command that reads a tree snapshot',
        'Ask the user for the instance paths you need. A tree read needs a /v1 endpoint that does not exist yet (M09 owns the snapshot, M31 agrees the wire shape).',
      );
    },

    /**
     * Propose, by running.
     *
     * The operations the suite handed over travel in the prompt, and the
     * scripted model behind the daemon writes them back out as its draft. That
     * is the honest mapping for this connector: `forgebridge run` is how a
     * ChangeSet comes into existence from the command line, and the round trip
     * exercised here — prompt in, ChangeSet in `validated`, nothing applied —
     * is the whole of what the command does.
     */
    async propose(input: ProposeInput): Promise<ConnectorProposal> {
      const draft = JSON.stringify({ summary: input.summary, operations: input.operations });
      const response = await startRun(`${DRAFT_MARKER} ${draft}`, input.projectId, input.baseVersion);

      if (response.changeSetId === null) {
        throw new ForgeBridgeError(
          response.failure?.code ?? 'internal',
          response.failure?.message ?? 'the run produced no ChangeSet',
          response.failure?.remedy,
        );
      }
      return {
        changeSetId: response.changeSetId,
        status: response.changeSetStatus as ConnectorProposal['status'],
        validation: response.validation as ConnectorProposal['validation'],
        diff: await diff(response.changeSetId),
      };
    },

    diff,

    /**
     * `forgebridge apply`, with the wait turned off.
     *
     * `--timeout 0` is the mode a CI step uses when a later step polls for the
     * result itself: report what is true now and exit. What the suite needs is
     * exactly that — whether the set was cleared — and waiting for a Studio
     * session that will never report would only add a timeout to every run.
     *
     * The command refuses anything unapproved by throwing, so a refusal
     * arrives here as a `CliError` carrying the protocol code, and an id that
     * was never proposed fails at the diff read with `not_found`.
     */
    async apply(changeSetId: string): Promise<ConnectorApplyReport> {
      const report = await json<ConnectorDiff>((deps) =>
        applyCommand({ command: 'apply', global, changeSetId, timeoutSeconds: 0 }, deps),
      );
      return {
        changeSetId: report.changeSetId,
        status: report.status as ConnectorApplyReport['status'],
        // Reached only for a status `applyCommand` recognises as cleared; every
        // other status threw above.
        accepted: true,
        message: `forgebridge apply reports this ChangeSet as "${report.status}".`,
      };
    },

    async startRun(input: RunInput): Promise<ConnectorRun> {
      const response = await startRun(input.prompt, input.projectId);
      return {
        runId: response.run.id,
        stage: response.run.stage,
        status: response.run.status,
        // Whole and in order, straight off the run response. The one-liner the
        // command prints is a rendering of this list, never a replacement for
        // it (ADR-008).
        attempts: response.run.attempts,
        changeSetIds: response.run.changeSetIds,
      };
    },

    describeSurface(): ConnectorSurface {
      return {
        name: '@forgebridge/cli',
        protocolVersion: PROTOCOL_VERSION,
        operations: COMMANDS.map((id) => ({ id })),
      };
    },

    /**
     * The connector's own classifier, not one written for the suite.
     *
     * `classifyFailure` is what an embedder of this package calls. It reads the
     * protocol code off the `CliError` a refusal carries — which is why the
     * code is on the error and not only in its sentence: a caller that had to
     * scrape `stale_base:` off the front of a message would be branching on
     * prose.
     */
    describeError(error: unknown): ConnectorErrorView {
      const view = classifyFailure(error);
      return {
        code: view.code,
        recognised: view.recognised,
        // The value a caller of *this* transport branches on is the exit code.
        transportCode: view.exitCode,
        message: view.message,
        ...(view.remedy ? { remedy: view.remedy } : {}),
      };
    },
  };
}

/** The `--json` document `forgebridge run` prints, as far as this adapter reads it. */
interface RunPayload {
  run: { id: string; stage: string; status: string; attempts: ConnectorRun['attempts']; changeSetIds: string[] };
  changeSetId: string | null;
  changeSetStatus: string | null;
  validation: unknown;
  failure: { code: never; message: string; remedy?: string } | null;
}

// ── the run ──────────────────────────────────────────────────────────────────

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('@forgebridge/cli is a conformant connector', () => {
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
    // the refusal a gate rather than a command that always says no.
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

  it('reports every model the run tried, over a real event stream', async () => {
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

    // `runCommand` follows the run as it happens, so this case also exercises
    // the SSE reader in `client.ts` against a daemon that is really streaming.
    expect(report.ok, formatReport(report)).toBe(true);
    expect(formatReport(report)).toContain(`${DOWN_MODEL}→provider-error`);
  });
});
