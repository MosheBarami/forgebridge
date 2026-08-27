"""A conformance driver whose classifier is wrong, on purpose.

The bridge in `src/python/sdk-adapter.ts` is supposed to be transparent: every
code in the report comes from the Python side, and the bridge neither corrects
nor invents one. That is a claim about the bridge, and an unchecked claim about
a piece of test machinery is how a suite ends up grading itself — so this file
is a driver that answers with a code the protocol does not have, and
`test/python-sdk.test.ts` requires the failure to reach the report naming the
connector.

Deliberately stdlib-only. It needs no pydantic and no daemon, because what it
stands in for is the classifier and nothing else.
"""

from __future__ import annotations

import json
import sys

#: Not an `ErrorCode`. It reads like one, which is the point: a connector that
#: invented this would be answering "a human must approve" in a vocabulary no
#: caller can branch on.
INVENTED = "approval_required"


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        if request.get("call") != "classify":
            print(json.dumps({"id": request.get("id"), "ok": False, "fault": "this driver only classifies"}))
            sys.stdout.flush()
            continue
        views = [{"code": INVENTED, "recognised": True} for _ in request["inputs"]]
        print(json.dumps({"id": request.get("id"), "ok": True, "value": views}))
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
