import { DEFAULT_PIPELINE_REQUIREMENTS } from '@forgebridge/core';

/*
 * ── Why these three imports look the way they do ───────────────────────────
 *
 * `@forgebridge/model-registry` cannot be imported from its package root here,
 * and the reason is a real defect rather than a preference.
 *
 * `src/registry.ts` computes its data path at **module scope**:
 *
 *     export const CATALOG_PATH = fileURLToPath(new URL('../data/catalog.json', import.meta.url));
 *
 * That is the right way for a Node package to find its own data file and it
 * does not survive a bundler. Webpack rewrites `import.meta.url` to the emitted
 * chunk's location and substitutes its own `url` shim, whose `fileURLToPath`
 * accepts only strings — so merely *importing* the package root, without ever
 * calling `loadCatalog`, throws:
 *
 *     TypeError: The "path" argument must be of type string or an instance of URL.
 *                Received an instance of URL
 *
 * and `next build` fails at "Collecting page data" before this page renders.
 * `serverExternalPackages: ['@forgebridge/model-registry']` does not help: the
 * package reaches this app through a workspace symlink, webpack resolves it to
 * its real path outside `node_modules`, and Next therefore bundles it anyway.
 * Both were tried.
 *
 * So this module imports only the parts of the package that are free of Node
 * built-ins — `types.js` (the `Catalog` schema) and `derive.js` (ADR-007's
 * free-derivation rule) — and reads the catalog file as a module rather than
 * from disk. Nothing about *what is true* is restated here: the schema still
 * validates, and freeness is still derived by the package's own function.
 *
 * TODO(M35): fix this at the source and delete the deep paths below. One line
 * in `packages/model-registry/src/registry.ts` does it — move `CATALOG_PATH`'s
 * computation inside `loadCatalog` (or make it a function) so importing the
 * package has no side effect. The package should also export `./data/catalog.json`
 * and its submodules, so this file can use bare specifiers. Owner: the registry
 * maintainer. **The settings surface's `lib/models/catalog.ts` hits the same
 * defect and is currently failing the build for the same reason** — this is not
 * a problem local to one page.
 */
import catalogJson from '../../../../../../packages/model-registry/data/catalog.json';
import { deriveFree } from '../../../../../../packages/model-registry/dist/derive.js';
import { Catalog, type CatalogModel } from '../../../../../../packages/model-registry/dist/types.js';

/**
 * The model catalog, read on the server and shaped for the selector (M35).
 *
 * ── Where the list comes from ──────────────────────────────────────────────
 *
 * `packages/model-registry/data/catalog.json`, validated by the schema that
 * owns it. Not a list written here, and not a list written anywhere in this app
 * — ADR-007's argument is that a hand-maintained model list is wrong within a
 * week, and the sync script is the only thing allowed to author one.
 *
 * Freeness is **derived**, never read from the stored `free` flag. That flag is
 * a cache the sync wrote; trusting it would let a hand-edited catalog assert
 * that a model billed per generated song is free, and this page would repeat
 * the claim. `deriveFree` is the package's own answer and Lyria is its pinned
 * counterexample.
 *
 * ── Why this is a server module ────────────────────────────────────────────
 *
 * The catalog is build-time data. Shipping a fetch for a file that cannot
 * change between deploys would be a network round trip to learn something the
 * HTML could have carried, so the composer takes its models as a prop.
 *
 * ── Why the pipeline requirement is on screen ──────────────────────────────
 *
 * `DEFAULT_PIPELINE_REQUIREMENTS` is the core's own answer to what this
 * pipeline needs of a model: tool calling **and** structured output. At the
 * time of writing, four of the sixteen free models in this catalog carry both.
 * A selector listing all sixteen as choices would be offering twelve models
 * that cannot drive a run — the user picks one, the router skips it, and the
 * run log explains after the fact what the selector could have said before. So
 * eligibility is computed from the core's constant, never restated as a
 * literal, and the ineligible models are shown grouped with the reason.
 */

export interface ModelChoice {
  readonly id: string;
  readonly displayName: string;
  readonly author: string;
  readonly provider: string;
  readonly contextTokens: number;
  readonly free: boolean;
  /** Why `free` holds the value it does — `deriveFree`'s words, not the file's. */
  readonly freeReason: string;
  /** A free model with an expiry inside the registry's warning window. */
  readonly expiringSoon: boolean;
  readonly tools: boolean;
  readonly structuredOutputs: boolean;
  /** Meets `DEFAULT_PIPELINE_REQUIREMENTS`, so a run may actually use it. */
  readonly eligible: boolean;
  /** Which required capabilities are missing. Empty when `eligible`. */
  readonly missing: readonly string[];
  /** Published coding index, or null when the model was never scored on it. */
  readonly coding: number | null;
}

