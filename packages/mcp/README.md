# @forgebridge/mcp

The MCP connector: one tool surface, two transport bindings, over the ForgeBridge
daemon's `/v1` REST surface.

This is the flagship connector ([ADR-009](../../docs/architecture/adr-009-mcp-primary-connector.md)):
one implementation is meant to reach every editor and agent that speaks MCP, rather than
eleven bespoke integrations. It contains no business logic. Every decision that matters —
whether a ChangeSet is well formed, whether its paths are permitted, whether it may be
applied — is taken behind the daemon, in `@forgebridge/core`. This package translates a
wire format into a call and back.

## Status (M26)

| Thing | State |
|---|---|
| Tool surface, schemas, error mapping, daemon client | written, tested |
| `@modelcontextprotocol/sdk` | installed and pinned at `^1.30.0` — the version every call was run against |
| `src/server.ts` — the two transport bindings | typechecked and run against the SDK |
| Published to npm | no — M49 |

The package builds and typechecks. Both bindings have been exercised: a live SDK client
over an in-memory transport listed the tools with the JSON Schemas the SDK projects
from their Zod shapes, and the streamable-HTTP binding answered a real `initialize`, refused
an `Origin`-bearing request with 403, and refused an unauthenticated one with 401. The API that had to be confirmed —
constructor shapes, `registerTool`'s config keys, `handleRequest`'s signature — is listed
in the block at the top of `src/server.ts`. `^1.30.0` is a floor that was run, not a guess:
earlier 1.x releases are untested and therefore unclaimed.

## The approval boundary

`forge.propose_changeset` and `forge.apply_changeset` are separate tools so that a model
cannot clear its own work ([ADR-012](../../docs/architecture/adr-012-approval-gated-apply.md)).
On this connector the separation is structural rather than conditional:

- **`forge.propose_changeset`** submits a ChangeSet, which the daemon validates against the
  project's path policy, and returns its id and a rendered diff. Nothing is queued for
  Roblox Studio and nothing changes in the place.
- **`forge.apply_changeset`** cannot approve. It reads the ChangeSet's status and reports
  it. If a human has not approved, it refuses with `not_approved` and tells the calling
  model to ask the user. Chaining propose → apply always fails.
- **`forge.rollback` is gated the same way.** A rollback is a write: it reverses an apply
  the user may have wanted. The daemon gates `POST /v1/journal/:id/rollback` on the producer
  token and nothing else, and this process holds that token — so the tool refuses with
  `not_approved` unless a `RollbackGate` (`src/approval.ts`) yields a grant for that exact
  journal id. Grants are per journal entry and single use, so a human clearing ChangeSet A
  never authorises reversing journal B, and `record` is an in-process method no tool call,
  argument or JSON-RPC method can reach.
- **There is no approve call anywhere in this package.** `DaemonClient` has no `approve()`
  method, no tool maps to `POST /v1/changesets/:id/approve`, and `test/approval-boundary.test.ts`
  asserts that no request any tool makes reaches an approve path — including one assembled
  out of a model-supplied id.

Approval happens somewhere this connector cannot reach: in the Studio plugin, which decides
on arrival rather than trusting the verdict that travelled with the ChangeSet, or through a
ForgeBridge client the human drives themselves.

Two limits worth stating plainly rather than leaving to be discovered:

1. **The producer token is shared.** The daemon authenticates producers with one
   process-wide token, and this server holds it because it needs it to propose at all. A
   *different* process holding that token could approve. The boundary this package provides
   is that the model's tool surface has no such call — not that the token cannot be used
   for one. The gate that does not depend on the token is the plugin's own approval step in
   Studio. This is also why the HTTP binding authenticates: anything that reached that port
   unauthenticated would be holding the producer token by proxy.
2. **`--dangerously-skip-permissions`-style client settings are not a ForgeBridge
   concern.** A client that auto-approves *tool calls* is auto-approving proposals, which is
   fine; it cannot auto-approve the ChangeSet, because no tool here does that.

## Tools

