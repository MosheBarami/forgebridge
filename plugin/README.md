# ForgeBridge — Roblox Studio plugin

The consumer end of the bridge. It polls a ForgeBridge daemon (or relay) for ChangeSets,
shows you what each one would do, waits for your approval, applies the operations one by
one, and reports back exactly how far it got.

It calls six endpoints and nothing else: `POST /v1/link/pair` once, then
`GET /v1/link/poll`, `POST /v1/changesets/:id/apply-result`,
`POST /v1/journal/:id/entry`, `POST /v1/journal/:id/rollback-result` and
`POST /v1/output`. The two journal routes are M11's: the first hands the inverse
operations to the daemon so a rollback can outlive this Studio session, the second reports
how far a reversal got. That surface is small on purpose — a Studio plugin is the hardest
piece of this system to update once it is in the field, so it should have as little in it
as possible. Diffing for the web UI and the approval record live on the other side of the
link, and so does the decision to roll back; what happens here is the replay.

## Installing it

**From a release (M49 — there are no releases yet).** Nothing is published: no
`ForgeBridge.rbxm` is built by anything in this repository, there is no release job, and there
is no checksum to check. Until M49 lands, the only install path is the one below. When it does
land: download `ForgeBridge.rbxm`, then in Studio open the **Plugins** tab and click **Plugins
Folder** — Studio opens the folder it loads local plugins from — copy the `.rbxm` in and
restart Studio, and check the published checksum first, because this is code that runs inside
Studio with your session.

**From source.** See [BUILD.md](BUILD.md). `rojo build --output ForgeBridge.rbxm`, same
install step. For development, `rojo serve` and connect from Studio.

## The permission Roblox will ask you for

You do **not** need to turn on "Allow HTTP Requests" in Game Settings. That setting
governs scripts running in the experience. Studio plugins may call `HttpService`
regardless, including to `127.0.0.1` — which is how Rojo has worked for years and why this
plugin long-polls rather than using a socket (Studio has no WebSocket API at all).

What you *will* see is a Roblox permission prompt the **first** time this plugin calls a
given web address. The prompt is scoped to that address, and you can accept or deny it.
Two things follow from that:

- **The daemon uses a fixed port, 7317.** The grant is tied to the address, so a stable
  address means you are asked once rather than again every time the daemon comes back on a
  different port. Point the plugin somewhere else and Roblox will ask again for the new
  address — correctly, because it is a different place to send your work.
- **The plugin tells you what it is about to ask for, first.** Before it makes that first
  call it names the address in the panel and in the Output window. A prompt you did not
  expect gets denied, and a denied prompt looks exactly like a plugin that is broken:
  connecting forever, no error, nothing to search for.

If you did deny it, Roblox remembers the answer, and the plugin will sit there unable to
connect. Pointing it at a different address makes Roblox ask again for that one.

> TODO(M49): name the exact place in current Studio where a denied plugin HTTP permission
> is reviewed and reset, once someone has checked it against a live build rather than from
> memory. Owner: whoever writes the install docs for the first release.

## Pointing it at a daemon

1. Start a daemon on your machine (`packages/daemon`). It prints a **pairing code** on
   startup.
2. Click **ForgeBridge** in the Studio toolbar to open the panel.
3. Check the base URL, type the pairing code, and click **Connect**.

The code is eight characters, good for ten minutes, five attempts, and single use. It
carries no `I`, `L`, `O`, `U`, `0` or `1`, so there is no character in it that a
look-alike could be mistaken for; the panel checks that before spending one of your five
attempts on it, and hyphens or spaces you type while reading it aloud are ignored.

Redeeming the code derives a session key that both ends compute independently — nothing
secret crosses the wire — and every request after it carries a MAC under that key. The
panel shows the key's public id, never the key. The link is remembered per install, so
reopening Studio does not mean retyping a code.

Re-pair when the daemon restarts. Session keys are held in memory only and deliberately do
not survive a daemon restart, so the first poll afterwards is refused and the panel asks
for a fresh code.

It starts at `http://127.0.0.1:7317` — the port `packages/daemon` listens on
(`DEFAULT_DAEMON_PORT` in `src/server.ts`, mirrored as `DEFAULT_BASE_URL` in
`src/Config.luau`). Edit it if you run the daemon elsewhere; whatever you type is
remembered per install. The two constants are hand-kept in step for now, and the
conformance test that would stop them drifting is still owed — TODO(M41).

