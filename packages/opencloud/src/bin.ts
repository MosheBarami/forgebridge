#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/**
 * `forgebridge-opencloud` — the three Open Cloud surfaces from a terminal.
 *
 * This is the binary M48's definition of done means by *"publish-from-CLI works
 * end to end"*. It is deliberately this package's own bin rather than a
 * subcommand of the `forgebridge` CLI: `packages/cli` is M28's, and a package
 * that can only be driven through another package's binary cannot be tested on
 * its own or adopted by anyone who does not want the rest of the toolchain.
 * Wiring `forgebridge opencloud …` through to these functions is a small,
 * separate change that belongs to whoever owns that CLI.
 *
 * Everything it prints goes to stdout as one JSON object on success and to
 * stderr as a sentence on failure, so it composes with `jq` and with a shell
 * `if`. The exit code is the contract: 0 did it, non-zero did not, and there is
 * no third state where the command reports success it could not confirm.
 *
 * The key is read from the environment and from nowhere else — not from a flag,
 * because a flag is in the shell history and in `ps`, and not from a file path
 * this package would then have to be trusted to handle.
 */
import { readFile } from 'node:fs/promises';
import { createOpenCloudClient, type OpenCloudClient } from './client.js';
import { OpenCloudError } from './errors.js';
import {
  deleteEntry,
  getEntry,
  incrementEntry,
  listDataStores,
  listEntries,
  listEntryVersions,
  setEntry,
} from './datastores.js';
import { publishMessage } from './messaging.js';
import { contentTypeForPlaceFile, publishPlaceVersion, type PlaceVersionType } from './places.js';

export const API_KEY_ENV = 'ROBLOX_OPEN_CLOUD_API_KEY';

export const USAGE = `forgebridge-opencloud — Roblox Open Cloud from a terminal

The API key is read from ${API_KEY_ENV}. It is never taken as a flag: a flag is
in your shell history and visible in \`ps\` to every process on the machine.

Usage:
  forgebridge-opencloud publish-place  --universe <id> --place <id> --file <path>
                                       --version-type Published|Saved
  forgebridge-opencloud datastore get      --universe <id> --datastore <name> --key <key> [--scope <s>]
  forgebridge-opencloud datastore set      --universe <id> --datastore <name> --key <key> --value <json>
                                           [--scope <s>] [--match-version <v>] [--exclusive-create]
  forgebridge-opencloud datastore delete   --universe <id> --datastore <name> --key <key> [--scope <s>]
  forgebridge-opencloud datastore incr     --universe <id> --datastore <name> --key <key> --by <n> [--scope <s>]
  forgebridge-opencloud datastore list     --universe <id> [--prefix <p>] [--limit <n>] [--cursor <c>]
  forgebridge-opencloud datastore entries  --universe <id> --datastore <name> [--prefix <p>] [--limit <n>]
  forgebridge-opencloud datastore versions --universe <id> --datastore <name> --key <key> [--limit <n>]
  forgebridge-opencloud message publish    --universe <id> --topic <topic> --message <text>

Options common to every subcommand:
  --base-url <url>   Override https://apis.roblox.com (must be https)
  --help             Print this and exit

There is no --dry-run. Each of these either happens or reports that it did not.
`;

export interface CommandResult {
  /** Process exit code. 0 only when the operation is confirmed done. */
  code: number;
  /** One JSON object on success, empty on failure. */
  stdout: string;
  /** A sentence on failure, empty on success. */
  stderr: string;
}

type Flags = Record<string, string | boolean>;

/**
 * Parse `--flag value` and `--flag` pairs.
 *
 * Unknown flags are an error rather than being ignored. A typo'd
 * `--exclusive-creat` that is silently dropped turns "only if absent" into
 * "overwrite whatever is there", which is the difference between a safe command
 * and a destructive one and is invisible in the output either way.
 */
export function parseFlags(argv: readonly string[], known: ReadonlySet<string>): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
    const name = token.slice(2);
    if (!known.has(name)) {
      throw new Error(`unknown option "--${name}". Run with --help for the ones this subcommand takes.`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`);
  return value;
}

function optional(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function integer(flags: Flags, name: string): number {
  const raw = required(flags, name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number (got "${raw}")`);
  return parsed;
}