The twelve names are fixed by [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §5.
Every input schema is derived from `@forgebridge/protocol` rather than redeclared, so the
protocol's refusals — a path segment that is not a safe identifier, a `setProperty` on
`Parent` or `Name`, more than 500 operations — apply to an MCP caller unchanged.

| Tool | Serves | Notes |
|---|---|---|
| `forge.list_projects` | `GET /v1/link` | projects and their paired Studio sessions |
| `forge.read_tree` | — | **refuses with `not_found`**: no `/v1` tree endpoint exists (M09 owns the snapshot, M31 agrees the shape) |
| `forge.read_script` | — | **refuses with `not_found`**, same reason |
| `forge.start_run` | `POST /v1/runs` | hands the prompt to the daemon's own model and returns the ChangeSet it proposed, in `validated`; carries every `ModelAttempt` the router made |
| `forge.propose_changeset` | `POST /v1/changesets` then `GET …/diff` | validates and records; applies nothing |
| `forge.diff_changeset` | `GET /v1/changesets/:id/diff` | also how you check whether a human approved yet |
| `forge.apply_changeset` | `GET /v1/changesets/:id/diff` | reports; refuses `not_approved` for anything a human has not cleared |
| `forge.run_tests` | — | **refuses with `provider_unconfigured`**: the Sandbox port has no adapter (M13) and `/v1` has no test endpoint (M31/M41) |
| `forge.rollback` | `POST /v1/journal/:id/rollback` | **refuses with `not_approved`** unless a `RollbackGate` cleared this journal id; then dispatched, not completed — the inverses live on the plugin |
| `forge.tail_output` | `GET /v1/output` | what Studio printed |
| `forge.list_models` | `GET /v1/models` | the synced catalog and its live health |
| `forge.link_status` | `GET /v1/link` | transport and what it implies about who can read your changes |

### Which tool writes the operations

`forge.propose_changeset` and `forge.start_run` end in the same place — a ChangeSet the
daemon validated and nobody approved — and differ only in who wrote the operations. Use
propose when the calling model wrote them; use start_run to hand the prompt to the model the
daemon routes to. A run is not a shortcut past the gate, and its input shape has no field
that reaches one.

`forge.start_run` returns `attempts` whole: every model the router tried, in order, with
why it moved on ([ADR-008](../../docs/architecture/adr-008-capability-router-with-visible-fallback.md)).
The code came from the model named in the last `ok` attempt, which may not be the one that
was asked for, so the description tells the calling model to report that list as it stands.

The four that refuse say so in their description text as well as in their answer, because
that text is what the calling model reads before it decides to try. Three of them refuse
because the endpoint behind them does not exist yet; `forge.rollback` refuses because
nobody has said yes, which is a different thing and its description says which.

`baseVersion` has no read endpoint either: a fresh project is `0`, and a wrong value is
refused with `stale_base` naming the version the project is actually at, which is the
number to rebuild against. TODO(M31) — an additive `/v1` read would make that a lookup
rather than a probe.

## Running it

Not on npm (TODO(M49) — release engineering publishes it). There is no `npx` command to
copy, and inventing one that 404s today would be worse than saying so. Run it from a clone:

```bash
# once, at the repository root — this is what installs the MCP SDK (M26)
npm install
npm run build
```

Then start the daemon, which prints a producer token and a pairing code:

```bash
forgebridge-daemon
```

The MCP server is `packages/mcp/dist/bin.js`. It speaks stdio by default:

```bash
FORGEBRIDGE_PRODUCER_TOKEN=<the token the daemon printed> \
  node /absolute/path/to/forgebridge/packages/mcp/dist/bin.js --stdio
```

or streamable HTTP for a remote client:

```bash
FORGEBRIDGE_PRODUCER_TOKEN=<the token the daemon printed> \
  node /absolute/path/to/forgebridge/packages/mcp/dist/bin.js --http --port 7318
```

which prints, on stderr, the bearer token that binding requires:

```
forgebridge-mcp: streamable HTTP on http://127.0.0.1:7318/mcp, daemon http://127.0.0.1:7317
forgebridge-mcp: bearer token: 8Qk1…
forgebridge-mcp: send it as "Authorization: Bearer <token>"; requests without it are refused with 401.
```

The HTTP binding serves `POST /mcp`, binds `127.0.0.1` unless told otherwise, checks the
`Host` header, refuses any request carrying an `Origin`, and **requires that bearer token
on every request**. Four checks answering four different questions; only the last is
authentication.

The token is minted per process unless `--http-token` / `FORGEBRIDGE_MCP_TOKEN` names one,
it is compared with `timingSafeEqual` behind a length check, and **there is no way to turn
it off**. Loopback is not an authentication boundary — `packages/daemon/src/envelope.ts`
says exactly that about the daemon's own port — and every request this binding accepts is
served by a tool server backed by the daemon's producer token. An open port here is that
token handed to whatever process found it. An opt-out was considered: the only honest
version would be the daemon refusing to issue a producer token to an unauthenticated MCP
binding, and the daemon cannot see how its token is being used, so the flag would disable
the boundary with nothing anywhere to compensate.

The stdio binding needs none of this. It is a child process the client spawned, and the
parent is the trust boundary.

## Client configuration

Every block below is real and copy-pasteable. Replace `/absolute/path/to/forgebridge` with
your clone, and the token with the one the daemon printed. The token is a secret: it goes
in the client's config file, not in a shared repository.

### Claude Code

Project-scoped, in `.mcp.json` at the root of the project you are working in:

```json
{
  "mcpServers": {
    "forgebridge": {
      "command": "node",
      "args": ["/absolute/path/to/forgebridge/packages/mcp/dist/bin.js", "--stdio"],
      "env": {
        "FORGEBRIDGE_PRODUCER_TOKEN": "the-token-the-daemon-printed"
      }
    }
  }
}
```

Or from the command line:

```bash
claude mcp add forgebridge --env FORGEBRIDGE_PRODUCER_TOKEN=the-token-the-daemon-printed -- node /absolute/path/to/forgebridge/packages/mcp/dist/bin.js --stdio
```

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config), same shape:

