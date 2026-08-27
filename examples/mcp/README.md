# MCP example

`forgebridge-mcp` is an MCP server. There is no script to run here that is more
honest than the configuration an MCP client actually needs, so that is what this
directory holds — plus one script that proves the server answers, without an
editor in the loop.

## Point an editor at it

`client-config.json` is the shape every stdio MCP client uses. Copy the
`forgebridge` entry into your client's configuration file and restart it.

```bash
cat examples/mcp/client-config.json
```

The daemon's producer token goes in the environment rather than in an argument:
arguments are visible in `ps` to every process on the machine, and this one lets
its holder submit and approve ChangeSets.

> `packages/mcp` has not been tried against any of the editors M26 names. The
> transport is conformant and tested (`packages/mcp/test/conformance.test.ts`),
> and "works in editor X" is a different claim that nobody in this repository has
> earned yet.

## Prove it answers, with no editor

```bash
npm ci && npm run build
npx forgebridge daemon --allow-path ServerScriptService.Shop   # another terminal
export FORGEBRIDGE_PRODUCER_TOKEN=…
node examples/mcp/handshake.mjs
```

It speaks the initialize handshake over stdio and lists the tools the server
advertises. Nothing is proposed and nothing is approved.