const COMMON = ['base-url', 'help'];
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  'publish-place': [...COMMON, 'universe', 'place', 'file', 'version-type'],
  'datastore get': [...COMMON, 'universe', 'datastore', 'key', 'scope'],
  'datastore set': [...COMMON, 'universe', 'datastore', 'key', 'scope', 'value', 'match-version', 'exclusive-create'],
  'datastore delete': [...COMMON, 'universe', 'datastore', 'key', 'scope'],
  'datastore incr': [...COMMON, 'universe', 'datastore', 'key', 'scope', 'by'],
  'datastore list': [...COMMON, 'universe', 'prefix', 'limit', 'cursor'],
  'datastore entries': [...COMMON, 'universe', 'datastore', 'prefix', 'limit', 'cursor', 'scope'],
  'datastore versions': [...COMMON, 'universe', 'datastore', 'key', 'scope', 'limit', 'cursor'],
  'message publish': [...COMMON, 'universe', 'topic', 'message'],
};

export interface RunDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  /** Injected so the tests need no network and no key. */
  createClient?: (apiKey: string, baseUrl: string | undefined) => OpenCloudClient;
  /** Injected so the tests need no place file on disk. */
  readPlaceFile?: (path: string) => Promise<Uint8Array>;
}

export async function run(argv: readonly string[], deps: RunDependencies = {}): Promise<CommandResult> {
  const environment = deps.environment ?? process.env;
  const readPlaceFile = deps.readPlaceFile ?? (async (file: string) => new Uint8Array(await readFile(file)));
  const createClient =
    deps.createClient ??
    ((apiKey: string, baseUrl: string | undefined) =>
      createOpenCloudClient(baseUrl === undefined ? { apiKey } : { apiKey, baseUrl }));

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { code: argv.length === 0 ? 2 : 0, stdout: '', stderr: USAGE };
  }

  const head = argv[0] ?? '';
  const command = head === 'datastore' || head === 'message' ? `${head} ${argv[1] ?? ''}`.trim() : head;
  const known = KNOWN[command];
  if (known === undefined) {
    return { code: 2, stdout: '', stderr: `forgebridge-opencloud: unknown command "${command}"\n\n${USAGE}` };
  }
  const rest = argv.slice(command.includes(' ') ? 2 : 1);

  try {
    const flags = parseFlags(rest, new Set(known));

    // The key is fetched after the flags parse, so `--help` and a typo'd flag
    // are answered without requiring one. It is fetched *before* any request,
    // so a missing key fails at the door rather than as a 401 the user has to
    // interpret.
    const apiKey = environment[API_KEY_ENV];
    if (apiKey === undefined || apiKey.trim() === '') {
      return {
        code: 2,
        stdout: '',
        stderr:
          `forgebridge-opencloud: ${API_KEY_ENV} is not set. ` +
          'Create a key at https://create.roblox.com/dashboard/credentials with the scopes this subcommand needs, ' +
          'and export it in the shell you run this from.',
      };
    }

    const client = createClient(apiKey, optional(flags, 'base-url'));
    const payload = await dispatch(command, flags, client, readPlaceFile);
    return { code: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: '', stderr: `forgebridge-opencloud: ${describe(error)}\n` };
  }
}

