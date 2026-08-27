# @forgebridge/conformance

The connector conformance suite: one executable definition of what any ForgeBridge
connector must do, run against a live daemon.

MCP, A2A, the CLI and the SDKs all say the same seven things to the same `/v1` surface in
four different vocabularies. Written four times, they will diverge four ways — and the
divergences that matter are not cosmetic. A connector that renders `relay-tls` as a padlock
has told the user something false about who can read their code. A connector that approves
on the caller's behalf has switched off the one gate standing between a model and someone's
place. Both would pass their own unit tests.

So the behaviours live here, once, as data. A connector implements six calls and an error
classifier, and inherits every case.

## Status (M31)

| Thing | State |
|---|---|
| The twelve cases, the runner, the report | written, tested |
| Reference adapter over the daemon's `/v1` REST surface | written, run against a live daemon in `test/reference-adapter.test.ts` |
| Proof the suite can fail | twelve cheating adapters in `test/cheating-adapters.test.ts`, three more against the Python SDK in `test/python-sdk.test.ts` |
| `forgebridge-conformance` binary | written, exercised end to end in `test/bin.test.ts` |
| `@forgebridge/mcp` | passes, against a live daemon — `packages/mcp/test/conformance.test.ts` |
| `@forgebridge/a2a` | passes, against a live daemon — `packages/a2a/test/conformance.test.ts` |
| `@forgebridge/cli` | passes, against a live daemon — `packages/cli/test/conformance.test.ts` |
| The Python SDK (`packages/sdk-python`, unpublished until M30) | passes, against a live daemon — `test/python-sdk.test.ts`, over the driver in that package's `tests/conformance_driver.py` |

## The cases

| id | requires |
|---|---|
| `link-posture` | `linkStatus()` reports a `TransportKind` and the **exact** `PRIVACY_POSTURE` string the protocol assigns it |
| `projects-listed` | at least one project, with a uuid id and at most one default |
| `tree-read` | a tree whose children are addressed beneath their parents — **or** a refusal that is a protocol error carrying a remedy |
| `propose-returns-id-and-diff` | a uuid id and a diff naming the same id, the same `baseVersion`, one entry per operation — and a status that is not approved |
| `verdict-recomputed` | the `Validation` that comes back was computed by the core, not by the producer |
| `stale-base-refused` | a set built on a `baseVersion` that is not current is refused with `stale_base` |
| **`apply-refused-without-approval`** | `apply()` refuses with `not_approved` **and the ChangeSet is still unapproved afterwards** |
| `apply-unknown-changeset-is-not-found` | `apply()` on an id that was never proposed answers `not_found`, not `not_approved` |
| `apply-after-human-approval` | the identical set applies once a human — never the connector — approves it |
| `error-codes-total` | every `ErrorCode` maps to something the caller can branch on, from an exception and from the wire payload |
| `run-reports-every-attempt` | the complete `ModelAttempt` list, in order — never only the model that succeeded |
| `surface-portable` | the advertised tool/skill ids are unique, portable and on a compatible protocol major |

An **unsupported** case is a gap, not a breach: `report.ok` is about failures only. A
connector with no run surface is not a broken connector, and the honest report says so.

### Why `apply-refused-without-approval` re-reads the status

Refusing is not enough. A connector that quietly approves and *then* reports `not_approved`
passes every assertion about the response — right code, right message, no acceptance — while
the set it cleared is on its way to the user's place. So the case reads the ChangeSet back
after the refusal and requires it to still be unapproved. `test/cheating-adapters.test.ts`
contains exactly that connector, and watches it go red.

### Why `apply-unknown-changeset-is-not-found` exists

Because the cheapest way to pass the case above is `apply() { throw not_approved }`. That
connector enforces nothing, and only a second, differently-shaped failure can tell the two
apart. `apply-after-human-approval` closes the same hole from the other side.

## The adapter

```ts
interface ConnectorAdapter {
  readonly name: string;
  linkStatus(): Promise<ConnectorLinkStatus>;
  listProjects(): Promise<ConnectorProject[]>;
  readTree(projectId: string): Promise<ConnectorTree>;
  propose(input: ProposeInput): Promise<ConnectorProposal>;
  diff(changeSetId: string): Promise<ConnectorDiff>;
  apply(changeSetId: string): Promise<ConnectorApplyReport>;
  describeError(error: unknown): ConnectorErrorView;

  startRun?(input: RunInput): Promise<ConnectorRun>;         // optional
  describeSurface?(): ConnectorSurface | Promise<ConnectorSurface>; // optional
}
```

