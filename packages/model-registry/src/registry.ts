import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { deriveFree } from './derive.js';
import {
  Catalog,
  type Capability,
  type CatalogModel,
  type ExcludedModel,
  type ProviderInfo,
  type RankBy,
} from './types.js';

const DAY_MS = 86_400_000;

/**
 * How old the snapshot may get before the UI must stop presenting it as current.
 * ADR-007 accepts up to a week of lag by design (the drift job runs weekly); this
 * threshold is the point at which the job itself has evidently stopped running.
 */
export const STALENESS_THRESHOLD_DAYS = 14;

/**
 * Resolved against this module's own URL so the same path works from `src` under
 * vitest and from `dist` in a published install. A `process.cwd()`-relative path
 * would resolve to whatever directory the daemon happened to start in.
 *
 * `.href` rather than the `URL` object, and that is not redundant. `fileURLToPath`
 * accepts either, but it identifies a `URL` by realm, so a bundler that supplies
 * its own `URL` implementation hands `node:url` an object it refuses with
 * "Received an instance of URL" — which is what `next build` did to the models
 * settings page. A string carries no realm, so it is the form that survives
 * being bundled by something we do not control.
 */
export const CATALOG_PATH = fileURLToPath(new URL('../data/catalog.json', import.meta.url).href);

export interface Staleness {
  syncedAt: Date;
  ageMs: number;
  /** Fractional days — rounded by whoever displays it, not here. */
  ageDays: number;
  stale: boolean;
  thresholdDays: number;
}

/**
 * Read and validate the catalog. Throws on anything unreadable or malformed:
 * a registry that silently degrades to zero models sends the router down the
 * "no provider configured" path, where the real fault — a broken build artefact —
 * is invisible.
 *
 * The thrown errors carry the path and the schema failure on purpose. This is a
 * packaging fault surfacing to whoever is running the process, never a payload
 * crossing the wire, so there is nothing here to withhold.
 */
export function loadCatalog(path: string = CATALOG_PATH): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`model-registry: cannot read catalog at ${path}`, { cause });
  }

  const parsed = Catalog.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`model-registry: ${path} is not a valid catalog — ${summarise(parsed.error)}`);
  }
  return parsed.data;
}

function summarise(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
  const rest = error.issues.length - issues.length;
  return rest > 0 ? `${issues.join('; ')} (+${rest} more)` : issues.join('; ');
}

export class ModelRegistry {
  private readonly index: ReadonlyMap<string, CatalogModel>;

  private constructor(readonly catalog: Catalog) {
    this.index = new Map(catalog.models.map((model) => [model.id, model]));
  }

  /** Load the catalog shipped with this package. */
  static load(path?: string): ModelRegistry {
    return new ModelRegistry(loadCatalog(path));
  }

  /** Build from an in-memory catalog — validated, because this is the untrusted door. */
  static fromCatalog(catalog: unknown): ModelRegistry {
    return new ModelRegistry(Catalog.parse(catalog));
  }

  /** Every model in the snapshot, in catalog order. */
  all(): readonly CatalogModel[] {
    return this.catalog.models;
  }

  /** Models the sync saw and left out, each with its recorded reason. */
  excluded(): readonly ExcludedModel[] {
    return this.catalog.excluded;
  }

  /**
   * Exact id lookup, with no normalisation of any kind.
   *
   * In particular the `:free` suffix is never stripped or resolved.
   * `z-ai/glm-5.2:free` and `z-ai/glm-5.2` are different tiers with different
   * endpoints and different prices — the paid one's cheapest endpoint is
   * $0.4186/M input. A lookup that fell back from one to the other would answer
   * a question about a free model with a paid model's pricing, which is the exact
   * shape of bug ADR-007 is written against. A miss returns undefined; the caller
   * decides what to do about it.
   */
  byId(id: string): CatalogModel | undefined {
    return this.index.get(id);
  }

