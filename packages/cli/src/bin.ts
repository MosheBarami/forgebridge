#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, exitCodeFor, type ExitCode } from './exit.js';
import { createIo, emitJson, paint } from './output.js';
import { parseInvocation } from './args.js';
import { defaultDeps, dispatch } from './index.js';

/**
 * `forgebridge` — the only file in this package that knows a process exists.
 *
 * Everything above it returns an exit code and writes through an `Io`; this
 * turns that into `process.exitCode`. Keeping the boundary here is what makes
 * the rest testable without spawning anything.
 */

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<ExitCode> {
  /**
   * Whether the caller wants machine output has to be known before the command
   * line is parsed, because a *usage* error is exactly the case where parsing
   * did not finish. A script that asked for `--json` and got a bare English
   * sentence on a bad flag has to parse prose to find out what went wrong.
   */
  const json = argv.includes('--json');
  const io = createIo({ stdout: process.stdout, stderr: process.stderr, env, json });

  try {
    return await dispatch(parseInvocation(argv, env), defaultDeps(io));
  } catch (error) {
    const code = exitCodeFor(error);
    const message = error instanceof Error ? error.message : String(error);
    const remedy = error instanceof CliError ? error.remedy : undefined;

    if (json) {
      // Errors are results too. On stderr, so a `--json` consumer redirecting
      // stdout still gets a parseable failure instead of an empty document.
      emitJson({ ...io, out: io.err }, { ok: false, exitCode: code, error: message, ...(remedy ? { remedy } : {}) });
    } else {
      io.err(paint(io, 'red', `error: ${message}`));
      if (remedy) io.err(remedy);
    }

    // An unexpected exception is a bug in this package, not something the user
    // can act on, so its stack goes to stderr rather than being swallowed —
    // behind an env var, because a stack trace in normal CI output is noise.
    if (!(error instanceof CliError) && env['FORGEBRIDGE_DEBUG'] && error instanceof Error && error.stack) {
      io.err(error.stack);
    }
    return code;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

/**
 * Only run when this file was executed, not when it was imported — the same
 * guard `packages/daemon/src/bin.ts` and `scripts/verify-boundaries.ts` use, so
 * that a test importing `main` does not run the CLI as a side effect.
 */
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      // `exitCode` rather than `exit()`: stdout may still be draining into a
      // pipe, and `process.exit` truncates it. A CLI that loses the tail of its
      // own JSON when piped is a CLI that works only in a terminal.
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT.FAILED;
    },
  );
}
