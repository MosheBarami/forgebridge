"""The run event stream: the frame reader, and the client that follows one.

Until `forgebridge.stream` existed, `start_run` refused `stream=True` and pointed
at a TODO — so a Python caller could start a run and then had nothing to look at
for however long the router took, which for a fallback through several free
models is minutes of silence. Making a fallback *visible* rather than merely
recorded is what ADR-008 is about, and a caller that cannot see it cannot tell a
slow run from a hung daemon.

Every case below is either a frame shape the daemon really writes
(`packages/daemon/src/runs.ts`) or one the SSE format permits and the daemon
happens not to write — because a reader built for exactly one writer breaks the
first time the writer is legal and different.
"""

from __future__ import annotations

import json

import pytest

from forgebridge import ForgeBridgeClient
from forgebridge.client import PRODUCER_TOKEN_HEADER, StreamResponse
from forgebridge.errors import ForgeBridgeError, TransportError
from forgebridge.models import StartRunRequest
from forgebridge.stream import RunEvent, iter_event_frames, parse_event_frame
from test_client import RUN_RESPONSE

# ── the frame reader ─────────────────────────────────────────────────────────


def frame(name: str, data: object, identifier: int | None = None) -> bytes:
    """One frame in the daemon's own framing, so these tests read what it writes."""
    lines = [] if identifier is None else [f"id: {identifier}"]
    lines += [f"event: {name}", f"data: {json.dumps(data)}", "", ""]
    return "\n".join(lines).encode()


def test_a_frame_carries_its_name_its_payload_and_its_cursor() -> None:
    events = list(iter_event_frames([frame("stage", {"stage": "planning"}, 4)]))
    assert events == [RunEvent(name="stage", data={"stage": "planning"}, id=4)]


def test_a_keep_alive_is_not_an_event() -> None:
    """A comment frame carries nothing to hand a caller.

    Yielding it with a `None` payload would make every caller check for it, and
    the daemon writes one every few seconds on an idle stream.
    """
    events = list(iter_event_frames([b": keep-alive\n\n", frame("run", {"ok": True})]))
    assert [event.name for event in events] == ["run"]


def test_a_frame_split_across_chunks_is_still_one_frame() -> None:
    body = frame("model-attempt", {"modelId": "glm-5.2:free"})
    events = list(iter_event_frames([body[:10], body[10:20], body[20:]]))
    assert events[0].data == {"modelId": "glm-5.2:free"}


def test_a_multibyte_character_split_across_chunks_is_not_mangled() -> None:
    """The reason the decoder is incremental rather than per-chunk.

    An `output-delta` carrying a model's own prose is exactly where a chunk
    boundary lands mid-character, and a U+FFFD there would be invisible.
    """
    body = 'event: output-delta\ndata: "café"\n\n'.encode()
    split = body.index(b"\xc3") + 1
    events = list(iter_event_frames([body[:split], body[split:]]))
    assert events[0].data == "café"


def test_a_final_frame_with_no_blank_line_is_not_dropped() -> None:
    """A stream that closes tidily but abruptly still said something.

    The one frame whose absence a caller cannot recover from is `run`, so a
    reader that required the trailing blank line would lose exactly the frame
    that matters.
    """
    events = list(iter_event_frames([b'event: run\ndata: {"a": 1}\n']))
    assert events == [RunEvent(name="run", data={"a": 1}, id=None)]


def test_a_data_line_that_is_not_json_is_kept_as_text() -> None:
    """Not swallowed as a parse error: the daemon only ever writes JSON there, so
    a non-JSON payload is a fact about the transport worth surfacing."""
    assert parse_event_frame("event: odd\ndata: not json") == RunEvent(
        name="odd", data="not json", id=None
    )


def test_multi_line_data_is_joined_the_way_the_format_says() -> None:
    assert parse_event_frame('event: x\ndata: {"a":\ndata: 1}').data == {"a": 1}


def test_a_frame_with_no_data_field_is_dropped() -> None:
    assert parse_event_frame("event: x\nid: 3") is None


def test_carriage_returns_are_normalised_rather_than_trusted() -> None:
    body = b'event: run\r\ndata: {"a": 1}\r\n\r\n'
    assert list(iter_event_frames([body])) == [RunEvent(name="run", data={"a": 1}, id=None)]


# ── the client following one ─────────────────────────────────────────────────


class StreamRecorder:
    """A stream transport that records the request and replays scripted chunks."""

    def __init__(
        self,
        *chunks: bytes,
        status: int = 200,
        content_type: str = "text/event-stream",
    ) -> None:
        self.chunks = list(chunks)
        self.status = status
        self.content_type = content_type
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        return StreamResponse(
            status=self.status, content_type=self.content_type, chunks=iter(self.chunks)
        )


def client(recorder: StreamRecorder, **kwargs) -> ForgeBridgeClient:
    return ForgeBridgeClient(
        "http://127.0.0.1:8787", producer_token="t0ken", stream_transport=recorder, **kwargs
    )


