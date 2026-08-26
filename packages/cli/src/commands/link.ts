import { PAIRING } from '@forgebridge/protocol';
import type { Invocation } from '../args.js';
import { EXIT, usageError, type ExitCode } from '../exit.js';
import { emitJson, renderTable } from '../output.js';
import { relativeTime } from '../format.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge link` — what the Studio link looks like from here.
 *
 * ── Why `--code` is refused ──────────────────────────────────────────────────
 *
 * A pairing code is redeemed by the *consumer*: the Studio plugin posts it to
 * `/v1/link/pair`, and both sides derive a session key from the code and a
 * per-pairing salt. That key is what the plugin signs its polls and its apply
 * results with, and it is the only thing separating the paired Studio session
 * from anything else that found the port.
 *
 * The CLI is a producer. If it redeemed the code it would burn a single-use,
 * ten-minute credential and register itself as the Studio session for the
 * project — leaving a link the daemon believes is paired, with no place behind
 * it and no plugin able to pair, until the code was reissued. That is not a
 * feature with a warning on it; it is a way to break pairing from the command
 * line, so the flag is recognised and refused with the reason rather than
 * silently rejected as unknown.
 *
 * The code travels the way it was designed to: printed once on the terminal the
 * daemon was started from, carried by hand into the plugin.
 */
export async function linkCommand(
  invocation: Extract<Invocation, { command: 'link' }>,
  deps: Deps,
): Promise<ExitCode> {
  if (invocation.code !== null) {
    throw usageError(
      'pairing codes are redeemed by the Studio plugin, not by the CLI',
      [
        'The plugin posts the code to /v1/link/pair and derives the session key it signs its own requests with.',
        'Redeeming it here would consume a single-use code and register this CLI as the Studio session for the project.',
        `Type the code the daemon printed into the plugin instead — it is valid ${PAIRING.TTL_SECONDS / 60} minutes and good for ${PAIRING.MAX_ATTEMPTS} attempts.`,
      ].join('\n'),
    );
  }

  const transport = deps.createTransport(invocation.global);
  const status = await transport.linkStatus();
  const { io } = deps;

  printPosture(io, status.transport);

  if (invocation.global.json) {
    emitJson(io, status);
    return EXIT.OK;
  }

  io.out(`transport  ${status.transport}`);
  io.out(`protocol   ${status.protocolVersion}`);
  io.out(`project    ${status.defaultProjectId}`);

  if (status.links.length === 0) {
    io.out('links      none — no Studio session has paired with this transport');
  } else {
    io.out('');
    io.out(
      renderTable(
        [
          { header: 'LINK' },
          { header: 'STATE' },
          { header: 'PLUGIN' },
          { header: 'PLACE' },
          { header: 'LAST SEEN' },
        ],
        status.links.map((link) => [
          link.id,
          link.state,
          link.pluginVersion ?? '—',
          link.placeId === null ? '—' : String(link.placeId),
          relativeTime(link.lastSeenAt, deps.now()),
        ]),
      ),
    );
    io.out('');
  }

  if (status.pairing === null) {
    io.out('pairing    no code outstanding');
  } else {
    // Only that a code exists, never the code. The daemon refuses to serve it
    // for the same reason: anything that can reach the port could then pair.
    const remaining = Math.max(0, (Date.parse(status.pairing.expiresAt) - deps.now()) / 1000);
    io.out(
      `pairing    a code is outstanding — expires in ${Math.ceil(remaining)}s, ${status.pairing.attemptsRemaining} attempt(s) left`,
    );
    io.out('           Type it into the Studio plugin; it is not served over HTTP.');
  }

  return EXIT.OK;
}