```json
{
  "mcpServers": {
    "forgebridge": {
      "command": "node",
      "args": ["/absolute/path/to/forgebridge/packages/mcp/dist/bin.js", "--stdio"],
      "env": {
        "FORGEBRIDGE_PRODUCER_TOKEN": "the-token-the-daemon-printed"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "forgebridge": {
      "command": "node",
      "args": ["/absolute/path/to/forgebridge/packages/mcp/dist/bin.js", "--stdio"],
      "env": {
        "FORGEBRIDGE_PRODUCER_TOKEN": "the-token-the-daemon-printed"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "forgebridge": {
      "command": "node",
      "args": ["/absolute/path/to/forgebridge/packages/mcp/dist/bin.js", "--stdio"],
      "env": {
        "FORGEBRIDGE_PRODUCER_TOKEN": "the-token-the-daemon-printed"
      }
    }
  }
}
```

Only the spawned-process form is given here. Windsurf's key for a remote server is not one
this file is confident of, so it is not written down — use the stdio form, or check
Windsurf's own documentation.

### Cline

Open the MCP Servers pane in the Cline sidebar and choose *Configure MCP Servers*, which
opens `cline_mcp_settings.json`. The path differs by editor build, which is why it is not
written here:

```json
{
  "mcpServers": {
    "forgebridge": {
      "command": "node",
      "args": ["/absolute/path/to/forgebridge/packages/mcp/dist/bin.js", "--stdio"],
      "env": {
        "FORGEBRIDGE_PRODUCER_TOKEN": "the-token-the-daemon-printed"
      },
      "disabled": false
    }
  }
}
```

### Everything else

ADR-009 names Roo, Kilo, Continue, OpenCode, Copilot agent mode and ChatGPT connectors as
targets of this one implementation. **No configuration for those is given here, because
none has been verified.** They speak MCP, so a stdio server should reach them, but the file
each one reads and the key each one uses are not facts this package can assert without
having tried them. What has been run is the reference SDK's own `Client`, which is what
verifies the wire surface; M31 is the conformance suite that would cover the editors.

One risk to check when you do: the MCP specification does not constrain tool-name
characters, but a client that projects tools into an OpenAI-style function schema inherits
that grammar, which is `[A-Za-z0-9_-]` and excludes the dot in `forge.list_projects`.
Whether any shipping client actually refuses it is **not known here**. If one does,
`--tool-name-separator _` registers the same twelve tools as `forge_list_projects`.

## Configuration

| Flag | Environment | Default |
|---|---|---|
| `--stdio` / `--http` | `FORGEBRIDGE_MCP_TRANSPORT` | `stdio` |
| `--daemon-url <url>` | `FORGEBRIDGE_DAEMON_URL` | `http://127.0.0.1:7317` |
| `--producer-token <t>` | `FORGEBRIDGE_PRODUCER_TOKEN` | none — required |
| `--project <uuid>` | `FORGEBRIDGE_PROJECT_ID` | the daemon's default project |
| `--host <host>` | `FORGEBRIDGE_MCP_HOST` | `127.0.0.1` |
| `--port <port>` | `FORGEBRIDGE_MCP_PORT` | `7318` |
| `--http-token <token>` | `FORGEBRIDGE_MCP_TOKEN` | minted per process, printed once at startup |
| `--tool-name-separator <c>` | `FORGEBRIDGE_MCP_TOOL_SEPARATOR` | `.` |

An `--http-token` shorter than 16 characters is refused rather than accepted: choosing your
own token must not be quietly weaker than not choosing one. An empty value is treated as
"none supplied" and mints one, so the shape someone reaches for when they mean to switch
authentication off fails closed instead.

