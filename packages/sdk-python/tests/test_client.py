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
from forgebridge.models import ApproveRequest, ChangeSet, StartRunRequest

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
