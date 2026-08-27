import { randomBytes } from 'node:crypto';
import { DEFAULT_DAEMON_PORT, LOOPBACK_HOST, PRODUCER_TOKEN_ENV } from '@forgebridge/daemon';

/**
 * Strip trailing `/` in linear time.
 *
 * `replace(/\/+$/, '')` stood here and reads better, but `\/+$` is the textbook
 * polynomial-ReDoS shape — on a long run of slashes the engine backtracks
 * O(n^2), which is what CodeQL's `js/polynomial-redos` fires on. A base URL is a
 * caller-supplied string, so the loop is the honest answer rather than an
 * argument about who would ever pass one. Local to this file on purpose: it is
 * three lines, and a shared utility package for it would cross a boundary
 * `verify-boundaries.ts` is right to keep closed.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  // 47 is `/`. charCodeAt keeps this a scan, with no allocation per character.
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}


/**
 * How this server was asked to run, resolved once from flags and environment.
 *
 * `DEFAULT_DAEMON_PORT` and `PRODUCER_TOKEN_ENV` are imported from the daemon
 * rather than written down again. A connector that hardcodes 7317 is a
 * connector that keeps working right up until the day the daemon moves, and
 * the symptom a user sees is "the bridge is broken" (see the port's own
 * comment in `packages/daemon/src/server.ts`).
 */

/**
 * Which transport binding to open. One server implementation, two bindings.
 *
 * Named a *binding* rather than a transport because the protocol already has a
 * `TransportKind`, and it means something else entirely — which link carries
 * ChangeSets to Studio, and therefore who can read them. Two types called
 * `TransportKind` in one dependency graph would be a confusion worth avoiding.
 */
export type TransportBinding = 'stdio' | 'http';

export const TRANSPORT_ENV = 'FORGEBRIDGE_MCP_TRANSPORT';
export const DAEMON_URL_ENV = 'FORGEBRIDGE_DAEMON_URL';
export const PROJECT_ID_ENV = 'FORGEBRIDGE_PROJECT_ID';
export const HTTP_PORT_ENV = 'FORGEBRIDGE_MCP_PORT';
export const HTTP_HOST_ENV = 'FORGEBRIDGE_MCP_HOST';
export const TOOL_SEPARATOR_ENV = 'FORGEBRIDGE_MCP_TOOL_SEPARATOR';
export const HTTP_TOKEN_ENV = 'FORGEBRIDGE_MCP_TOKEN';

/**
 * The default HTTP port for the *MCP* binding, which is not the daemon's.
 *
 * Unlike the daemon's port this one carries no Roblox permission prompt, so it
 * is chosen only to sit next to 7317 without colliding with it.
 */
export const DEFAULT_HTTP_PORT = 7318;

/**
 * The separator in the mandated tool names (`forge.list_projects`).
 *
 * Configurable, and defaulting to the name the architecture specifies.
 * TODO(M31): the MCP specification does not constrain tool-name characters,
 * but clients that project tools into an OpenAI-style function schema do —
 * that grammar is `[A-Za-z0-9_-]`, which a dot fails. Whether any shipping
 * client actually refuses `forge.list_projects` has NOT been verified here and
 * must not be claimed either way until the connector conformance suite runs a
 * real client against it. If one does, `--tool-name-separator _` is the escape
 * hatch, and this is the knob the suite turns.
 */
export const DEFAULT_TOOL_SEPARATOR = '.';

/**
 * The floor on an operator-supplied HTTP bearer token, in characters.
 *
 * A policy, not a measurement. The thing this token stands in front of is a
 * process holding the daemon's producer token, and the endpoint is a local HTTP
 * socket that answers as fast as the machine can loop — a four-character secret
 * there is a formality. A minted token is 32 bytes of CSPRNG rendered base64url,
 * which is 43 characters; this floor exists only so that *choosing* your own
 * token cannot quietly be weaker than not choosing one.
 */
export const MIN_HTTP_TOKEN_CHARS = 16;

export interface ServerConfig {
  transport: TransportBinding;
  /** Base URL of the daemon's `/v1` surface, without a trailing slash. */
  daemonUrl: string;
  /**
   * The daemon's producer token. Producer routes refuse a request without it,
   * because loopback is not an authentication boundary.
   */
  producerToken: string;
  /** Project every tool call assumes when its arguments name none. */
  defaultProjectId: string | null;
  /** Only meaningful for the `http` binding. */
  httpHost: string;
  httpPort: number;
  /**
   * The bearer token the HTTP binding requires. Minted per process unless an
   * operator names one, and non-optional so that a config assembled by hand
   * cannot omit it into an open endpoint.
   */
  httpToken: string;
  toolSeparator: string;
}

export class ConfigError extends Error {}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ConfigError(`${flag} needs a value`);
  }
  return value;
}

function parsePort(raw: string, flag: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`${flag} must be a port between 1 and 65535, not "${raw}"`);
  }
  return port;
}

