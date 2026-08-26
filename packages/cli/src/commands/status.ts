import type { ModelsSnapshot } from '@forgebridge/daemon';
import type { Invocation } from '../args.js';
import { EXIT, type ExitCode } from '../exit.js';
import { emitJson, paint } from '../output.js';
import { humanCount, humanDuration, relativeTime } from '../format.js';
import { postureSentence, printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge status` — the command to run before asking why nothing happened.
 *
 * It answers the three questions in the order they actually block someone: is
 * there a daemon, is Studio on the other end of it, and is there a model to
 * route to. A run that never starts is almost always one of those three, and
 * each has a different fix.
 */
export async function statusCommand(
  invocation: Extract<Invocation, { command: 'status' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);
  const { io } = deps;

  const health = await transport.health();
  const link = await transport.linkStatus();

  printPosture(io, link.transport);

  /**
   * A registry failure does not sink the report.
   *
   * `status` is a diagnostic: aborting on the third of three questions would
   * hide the answers to the first two, which are the ones more likely to be
   * wrong. The failure is reported in place, in the row it belongs to.
   */
  let models: ModelsSnapshot | null = null;
  let modelsError: string | null = null;
  try {
    models = await transport.models();
  } catch (error) {
    modelsError = error instanceof Error ? error.message : String(error);
  }

  if (invocation.global.json) {
    emitJson(io, {
      health,
      link: {
        transport: link.transport,
        privacyPosture: postureSentence(link.transport),
        protocolVersion: link.protocolVersion,
        defaultProjectId: link.defaultProjectId,
        links: link.links,
        pairing: link.pairing,
      },
      models: models ?? { error: modelsError },
    });
    return EXIT.OK;
  }

  io.out(
    `daemon     ${paint(io, 'green', 'ok')}  ${health.service} ${health.version} (protocol ${health.protocolVersion}) on ${health.boundTo}, up ${humanDuration(health.uptimeSeconds)}`,
  );
  io.out(`transport  ${link.transport}`);

  const paired = link.links.filter((entry) => entry.state === 'paired');
  if (paired.length === 0) {
    io.out(
      `link       ${paint(io, 'yellow', 'unpaired')} — no Studio session. Nothing can apply a ChangeSet until one pairs.`,
    );
  } else {
    for (const entry of paired) {
      io.out(
        `link       ${paint(io, 'green', 'paired')} — plugin ${entry.pluginVersion ?? 'unknown'}, place ${entry.placeId ?? 'unknown'}, last seen ${relativeTime(entry.lastSeenAt, deps.now())}`,
      );
    }
  }

  io.out(
    link.pairing === null
      ? 'pairing    no code outstanding'
      : `pairing    a code is outstanding, ${link.pairing.attemptsRemaining} attempt(s) left`,
  );

  if (modelsError !== null) {
    io.out(`models     ${paint(io, 'red', 'unavailable')} — ${modelsError}`);
  } else if (models === null || !models.configured) {
    io.out(
      `models     ${paint(io, 'yellow', 'no registry configured')} — this transport was started without one, so no run can be routed.`,
    );
  } else {
    io.out(
      `models     ${humanCount(models.models.length)} from ${models.source}, verified ${relativeTime(models.verifiedAt, deps.now())}`,
    );
  }

  return EXIT.OK;
}
