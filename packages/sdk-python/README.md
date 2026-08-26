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
