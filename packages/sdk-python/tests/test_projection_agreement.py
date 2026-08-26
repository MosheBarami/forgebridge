"""The Python half of the cross-language drift proof.

The full proof lives in `scripts/__tests__/schema-projection.test.ts`, which runs
the same corpus through Zod, through the JSON Schema documents and through these
models and requires all three to agree. This file is the part a Python
contributor can run on its own: it asserts the models judge every corpus document
the way the corpus says the Zod contract does.

A failure here means the projection and the protocol have parted company. It does
not mean the corpus is wrong — the corpus is checked against Zod on the
TypeScript side.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from roundtrip import run_case

CORPUS = json.loads((pathlib.Path(__file__).resolve().parent / "corpus.json").read_text())
CASES = CORPUS["cases"]


def test_the_corpus_is_worth_running() -> None:
    assert len(CASES) >= 20
    assert any(case["name"] == "every-property-value-tag" for case in CASES)
    assert sum(1 for case in CASES if not case["zodValid"]) >= 10


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_models_agree_with_the_contract(case: dict) -> None:
    result = run_case(case)
    assert result["valid"] == case["zodValid"], result["error"]


@pytest.mark.parametrize(
    "case",
    [case for case in CASES if case["zodValid"]],
    ids=[case["name"] for case in CASES if case["zodValid"]],
)
def test_a_valid_document_survives_a_round_trip(case: dict) -> None:
    """Parse, dump, parse again, dump again — and get the same document.

    Defaults are materialised on the first parse, so a projection that applied
    them inconsistently would show up as a difference between the two dumps.
    """
    once = run_case(case)
    twice = run_case({**case, "document": once["parsed"]})
    assert twice["valid"], twice["error"]
    assert twice["parsed"] == once["parsed"]


def test_the_only_declared_divergence_is_the_ordering_rule() -> None:
    """Everything else the schema accepts, the protocol accepts.

    If a second divergence appears, it belongs in
    `packages/protocol/schema/README.md` before it belongs here.
    """
    divergent = [case["name"] for case in CASES if case["zodValid"] != case["schemaValid"]]
    assert divergent == ["duplicate-delete-ordering"]
