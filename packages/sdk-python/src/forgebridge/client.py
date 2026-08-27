"""A thin client for the ForgeBridge `/v1` surface.

Thin is the whole design (ADR-009). Every method here translates a call into an
HTTP request and a response back into a generated model, and does nothing else:
no retries that hide a `stale_base`, no queueing, no "convenience" that decides
something the daemon is supposed to decide. A connector that makes a policy
decision has put that decision somewhere `@forgebridge/core` cannot see it.

The one rule this file exists to keep visible:

    **Proposing and approving are separate calls, and there is no method that
    does both.** `propose_changeset` submits; `approve_changeset` clears the set
    to be delivered. ADR-012 puts a human between those two steps, and a helper
    that chained them — however convenient — would let a model approve its own
    work. If you find yourself wanting one, that is the gate working.

`start_run` is on the same side of that line as `propose_changeset`: it hands a
prompt to the daemon's own model and gets back a ChangeSet in `validated`. A run
is not a shortcut past the gate, and its request shape has no field that reaches
one.

Only the standard library is used for transport. A client whose job is to be
easy to drop into somebody else's agent should not drag an HTTP stack in with
it, and `transport=` lets a caller supply their own (httpx, requests, a test
double) without this module knowing about any of them.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from .errors import ForgeBridgeError, TransportError
from .models import (
    ApplyResultAck,
    ApproveRequest,
    ApproveResponse,
    ChangeSet,
    ChangeSetDiff,
    DeliveryEnvelope,
    HealthResponse,
    JournalEntryAck,
    JournalStateResponse,
    LinkStatusResponse,
    ModelsSnapshot,
    OutputResponse,
    PairRequest,
    PairResponse,
    ProtocolError,
    RollbackRequest,
    RollbackResponse,
    RollbackResultAck,
    RunResponse,
    StartRunRequest,
    SubmitChangeSetResponse,
)
from .stream import RunEvent, iter_event_frames

__all__ = [
    "PROTOCOL_VERSION",
    "ForgeBridgeClient",
    "HttpResponse",
    "StreamResponse",
    "StreamTransport",
    "Transport",
    "urllib_stream_transport",
    "urllib_transport",
]

#: Kept in step with `packages/protocol/src/version.ts` by
#: `tests/test_generated_models.py`, which reads the generated OpenAPI document.
PROTOCOL_VERSION = "1.0.0"

PRODUCER_TOKEN_HEADER = "X-ForgeBridge-Token"
LINK_HEADER = "X-ForgeBridge-Link"
MAC_HEADER = "X-ForgeBridge-Mac"
PROTOCOL_VERSION_HEADER = "X-ForgeBridge-Protocol"


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


#: `(method, url, headers, body) -> HttpResponse`. A transport must return the
#: response for any status the server produced, including 4xx and 5xx: this
#: client turns those into `ForgeBridgeError`, and a transport that raises on
#: them instead hides the protocol's error codes.
Transport = Callable[[str, str, Mapping[str, str], "bytes | None"], HttpResponse]


def urllib_transport(timeout: float = 30.0) -> Transport:
    """The default transport: `urllib`, no third-party dependency."""

    def send(method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> HttpResponse:
        request = urllib.request.Request(url, data=body, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return HttpResponse(status=response.status, body=response.read())
        except urllib.error.HTTPError as error:  # a real answer, just not a 2xx
            return HttpResponse(status=error.code, body=error.read())
        except urllib.error.URLError as error:
            raise TransportError(str(error)) from error

    return send


@dataclass(frozen=True)
class StreamResponse:
    """An answer being read as it arrives.

    `chunks` is consumed once. A non-2xx answer is still a `StreamResponse` — the
    body is the `ProtocolError` the daemon sent, and a transport that raised on
    it instead would hide the one thing the caller needs to branch on.
    """

    status: int
    content_type: str
    chunks: Iterator[bytes]


#: `(method, url, headers, body) -> StreamResponse`. Separate from `Transport`
#: because the two have genuinely different shapes: one answer read whole, or one
#: read as it arrives. Folding them together would mean every ordinary call
#: carrying an iterator nobody iterates.
StreamTransport = Callable[[str, str, Mapping[str, str], "bytes | None"], StreamResponse]


def urllib_stream_transport(idle_timeout: float = 120.0) -> StreamTransport:
    """The default stream transport: `urllib`, no third-party dependency.

    `idle_timeout` is `urllib`'s socket timeout, which is already a per-read
    ceiling rather than a deadline for the whole response — so it measures
    *silence*, which is the only thing that separates a dropped connection from a
    model that is still thinking. The daemon writes a keep-alive comment frame on
    an idle stream, so silence for this long is a dead socket rather than a slow
    run.
    """

    def send(
        method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> StreamResponse:
        request = urllib.request.Request(url, data=body, method=method)
        for name, value in headers.items():
            request.add_header(name, value)

        def chunks(response: Any) -> Iterator[bytes]:
            try:
                while True:
                    chunk = response.read(_STREAM_CHUNK_BYTES)
                    if not chunk:
                        return
                    yield chunk
            finally:
                response.close()

        try:
            response = urllib.request.urlopen(request, timeout=idle_timeout)
        except urllib.error.HTTPError as error:  # a real answer, just not a 2xx
            payload = error.read()
            error.close()
            return StreamResponse(
                status=error.code,
                content_type=error.headers.get("content-type", ""),
                chunks=iter([payload]),
            )
        except urllib.error.URLError as error:
            raise TransportError(str(error)) from error

        return StreamResponse(
            status=response.status,
            content_type=response.headers.get("content-type", ""),
            chunks=chunks(response),
        )

    return send


#: Small enough that a frame is handed on as soon as it completes rather than
#: when a buffer happens to fill. A run stream is a handful of bytes every few
#: seconds, and the point of reading it at all is that it is live.
_STREAM_CHUNK_BYTES = 1024


class ForgeBridgeClient:
    """Producer-side and consumer-side calls against one `/v1` base address.

    `producer_token` is the per-process secret the daemon prints at startup.
    Loopback is not an authentication boundary — any process on the machine can
    reach the port — so every producer route requires it, and the two that
    matter most are `approve_changeset` and `request_rollback`.
    """

    def __init__(
        self,
        base_url: str,
        *,
        producer_token: str | None = None,
        link_id: str | None = None,
        transport: Transport | None = None,
        stream_transport: StreamTransport | None = None,
        timeout: float = 30.0,
        run_idle_timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.producer_token = producer_token
        self.link_id = link_id
        self._send = transport or urllib_transport(timeout)
        # Separate from `_send`, and separately overridable, because the two
        # answer different questions: `timeout` bounds one whole exchange, while
        # `run_idle_timeout` bounds a *silence* on a stream that may legitimately
        # take minutes. A single number cannot mean both.
        self._stream = stream_transport or urllib_stream_transport(run_idle_timeout)

    # ── public surface, unauthenticated ────────────────────────────────────

    def health(self) -> HealthResponse:
        return HealthResponse.model_validate(self._call("GET", "/v1/health"))

    def link_status(self) -> LinkStatusResponse:
        return LinkStatusResponse.model_validate(self._call("GET", "/v1/link"))

    def models(self) -> ModelsSnapshot:
        return ModelsSnapshot.model_validate(self._call("GET", "/v1/models"))

    def pair(self, request: PairRequest) -> PairResponse:
        return PairResponse.model_validate(self._call("POST", "/v1/link/pair", body=request))

    # ── producer surface ───────────────────────────────────────────────────

    def propose_changeset(self, changeset: ChangeSet) -> SubmitChangeSetResponse:
        """Submit a ChangeSet. This does not approve it and does not apply it.

        The daemon recomputes `validation` and overwrites `status`, so whatever
        this client sends in those two fields is discarded — a set cannot arrive
        pre-approved or carrying its own verdict.
        """
        return SubmitChangeSetResponse.model_validate(
            self._call("POST", "/v1/changesets", body=changeset, producer=True)
        )

    def start_run(
        self,
        request: StartRunRequest,
        on_event: Callable[[RunEvent], None] | None = None,
    ) -> RunResponse:
        """Turn a prompt into a proposed ChangeSet. Nothing is applied.

        The run stops at the human gate: the ChangeSet it produces is stored
        `validated`, and clearing it is `approve_changeset`, which is a separate
        call for the reason ADR-012 gives. There is no field on `StartRunRequest`
        that reaches approval, so a caller cannot ask for its own work to be
        cleared even by accident.

        `response.run.attempts` is the complete list of models the router tried,
        in order, with why it moved on from each one (ADR-008). Report it whole.
        The code in the ChangeSet was written by the model named in the last
        successful attempt, which may not be the one that was asked for, and a
        caller that shows only the winner is misreporting who wrote it.

        **This call waits on a language model**, and on the router's fallback
        through however many models the policy allows, so it can take minutes.
        The client's `timeout` applies here as it does to every other call, so
        construct the client with one sized for a run — or pass a `transport` of
        your own that knows the difference.

        Pass `on_event` to follow the run as it happens. The answer is the same
        `RunResponse` either way, because the streamed form's last `run` frame
        *is* the JSON body — a client that reconstructed the result from the
        events it happened to catch would be a client whose answer depended on
        how fast it was reading. With a listener the wall-clock `timeout` is
        replaced by `run_idle_timeout`, which measures silence.

        `stream` is not a field a caller sets. This client sets it from whether
        it was given a listener, so the request and the way the answer is read
        cannot disagree; a caller that asked for a stream and then did not read
        one would hold a socket open until the daemon gave up on it. A
        caller-supplied `stream=True` is refused rather than quietly downgraded.
        """
        if request.stream:
            raise TransportError(
                "start_run sets stream itself, from whether it was given a listener. "
                "Pass on_event=... to follow the run as it happens, or leave stream at "
                "its default of False for the single JSON answer, which carries the "
                "attempt list in full."
            )
        if on_event is None:
            return RunResponse.model_validate(
                self._call("POST", "/v1/runs", body=request, producer=True)
            )
        return self._follow_run(
            "POST",
            "/v1/runs",
            body=request.model_copy(update={"stream": True}),
            on_event=on_event,
        )

    def get_run(self, run_id: str) -> RunResponse:
        """Read a run the daemon already recorded.

        Addressable while the run is still going and not only after it: the
        daemon writes the record before it calls the first model. So this is how
        a caller that lost its connection — or one that never held it — finds
        out which models were tried.
        """
        return RunResponse.model_validate(
            self._call("GET", f"/v1/runs/{_segment(run_id)}", producer=True)
        )

    def watch_run(
        self,
        run_id: str,
        *,
        since: int | None = None,
        on_event: Callable[[RunEvent], None] | None = None,
    ) -> RunResponse:
        """Replay and follow a run as it happens, and return what it settled on.

        Opens with a `run` frame so a caller that arrives late knows what the
        events are about, replays the retained events from `since`, then follows
        until the run ends. The log is in memory and capped: `output-delta`
        frames are never retained, and a run old enough to have been evicted
        answers with the run record and a `closed` frame rather than stopping
        quietly. Nothing the stream can lose is missing from the record — the
        attempt list is on the `run` frame.

        Use `iter_run_events` instead when the frames themselves are the point
        and the final record is not.
        """
        query = "" if since is None else f"?since={int(since)}"
        return self._follow_run(
            "GET",
            f"/v1/runs/{_segment(run_id)}/events{query}",
            body=None,
            on_event=on_event,
        )

    def iter_run_events(self, run_id: str, *, since: int | None = None) -> Iterator[RunEvent]:
        """Every frame of a run's event stream, as it arrives.

        The generator holds the socket open, so a caller that stops iterating
        should close it (`gen.close()`, or leaving the `for` loop, which does).
        An `error` frame is yielded rather than raised here: this is the raw
        reader, and deciding that a frame ends the call is `watch_run`'s job.
        """
        response = self._open_stream("GET", f"/v1/runs/{_segment(run_id)}/events", since=since)
        yield from iter_event_frames(response.chunks)

    def get_diff(self, changeset_id: str) -> ChangeSetDiff:
        return ChangeSetDiff.model_validate(
            self._call("GET", f"/v1/changesets/{_segment(changeset_id)}/diff", producer=True)
        )

    def approve_changeset(self, changeset_id: str, request: ApproveRequest) -> ApproveResponse:
        """Clear a ChangeSet to be delivered to the paired Studio session.

        Deliberately not reachable from `propose_changeset`. Approval is the one
        step ADR-012 reserves for a human, and a producer that could do both in
        one call would be a model approving its own work.

        The daemon refuses a set whose validation failed, a stale `baseVersion`,
        and a bulk delete without `confirm_bulk_delete` — none of which this
        client second-guesses.
        """
        return ApproveResponse.model_validate(
            self._call(
                "POST",
                f"/v1/changesets/{_segment(changeset_id)}/approve",
                body=request,
                producer=True,
            )
        )

    def request_rollback(self, journal_id: str, request: RollbackRequest) -> RollbackResponse:
        """Dispatch a rollback. Dispatched is not done.

        Still not, and it never will be from this call: the delivery carries the
        inverse operations, the paired Studio session polls for it, replays them
        and reports afterwards. What M11 changed is that the outcome exists on
        the wire at all — read it with `get_journal`, which is the only thing
        that can tell a completed reversal from a partial one.

        Refused when the daemon holds no inverses for the apply. That is a
        deliberate fail-closed: a reversal it cannot send is not one it will
        pretend to dispatch, and the refusal names the Studio session that may
        still be able to undo in place.
        """
        return RollbackResponse.model_validate(
            self._call(
                "POST",
                f"/v1/journal/{_segment(journal_id)}/rollback",
                body=request,
                producer=True,
            )
        )

    def get_journal(self, journal_id: str) -> JournalStateResponse:
        """Read what happened to one apply, and to any reversal of it.

        `state` has five values and three of them mean a rollback did not fully
        happen. `rollback_partial` in particular is its own answer and must not
        be read as a variety of `rolled_back`: some inverses replayed and some
        did not, so the place is in a state neither the original apply nor the
        rollback describes, and the inverses that would have finished the job
        have been consumed. `result.outcomes` says which ones failed.

        `inverses` is `None`, not `0`, when this daemon holds none — the two are
        different facts, and only one of them means there is no route back.
        """
        return JournalStateResponse.model_validate(
            self._call("GET", f"/v1/journal/{_segment(journal_id)}", producer=True)
        )

    def read_output(self, link: str | None = None) -> OutputResponse:
        query = f"?link={urllib.parse.quote(link)}" if link else ""
        return OutputResponse.model_validate(
            self._call("GET", f"/v1/output{query}", producer=True)
        )

    # ── consumer surface ───────────────────────────────────────────────────
    #
    # Every call below is authenticated by a MAC over the request under the
    # session key derived at pairing, and this package cannot derive that key.
    # The derivation and the MAC construction live in
    # `packages/daemon/src/envelope.ts` and are not specified anywhere a second
    # implementation could be written against without reading that file and
    # guessing at the parts it leaves implicit — which is exactly the kind of
    # guess `docs/PROTOCOL.md` forbids.
    #
    # So the MAC is a parameter. A caller that has one (a Studio plugin, a test
    # harness, a relay) can drive these; a caller that does not cannot, and gets
    # told so instead of sending something that will fail to verify.
    #
    # TODO(M30): a Python-side pairing and MAC implementation, once M18 has
    # written the pairing handshake down as a specification rather than as one
    # TypeScript file. Owner: whoever owns `packages/sdk-python` at M30.

    def poll(self, *, mac: str, since: int = 0) -> DeliveryEnvelope | None:
        """Long-poll for the next delivery. `None` means the poll timed out empty."""
        payload = self._call(
            "GET",
            f"/v1/link/poll?since={int(since)}",
            consumer_mac=mac,
            allow_empty=True,
        )
        return None if payload is None else DeliveryEnvelope.model_validate(payload)

    def report_apply_result(
        self,
        envelope: DeliveryEnvelope,
        *,
        changeset_id: str | None = None,
    ) -> ApplyResultAck:
        """Report an ApplyResult, sealed in an envelope this client did not seal.

        A partial apply is a legal outcome and is reported as one; the consumer
        never claims a clean apply it did not achieve.
        """
        path = (
            f"/v1/changesets/{_segment(changeset_id)}/apply-result"
            if changeset_id
            else "/v1/apply-result"
        )
        return ApplyResultAck.model_validate(self._call("POST", path, body=envelope, link=True))

    def record_journal_entry(
        self, journal_id: str, envelope: DeliveryEnvelope
    ) -> JournalEntryAck:
        """Upload the inverse operations captured before an apply ran.

        The payload is a `JournalEntry`. This is what takes the inverses off the
        session that captured them; without it a rollback cannot outlive that
        session, which makes it a session feature rather than a safety net.

        Post it after the ApplyResult, never before: the daemon attaches the
        entry to the apply it already witnessed and refuses one for an apply it
        has not seen.
        """
        return JournalEntryAck.model_validate(
            self._call(
                "POST",
                f"/v1/journal/{_segment(journal_id)}/entry",
                body=envelope,
                link=True,
            )
        )

    def report_rollback_result(
        self, journal_id: str, envelope: DeliveryEnvelope
    ) -> RollbackResultAck:
        """Report how far a reversal got. The payload is a `RollbackResult`.

        A partial reversal is reported as a partial reversal — one outcome per
        inverse attempted, nothing rounded up — and the daemon leaves
        `rolledBackAt` null for it, because the entry is then neither reversed
        nor intact.
        """
        return RollbackResultAck.model_validate(
            self._call(
                "POST",
                f"/v1/journal/{_segment(journal_id)}/rollback-result",
                body=envelope,
                link=True,
            )
        )

    def mirror_output(self, envelope: DeliveryEnvelope) -> None:
        """Mirror the Studio console up. The payload is an OutputBatch."""
        self._call("POST", "/v1/output", body=envelope, link=True, allow_empty=True)

    # ── plumbing ───────────────────────────────────────────────────────────

    def _open_stream(self, method: str, path: str, *, since: int | None = None) -> StreamResponse:
        """One request whose answer is read as it arrives, not whole."""
        if not self.producer_token:
            raise TransportError(
                f"{path} is producer surface and needs the daemon's producer token; "
                "construct the client with producer_token=..."
            )
        query = "" if since is None else f"?since={int(since)}"
        return self._stream(
            method,
            f"{self.base_url}{path}{query}",
            {
                "Accept": "text/event-stream",
                PROTOCOL_VERSION_HEADER: PROTOCOL_VERSION,
                PRODUCER_TOKEN_HEADER: self.producer_token,
            },
            None,
        )

    def _follow_run(
        self,
        method: str,
        path: str,
        *,
        body: Any,
        on_event: Callable[[RunEvent], None] | None,
    ) -> RunResponse:
        """Read a run stream to its end and return the run it settled on.

        The `run` frame is the answer; every other frame goes to the listener. A
        stream that ends without one is a failure rather than an empty success —
        "no model was tried" and "I did not see which models were tried" are
        different facts, and only one of them is something this client observed.
        """
        headers: dict[str, str] = {
            "Accept": "text/event-stream, application/json",
            PROTOCOL_VERSION_HEADER: PROTOCOL_VERSION,
        }
        if not self.producer_token:
            raise TransportError(
                f"{path} is producer surface and needs the daemon's producer token; "
                "construct the client with producer_token=..."
            )
        headers[PRODUCER_TOKEN_HEADER] = self.producer_token

        encoded: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            encoded = json.dumps(
                body.model_dump(mode="json", by_alias=True), separators=(",", ":")
            ).encode("utf-8")

        response = self._stream(method, f"{self.base_url}{path}", headers, encoded)

        # The daemon refuses some runs before it opens the stream — no model
        # client, a stale base version, `pinned` with nothing pinned — and those
        # arrive as an ordinary JSON error with a status on it. So the content
        # type decides how the body is read, never the flag that was sent.
        if "text/event-stream" not in response.content_type:
            payload = b"".join(response.chunks)
            parsed = _json_or_transport_error(payload, method, path, response.status)
            if 200 <= response.status < 300:
                return _run_or_transport_error(parsed, method, path)
            raise _protocol_error(parsed, method, path, response.status)

        latest: Any = None
        saw_run = False
        for frame in iter_event_frames(response.chunks):
            if frame.name == "error":
                # The headers went out with the first frame, so the daemon had no
                # status left to set and said what happened in the stream instead.
                raise _protocol_error(frame.data, method, path, response.status)
            if frame.name == "run":
                latest = frame.data
                saw_run = True
                continue
            if on_event is not None:
                on_event(frame)

        if not saw_run:
            raise TransportError(
                f"{method} {path} ended without a run frame, so nothing can be said about "
                "which models were tried. Read the record with get_run(run_id)."
            )
        return _run_or_transport_error(latest, method, path)

    def _call(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        producer: bool = False,
        link: bool = False,
        consumer_mac: str | None = None,
        allow_empty: bool = False,
    ) -> Any:
        headers: dict[str, str] = {
            "Accept": "application/json",
            PROTOCOL_VERSION_HEADER: PROTOCOL_VERSION,
        }
        if producer:
            if not self.producer_token:
                raise TransportError(
                    f"{path} is producer surface and needs the daemon's producer token; "
                    "construct the client with producer_token=..."
                )
            headers[PRODUCER_TOKEN_HEADER] = self.producer_token
        if link or consumer_mac is not None:
            if not self.link_id:
                raise TransportError(
                    f"{path} is consumer surface and needs a paired link; "
                    "construct the client with link_id=..."
                )
            headers[LINK_HEADER] = self.link_id
        if consumer_mac is not None:
            headers[MAC_HEADER] = consumer_mac

        encoded: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = (
                body.model_dump(mode="json", by_alias=True)
                if hasattr(body, "model_dump")
                else body
            )
            encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")

        response = self._send(method, f"{self.base_url}{path}", headers, encoded)

        if response.status == 204 or not response.body:
            if allow_empty or 200 <= response.status < 300:
                return None
            raise TransportError(f"{method} {path} returned {response.status} with no body")

        try:
            parsed = json.loads(response.body)
        except json.JSONDecodeError as error:
            raise TransportError(f"{method} {path} returned a body that is not JSON") from error

        if 200 <= response.status < 300:
            return parsed

        # A protocol error is an answer. Anything else that failed is not, and
        # pretending otherwise would invent an error code the server never sent.
        try:
            error = ProtocolError.model_validate(parsed)
        except Exception as exc:
            raise TransportError(
                f"{method} {path} returned {response.status} "
                "with a body that is not a ProtocolError"
            ) from exc
        raise ForgeBridgeError(error, response.status)


def _run_or_transport_error(payload: Any, method: str, path: str) -> RunResponse:
    """A `run` frame this build cannot read is a transport failure, not a run.

    A truncated frame, or one carrying a shape a newer daemon sends, would
    otherwise escape as a pydantic `ValidationError` — which is neither of the
    two failures this package promises a caller, and which `describe_error`
    would have to default. Naming it here keeps the classifier's answer honest.
    """
    try:
        return RunResponse.model_validate(payload)
    except Exception as error:
        raise TransportError(
            f"{method} {path} answered with a run record this build does not recognise. "
            "The transport may be running a different protocol version."
        ) from error


def _json_or_transport_error(payload: bytes, method: str, path: str, status: int) -> Any:
    try:
        return json.loads(payload)
    except json.JSONDecodeError as error:
        raise TransportError(
            f"{method} {path} returned {status} with a body that is not JSON"
        ) from error


def _protocol_error(payload: Any, method: str, path: str, status: int) -> Exception:
    """The refusal the daemon meant, or a transport error if it was not one.

    Inventing an `ErrorCode` for a body that is not a `ProtocolError` would hand
    the caller a refusal the daemon never made, so that case stays a transport
    error.
    """
    try:
        error = ProtocolError.model_validate(payload)
    except Exception:  # any validation failure means "this is not a protocol error"
        return TransportError(
            f"{method} {path} failed with {status} and a body that is not a ProtocolError"
        )
    return ForgeBridgeError(error, status)


def _segment(value: str) -> str:
    """Percent-encode one path segment.

    An id reaches this client from wherever the caller got it. Interpolating it
    raw would let a `../` walk the caller into a different route.
    """
    return urllib.parse.quote(value, safe="")
