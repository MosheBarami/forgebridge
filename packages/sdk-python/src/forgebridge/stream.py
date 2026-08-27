"""Read a `text/event-stream` body, one frame at a time.

The writer on the other end is `writeEventFrame` in
`packages/daemon/src/runs.ts`: `id:` when the frame has an index, then `event:`,
then a single `data:` line of JSON, then a blank line — plus a `:` comment frame
as a keep-alive on an otherwise silent stream. This reader handles the general
form of all four fields rather than only that shape, because a reader written to
exactly one writer breaks the first time the writer is legal and different.

── Why the idle ceiling, and not a total one ────────────────────────────────

A run waits on a language model, and on the router's fallback through however
many models the policy allows, so no wall-clock ceiling can tell a slow run from
a dead socket: a model that thinks for four minutes and then answers is a run
that worked. What separates them is *silence*. The daemon writes a keep-alive
comment frame on an idle stream, so a stream that says nothing at all for long
enough is a dropped connection — and that is the only reading of the two that
does not require guessing how long a prompt should take.

`urllib`'s `timeout` is already a per-read socket timeout rather than a deadline
for the whole response, which is exactly this semantics, so the default stream
transport gets it for free rather than reimplementing it.
"""

from __future__ import annotations

import codecs
import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

__all__ = ["RunEvent", "iter_event_frames", "parse_event_frame"]


@dataclass(frozen=True)
class RunEvent:
    """One frame off a `/v1` event stream.

    `name` is the SSE event type: a core `RunEvent.type` — `stage`, `plan`,
    `model-attempt-started`, `output-delta`, `model-attempt`, `model-skipped`,
    `validation`, `change-set`, `cancelled`, `failed` — or one of the daemon's
    own frames: `run`, `error`, `closed`, `truncated`.

    `data` is left untyped on purpose. The core's event union is TypeScript and
    is not projected into `packages/protocol/schema/`, so there is nothing to
    generate a model from; a hand-written copy of it here would be a copy that
    goes stale the first time the core adds an event. The two frames that decide
    the *outcome* of a run — `run` and `error` — are parsed against the generated
    models by `ForgeBridgeClient`, and everything else is handed to the caller as
    it arrived, to render or to ignore.
    """

    name: str
    data: Any
    #: The SSE `id:`, which is the `since=` cursor for `GET /v1/runs/{id}/events`.
    id: int | None = None


def parse_event_frame(raw: str) -> RunEvent | None:
    """One frame's fields, or `None` when the frame carries no data.

    A frame with no `data:` is a comment or a keep-alive and is dropped — it
    carries nothing to hand a caller, and passing it on as an event with a `None`
    payload would make every caller check for it. A `data:` that is not JSON is
    kept as its own text rather than discarded: the daemon only ever writes JSON
    there, so a non-JSON payload is a fact about the transport worth surfacing,
    not a parse error worth swallowing.
    """
    name = "message"
    identifier: int | None = None
    data: list[str] = []

    for line in raw.split("\n"):
        if line == "" or line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        # One optional space after the colon is part of the field value's encoding.
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            name = value
        elif field == "data":
            data.append(value)
        elif field == "id":
            try:
                identifier = int(value)
            except ValueError:
                identifier = None

    if not data:
        return None

    text = "\n".join(data)
    try:
        payload: Any = json.loads(text)
    except json.JSONDecodeError:
        payload = text
    return RunEvent(name=name, data=payload, id=identifier)


def iter_event_frames(chunks: Iterable[bytes]) -> Iterator[RunEvent]:
    """Turn a stream of bytes into frames as they complete.

    Decoding is incremental and boundary-safe: a chunk that splits a multi-byte
    character mid-sequence is held by the decoder rather than replaced with
    U+FFFD. A Luau source line arriving in an `output-delta` is exactly where
    that would show up and exactly where it would be least visible, which is why
    this uses an incremental decoder instead of calling `bytes.decode` per chunk.
    """
    decoder = codecs.getincrementaldecoder("utf-8")()
    buffered = ""

    for chunk in chunks:
        buffered += decoder.decode(chunk)
        # A frame ends at a blank line. `\r\n` is legal in the format and the
        # daemon does not emit it, so it is normalised rather than trusted.
        buffered = buffered.replace("\r\n", "\n")
        while "\n\n" in buffered:
            raw, _, buffered = buffered.partition("\n\n")
            frame = parse_event_frame(raw)
            if frame is not None:
                yield frame

    # Whatever the decoder was still holding, plus a frame the stream ended on
    # without its blank line. Dropping that last frame would lose the `run` frame
    # of a stream that closed tidily but abruptly — which is the one frame whose
    # absence a caller cannot recover from.
    buffered += decoder.decode(b"", final=True)
    for raw in buffered.split("\n\n"):
        if raw.strip() == "":
            continue
        frame = parse_event_frame(raw)
        if frame is not None:
            yield frame