**There is no `approve()`.** Not "there is one and the suite never calls it" — it is not
declared. [ADR-012](../../docs/architecture/adr-012-approval-gated-apply.md) makes approval
an act a model cannot perform, and a conformance interface offering an approve method would
let a connector pass this suite while holding the handle on both sides of the gate.

Approval reaches the suite through `ConformanceOptions.humanApproval`, a separate object the
adapter never sees. The separation in the harness mirrors the separation in the system: an
approval the adapter could arrange for itself would prove that `apply()` works and nothing
at all about the gate.

Every shape an adapter returns is validated against `@forgebridge/protocol` schemas rather
than against strings — a connector that invents a ChangeSet status or a link state fails on
the shape, before any case-specific check runs.

## Running it

Against a daemon that is already running:

```bash
forgebridge-conformance --daemon http://127.0.0.1:7317 --token "$FORGEBRIDGE_PRODUCER_TOKEN"
```

`--approve`, `--pair <code>` and `--run` are opt-in because each reaches past a read.
`--approve` records a real approval for the fixture ChangeSet, and a paired Studio session
will apply it. `--run` starts a real run, which calls a language model through the daemon and
costs whatever that provider charges. Without them the suite only proposes — which changes
nothing in the place and costs nothing — and reports `apply-after-human-approval` and
`run-reports-every-attempt` as unsupported. `--only`, `--json`, `--list` and `--help` do what
they look like. Exit code 1 when any case fails.

From a test:

```ts
import { assertConformant, runConformanceSuite } from '@forgebridge/conformance';

const report = await runConformanceSuite(myAdapter, { humanApproval });
assertConformant(report); // throws with the case, its requirement, and its source
```

`runConformanceSuite` never throws for a failing connector — a failed case is data. It
throws only for a caller error, such as an unknown id in `only`, because a typo there would
otherwise run nothing and report success.

## Wiring a connector in

The adapter for a connector belongs **in that connector's own test tree**, not here. This
package deliberately depends on nothing but `@forgebridge/protocol` and `@forgebridge/daemon`:
if it imported `@forgebridge/mcp` in order to test it, then `@forgebridge/mcp` could not
import this package to run the suite, which is the direction the dependency actually needs
to go.

A connector adapter is a shim over calls that already exist. For `@forgebridge/mcp` it is the
tool handlers with their `textResult` payloads parsed back out; for `@forgebridge/a2a` it is
`ForgeBridgeBackend` plus the skill invocations; for the CLI it is the command functions under
`--json`; for an SDK it is the client methods. All four are written, and each one is the
shortest worked example of its own connector:

| Connector | Its adapter | What it drives |
|---|---|---|
| `@forgebridge/mcp` | `packages/mcp/test/conformance.test.ts` | tool calls through `registerForgeBridgeTools`, so a refusal arrives as the `isError` result a model actually receives |
| `@forgebridge/a2a` | `packages/a2a/test/conformance.test.ts` | skill invocations over the JSON-RPC surface |
| `@forgebridge/cli` | `packages/cli/test/conformance.test.ts` | the command functions under `--json`, reading the document a `\| jq` would have received |
| The Python SDK (`packages/sdk-python`, unpublished until M30) | `src/python/sdk-adapter.ts` | `ForgeBridgeClient`, one process over — see below |

The reference adapter in `src/reference/daemon-adapter.ts` is the worked version of the same
thing over plain REST, short enough to read in one sitting.

### The Python SDK is the exception, and why

`src/python/sdk-adapter.ts` is the one adapter that lives here rather than in the connector's
own tree, and the reason is structural rather than a judgement about where it belongs. This
suite needs a built npm workspace and a live daemon; the workflow job that lints and tests the
Python SDK has neither, and hosting a TypeScript adapter inside a package whose registry is
PyPI (M30 owns publishing it) would make that directory an npm workspace and change
`package-lock.json`.

So the split follows the language. The Python half is that package's
`tests/conformance_driver.py` — a subprocess entry point in the same shape as its
`tests/roundtrip.py`, which the cross-language schema drift proof already shells out to.
The TypeScript half is a bridge that speaks JSON lines to it and decides nothing: every value
it returns came from `ForgeBridgeClient`, and every error code came from
`forgebridge.describe_error`. `describeError` is synchronous and the classifier is in another
process, so the bridge asks for every classification it will need in one batch at startup, and
**throws** for an input it never showed the SDK rather than defaulting one to `internal` — a
bridge that guessed there would pass `error-codes-total` without asking Python anything.

This is the only connector that runs the matrix in another language, and that is most of its
value: three TypeScript connectors passing a TypeScript suite share the same zod schemas, the
same `ForgeBridgeError` and the same idea of what a ChangeSet is in memory, so their agreement
is weaker evidence than it looks. The Python SDK shares none of it.

