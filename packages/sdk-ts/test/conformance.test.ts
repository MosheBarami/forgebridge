/**
 * `@forgebridge/sdk-ts` against the connector conformance suite, on a live daemon.
 *
 * `@forgebridge/conformance` is the one executable definition of what a
 * ForgeBridge connector must do, and every connector inherits it through one
 * adapter interface. This is that adapter for the TypeScript SDK, and it is
 * thin on purpose: every call below is one call on `ForgeBridgeClient`, and
 * every failure is classified by `describeError` — the function an embedder of
 * this package calls — rather than by a mapping written for the suite. An
 * adapter that classified errors itself would prove that this file can map
 * error codes and nothing at all about whether the SDK can.
 *
 * ── The call that is not here ────────────────────────────────────────────────
 *
 * There is no `approve`. `ForgeBridgeClient.approveChangeSet` exists — it has
 * to, because approving is a real thing a ForgeBridge client does, and a human
 * operating a script is exactly who does it — and this adapter must not be able
 * to reach it: the suite's approval arrives from `daemonHumanApproval`, a
 * separate object, precisely so that `apply-after-human-approval` proves the
 * gate opened rather than that the connector under test can open it (ADR-012).
 *
 * Leaving the call out would be enough for the suite. It is not enough for a
 * reader, so the guard is structural as well, exactly as it is in
 * `packages/sdk-python/tests/conformance_driver.py`: the client this adapter
 * builds is wired to a `fetch` that refuses any request whose URL contains
 * `/approve` before it is sent. If somebody adds an approve call here later it
 * fails loudly rather than quietly making the suite meaningless — and the last
 * `describe` block below asserts both halves of that, and that the guard does
 * *not* fire on an ordinary call.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgeBridgeError, PROTOCOL_VERSION } from '@forgebridge/protocol';
import { createDaemon, type ForgeBridgeDaemon, type ModelsPort, type RunModelClient } from '@forgebridge/daemon';
import {
  approvalCheats,
  assertConformant,
  connectStudioDouble,
  daemonHumanApproval,
  formatReport,
  runConformanceSuite,
  CONFORMANCE_CASES,
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
import { ForgeBridgeClient, OPERATION_IDS, TransportError, describeError } from '../src/index.js';

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
 * The failure is a plain `Error` rather than a classified model-client error, so
 * the core records `provider-error`: the outcome it uses for a throw it was not
 * told how to read. Deliberate — this package does not depend on
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

// ── the guard ────────────────────────────────────────────────────────────────

/** The one path this adapter refuses to send, whatever it is handed. */
export const FORBIDDEN_PATH_FRAGMENT = '/approve';

/**
 * Wrap a fetch so no approval request can leave this process.
 *
 * Exported so the last `describe` block can point it at the guard directly, and
 * so the reason it exists is one a reader can find rather than infer.
 */
export function guardedFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (String(input).includes(FORBIDDEN_PATH_FRAGMENT)) {
      throw new TransportError(
        'the conformance adapter does not make approval requests; approval is a human action taken in Roblox ' +
          'Studio or in a ForgeBridge client (ADR-012)',
      );
    }
    return await (inner as (input: unknown, init?: RequestInit) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
}

// ── the adapter ──────────────────────────────────────────────────────────────

/** Statuses that mean a human cleared this set and the daemon has it queued. */
const CLEARED = new Set(['approved', 'applying', 'applied', 'partial', 'failed']);

