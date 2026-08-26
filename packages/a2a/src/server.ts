import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DENY_ALL_APPROVALS, type ApprovalGate } from './approval.js';
import type { ForgeBridgeBackend } from './backend.js';
import { agentCardEtag, buildAgentCard, type AgentCardOptions } from './card.js';
import { A2AProtocolError, JSONRPC_ERRORS, versionNotSupported } from './errors.js';
import { SkillExecutor } from './executor.js';
import { A2AHandler } from './jsonrpc.js';
import {
  A2A_EXTENSIONS_HEADER,
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_WELL_KNOWN_PATH,
  JsonRpcRequest,
  type AgentCard,
} from './spec.js';
import { TaskStore } from './tasks.js';

/**
 * The HTTP transport: an Agent Card at the well-known path, and one JSON-RPC
 * endpoint.
 *
 * Three things are decided here rather than in the layers above, because all
 * three are properties of the *connection* and not of the call.
 *
 * **Authentication.** A bearer token, checked before the JSON-RPC envelope is
 * parsed. This ingress can propose ChangeSets into a user's Roblox place, so it
 * is not open by default and there is no option to make it open.
 *
 * **Version negotiation** (§3.6). The `A2A-Version` header decides which
 * semantics a request is asking for, and a version this interface does not
 * speak is refused rather than guessed at.
 *
 * **Binding.** Loopback by default, like the daemon. A2A is agent-to-agent and
 * an operator will often want this reachable from elsewhere, but that is a
 * decision they make explicitly, with TLS in front of it, rather than one this
 * package makes for them by defaulting to `0.0.0.0`.
 */

/**
 * The connector's default port.
 *
 * One above the daemon's 7317 so that the two can run side by side out of the
 * box, which is the normal arrangement: this process talks to that one.
 */
export const DEFAULT_A2A_PORT = 7318;

/** Where the JSON-RPC endpoint lives, unless an operator moves it. */
export const DEFAULT_ENDPOINT_PATH = '/a2a/v1';

/** JSON-RPC bodies are small. A ChangeSet is not — hence the ceiling, not a guess. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024 + 64 * 1024;

const LOOPBACK_HOST = '127.0.0.1';

export interface A2AServerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: A2AServerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface A2AServerOptions {
  /** How this connector reaches ForgeBridge. Usually a `DaemonBackend`. */
  backend: ForgeBridgeBackend;
  /**
   * Where approvals come from. Defaults to `DENY_ALL_APPROVALS`, which means
   * propose and read work and nothing can be applied until an operator wires up
   * an approval path. See `approval.ts` for why that is the right default.
   */
  gate?: ApprovalGate;
  /**
   * The URL agents will reach this connector at, for the Agent Card. Required
   * for the reason `AgentCardOptions.endpointUrl` gives: the socket this
   * process binds is usually not the address a caller can use.
   */
  endpointUrl: string;
  port?: number;
  /** Interface to bind. Defaults to loopback; widening it is the operator's call. */
  host?: string;
  endpointPath?: string;
  /**
   * The bearer token callers must present. Minted per process when absent, in
   * which case it is readable from `bearerToken` so the launcher can print it.
   */
  bearerToken?: string;
  /** §4.4.6 `tenant`, when several instances share one endpoint. */
  tenant?: string;
  /** Overrides the card version. For tests and downstream repackagers. */
  version?: string;
  logger?: A2AServerLogger;
  now?: () => number;
  maxTasks?: number;
}

export class A2AServer {
  readonly card: AgentCard;
  readonly tasks: TaskStore;
  readonly handler: A2AHandler;

  /**
   * The bearer secret. Readable so the process that started this connector can
   * print it or hand it to the agent it is federating with; never served over
   * HTTP, and never written to a log by this package.
   */
  readonly bearerToken: string;

  readonly #server: Server;
  readonly #endpointPath: string;
  readonly #host: string;
  readonly #port: number;
  readonly #logger: A2AServerLogger;
  readonly #etag: string;
  readonly #cardBody: string;

