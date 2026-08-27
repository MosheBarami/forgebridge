# @forgebridge/a2a

The A2A (Agent2Agent) connector. It makes ForgeBridge reachable by agent orchestrators and
other agents, rather than only by an editor holding an MCP client.

It serves an Agent Card at the well-known path, answers the A2A task surface over JSON-RPC,
and translates each call into one request against the daemon's `/v1` endpoints. There is no
business logic here — that is ADR-009, and it is the reason this package is mostly
translation and tests.

**A calling agent may propose a change and read a diff. It cannot apply one.** See
[The approval boundary](#the-approval-boundary).

---

## Which specification this was built against

Everything in `src/spec.ts` was transcribed from **A2A `v1.0.1`**, read at that tag of the
specification repository:

| Source | Path | Read at |
|---|---|---|
| Prose specification | `docs/specification.md` | tag `v1.0.1` of `github.com/a2aproject/A2A` |
| Canonical data model | `specification/a2a.proto` | tag `v1.0.1` of the same repository |

The negotiated protocol version is `1.0` — `Major.Minor` only, because §3.6 says patch
numbers "MUST not be considered when clients and servers negotiate protocol versions".

Two conventions from §5.5 govern every shape on the wire and are the two most common ways
to get an A2A implementation subtly wrong:

- JSON field names are **camelCase**, not the proto's snake_case (`contextId`, not `context_id`).
- Enum values are the **proto's SCREAMING_SNAKE_CASE names**: `"TASK_STATE_WORKING"`, not
  `"working"`. A2A before 1.0 used the lowercase forms; a client written against those will
  not recognise anything this connector sends.

`docs/MILESTONES.md` describes M27 as serving `/.well-known/agent.json`. That was the path
before A2A 0.3.0. The current specification registers `/.well-known/agent-card.json` (§8.2
and §14.3) and that is what this package serves; the old path returns 404, because the
document that used to live there had a different shape and answering with a 1.0 card would
hand a 0.3 client something it cannot read.

---

## What is implemented

| A2A method (§5.3) | Status |
|---|---|
| `SendMessage` | implemented — blocking by default, `returnImmediately` honoured |
| `GetTask` | implemented, with `historyLength` semantics per §3.2.4 |
| `ListTasks` | implemented — filters on `contextId`, `status`, `statusTimestampAfter`; cursor pagination |
| `CancelTask` | implemented |
| `SendStreamingMessage` | **not implemented** — `capabilities.streaming` is `false`, so §3.3.4 requires `UnsupportedOperationError` |
| `SubscribeToTask` | **not implemented** — same reason, same error |
| `CreateTaskPushNotificationConfig` | **not implemented** — `capabilities.pushNotifications` is `false`, so §3.3.4 requires `PushNotificationNotSupportedError` |
| `GetTaskPushNotificationConfig` | **not implemented** — same |
| `ListTaskPushNotificationConfigs` | **not implemented** — same |
| `DeleteTaskPushNotificationConfig` | **not implemented** — same |
| `GetExtendedAgentCard` | **not implemented** — `capabilities.extendedAgentCard` is `false`, so §3.3.4 requires `UnsupportedOperationError` |

The unimplemented half is declared as absent on the Agent Card rather than left silent.
That is the difference between a client discovering the limitation at discovery time and
discovering it by hanging on a stream that never opens.

**Bindings.** Only the JSON-RPC binding (§9) is implemented, and it is the only one the
card declares. The gRPC binding (§10) and the HTTP+JSON/REST binding (§11) are absent.

**Also not implemented:**

- **JSON-RPC batching.** A batch is an array, and an array is answered with `-32600`.
  Nothing in A2A requires batch support; it is a JSON-RPC 2.0 feature this binding does not
  offer.
- **Agent Card signing** (§8.4). The card carries no `signatures` array. Signing needs a key
  and a distribution story for the JWKS, neither of which exists yet.
- **`TASK_STATE_INPUT_REQUIRED`.** No skill asks a caller for more input mid-task, so no
  task ever enters it. It is in the transition table because the lifecycle is the
  specification's, not this connector's.
- **Extended Agent Card** (§3.1.11, §13.3). The public card is the whole card.

---

## Skill invocation v1

A2A has no skill-invocation mechanism. §4.4.5 defines a skill as an id, a description and
some tags, and calls skills "largely a descriptive concept"; there is no field anywhere in
`SendMessageRequest` that says which one a caller wants. An agent is expected to work it out
from the message.

ForgeBridge does not work it out from prose, and should not try: these operations write into
a Roblox place someone may have spent months on, and inferring "you probably meant apply"
from free text is exactly the failure ADR-012 exists to prevent. So the invocation is
explicit, and it is declared on the card as an A2A extension (§4.6.1) with this URI:

```
https://github.com/MosheBarami/forgebridge/tree/main/packages/a2a#skill-invocation-v1
```

The extension is marked `required: true`, which under §3.3.4 means a caller that has not
declared support for it is refused with `ExtensionSupportRequiredError`. Declare it in the
`A2A-Extensions` request header or in `message.extensions` — §4.6.1 shows both.

**The convention.** A message carries **exactly one `data` Part** whose value is:

```json
{ "skill": "<skill id>", "input": { } }
```

Other parts may accompany it; exactly one carries the invocation, so there is never a
question of which of two data parts was meant. A message that names no skill, or names two,
comes back as a task in `TASK_STATE_REJECTED` — not as a JSON-RPC error, because the
message was a well-formed A2A message and this agent has simply decided not to perform what
it asked for, which is what that state means.

Every skill's input schema is strict: an unrecognised key is refused rather than dropped.

### The seven skills

| Skill id | Input | Writes to the place? |
|---|---|---|
| `start-run` | `{ prompt, projectId?, policy?, pinnedModel?, baseVersion?, maxAttempts? }` | no |
| `propose-changeset` | `{ changeSet }` — a `ChangeSet` from `@forgebridge/protocol` | no |
| `review-changeset-diff` | `{ changeSetId }` | no |
| `apply-approved-changeset` | `{ changeSetId }` | **yes — approval-gated** |
| `rollback-apply` | `{ journalId, expectedVersion, reason? }` | **yes — approval-gated** |
| `query-models` | `{}` | no |
| `studio-link-status` | `{}` | no |

`start-run` and `propose-changeset` end in the same place — a ChangeSet the daemon
validated and nobody approved — and differ only in who wrote the operations. A run hands the
prompt to the model this ForgeBridge instance routes to; a proposal carries operations the
calling agent wrote itself. Neither is a way past the gate, and `StartRunInput` has no field
that reaches one.

A run's artifact carries `run.attempts` whole: every model the router tried, in order, with
why it moved on ([ADR-008](../../docs/architecture/adr-008-capability-router-with-visible-fallback.md)).
The status message collapses it into one line — `glm-5.2:free → rate-limited →
minimax-m3:free` — using the protocol's own renderer, so every ForgeBridge surface says it
the same way. The code came from the model in the last successful attempt, which may not be
the one that was asked for, and the skill's description says so on the card.

Results come back as **artifacts**, not messages — §3.7 is explicit that "Messages SHOULD
NOT be used to deliver task outputs". Each artifact carries a `data` Part with the daemon's
response verbatim and a `text` Part summarising it.

---

## The approval boundary

This is the part worth reading twice.

ADR-012 separates propose from apply so that a model cannot clear its own work. The daemon
enforces that split at its endpoints — but it enforces it against a *caller*, and it
identifies callers with one process-wide producer token. Whoever holds that token may submit
a ChangeSet, and whoever holds it may approve one.

This connector holds the token. It has to; it cannot propose without it. So if it forwarded
an A2A "apply" straight through to `POST /v1/changesets/:id/approve`, every remote agent
that could reach this port would be holding the producer token by proxy. Two calls, one
principal, one after the other, on that principal's own say-so: self-approval with extra
steps.

The rule here is therefore structural rather than procedural:

- **No code path exists from an inbound A2A request to an approve or a rollback.** The
  backend's `approve` and `rollback` methods take an `ApprovalGrant` and cannot be called
  without one, so the compiler refuses a call that has not obtained a grant.
- **Grants come only from an `ApprovalGate`**, whose `consume(skill, subject)` takes the
  identifier of the thing being approved and nothing else. There is no parameter through
  which a request can describe, hint at, or assert its own authorisation.
- **The caller cannot name its own approver, confirm its own bulk delete, or say which
  content it reviewed.** Those fields live on the grant. `apply-approved-changeset`'s input
  schema is strict, so a caller that sends `approvedBy` is refused outright rather than
  having the field quietly dropped.
- **A grant names content, not just an id.** `ApplyApprovalGrant.contentDigest` is required,
  and it is the digest `GET /v1/changesets/:id/diff` reported to the human who read it. The
  daemon refuses an approve whose digest does not match the operations it holds, so a "yes"
  covers the operations that were read and nothing that arrives on that id afterwards.
- **The default gate approves nothing.** `DENY_ALL_APPROVALS` is the default for the same
  reason the daemon defaults to `DENY_ALL_POLICY`: a half-configured connector should be one
  that can propose and read and cannot write.
- **`LocalOperatorApprovalGate.record()` is an in-process method.** No JSON-RPC method, HTTP
  route or message shape reaches it. A local approver — the CLI (M28), a local UI, the Studio
  plugin's own confirmation — calls it; a remote agent cannot.
- **Grants are single-use and scoped to one subject and one skill.** One human "yes" is one
  apply.

An apply with no grant returns a task in `TASK_STATE_AUTH_REQUIRED` — an *interrupted*
state, not a failure, because the request was legitimate and is waiting on a human. Re-send
the same request after approval and the task resumes.

**Rollback is gated the same way, which is stricter than it strictly needs to be.** Rollback
restores a previous state, so it is arguably safe. It also writes to the user's place, and a
remote agent reversing work a human approved is a real harm. A remote agent is less trusted
than a local editor, not more.

The claims in this section are the subject of `test/approval.test.ts`, which asserts them by
checking whether the backend was ever *reached* — a connector that called approve and then
reported a failure would still have written to the place.

---

## Task lifecycle

The specification defines the states (§4.1.3), which are terminal, and which are interrupted.
It publishes no edge list, so the table below is this connector's, derived from those three
facts and enforced by `TaskStore.transition`, which throws on an illegal move rather than
writing it.

```
SUBMITTED ──▶ WORKING ──▶ COMPLETED          terminal: COMPLETED FAILED
    │            │   │                                 CANCELED REJECTED
    │            │   ├──▶ FAILED
    │            │   ├──▶ REJECTED           interrupted: INPUT_REQUIRED
    │            │   ├──▶ INPUT_REQUIRED                  AUTH_REQUIRED
    │            │   └──▶ AUTH_REQUIRED ──┐
    │            │                        │   (a new message resumes it)
    ├──▶ REJECTED                         └──▶ WORKING
    │
    └──▶ CANCELED  ◀── from any non-terminal state
```

`TASK_STATE_UNSPECIFIED` is the proto's zero value and is never entered; it has a row with
no outgoing edges so that an accidental write of it fails closed instead of behaving like
`SUBMITTED`.

The illegal transitions — a terminal state moving anywhere, `SUBMITTED` skipping `WORKING`,
anything entering the zero value — are covered in `test/lifecycle.test.ts`.

A `CancelTask` on a terminal task returns `TaskNotCancelableError`, which §3.3.2 describes
for exactly that case. Cancelling stops this connector from reporting further; it does not
recall work already handed to the daemon. An approved ChangeSet is queued for the Studio
plugin, and cancelling the A2A task that requested it does not un-queue it. Rollback is the
mechanism for undoing an apply, and it is a separate, separately-approved skill.

---

## Errors

A2A splits failure into two layers and this connector keeps them apart.

**Layer 1 — protocol failure.** The request was unusable. These are JSON-RPC error objects
(§9.5) and no task is created or changed.

| Situation | Code | Name |
|---|---|---|
| Body is not JSON | `-32700` | `JSONParseError` |
| Envelope is not a JSON-RPC request (a batch, for instance) | `-32600` | `InvalidRequestError` |
| Unknown method | `-32601` | `MethodNotFoundError` |
| Params fail validation; wrong or missing `tenant`; message on a terminal task | `-32602` | `InvalidParamsError` |
| Unknown or evicted task id | `-32001` | `TaskNotFoundError` |
| Cancel of a terminal task | `-32002` | `TaskNotCancelableError` |
| A push-notification method | `-32003` | `PushNotificationNotSupportedError` |
| Streaming, subscribe, or extended card | `-32004` | `UnsupportedOperationError` |
| The required extension was not declared | `-32008` | `ExtensionSupportRequiredError` |
| `A2A-Version` is absent or is not `1.0` | `-32009` | `VersionNotSupportedError` |

Every error carries a `data` array whose entries have the `@type` key §9.5 requires —
`google.rpc.ErrorInfo`, or `google.rpc.BadRequest` with `fieldViolations` for a validation
failure, because "Invalid parameters" alone tells a calling agent nothing it can act on and
a calling agent has no human to squint at the payload for it.

**Layer 2 — execution failure.** A task was accepted and did not succeed. This is *not* a
JSON-RPC error: §3.3.3 says operations return a Task and processing continues, so a run that
fails does so by reaching a terminal state with the reason in its status message.

The split between `REJECTED` and `FAILED` follows the proto's own definitions — `REJECTED`
is "the agent has decided to not perform the task", `FAILED` is "finished with an error" —
which matters to an orchestrator, because `REJECTED` means "do not retry this as-is" and
`FAILED` means "the same request may work later":

| ForgeBridge error code | Task state |
|---|---|
| `invalid_request`, `policy_violation`, `not_approved`, `too_large` | `TASK_STATE_REJECTED` |
| everything else — `stale_base`, `link_unpaired`, `rate_limited`, `provider_unconfigured`, … | `TASK_STATE_FAILED` |

The daemon's `remedy` is carried through, because it is the half a calling agent can act on.
Its `traceId` is not: that is support correlation for a human. A failure that is this
connector's own bug reports no detail at all — the daemon's rule that an internal error never
carries an internal detail applies with more force to a remote audience, not less.

Error mapping is covered in `test/errors.test.ts`.

---

## Version negotiation

§3.6.2 has one rule that surprises people, and this connector follows it exactly:

> Agents MUST interpret empty value as 0.3 version.

So a request with **no** `A2A-Version` header is treated as declaring 0.3, which this
interface does not speak, and is refused with `VersionNotSupportedError`. Send
`A2A-Version: 1.0`. A patch component is ignored (`1.0.7` negotiates as `1.0`), and §3.6.1's
alternative of passing the version as a request parameter is accepted too.

Serving 1.0 semantics to a client that asked for 0.3 would send it lowercase task states it
does not recognise and field names that moved. A clear refusal is the better failure.

---

## Transport

| Path | Method | Auth |
|---|---|---|
| `/.well-known/agent-card.json` | `GET`, `HEAD` | none — the card is public discovery information (§14.3) |
| `/a2a/v1` (configurable) | `POST` | `Authorization: Bearer <token>` |

The bearer token is minted per process when one is not supplied, and is readable from
`server.bearerToken` so a launcher can print it. It authenticates the calling agent; it does
not authorise applying anything.

The card is served with an `ETag` derived from its `version` and a `Cache-Control` max-age,
and answers a conditional request with 304 (§8.6.1).

JSON-RPC outcomes come back at HTTP 200 with the outcome inside the envelope, which is the
ordinary JSON-RPC-over-HTTP convention and is not contradicted by the specification: the
HTTP-status column of the §5.4 mapping table belongs to the HTTP+JSON binding (§11.6), while
§9.5 defines this binding's errors entirely in terms of the JSON-RPC error object. Non-200
statuses are reserved for failures that happen before there is an envelope — 401, 404, 405,
413, 415.

The server binds `127.0.0.1` by default. A2A is agent-to-agent and an operator will often
want it reachable from elsewhere, but that is an explicit decision with TLS in front of it,
not a default this package picks. §4.4.6 requires the advertised URL to be absolute HTTPS in
production; a non-loopback bind advertising `http://` is logged as a warning rather than
refused, because a reverse proxy terminating TLS is legitimate and this process cannot see
it.

---

## Wiring it up

```ts
import { DaemonBackend, LocalOperatorApprovalGate, createA2AServer } from '@forgebridge/a2a';

const gate = new LocalOperatorApprovalGate();

const server = createA2AServer({
  backend: new DaemonBackend({
    baseUrl: 'http://127.0.0.1:7317',
    producerToken: process.env.FORGEBRIDGE_PRODUCER_TOKEN as string,
  }),
  gate,
  endpointUrl: 'https://forgebridge.example.com/a2a/v1',
});

await server.listen();

// The only way an apply is ever cleared. Called by a local approver -- never
// reachable over A2A.
// `contentDigest` is the one the diff reported to the human who read it --
// `(await backend.diff(changeSetId)).contentDigest`. The daemon refuses an
// approve that does not echo it, so the yes is bound to what was reviewed.
gate.record({
  skill: 'apply-approved-changeset',
  subject: changeSetId,
  approvedBy: 'operator@workstation',
  contentDigest,
});
```

The daemon must be running and must have printed the producer token this process passes:

```sh
forgebridge-daemon
```

Checks:

```sh
npm run typecheck
npm run test
npm run build
```

`test/conformance.test.ts` runs [`@forgebridge/conformance`](../conformance/README.md)
against a live daemon, driving every case through a real `SendMessage` — invocation
parsing, task creation, the executor, the artifact — rather than by calling
`SkillExecutor` directly. The gate is `DENY_ALL_APPROVALS` and the approval the suite needs
arrives from an object the adapter cannot reach, which is the only version of that test
worth running. Eleven cases pass; `tree-read` reports `unsupported`, because this connector
advertises no tree-reading skill and refuses in the protocol's own words.

---

## Known gaps

Each of these is a `TODO` in the source naming the milestone that closes it.

- **`TODO(M28)` — `LocalOperatorApprovalGate` holds approvals in memory** (`src/approval.ts`).
  A connector restart discards pending approvals, and a second connector process cannot see
  approvals recorded in the first. A durable, cross-process gate belongs with the CLI that
  will record them. Owner: the CLI author.
- **`TODO(M31)` — the daemon response shapes are re-declared here** (`src/daemon-wire.ts`).
  `packages/daemon/src/wire.ts` carries the same TODO: they belong in
  `@forgebridge/protocol` so that the daemon, this connector and `apps/relay` cannot drift.
  Owner: the protocol maintainer.
- **`TODO(M31)` — the Agent Card is validated against this package's own transcription**
  (`src/card.ts`), which can only catch drift from itself. The connector conformance suite
  now runs against this package (`test/conformance.test.ts`) and checks what is
  connector-neutral — unique, portable skill ids on a compatible protocol major — but not the
  card against the published A2A JSON Schema, which would need that schema vendored here.
  Owner: the conformance-suite author.
- **`TODO(M31)` — the specification assigns no JSON-RPC error code for an authentication
  failure** (`src/server.ts`). §3.3.2 names "JSON-RPC custom error" as the representation but
  §5.4's A2A range `-32001`–`-32099` defines nine codes and none of them is one. Picking a
  number out of that reserved range risks colliding with one the working group later assigns,
  so authentication failures are answered as HTTP 401 with a `WWW-Authenticate: Bearer`
  challenge and no JSON-RPC envelope — which is defensible, since authentication is checked
  before the envelope is parsed and there is no request id to correlate an error to. **If a
  code is registered, it belongs in `A2A_ERRORS` in `src/errors.ts` and in the `unauthorized`
  function in `src/server.ts`.** Owner: whoever next re-reads the specification for a version
  bump.
