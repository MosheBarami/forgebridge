#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProjectPolicy } from '@forgebridge/core';
import { InstancePath, PAIRING } from '@forgebridge/protocol';
import { PRODUCER_TOKEN_ENV, PRODUCER_TOKEN_HEADER } from './auth.js';
import { CatalogModels } from './models.js';
import { OPENROUTER_SECRET_REF, OpenRouterClient } from './openrouter.js';
import { defaultSecrets } from './secrets.js';
import { DEFAULT_DAEMON_PORT, createDaemon, type DaemonLogger } from './server.js';

/**
 * `forgebridge-daemon` — the local transport, run directly.
 *
 * Everything it prints goes to stderr so that stdout stays free for a future
 * machine-readable mode; the one thing a user must read (the pairing code) is
 * printed once, on the terminal they started it from, and never served over
 * HTTP or written to a log file.
 */

export interface Args {
  port: number;
  projectId: string;
  allowedOrigins: string[];
  allowedPaths: string[];
  help: boolean;
  version: boolean;
}

const USAGE = `forgebridge-daemon — the ForgeBridge local transport

Binds 127.0.0.1 only. No cloud, no account, nothing leaves this machine.

Usage:
  forgebridge-daemon [options]

Options:
  --port <n>            Port to bind (default ${DEFAULT_DAEMON_PORT})
  --project <uuid>      Project id links and changesets default to
  --allow-path <path>   Instance path a ChangeSet may write to, itself or
                        beneath, e.g. ServerScriptService.Shop (repeatable).
                        Without at least one, every ChangeSet is refused.
  --allow-origin <url>  Permit a browser origin to call the daemon (repeatable)
  --version             Print the protocol version and exit
  --help                Print this and exit
`;

/**
 * A project id has to be a uuid because `Link.parse` says so, and a link is
 * parsed on the first pair — long after the process started. Accepting any
 * non-empty string here turned "--project my-game" into a daemon that starts,
 * looks healthy, and then answers the first pairing attempt with a bare 500 out
 * of a ZodError nobody can see. Bad input fails at the boundary it arrived on.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    port: DEFAULT_DAEMON_PORT,
    projectId: randomUUID(),
    allowedOrigins: [],
    allowedPaths: [],
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
        args.version = true;
        break;
      case '--port': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1 || value > 65_535) {
          throw new Error('--port must be an integer between 1 and 65535');
        }
        args.port = value;
        break;
      }
      case '--project': {
        const value = argv[++i];
        if (!value) throw new Error('--project requires a uuid');
        if (!UUID.test(value)) {
          throw new Error(`--project must be a uuid, e.g. ${randomUUID()} (got "${value}")`);
        }
        args.projectId = value;
        break;
      }
      case '--allow-path': {
        const value = argv[++i];
        if (!value) throw new Error('--allow-path requires an instance path, e.g. ServerScriptService.Shop');
        const parsed = InstancePath.safeParse(value);
        if (!parsed.success) {
          // A prefix that parses as nothing matches nothing, which looks
          // exactly like a policy that is working. Refuse it at the door.
          throw new Error(
            `--allow-path "${value}" is not a valid instance path: ${parsed.error.issues[0]?.message ?? 'rejected'}`,
          );
        }
        args.allowedPaths.push(value);
        break;
      }
      case '--allow-origin': {
        const value = argv[++i];
        if (!value) throw new Error('--allow-origin requires an origin, e.g. http://localhost:3000');
        args.allowedOrigins.push(value);
        break;
      }
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }

  return args;
}

const consoleLogger: DaemonLogger = {
  info: (message, fields) => process.stderr.write(format('info', message, fields)),
  warn: (message, fields) => process.stderr.write(format('warn', message, fields)),
  error: (message, fields) => process.stderr.write(format('error', message, fields)),
};

function format(level: string, message: string, fields?: Record<string, unknown>): string {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `[${new Date().toISOString()}] ${level} ${message}${suffix}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stderr.write(USAGE);
    return;
  }
  if (args.version) {
    const { PROTOCOL_VERSION } = await import('@forgebridge/protocol');
    const { DAEMON_VERSION } = await import('./server.js');
    process.stderr.write(`forgebridge-daemon ${DAEMON_VERSION} (protocol ${PROTOCOL_VERSION})\n`);
    return;
  }

  const policy: ProjectPolicy = { allowedPathPrefixes: args.allowedPaths, autoApply: null };

  // The composition root, and the only place the three of these meet. The
  // daemon library holds a `ModelsPort` and a `RunModelClient` and knows what
  // neither of them is made of — which is what keeps the catalog out of the
  // transport (`wire.ts`) and the vendor out of the engine (ADR-005).
  const secrets = defaultSecrets();
  const models = new CatalogModels();
  const modelClient = new OpenRouterClient({ secrets });

  const daemon = createDaemon({
    port: args.port,
    projectId: args.projectId,
    allowedOrigins: args.allowedOrigins,
    policy,
    models,
    modelClient,
    // An operator who exports the token can hand the same value to a client it
    // launches; otherwise the daemon mints one and prints it below.
    ...(process.env[PRODUCER_TOKEN_ENV] ? { producerToken: process.env[PRODUCER_TOKEN_ENV] } : {}),
    logger: consoleLogger,
  });

  const bound = await daemon.listen();
  const pairing = daemon.issuePairingCode();

  // Whether a credential was found, never what it is. `describe()` names the
  // backend that answered so a user reading this line knows where the daemon
  // looked — and is told plainly when that place is one any process they run
  // can read (ADR-006).
  const backend = secrets.describe();
  const configured = (await secrets.get(OPENROUTER_SECRET_REF)) !== null;
  const snapshot = await models.snapshot();

  process.stderr.write(
    [
      '',
      `  ForgeBridge daemon listening on ${bound.url}`,
      '  Local — nothing leaves this machine.',
      '',
      `  Pairing code: ${pairing.code}`,
      `  Valid for ${PAIRING.TTL_SECONDS / 60} minutes, ${PAIRING.MAX_ATTEMPTS} attempts, single use.`,
      '',
      // Printed here, once, for the same reason the pairing code is: it is a
      // secret the human carries from this terminal to the thing that needs it,
      // and it is never served over HTTP or written to a log.
      `  Producer token: ${daemon.producerToken}`,
      `  Send it as ${PRODUCER_TOKEN_HEADER} on submit, approve, diff, rollback and console reads.`,
      '',
      `  Project: ${args.projectId}`,
      args.allowedPaths.length > 0
        ? `  Writable paths: ${args.allowedPaths.join(', ')}`
        : '  Writable paths: none — every ChangeSet will be refused. Pass --allow-path <InstancePath>.',
      '',
      `  Models: ${snapshot.models.length} from ${snapshot.source}`,
      configured
        ? `  Provider key: found in ${backend.label}` +
          (backend.readableByOtherProcesses
            ? ' — readable by any process running as you; the OS keychain is not.'
            : '.')
        : '  Provider key: none found, so POST /v1/runs will refuse. Export OPENROUTER_API_KEY, or add it' +
          ' to your keychain: security add-generic-password -U -s forgebridge.provider -a openrouter -w',
      '',
    ].join('\n'),
  );

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    process.stderr.write(`\n${signal} received, closing\n`);
    void daemon.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Only start a daemon when this file was run, not when it was imported — the
 * argument parser above is testable, and importing it must not open a socket.
 * Same guard as `scripts/verify-boundaries.ts`.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
