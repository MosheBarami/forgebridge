"""`describe_error` is total, and it never invents a decision nobody made."""

from __future__ import annotations

import pytest

from forgebridge import describe_error
from forgebridge.errors import ForgeBridgeError, TransportError
from forgebridge.models import ErrorCode, ProtocolError

CODES = list(ErrorCode.__args__)


@pytest.mark.parametrize("code", CODES)
def test_a_raised_protocol_error_keeps_its_code(code: str) -> None:
    """The code is the thing a caller branches on, so it survives untouched."""
    failure = ForgeBridgeError(ProtocolError(code=code, message=f"synthetic {code}"), 400)
    view = describe_error(failure)

    assert view.code == code
    assert view.recognised is True
    assert view.status == 400


@pytest.mark.parametrize("code", CODES)
def test_the_same_code_off_the_wire(code: str) -> None:
    """A body nobody has parsed yet is how a protocol error usually arrives.

    A classifier that only understands its own exception class has a mapping that
    works in its own tests and nowhere else, so the JSON form is checked for
    every code and not only for one.
    """
    view = describe_error({"code": code, "message": f"synthetic {code}", "remedy": "do the thing"})

    assert view.code == code
    assert view.recognised is True
    assert view.remedy == "do the thing"


def test_the_covered_codes_are_all_of_them() -> None:
    """A guard on the guard: the parametrisation reads the enum, not a list."""
    assert len(CODES) == 14
    assert "not_approved" in CODES


def test_a_transport_error_is_internal_and_not_recognised() -> None:
    """The absence of an answer is not an answer.

    `internal` because the protocol has no code for "the transport is not
    reachable" (TODO(M31)), and `recognised is False` because reporting it as a
    protocol error would claim the daemon said something it never said.
    """
    view = describe_error(TransportError("connection refused"))

    assert view.code == "internal"
    assert view.recognised is False
    assert view.remedy and "daemon is running" in view.remedy


def test_an_unrecognised_failure_defaults_to_internal() -> None:
    view = describe_error(RuntimeError("socket hang up"))

    assert view.code == "internal"
    assert view.recognised is False
    # Not `not_approved`, and the distance between those two is the reason this
    # test exists: an unrecognised failure classified as an approval decision
    # would be this SDK inventing one out of a network event.
    assert "socket hang up" in (view.message or "")


def test_nothing_at_all_is_still_classified() -> None:
    """A timed-out transport can hand a caller `None`. It must not crash here."""
    view = describe_error(None)

    assert view.code == "internal"
    assert view.recognised is False


@pytest.mark.parametrize(
    "value",
    [
        {"code": "not_a_code", "message": "made up"},
        {"message": "no code at all"},
        "a bare string",
        42,
        [],
    ],
)
def test_a_shape_that_is_not_a_protocol_error_is_not_read_as_one(value: object) -> None:
    """Fail closed. "I do not understand this" must not answer "this is safe"."""
    view = describe_error(value)

    assert view.code == "internal"
    assert view.recognised is False
