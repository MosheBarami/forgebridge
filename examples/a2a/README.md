# A2A example

`packages/a2a` serves an agent card and a JSON-RPC task surface. This example
starts one in-process and drives it the way another agent would: fetch the card,
send a message, read the task back.

```bash
npm ci && npm run build
npx forgebridge daemon --allow-path ServerScriptService.Shop   # another terminal
export FORGEBRIDGE_PRODUCER_TOKEN=…
node examples/a2a/agent.mjs
```

## What to look at in the output

**The card is served at `/.well-known/agent-card.json`.** That is where A2A has
registered it since 0.3.0, and it is worth checking against because an earlier
draft of this repository's own documentation had it somewhere else.

**`streaming` and `pushNotifications` are `false`.** They are declared false and
the corresponding methods answer the error §3.3.4 requires. That is implemented
behaviour rather than a gap: an agent that reads the card knows not to ask, and
one that asks anyway gets the specified refusal instead of a hang.

**The task stops at a diff.** `start-run` reaches `POST /v1/runs` and its
artifact carries every model attempt the router made — but applying needs a
human grant, and this script does not have one. An agent that could approve its
own submission is the thing ADR-012 exists to prevent.
