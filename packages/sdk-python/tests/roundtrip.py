"""Run the shared corpus through the generated models and report what happened.

Not a test itself — a subprocess entry point. The cross-language drift proof
lives in `scripts/__tests__/schema-projection.test.ts`, which has the Zod schemas
and the JSON Schema documents in hand but cannot import pydantic; it shells out
to this file for the third leg and compares all three.

Prints one JSON object per corpus case to stdout:

    {"name": ..., "valid": bool, "parsed": <the model's own dump> | null,
     "error": <str> | null}
"""

from __future__ import annotations

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from forgebridge.checks import check_changeset_ordering  # noqa: E402
from forgebridge.models import ALL_MODELS  # noqa: E402

CORPUS = HERE / "corpus.json"


def run_case(case: dict) -> dict:
    model = ALL_MODELS.get(case["type"])
    if model is None:
        return {"name": case["name"], "valid": False, "parsed": None,
                "error": f"no generated model named {case['type']}"}
    try:
        instance = model.model_validate(case["document"])
    except Exception as error:  # pydantic raises ValidationError; anything else is a bug here
        return {"name": case["name"], "valid": False, "parsed": None, "error": str(error)}

    # The one constraint JSON Schema cannot carry. Applied here rather than
    # inside the model so that "the schema accepts it" and "the protocol accepts
    # it" stay visibly different answers.
    if case["type"] == "ChangeSet":
        issues = check_changeset_ordering(instance)
        if issues:
            return {"name": case["name"], "valid": False, "parsed": None,
                    "error": "; ".join(issues), "unprojected": True}

    return {"name": case["name"], "valid": True,
            "parsed": instance.model_dump(mode="json", by_alias=True), "error": None}


def main() -> int:
    corpus = json.loads(CORPUS.read_text())
    print(json.dumps([run_case(case) for case in corpus["cases"]]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
