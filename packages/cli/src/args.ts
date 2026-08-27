import { parseArgs, type ParseArgsConfig } from 'node:util';
import { normaliseHost } from '@forgebridge/luau-analysis';
import { InstancePath } from '@forgebridge/protocol';
import { DEFAULT_DAEMON_PORT, MAX_RUN_ATTEMPTS, ROUTING_POLICIES, type RoutingPolicyName } from '@forgebridge/daemon';
import { usageError } from './exit.js';

/**
 * The command line, parsed.
 *
 * ── Why there is no CLI framework here ───────────────────────────────────────
 *
 * `node:util`'s `parseArgs` is in the standard library, and this surface is
 * eight commands with at most four options each. A framework would earn its
 * place if this had nested subcommand trees, shell completions, or interactive
 * prompts; it has none of those, and it is a package whose whole job is to be a
 * thin translator (ADR-009). The cost of the dependency is not the install — it
 * is that every consumer of `@forgebridge/cli` inherits its supply chain, on a
 * binary whose other job is holding a producer token. `parseArgs` throws on
 * unknown options and missing values, which is the only behaviour actually
 * needed, and the mapping from its errors to exit code 2 is below.
 *
 * Validation is deliberately eager: a bad uuid, an out-of-range port or an
 * unparseable instance path is refused here, before any request. The daemon
 * would refuse them too, but as a 404 or a 400 after a round trip — and a
 * malformed `--allow-path` that reaches a policy is a prefix matching nothing,
 * which looks exactly like a policy that is working.
 */

export const COMMANDS = ['daemon', 'link', 'models', 'run', 'diff', 'apply', 'rollback', 'status'] as const;
export type Command = (typeof COMMANDS)[number];

export const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;

/** Where the base address comes from when `--url` is absent. */
export const BASE_URL_ENV = 'FORGEBRIDGE_DAEMON_URL';

/**
 * Where the producer token comes from when `--token` is absent.
 *
 * The same variable `@forgebridge/daemon` reads, so a daemon and a CLI started
 * from one shell share a token without either writing it down. It is never
 * persisted by this package: a token on disk is a token in a backup.
 */
export const TOKEN_ENV = 'FORGEBRIDGE_PRODUCER_TOKEN';

/** How long `apply` waits for a consumer to report, when the caller says nothing. */
export const DEFAULT_APPLY_TIMEOUT_SECONDS = 120;

export interface GlobalOptions {
  json: boolean;
  baseUrl: string;
  token: string | undefined;
}

export type Invocation =
  | { command: 'help'; topic: Command | null }
  | { command: 'version' }
  | {
      command: 'daemon';
      global: GlobalOptions;
      port: number;
      projectId: string | null;
      allowPaths: string[];
      allowOrigins: string[];
      allowHttpHosts: string[];
    }
  | { command: 'link'; global: GlobalOptions; code: string | null }
  | { command: 'models'; global: GlobalOptions; free: boolean; capabilities: string[] }
  | {
      command: 'run';
      global: GlobalOptions;
      prompt: string;
      projectId: string | null;
      /** Null means "whatever the transport defaults to", which is `free-first`. */
      policy: RoutingPolicyName | null;
      pinnedModel: string | null;
      baseVersion: number | null;
      maxAttempts: number | null;
      /** Print every attempt in full rather than the collapsed one-liner. */
      verbose: boolean;
    }
  | { command: 'diff'; global: GlobalOptions; changeSetId: string }
  | { command: 'apply'; global: GlobalOptions; changeSetId: string; timeoutSeconds: number }
  | { command: 'rollback'; global: GlobalOptions; journalId: string; expectedVersion: number; reason: string | null }
  | { command: 'status'; global: GlobalOptions };

/**
 * The same shape `@forgebridge/daemon` enforces on `--project`, for the same
 * reason: ids in this protocol are uuids by schema (`ChangeSet.id`,
 * `JournalEntry.id`, `Link.projectId`), and a non-uuid accepted here becomes a
 * 404 from a route that never had a chance of matching.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The bound `Run.prompt` carries in the frozen protocol. */
const MAX_PROMPT_CHARS = 50_000;

/**
 * Single-valued flags are declared `multiple: true` and then held to exactly
 * one by `stringOrNull`.
 *
 * Without `multiple`, `parseArgs` silently keeps the last occurrence, so
 * `--url a --url b` would pick one and say nothing. On a flag that decides
 * which machine a ChangeSet is sent to, quietly picking is worse than refusing
 * — so the parser is asked to collect every occurrence precisely in order to
 * notice that there was more than one.
 */
