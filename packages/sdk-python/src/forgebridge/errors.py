"""The protocol's error surface, as a Python exception.

`ErrorCode` is a closed set on purpose — a consumer must be able to branch on the
code, and "some string the server felt like" is not branchable. So the exception
carries the code as data rather than encoding it in a class hierarchy that would
have to grow a subclass every time the protocol adds one.
"""

from __future__ import annotations

from .models import ErrorCode, ProtocolError

__all__ = ["ErrorCode", "ForgeBridgeError", "ProtocolError"]


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