The plugin will refuse some URLs, and says which and why:

| URL | What happens |
|---|---|
| `http://127.0.0.1:9000`, `http://localhost:9000`, `http://[::1]:9000` | accepted — a local daemon |
| `http://relay.example.org` | refused: it will not send your changes in the clear |
| `https://relay.example.org` | accepted as a URL, but deliveries are refused — see below |
| `http://127.0.0.1.example.com` | refused: that is not a loopback address, and the check is anchored so a lookalike host cannot pretend to be one |

## Privacy postures

The panel always names the posture of the current link, in words. These are the
protocol's own strings (`PRIVACY_POSTURE` in `packages/protocol/src/link.ts`), shown
verbatim:

- **Local — nothing leaves this machine**
- **Relay — the relay operator can read your changes**
- **Relay — end-to-end encrypted, the relay sees only ciphertext** — M19, and this build
  cannot produce it (ADR-014)

Read the middle one literally. On a `relay-tls` link, TLS protects your changes from
everyone **except** the relay operator, who can read every ChangeSet — the scripts, the
paths, the property values — as plaintext. That is a real limitation of the v1 design
(ADR-014) and it is why the local daemon is the default and the recommendation. There is
no padlock icon anywhere in this plugin; a padlock would say the opposite.

The third posture is not something this build can produce. It becomes available when
end-to-end encryption ships (M19), and until then the plugin will never claim it.

## What this build will not do yet

**Relay links are refused.** Not for want of crypto any more — `src/Crypto.luau` is a
pure-Luau SHA-256, HMAC-SHA256 and HKDF-SHA256, and every delivery is authenticated under
the pairing-derived key. What is missing is the other end: pairing is written against a
daemon's `POST /v1/link/pair`, and there is no relay in this repository to pair with or to
test that handshake against (TODO(M17) in `src/Transport.luau`). Pointing the plugin at an
unbuilt relay would mean guessing at its half of the protocol, so it refuses and says so.

**Payloads are authenticated, not encrypted.** ADR-014 chose an HMAC for v1 deliberately:
a hash and a MAC are the two primitives a careful reader can check line by line against
published vectors, which `tests/CryptoSpec.luau` does (NIST for SHA-256, RFC 4231 for
HMAC, RFC 5869 for HKDF — none of those vectors were produced by running this code). On a
loopback link authenticity is the property that matters, because any process on the
machine can open a socket to `127.0.0.1` and the MAC is what separates the daemon you
paired with from everything else that found the port. X25519 and an AEAD are M19, behind
an external review.

**A restored deletion is rebuilt, not resurrected.** Luau has no property reflection, so
the durable record of a deleted subtree captures its structure, names, attributes, tags,
script sources and a list of common engine properties — not every property of every
class. The in-session undo uses a live clone and loses nothing; the durable record is
honest about being a rebuild. That limit is `TODO(M15)` in `src/Journal.luau`, and
`tests/RollbackSpec.luau` pins it in both directions: a property on the captured list
comes back, one off it does not.

## Rollback

**It outlives the session (M11).** The plugin captures the inverse of every operation
before it runs, and after each apply it uploads those inverses to
`POST /v1/journal/:id/entry`. A reversal the user asks for arrives back down the same
poll carrying the inverses to replay, `src/Rollback.luau` replays them last-first — undo
the last operation first, or a create-then-set pair deletes the instance before restoring
a property on it — and `POST /v1/journal/:id/rollback-result` reports how far it got.
Closing Studio is no longer the end of the road back from an apply.

Studio's own undo works too, and now covers both directions: every apply and every
rollback is one `ChangeHistoryService` recording, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> takes the
whole thing back. A reversal Studio will not open a waypoint for is refused outright rather
than performed without one — the inverses are spent once replayed, so a rollback with no
waypoint would have no recovery path in either direction.

**A partial reversal is reported as a partial reversal.** If some inverses replay and
others do not, the panel and the report both say so, per inverse. The place is then in a
state neither the apply nor the rollback describes and the inverses that would have
finished the job are spent, so it is never rounded up to "rolled back" — and the reported
tree version is a fresh one rather than the pre-apply version, because the pre-apply tree
is not where the place is.

**Two things it refuses rather than guesses at.** A delivery whose steps are not in replay
order is refused instead of re-sorted, because a consumer that quietly corrected the order
would hide a daemon that had stopped producing it. A delivery carrying no inverses at all
— the shape a pre-M11 daemon sends — is refused instead of executed as a reversal with no
work to do, which would report a clean rollback for a tree nobody touched.