async function dispatch(
  command: string,
  flags: Flags,
  client: OpenCloudClient,
  readPlaceFile: (path: string) => Promise<Uint8Array>,
): Promise<unknown> {
  switch (command) {
    case 'publish-place': {
      const file = required(flags, 'file');
      const versionType = required(flags, 'version-type');
      if (versionType !== 'Published' && versionType !== 'Saved') {
        throw new Error('--version-type must be Published or Saved. There is no default: one of them is live.');
      }
      const { format } = contentTypeForPlaceFile(file);
      return await publishPlaceVersion(client, {
        universeId: required(flags, 'universe'),
        placeId: required(flags, 'place'),
        file: await readPlaceFile(file),
        format,
        versionType: versionType as PlaceVersionType,
      });
    }
    case 'datastore get':
      return await getEntry(client, address(flags));
    case 'datastore set': {
      const raw = required(flags, 'value');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error('--value must be JSON. To store the literal string "x", pass \'"x"\'.');
      }
      return await setEntry(client, {
        ...address(flags),
        value,
        ...(optional(flags, 'match-version') === undefined ? {} : { matchVersion: required(flags, 'match-version') }),
        ...(flags['exclusive-create'] === undefined ? {} : { exclusiveCreate: true }),
      });
    }
    case 'datastore delete':
      await deleteEntry(client, address(flags));
      return { deleted: true };
    case 'datastore incr':
      return await incrementEntry(client, { ...address(flags), incrementBy: integer(flags, 'by') });
    case 'datastore list':
      return await listDataStores(client, {
        universeId: required(flags, 'universe'),
        ...(optional(flags, 'prefix') === undefined ? {} : { prefix: required(flags, 'prefix') }),
        ...(optional(flags, 'limit') === undefined ? {} : { limit: integer(flags, 'limit') }),
        ...(optional(flags, 'cursor') === undefined ? {} : { cursor: required(flags, 'cursor') }),
      });
    case 'datastore entries':
      return await listEntries(client, {
        universeId: required(flags, 'universe'),
        dataStoreName: required(flags, 'datastore'),
        ...(optional(flags, 'scope') === undefined ? {} : { dataStoreScope: required(flags, 'scope') }),
        ...(optional(flags, 'prefix') === undefined ? {} : { prefix: required(flags, 'prefix') }),
        ...(optional(flags, 'limit') === undefined ? {} : { limit: integer(flags, 'limit') }),
        ...(optional(flags, 'cursor') === undefined ? {} : { cursor: required(flags, 'cursor') }),
      });
    case 'datastore versions':
      return await listEntryVersions(client, {
        ...address(flags),
        ...(optional(flags, 'limit') === undefined ? {} : { limit: integer(flags, 'limit') }),
        ...(optional(flags, 'cursor') === undefined ? {} : { cursor: required(flags, 'cursor') }),
      });
    case 'message publish':
      await publishMessage(client, {
        universeId: required(flags, 'universe'),
        topic: required(flags, 'topic'),
        message: required(flags, 'message'),
      });
      return { published: true, topic: required(flags, 'topic') };
    /* c8 ignore next 2 -- unreachable: `command` was looked up in KNOWN above. */
    default:
      throw new Error(`unhandled command "${command}"`);
  }
}

function address(flags: Flags): {
  universeId: string;
  dataStoreName: string;
  entryKey: string;
  dataStoreScope?: string;
} {
  const base = {
    universeId: required(flags, 'universe'),
    dataStoreName: required(flags, 'datastore'),
    entryKey: required(flags, 'key'),
  };
  const dataStoreScope = optional(flags, 'scope');
  return dataStoreScope === undefined ? base : { ...base, dataStoreScope };
}

/**
 * Render an error for a terminal.
 *
 * `OpenCloudError` already formats itself without the credential; anything else
 * contributes its message only. A raw `Error` object stringified with its stack
 * is how an environment variable ends up in a CI log, so nothing here reaches
 * for `.stack`.
 */
export function describe(error: unknown): string {
  if (error instanceof OpenCloudError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/* c8 ignore start -- the process shim; `run` above is what the tests drive. */
// Compared as REAL paths. `npm` installs a bin as a symlink under
// `node_modules/.bin/`, so launching `forgebridge-opencloud` — the only name the
// README ever gives — sets argv[1] to the symlink while `import.meta.url` is the
// resolved target. Comparing the two directly made the guard false for exactly
// the invocation the docs tell people to use, and the CLI printed nothing.
const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    // An unresolvable path is not this module; refusing to run is the safe
    // answer, since the alternative is a CLI that executes on a mismatch.
    return false;
  }
})();

if (invokedDirectly) {
  const result = await run(process.argv.slice(2));
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
/* c8 ignore stop */