const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  url: { type: 'string', multiple: true },
  token: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

type ParsedValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/**
 * `parseArgs`, with its failures translated into usage errors.
 *
 * Its messages already name the offending flag; wrapping them keeps that text
 * and attaches the exit code, so an unknown option and a missing value both
 * leave with 2 rather than with an uncaught `TypeError` and a stack trace.
 */
function parse(argv: readonly string[], options: ParseArgsConfig['options'], allowPositionals: boolean): {
  values: ParsedValues;
  positionals: string[];
} {
  try {
    const result = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals,
      strict: true,
    });
    return { values: result.values as ParsedValues, positionals: [...result.positionals] };
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error), 'Run `forgebridge --help`.');
  }
}

function globalsFrom(values: ParsedValues, env: NodeJS.ProcessEnv): GlobalOptions {
  const url = stringOrNull(values['url'], '--url') ?? env[BASE_URL_ENV] ?? DEFAULT_BASE_URL;
  assertAbsoluteHttpUrl(url);
  return {
    json: values['json'] === true,
    baseUrl: url,
    token: stringOrNull(values['token'], '--token') ?? env[TOKEN_ENV],
  };
}

/** Exactly one occurrence of a single-valued flag, or a refusal naming it. */
function stringOrNull(value: string | boolean | (string | boolean)[] | undefined, flag: string): string | null {
  if (value === undefined) return null;
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 1) throw usageError(`${flag} was given more than once`);
  const only = values[0];
  if (typeof only !== 'string') throw usageError(`${flag} requires a value`);
  if (only.length === 0) throw usageError(`${flag} requires a non-empty value`);
  return only;
}

function stringList(value: string | boolean | (string | boolean)[] | undefined, flag: string): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) throw usageError(`${flag} requires a non-empty value`);
    return entry;
  });
}

function assertAbsoluteHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError(`--url must be an absolute URL, e.g. ${DEFAULT_BASE_URL} (got "${value}")`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw usageError(`--url must be http or https (got "${parsed.protocol.replace(':', '')}")`);
  }
}