## Approval

Approval is required by default (ADR-012). The panel shows the summary, the destructive
operations first, then the rest of the diff, then **Approve** / **Reject**.

Auto-apply is opt-in and takes a path scope — `ServerScriptService.Shop`, say. The scope
is matched segment by segment, so `ServerScriptService.ShopAdmin` is **not** inside
`ServerScriptService.Shop`.

A ChangeSet skips the prompt only when **every reason to skip it is one this plugin
checked itself**: auto-apply is on, every path it touches is inside the scope, it deletes
nothing, and it writes no Luau source.

"Every path it touches" includes paths that appear only inside property *values*. An
`InstanceRef` in a property bag names another instance, and an operation whose own path sits
inside your scope can still point a reference at something well outside it — so those
targets are checked against the scope too.

**The validation verdict on a ChangeSet is advisory.** It is computed by the core and
arrives over the link, and the protocol is explicit that a consumer must treat a verdict it
did not witness as unvalidated. So the panel shows it with the name of whoever computed it
attached — "reported by …, not verified here" — and it works one way only: a reported
failure is still worth refusing on, and a reported pass unlocks nothing. Nothing skips the
human on the strength of someone else's word for it.

That is why anything writing Luau source needs approval. Static analysis is the one part of
the verdict this plugin cannot recompute: there is no Luau parser in here to replace it
with. The daemon does recompute it — `packages/luau-analysis` runs over every source a
ChangeSet carries and a `fail` is refused before it could be delivered — but this plugin
cannot distinguish a verdict that was computed from one a sender simply wrote, and the
analyser itself reads what a script says rather than what it computes. Source arriving with
a clean verdict is still source a human should look at. That includes source
smuggled in as a property: a `createInstance` carrying `Source` in its property bag, or a
`setProperty` writing `Source`, counts exactly as much as a `writeScript`.

`deleteInstance` is **never** auto-applied. No setting turns that off.

`setProperty` may not write `Parent` or `Name`. Both are structural changes wearing a
property's clothes: setting `Parent` relocates a whole subtree while the operation names
only its source path, which slips the path allowlist, the bulk-delete count and the
auto-apply exclusion at once. The protocol schema refuses both, and this plugin refuses
them again on arrival — a schema on the other side of a link is not a gate this end can
lean on. Use `moveInstance`, which names both endpoints and journals a reversible inverse.

Rejecting is reported back to the producer as a refusal, so nothing is left waiting.

**An apply that Studio cannot record is refused outright.** Every apply opens a
`ChangeHistoryService` recording so <kbd>Ctrl</kbd>+<kbd>Z</kbd> can take it back. When
Studio declines to open one — normally because another plugin has a recording open — the
whole ChangeSet is refused and nothing is written, because applying with no undo waypoint
would leave a change in your place with no route back except the session journal. You lose
a retry; you would otherwise have lost the recovery path.

## When an operation only half-lands

A move is two engine writes — reparent, then rename — and the second can fail after the
first has changed the tree. When that happens the plugin puts the instance back at its
original parent if the engine lets it, reports the operation as **failed** with what
actually happened to it, and **journals the inverse either way**. An inverse that no longer
resolves is a loud error a human can act on; a mutation with no inverse at all is silent
and permanent, and the journal exists precisely to prevent that (ADR-012).

The wire has no third answer here — `OperationOutcome` carries `ok` and `error` and
nothing else — so "partly applied" is carried by the error text and by the journal, and the
apply counts as having changed the tree, which is what moves the version and commits
Studio's undo recording.

## Mirroring the Studio console

Off by default. When you turn it on, output printed in Studio from that point onwards is
batched and posted to `/v1/output` so the producer can see what the place printed. It is
off by default because the console carries whatever your place prints — and on a relay
link, the relay operator can read it.

## Running the tests

```
luau tests/run.luau
```

`tests/` contains plain assert-based Luau modules and touches no Roblox API — fake
instances stand in for the real ones — so any Luau runtime with require-by-string will do
(the `luau` CLI, or Lune with `lune run tests/run.luau`). A failing test exits non-zero.