  constructor(options: A2AServerOptions) {
    this.#endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
    this.#host = options.host ?? LOOPBACK_HOST;
    this.#port = options.port ?? DEFAULT_A2A_PORT;
    this.#logger = options.logger ?? silentLogger;
    this.bearerToken = options.bearerToken ?? randomBytes(32).toString('base64url');

    this.tasks = new TaskStore({
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }),
    });

    this.handler = new A2AHandler({
      tasks: this.tasks,
      executor: new SkillExecutor({
        backend: options.backend,
        gate: options.gate ?? DENY_ALL_APPROVALS,
        tasks: this.tasks,
      }),
      expectedTenant: options.tenant,
    });

    const cardOptions: AgentCardOptions = {
      endpointUrl: options.endpointUrl,
      ...(options.tenant ? { tenant: options.tenant } : {}),
      ...(options.version ? { version: options.version } : {}),
    };
    this.card = buildAgentCard(cardOptions);
    this.#etag = agentCardEtag(this.card);
    this.#cardBody = JSON.stringify(this.card);

    if (this.#host !== LOOPBACK_HOST && !options.endpointUrl.startsWith('https://')) {
      // Not refused, because a reverse proxy terminating TLS is a legitimate
      // and common arrangement and this process cannot see it. Said out loud,
      // because §4.4.6 requires an absolute HTTPS URL in production and a card
      // advertising `http://` to strangers is worth one line in a log.
      this.#logger.warn('serving a non-loopback A2A endpoint whose advertised URL is not https', {
        endpointUrl: options.endpointUrl,
        host: this.#host,
      });
    }

    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once('error', onError);
      this.#server.listen({ host: this.#host, port: this.#port }, () => {
        this.#server.removeListener('error', onError);
        resolve();
      });
    });
    const port = this.address?.port ?? this.#port;
    return { host: this.#host, port, url: `http://${this.#host}:${port}` };
  }

  async close(): Promise<void> {
    // Background tasks first: a caller that used `returnImmediately` has work
    // in flight, and tearing the store out from under it turns a completed
    // apply into an unexplained illegal-transition throw.
    await this.handler.settled();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  get address(): AddressInfo | null {
    const address = this.#server.address();
    return address && typeof address === 'object' ? address : null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? this.#host}`);

      if (url.pathname === AGENT_CARD_WELL_KNOWN_PATH) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
        return this.#serveCard(req, res);
      }

      if (url.pathname === this.#endpointPath) {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        return await this.#serveJsonRpc(req, res, url);
      }

      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      this.#logger.error('unhandled A2A connector error', { error: String(error) });
      // A body that leaks a stack out of a process holding a producer token is
      // a finding, not a debugging convenience — the same rule the daemon
      // applies to itself.
      writeJsonRpc(res, 200, null, undefined, {
        code: JSONRPC_ERRORS.internal.code,
        message: JSONRPC_ERRORS.internal.message,
      });
    }
  }

  /**
   * §8.2 and §8.6.1. Served unauthenticated: the card is a discovery document
   * whose whole purpose is to be readable before a relationship exists, and
   * §14.3 says it "SHOULD NOT include sensitive credentials or internal
   * implementation details" precisely because it is public. It names the
   * security scheme a caller will need; it does not contain one.
   */
  #serveCard(req: IncomingMessage, res: ServerResponse): void {
    const ifNoneMatch = headerValue(req, 'if-none-match');
    const headers: Record<string, string> = {
      'content-type': A2A_MEDIA_TYPE,
      etag: this.#etag,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    };

    if (ifNoneMatch === this.#etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(this.#cardBody, 'utf8')) });
      res.end();
      return;
    }

    res.writeHead(200, { ...headers, 'content-length': String(Buffer.byteLength(this.#cardBody, 'utf8')) });
    res.end(this.#cardBody);
  }

  async #serveJsonRpc(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#authenticated(req)) return unauthorized(res);

    const contentType = (headerValue(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType !== 'application/json' && contentType !== A2A_MEDIA_TYPE) {
      return writeJson(res, 415, {
        error: `Content-Type must be application/json or ${A2A_MEDIA_TYPE}`,
      });
    }

    // §3.6: negotiated before anything is parsed, because the version decides
    // how to read what follows. There is no request id yet, so an error here is
    // correlated to `null`, which JSON-RPC 2.0 allows for exactly this case.
    const versionError = this.#negotiateVersion(req, url);
    if (versionError) return writeJsonRpc(res, 200, null, undefined, versionError.toJsonRpcError());

    let body: Buffer;
    try {
      body = await readBody(req, MAX_REQUEST_BYTES);
    } catch {
      return writeJson(res, 413, { error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body.toString('utf8'));
    } catch {
      return writeJsonRpc(res, 200, null, undefined, {
        code: JSONRPC_ERRORS.parse.code,
        message: JSONRPC_ERRORS.parse.message,
      });
    }

    const envelope = JsonRpcRequest.safeParse(parsedJson);
    if (!envelope.success) {
      // A JSON-RPC batch is an array, which fails this parse. Batching is not
      // implemented and this is the honest answer for it; see the README.
      return writeJsonRpc(res, 200, null, undefined, {
        code: JSONRPC_ERRORS.invalidRequest.code,
        message: JSONRPC_ERRORS.invalidRequest.message,
      });
    }

    const { id, method, params } = envelope.data;
    const declaredExtensions = (headerValue(req, A2A_EXTENSIONS_HEADER) ?? '')
      .split(',')
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);

    try {
      const result = await this.handler.call(method, params, { declaredExtensions });
      return writeJsonRpc(res, 200, id ?? null, result, undefined);
    } catch (error) {
      if (error instanceof A2AProtocolError) {
        return writeJsonRpc(res, 200, id ?? null, undefined, error.toJsonRpcError());
      }
      this.#logger.error('A2A method threw', { method, error: String(error) });
      return writeJsonRpc(res, 200, id ?? null, undefined, {
        code: JSONRPC_ERRORS.internal.code,
        message: JSONRPC_ERRORS.internal.message,
      });
    }
  }

  /**
   * §3.6.2. Two rules, both stated in the specification and both surprising
   * enough to be worth spelling out:
   *
   *   - only `Major.Minor` counts; a patch component is ignored, because §3.6
   *     says patch numbers "MUST not be considered when clients and servers
   *     negotiate protocol versions";
   *   - an *absent* header means `0.3`, not "whatever the server speaks":
   *     "Agents MUST interpret empty value as 0.3 version". This interface
   *     speaks 1.0 only, so a caller that sends no version header is refused
   *     with `VersionNotSupportedError` rather than silently served 1.0
   *     semantics it did not ask for. A 0.3 client fed 1.0 responses would see
   *     lowercase task states it does not recognise and field names that moved,
   *     which is a worse failure than a clear refusal.
   */
  #negotiateVersion(req: IncomingMessage, url: URL): A2AProtocolError | null {
    // §3.6.1 permits the version as a request parameter as well as a header.
    const raw = headerValue(req, A2A_VERSION_HEADER) ?? url.searchParams.get(A2A_VERSION_HEADER) ?? '';
    const declared = raw.trim();
    const effective = declared === '' ? '0.3' : majorMinor(declared);
    if (effective !== A2A_PROTOCOL_VERSION) {
      return versionNotSupported(effective, A2A_PROTOCOL_VERSION);
    }
    return null;
  }

  #authenticated(req: IncomingMessage): boolean {
    const header = headerValue(req, 'authorization') ?? '';
    const [scheme, ...rest] = header.split(' ');
    if ((scheme ?? '').toLowerCase() !== 'bearer') return false;
    const provided = rest.join(' ').trim();
    // Constant time, and length-checked first: `timingSafeEqual` throws on a
    // length mismatch, which would turn a wrong-length token into a 500 and a
    // length oracle.
    const expected = Buffer.from(this.bearerToken, 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length === 0 || expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

export function createA2AServer(options: A2AServerOptions): A2AServer {
  return new A2AServer(options);
}

/** `1.0.1` and `1.0` both negotiate as `1.0` (§3.6). */
export function majorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

// ────────────────────────────────── transport helpers ──────────────────────────────────

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function writeJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
    'content-length': String(Buffer.byteLength(payload, 'utf8')),
  });
  res.end(payload);
}

/**
 * A JSON-RPC response, always at HTTP 200 when there is a JSON-RPC envelope to
 * put the outcome in.
 *
 * This is the ordinary JSON-RPC-over-HTTP convention, and the specification does
 * not contradict it: the HTTP-status column of the §5.4 mapping table belongs to
 * the HTTP+JSON binding (§11.6), not to this one, which §9.5 defines entirely in
 * terms of the JSON-RPC error object. Non-200 statuses are reserved here for
 * failures that happen before there is an envelope — 401, 404, 405, 413, 415.
 */
function writeJsonRpc(
  res: ServerResponse,
  status: number,
  id: string | number | null,
  result: unknown,
  error: { code: number; message: string; data?: unknown } | undefined,
): void {
  const body =
    error === undefined
      ? { jsonrpc: '2.0' as const, id, result }
      : { jsonrpc: '2.0' as const, id, error };
  writeJson(res, status, body);
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  writeJson(res, 405, { error: 'method not allowed' }, { allow });
}

/**
 * §3.3.2 asks a server to "include authentication challenge information" and to
 * "specify which authentication scheme is required", which `WWW-Authenticate`
 * does in the standard way.
 *
 * The body is not a JSON-RPC error object, because authentication is checked
 * before the envelope is parsed and there is therefore no request id to
 * correlate one to.
 *
 * TODO(M31): the specification names "JSON-RPC custom error" as the JSON-RPC
 * binding's representation of an authentication failure (§3.3.2) but assigns no
 * code for it — §5.4's A2A range `-32001`–`-32099` defines nine codes and none
 * of them is an authentication error. Picking a number out of that reserved
 * range would risk colliding with one the working group later assigns. If a code
 * is registered, it belongs in `A2A_ERRORS` in `src/errors.ts` and in this
 * function. Owner: whoever next re-reads the specification for a version bump.
 */
function unauthorized(res: ServerResponse): void {
  writeJson(
    res,
    401,
    { error: 'a bearer token is required to call this A2A endpoint' },
    { 'www-authenticate': 'Bearer' },
  );
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limitBytes) {
    throw new Error('too large');
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      // `Content-Length` is a claim by the sender, so the running total is
      // checked too and not only the header.
      if (total > limitBytes) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(chunks, total)));
    req.once('error', reject);
  });
}