function integerIn(raw: string, flag: string, min: number, max: number): number {
  // `Number` on "" is 0 and on "12abc" is NaN; the explicit digit test keeps
  // "--port 80x" from becoming a confusing NaN message instead of a clear one.
  if (!/^-?\d+$/.test(raw)) throw usageError(`${flag} must be an integer (got "${raw}")`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usageError(`${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function requireUuid(raw: string | undefined, what: string): string {
  if (raw === undefined || raw.length === 0) throw usageError(`${what} is required`);
  if (!UUID.test(raw)) throw usageError(`${what} must be a uuid (got "${raw}")`);
  return raw;
}

function requireExactlyOnePositional(positionals: readonly string[], what: string): string {
  const [first, ...extra] = positionals;
  if (first === undefined) throw usageError(`${what} is required`);
  if (extra.length > 0) throw usageError(`expected one ${what}, got ${positionals.length}: ${positionals.join(' ')}`);
  return first;
}

export function parseInvocation(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Invocation {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const topic = rest[0];
    if (topic !== undefined && !isCommand(topic)) throw usageError(`unknown command: ${topic}`);
    return { command: 'help', topic: topic === undefined ? null : topic };
  }
  if (first === '--version' || first === '-V') return { command: 'version' };

  if (!isCommand(first)) {
    throw usageError(`unknown command: ${first}`, `Known commands: ${COMMANDS.join(', ')}.`);
  }

  // `--help` after a command is help *for that command*, which is what someone
  // types when they already know the command and not the flags.
  if (rest.includes('--help') || rest.includes('-h')) return { command: 'help', topic: first };

  switch (first) {
    case 'daemon':
      return parseDaemon(rest, env);
    case 'link':
      return parseLink(rest, env);
    case 'models':
      return parseModels(rest, env);
    case 'run':
      return parseRun(rest, env);
    case 'diff':
      return parseDiff(rest, env);
    case 'apply':
      return parseApply(rest, env);
    case 'rollback':
      return parseRollback(rest, env);
    case 'status':
      return parseStatus(rest, env);
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function parseDaemon(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(
    argv,
    {
      port: { type: 'string', multiple: true },
      project: { type: 'string', multiple: true },
      'allow-path': { type: 'string', multiple: true },
      'allow-origin': { type: 'string', multiple: true },
      'allow-http-host': { type: 'string', multiple: true },
    },
    true,
  );
  rejectPositionals(positionals, 'daemon');

  const portRaw = stringOrNull(values['port'], '--port');
  const projectRaw = stringOrNull(values['project'], '--project');

  const allowPaths = stringList(values['allow-path'], '--allow-path');
  for (const path of allowPaths) {
    const parsed = InstancePath.safeParse(path);
    if (!parsed.success) {
      // A prefix that parses as nothing matches nothing, which is
      // indistinguishable from a policy that is working. Refuse it at the door,
      // exactly as `forgebridge-daemon` does.
      throw usageError(
        `--allow-path "${path}" is not a valid instance path: ${parsed.error.issues[0]?.message ?? 'rejected'}`,
        'Paths look like ServerScriptService.Shop — dot-separated identifiers under an addressable service root.',
      );
    }
  }

  // Normalised here rather than in the daemon so that `--allow-http-host
  // https://api.example.com/v1` and `api.example.com` are the same allowlist
  // entry, and so a host with a scheme, a port or a path on it does not silently
  // match nothing. The function is the analyser's own, so the comparison in the
  // rule and the value typed on the command line cannot drift apart.
  const allowHttpHosts = stringList(values['allow-http-host'], '--allow-http-host').map((host) => {
    const normalised = normaliseHost(host);
    if (normalised.length === 0) {
      throw usageError(
        `--allow-http-host "${host}" names no host`,
        'Hosts look like api.example.com, or *.example.com for a subdomain wildcard.',
      );
    }
    return normalised;
  });

  return {
    command: 'daemon',
    global: globalsFrom(values, env),
    port: portRaw === null ? DEFAULT_DAEMON_PORT : integerIn(portRaw, '--port', 1, 65_535),
    projectId: projectRaw === null ? null : requireUuid(projectRaw, '--project'),
    allowPaths,
    allowOrigins: stringList(values['allow-origin'], '--allow-origin'),
    allowHttpHosts,
  };
}

function parseLink(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(argv, { code: { type: 'string', multiple: true } }, true);
  rejectPositionals(positionals, 'link');
  return { command: 'link', global: globalsFrom(values, env), code: stringOrNull(values['code'], '--code') };
}

function parseModels(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(
    argv,
    { free: { type: 'boolean' }, caps: { type: 'string', multiple: true } },
    true,
  );
  rejectPositionals(positionals, 'models');

  // `--caps tools,vision` and `--caps tools --caps vision` mean the same thing.
  // Both spellings turn up in scripts, and refusing one is a papercut with no
  // safety argument behind it.
  const capabilities = stringList(values['caps'], '--caps')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const capability of capabilities) {
    // Shape only. The closed `Capability` enum lives in `@forgebridge/model-registry`,
    // which this package deliberately does not depend on — the daemon serves the
    // catalog through a port, and a connector holding its own copy of the enum
    // would go stale the first time the registry gains one. An unrecognised
    // capability filters to nothing, and `models` says which ones the snapshot
    // actually carries.
    if (!/^[a-z][a-z0-9_]*$/.test(capability)) {
      throw usageError(`--caps entries are lowercase tokens like "tools" or "structured_outputs" (got "${capability}")`);
    }
  }

  return { command: 'models', global: globalsFrom(values, env), free: values['free'] === true, capabilities };
}

function parseRun(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(
    argv,
    {
      project: { type: 'string', multiple: true },
      policy: { type: 'string', multiple: true },
      model: { type: 'string', multiple: true },
      'base-version': { type: 'string', multiple: true },
      'max-attempts': { type: 'string', multiple: true },
      verbose: { type: 'boolean' },
    },
    true,
  );
  const prompt = requireExactlyOnePositional(positionals, 'a prompt');
  if (prompt.trim().length === 0) throw usageError('the prompt is empty');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw usageError(`the prompt is ${prompt.length} characters; the protocol caps Run.prompt at ${MAX_PROMPT_CHARS}`);
  }

  const policyRaw = stringOrNull(values['policy'], '--policy');
  if (policyRaw !== null && !(ROUTING_POLICIES as readonly string[]).includes(policyRaw)) {
    throw usageError(
      `--policy must be one of ${ROUTING_POLICIES.join(', ')} (got "${policyRaw}")`,
      'These are the routing policies @forgebridge/core implements; the transport refuses anything else.',
    );
  }
  const policy = policyRaw === null ? null : (policyRaw as RoutingPolicyName);
  const pinnedModel = stringOrNull(values['model'], '--model');

  // `pinned` and `--model` are one decision spelled two ways, so the two ways
  // are held to agreeing. A `--model` under any other policy would be accepted
  // by the transport and then ignored — a flag that silently does nothing on a
  // command whose whole subject is which model wrote your code.
  if (policy === 'pinned' && pinnedModel === null) {
    throw usageError(
      '--policy pinned needs --model <id>',
      'Pinning disables fallback entirely: the named model is the only one tried, and a failure is the run failing rather than the next model being reached for.',
    );
  }
  if (pinnedModel !== null && policy !== null && policy !== 'pinned') {
    throw usageError(
      `--model names a model to pin, which only means something under --policy pinned (got --policy ${policy})`,
      'Drop --policy to pin, or drop --model to let the router order the candidates.',
    );
  }

  const projectRaw = stringOrNull(values['project'], '--project');
  const baseVersionRaw = stringOrNull(values['base-version'], '--base-version');
  const maxAttemptsRaw = stringOrNull(values['max-attempts'], '--max-attempts');

  return {
    command: 'run',
    global: globalsFrom(values, env),
    prompt,
    projectId: projectRaw === null ? null : requireUuid(projectRaw, '--project'),
    // A bare `--model` means pinned. Naming a model and then watching another
    // one answer is the substitution ADR-008 exists to make visible.
    policy: policy ?? (pinnedModel === null ? null : 'pinned'),
    pinnedModel,
    baseVersion:
      baseVersionRaw === null ? null : integerIn(baseVersionRaw, '--base-version', 0, Number.MAX_SAFE_INTEGER),
    maxAttempts: maxAttemptsRaw === null ? null : integerIn(maxAttemptsRaw, '--max-attempts', 1, MAX_RUN_ATTEMPTS),
    verbose: values['verbose'] === true,
  };
}

