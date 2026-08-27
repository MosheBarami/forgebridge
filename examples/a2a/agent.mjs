/**
 * Drive the ForgeBridge A2A connector the way another agent would.
 *
 *   node examples/a2a/agent.mjs
 *
 * Starts the server in-process rather than shelling out, because `packages/a2a`
 * exposes no binary — it is a library an application mounts, and this is the
 * shortest honest demonstration of that.
 *
 * Two things in here are the point rather than scaffolding. The connector mints
 * a bearer token per process and every JSON-RPC call must present it: this
 * process holds the daemon's producer token, and an open port would be that
 * token handed to whatever found it. And the approval gate is left at its
 * default, `DENY_ALL_APPROVALS`, so propose and read work and nothing can be
 * applied — an agent that could approve its own submission is what ADR-012
 * exists to prevent.
 */
import { DaemonBackend, createA2AServer } from '@forgebridge/a2a';

const producerToken = process.env.FORGEBRIDGE_PRODUCER_TOKEN;
if (!producerToken) {
  console.error('Set FORGEBRIDGE_PRODUCER_TOKEN — the token the daemon printed on its own terminal.');
  process.exit(2);
}

const port = Number(process.env.FORGEBRIDGE_A2A_PORT ?? 7319);
const server = createA2AServer({
  backend: new DaemonBackend({
    baseUrl: process.env.FORGEBRIDGE_DAEMON_URL ?? 'http://127.0.0.1:7317',
    producerToken,
  }),
  // The address a *caller* would use, which is not necessarily the socket this
  // process binds — the card has to advertise the former.
  endpointUrl: `http://127.0.0.1:${port}/`,
  port,
});

const bound = await server.listen();
const base = bound.url.replace(/\/$/, '');

try {
  // 1. The card. Since A2A 0.3.0 this is where it lives; an earlier draft of
  //    this repository's own documentation had it elsewhere, which is why the
  //    path is spelled out here rather than assumed.
  const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
  console.log(`agent      : ${card.name} ${card.version}`);
  console.log(`endpoint   : ${bound.url}`);
  console.log(`streaming  : ${card.capabilities?.streaming} — declared, and the method answers the specified error`);
  console.log('skills     :');
  for (const skill of card.skills ?? []) console.log(`  ${skill.id}`);

  // 2. JSON-RPC, with the bearer token this process minted.
  const rpc = async (method, params) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.bearerToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return response.json();
  };

  const sent = await rpc('message/send', {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text: 'Add a shop stand with a proximity prompt' }],
      messageId: crypto.randomUUID(),
    },
  });

  if (sent.error) {
    console.error(`\n${sent.error.code}: ${sent.error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`\ntask       : ${sent.result?.id}`);
    console.log(`state      : ${sent.result?.status?.state}`);
    console.log(
      '\nIt stops short of applying. The gate is DENY_ALL_APPROVALS by default, so an\n' +
        'operator has to wire an approval path before anything reaches a place.',
    );
  }
} finally {
  await server.close();
}
