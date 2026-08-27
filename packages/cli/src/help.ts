import { PAIRING, PRIVACY_POSTURE } from '@forgebridge/protocol';
import { MAX_RUN_ATTEMPTS, ROUTING_POLICIES } from '@forgebridge/daemon';
import { DEFAULT_APPLY_TIMEOUT_SECONDS, DEFAULT_BASE_URL, BASE_URL_ENV, TOKEN_ENV, type Command } from './args.js';

/**
 * Help text.
 *
 * The exit-code table is not an afterthought here: CI consumers branch on the
 * code and read the text once, when they are writing the step. It is repeated
 * in every command's help for the same reason man pages repeat themselves —
 * nobody scrolls back up.
 */

const EXIT_CODES = `Exit codes:
  0  success
  1  the transport was reached and the operation failed
  2  usage error — the command line was wrong, nothing was attempted
  3  no daemon answered at the base address`;

const GLOBAL = `Global options:
  --url <address>   Transport base address (default ${DEFAULT_BASE_URL}, or $${BASE_URL_ENV})
  --token <value>   Producer token, required by run, diff, apply and rollback.
                    Defaults to $${TOKEN_ENV}. The daemon prints it once, on the
                    terminal it was started from. This CLI never writes it to disk.
  --json            Machine-readable output on stdout. Notices stay on stderr.
  -h, --help        Print help for the command and exit`;

export const ROOT_HELP = `forgebridge — drive a Roblox Studio place from a shell

Every command that reaches a transport prints, on stderr, who can read what you
just sent — in the protocol's own words:

  ${PRIVACY_POSTURE['local-daemon']}
  ${PRIVACY_POSTURE['relay-tls']}
  ${PRIVACY_POSTURE['relay-e2e']}

Usage:
  forgebridge <command> [options]

Commands:
  daemon      Start the local transport on this machine
  link        Show the Studio link: transport, state, pairing
  status      Daemon health, link posture, model availability
  models      Query the model catalog the transport serves
  run         Submit a run from a prompt
  diff        Render a changeset for review
  apply       Report on an approved changeset as it is applied
  rollback    Reverse an apply, from its journal entry

${GLOBAL}

${EXIT_CODES}

Run \`forgebridge help <command>\` for detail.`;

const COMMAND_HELP: Record<Command, string> = {
  daemon: `forgebridge daemon — start the local transport

Binds 127.0.0.1 only. No cloud, no account: ${PRIVACY_POSTURE['local-daemon'].toLowerCase()}.

Prints two secrets once, to this terminal, and never over HTTP: the pairing code
the Studio plugin needs, and the producer token every other command needs.

Usage:
  forgebridge daemon [options]

Options:
  --port <n>            Port to bind
  --project <uuid>      Project id links and changesets default to
  --allow-path <path>   Instance path a ChangeSet may write to, itself or beneath,
                        e.g. ServerScriptService.Shop (repeatable). Without at
                        least one, every ChangeSet is refused.
  --allow-origin <url>  Permit a browser origin to call the transport (repeatable)
  --allow-http-host <h> Host a generated script may reach through HttpService,
                        e.g. api.example.com or *.example.com (repeatable).
                        Without any, every outbound call is a finding.

${EXIT_CODES}`,

  link: `forgebridge link — show the Studio link

Reports the transport, the privacy posture, every link the transport knows, and
whether a pairing code is currently outstanding.

Usage:
  forgebridge link [options]

Pairing is not done from here. The code the daemon printed is carried by hand
into the Studio plugin, which redeems it and derives the session key it will
sign its own requests with. It is single use, valid ${PAIRING.TTL_SECONDS / 60} minutes, and good for
${PAIRING.MAX_ATTEMPTS} attempts. \`--code\` is refused, with an explanation.

${GLOBAL}

${EXIT_CODES}`,

  status: `forgebridge status — is this thing working

Reports daemon health, the link posture and state, and whether a model registry
is configured. The one command to run before asking why nothing happened.

Usage:
  forgebridge status [options]

${GLOBAL}

${EXIT_CODES}`,

  models: `forgebridge models — query the model catalog

Usage:
  forgebridge models [--free] [--caps <capability,...>] [options]

Options:
  --free            Only models the registry derived as free from their price
  --caps <list>     Only models carrying every listed capability, e.g.
                    --caps tools,structured_outputs (repeatable)

${GLOBAL}

${EXIT_CODES}`,

  run: `forgebridge run — submit a run from a prompt

Usage:
  forgebridge run "<prompt>" [options]

Options:
  --project <uuid>      Project to run against (default: the transport's own)
  --policy <name>       How the router orders and falls back over the candidates:
                        ${ROUTING_POLICIES.join(', ')}. Default free-first, which
                        is the only default that cannot surprise you with a bill.
  --model <id>          Pin one model. Implies --policy pinned, which disables
                        fallback entirely: that model or nothing.
  --base-version <n>    The tree version this run must build against. A mismatch
                        is refused before a token is spent, not after.
  --max-attempts <n>    Cap how many models one run may try (1–${MAX_RUN_ATTEMPTS})
  --verbose             Print every attempt in full — durations, tokens, cost,
                        the router's ordering, and the candidates it skipped

Every model tried is printed as it is tried, and again as one line at the end:

  models     glm-5.2:free → rate-limited → minimax-m3:free

That line is the run's record. A model swapped in without an attempt beside it
would be a silent substitution, which is the thing ADR-008 exists to prevent.

This command never applies. A run leaves a ChangeSet in "validated"; it prints
the changeset id, how to review it, and how a human approves it. There is no
flag that approves — that flag would be the off switch for the only gate
between a model and your place (ADR-012).

Needs the producer token: a run spends the daemon operator's model credit.

${GLOBAL}

${EXIT_CODES}`,

  diff: `forgebridge diff — render a changeset for review

Usage:
  forgebridge diff <changeset-id> [options]

Shows the summary, the validation verdict, whether the set has gone stale
against the current project version, and every operation with the paths it
touches. Destructive operations are marked.

Needs the producer token: a diff serves script source and property values out of
your place.

${GLOBAL}

${EXIT_CODES}`,

  apply: `forgebridge apply — report on an approved changeset as it is applied

Usage:
  forgebridge apply <changeset-id> [options]

Options:
  --timeout <s>     Seconds to wait for a terminal outcome (default ${DEFAULT_APPLY_TIMEOUT_SECONDS}).
                    0 reports what is true now and exits.

Refuses any changeset that is not approved, and says how to approve one. There
is no flag that approves on your behalf — that flag would be the off switch for
the only gate between a model and your place (ADR-012).

${GLOBAL}

${EXIT_CODES}`,

  rollback: `forgebridge rollback — reverse an apply

Usage:
  forgebridge rollback <journal-id> --expected-version <n> [options]

Options:
  --expected-version <n>  The project version this rollback must apply against.
                          Required, never guessed: it is what stops a reversal
                          landing on a tree that has moved since.
  --reason <text>         Recorded with the request

Dispatches the reversal to the paired Studio session, which holds the inverse
operations. Dispatched is not done — only the consumer that captured the
inverses can say a rollback completed.

${GLOBAL}

${EXIT_CODES}`,
};

export function helpFor(topic: Command | null): string {
  return topic === null ? ROOT_HELP : COMMAND_HELP[topic];
}
