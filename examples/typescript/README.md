# TypeScript SDK example

A runnable walk-through of `@forgebridge/sdk-ts` against a local daemon:
propose → read the diff → approve → read the journal, with a run as the other
way a ChangeSet comes into existence.

It is four scripts rather than one, and the split is the point. `propose.mjs`
stops after printing the diff; approving is `approve.mjs`, run by whoever read
it, taking the `contentDigest` that was printed. ADR-012 puts a person between
those two steps, and an example that offered a `--yes` flag would be teaching the
opposite of what the system does.

## Before you start

`@forgebridge/sdk-ts` is not published (`M49`), so these run from a checkout of
this repository:

```bash
npm ci
npm run build
```

Then start a daemon and pair a Studio session with it — an approved ChangeSet
with nothing on the consumer end has nowhere to go, and the daemon refuses to
approve one for a project with no paired link:

```bash
npx forgebridge daemon   # prints the producer token and a pairing code, once, on this terminal
npx forgebridge link     # shows the link status; it does not redeem the code
```

The pairing code is typed into the ForgeBridge plugin in Studio, not into the
CLI: the plugin is the consumer, and redeeming the code here would burn a
single-use credential and register the CLI as the Studio session. `forgebridge
link --code` is recognised and refused for exactly that reason.

Export what the daemon printed:

```bash
export FORGEBRIDGE_PRODUCER_TOKEN=…      # from the daemon's terminal
export FORGEBRIDGE_DAEMON_URL=http://127.0.0.1:7317   # the default; set it if you moved the port
```

## The walk-through

```bash
# 1. Propose. Prints the validation verdict, the diff, and the digest.
node examples/typescript/propose.mjs

# 2. Approve — a separate command, for a person who read the diff.
node examples/typescript/approve.mjs <changeSetId> <contentDigest>

# 3. Read what the apply actually did, and undo it if it was wrong.
node examples/typescript/journal.mjs <journalId>
node examples/typescript/journal.mjs <journalId> --rollback
```

And the prompt-driven path, which produces a ChangeSet the same way and stops in
the same place:

```bash
node examples/typescript/run.mjs "add a respawn handler"
```

`run.mjs` prints every model the router tried, in order, with why it moved on —
including the ones it never invoked, which are reported separately because a
skipped candidate is not an attempt.

## Things these scripts deliberately do not do

- **Approve what they proposed.** There is no method on the client that does
  both, and no flag on `propose.mjs` that reaches one.
- **Fetch the digest at approval time.** `approve.mjs` takes it as an argument.
  Reading the diff again and echoing whatever it said would approve the script's
  idea of the set rather than the operations a person was shown.
- **Round a partial rollback up.** `journal.mjs` prints `rollback_partial` as its
  own state, in its own words, because the place is then in a state neither the
  apply nor the rollback describes and the inverses that would have finished the
  job are spent.
- **Guess a tree version.** `propose.mjs` builds on version 0 and says so:
  `/v1` publishes no route that reads a project's current version, which is the
  same gap that makes `tree-read` `unsupported` for every connector in the M31
  conformance suite. When the guess is wrong the diff reports `stale`, and the
  script prints the version to re-run with rather than merging.
