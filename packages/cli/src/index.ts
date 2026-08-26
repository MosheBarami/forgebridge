import { PROTOCOL_VERSION } from '@forgebridge/protocol';
import { DaemonClient, type Transport } from './client.js';
import { CLI_VERSION } from './version.js';
import type { GlobalOptions, Invocation } from './args.js';
import { EXIT, type ExitCode } from './exit.js';
import { helpFor } from './help.js';
import type { Io } from './output.js';
import type { Deps } from './commands/context.js';
import { applyCommand } from './commands/apply.js';
import { daemonCommand } from './commands/daemon.js';
import { diffCommand } from './commands/diff.js';
import { linkCommand } from './commands/link.js';
import { modelsCommand } from './commands/models.js';
import { rollbackCommand } from './commands/rollback.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';

export { CLI_VERSION };
export * from './args.js';
export * from './exit.js';
export * from './posture.js';
export * from './output.js';
export * from './client.js';

/**
 * The dispatcher.
 *
 * Every command returns an exit code rather than calling `process.exit`, so the
 * whole surface is drivable from a test with a stub transport and a captured
 * `Io`. `bin.ts` is the only file in this package that knows a process exists.
 */
export async function dispatch(invocation: Invocation, deps: Deps): Promise<ExitCode> {
  switch (invocation.command) {
    case 'help':
      deps.io.out(helpFor(invocation.topic));
      return EXIT.OK;
    case 'version':
      deps.io.out(`forgebridge ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`);
      return EXIT.OK;
    case 'daemon':
      return daemonCommand(invocation, deps);
    case 'link':
      return linkCommand(invocation, deps);
    case 'status':
      return statusCommand(invocation, deps);
    case 'models':
      return modelsCommand(invocation, deps);
    case 'run':
      return runCommand(invocation, deps);
    case 'diff':
      return diffCommand(invocation, deps);
    case 'apply':
      return applyCommand(invocation, deps);
    case 'rollback':
      return rollbackCommand(invocation, deps);
  }
}

/** The default transport factory: one real HTTP client per invocation. */
export function createTransport(global: GlobalOptions): Transport {
  return new DaemonClient({ baseUrl: global.baseUrl, token: global.token });
}

export function defaultDeps(io: Io): Deps {
  return {
    io,
    createTransport,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
