"""Propose a ChangeSet from Python and print the diff a person has to read.

Stops there, on purpose. Approving is a separate act by whoever read the diff
(ADR-012), and ``approve_changeset`` requires the ``contentDigest`` the diff
printed — so a producer that never loaded a diff cannot approve its own
submission.

    FORGEBRIDGE_DAEMON_URL      default http://127.0.0.1:7317
    FORGEBRIDGE_PRODUCER_TOKEN  printed once by ``forgebridge daemon``
    FORGEBRIDGE_BASE_VERSION    default 0 — see the comment on baseVersion below

Field names here are the protocol's, in camelCase, because that is what the
generated models carry: ``models.py`` is a projection of the Zod schemas in
``packages/protocol`` rather than a hand-written Python API, and renaming the
fields on the way in would put a translation layer between two things a drift
gate is checking against each other.
"""

from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone

from forgebridge import ForgeBridgeClient, ForgeBridgeError, TransportError, describe_error
from forgebridge.models import ChangeSet


def main() -> int:
    token = os.environ.get("FORGEBRIDGE_PRODUCER_TOKEN")
    if not token:
        print(
            "Set FORGEBRIDGE_PRODUCER_TOKEN. The daemon prints it once, on its own terminal:\n"
            "loopback is not an authentication boundary, so every producer route requires it.",
            file=sys.stderr,
        )
        return 2

    client = ForgeBridgeClient(
        base_url=os.environ.get("FORGEBRIDGE_DAEMON_URL", "http://127.0.0.1:7317"),
        producer_token=token,
    )

    try:
        # 1. Who is on the other end, and who else can read what we send?
        #    The posture string is printed verbatim — its wording is the contract.
        status = client.link_status()
        print(f"transport : {status.transport}")
        print(f"privacy   : {status.privacyPosture}")

        paired = [link for link in status.links if link.state == "paired"]
        if not paired:
            print(
                "\nNo Studio session is paired, so an approved ChangeSet would have nowhere to go.\n"
                "Run `forgebridge link` and enter the code in the ForgeBridge plugin.",
                file=sys.stderr,
            )
            return 1

        # 2. Build the set through the generated model rather than as a dict.
        #    That is the point of this SDK: a set the protocol would refuse is
        #    refused here, with the field named, before a request is made.
        #
        #    `baseVersion` is the tree version this set was built against. The
        #    daemon refuses an apply whose base has moved, with `stale_base`,
        #    rather than merging — there is no last-write-wins path here. It is
        #    0 and overridable by hand because `/v1` publishes no route that
        #    reports the current version yet.
        changeset = ChangeSet.model_validate(
            {
                "id": str(uuid.uuid4()),
                "projectId": paired[0].projectId,
                "baseVersion": int(os.environ.get("FORGEBRIDGE_BASE_VERSION", "0")),
                "summary": "Add a Prices folder under the shop",
                "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "operations": [
                    {
                        "op": "createInstance",
                        "path": "ServerScriptService.Shop.Prices",
                        "className": "Folder",
                    }
                ],
            }
        )

        # 3. Propose. Nothing is applied and nothing is approved. Whatever this
        #    client puts in `validation` and `status` is discarded: the daemon
        #    recomputes the verdict inside its own trust boundary, so a set
        #    cannot arrive pre-approved or carrying its own opinion of itself.
        submitted = client.propose_changeset(changeset)
        print(f"\nchangeset : {submitted.changeSetId}")
        print(f"status    : {submitted.status}")
        print(f"luau      : {submitted.validation.luau.status}")
        print(f"policy    : {submitted.validation.policy.status}")
        print(f"computedBy: {submitted.validation.computedBy}")

        # 4. The diff. Destructive operations are ordered first.
        diff = client.get_diff(submitted.changeSetId)
        print(f"digest    : {diff.contentDigest}")
        for operation in diff.operations:
            marker = "!" if operation.destructive else " "
            print(f" {marker} {operation.op:>16}  {', '.join(operation.paths)}")

        print(
            "\nApprove it with the digest above, from a terminal belonging to whoever read this:\n"
            f"  forgebridge approve {submitted.changeSetId} --digest {diff.contentDigest}"
        )
        return 0

    except ForgeBridgeError as error:
        # `describe_error` renders the protocol's error envelope — the code, the
        # message and the retry advice the daemon actually sent — rather than a
        # repr of an exception.
        print(f"\n{describe_error(error)}", file=sys.stderr)
        return 1
    except TransportError as error:
        print(f"\nThe daemon did not answer: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
