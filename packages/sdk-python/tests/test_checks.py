"""The constraint the JSON Schema projection cannot carry."""

from __future__ import annotations

from forgebridge.checks import check_changeset_ordering
from forgebridge.models import ChangeSet

BASE = {
    "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "projectId": "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    "baseVersion": 0,
    "summary": "ordering",
    "createdAt": "2026-08-26T12:00:00Z",
}


def changeset(operations: list[dict]) -> ChangeSet:
    return ChangeSet.model_validate({**BASE, "operations": operations})


def test_a_clean_set_reports_nothing() -> None:
    assert check_changeset_ordering(
        changeset(
            [
                {"op": "deleteInstance", "path": "Workspace.A"},
                {"op": "deleteInstance", "path": "Workspace.B"},
            ]
        )
    ) == []


def test_a_delete_after_a_touch_of_the_same_path_is_reported() -> None:
    issues = check_changeset_ordering(
        changeset(
            [
                {
                    "op": "setProperty",
                    "path": "Workspace.Doomed",
                    "property": "Transparency",
                    "value": {"t": "Number", "v": 1},
                },
                {"op": "deleteInstance", "path": "Workspace.Doomed"},
            ]
        )
    )
    assert issues == [
        'operation 1 deletes "Workspace.Doomed", which operation 0 also touches'
    ]


def test_a_delete_before_the_other_operation_is_not_reported() -> None:
    """The rule is directional, and this test is what keeps it that way.

    `packages/protocol/src/changeset.ts` only raises when the delete comes
    *after* something else touched the path. A check that also fired the other
    way round would refuse sets the daemon accepts, which is the same class of
    bug as accepting sets it refuses.
    """
    assert check_changeset_ordering(
        changeset(
            [
                {"op": "deleteInstance", "path": "Workspace.Doomed"},
                {
                    "op": "createInstance",
                    "path": "Workspace.Doomed",
                    "className": "Folder",
                },
            ]
        )
    ) == []
