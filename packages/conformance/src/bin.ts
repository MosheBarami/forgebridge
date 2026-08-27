#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCER_TOKEN_ENV } from '@forgebridge/daemon';
import type { ConformanceOptions } from './adapter.js';
import { formatReport } from './report.js';
import { CASE_IDS, runConformanceSuite } from './suite.js';
import { DaemonRestAdapter } from './reference/daemon-adapter.js';
import { connectStudioDouble, daemonHumanApproval } from './reference/harness.js';

/**
 * `forgebridge-conformance` — run the suite against a daemon that is already
 * running, using the reference adapter.
 *
 * A binary rather than only a library function, because "the connectors are
 * conformant" should be checkable by whoever is holding the machine and not
 * only inside this repository's own test run.
 *
 * Three flags reach past a read, and all three are opt-in because this command
 * can be pointed at a real place: `--approve` records a real approval for the
 * fixture ChangeSet, which a paired Studio session will then apply, `--pair`
 * attaches a stand-in consumer to a link, and `--run` starts a real run, which
 * calls a language model and spends whatever that costs. Without them the suite
 * only proposes — which changes nothing in the place and costs nothing — and
 * reports the apply-after-approval and run cases as unsupported.
 */

const USAGE = [
  'forgebridge-conformance — run the connector conformance suite against a live daemon',
  '',
  '  --daemon <url>      daemon base URL (default http://127.0.0.1:7317)',
  '  --token <token>     the producer token the daemon printed at startup',
  `                      (or the ${PRODUCER_TOKEN_ENV} environment variable)`,
  '  --project <uuid>    project to run against (default: the daemon own default)',
  '  --base-version <n>  the version the fixture is built on (default 0)',
  '  --only <ids>        comma-separated case ids to run',
  '  --pair <code>       pair a stand-in Studio consumer with this pairing code.',
  '                      Needed only when no real Studio session is paired: the',
  '                      daemon will not approve a set it could never deliver.',
  '  --approve           WRITES. Perform the out-of-band human approval, so the',
  '                      apply-after-approval case can run. A paired Studio',
  '                      session will apply the fixture ChangeSet for real.',
  '  --run               SPENDS. Start a real run, so the run case can check the',
  '                      attempt list. This calls a language model through the',
  '                      daemon and costs whatever that provider charges.',
  '  --json              print the report as JSON instead of as text',
  '  --list              list the case ids and exit',
  '  --help',
  '',
  'Exit code 1 when any case fails. An unsupported case is a gap, not a failure.',
].join('\n');

export interface Flags {
  daemon: string;
  token: string | null;
  project: string | null;
  baseVersion: number | null;
  only: string[] | null;
  pair: string | null;
  approve: boolean;
  run: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Flags {
  const flags: Flags = {
    daemon: 'http://127.0.0.1:7317',
    token: env[PRODUCER_TOKEN_ENV] ?? null,
    project: null,
    baseVersion: null,
    only: null,
    pair: null,
    approve: false,
    run: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case '--daemon':
        flags.daemon = next();
        break;
      case '--token':
        flags.token = next();
        break;
      case '--project':
        flags.project = next();
        break;
      case '--base-version':
        flags.baseVersion = Number.parseInt(next(), 10);
        break;
      case '--only':
        flags.only = next()
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        break;
      case '--pair':
        flags.pair = next();
        break;
      case '--approve':
        flags.approve = true;
        break;
      case '--run':
        flags.run = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--help':
      case '-h':
      case '--list':
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (flags.baseVersion !== null && !Number.isInteger(flags.baseVersion)) {
    throw new Error('--base-version must be a whole number');
  }
  return flags;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (argv.includes('--list')) {
    process.stdout.write(`${CASE_IDS.join('\n')}\n`);
    return 0;
  }

  const flags = parseArgs(argv, env);
  if (!flags.token) {
    process.stderr.write(
      `forgebridge-conformance: no producer token. Pass --token, or set ${PRODUCER_TOKEN_ENV}. Producer routes refuse a request without one, because loopback is not an authentication boundary.\n`,
    );
    return 2;
  }

  const adapter = new DaemonRestAdapter({ baseUrl: flags.daemon, producerToken: flags.token, runs: flags.run });

  if (flags.pair) {
    const studio = await connectStudioDouble({ baseUrl: flags.daemon, pairingCode: flags.pair });
    process.stderr.write(`paired a stand-in Studio consumer: link ${studio.linkId} on project ${studio.projectId}\n`);
  }

  if (flags.approve) {
    process.stderr.write(
      'note: --approve records a real approval for the fixture ChangeSet. A paired Studio session will apply it.\n',
    );
  }

  if (flags.run) {
    process.stderr.write(
      'note: --run starts a real run. The daemon will call a language model, and whatever that costs is charged to whoever configured it.\n',
    );
  }

  const options: ConformanceOptions = {
    ...(flags.project ? { projectId: flags.project } : {}),
    ...(flags.baseVersion !== null ? { baseVersion: flags.baseVersion } : {}),
    ...(flags.only ? { only: flags.only } : {}),
    ...(flags.approve
      ? { humanApproval: daemonHumanApproval({ baseUrl: flags.daemon, producerToken: flags.token }) }
      : {}),
  };

  const report = await runConformanceSuite(adapter, options);
  process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  return report.ok ? 0 : 1;
}

/**
 * Only run when this file was executed, not when it was imported. Same guard as
 * `packages/mcp/src/bin.ts` and `packages/daemon/src/bin.ts`.
 */
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // The message is the operator's to act on — a wrong flag, an unreachable
      // daemon — so it is printed as-is rather than swallowed into a generic.
      process.stderr.write(`forgebridge-conformance: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
