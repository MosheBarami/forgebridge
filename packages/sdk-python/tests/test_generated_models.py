"""The generated module is a projection of the schemas, and stays one."""

from __future__ import annotations

import json
import pathlib

import pytest

from forgebridge.models import ALL_MODELS

REPO = pathlib.Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO / "packages" / "protocol" / "schema"


def test_every_json_schema_has_a_model() -> None:
    """One file per top-level type; one entry in ALL_MODELS per file.

    A type added to the protocol and projected into JSON Schema but never into
    Python is exactly the silent gap the whole projection exists to close.
    """
    projected = {
        path.name.removesuffix(".schema.json") for path in SCHEMA_DIR.glob("*.schema.json")
    }
    assert projected, "no generated schemas found; run `npm run generate:schemas`"
    missing = sorted(projected - set(ALL_MODELS))
    assert missing == []


def test_openapi_components_are_all_modelled() -> None:
    openapi = json.loads((SCHEMA_DIR / "openapi.json").read_text())
    components = set(openapi["components"]["schemas"])
    assert sorted(components - set(ALL_MODELS)) == []


def test_client_protocol_version_matches_the_generated_document() -> None:
    from forgebridge.client import PROTOCOL_VERSION

    openapi = json.loads((SCHEMA_DIR / "openapi.json").read_text())
    assert openapi["info"]["version"] == PROTOCOL_VERSION


def test_the_generated_file_says_not_to_edit_it() -> None:
    source = (REPO / "packages/sdk-python/src/forgebridge/models.py").read_text()
    assert "DO NOT EDIT" in source
    assert "npm run generate:schemas" in source


def test_extra_keys_are_stripped_not_refused() -> None:
    """Zod's default object mode strips unknown keys; so must this.

    Refusing them would break the additive-fields promise `/v1` makes: a producer
    speaking a later minor version would be rejected by a client that is supposed
    to ignore what it does not understand.
    """
    error = ALL_MODELS["ProtocolError"].model_validate(
        {"code": "not_found", "message": "gone", "somethingNewInV1_1": True}
    )
    assert "somethingNewInV1_1" not in error.model_dump(by_alias=True)


@pytest.mark.parametrize("name", ["ChangeSet", "Operation", "PropertyValue", "ApplyResult", "Link"])
def test_the_load_bearing_types_are_exported(name: str) -> None:
    assert name in ALL_MODELS
