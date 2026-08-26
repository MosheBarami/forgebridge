/**
 * Exit codes, and the error type that carries one.
 *
 * CI consumers depend on these more than on stdout: a pipeline step branches on
 * `$?` long before anyone reads the log. So the set is small, closed, and
 * documented in `--help` — and the distinction that earns its place is 1 versus
 * 3. "The daemon refused what you asked" and "there is no daemon" call for
 * different pipeline behaviour: the first is a real answer to act on, the second
 * is a missing prerequisite to retry or start.
 */
export const EXIT = {
  /** The command did what it said. */
  OK: 0,
  /** The daemon was reached and the operation did not succeed. */
  FAILED: 1,
  /** The command line itself was wrong; nothing was attempted. */
  USAGE: 2,
  /** No daemon answered at the base address. */
  UNREACHABLE: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error that already knows what the process should exit with.
 *
 * `remedy` mirrors `ProtocolError.remedy` from the protocol: the daemon answers
 * refusals with a sentence saying what to do next, and dropping it on the floor
 * on the way to a terminal would waste the one field written for the person
 * reading this output.
 */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (message: string, remedy?: string): CliError =>
  new CliError(EXIT.USAGE, message, remedy);

export const operationFailed = (message: string, remedy?: string): CliError =>
  new CliError(EXIT.FAILED, message, remedy);

export const daemonUnreachable = (message: string, remedy?: string): CliError =>
  new CliError(EXIT.UNREACHABLE, message, remedy);

/**
 * The exit code for any thrown value.
 *
 * An unexpected exception is a failed operation, not a usage error: the command
 * line was accepted, something after it broke. Defaulting the other way would
 * tell a CI job to go and re-read its own flags over a bug in this package.
 */
export function exitCodeFor(error: unknown): ExitCode {
  return error instanceof CliError ? error.exitCode : EXIT.FAILED;
}
