import type { ProjectPolicy } from '@forgebridge/core';
import { createDaemon, type ForgeBridgeDaemon } from '@forgebridge/daemon';
import type { ConformanceOptions, HumanApproval } from '../src/adapter.js';
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
export async function startHarness(): Promise<Harness> {
  // Port 0: the fixed default is a production concern, and binding it would
  // make this suite fight a daemon the developer already has running.
  const daemon = createDaemon({ port: 0, policy: TEST_POLICY });
  await daemon.listen();
  const baseUrl = daemon.url;

  const { code } = daemon.issuePairingCode();
  const studio = await connectStudioDouble({ baseUrl, pairingCode: code });

  const adapter = new DaemonRestAdapter({ baseUrl, producerToken: daemon.producerToken });
  const approval = daemonHumanApproval({ baseUrl, producerToken: daemon.producerToken });

  return {
    daemon,
    baseUrl,
    adapter,
    approval,
    studio,
    options: { humanApproval: approval },
    async close() {
      await daemon.close();
    },
  };
}
