"""The constraints that stop a ChangeSet from escaping its own gates.

Each of these was a hole in the protocol at some point, closed by adversarial
review before the first public commit. They are re-asserted here because a
projection is only as good as the refusals it carries across.
"""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from forgebridge.models import (
    CreateInstanceOp,
    InstancePath,
    Operation,
    PropertyValue,
    SetPropertyOp,
)

path_adapter = TypeAdapter(InstancePath)
operation_adapter = TypeAdapter(Operation)
value_adapter = TypeAdapter(PropertyValue)


@pytest.mark.parametrize(
    "path",
    [
        "Workspace",
        "ServerScriptService.Shop.PurchaseHandler",
        "ReplicatedStorage._private0",
    ],
)
def test_accepts_a_real_path(path: str) -> None:
    assert path_adapter.validate_python(path) == path


@pytest.mark.parametrize(
    "path",
    [
        "NotAService.Thing",          # not an addressable service root
        "Workspace.Shop Admin",       # a space is not a safe identifier
        "Workspace.Shop.Admin.v2.x-1",  # nor is a hyphen
        "Workspace..Thing",           # an empty segment
        "Workspace.",
        "",
        "Workspace." + "A" * 101,     # over the segment bound
        "Workspace." + ".".join("n" for _ in range(32)),  # over the depth bound
    ],
)
def test_refuses_a_path_that_could_smuggle_a_separator(path: str) -> None:
    with pytest.raises(ValidationError):
        path_adapter.validate_python(path)


@pytest.mark.parametrize("structural", ["Parent", "Name"])
def test_set_property_refuses_the_structural_properties(structural: str) -> None:
    """Assigning `Parent` relocates a subtree while reporting only its source path.

    That slipped the policy allowlist, the bulk-delete counter and the
    auto-apply exclusion at the same time. `moveInstance` exists for it.
    """
    with pytest.raises(ValidationError):
        SetPropertyOp.model_validate(
            {
                "op": "setProperty",
                "path": "Workspace.Part",
                "property": structural,
                "value": {"t": "String", "v": "anything"},
            }
        )


@pytest.mark.parametrize("reserved", ["constructor", "prototype", "__index"])
def test_a_property_bag_refuses_reserved_names(reserved: str) -> None:
    with pytest.raises(ValidationError):
        CreateInstanceOp.model_validate(
            {
                "op": "createInstance",
                "path": "Workspace.Part",
                "className": "Part",
                "properties": {reserved: {"t": "Bool", "v": True}},
            }
        )


def test_an_instance_ref_is_a_path_not_a_string() -> None:
    """The reference target gets the same segment rules as an operation's own path.

    Typing it loosely left exactly one hole in the guard those rules exist for —
    and the policy layer never saw it either, until `pathsOf` started reporting
    reference targets.
    """
    with pytest.raises(ValidationError):
        value_adapter.validate_python({"t": "InstanceRef", "path": "Anywhere.At.All"})
    ok = value_adapter.validate_python({"t": "InstanceRef", "path": "Workspace.Rig"})
    assert ok.path == "Workspace.Rig"


def test_the_property_value_union_is_closed() -> None:
    with pytest.raises(ValidationError):
        value_adapter.validate_python({"t": "Ray", "origin": [0, 0, 0]})


def test_defaults_are_materialised_the_way_zod_materialises_them() -> None:
    font = value_adapter.validate_python({"t": "Font", "family": "Gotham"})
    assert font.weight == "Regular"
    assert font.style == "Normal"

    created = operation_adapter.validate_python(
        {"op": "createInstance", "path": "Workspace.Thing", "className": "Folder"}
    )
    assert created.properties == {}


def test_an_absent_optional_stays_absent_after_a_round_trip() -> None:
    """`None` is this projection's stand-in for absence, and must not reach the wire.

    Zod leaves an `.optional()` field off the parsed object entirely. A client
    that sent `"runId": null` instead would be sending a value the schema does
    not permit.
    """
    from forgebridge.models import ChangeSet

    changeset = ChangeSet.model_validate(
        {
            "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "projectId": "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
            "baseVersion": 0,
            "summary": "no runId",
            "createdAt": "2026-08-26T12:00:00Z",
            "operations": [{"op": "deleteInstance", "path": "Workspace.Scratch"}],
        }
    )
    dumped = changeset.model_dump(mode="json", by_alias=True)
    assert "runId" not in dumped
    assert "validation" not in dumped
    # A nullable field with a null default is a different thing and stays put.
    from forgebridge.models import Link

    link = Link.model_validate(
        {
            "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3305",
            "projectId": "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
            "transport": "local-daemon",
            "state": "paired",
            "createdAt": "2026-08-26T12:00:00Z",
        }
    )
    assert link.model_dump(mode="json", by_alias=True)["sessionKeyId"] is None


def test_an_approval_cannot_be_built_without_the_content_it_approves() -> None:
    """ADR-012's approval is a statement about operations, not about an id.

    The daemon refuses an approve whose `contentDigest` does not match the
    operations it holds, and the projection carries that refusal one step
    earlier: a Python producer cannot even *construct* an approval that names no
    reviewed content. A default here would have been a caller opting out of the
    binding without noticing.
    """
    from forgebridge.models import ApproveRequest

    with pytest.raises(ValidationError):
        ApproveRequest()

    # The control: the same call with the digest the diff reported is the
    # ordinary, legitimate shape and is accepted unchanged.
    approval = ApproveRequest(contentDigest="vOZa1mHnQnJ1H+D5b3Rk8lYbC2s9nqJ3nS0k1s5oJ0Q=")
    assert approval.model_dump(mode="json", by_alias=True)["contentDigest"] == (
        "vOZa1mHnQnJ1H+D5b3Rk8lYbC2s9nqJ3nS0k1s5oJ0Q="
    )

    # …and an empty string is not a digest. `min_length=1` on the wire is what
    # stops "" from reading as "I approved nothing in particular".
    with pytest.raises(ValidationError):
        ApproveRequest(contentDigest="")
