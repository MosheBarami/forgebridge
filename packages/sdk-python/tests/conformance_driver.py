"""Drive `forgebridge.ForgeBridgeClient` for the connector conformance suite.

Not a test itself — a subprocess entry point, in the shape `tests/roundtrip.py`
already uses for the cross-language drift proof. `@forgebridge/conformance` is
TypeScript and needs a built workspace and a live daemon; this package is Python
and its CI gate has neither. So the suite runs where it can run, and shells out
to this file for the calls it is testing. The adapter on the other end is
`packages/conformance/src/python/sdk-adapter.ts`.

    stdin   one JSON object per line: {"id": n, "call": "...", ...}
    stdout  one JSON object per line: {"id": n, "ok": true, "value": ...}
                                   or {"id": n, "ok": false, "error": <ErrorView>}
    stderr  anything a human should read; never part of the protocol

Nothing here decides anything. Every command is one call on the client, and
every failure is classified by `forgebridge.describe_error` — the function a
Python caller uses — rather than by a mapping written for the suite. A driver
that classified errors itself would prove that this file can map error codes and
nothing at all about whether the SDK can.

── The call that is not here ────────────────────────────────────────────────

There is no `approve`. `ForgeBridgeClient.approve_changeset` exists — it has to,
because approving is a real thing a ForgeBridge client does — and this driver
must not be able to reach it: the suite's approval arrives from a separate
object, out of band, precisely so that `apply-after-human-approval` proves the
gate opened rather than that the connector under test can open it (ADR-012).

Leaving the command out of the table would be enough for the suite. It is not
enough for a reader, so the guard is structural as well: the client this driver
builds is wired to a transport that refuses any request whose URL contains
`/approve`, before the request is sent. If someone adds an approve command here
later, it fails loudly rather than quietly making the suite meaningless.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from forgebridge import (  # noqa: E402
    ErrorView,
    ForgeBridgeClient,
    ForgeBridgeError,
    HttpResponse,
    Transport,
    TransportError,
    describe_error,
    urllib_transport,
)
from forgebridge.models import (  # noqa: E402
    ChangeSet,
    ProtocolError,
    StartRunRequest,
)

#: The one path this driver refuses to send, whatever it is handed.
FORBIDDEN_PATH_FRAGMENT = "/approve"


def guarded_transport(inner: Transport) -> Transport:
    """Wrap a transport so that no approval request can leave this process."""

    def send(
        method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> HttpResponse:
        if FORBIDDEN_PATH_FRAGMENT in url:
            raise TransportError(
                "the conformance driver does not make approval requests; approval is a "
                "human action taken in Roblox Studio or in a ForgeBridge client (ADR-012)"
            )
        return inner(method, url, headers, body)

    return send


# ── the commands ─────────────────────────────────────────────────────────────
#
# Each returns the value the adapter on the other end expects, in the protocol's
# own field names. Anything that fails raises, and `main` classifies it.


def link_status(client: ForgeBridgeClient, _request: dict) -> dict:
    status = client.link_status()
    return {
        "transport": status.transport,
        # Forwarded byte for byte. The posture is one of the few strings whose
        # wording is the contract: a connector that paraphrased it would have
        # told the user something false about who can read their code.
        "privacyPosture": status.privacyPosture,
        "protocolVersion": status.protocolVersion,
        "defaultProjectId": status.defaultProjectId,
        "links": [
            {"linkId": link.id, "projectId": link.projectId, "state": link.state}
            for link in status.links
        ],
    }


def list_projects(client: ForgeBridgeClient, _request: dict) -> list[dict]:
    """Assembled from the links, because `/v1` publishes no project list.

    `currentVersion` is left off rather than guessed. A version this driver
    invented would make `propose-returns-id-and-diff` check a number nobody
    published — the same gap the reference adapter records, and the same
    additive `/v1` read closes both (TODO(M31) in
    `packages/conformance/src/reference/daemon-adapter.ts`).
    """
    status = client.link_status()
    ids: list[str] = []
    for link in status.links:
        if link.projectId not in ids:
            ids.append(link.projectId)
    if status.defaultProjectId and status.defaultProjectId not in ids:
        ids.append(status.defaultProjectId)

    return [
        {
            "projectId": project_id,
            "isDefault": project_id == status.defaultProjectId,
            "links": [
                {"linkId": link.id, "projectId": link.projectId, "state": link.state}
                for link in status.links
                if link.projectId == project_id
            ],
        }
        for project_id in ids
    ]


def read_tree(_client: ForgeBridgeClient, _request: dict) -> dict:
    """Refused, in the protocol's own words, which is what the case accepts.

    This SDK has no tree method because `/v1` serves no tree snapshot to read.
    Refusing with `not_found` and a remedy is the honest form of that, and it is
    the same answer `forge.read_tree` gives. The day the endpoint lands, this
    becomes a call and the case starts passing.
    """
    raise ForgeBridgeError(
        ProtocolError(
            code="not_found",
            message="this ForgeBridge SDK has no method that reads a tree snapshot",
            remedy=(
                "Ask the user for the instance paths you need. A tree read needs a /v1 "
                "endpoint that does not exist yet (M09 owns the snapshot, M31 agrees the "
                "wire shape)."
            ),
        ),
        404,
    )


def propose(client: ForgeBridgeClient, request: dict) -> dict:
    """Submit a ChangeSet. This does not approve it and does not apply it.

    `claimedValidation` is forwarded untouched when the caller supplies one.
    `ChangeSet` has a `validation` field, so a producer *can* put a verdict of
    its own on the wire through this client — and forwarding it is what lets the
    suite prove from the outside that the daemon discards it and recomputes
    (PROTOCOL invariant 4). Dropping it here would make the case pass by making
    the forgery unrepresentable, which proves something about this driver rather
    than about the system.
    """
    changeset = ChangeSet.model_validate(
        {
            "id": str(uuid.uuid4()),
            "projectId": request["projectId"],
            "baseVersion": request["baseVersion"],
            "summary": request["summary"],
            "operations": request["operations"],
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            **(
                {"validation": request["claimedValidation"]}
                if request.get("claimedValidation")
                else {}
            ),
        }
    )
    submitted = client.propose_changeset(changeset)
    return {
        "changeSetId": submitted.changeSetId,
        "status": submitted.status,
        "validation": submitted.validation.model_dump(mode="json", by_alias=True),
        "diff": diff(client, {"changeSetId": submitted.changeSetId}),
    }


def diff(client: ForgeBridgeClient, request: dict) -> dict:
    rendered = client.get_diff(request["changeSetId"])
    return rendered.model_dump(mode="json", by_alias=True)


#: What `apply()` may report once a human has actually approved. A set that
#: failed to apply belongs here too: it was still dispatched, so finding one
#: after a refused apply would mean the refusal was theatre.
CLEARED = ("approved", "applying", "applied", "partial", "failed")


def apply(client: ForgeBridgeClient, request: dict) -> dict:
    """Report on a ChangeSet a human has already approved.

    There is no `apply` on this client and there is nothing for one to call: in
    this protocol a producer never dispatches, the daemon does that when a human
    approves, and what a producer can do is read the status and say whether the
    set was cleared. So the branch table is the whole of it, and it is the same
    one `forge.apply_changeset`, the A2A `apply-approved-changeset` skill and the
    reference adapter all use.

    The diff read first is not a formality: it is what makes an id that was never
    proposed answer `not_found` rather than being refused by a gate for a set
    that does not exist. And the default is a refusal — an unrecognised status
    ends in `not_approved`, because failing closed is the only safe default for
    the one gate standing between a model and someone's place.
    """
    changeset_id = request["changeSetId"]
    rendered = client.get_diff(changeset_id)

    if rendered.status in CLEARED:
        return {
            "changeSetId": changeset_id,
            "status": rendered.status,
            "accepted": True,
            "message": (
                "A human approved this ChangeSet out of band and the daemon has it queued "
                "for the paired Studio session."
            ),
        }

    if rendered.status == "stale":
        raise ForgeBridgeError(
            ProtocolError(
                code="stale_base",
                message=(
                    "the place moved after this ChangeSet was built, so it can no longer "
                    "be applied"
                ),
                remedy=(
                    "Rebuild the operations against the current version and propose a new "
                    "ChangeSet."
                ),
            ),
            409,
        )

    raise ForgeBridgeError(
        ProtocolError(
            code="not_approved",
            message=f"changeset {changeset_id} has not been approved (status: {rendered.status})",
            remedy=(
                "Ask the user to review the diff and approve it in Roblox Studio or in their "
                "ForgeBridge client. Approval is a human action; no call on this driver can "
                "perform it (ADR-012)."
            ),
        ),
        403,
    )


def start_run(client: ForgeBridgeClient, request: dict) -> dict:
    """A prompt in, a proposed ChangeSet out, nothing applied.

    `run.attempts` is forwarded whole and in order — every model the router
    tried, with why it moved on from each. The code in the ChangeSet was written
    by the model named in the last successful attempt, which may not be the one
    that was asked for, and a caller that reported only the winner would be
    misreporting who wrote it (ADR-008).
    """
    response = client.start_run(
        StartRunRequest(
            prompt=request["prompt"],
            projectId=request["projectId"],
            producer={"kind": "sdk", "client": "forgebridge conformance driver"},
        )
    )
    return {
        "runId": response.run.id,
        "stage": response.run.stage,
        "status": response.run.status,
        "attempts": [
            attempt.model_dump(mode="json", by_alias=True) for attempt in response.run.attempts
        ],
        "changeSetIds": list(response.run.changeSetIds),
    }


def classify(_client: ForgeBridgeClient, request: dict) -> list[dict]:
    """Classify a batch of failures, the way a Python caller would.

    Asked for in a batch, and asked for up front, because the conformance
    interface's `describeError` is synchronous and this driver is a subprocess.
    What crosses the pipe is the *inputs*; every code and every `recognised` flag
    in the answers is `forgebridge.describe_error`'s, so a partial mapping on
    this side shows up as a partial mapping in the report.
    """
    return [_view_to_json(describe_error(_reconstruct(item))) for item in request["inputs"]]


def _reconstruct(item: dict) -> object:
    """Turn one described failure back into the Python object it stands for.

    The three kinds are the three ways a failure actually reaches a Python
    caller, and they are kept apart on purpose: an SDK that understands only its
    own exception class has a mapping that works in its own tests and nowhere
    else.
    """
    kind = item.get("kind")
    if kind == "protocol_error":
        # A refusal that arrived as an answer: a status and a body.
        return ForgeBridgeError(
            ProtocolError.model_validate(item["payload"]), int(item["status"])
        )
    if kind == "wire_payload":
        # The same refusal as a body nobody has parsed yet.
        return item["payload"]
    if kind == "transport_error":
        return TransportError(item.get("message", ""))
    if kind == "opaque":
        return RuntimeError(item.get("message", ""))
    if kind == "nothing":
        return None
    raise ValueError(f"the driver was asked to classify an input of unknown kind {kind!r}")


def _view_to_json(view: ErrorView) -> dict:
    return {
        "code": view.code,
        "recognised": view.recognised,
        **({"status": view.status} if view.status is not None else {}),
        **({"message": view.message} if view.message is not None else {}),
        **({"remedy": view.remedy} if view.remedy is not None else {}),
    }


COMMANDS = {
    "link_status": link_status,
    "list_projects": list_projects,
    "read_tree": read_tree,
    "propose": propose,
    "diff": diff,
    "apply": apply,
    "start_run": start_run,
    "classify": classify,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", required=True, help="base URL of a running daemon")
    parser.add_argument("--token", required=True, help="the daemon's producer token")
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        # A run waits on a language model and on the router's fallback through
        # however many the policy allows, so the client's default of 30s is the
        # wrong size for the one call that can take minutes.
        help="seconds any one call may take (default 120, sized for a run)",
    )
    args = parser.parse_args(argv)

    client = ForgeBridgeClient(
        args.daemon,
        producer_token=args.token,
        transport=guarded_transport(urllib_transport(args.timeout)),
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request: dict[str, Any] = json.loads(line)
        response = _handle(client, request)
        sys.stdout.write(f"{json.dumps(response)}\n")
        sys.stdout.flush()
    return 0


def _handle(client: ForgeBridgeClient, request: dict) -> dict:
    command = COMMANDS.get(request.get("call", ""))
    if command is None:
        # Fail closed, and say so as a driver fault rather than as a classified
        # protocol error: "I do not understand this" and "this is safe" must not
        # be the same answer. `approve` reaches here, and reaching here is the
        # point.
        return {
            "id": request.get("id"),
            "ok": False,
            "fault": (
                f"the conformance driver has no command {request.get('call')!r}. "
                f"It serves: {', '.join(sorted(COMMANDS))}."
            ),
        }

    try:
        return {"id": request.get("id"), "ok": True, "value": command(client, request)}
    except Exception as failure:  # every failure is data here, never a crash
        view = describe_error(failure)
        return {
            "id": request.get("id"),
            "ok": False,
            "error": _view_to_json(view),
            # What was actually raised, for a report a human reads. The suite
            # branches on `error.code`; this is here so that a failing run names
            # the exception rather than only its classification.
            "raised": type(failure).__name__,
        }


if __name__ == "__main__":
    raise SystemExit(main())
