import { z } from 'zod';
import type { Invocation } from '../args.js';
import { EXIT, operationFailed, type ExitCode } from '../exit.js';
import { emitJson, paint, renderTable, truncate } from '../output.js';
import { humanCount, relativeTime } from '../format.js';
import { printPosture } from '../posture.js';
import type { Deps } from './context.js';

/**
 * `forgebridge models` — what this transport can route to.
 *
 * ── Reading records the transport types as opaque ────────────────────────────
 *
 * `GET /v1/models` answers with `ModelsSnapshot`, whose `models` are
 * `Record<string, unknown>`. That is deliberate on the daemon's side: the
 * catalog reaches it through a port, and typing the records would put catalog
 * knowledge into the transport. It leaves a client that wants a table needing
 * to read fields out of an untyped bag.
 *
 * The projection below is tolerant on purpose — every field optional, every
 * absence rendered as a dash. Two alternatives were worse. Importing
 * `CatalogModel` from `@forgebridge/model-registry` would give this package a
 * second copy of the catalog's shape and a dependency the layering does not
 * want; parsing strictly would mean a registry that adds a field, or a
 * self-hoster serving a slightly different catalog, turns `forgebridge models`
 * into an error instead of a table with one column missing.
 *
 * `free` is the field to be careful with. In the registry it is derived from
 * price and re-derived on every read — never asserted — so it is displayed
 * exactly as received and only when it is actually a boolean. A missing `free`
 * renders as `?`, never as `no`: guessing "not free" is a smaller lie than
 * guessing "free", and both are lies about someone's bill.
 */

const ModelRow = z
  .object({
    id: z.string().optional(),
    displayName: z.string().optional(),
    author: z.string().optional(),
    provider: z.string().optional(),
    contextTokens: z.number().optional(),
    capabilities: z.array(z.string()).optional(),
    free: z.boolean().optional(),
    freeReason: z.string().optional(),
  })
  .passthrough();

type ModelRow = z.infer<typeof ModelRow>;

export async function modelsCommand(
  invocation: Extract<Invocation, { command: 'models' }>,
  deps: Deps,
): Promise<ExitCode> {
  const transport = deps.createTransport(invocation.global);
  const { io } = deps;

  const link = await transport.linkStatus();
  printPosture(io, link.transport);

  const snapshot = await transport.models();

  if (!snapshot.configured) {
    /**
     * "Nothing is configured" is not "there are no free models".
     *
     * The snapshot carries `configured` precisely so the two can be told apart,
     * and a script that read an empty list as an availability answer would pick
     * no model and blame the filter. Exiting non-zero is what stops it.
     */
    throw operationFailed(
      'this transport has no model registry configured, so it can tell you nothing about model availability',
      'Start a transport with a registry wired in, or check `forgebridge status`.',
    );
  }

  // Each record is kept beside its projection so `--json` can emit the record
  // exactly as it arrived while the table reads the projection.
  const all = snapshot.models.map((record) => {
    const parsed = ModelRow.safeParse(record);
    return { record, model: parsed.success ? parsed.data : ({} as ModelRow) };
  });

  const matching = all.filter(({ model }) => {
    if (invocation.free && model.free !== true) return false;
    return invocation.capabilities.every((capability) => model.capabilities?.includes(capability) === true);
  });

  if (invocation.global.json) {
    // The records as received, not the projection: a machine consumer wants
    // every field the registry published, including the ones no column shows.
    emitJson(io, {
      source: snapshot.source,
      verifiedAt: snapshot.verifiedAt,
      total: snapshot.models.length,
      matched: matching.length,
      filters: { free: invocation.free, capabilities: invocation.capabilities },
      models: matching.map(({ record }) => record),
    });
    return EXIT.OK;
  }

  io.err(
    paint(
      io,
      'dim',
      `${humanCount(snapshot.models.length)} model(s) from ${snapshot.source}, verified ${relativeTime(snapshot.verifiedAt, deps.now())}`,
    ),
  );

  if (matching.length === 0) {
    // An empty result from a configured registry is an answer, so this succeeds.
    // Naming the capabilities the snapshot actually carries turns a typo in
    // `--caps` into a one-line fix instead of a guess.
    io.err(paint(io, 'yellow', 'no models match those filters'));
    const available = [...new Set(all.flatMap(({ model }) => model.capabilities ?? []))].sort();
    if (invocation.capabilities.length > 0 && available.length > 0) {
      io.err(paint(io, 'dim', `capabilities in this catalog: ${available.join(', ')}`));
    }
    return EXIT.OK;
  }

  io.out(
    renderTable(
      [
        { header: 'MODEL' },
        { header: 'AUTHOR' },
        { header: 'CONTEXT', align: 'right' },
        { header: 'FREE' },
        { header: 'CAPABILITIES' },
      ],
      matching.map(({ model }) => [
        model.id ?? '—',
        model.author ?? model.provider ?? '—',
        model.contextTokens === undefined ? '—' : humanCount(model.contextTokens),
        model.free === undefined ? '?' : model.free ? 'yes' : 'no',
        truncate((model.capabilities ?? []).join(' '), 60) || '—',
      ]),
    ),
  );

  return EXIT.OK;
}