export function sdkAdapter(client: ForgeBridgeClient): ConnectorAdapter {
  const linkStatus = async (): Promise<ConnectorLinkStatus> => {
    const status = await client.linkStatus();
    return {
      transport: status.transport,
      // Forwarded byte for byte. The posture is one of the few strings whose
      // wording is the contract: a connector that paraphrased "the relay
      // operator can read your changes" would have told the user something false
      // about who can read their code.
      privacyPosture: status.privacyPosture,
      protocolVersion: status.protocolVersion,
      defaultProjectId: status.defaultProjectId,
      links: status.links.map((link) => ({ linkId: link.id, projectId: link.projectId, state: link.state })),
    };
  };

  const diff = async (changeSetId: string): Promise<ConnectorDiff> => {
    const rendered = await client.getDiff(changeSetId);
    return {
      changeSetId: rendered.changeSetId,
      projectId: rendered.projectId,
      status: rendered.status,
      baseVersion: rendered.baseVersion,
      currentVersion: rendered.currentVersion,
      stale: rendered.stale,
      summary: rendered.summary,
      operations: rendered.operations.map((operation) => ({
        index: operation.index,
        op: operation.op,
        summary: operation.summary,
        destructive: operation.destructive,
      })),
      counts: { total: rendered.counts.total },
      validation: rendered.validation ?? null,
      contentDigest: rendered.contentDigest,
    };
  };

  return {
    name: '@forgebridge/sdk-ts',
    linkStatus,

    /**
     * Assembled from the link status: `/v1` publishes no project list.
     *
     * `currentVersion` is left off rather than guessed. A version invented here
     * would make `propose-returns-id-and-diff` check a number nobody published —
     * the same gap the reference adapter records, and the same additive `/v1`
     * read closes both.
     */
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
     * There is no tree read on this client because `/v1` serves no tree
     * snapshot. A method that returned an empty tree would be worse than none.
     */
    async readTree(): Promise<ConnectorTree> {
      throw new ForgeBridgeError(
        'not_found',
        'this ForgeBridge SDK has no call that reads a tree snapshot',
        'Ask the user for the instance paths you need. A tree read needs a /v1 endpoint that does not exist yet (M09 owns the snapshot, M31 agrees the wire shape).',
      );
    },

    /**
     * Propose, by proposing.
     *
     * Unlike the CLI adapter — which has no propose command and maps this onto a
     * run — this SDK has the producer call itself, so the mapping is direct and
     * `claimedValidation` is forwarded *untouched*. That is the stronger answer
     * for PROTOCOL invariant 4: the suite sends a forged verdict, this connector
     * does nothing about it, and the verdict that comes back is still one the
     * core computed.
     */
    async propose(input: ProposeInput): Promise<ConnectorProposal> {
      const submitted = await client.proposeChangeSet({
        id: randomUUID(),
        projectId: input.projectId,
        baseVersion: input.baseVersion,
        summary: input.summary,
        operations: input.operations,
        ...(input.claimedValidation ? { validation: input.claimedValidation } : {}),
        createdAt: new Date().toISOString(),
      });
      return {
        changeSetId: submitted.changeSetId,
        status: submitted.status,
        validation: submitted.validation,
        diff: await diff(submitted.changeSetId),
      };
    },

    diff,

    /**
     * Report on a ChangeSet a human has already approved.
     *
     * There is no `apply` on this client and there is nothing for one to call:
     * in this protocol a producer never dispatches — the daemon does that when a
     * human approves — and what a producer can do is read the status and say
     * whether the set was cleared. So the branch table is the whole of it, and
     * it is the same one the Python driver, the MCP tool and the reference
     * adapter all use.
     *
     * The diff read first is not a formality: it is what makes an id that was
     * never proposed answer `not_found` rather than being refused by a gate for
     * a set that does not exist. And the default is a refusal — an unrecognised
     * status ends in `not_approved`, because failing closed is the only safe
     * default for the one gate standing between a model and someone's place.
     */
    async apply(changeSetId: string): Promise<ConnectorApplyReport> {
      const rendered = await client.getDiff(changeSetId);

      if (CLEARED.has(rendered.status)) {
        return {
          changeSetId,
          status: rendered.status,
          accepted: true,
          message:
            'A human approved this ChangeSet out of band and the daemon has it queued for the paired Studio session.',
        };
      }

      if (rendered.status === 'stale') {
        throw new ForgeBridgeError(
          'stale_base',
          'the place moved after this ChangeSet was built, so it can no longer be applied',
          'Rebuild the operations against the current version and propose a new ChangeSet.',
        );
      }

      throw new ForgeBridgeError(
        'not_approved',
        `changeset ${changeSetId} has not been approved (status: ${rendered.status})`,
        'Ask the user to review the diff and approve it in Roblox Studio or in their ForgeBridge client. Approval is a human action; no call on this adapter can perform it (ADR-012).',
      );
    },

    async startRun(input: RunInput): Promise<ConnectorRun> {
      const response = await client.startRun({ prompt: input.prompt, projectId: input.projectId });
      if (response.failure && response.changeSetId === null) {
        throw new ForgeBridgeError(response.failure.code, response.failure.message, response.failure.remedy);
      }
      return {
        runId: response.run.id,
        stage: response.run.stage,
        status: response.run.status,
        // Whole and in order, straight off the run response (ADR-008).
        attempts: response.run.attempts,
        changeSetIds: response.run.changeSetIds,
      };
    },

    /**
     * The advertised surface is the generated route table.
     *
     * `packages/sdk-python` declares this case `unsupported`, on the ground that
     * a library advertises no tool list. This one can answer, and the answer is
     * not a hand-written list that would go stale: `OPERATION_IDS` is projected
     * from the same OpenAPI document the client is driven by, so what this
     * connector says it can do and what it can do are the same object.
     */
    describeSurface(): ConnectorSurface {
      return {
        name: '@forgebridge/sdk-ts',
        protocolVersion: PROTOCOL_VERSION,
        operations: OPERATION_IDS.map((id) => ({ id })),
      };
    },

    /**
     * The connector's own classifier, not one written for the suite.
     *
     * `describeError` is what an embedder of this package calls, and the suite
     * feeds it every `ErrorCode` twice — once thrown, once as the JSON body the
     * daemon sends.
     */
    describeError(error: unknown): ConnectorErrorView {
      const view = describeError(error);
      return {
        code: view.code,
        recognised: view.recognised,
        // The value a caller of *this* transport branches on is the HTTP status.
        ...(view.httpStatus === undefined ? {} : { transportCode: view.httpStatus }),
        ...(view.message === undefined ? {} : { message: view.message }),
        ...(view.remedy === undefined ? {} : { remedy: view.remedy }),
      };
    },
  };
}

