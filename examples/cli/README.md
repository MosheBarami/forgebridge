# CLI example

The whole loop from a shell, with no browser and no editor: propose, read the
diff, approve, apply, roll back.

```bash
npm ci && npm run build
./examples/cli/walkthrough.sh
```

The script stops before approving and tells you the command to run. That is not
a rough edge — ADR-012 puts a person between "here is a diff" and "apply it",
and an example that offered `--yes` would be teaching the opposite of what the
system does. `packages/cli`'s `run` subcommand never approves either.

## What you need first

```bash
npx forgebridge daemon --allow-path ServerScriptService.Shop
```

That prints a pairing code and a producer token, once, on its own terminal.
Type the code into the ForgeBridge plugin in Studio — not into the CLI, which
would burn a single-use credential on the wrong consumer — then, in the terminal
you will run the walk-through from:

```bash
export FORGEBRIDGE_PRODUCER_TOKEN=…                    # from the daemon's terminal
export FORGEBRIDGE_DAEMON_URL=http://127.0.0.1:7317    # the default
```

Every subcommand takes `--json`, and the walk-through uses it: the human output
is for humans and its shape is not a contract.
