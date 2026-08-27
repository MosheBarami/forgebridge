# @forgebridge/sdk-ts

A typed TypeScript client for the ForgeBridge `/v1` surface. Node 22+.

**Not published.** The package is marked `private`, so `npm publish
--workspaces` skips it by construction rather than by anyone remembering to, and
there is no `npm install @forgebridge/sdk-ts` that installs it — writing that
command here would send a reader to a 404. Whether the marker comes off is `M49`'s
to decide, because that milestone owns how everything in this repository is
released together. Until then it is used from a checkout, as a workspace
dependency:

```jsonc
// package.json, inside this repository
{ "dependencies": { "@forgebridge/sdk-ts": "*" } }
```

## Most of it is generated

`src/generated/wire.ts` and `src/generated/routes.ts` are written by
`scripts/generate.ts` from `packages/protocol/schema/openapi.json` — the OpenAPI
3.1 document the root `scripts/generate-schemas.ts` projects from the Zod
contract and checks against the daemon's own router. Editing them by hand
changes a copy of the protocol; `npm run generate --workspace @forgebridge/sdk-ts`
rewrites them, and `test/generated.test.ts` fails on any difference.

Everything else in `src/` — the client, the errors, the event-stream reader — is
written by hand.

### Two kinds of schema, and the difference matters

A component whose name `@forgebridge/protocol` already exports as a Zod schema is
**bound to that export**, not re-derived from its JSON Schema:

```ts
export const ChangeSet = protocol.ChangeSet;
```

The two would agree today — the JSON Schema was projected from that very export
— and agreeing today is not the property worth having. A projection can only
*lose* constraints, and
[`packages/protocol/schema/README.md`](../protocol/schema/README.md) lists the
ones it loses; a second Zod built from the lossy side would be a validator
quietly weaker than the contract it exists to enforce.

The practical consequence is visible in one place. `packages/sdk-python` has a
`check_changeset_ordering` helper, because the ChangeSet ordering rule is a
`.superRefine()` body and does not survive the projection into JSON Schema. This
SDK has no such helper and needs none: `proposeChangeSet` parses with the
protocol's own schema, so it refuses the same set the daemon would, before the
request leaves the process.

What *is* projected is exactly the daemon's own request and response shapes —
`ChangeSetDiff`, `RunResponse`, `JournalStateResponse` and the rest. They live in
`packages/daemon/src/wire.ts`, which a client package must not import: that would
make everything embedding this SDK depend on a server.

## Propose and approve are two calls

```ts
import { ForgeBridgeClient } from '@forgebridge/sdk-ts';

const client = new ForgeBridgeClient({ baseUrl, producerToken });

const submitted = await client.proposeChangeSet(changeSet); // stored and validated
const reviewed = await client.getDiff(submitted.changeSetId); // a human reads this
await client.approveChangeSet(submitted.changeSetId, {       // a human decides this
  contentDigest: reviewed.contentDigest,
  approvedBy: 'alex',
});
```

There is no method that does both, and there will not be one. ADR-012 puts a
person between the two steps; a helper that chained them would let a model
approve its own work, which is the single thing the approval gate exists to stop.

`contentDigest` is why the diff is read into a variable rather than printed and
thrown away. The daemon refuses an approve whose digest does not match the
operations it holds, so the field is what turns "I approve set X" into "I approve
the operations I was shown for set X" — and `ApproveRequest` has no default for
it, so a producer cannot skip the binding by accident.
`test/client.test.ts` asserts that neither `proposeChangeSet` nor `startRun` ever
issues a request whose URL contains `/approve`.

## A run is on the propose side of that line

```ts
const run = await client.startRun({ prompt: 'add a respawn handler' });

for (const attempt of run.run.attempts) {          // every model, in order
  console.log(attempt.modelId, attempt.outcome);   // glm-5.2:free rate-limited
}                                                  // minimax-m3:free ok
console.log(run.changeSetId, run.changeSetStatus); // … validated
```

`startRun` hands the prompt to the model the daemon routes to and returns the
ChangeSet it proposed. It is not a shortcut past the gate: the set comes back
`validated`, and clearing it is still `approveChangeSet`. `StartRunRequest` has
no field that reaches approval and none that carries a validation — a producer
cannot send a verdict of its own, because there is nowhere to put one.

