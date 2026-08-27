import { ErrorCode, ForgeBridgeError, ProtocolError } from '@forgebridge/protocol';

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
    /**
     * The protocol code this refusal came from, when it came from one.
     *
     * Four exit codes are enough for a shell and not enough for a caller
     * embedding this package: `EXIT.FAILED` covers a stale base, an unapproved
     * ChangeSet and a policy violation alike, and those call for three
     * different next moves. The code is carried alongside rather than folded
     * into the message, because a caller that had to scrape `stale_base:` off
     * the front of a sentence would be branching on prose.
     *
     * Absent when this CLI refused on its own account — a bad flag is not a
     * protocol error, and reporting one as `invalid_request` would claim the
     * transport said something it never saw.
     */
    readonly code?: ErrorCode,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (message: string, remedy?: string): CliError =>
  new CliError(EXIT.USAGE, message, remedy);

export const operationFailed = (message: string, remedy?: string, code?: ErrorCode): CliError =>
  new CliError(EXIT.FAILED, message, remedy, code);

export const daemonUnreachable = (message: string, remedy?: string): CliError =>
  new CliError(EXIT.UNREACHABLE, message, remedy);

/**
 * Any failure this CLI can produce, reduced to the protocol code a caller
 * branches on — and to whether it recognised one at all.
 *
 * `recognised: false` travels with the `internal` default rather than being
 * inferred from it, because `internal` is also a real answer the daemon sends.
 * A CLI that reported a missing daemon as `not_approved` would be inventing an
 * approval decision out of a closed socket.
 *
 * The unreachable case is the one worth naming: the protocol's `ErrorCode` has
 * no "the transport is not there" member, so it lands on `internal` and says so
 * in its message. That gap is the same one `packages/daemon/src/auth.ts` and
 * `packages/mcp/src/daemon-client.ts` both record — TODO(M31), owner: the
 * protocol maintainer. Exit code 3 is what a shell branches on meanwhile, and
 * it is not lost: it is on the error this reads.
 */
export interface FailureView {
  code: ErrorCode;
  recognised: boolean;
  exitCode: ExitCode;
  message: string;
  remedy?: string;
}

export function classifyFailure(error: unknown): FailureView {
  if (error instanceof CliError && error.code) {
    return {
      code: error.code,
      recognised: true,
      exitCode: error.exitCode,
      message: error.message,
      ...(error.remedy ? { remedy: error.remedy } : {}),
    };
  }

  if (error instanceof ForgeBridgeError) {
    return {
      code: error.code,
      recognised: true,
      exitCode: EXIT.FAILED,
      message: error.message,
      ...(error.remedy ? { remedy: error.remedy } : {}),
    };
  }

  const payload = ProtocolError.safeParse(error);
  if (payload.success) {
    return {
      code: payload.data.code,
      recognised: true,
      exitCode: EXIT.FAILED,
      message: payload.data.message,
      ...(payload.data.remedy ? { remedy: payload.data.remedy } : {}),
    };
  }

  return {
    code: 'internal',
    recognised: false,
    exitCode: exitCodeFor(error),
    message: error instanceof Error ? error.message : 'a non-error was thrown',
  };
}

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
