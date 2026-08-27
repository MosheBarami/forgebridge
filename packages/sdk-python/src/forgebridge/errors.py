"""The protocol's error surface, as a Python exception.

`ErrorCode` is a closed set on purpose — a consumer must be able to branch on the
code, and "some string the server felt like" is not branchable. So the exception
carries the code as data rather than encoding it in a class hierarchy that would
have to grow a subclass every time the protocol adds one.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import ErrorCode, ProtocolError

__all__ = [
    "ErrorCode",
    "ErrorView",
    "ForgeBridgeError",
    "ProtocolError",
    "describe_error",
]


class ForgeBridgeError(Exception):
    """A `/v1` call that came back with a protocol error body."""

    def __init__(self, error: ProtocolError, status: int) -> None:
        super().__init__(error.message)
        self.error = error
        self.status = status

    @property
    def code(self) -> str:
        return self.error.code

    @property
    def remedy(self) -> str | None:
        return self.error.remedy

    def __str__(self) -> str:
        suffix = f" — {self.error.remedy}" if self.error.remedy else ""
        return f"[{self.error.code}] {self.error.message}{suffix}"


class TransportError(Exception):
    """The call never reached a `/v1` handler, or came back as something else.

    Kept distinct from `ForgeBridgeError` because the two demand different
    responses: a protocol error is an answer, and a transport error is the
    absence of one.
    """


@dataclass(frozen=True)
class ErrorView:
    """One failure, reduced to the thing a caller branches on.

    `code` is always a member of `ErrorCode`, because the set is closed and a
    caller must be able to branch on it. `recognised` says whether this was read
    as a protocol error or defaulted — and the distinction is the whole point of
    the field. An unrecognised failure reported as `internal` is correct; an
    unrecognised failure reported as `not_approved` would be this SDK inventing
    an approval decision out of a socket timeout.
    """

    code: ErrorCode
    recognised: bool
    #: The HTTP status the answer arrived with, when there was an answer.
    status: int | None = None
    message: str | None = None
    remedy: str | None = None


def describe_error(error: object) -> ErrorView:
    """Classify anything this package can hand back.

    Callers of this SDK already branch on these facts — `except ForgeBridgeError
    as failure: failure.code`, `except TransportError` — so this function
    contains no judgement they do not already make. It exists because those two
    `except` clauses are a *shape* rather than a value, and a shape cannot be
    handed to something generic: a connector conformance suite, a retry policy,
    a router that decides whether to rebase or to go and find a human all need
    the answer as data.

    Every branch below is total. There is no path that returns nothing and no
    path that raises, because a classifier that can fail is one a caller cannot
    use inside a `except` block — which is the only place it is ever called.
    """
    if isinstance(error, ForgeBridgeError):
        return ErrorView(
            code=error.error.code,
            recognised=True,
            status=error.status,
            message=error.error.message,
            remedy=error.error.remedy,
        )

    if isinstance(error, TransportError):
        # TODO(M31): the protocol's ErrorCode has no "the transport is not
        # reachable" member, so this lands on `internal` and carries the truth in
        # its remedy — the same gap `packages/mcp/src/daemon-client.ts` and
        # `packages/daemon/src/auth.ts` both name. Owner: the protocol
        # maintainer, as an additive change. `recognised` is False on purpose:
        # this is not a protocol error, it is the absence of an answer, and
        # saying otherwise would claim the daemon said something it never said.
        return ErrorView(
            code="internal",
            recognised=False,
            message=str(error),
            remedy=(
                "The call never reached a /v1 handler. Check that the daemon is running and "
                "that base_url points at it."
            ),
        )

    # A protocol error as it actually arrives over a wire this package did not
    # read: a JSON body, not an instance of anybody's class. A classifier that
    # only understands its own exception type has a mapping that works in its
    # own tests and nowhere else.
    if isinstance(error, ProtocolError):
        payload: ProtocolError | None = error
    else:
        try:
            payload = ProtocolError.model_validate(error)
        except Exception:
            payload = None

    if payload is not None:
        return ErrorView(
            code=payload.code,
            recognised=True,
            message=payload.message,
            remedy=payload.remedy,
        )

    return ErrorView(
        code="internal",
        recognised=False,
        message=f"{type(error).__name__}: {error}" if error is not None else "nothing was raised",
    )