// ── the harness ──────────────────────────────────────────────────────────────

interface Harness {
  daemon: ForgeBridgeDaemon;
  client: ForgeBridgeClient;
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

  const client = new ForgeBridgeClient({
    baseUrl: daemon.url,
    producerToken: daemon.producerToken,
    fetch: guardedFetch(globalThis.fetch),
    // A run goes through a scripted model here, but it still goes through the
    // whole pipeline; the default would be tight enough to be flaky on a loaded
    // machine and would fail as a timeout rather than as a finding.
    timeoutMs: 60_000,
  });

  return {
    daemon,
    client,
    adapter: sdkAdapter(client),
    approve: daemonHumanApproval({ baseUrl: daemon.url, producerToken: daemon.producerToken }),
    close: () => daemon.close(),
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('@forgebridge/sdk-ts is a conformant connector', () => {
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
    // A suite that ran nothing also reports `ok`. Counted against the suite's
    // own case list rather than a number written here, so a case added to
    // `@forgebridge/conformance` is one this connector is held to.
    expect(report.results.map((result) => result.case.id).sort()).toEqual(
      CONFORMANCE_CASES.map((entry) => entry.id).sort(),
    );
  });

  it('refuses to apply what no human cleared, and the set stays unapproved', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { humanApproval: harness.approve });
    const outcome = (id: string): string | undefined =>
      report.results.find((result) => result.case.id === id)?.outcome;

    expect(outcome('apply-refused-without-approval'), formatReport(report)).toBe('pass');
    expect(outcome('apply-unknown-changeset-is-not-found')).toBe('pass');
    // And the same set applies once a human approves it, which is what makes the
    // refusal a gate rather than a call that always says no.
    expect(outcome('apply-after-human-approval')).toBe('pass');
  });

  it('records the one gap it has as unsupported, not as a failure', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { humanApproval: harness.approve });
    const unsupported = report.results
      .filter((result) => result.outcome === 'unsupported')
      .map((result) => result.case.id);

    // `tree-read` only, because `/v1` serves no tree snapshot for any connector
    // to read. `surface-portable` is answered here, unlike in the Python SDK,
    // because this connector's advertised surface is generated rather than
    // hand-listed.
    expect(unsupported).toEqual(['tree-read']);
    expect(report.ok).toBe(true);
  });

  it('forwards a producer-claimed verdict untouched, and gets the core\'s back', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, {
      humanApproval: harness.approve,
      only: ['verdict-recomputed'],
    });
    expect(report.ok, formatReport(report)).toBe(true);
  });
});

/**
 * The same three cheats every connector runs, wrapped around this adapter.
 *
 * They live in `@forgebridge/conformance` rather than here because "the suite
 * would catch this" is a claim about *this* adapter and not only about the
 * reference one. An adapter is a shim, and a shim can be thin enough to pass
 * every case while the connector behind it enforces nothing; the way to find
 * that out is to break the shim on purpose and require the report to go red.
 */
describe('the suite catches this connector skipping the approval check', () => {
  it('goes red for each cheat, and green for the one case that is not a gate on its own', async () => {
    harness = await startHarness();

    for (const cheat of approvalCheats(harness.adapter, harness.approve)) {
      const report = await runConformanceSuite(cheat.adapter, {
        humanApproval: harness.approve,
        only: [cheat.caseId, ...cheat.stillPasses],
      });

      const caught = report.results.find((result) => result.case.id === cheat.caseId);
      expect(caught?.outcome, `${cheat.name}\n${formatReport(report)}`).toBe('fail');
      expect(caught?.failures.join('\n')).toMatch(cheat.failure);
      expect(report.ok).toBe(false);

      // The instructive half: "refuses whatever it is handed" *passes*
      // `apply-refused-without-approval`, and a connector author who read only
      // that case would ship it. One case in isolation is not a gate.
      for (const id of cheat.stillPasses) {
        expect(report.results.find((result) => result.case.id === id)?.outcome, formatReport(report)).toBe('pass');
      }
    }
  });
});

describe('the adapter cannot approve, structurally and not only by omission', () => {
  it('has no approve call on the interface it implements', async () => {
    harness = await startHarness();
    expect('approve' in harness.adapter).toBe(false);
  });

  it('refuses an approval request before it is sent, even when one is asked for', async () => {
    harness = await startHarness();
    // `approveChangeSet` is a real method on the client and this is what stops
    // it here: the guard fires on the URL, before the request leaves.
    await expect(
      harness.client.approveChangeSet('11111111-1111-4111-8111-111111111111', {
        contentDigest: 'sha256:whatever',
      }),
    ).rejects.toThrow(/does not make approval requests/);
  });

  it('and does not fire on an ordinary call', async () => {
    // The control. A guard that refused everything would pass the test above and
    // make the whole suite meaningless.
    harness = await startHarness();
    const status = await harness.client.linkStatus();
    expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
