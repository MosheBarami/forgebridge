"""ForgeBridge — Python models and a thin client for the `/v1` protocol.

The models in `forgebridge.models` are generated from the Zod schemas in
`packages/protocol/src` and are not edited by hand; see
`packages/protocol/schema/README.md` for what the projection does and does not
carry.

Not published. There is no `pip install forgebridge` that installs this package —
writing that command in a README would send a reader to somebody else's project
or to a 404. `pyproject.toml` carries the `Private :: Do Not Upload` classifier,
which an index refuses; whether that marker comes off is `M49`'s to decide.
Install it from a checkout:

    pip install -e packages/sdk-python

A worked example lives in `examples/python/`.
"""

from .checks import check_changeset_ordering
from .client import (
    ForgeBridgeClient,
    HttpResponse,
    StreamResponse,
    StreamTransport,
    Transport,
    urllib_stream_transport,
    urllib_transport,
)
from .errors import ErrorView, ForgeBridgeError, TransportError, describe_error
from .models import ALL_MODELS
from .stream import RunEvent, iter_event_frames, parse_event_frame

__version__ = "0.1.0"

__all__ = [
    "ALL_MODELS",
    "ErrorView",
    "ForgeBridgeClient",
    "ForgeBridgeError",
    "HttpResponse",
    "RunEvent",
    "StreamResponse",
    "StreamTransport",
    "Transport",
    "TransportError",
    "check_changeset_ordering",
    "describe_error",
    "iter_event_frames",
    "parse_event_frame",
    "urllib_stream_transport",
    "urllib_transport",
]