`run.run.attempts` is the whole list, never only the model that succeeded
([ADR-008](../../docs/architecture/adr-008-capability-router-with-visible-fallback.md)).
The code came from the model in the last `ok` attempt, which may not be the one
that was asked for, so a caller that reports only the winner is misreporting who
wrote it.

**A run waits on a language model**, and on the router's fallback through however
many models the policy allows. Pass a listener to follow it as it happens; the
answer is the same `RunResponse` either way, because the streamed form's last
`run` frame *is* the JSON body.

```ts
await client.startRun({ prompt }, (frame) => console.error(frame.name));
await client.watchRun(runId, { since: 0, onFrame: (frame) => console.error(frame.name) });
```

With a listener the wall-clock timeout is replaced by an idle ceiling: a stream
that goes quiet is a dropped connection, whereas a model that thinks for four
minutes and then answers is a run that worked, and no wall-clock limit tells
those apart.

## Every failure reduces to a code you can branch on

```ts
import { describeError } from '@forgebridge/sdk-ts';

try {
  await client.proposeChangeSet(changeSet);
} catch (failure) {
  const view = describeError(failure);
  if (view.code === 'stale_base') {
    // rebuild against the current version
  } else if (view.code === 'not_approved') {
    // go and find a human; no call here can do it
  } else if (!view.recognised) {
    // nobody said anything; this is not a decision
  }
}
```

`describeError` contains no judgement a caller does not already make —
`catch (e) { if (e instanceof ForgeBridgeError) e.code }` and
`e instanceof TransportError` are the same two branches. It exists because those
branches are a *shape* rather than a value, and a shape cannot be handed to
something generic: a retry policy, a router deciding whether to rebase or to ask
a person, or the connector conformance suite all need the answer as data.

Two properties are load-bearing, and `test/errors.test.ts` checks both. It is
**total** — every input returns a view and none raises. And `recognised` is
`false` whenever the answer was defaulted: an unreachable daemon is reported as
`internal` because the protocol has no code for "the transport is not reachable"
(`TODO(M31)`), never as `not_approved`, which would be this package inventing an
approval decision out of a network event.

## The route table is the client's only idea of the surface

Every method names the operation it calls and the schema it expects, and both are
checked against the generated table before a request goes out:

- a method that named `getHealth` and parsed the answer as a `LinkStatusResponse`
  throws `RouteContractError` rather than returning a wrong shape;
- a path parameter the route does not declare, and a query parameter it does not
  declare, are both refused — a typo in a query name would otherwise be sent,
  ignored by the daemon, and read as "the filter did nothing";
- `OPERATION_COVERAGE` is a `Record<OperationId, …>`, so a route added to the
  document and to nothing here fails `tsc`.

## Consumer routes need a MAC this package does not compute

`poll`, `reportApplyResult`, `recordJournalEntry`, `reportRollbackResult` and
`mirrorOutput` are authenticated by a MAC over the request under the session key
derived at pairing. The derivation lives in `packages/daemon/src/envelope.ts` and
is not written down anywhere a second implementation could be built against
without guessing at it, so this client takes the MAC as a parameter and the
envelope already sealed. `TODO(M18)`: a written specification of the pairing
handshake, after which a key-deriving consumer client can be built against the
specification rather than against one TypeScript file.

## Tests

```bash
npm run test --workspace @forgebridge/sdk-ts
```

`test/conformance.test.ts` runs the whole `@forgebridge/conformance` matrix
against a live daemon, like every other connector, and runs the three
`approvalCheats` against this adapter to watch the suite go red. Every case
passes except `tree-read`, which reports `unsupported` for every connector
because `/v1` serves no tree snapshot.

Unlike `packages/sdk-python`, this connector answers `surface-portable` rather
than declaring it unsupported: its advertised operation list is `OPERATION_IDS`,
projected from the same document the client is driven by, so what it says it can
do and what it can do are the same object.

## Example

[`examples/typescript`](../../examples/typescript) is a runnable, three-step
walk-through against a local daemon — propose, read the diff, approve — split
across two scripts on purpose, because the gate between them is a person.
