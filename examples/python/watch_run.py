"""The other way a ChangeSet comes into existence: hand the daemon a prompt.

A run is on the *propose* side of the approval gate. It returns a ChangeSet
stored `validated`, and clearing it is still `approve.py` — `StartRunRequest` has
no field that reaches approval and none that carries a validation, so a producer
cannot send a verdict of its own because there is nowhere to put one.

What this script is for is the attempt list, watched as it happens. The router
falls back over however many models the policy allows, and every model it tried
is reported in order with why it moved on (ADR-008): a fallback the caller cannot
see is a silent substitution, and the code in the ChangeSet was written by the
model in the last `ok` attempt — which may not be the one that was asked for.

    python examples/python/watch_run.py "add a respawn handler"
"""

from __future__ import annotations

import os
import sys

from forgebridge import ForgeBridgeClient, RunEvent, describe_error
from forgebridge.models import StartRunRequest


def show(event: RunEvent) -> None:
    """Progress goes to stderr, so a pipeline reading stdout still works."""
    if event.name in {"stage", "model-attempt", "model-skipped"}:
        print(f"… {event.name}: {event.data}", file=sys.stderr)


def main(prompt: str) -> int:
    token = os.environ.get("FORGEBRIDGE_PRODUCER_TOKEN")
    if not token:
        print("Set FORGEBRIDGE_PRODUCER_TOKEN, which the daemon printed.", file=sys.stderr)
        return 2

    # `run_idle_timeout` bounds *silence*, not the run: a model that thinks for
    # four minutes and then answers is a run that worked, and the daemon writes a
    # keep-alive frame on an idle stream, so silence is a dropped connection.
    client = ForgeBridgeClient(
        os.environ.get("FORGEBRIDGE_DAEMON_URL", "http://127.0.0.1:7317"),
        producer_token=token,
        run_idle_timeout=120.0,
    )

    response = client.start_run(StartRunRequest(prompt=prompt), on_event=show)

    print("models tried, in order:")
    for attempt in response.run.attempts:
        note = f" ({attempt.note})" if attempt.note else ""
        print(f"  {attempt.modelId} → {attempt.outcome}{note}")
    for skipped in response.skipped:
        # Skipped is not attempted, and the two are never merged: a ModelAttempt
        # describing a call that never happened would be a record of a fiction.
        print(f"  {skipped.modelId} → never invoked ({skipped.reason}: {skipped.detail})")

    if response.changeSetId is None:
        message = response.failure.message if response.failure else "no reason given"
        print(f"\nthe run produced no ChangeSet: {message}", file=sys.stderr)
        return 1

    print(f"\nchangeset : {response.changeSetId}")
    print(f"status    : {response.changeSetStatus}")
    print(
        "\nNothing has been applied. Read it, then clear it:\n\n"
        f"  python examples/python/approve.py {response.changeSetId} {response.contentDigest}\n"
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print('usage: python examples/python/watch_run.py "<prompt>"', file=sys.stderr)
        raise SystemExit(2)
    try:
        raise SystemExit(main(" ".join(sys.argv[1:])))
    except SystemExit:
        raise
    except Exception as failure:  # nothing escapes unclassified: describe_error is total
        view = describe_error(failure)
        print(f"[{view.code}] {view.message or 'the run failed'}", file=sys.stderr)
        if view.remedy:
            print(view.remedy, file=sys.stderr)
        raise SystemExit(1) from failure
