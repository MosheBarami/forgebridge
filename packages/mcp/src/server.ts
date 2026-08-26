import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DaemonClient } from './daemon-client.js';
import { registerForgeBridgeTools, type McpServerLike } from './register.js';
import type { ToolContext } from './tools.js';
import { bindsPublicly, type ServerConfig } from './config.js';

/**
 * The two transport bindings, over one server implementation.
 *
 * Everything above this file is free of the SDK: the tools, their schemas, the
 * error mapping and the registration walk are all plain TypeScript, tested
 * against a recording double. This file is the only place the SDK is imported,
 * which is what keeps a protocol-library upgrade a change to one file rather
 * than to eleven tool handlers.
 *
 * ── Verified against @modelcontextprotocol/sdk 1.30.0 (M26) ──────────────────
 *
 * Every call below has been run, not just read out of the documentation:
 *
 *   1. `new McpServer({ name, version })`
 *   2. `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`
 *      — `inputSchema` takes a raw Zod shape and the SDK projects it into the
 *        JSON Schema the client sees; `readOnlyHint`, `destructiveHint` and
 *        `openWorldHint` are all keys of the SDK's own `ToolAnnotations`.
 *        `register.ts`'s `McpServerLike` is that surface, written out.
 *   3. `server.connect(transport)` and `server.close()`
 *   4. `new StdioServerTransport()`
 *   5. `new StreamableHTTPServerTransport({ sessionIdGenerator })` and
 *      `transport.handleRequest(req, res, parsedBody)`
 *   6. `package.json` pins `^1.30.0`, which is the floor that was actually run.
 *      Earlier 1.x releases may well work; none has been tested, so none is
 *      claimed.
 *
 * A live client over an in-memory transport listed the eleven tools with their
 * projected schemas, and the HTTP binding answered a real `initialize`. Do not
 * widen what this file claims beyond that.
 */

const packageJson = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;

export interface StartOptions {
  config: ServerConfig;
  /** Where diagnostics go. Never stdout under stdio — see `startStdio`. */
  log?: (message: string) => void;
}

function contextFor(config: ServerConfig): ToolContext {
  return {
    client: new DaemonClient({ baseUrl: config.daemonUrl, producerToken: config.producerToken }),
    defaultProjectId: config.defaultProjectId,
  };
}

/** An `McpServer` with the ForgeBridge surface registered on it. */
export function createForgeBridgeServer(config: ServerConfig): { server: McpServer; toolNames: string[] } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Bound uncast on purpose: `McpServer` has to satisfy `McpServerLike`
  // structurally, so the moment the SDK is installed the compiler checks the
  // one assumption this package makes about its API. A cast here would defer
  // that check forever, which is the opposite of what the TODO above asks for.
  const registrar: McpServerLike = server;
  const toolNames = registerForgeBridgeTools(registrar, contextFor(config), {
    toolSeparator: config.toolSeparator,
  });
  return { server, toolNames };
}

/**
 * stdio, for an editor that spawns this process.
 *
 * Stdout is the JSON-RPC channel and nothing else may be written to it: one
 * stray `console.log` corrupts the stream and the client reports a parse error
 * rather than the print. Every diagnostic in this package goes to stderr, which
 * is why `log` defaults to it here rather than to `console.log`.
 */
export async function startStdio(options: StartOptions): Promise<McpServer> {
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  const { server, toolNames } = createForgeBridgeServer(options.config);
  await server.connect(new StdioServerTransport());
  log(`forgebridge-mcp: stdio, ${toolNames.length} tools, daemon ${options.config.daemonUrl}`);
  return server;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Which `Host` headers this binding will answer to.
 *
 * Checked here rather than delegated, for the same reason the daemon checks its
 * own: binding loopback keeps remote packets out but does not keep *browsers*
 * out. A page anywhere can point a hostname it controls at 127.0.0.1 and have
 * the user's own browser deliver requests here — and this process carries a
 * token that can write into somebody's place.
 */
export function hostIsAllowed(hostHeader: string | undefined, configuredHost: string): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : (hostHeader.split(':')[0] ?? '');
  const normalised = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalised) || normalised === configuredHost.trim().toLowerCase();
}

/** The MCP endpoint path. One path, because a client configures one URL. */
export const HTTP_ENDPOINT = '/mcp';

const JSON_RPC_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

function rejectRequest(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, JSON_RPC_HEADERS);
  // JSON-RPC shaped so a client surfaces the sentence rather than "bad response".
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message }, id: null }));
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
}

/** 8 MiB, matching the protocol's ceiling on one ChangeSet. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Streamable HTTP, for a remote client.
 *
 * A fresh server and transport per request: the stateless shape, which needs no
 * session table and cannot leak one client's state into another's response. The
 * cost is constructing eleven tool registrations per call, which is object
 * allocation, not I/O.
 */
export function startHttp(options: StartOptions): Promise<Server> {
  const { config } = options;
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        if (!hostIsAllowed(req.headers.host, config.httpHost)) {
          rejectRequest(res, 400, 'Host is not permitted');
          return;
        }
        // No browser is a legitimate client of this endpoint, and a request
        // carrying an Origin is a browser saying so.
        if (req.headers.origin !== undefined) {
          rejectRequest(res, 403, 'cross-origin requests are not permitted');
          return;
        }
        const path = (req.url ?? '/').split('?')[0];
        if (path !== HTTP_ENDPOINT) {
          rejectRequest(res, 404, `unknown path; the MCP endpoint is ${HTTP_ENDPOINT}`);
          return;
        }
        if (req.method !== 'POST') {
          rejectRequest(res, 405, 'only POST is served; this binding keeps no session to resume');
          return;
        }

        const body = await readBody(req, MAX_BODY_BYTES);
        const { server } = createForgeBridgeServer(config);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        log(`forgebridge-mcp: request failed (${error instanceof Error ? error.name : 'unknown error'})`);
        if (!res.headersSent) rejectRequest(res, 500, 'the MCP server failed to handle this request');
        else res.end();
      }
    })();
  });

  if (bindsPublicly(config.httpHost)) {
    log(
      `forgebridge-mcp: WARNING binding ${config.httpHost}:${config.httpPort}, which is reachable from outside this machine. Anything that reaches it can propose changes to the paired place.`,
    );
  }

  return new Promise<Server>((resolve) => {
    http.listen(config.httpPort, config.httpHost, () => {
      log(
        `forgebridge-mcp: streamable HTTP on http://${config.httpHost}:${config.httpPort}${HTTP_ENDPOINT}, daemon ${config.daemonUrl}`,
      );
      resolve(http);
    });
  });
}
