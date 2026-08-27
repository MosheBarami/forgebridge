# Python SDK example

Three scripts against a local daemon, and the split between them is the point.
`propose.py` walks the producer half of the loop — read the link posture, propose
a ChangeSet, print the diff — and stops. Approving is `approve.py`, a separate
command run by whoever read the diff, taking the digest it printed. ADR-012 puts
a person between those two steps, and an example that offered a `--yes` flag
would teach the opposite of what the system does.

```bash
python -m pip install -e "packages/sdk-python"
export FORGEBRIDGE_PRODUCER_TOKEN=…                     # from the daemon's terminal
export FORGEBRIDGE_DAEMON_URL=http://127.0.0.1:7317     # the default; set it if you moved the port
```

`packages/sdk-python` is unpublished — its `pyproject.toml` carries the
`Private :: Do Not Upload` classifier, and `M49` owns whether that comes off — so
it is installed from the checkout. The daemon must be running with at least one `--allow-path`, and a Studio session must be
paired with it: the daemon refuses to approve a set for a project with no
consumer, which is the honest failure rather than a queued apply nobody will see.
The daemon prints the producer token and a pairing code once, on its own
terminal, and the code is typed into the ForgeBridge plugin in Studio — never
into a producer, which would burn a single-use credential.

## The walk-through

```bash
# 1. Propose. Prints the validation verdict, the diff, and the content digest.
python examples/python/propose.py

# 2. Approve — a separate command, for a person who read the diff. Both
#    arguments are printed by step 1.
python examples/python/approve.py <changeSetId> <contentDigest>
```

And the prompt-driven path, which produces a ChangeSet the same way, stops in the
same place, and is watched as it happens:

```bash
python examples/python/watch_run.py "add a respawn handler"
```

`watch_run.py` prints every model the router tried, in order, with why it moved
on — and the candidates it never invoked, reported separately, because a skipped
candidate is not an attempt (ADR-008).

## Three things worth noticing in the code

**`propose.py` stops at the diff.** `approve_changeset` requires the
`contentDigest` the diff reported, so a producer that never loaded a diff cannot
approve its own submission. `approve.py` takes that digest as an argument rather
than fetching it: reading the diff again there and echoing whatever it said would
approve the script's idea of the set rather than the operations a person read.

**A ChangeSet is built through the generated model, not as a dict.** A set the
protocol would refuse is refused here, with the field named, before a request is
made. The one exception is the ChangeSet ordering rule — a `.superRefine()` body
is arbitrary TypeScript and does not survive the projection into JSON Schema, so
`forgebridge.check_changeset_ordering` re-implements it and a producer should
call it before sending. (`packages/sdk-ts` needs no such call: it parses with the
protocol's own Zod, which carries the refinement.)

**`watch_run.py` sets `run_idle_timeout`, not a total timeout.** A run waits on a
language model and on the router's fallback, so no wall-clock ceiling separates a
slow run from a dead socket. The daemon writes a keep-alive frame on an idle
stream, so *silence* is what distinguishes them.
