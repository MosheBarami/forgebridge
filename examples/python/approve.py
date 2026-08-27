"""Step 2 of 3 — clear a ChangeSet for delivery.

A separate file from `propose.py`, and separate on purpose. ADR-012 makes
approval an act a model does not perform, so the walk-through offers no `--yes`
flag on the propose step: the two halves are two commands, run by whoever read
the diff.

The digest is an argument rather than something this script fetches, and that is
the mechanism rather than an inconvenience. Reading the diff again here and
echoing whatever it said would approve *this script's* idea of the set. Typing
the digest that was printed to a person is what turns "I approve set X" into "I
approve the operations I was shown for set X" — and if the set changed since, the
daemon refuses the approval instead of quietly clearing something nobody read.

    python examples/python/approve.py <changeSetId> <contentDigest> [--confirm-bulk-delete]
"""

from __future__ import annotations

import getpass
import os
import sys

from forgebridge import ForgeBridgeClient, describe_error
from forgebridge.models import ApproveRequest


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: python examples/python/approve.py <changeSetId> <contentDigest> "
            "[--confirm-bulk-delete]\n"
            "Both come from propose.py, which prints the exact command.",
            file=sys.stderr,
        )
        return 2

    token = os.environ.get("FORGEBRIDGE_PRODUCER_TOKEN")
    if not token:
        print("Set FORGEBRIDGE_PRODUCER_TOKEN, which the daemon printed.", file=sys.stderr)
        return 2

    changeset_id, content_digest = argv[0], argv[1]
    client = ForgeBridgeClient(
        os.environ.get("FORGEBRIDGE_DAEMON_URL", "http://127.0.0.1:7317"),
        producer_token=token,
    )

    approved = client.approve_changeset(
        changeset_id,
        ApproveRequest(
            contentDigest=content_digest,
            approvedBy=getpass.getuser(),
            # A separate flag rather than a bigger button. The daemon requires it
            # when a set removes more instances than the protocol's bulk
            # threshold, so the approver has to say the destructive part aloud.
            confirmBulkDelete="--confirm-bulk-delete" in argv[2:],
        ),
    )

    print(f"approved  : {approved.changeSetId}")
    print(f"status    : {approved.status}")
    print(f"nonce     : {approved.nonce}")
    print(
        "\nQueued for the paired Studio session. The plugin polls, applies, and reports back."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as failure:  # nothing escapes unclassified: describe_error is total
        view = describe_error(failure)
        print(f"[{view.code}] {view.message or 'the approval failed'}", file=sys.stderr)
        if view.remedy:
            print(view.remedy, file=sys.stderr)
        if view.code == "invalid_request":
            print(
                "A digest that does not match is the gate working: the operations the daemon\n"
                "holds are not the ones that were printed. Read the diff again before approving.",
                file=sys.stderr,
            )
        raise SystemExit(1) from failure