The daemon URL default is imported from `@forgebridge/daemon`, not written down twice: the
daemon's port is fixed because Roblox scopes a plugin's HTTP permission per address, and a
connector with its own copy of the number is a connector that keeps working until the day
the daemon moves.

Every diagnostic goes to stderr. Under stdio, stdout is the JSON-RPC channel and a single
stray line on it corrupts the stream.

## Errors

The protocol's `ErrorCode` is a closed set so a consumer can branch on it, and this
connector keeps it that way. A refusal reaches the calling model as a tool result with
`isError: true` carrying the code, the HTTP status, the daemon's own message and remedy,
whether retrying could ever help, and one sentence saying what the agent should do instead:

```json
{
  "error": {
    "code": "not_approved",
    "httpStatus": 403,
    "message": "changeset 5f… has not been approved (status: validated)",
    "remedy": "Ask the user to review the diff and approve it in Roblox Studio or in their ForgeBridge client.",
    "retryable": true,
    "agentShould": "A human has not approved this ChangeSet yet. Report the changeset id to the user and ask them to approve it…"
  }
}
```

A refusal is a tool result rather than a JSON-RPC error on purpose: `stale_base` is not a
malformed call, it is the protocol telling the caller to rebase, and that is an instruction
only the model can follow. Reporting it as a transport failure would hide the one sentence
that resolves it. No stack trace crosses the boundary; an unrecognised throw becomes a
detail-free `internal`, the same rule the daemon applies to its own responses.

## Tests

```bash
npm run test
```

Nine files, covering tool registration and the exact twelve names, schema validation
rejecting malformed input, the propose/apply separation, error-code mapping, the daemon
client's headers and refusal handling, transport selection, and the HTTP binding's
authentication, and the connector conformance suite. The three that matter most:

- `test/approval-boundary.test.ts` drives a recording stand-in for `/v1` and asserts that an
  agent cannot chain propose → apply, that no tool under any arguments issues a request to
  an approve path, and that `forge.rollback` refuses an uncleared journal id *without
  reaching the daemon* — the daemon would have accepted it, since this process holds the
  producer token. Its control is the case the gate must not break: a journal entry a human
  did clear still dispatches, and a clearance for one entry does not carry to another.
- `test/http-auth.test.ts` runs the real binding on an ephemeral port and asserts that an
  unauthenticated request is refused with 401 before it is even routed, that a token of the
  wrong *length* is that same 401 rather than the 500 an unguarded `timingSafeEqual` throws,
  that `timingSafeEqual` is what does the comparing, and — the control — that a request
  carrying the token still gets a real `initialize` answered.
- `test/conformance.test.ts` runs [`@forgebridge/conformance`](../conformance/README.md)
  against a live daemon, through `registerForgeBridgeTools` rather than by calling handlers
  — the registration wrapper is what a calling model's failures actually come back through.
  Eleven cases pass; `tree-read` reports `unsupported`, because `forge.read_tree` refuses in
  the protocol's own words and the suite records that as the gap it is. The approval it
  needs comes from an object the adapter cannot reach, which is the only version of that
  test worth running.

`src/server.ts` is the one file that imports the SDK, and `register.ts` describes the slice
of it this package calls as a structural interface — `createForgeBridgeServer` assigns the
real `McpServer` to that interface uncast, so an SDK upgrade that changes the shape is a
compile error rather than a runtime surprise. Everything above that line is tested against
a recording double.

## Open TODOs

| TODO | What it is waiting for |
|---|---|
| `TODO(M31)` in `src/tools.ts` | a `/v1` read for a project's current tree version, and one for a ChangeSet's per-operation `ApplyResult` |
| `TODO(M31)` in `src/daemon-client.ts` | a protocol error code for "the transport is not reachable"; today it lands on `internal` and carries the truth in its remedy |
| `TODO(M31)` in `src/config.ts` | whether any client actually refuses a dot in a tool name |
| `TODO(M28)` in `src/approval.ts` | a durable, cross-process approval path to record rollback grants into — until it exists, `forgebridge-mcp` run from the command line has no gate to offer and `forge.rollback` refuses every call. It is also where this gate and A2A's, now two hand-copies of one idea, should be merged |
| `TODO(M49)` | publishing to npm, so there is an `npx` command worth writing down |

`forge.read_tree`, `forge.read_script` and `forge.run_tests` are not TODOs in this package:
they need endpoints and adapters that belong to other milestones (M09/M13/M31/M41), and
until those exist the honest implementation is the one here — refuse, name the code, and
tell the model to ask the human instead. `forge.rollback` refusing is not a TODO either: it
is what the tool is supposed to do until a human says otherwise, and the M28 row above is
about giving them somewhere to say it, not about removing the gate.