/**
 * `stdio` unless something says otherwise.
 *
 * An editor that spawns this process talks over its pipes and nothing else, and
 * that is the overwhelmingly common case. Serving HTTP is a decision an
 * operator makes out loud; it is never what you get by accident.
 */
export function resolveTransport(argv: readonly string[], env: NodeJS.ProcessEnv): TransportBinding {
  if (argv.includes('--stdio') && argv.includes('--http')) {
    throw new ConfigError('--stdio and --http are mutually exclusive');
  }
  if (argv.includes('--stdio')) return 'stdio';
  if (argv.includes('--http')) return 'http';

  const declared = env[TRANSPORT_ENV]?.trim().toLowerCase();
  if (declared === 'stdio' || declared === 'http') return declared;
  if (declared !== undefined && declared !== '') {
    throw new ConfigError(`${TRANSPORT_ENV} must be "stdio" or "http", not "${declared}"`);
  }
  return 'stdio';
}

function normaliseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`"${raw}" is not a valid daemon URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`the daemon URL must be http or https, not "${url.protocol}"`);
  }
  return `${url.origin}${withoutTrailingSlashes(url.pathname)}`;
}

export function resolveConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ServerConfig {
  const transport = resolveTransport(argv, env);

  const daemonUrl = normaliseUrl(
    flagValue(argv, '--daemon-url') ?? env[DAEMON_URL_ENV] ?? `http://${LOOPBACK_HOST}:${DEFAULT_DAEMON_PORT}`,
  );

  // Read, never stored and never echoed. The daemon prints it once next to the
  // pairing code; it reaches this process the same way any other secret does.
  const producerToken = (flagValue(argv, '--producer-token') ?? env[PRODUCER_TOKEN_ENV] ?? '').trim();
  if (producerToken === '') {
    throw new ConfigError(
      `no producer token: set ${PRODUCER_TOKEN_ENV} to the token the daemon printed at startup`,
    );
  }

  const projectRaw = flagValue(argv, '--project') ?? env[PROJECT_ID_ENV] ?? '';
  const defaultProjectId = projectRaw.trim() === '' ? null : projectRaw.trim();

  const portRaw = flagValue(argv, '--port') ?? env[HTTP_PORT_ENV];
  const httpPort = portRaw === undefined ? DEFAULT_HTTP_PORT : parsePort(portRaw, '--port');

  // Loopback by default for the same reason the daemon binds it: this process
  // holds a token that can write into somebody's place. Widening the bind is
  // the operator's explicit decision, and `bin.ts` says so on stderr when they
  // make it.
  const httpHost = (flagValue(argv, '--host') ?? env[HTTP_HOST_ENV] ?? LOOPBACK_HOST).trim();

  const toolSeparator = flagValue(argv, '--tool-name-separator') ?? env[TOOL_SEPARATOR_ENV] ?? DEFAULT_TOOL_SEPARATOR;
  if (!/^[._-]$/.test(toolSeparator)) {
    throw new ConfigError('--tool-name-separator must be one of . _ -');
  }

  const httpToken = resolveHttpToken(flagValue(argv, '--http-token') ?? env[HTTP_TOKEN_ENV]);

  return { transport, daemonUrl, producerToken, defaultProjectId, httpHost, httpPort, httpToken, toolSeparator };
}

/**
 * The HTTP binding's bearer token: taken from the operator, or minted.
 *
 * Minted rather than optional, and there is deliberately **no way to turn the
 * check off**. Binding loopback is not an authentication boundary — the daemon's
 * own `envelope.ts` says the MAC exists precisely because "any process on the
 * box can open a socket to 127.0.0.1" — and this process answers every request
 * with the daemon's producer token behind it. An unauthenticated HTTP binding is
 * therefore that token handed to whatever found the port, which is the boundary
 * ADR-012 depends on, gone.
 *
 * An opt-out was considered and rejected: the only honest version of one would
 * be the daemon refusing to issue a producer token to an unauthenticated MCP
 * binding, and the daemon has no way to know how its token is being used. A flag
 * this package could offer would therefore be a flag that disables the boundary
 * and cannot be compensated for anywhere else. Minting costs an operator one
 * copy-paste from the line `startHttp` prints, which is what they already do for
 * the producer token and the pairing code.
 *
 * An empty or whitespace value is treated as "not supplied" rather than as "no
 * token", so `FORGEBRIDGE_MCP_TOKEN=` — the shape someone reaches for when they
 * mean to switch this off — mints one and fails closed.
 */
export function resolveHttpToken(raw: string | undefined): string {
  const supplied = (raw ?? '').trim();
  if (supplied === '') return randomBytes(32).toString('base64url');
  if (supplied.length < MIN_HTTP_TOKEN_CHARS) {
    throw new ConfigError(
      `--http-token must be at least ${MIN_HTTP_TOKEN_CHARS} characters; omit it and one is minted for you`,
    );
  }
  return supplied;
}

/** True when the HTTP binding would be reachable from outside this machine. */
export function bindsPublicly(host: string): boolean {
  const normalised = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return !['127.0.0.1', 'localhost', '::1'].includes(normalised);
}
