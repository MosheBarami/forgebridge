# forgebridge (Python)

Pydantic v2 models for the ForgeBridge wire protocol, and a thin client for the
`/v1` surface. Python 3.10+.

**Not published.** There is no `pip install forgebridge` that installs this
package — writing that command here would send a reader to somebody else's
project or to a 404. Publishing to PyPI with a worked example is `M30` in
`docs/MILESTONES.md`. Until then, install it from a checkout of the repository:

```bash
# M30 owns publishing this; until then it installs from a checkout only.
pip install -e packages/sdk-python
```

## The models are generated

`src/forgebridge/models.py` is written by `scripts/generate-schemas.ts` from the
Zod schemas in `packages/protocol/src`, by way of the JSON Schema and OpenAPI
documents in `packages/protocol/schema/`. Editing it by hand changes a copy of
the protocol, and the next `npm run generate:schemas` reverts the change.
`npm run verify:schemas` fails on any difference between the file and the
schemas.

Everything else in `src/forgebridge/` — the client, the error type, the checks —
is written by hand.

## What the projection does not carry

A Zod `.superRefine()` is arbitrary TypeScript, and some of it has no JSON Schema
equivalent. `packages/protocol/schema/README.md` lists every case. The one that
matters to a producer is the ChangeSet ordering rule, which is re-implemented
here rather than dropped:

```python
from forgebridge import check_changeset_ordering

issues = check_changeset_ordering(changeset)
if issues:
    raise SystemExit("\n".join(issues))
```

A schema-valid ChangeSet is not automatically a protocol-valid one. Run the check
before you send, or learn about it from a `400` instead.

## Propose and approve are two calls

```python
from forgebridge import ForgeBridgeClient
from forgebridge.models import ApproveRequest

client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token=token)

submitted = client.propose_changeset(changeset)     # stored and validated
reviewed = client.get_diff(submitted.changeSetId)   # a human reads this
client.approve_changeset(                           # a human decides this
    submitted.changeSetId,
    ApproveRequest(contentDigest=reviewed.contentDigest, approvedBy="alex"),
)
```

There is no method that does both, and there will not be one. ADR-012 puts a
person between the two steps; a helper that chained them would let a model
approve its own work, which is the single thing the approval gate exists to stop.

`contentDigest` is the reason the diff is read into a variable rather than
printed and thrown away. The daemon refuses an approve whose digest does not
match the operations it holds, so the field is what turns "I approve set X" into
"I approve the operations I was shown for set X" — and `ApproveRequest` has no
default for it, so a producer cannot skip the binding by accident.

## A run is on the propose side of that line

```python
from forgebridge.models import StartRunRequest

run = client.start_run(StartRunRequest(prompt="add a respawn handler"))

for attempt in run.run.attempts:                    # every model, in order
    print(attempt.modelId, attempt.outcome)         # glm-5.2:free rate-limited
                                                    # minimax-m3:free ok
print(run.changeSetId, run.changeSetStatus)         # ... validated
```

`start_run` hands the prompt to the model the daemon routes to and returns the
ChangeSet it proposed. It is not a shortcut past the gate: the set comes back
`validated`, and clearing it is still `approve_changeset`. `StartRunRequest` has
no field that reaches approval, and none that carries a validation — a producer
cannot send a verdict of its own, because there is nowhere to put one.

`run.run.attempts` is the whole list, never only the model that succeeded
([ADR-008](../../docs/architecture/adr-008-capability-router-with-visible-fallback.md)).
The code came from the model in the last `ok` attempt, which may not be the one
that was asked for, so a caller that reports only the winner is misreporting who
wrote it.

**A run waits on a language model**, and on the router's fallback through
however many models the policy allows. The client's `timeout` applies to it like
any other call, so construct the client with one sized for a run:
`ForgeBridgeClient(url, producer_token=token, timeout=600)`.

`stream=True` is refused rather than quietly downgraded: this client reads one
JSON answer and cannot parse a `text/event-stream` body. The streamed form of a
run is `GET /v1/runs/{id}/events`, and a Python reader for it is TODO(M30).

## Consumer routes need a MAC this package cannot compute

`poll`, `report_apply_result` and `mirror_output` are authenticated by a MAC over
the request under the session key derived at pairing. The derivation lives in
`packages/daemon/src/envelope.ts` and is not written down anywhere a second
implementation could be built against without guessing at it, so this client
takes the MAC as a parameter instead of inventing one. TODO(M30): a Python-side
pairing and MAC implementation, once `M18` has specified the handshake.

## Tests

```bash
# Run from the repository root. `packages/sdk-python` (M30) is not on PyPI.
cd packages/sdk-python
python -m pytest
python -m ruff check .
```

`tests/test_projection_agreement.py` is the Python half of the cross-language
drift proof; the TypeScript half is `scripts/__tests__/schema-projection.test.ts`,
which runs the same documents through Zod, through the JSON Schema and through
these models and compares all three.

### Not yet wired into the connector conformance suite

`@forgebridge/conformance` is the one executable definition of what a ForgeBridge
connector must do, and `@forgebridge/cli`, `@forgebridge/mcp` and
`@forgebridge/a2a` each run it against a live daemon from their own test tree.
This package does not, and the reason is structural rather than a decision about
what is worth testing:

- the suite is TypeScript, and it needs a live daemon and a built workspace to
  run against. The Python gate in `.github/workflows/ci.yml` has neither — it
  runs before `npm run build`, so nothing under `packages/*/dist` exists yet;
- and hosting the adapter here would make this directory an npm workspace, which
  changes `package-lock.json` for a package whose registry is PyPI.

So the run behaviours the suite checks are asserted here instead, against the
same requirements: `tests/test_client.py` holds that a run reports every attempt
in order, that it stops at `validated`, that no route it builds reaches
`/approve`, and that a verdict is unrepresentable on the request. That is the
same set of claims, made one language over — it is not the same *proof*, and the
difference is exactly what the suite exists to catch.

TODO(M31): a driver in the shape of `tests/roundtrip.py` — a subprocess entry
point the TypeScript side shells out to, which is how the cross-language drift
proof above already works — plus an adapter in a package that runs after the
build. Owner: whoever owns `packages/sdk-python` at M30.