## Proving the suite can fail

A conformance suite nobody has watched fail is decoration: every case is a claim about what
it would catch, and an untested claim about a safety check is the kind of thing discovered to
have been false on the day it mattered. `test/cheating-adapters.test.ts` therefore wraps the
reference adapter — one behaviour changed at a time — and asserts on the case that goes red.
`test/python-sdk.test.ts` does the same to the Python adapter for the three approval cheats,
because "the suite catches this" is a claim about each connector's adapter and not only about
the reference one.

| The cheat | The case that catches it |
|---|---|
| `apply()` approves the set first | `apply-refused-without-approval` |
| `apply()` approves quietly, then reports `not_approved` | `apply-refused-without-approval` (the status re-read) |
| `apply()` always throws `not_approved` | `apply-unknown-changeset-is-not-found`, `apply-after-human-approval` |
| propose echoes the producer's own verdict | `verdict-recomputed` |
| the privacy posture is paraphrased into "Secure ✅" | `link-posture` |
| a stale set is quietly rebased and resubmitted | `stale-base-refused` |
| every failure is flattened to `internal` | `error-codes-total` |
| the classifier invents a code, or throws | `error-codes-total` |
| a run reports only the model that succeeded | `run-reports-every-attempt` |
| a run credits a model with no attempt | `run-reports-every-attempt` |
| a diff reports a status outside the protocol enum | `propose-returns-id-and-diff` |

The "always throws" cheat is the instructive one: it **passes**
`apply-refused-without-approval`, and `test/cheating-adapters.test.ts` asserts that it does.
One case in isolation is not a gate.

## Completeness of the attempt list

Shape alone cannot catch a truncated `ModelAttempt` list — a run that fell back twice and
reports only the winner is perfectly well formed. So when the harness knows what the router
was scripted to do, it passes `run.expectedAttempts` and the list must match it exactly.
Without that, the case checks order and structure and **says in its notes** that completeness
was not checked. It does not claim more than it verified.

## Known gaps

- **`tree-read` reports `unsupported` against today's daemon.** `/v1` serves no tree snapshot,
  so every connector refuses the read with `not_found` and a remedy. That is an honest
  refusal, so the suite records the gap and stays green — and the case starts passing the day
  the endpoint lands, with no edit here. That is the point of having written it early:
  `run-reports-every-attempt` was on this list until `POST /v1/runs` landed, and it started
  passing without the suite being touched.
- **`run-reports-every-attempt` reports `unsupported` where there is no model to route
  between.** Two shapes qualify and only two: a connector that declares no `startRun`, and a
  deployment whose `POST /v1/runs` refuses with `provider_unconfigured` and a remedy. Every
  other refusal fails the case, because "unsupported" as the answer to any failure is the same
  as having no case at all — `test/reference-adapter.test.ts` plants a `stale_base` refusal and
  watches it go red.
- **`TODO(M31)` in `packages/a2a/src/card.ts` asked this suite to validate the Agent Card
  against the published A2A JSON Schema.** It does not. `surface-portable` checks what is
  connector-neutral — unique, portable ids on a compatible protocol major — because
  validating an A2A card against the A2A schema needs that schema vendored into this
  repository, which is a decision for the A2A package and its maintainer, not a thing to
  smuggle in through a test dependency. The narrower check is stated as what it is.
- **`surface-portable` reports dotted ids, and never fails them.** Clients that project tools
  into an OpenAI-style function schema accept only `[A-Za-z0-9_-]`, which `forge.list_projects`
  fails — but whether any shipping client actually refuses one has not been verified
  (`TODO(M31)` in `packages/mcp/src/config.ts` says so plainly). Failing a connector over an
  unverified claim would make this suite the thing that is wrong.
- **The wire shapes are transcribed here, for the third time.** `packages/daemon/src/wire.ts`
  and `packages/a2a/src/daemon-wire.ts` each carry a `TODO(M31)` asking to be promoted into
  `@forgebridge/protocol`, and this suite is named there as the forcing function. `src/shapes.ts`
  is the third copy; it describes only the fields the cases assert on, and it becomes a set of
  imports the day the promotion lands. Owner: the protocol maintainer.
- **The suite reads no per-operation `ApplyResult`.** `/v1` records one and exposes no
  producer route that returns it, so `ConnectorApplyReport.outcomes` is optional and unchecked.
  When the additive read lands, the case to extend is `apply-after-human-approval`.
- **`surface-portable` reports `unsupported` for the reference adapter and the Python SDK.**
  Neither advertises a tool list, a skill list or an Agent Card: one is plain REST and the
  other is a library. There is nothing there to be portable or not, and inventing a surface so
  the case had something to check would be the suite grading its own fixture.
