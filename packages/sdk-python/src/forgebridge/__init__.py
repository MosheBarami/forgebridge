"""ForgeBridge — Python models and a thin client for the `/v1` protocol.

The models in `forgebridge.models` are generated from the Zod schemas in
`packages/protocol/src` and are not edited by hand; see
`packages/protocol/schema/README.md` for what the projection does and does not
carry.

Not published. There is no `pip install forgebridge` that installs this package
(TODO(M30) — publishing to PyPI, with an example script, is M30's row in
`docs/MILESTONES.md`). Install it from a checkout:

    pip install -e packages/sdk-python
"""

from .checks import check_changeset_ordering
from .client import ForgeBridgeClient, HttpResponse, Transport, urllib_transport
from .errors import ForgeBridgeError, TransportError
from .models import ALL_MODELS

__version__ = "0.1.0"

__all__ = [
    "ALL_MODELS",
    "ForgeBridgeClient",
    "ForgeBridgeError",
    "HttpResponse",
    "Transport",
    "TransportError",
    "check_changeset_ordering",
    "urllib_transport",
]
