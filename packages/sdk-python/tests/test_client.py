"""The client is a translator, and the approval gate is not negotiable."""

from __future__ import annotations

import inspect
import json

import pytest

from forgebridge import ForgeBridgeClient
from forgebridge.client import (
    LINK_HEADER,
    MAC_HEADER,
    PRODUCER_TOKEN_HEADER,
    HttpResponse,
)
from forgebridge.errors import ForgeBridgeError, TransportError
from forgebridge.models import (
    ApproveRequest,
    ChangeSet,
    DeliveryEnvelope,
    RollbackRequest,
    RollbackResult,
    StartRunRequest,
)

# A sealed envelope, opaque to this client: it holds no session key and cannot
# make one (see the M30 note in `client.py`). What matters here is the routing
# and the headers, not the payload.
ENVELOPE = {
    "linkId": "3f2504e0-4f89-41d3-9a0c-0305e82c3305",
    "nonce": 9,
    "encrypted": False,
    "payload": "e30=",
    "mac": "bWFj",
}

# The digest `GET /v1/changesets/:id/diff` reports for CHANGESET's operations.
# An approve must echo it: the daemon binds a "yes" to the content that was
# reviewed, not to the id it arrived on. It is opaque to this client, which
# never computes one — it repeats what the approver read.
REVIEWED_DIGEST = "vOZa1mHnQnJ1H+D5b3Rk8lYbC2s9nqJ3nS0k1s5oJ0Q="

CHANGESET = {
    "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "projectId": "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    "baseVersion": 3,
    "summary": "a small change",
    "createdAt": "2026-08-26T12:00:00Z",
    "operations": [{"op": "deleteInstance", "path": "Workspace.Scratch"}],
}


class Recorder:
    """A transport that records what was sent and replays a scripted answer."""

    def __init__(self, *answers: HttpResponse) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        return self.answers.pop(0)


def ok(payload: dict, status: int = 200) -> HttpResponse:
    return HttpResponse(status=status, body=json.dumps(payload).encode())


def test_propose_does_not_approve() -> None:
    """One call, one route. The gate ADR-012 puts here is the whole design.

    A helper that submitted and approved in one step would let a model clear its
    own work, so the test asserts the wire traffic, not just the return value.
    """
    recorder = Recorder(
        ok(
            {
                "changeSetId": CHANGESET["id"],
                "status": "validated",
                "baseVersion": 3,
                "validation": {
                    "luau": {"status": "ok", "findings": []},
                    "policy": {"status": "ok", "violations": []},
                    "computedAt": "2026-08-26T12:00:01Z",
                    "computedBy": "forgebridge-daemon@0.1.0",
                },
            },
            status=201,
        )
    )
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    result = client.propose_changeset(ChangeSet.model_validate(CHANGESET))

    assert result.status == "validated"
    assert len(recorder.calls) == 1
    method, url, headers, _ = recorder.calls[0]
    assert (method, url) == ("POST", "http://127.0.0.1:8787/v1/changesets")
    assert headers[PRODUCER_TOKEN_HEADER] == "t0ken"
    assert "approve" not in url


def test_no_method_submits_and_approves() -> None:
    """Written as a test rather than a comment because comments do not fail.

    If somebody adds a convenience wrapper later, this is what stops it.
    """
    for name, member in inspect.getmembers(ForgeBridgeClient, inspect.isfunction):
        if name.startswith("_"):
            continue
        # The docstrings talk about approval on purpose; the *routes* a method
        # builds are what this is checking, so the prose is stripped first.
        source = inspect.getsource(member).replace(member.__doc__ or "", "")
        submits = '"/v1/changesets"' in source
        approves = "/approve" in source
        assert not (submits and approves), f"{name} both submits and approves a ChangeSet"
    assert '"/v1/changesets"' in inspect.getsource(ForgeBridgeClient.propose_changeset)
    assert "/approve" in inspect.getsource(ForgeBridgeClient.approve_changeset)


def test_approve_carries_the_producer_token_and_the_bulk_delete_flag() -> None:
    approved = {"changeSetId": CHANGESET["id"], "status": "approved", "nonce": 1}
    recorder = Recorder(ok(approved, status=202))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    client.approve_changeset(
        str(CHANGESET["id"]),
        ApproveRequest(
            contentDigest=REVIEWED_DIGEST, approvedBy="alex", confirmBulkDelete=True
        ),
    )
    _, url, headers, body = recorder.calls[0]
    assert url.endswith(f"/v1/changesets/{CHANGESET['id']}/approve")
    assert headers[PRODUCER_TOKEN_HEADER] == "t0ken"
    assert json.loads(body)["confirmBulkDelete"] is True
    assert json.loads(body)["contentDigest"] == REVIEWED_DIGEST


