"""The conformance driver, held to the one thing it must never be able to do.

The driver is what `@forgebridge/conformance` shells out to, and the suite it
serves is only worth running if the connector under test cannot open the gate it
is being tested against. `ForgeBridgeClient.approve_changeset` exists — it has
to — so "the driver has no approve command" is a claim about this file that
somebody could quietly break, and these tests are what break loudly instead.
"""

from __future__ import annotations

import json

import pytest

import conformance_driver as driver
from forgebridge import ForgeBridgeClient
from forgebridge.client import HttpResponse
from forgebridge.errors import ForgeBridgeError, TransportError

PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3302"
CHANGESET = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"


def diff_body(status: str) -> dict:
    return {
        "changeSetId": CHANGESET,
        "projectId": PROJECT,
        "summary": "a small change",
        "status": status,
        "baseVersion": 3,
        "currentVersion": 3,
        "stale": False,
        "counts": {
            "total": 1,
            "creates": 0,
            "setProperties": 0,
            "scripts": 0,
            "moves": 0,
            "deletes": 1,
        },
        "contentDigest": "vOZa1mHnQnJ1H+D5b3Rk8lYbC2s9nqJ3nS0k1s5oJ0Q=",
        "operations": [
            {
                "index": 0,
                "op": "deleteInstance",
                "paths": ["Workspace.Scratch"],
                "summary": "delete Workspace.Scratch",
                "destructive": True,
            }
        ],
        "treeAware": False,
    }


def client_answering(*bodies: dict, status: int = 200) -> ForgeBridgeClient:
    answers = [HttpResponse(status=status, body=json.dumps(body).encode()) for body in bodies]

    def transport(method, url, headers, body):
        return answers.pop(0)

    return ForgeBridgeClient("http://daemon.invalid", producer_token="t", transport=transport)


# ── the call that must not exist ─────────────────────────────────────────────


def test_the_driver_serves_no_approve_command() -> None:
    """Not "the suite never sends one" — there is none to send.

    A driver that could approve would let the connector under test hold the
    handle on both sides of the gate, and `apply-after-human-approval` would then
    prove that apply works and nothing at all about the gate (ADR-012).
    """
    assert "approve" not in driver.COMMANDS
    assert not any("approve" in name for name in driver.COMMANDS)


def test_an_unknown_command_is_a_fault_and_not_a_classified_error() -> None:
    """Fail closed, and say which kind of failure it is.

    A driver that answered `{"ok": false, "error": {...}}` here would look to the
    suite exactly like the daemon refusing something, and "I do not understand
    this request" would become indistinguishable from "the daemon said no".
    """
    answer = driver._handle(
        client_answering(), {"id": 1, "call": "approve", "changeSetId": CHANGESET}
    )

    assert answer["ok"] is False
    assert "error" not in answer
    assert "no command 'approve'" in answer["fault"]


def test_the_transport_refuses_an_approval_request_before_sending_it() -> None:
    """The structural half. Even a driver that grew an approve command could not
    send one: the client it builds is wired to a transport that refuses the path.
    """
    sent: list[str] = []

    def inner(method, url, headers, body):
        sent.append(url)
        return HttpResponse(status=200, body=b"{}")

    guarded = driver.guarded_transport(inner)

    with pytest.raises(TransportError, match="does not make approval requests"):
        guarded("POST", f"http://daemon.invalid/v1/changesets/{CHANGESET}/approve", {}, b"{}")
    assert sent == []

    # And the control: the guard fires on the one path it is about, and on
    # nothing else. A guard that refused ordinary calls would be a guard people
    # route around, which is the same outcome as no guard.
    guarded("GET", f"http://daemon.invalid/v1/changesets/{CHANGESET}/diff", {}, None)
    assert sent == [f"http://daemon.invalid/v1/changesets/{CHANGESET}/diff"]


# ── the branch table apply() is ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "status", ["draft", "proposed", "validated", "rejected", "a status nobody has defined"]
)
def test_apply_refuses_anything_a_human_has_not_cleared(status: str) -> None:
    """Including a status this driver has never heard of.

    An unrecognised status ends in `not_approved` rather than in an acceptance,
    because failing closed is the only safe default for the one gate standing
    between a model and someone's place.
    """
    with pytest.raises(ForgeBridgeError) as raised:
        driver.apply(client_answering(diff_body(status)), {"changeSetId": CHANGESET})

    assert raised.value.code == "not_approved"
    assert raised.value.remedy and "human action" in raised.value.remedy


@pytest.mark.parametrize("status", ["approved", "applying", "applied", "partial", "failed"])
def test_apply_reports_a_cleared_set_as_cleared(status: str) -> None:
    """`failed` belongs here: a set that failed to apply was still dispatched."""
    report = driver.apply(client_answering(diff_body(status)), {"changeSetId": CHANGESET})

    assert report["accepted"] is True
    assert report["status"] == status


def test_apply_refuses_a_stale_set_as_stale_rather_than_as_unapproved() -> None:
    """Two different facts, and a caller branches differently on each: one sends
    the user to approve, the other sends the producer to rebase."""
    with pytest.raises(ForgeBridgeError) as raised:
        driver.apply(client_answering(diff_body("stale")), {"changeSetId": CHANGESET})

    assert raised.value.code == "stale_base"


def test_read_tree_refuses_in_the_protocols_own_words() -> None:
    """A refusal carrying a remedy, which is what the suite accepts as a gap."""
    with pytest.raises(ForgeBridgeError) as raised:
        driver.read_tree(client_answering(), {"projectId": PROJECT})

    assert raised.value.code == "not_found"
    assert raised.value.remedy and "/v1 endpoint" in raised.value.remedy


# ── classification ───────────────────────────────────────────────────────────


def test_classify_answers_every_kind_the_bridge_sends() -> None:
    views = driver.classify(
        client_answering(),
        {
            "inputs": [
                {
                    "kind": "protocol_error",
                    "status": 403,
                    "payload": {"code": "not_approved", "message": "no"},
                },
                {"kind": "wire_payload", "payload": {"code": "stale_base", "message": "moved"}},
                {"kind": "transport_error", "message": "connection refused"},
                {"kind": "opaque", "message": "socket hang up"},
                {"kind": "nothing"},
            ]
        },
    )

    assert [view["code"] for view in views] == [
        "not_approved",
        "stale_base",
        "internal",
        "internal",
        "internal",
    ]
    assert [view["recognised"] for view in views] == [True, True, False, False, False]


def test_classify_refuses_a_kind_it_does_not_know() -> None:
    """The bridge and the driver have to agree on the vocabulary, and a driver
    that shrugged at an unknown kind would silently classify nothing."""
    with pytest.raises(ValueError, match="unknown kind"):
        driver.classify(client_answering(), {"inputs": [{"kind": "a kind nobody defined"}]})