  /** Models carrying *every* listed capability. An empty list matches everything. */
  withCapabilities(capabilities: readonly Capability[]): CatalogModel[] {
    return this.catalog.models.filter((model) =>
      capabilities.every((capability) => model.capabilities.includes(capability)),
    );
  }

  /**
   * Models that are free and still available.
   *
   * Freeness is re-derived here rather than read from the stored `free` field.
   * The field is a cache written by the sync script; trusting it would mean a
   * hand-edited catalog could assert `free: true` on a model that bills per song
   * and the registry would repeat the claim. ADR-007's whole point is that this
   * is derived, never asserted — including when the assertion is our own file.
   */
  freeModels(now: Date = new Date()): CatalogModel[] {
    return this.catalog.models.filter((model) => {
      const derivation = deriveFree(model, now);
      return derivation.free && !derivation.expired;
    });
  }

  /** See the free function `rank`. */
  rank<T extends { benchmarks: CatalogModel['benchmarks'] }>(models: readonly T[], by: RankBy): T[] {
    return rank(models, by);
  }

  /** Providers summarised from the models actually present. */
  providers(): ProviderInfo[] {
    const order: string[] = [];
    const accumulated = new Map<string, { modelCount: number; freeCount: number; authors: string[] }>();

    for (const model of this.catalog.models) {
      let entry = accumulated.get(model.provider);
      if (entry === undefined) {
        entry = { modelCount: 0, freeCount: 0, authors: [] };
        accumulated.set(model.provider, entry);
        order.push(model.provider);
      }
      entry.modelCount += 1;
      if (deriveFree(model).free) entry.freeCount += 1;
      if (!entry.authors.includes(model.author)) entry.authors.push(model.author);
    }

    return order.map((id) => {
      const entry = accumulated.get(id) as { modelCount: number; freeCount: number; authors: string[] };
      return { id, source: this.catalog.source, ...entry };
    });
  }

  /** How old the snapshot is, and whether that is now a problem. */
  staleness(now: Date = new Date()): Staleness {
    const syncedAt = new Date(this.catalog.syncedAt);
    const ageMs = now.getTime() - syncedAt.getTime();
    const ageDays = ageMs / DAY_MS;
    return {
      syncedAt,
      ageMs,
      ageDays,
      stale: ageDays > STALENESS_THRESHOLD_DAYS,
      thresholdDays: STALENESS_THRESHOLD_DAYS,
    };
  }
}

/**
 * Order by a benchmark, best first, without mutating the input.
 *
 * Models with no score for the requested axis sort **last**, never as zero. A
 * missing benchmark is not a bad benchmark: coercing null to 0 would bury an
 * unmeasured model beneath every model that was measured and scored badly, and
 * the router would then "prefer" the worse one on the strength of a number
 * nobody ever produced. Ties, including ties among the unscored, keep their
 * catalog order so ranking is deterministic across runs.
 */
export function rank<T extends { benchmarks: CatalogModel['benchmarks'] }>(
  models: readonly T[],
  by: RankBy,
): T[] {
  return models
    .map((model, position) => ({ model, position, score: scoreOf(model.benchmarks, by) }))
    .sort((a, b) => {
      if (a.score === null && b.score === null) return a.position - b.position;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      if (a.score !== b.score) return b.score - a.score;
      return a.position - b.position;
    })
    .map((entry) => entry.model);
}

/** Null both when the axis is unscored and when the model has no benchmarks at all. */
export function scoreOf(benchmarks: CatalogModel['benchmarks'], by: RankBy): number | null {
  return benchmarks === null ? null : benchmarks[by];
}

let cached: ModelRegistry | undefined;

/**
 * The shipped catalog, loaded once per process. The snapshot is immutable data
 * on disk, so re-reading it per query would buy nothing but syscalls.
 */
export function getRegistry(): ModelRegistry {
  cached ??= ModelRegistry.load();
  return cached;
}