def test_a_producer_route_without_a_token_fails_before_it_sends() -> None:
    """Loopback is not an authentication boundary, and neither is optimism."""
    recorder = Recorder()
    client = ForgeBridgeClient("http://127.0.0.1:8787", transport=recorder)
    with pytest.raises(TransportError):
        client.approve_changeset(
            str(CHANGESET["id"]), ApproveRequest(contentDigest=REVIEWED_DIGEST)
        )
    assert recorder.calls == []


def test_a_consumer_route_sends_the_link_and_the_mac() -> None:
    recorder = Recorder(HttpResponse(status=204, body=b""))
    client = ForgeBridgeClient(
        "http://127.0.0.1:8787", link_id="3f2504e0-4f89-41d3-9a0c-0305e82c3305", transport=recorder
    )
    assert client.poll(mac="bWFj", since=4) is None
    _, url, headers, _ = recorder.calls[0]
    assert url.endswith("/v1/link/poll?since=4")
    assert headers[LINK_HEADER] == "3f2504e0-4f89-41d3-9a0c-0305e82c3305"
    assert headers[MAC_HEADER] == "bWFj"


def test_a_protocol_error_arrives_as_its_code_not_as_a_string() -> None:
    """A consumer must be able to branch on the code. That is why the set is closed."""
    recorder = Recorder(
        ok(
            {
                "code": "stale_base",
                "message": "the project is at version 9",
                "remedy": "Rebuild against version 9 and resubmit.",
            },
            status=409,
        )
    )
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    with pytest.raises(ForgeBridgeError) as caught:
        client.propose_changeset(ChangeSet.model_validate(CHANGESET))
    assert caught.value.code == "stale_base"
    assert caught.value.status == 409
    assert "Rebuild" in (caught.value.remedy or "")


def test_a_non_protocol_failure_is_not_dressed_up_as_one() -> None:
    recorder = Recorder(HttpResponse(status=502, body=b"<html>bad gateway</html>"))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    with pytest.raises(TransportError):
        client.propose_changeset(ChangeSet.model_validate(CHANGESET))


def test_an_id_cannot_walk_out_of_its_route() -> None:
    """Ids reach this client from wherever the caller got them."""
    approved = {"changeSetId": CHANGESET["id"], "status": "approved", "nonce": 1}
    recorder = Recorder(ok(approved, status=202))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    client.approve_changeset(
        "../../v1/journal/x/rollback", ApproveRequest(contentDigest=REVIEWED_DIGEST)
    )
    _, url, _, _ = recorder.calls[0]
    assert "/v1/journal/" not in url
    assert url.endswith("/approve")


# ── runs ──────────────────────────────────────────────────────────────────────

#: What `POST /v1/runs` answers. Two attempts and not one, deliberately: a
#: fixture whose run only ever tried the model that worked would let a client
#: that reported the winner alone pass every assertion about the attempt list.
RUN_RESPONSE = {
    "run": {
        "id": "3f2504e0-4f89-41d3-9a0c-0305e82c3310",
        "projectId": CHANGESET["projectId"],
        "prompt": "add a purchase handler",
        "stage": "awaiting-approval",
        "status": "running",
        "attempts": [
            {
                "modelId": "glm-5.2:free",
                "outcome": "rate-limited",
                "startedAt": "2026-08-26T12:00:00Z",
                "durationMs": 900,
            },
            {
                "modelId": "minimax-m3:free",
                "outcome": "ok",
                "startedAt": "2026-08-26T12:00:01Z",
                "durationMs": 4200,
            },
        ],
        "changeSetIds": [CHANGESET["id"]],
        "producer": {"kind": "sdk"},
        "startedAt": "2026-08-26T12:00:00Z",
        "finishedAt": None,
    },
    "plan": {"steps": ["write one script"]},
    "changeSetId": CHANGESET["id"],
    "changeSetStatus": "validated",
    "contentDigest": REVIEWED_DIGEST,
    "validation": {
        "luau": {"status": "ok", "findings": []},
        "policy": {"status": "ok", "violations": []},
        "computedAt": "2026-08-26T12:00:06Z",
        "computedBy": "forgebridge-daemon@0.1.0",
    },
    "skipped": [],
    "ordering": {
        "policy": "free-first",
        "candidatesConsidered": 4,
        "candidatesEligible": 2,
        "order": ["glm-5.2:free", "minimax-m3:free"],
    },
    "failure": None,
}