function parseDiff(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(argv, {}, true);
  const changeSetId = requireUuid(requireExactlyOnePositional(positionals, 'a changeset id'), 'a changeset id');
  return { command: 'diff', global: globalsFrom(values, env), changeSetId };
}

function parseApply(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(argv, { timeout: { type: 'string', multiple: true } }, true);
  const changeSetId = requireUuid(requireExactlyOnePositional(positionals, 'a changeset id'), 'a changeset id');
  const timeoutRaw = stringOrNull(values['timeout'], '--timeout');
  return {
    command: 'apply',
    global: globalsFrom(values, env),
    changeSetId,
    // 0 means "report what is true now and exit", which is the mode a CI step
    // wants when a later step polls for the result itself.
    timeoutSeconds:
      timeoutRaw === null ? DEFAULT_APPLY_TIMEOUT_SECONDS : integerIn(timeoutRaw, '--timeout', 0, 86_400),
  };
}

function parseRollback(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(
    argv,
    { 'expected-version': { type: 'string', multiple: true }, reason: { type: 'string', multiple: true } },
    true,
  );
  const journalId = requireUuid(requireExactlyOnePositional(positionals, 'a journal id'), 'a journal id');
  const expectedRaw = stringOrNull(values['expected-version'], '--expected-version');
  if (expectedRaw === null) {
    // Not defaulted, and not discovered by reading the daemon's refusal and
    // retrying. `RollbackRequest.expectedVersion` exists to guard against
    // reversing onto a tree that moved, and a client that fills it in from the
    // error it just got would be defeating the guard on the user's behalf.
    throw usageError(
      '--expected-version is required',
      'It is the project version the rollback must apply against — the `version` an apply reported, or `currentVersion` from `forgebridge diff <changeset-id>`. It guards against reversing onto a tree that has moved since.',
    );
  }
  return {
    command: 'rollback',
    global: globalsFrom(values, env),
    journalId,
    expectedVersion: integerIn(expectedRaw, '--expected-version', 0, Number.MAX_SAFE_INTEGER),
    reason: stringOrNull(values['reason'], '--reason'),
  };
}

function parseStatus(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation {
  const { values, positionals } = parse(argv, {}, true);
  rejectPositionals(positionals, 'status');
  return { command: 'status', global: globalsFrom(values, env) };
}

function rejectPositionals(positionals: readonly string[], command: Command): void {
  if (positionals.length > 0) {
    throw usageError(`\`forgebridge ${command}\` takes no arguments (got ${positionals.join(' ')})`);
  }
}
