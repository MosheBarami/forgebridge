#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, resolveConfig } from './config.js';
import { startHttp, startStdio } from './server.js';

/**
 * `forgebridge-mcp` — the connector, run directly.
 *
 * Everything it prints goes to stderr, the usage text included: under the stdio
 * binding stdout belongs to JSON-RPC, and a help message written there is read
 * by the client as a malformed frame rather than as help.
 */

const USAGE = [
  'forgebridge-mcp — the ForgeBridge MCP server',
  '',
  '  --stdio                    speak MCP over stdin/stdout (default)',
  '  --http                     serve streamable HTTP instead',
  '  --host <host>              HTTP bind address (default 127.0.0.1)',
  '  --port <port>              HTTP port (default 7318)',
  '  --http-token <token>       bearer token the HTTP binding requires;',
  '                             minted and printed at startup when omitted',
  '  --daemon-url <url>         ForgeBridge daemon base URL (default http://127.0.0.1:7317)',
  '  --producer-token <token>   the token the daemon printed when it started',
  '  --project <uuid>           project to assume when a tool call names none',
  '  --tool-name-separator <c>  "." (default), "_" or "-" inside tool names',
  '  --help',
  '',
  'Environment: FORGEBRIDGE_PRODUCER_TOKEN, FORGEBRIDGE_DAEMON_URL,',
  'FORGEBRIDGE_PROJECT_ID, FORGEBRIDGE_MCP_TRANSPORT, FORGEBRIDGE_MCP_HOST,',
  'FORGEBRIDGE_MCP_PORT, FORGEBRIDGE_MCP_TOKEN, FORGEBRIDGE_MCP_TOOL_SEPARATOR.',
  '',
  'The HTTP binding always requires its bearer token. There is no flag to turn',
  'that off: this process holds the daemon\u2019s producer token, and an open port',
  'would be that token handed to whatever found it.',
  '',
].join('\n');

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(USAGE);
    return;
  }

  const config = resolveConfig(argv, env);
  if (config.transport === 'http') {
    await startHttp({ config });
    return;
  }
  await startStdio({ config });
}

/**
 * Only start a server when this file was run, not when it was imported. Same
 * guard as `packages/daemon/src/bin.ts`.
 */
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    // A ConfigError is the user's to fix and says how; anything else is ours,
    // and its message could carry a path this process should not print.
    const message = error instanceof ConfigError ? error.message : 'the ForgeBridge MCP server failed to start';
    process.stderr.write(`forgebridge-mcp: ${message}\n`);
    process.exit(1);
  });
}