They cover the things that would be a security or data-loss bug if they were wrong: path
resolution refusing a missing ancestor rather than creating one, the PropertyValue decoder
refusing a tag it does not recognise, inverse capture for every operation kind, partial
applies being reported as partial, the transport stopping dead on `426`, replayed
deliveries being dropped, and `deleteInstance` never being auto-applied.

The load-bearing one is in `tests/RollbackSpec.luau`: it applies a ChangeSet that uses
every operation the protocol has, replays the journal, and asserts the place is the exact
structure it was before — including a `deleteInstance` whose inverse carries a serialised
subtree, which is the case where a half-restore cannot be retried because there is nothing
left to read. What ADR-012 promises is that the tree comes back, not that a list was
ordered correctly, so that is what the test measures.

Several of them exist because a gate that cannot fail is decoration, so they arrange for
the failure: an engine that refuses a `Name` or a `Parent` write, a move whose rename fails
after the reparent landed (with and without a successful restore), a Studio that will not
open an undo waypoint, a ChangeSet handler that throws mid-apply, and a passing validation
verdict that must still not unlock an auto-apply.

The crypto is tested against published vectors rather than against itself — NIST for
SHA-256, RFC 4231 for HMAC-SHA256, RFC 5869 for HKDF — because a test whose expectations
were produced by running the implementation proves only that it is deterministic.

### The live pairing check

Vectors prove this plugin matches the standards. They cannot prove it matches *the
daemon*, and that is the failure M18 actually had: both ends passed their own suites while
the seam between them did not exist. So pairing has one check that is not a unit test.

```
node tests/live-pair.mjs <pairing-code> <producer-token>
```

Both values are printed by the daemon on startup, and the code is single use — a second
run needs a fresh daemon. It pairs for real against `127.0.0.1:7317` and asserts four
things, each with a negative control beside it:

- the session key id this plugin derives equals the one the daemon issued;
- the daemon accepts a poll MAC built by `src/Transport.luau` (and answers `401` to the
  same MAC with one byte flipped);
- `Transport.verifyMac` accepts a delivery envelope the daemon actually sealed (and
  refuses it after one byte of the payload changes).

The split between `tests/live.luau` and `tests/live-pair.mjs` is not a preference: the
standalone `luau` CLI has no `io` and no `os.execute`, so it cannot open a socket. Node
does the transport and the asserting; every byte of crypto under test is this plugin's own
shipping Luau, because a driver that computed the expected key itself would agree with a
plugin that was wrong.

It is deliberately not in `run.luau`'s suite list. That suite is offline and hermetic, and
a test that fails whenever no daemon happens to be running is one people learn to skip.

## Layout

```
src/
  init.server.luau   toolbar, widget, settings, and the poll → diff → approve → apply loop
  Transport.luau     long-poll with backoff; 204 / 409 / 426 handling; replay refusal
  Pairing.luau       redeeming a code for a link and a session key
  Crypto.luau        SHA-256, HMAC-SHA256, HKDF-SHA256 and base64, in pure Luau
  Journal.luau       inverse capture, before anything is applied; the wire entry
  Apply.luau         ordered application, per-operation outcomes, stale-base refusal
  Rollback.luau      replaying a journal's inverses last-first, and reporting honestly
  Diff.luau          before/after rendering, including a real line delta for scripts
  Approve.luau       the approval policy (pure) and the dock widget
  Value.luau         the tagged PropertyValue union, both directions
  Path.luau          InstancePath validation and defensive resolution
  Config.luau        protocol constants and setting keys
tests/               unit tests, no Studio required
  live.luau          the live pairing check — needs a running daemon, not in run.luau
  live-pair.mjs      its driver: the sockets the luau CLI cannot open
```

Only `init.server.luau` calls `require`. Every other module is a leaf that touches no
Roblox service at module scope and receives its dependencies as arguments. That is what
makes the modules above testable at all: Roblox's `require` takes an Instance, so a module
that reaches for its neighbours can only ever be loaded inside Studio.

`plugin/` shares no code with the TypeScript packages (REPO-LAYOUT boundary rule 4). The
protocol constants in `Config.luau`, `Path.luau` and `Value.luau` are a hand-kept mirror of
`packages/protocol`, and a conformance test that pins them against the committed JSON
Schema is still owed — TODO(M41). **M08** has landed the first half: the JSON Schema
projection is generated and committed under `packages/protocol/schema/`, one
self-contained file per top-level type. **M41** writes the test that reads it.
`docs/REPO-LAYOUT.md` rule 4 and `src/Config.luau` say the same; the three move together.
