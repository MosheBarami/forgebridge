/**
 * Speak MCP to `forgebridge-mcp` over stdio and list its tools.
 *
 *   node examples/mcp/handshake.mjs
 *
 * An MCP client is a few hundred lines; this is the twenty that prove the
 * server is there. It sends `initialize`, then `tools/list`, and prints the
 * names. Nothing is proposed and nothing is approved — every tool that would
 * change a place needs an approval this script never gives.
 *
 * Note what it does NOT do: it does not read the server's stdout as anything
 * but JSON-RPC frames. `forgebridge-mcp` writes every human-readable line to
 * stderr for exactly that reason — help text on stdout is read by a client as a
 * malformed frame.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn('npx', ['forgebridge-mcp', '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const pending = new Map();

createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.trim() === '') return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    // A line that is not a frame is the server writing where it should not.
    // Reported rather than ignored: silence here is how a protocol bug hides.
    console.error(`not a JSON-RPC frame: ${line}`);
    return;
  }
  const resolve = pending.get(frame.id);
  if (resolve) {
    pending.delete(frame.id);
    resolve(frame);
  }
});

let nextId = 1;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

const initialize = await call('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'forgebridge-example', version: '0.1.0' },
});
console.log(`server    : ${initialize.result?.serverInfo?.name ?? '(none reported)'}`);
console.log(`protocol  : ${initialize.result?.protocolVersion ?? '(none reported)'}`);

send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const tools = await call('tools/list', {});
for (const tool of tools.result?.tools ?? []) {
  console.log(`  ${tool.name}`);
}

child.stdin.end();
child.kill();