def test_a_run_reports_every_model_it_tried_in_order() -> None:
    """ADR-008: the caller always receives the full list, never only the winner.

    A run that fell back and reports one attempt is perfectly well-formed, so
    the shape alone cannot catch it — the fixture falls back, and this asserts
    on both entries and on their order.
    """
    recorder = Recorder(ok(RUN_RESPONSE, status=201))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)

    result = client.start_run(StartRunRequest(prompt="add a purchase handler"))

    assert [(a.modelId, a.outcome) for a in result.run.attempts] == [
        ("glm-5.2:free", "rate-limited"),
        ("minimax-m3:free", "ok"),
    ]
    method, url, headers, body = recorder.calls[0]
    assert (method, url) == ("POST", "http://127.0.0.1:8787/v1/runs")
    assert headers[PRODUCER_TOKEN_HEADER] == "t0ken"
    # Sent as the wire schema spells it, with the default policy carried
    # explicitly rather than left for the server to guess at.
    assert json.loads(body)["policy"] == "free-first"


def test_a_run_stops_at_the_human_gate() -> None:
    """A run proposes. The ChangeSet it leaves behind is nobody's approval."""
    recorder = Recorder(ok(RUN_RESPONSE, status=201))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)

    result = client.start_run(StartRunRequest(prompt="add a purchase handler"))

    assert result.changeSetStatus == "validated"
    assert result.contentDigest == REVIEWED_DIGEST
    # And nothing on the way there touched the approve route.
    assert all("approve" not in url for _, url, _, _ in recorder.calls)


def test_a_run_never_claims_a_verdict_of_its_own() -> None:
    """PROTOCOL invariant 4, from the client's side.

    There is nowhere in `StartRunRequest` to put a validation, so a producer
    cannot send one — and the verdict that comes back names the daemon.
    """
    assert "validation" not in StartRunRequest.model_fields
    recorder = Recorder(ok(RUN_RESPONSE, status=201))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    result = client.start_run(StartRunRequest(prompt="p"))
    assert result.validation["computedBy"].startswith("forgebridge-daemon@")


def test_a_streamed_run_is_refused_rather_than_quietly_downgraded() -> None:
    recorder = Recorder()
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)
    with pytest.raises(TransportError):
        client.start_run(StartRunRequest(prompt="p", stream=True))
    assert recorder.calls == []


def test_a_run_needs_the_producer_token_before_it_spends_anything() -> None:
    recorder = Recorder()
    client = ForgeBridgeClient("http://127.0.0.1:8787", transport=recorder)
    with pytest.raises(TransportError):
        client.start_run(StartRunRequest(prompt="p"))
    assert recorder.calls == []


def test_a_recorded_run_is_readable_while_it_is_still_running() -> None:
    recorder = Recorder(ok(RUN_RESPONSE))
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t0ken", transport=recorder)

    result = client.get_run("3f2504e0-4f89-41d3-9a0c-0305e82c3310")

    assert result.run.status == "running"
    _, url, _, _ = recorder.calls[0]
    assert url.endswith("/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3310")


def test_no_method_runs_and_approves() -> None:
    """The same guard as above, aimed at the route a run could have grown."""
    source = inspect.getsource(ForgeBridgeClient.start_run)
    assert '"/v1/runs"' in source
    assert "/approve" not in source.replace(ForgeBridgeClient.start_run.__doc__ or "", "")


JOURNAL_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3306"


def _journal(state: str, outcomes: list[dict] | None) -> dict:
    return {
        "journalId": JOURNAL_ID,
        "changeSetId": CHANGESET["id"],
        "projectId": CHANGESET["projectId"],
        "summary": "a small change",
        "state": state,
        "versionBefore": 3,
        "versionAfter": 4,
        "appliedAt": "2026-08-26T12:00:00Z",
        "rollbackRequestedAt": "2026-08-26T12:01:00Z",
        "rolledBackAt": "2026-08-26T12:02:00Z" if state == "rolled_back" else None,
        "inverses": 2,
        "result": None
        if outcomes is None
        else {
            "journalId": JOURNAL_ID,
            "changeSetId": CHANGESET["id"],
            "outcomes": outcomes,
            "newVersion": 3,
            "rolledBackAt": "2026-08-26T12:02:00Z",
            "pluginVersion": "0.1.0",
        },
    }


