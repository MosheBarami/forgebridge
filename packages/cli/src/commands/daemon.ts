import { createDaemon, PRODUCER_TOKEN_ENV, PRODUCER_TOKEN_HEADER, type DaemonLogger } from '@forgebridge/daemon';
import { PAIRING, PRIVACY_POSTURE } from '@forgebridge/protocol';
import type { Invocation } from '../args.js';
import { EXIT, type ExitCode } from '../exit.js';
import { emitJson, paint } from '../output.js';
import type { Deps } from './context.js';

/**
 * `forgebridge daemon` — start the local transport.
 *
 * A front-end, not a second implementation: every decision — loopback binding,
 * pairing, the deny-all default policy, the producer token — belongs to
 * `@forgebridge/daemon` and is reached through `createDaemon`. What lives here
 * is presentation, which is the CLI's job, plus the one thing this front-end
 * does differently: the posture line comes from the protocol's
 * `PRIVACY_POSTURE` rather than being written out again, so a transport whose
 * posture ever changes cannot leave a stale sentence behind in this package.
 *
 * `--allow-path` is not decoration. The daemon's default policy denies
 * everything, so a daemon started without at least one writable prefix refuses
 * every ChangeSet — and a start-up that looks healthy and then rejects all work
 * is the failure people spend an afternoon on.
 *
 * `--allow-http-host` is the same shape of default in the other layer: with none
 * given, the Luau analyser reports every `HttpService` call as a finding. Both
 * lists are printed below, because an allowlist nobody can see is one people
 * assume is wider than it is.
 */
export async function daemonCommand(
  invocation: Extract<Invocation, { command: 'daemon' }>,
  deps: Deps,
): Promise<ExitCode> {
  const { io } = deps;

  const logger: DaemonLogger = {
    info: (message, fields) => io.err(line('info', message, fields)),
    warn: (message, fields) => io.err(line('warn', message, fields)),
    error: (message, fields) => io.err(line('error', message, fields)),
  };

  const daemon = createDaemon({
    port: invocation.port,
    allowedOrigins: invocation.allowOrigins,
    allowedHttpHosts: invocation.allowHttpHosts,
    policy: { allowedPathPrefixes: invocation.allowPaths, autoApply: null },
    logger,
    ...(invocation.projectId === null ? {} : { projectId: invocation.projectId }),
    // An operator who exported a token can hand the same value to a client it
    // launches; absent it, the daemon mints one and it is printed below.
    ...(process.env[PRODUCER_TOKEN_ENV] ? { producerToken: process.env[PRODUCER_TOKEN_ENV] } : {}),
  });

  const bound = await daemon.listen();
  const pairing = daemon.issuePairingCode();

  /**
   * Two secrets, printed once, to stderr, and never to stdout.
   *
   * The daemon does not serve either of them over HTTP — serving the pairing
   * code would hand it to anything that can reach the port. Putting them on
   * stdout would be the same mistake one layer up: stdout is what gets piped
   * into a file, a log shipper, or a CI artifact. `--json` therefore emits the
   * address and nothing secret.
   */
  if (invocation.global.json) {
    emitJson(io, {
      url: bound.url,
      host: bound.host,
      port: bound.port,
      projectId: daemon.defaultProjectId,
      transport: 'local-daemon',
      privacyPosture: PRIVACY_POSTURE['local-daemon'],
    });
  }

  io.err('');
  io.err(`  ForgeBridge daemon listening on ${bound.url}`);
  io.err(`  ${PRIVACY_POSTURE['local-daemon']}.`);
  io.err('');
  io.err(`  Pairing code: ${pairing.code}`);
  io.err(
    `  Valid for ${PAIRING.TTL_SECONDS / 60} minutes, ${PAIRING.MAX_ATTEMPTS} attempts, single use. Type it into the Studio plugin.`,
  );
  io.err('');
  io.err(`  Producer token: ${daemon.producerToken}`);
  io.err(`  Send it as ${PRODUCER_TOKEN_HEADER}, or export ${PRODUCER_TOKEN_ENV}, for diff, apply and rollback.`);
  io.err('');
  io.err(`  Project: ${daemon.defaultProjectId}`);
  io.err(
    invocation.allowPaths.length > 0
      ? `  Writable paths: ${invocation.allowPaths.join(', ')}`
      : paint(
          io,
          'yellow',
          '  Writable paths: none — every ChangeSet will be refused. Pass --allow-path <InstancePath>.',
        ),
  );
  io.err(
    invocation.allowHttpHosts.length > 0
      ? `  HttpService hosts: ${invocation.allowHttpHosts.join(', ')}`
      : '  HttpService hosts: none — every outbound call in a generated script is a finding.',
  );
  io.err('');

  await untilSignalled(async () => {
    io.err('closing');
    await daemon.close();
  });

  return EXIT.OK;
}

function line(level: string, message: string, fields?: Record<string, unknown>): string {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `[${new Date().toISOString()}] ${level} ${message}${suffix}`;
}

/**
 * Hold the process open until a signal, then shut down once.
 *
 * The `closing` latch matters: a second SIGINT while `close()` is draining held
 * long-polls would start a second shutdown over the top of the first.
 */
function untilSignalled(close: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let closing = false;
    const onSignal = (): void => {
      if (closing) return;
      closing = true;
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      close().then(resolve, reject);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
