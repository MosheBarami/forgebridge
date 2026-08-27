import type { ProjectPolicy } from '@forgebridge/core';
import { createDaemon, type ForgeBridgeDaemon, type ModelsPort, type RunModelClient } from '@forgebridge/daemon';
import type { ConformanceOptions, HumanApproval, RunExpectation } from '../src/adapter.js';
import { DaemonRestAdapter } from '../src/reference/daemon-adapter.js';
import { connectStudioDouble, daemonHumanApproval, type StudioDouble } from '../src/reference/harness.js';

/**
 * The path policy these runs happen under.
 *
 * Written out rather than defaulted away: the daemon's own default is deny-all,
 * so a suite that named no writable paths would be exercising a daemon that
 * refuses the fixture on policy — and `apply-after-human-approval` would report
 * `unsupported` for a reason that has nothing to do with the connector.
 */
export const TEST_POLICY: ProjectPolicy = {
  allowedPathPrefixes: ['Workspace', 'ServerScriptService', 'ReplicatedStorage'],
  autoApply: null,
};

/**
 * Two models, the first of which is down.
 *
 * Every run this harness makes therefore has a real fallback in it, which is
 * what `run-reports-every-attempt` needs: a one-attempt list and a list
 * truncated to the model that answered look identical (ADR-008), so a run that
 * never fell back cannot tell the case anything.
 */
export const DOWN_MODEL = 'conformance/down';
export const UP_MODEL = 'conformance/up';

/** What the router was scripted to do, for the suite to hold the run against. */
export const EXPECTED_ATTEMPTS: readonly RunExpectation[] = [
  // A plain `Error` rather than a classified provider failure, so the core
  // records `provider-error`: the outcome it uses for a throw it was not told
  // how to read.
  { modelId: DOWN_MODEL, outcome: 'provider-error' },
  { modelId: UP_MODEL, outcome: 'ok' },
];

/** The draft the working model writes. Inside the policy above, so it validates. */
const DRAFT = JSON.stringify({
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

  async configured(): Promise<boolean> {
    return true;
  }

  async complete(request: { model: { id: string } }): Promise<unknown> {
    if (request.model.id === DOWN_MODEL) throw new Error('scripted: this model is not answering');
    return {
      text: DRAFT,
      finishReason: 'stop',
      usage: { promptTokens: 40, completionTokens: 80, costUsd: 0 },
    };
  }
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

export interface Harness {
  daemon: ForgeBridgeDaemon;
  baseUrl: string;
  adapter: DaemonRestAdapter;
  approval: HumanApproval;
  studio: StudioDouble;
  options: ConformanceOptions;
  close(): Promise<void>;
}

/**
 * A live daemon, a paired Studio double, and the reference adapter pointed at
 * it — the closest thing to a real deployment that fits in a test file.
 *
 * The Studio double is not decoration: the daemon refuses to approve a set for
 * a project with no paired link, because an approval that could never be
 * delivered is a lie told to the approver. Without something on the consumer
 * end, the one case that proves the approval gate opens could not run.
 */
export async function startHarness(options: { producerToken?: string } = {}): Promise<Harness> {
  // Port 0: the fixed default is a production concern, and binding it would
  // make this suite fight a daemon the developer already has running.
  //
  // The models are scripted rather than real for the reason the run case
  // states: without knowing what the router *was made to do*, the suite can
  // check the shape and order of the attempt list but not its completeness.
  //
  // `producerToken` is normally left to the daemon to mint. It is settable here
  // for one test: a minted token is base64url, so about one in sixty-four
  // begins with `-`, and a caller that puts one in an argv as `--token VALUE`
  // has argparse read it as another option. See the leading-dash test in
  // `python-sdk.test.ts`.
  const daemon = createDaemon({
    port: 0,
    policy: TEST_POLICY,
    models: modelsPort(),
    modelClient: new ScriptedModels(),
    ...(options.producerToken === undefined ? {} : { producerToken: options.producerToken }),
  });
  await daemon.listen();
  const baseUrl = daemon.url;

  const { code } = daemon.issuePairingCode();
  const studio = await connectStudioDouble({ baseUrl, pairingCode: code });

  // `runs: true` because this daemon's models are scripted and cost nothing.
  // The default is off, and stays off in `forgebridge-conformance` unless the
  // operator passes `--run`, because there the model is somebody's real one.
  const adapter = new DaemonRestAdapter({ baseUrl, producerToken: daemon.producerToken, runs: true });
  const approval = daemonHumanApproval({ baseUrl, producerToken: daemon.producerToken });

  return {
    daemon,
    baseUrl,
    adapter,
    approval,
    studio,
    options: { humanApproval: approval, run: { expectedAttempts: [...EXPECTED_ATTEMPTS] } },
    async close() {
      await daemon.close();
    },
  };
}