def test_a_dispatched_rollback_is_not_a_completed_one() -> None:
    """`request_rollback` answers "dispatched" and cannot answer anything else.

    The Studio session holds the inverses and replays them after it polls, so at
    the moment this returns nothing has been reversed. The client must not have
    a method that pretends otherwise, and the outcome has its own read.
    """
    recorder = Recorder(
        ok(
            {
                "journalId": JOURNAL_ID,
                "changeSetId": CHANGESET["id"],
                "status": "dispatched",
                "nonce": 7,
                "steps": 2,
            },
            status=202,
        )
    )
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t", transport=recorder)
    response = client.request_rollback(
        JOURNAL_ID, RollbackRequest(journalId=JOURNAL_ID, expectedVersion=4)
    )
    assert response.status == "dispatched"
    assert response.steps == 2
    assert not hasattr(response, "rolledBackAt")


def test_a_partial_reversal_is_readable_as_partial() -> None:
    """The outcome no surface may round up.

    Some inverses replayed and some did not: the place is in a state neither the
    apply nor the rollback describes, and the ones that would have finished the
    job are spent. A client that could only say "rolled back or not" would make
    that indistinguishable from a reversal that never started.
    """
    recorder = Recorder(
        ok(
            _journal(
                "rollback_partial",
                [
                    {"index": 1, "ok": True},
                    {"index": 0, "ok": False, "error": "Workspace.Shop.Sign is gone"},
                ],
            )
        )
    )
    client = ForgeBridgeClient("http://127.0.0.1:8787", producer_token="t", transport=recorder)
    journal = client.get_journal(JOURNAL_ID)

    assert journal.state == "rollback_partial"
    assert journal.rolledBackAt is None
    # `result` projects as `Any`: the generator renders a nullable $ref that way,
    # here and on `RunResponse.validation` alike. Validating it explicitly is
    # what a caller has to do, so the test does what a caller does.
    result = RollbackResult.model_validate(journal.result)
    failed = [outcome for outcome in result.outcomes if not outcome.ok]
    assert [outcome.index for outcome in failed] == [0]
    assert failed[0].error == "Workspace.Shop.Sign is gone"

    _, url, headers, _ = recorder.calls[0]
    assert url.endswith(f"/v1/journal/{JOURNAL_ID}")
    assert headers[PRODUCER_TOKEN_HEADER] == "t"


def test_no_inverses_is_told_apart_from_nothing_to_undo() -> None:
    """`None` and `0` are different facts.

    `None` means the inverses never left the Studio session that captured them —
    that session may still be able to undo in place, and nothing else can. `0`
    would mean an apply that changed nothing.
    """
    payload = _journal("applied", None)
    payload["inverses"] = None
    client = ForgeBridgeClient(
        "http://127.0.0.1:8787", producer_token="t", transport=Recorder(ok(payload))
    )
    assert client.get_journal(JOURNAL_ID).inverses is None


def test_the_two_journal_writes_are_consumer_surface() -> None:
    """Both carry the link, because both decide what a rollback can do.

    One writes the record a reversal is replayed from; the other is the only
    thing that can stamp a journal reversed. A process that found the loopback
    port must be able to write neither.
    """
    client = ForgeBridgeClient("http://127.0.0.1:8787", transport=Recorder())
    with pytest.raises(TransportError):
        client.record_journal_entry(JOURNAL_ID, DeliveryEnvelope.model_validate(ENVELOPE))
    with pytest.raises(TransportError):
        client.report_rollback_result(JOURNAL_ID, DeliveryEnvelope.model_validate(ENVELOPE))

    recorder = Recorder(
        ok({"journalId": JOURNAL_ID, "changeSetId": CHANGESET["id"], "inverses": 2}),
        ok(
            {
                "journalId": JOURNAL_ID,
                "changeSetId": CHANGESET["id"],
                "state": "rolled_back",
                "version": 3,
            }
        ),
    )
    linked = ForgeBridgeClient(
        "http://127.0.0.1:8787",
        link_id="3f2504e0-4f89-41d3-9a0c-0305e82c3305",
        transport=recorder,
    )
    assert (
        linked.record_journal_entry(JOURNAL_ID, DeliveryEnvelope.model_validate(ENVELOPE)).inverses
        == 2
    )
    assert (
        linked.report_rollback_result(
            JOURNAL_ID, DeliveryEnvelope.model_validate(ENVELOPE)
        ).state
        == "rolled_back"
    )

    assert recorder.calls[0][1].endswith(f"/v1/journal/{JOURNAL_ID}/entry")
    assert recorder.calls[1][1].endswith(f"/v1/journal/{JOURNAL_ID}/rollback-result")
    for _, _, headers, _ in recorder.calls:
        assert headers[LINK_HEADER] == "3f2504e0-4f89-41d3-9a0c-0305e82c3305"