def test_a_followed_run_returns_the_run_frame_and_reports_the_rest() -> None:
    """The answer is the `run` frame, not something reassembled from the events.

    A client that rebuilt the result out of whatever frames it caught would be a
    client whose answer depended on how fast it was reading.
    """
    seen: list[RunEvent] = []
    recorder = StreamRecorder(
        frame("run", RUN_RESPONSE),
        frame("stage", {"stage": "generating"}, 0),
        frame("model-attempt", {"attempt": {"modelId": "glm-5.2:free"}}, 1),
        frame("run", RUN_RESPONSE),
    )
    result = client(recorder).start_run(StartRunRequest(prompt="p"), on_event=seen.append)

    assert [event.name for event in seen] == ["stage", "model-attempt"]
    tried = [attempt.modelId for attempt in result.run.attempts]
    assert tried == ["glm-5.2:free", "minimax-m3:free"]

    method, url, headers, body = recorder.calls[0]
    assert (method, url) == ("POST", "http://127.0.0.1:8787/v1/runs")
    assert headers[PRODUCER_TOKEN_HEADER] == "t0ken"
    # The client sets `stream` from the listener, so the request and the way the
    # answer is read cannot disagree.
    assert json.loads(body)["stream"] is True


def test_a_caller_supplied_stream_flag_is_refused_rather_than_obeyed() -> None:
    recorder = StreamRecorder()
    with pytest.raises(TransportError, match="sets stream itself"):
        client(recorder).start_run(
            StartRunRequest(prompt="p", stream=True), on_event=lambda _: None
        )
    assert recorder.calls == []


def test_a_stream_that_never_names_the_run_is_a_failure_not_an_empty_success() -> None:
    """"No model was tried" and "I did not see which models were tried" are
    different facts, and only one of them is something this client observed."""
    recorder = StreamRecorder(frame("stage", {"stage": "planning"}, 0))
    with pytest.raises(TransportError, match="without a run frame"):
        client(recorder).start_run(StartRunRequest(prompt="p"), on_event=lambda _: None)


def test_an_error_frame_becomes_the_protocol_error_it_carries() -> None:
    """The headers went out with the first frame, so the daemon had no status left
    to set and said what happened in the stream instead. It is still a refusal."""
    recorder = StreamRecorder(
        frame("run", RUN_RESPONSE),
        frame("error", {"code": "budget_exhausted", "message": "the day's capacity is spent"}),
    )
    with pytest.raises(ForgeBridgeError) as raised:
        client(recorder).start_run(StartRunRequest(prompt="p"), on_event=lambda _: None)
    assert raised.value.code == "budget_exhausted"


def test_a_refusal_before_the_stream_opens_is_read_as_json() -> None:
    """The daemon refuses some runs before it opens the stream — no model client,
    a stale base version, `pinned` with nothing pinned — and those arrive as an
    ordinary JSON error. The content type decides how the body is read, never the
    flag that was sent."""
    recorder = StreamRecorder(
        json.dumps({"code": "provider_unconfigured", "message": "no model client"}).encode(),
        status=503,
        content_type="application/json",
    )
    with pytest.raises(ForgeBridgeError) as raised:
        client(recorder).start_run(StartRunRequest(prompt="p"), on_event=lambda _: None)
    assert raised.value.code == "provider_unconfigured"
    assert raised.value.status == 503


def test_watch_run_replays_from_a_cursor_and_returns_the_record() -> None:
    recorder = StreamRecorder(frame("run", RUN_RESPONSE), frame("closed", {"reason": "done"}))
    result = client(recorder).watch_run(RUN_RESPONSE["run"]["id"], since=7)
    assert result.run.id == RUN_RESPONSE["run"]["id"]
    method, url, _, body = recorder.calls[0]
    assert method == "GET"
    assert url.endswith(f"/v1/runs/{RUN_RESPONSE['run']['id']}/events?since=7")
    assert body is None


def test_iter_run_events_yields_frames_including_the_ones_watch_run_consumes() -> None:
    """The raw reader. Deciding that a frame ends the call is `watch_run`'s job,
    so an `error` frame is yielded here rather than raised."""
    recorder = StreamRecorder(
        frame("run", RUN_RESPONSE),
        frame("error", {"code": "internal", "message": "something"}),
    )
    names = [event.name for event in client(recorder).iter_run_events(RUN_RESPONSE["run"]["id"])]
    assert names == ["run", "error"]


def test_a_run_frame_this_build_cannot_read_is_a_transport_failure() -> None:
    """Not a pydantic `ValidationError` escaping into a caller's `except`.

    A truncated frame, or one carrying a shape a newer daemon sends, is neither
    of the two failures this package promises — so it is named as the one it
    actually is, and `describe_error` classifies it without defaulting.
    """
    recorder = StreamRecorder(frame("run", {"not": "a run response"}))
    with pytest.raises(TransportError, match="does not recognise"):
        client(recorder).watch_run(RUN_RESPONSE["run"]["id"])


def test_following_a_run_still_needs_the_producer_token() -> None:
    recorder = StreamRecorder()
    unauthenticated = ForgeBridgeClient("http://127.0.0.1:8787", stream_transport=recorder)
    with pytest.raises(TransportError, match="producer token"):
        unauthenticated.watch_run(RUN_RESPONSE["run"]["id"])
    assert recorder.calls == []
