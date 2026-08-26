"""Constraints the JSON Schema projection cannot carry.

JSON Schema has no way to compare two elements of the same array, so the one
cross-operation rule in `ChangeSet` does not survive the projection into
`packages/protocol/schema/`. Re-implementing it here is the only honest
alternative to letting a Python producer believe a schema-valid ChangeSet is a
protocol-valid one — the daemon would refuse it, and the producer would learn
that from a 400 rather than from its own types.

`packages/protocol/schema/README.md` lists every such constraint; this module
implements the ones a Python producer can act on before it sends.
"""

from __future__ import annotations

from .models import ChangeSet

__all__ = ["check_changeset_ordering"]


def check_changeset_ordering(changeset: ChangeSet) -> list[str]:
    """Return the ordering issues `ChangeSet`'s Zod refinement would raise.

    Two operations addressing the same path in one set are almost always a model
    looping, and the ordering then becomes load-bearing in a way no reviewer
    notices in a diff. An empty list means the daemon will not refuse the set on
    these grounds.

    The wording mirrors the message in `packages/protocol/src/changeset.ts` so a
    producer sees the same sentence from a local check and from the wire.
    """
    issues: list[str] = []
    seen: dict[str, int] = {}
    for index, operation in enumerate(changeset.operations):
        if operation.op == "deleteInstance":
            previous = seen.get(operation.path)
            if previous is not None:
                issues.append(
                    f'operation {index} deletes "{operation.path}", '
                    f"which operation {previous} also touches"
                )
        seen[operation.path] = index
    return issues