export interface CatalogSummary {
  /** What was read to produce these entries — the catalog's own provenance. */
  readonly source: string;
  readonly syncedAt: string;
  /** Past the staleness threshold, so the UI must stop calling it current. */
  readonly stale: boolean;
  readonly ageDays: number;
  readonly thresholdDays: number;
  /** How many models the provider listed, before derivation dropped any. */
  readonly catalogTotal: number;
  readonly freeCount: number;
  readonly eligibleCount: number;
  /** Models the sync saw and left out, each with the recorded reason. */
  readonly excluded: ReadonlyArray<{ id: string; reason: string; detail: string }>;
}

export interface CatalogView {
  readonly models: readonly ModelChoice[];
  readonly summary: CatalogSummary;
}

const REQUIRED = DEFAULT_PIPELINE_REQUIREMENTS.capabilities ?? [];

const DAY_MS = 86_400_000;

/**
 * Mirrors `STALENESS_THRESHOLD_DAYS` in `packages/model-registry/src/registry.ts`,
 * which cannot be imported here for the reason at the top of this file.
 *
 * A duplicated constant is a constant that can drift, and the honest thing is
 * to say so rather than to pretend this is single-source. It is pinned by
 * `catalog.test.ts`, which reads the number back out of the registry's source
 * and fails if the two stop agreeing — so the drift is caught by CI rather than
 * by a user being shown a stale catalog as though it were current.
 */
export const STALENESS_THRESHOLD_DAYS = 14;

function toChoice(model: CatalogModel, now: Date): ModelChoice {
  // Widened to `string[]` for the membership test: `REQUIRED` is the core's
  // `readonly string[]`, and the core is deliberately not typed against the
  // registry's `Capability` enum — a router that only understood capabilities
  // this catalog has heard of could not route to a locally discovered model.
  const declared: readonly string[] = model.capabilities;
  const missing = REQUIRED.filter((capability) => !declared.includes(capability));
  const derivation = deriveFree(model, now);

  return {
    id: model.id,
    displayName: model.displayName,
    author: model.author,
    provider: model.provider,
    contextTokens: model.contextTokens,
    // An expired free model is not a free model. `deriveFree` reports the two
    // separately and folding them here is what keeps a model that lapsed last
    // week out of the "free" group instead of at the top of it.
    free: derivation.free && !derivation.expired,
    freeReason: derivation.reason,
    expiringSoon: derivation.expiringSoon,
    tools: declared.includes('tools'),
    structuredOutputs: declared.includes('structured_outputs'),
    eligible: missing.length === 0,
    missing,
    coding: model.benchmarks?.coding ?? null,
  };
}

/**
 * Order by the published coding index, best first, stably.
 *
 * Models with no score sort **last**, never as zero — this mirrors `rank` in
 * the registry, and the reasoning is worth repeating because it is the part
 * that is easy to get wrong: a missing benchmark is not a bad benchmark.
 * Coercing null to 0 would bury an unmeasured model beneath every model that
 * was measured and scored badly, and the list would then "prefer" the worse one
 * on the strength of a number nobody ever produced. Ties keep catalog order, so
 * the result is deterministic across builds.
 */
function rankByCoding(models: readonly ModelChoice[]): ModelChoice[] {
  return models
    .map((model, position) => ({ model, position }))
    .sort((a, b) => {
      const left = a.model.coding;
      const right = b.model.coding;
      if (left === null && right === null) return a.position - b.position;
      if (left === null) return 1;
      if (right === null) return -1;
      if (left !== right) return right - left;
      return a.position - b.position;
    })
    .map((entry) => entry.model);
}

/**
 * The catalog, ordered the way the selector shows it: free first, then by the
 * coding index.
 *
 * "Free first" is the brief's ordering and it is also the router's default
 * policy, so the top of this list and the router's first attempt agree — a
 * selector whose order contradicted the router would teach the user a wrong
 * model of what happens when they press the button.
 *
 * Parsed once per server process: the snapshot is immutable data inlined into
 * the bundle, so re-validating it per request would buy nothing but CPU.
 */
let parsed: Catalog | undefined;

function catalog(): Catalog {
  // `Catalog.parse` throws on anything malformed, and that is deliberate. A
  // registry that silently degraded to zero models would send the router down
  // the "no provider configured" path, where the real fault — a broken data
  // file — is invisible.
  parsed ??= Catalog.parse(catalogJson);
  return parsed;
}

export function readCatalog(now: Date = new Date()): CatalogView {
  const source = catalog();
  const choices = source.models.map((model) => toChoice(model, now));

  const free = rankByCoding(choices.filter((model) => model.free));
  const paid = rankByCoding(choices.filter((model) => !model.free));
  const models = [...free, ...paid];

  const ageDays = (now.getTime() - new Date(source.syncedAt).getTime()) / DAY_MS;

  return {
    models,
    summary: {
      source: source.source,
      syncedAt: source.syncedAt,
      stale: ageDays > STALENESS_THRESHOLD_DAYS,
      ageDays,
      thresholdDays: STALENESS_THRESHOLD_DAYS,
      catalogTotal: source.catalogTotal,
      freeCount: free.length,
      eligibleCount: models.filter((model) => model.eligible).length,
      excluded: source.excluded.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        detail: entry.detail,
      })),
    },
  };
}
