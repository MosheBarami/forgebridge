import { DEFAULT_PIPELINE_REQUIREMENTS } from '@forgebridge/core';

// The catalog itself, and the one rule that decides what "free" means. Both are
// reached by path rather than through `@forgebridge/model-registry`'s package
// entry point, and the reason is a bundler constraint worth stating in full,
// because the obvious import looks correct and is not:
//
//   `packages/model-registry/src/registry.ts` computes, at module scope,
//   `CATALOG_PATH = fileURLToPath(new URL('../data/catalog.json', import.meta.url))`.
//   That is the right way for a Node package to find its own data file, and it
//   is exactly what a bundler cannot carry: webpack rewrites
//   `new URL(…, import.meta.url)` into an asset reference built from its own
//   URL implementation, and `node:url`'s `fileURLToPath` then rejects the result
//   with "Received an instance of URL". The package is named in
//   `serverExternalPackages` so it is required at runtime rather than bundled —
//   but whether a given module actually gets externalised was observed to depend
//   on how many other modules in the same build import it, so a page can build
//   today and stop building when an unrelated page is deleted.
//
// Importing only the two modules that have no `node:` dependency removes the
// question. `derive.js` imports `types.js`, which imports `zod`, and that is the
// whole graph — no filesystem, no `import.meta.url`, nothing that behaves
// differently bundled than it does under Node.
//
// What this does NOT do is re-implement anything. `deriveFree` below is the
// registry's own function, the one the daemon and the router call. ADR-007's
// rule — freeness is derived, never asserted, by one implementation — is intact;
// only the import specifier changed.
//
// TODO(M31): the fix is the registry's, not this app's. Either its package
// `exports` grows subpaths for its pure modules (`./derive`, `./types`), or
// `CATALOG_PATH` stops being computed at module scope — a lazy getter costs
// nothing and makes the entry point safe to bundle. Owner: the registry
// maintainer. Until then this comment is why a reviewer should not "tidy" these
// three specifiers back into a package import.
import catalogJson from '../../../../../packages/model-registry/data/catalog.json';
import { EXPIRING_SOON_DAYS, deriveFree } from '../../../../../packages/model-registry/dist/derive.js';
import { Catalog, type CatalogModel } from '../../../../../packages/model-registry/dist/types.js';

/**
 * The catalog as the **settings** surface asks about it.
 *
 * ── Why this is a second projection and not a reuse ────────────────────────
 *
 * `app/[locale]/generate/catalog.ts` also reads this catalog. That is not
 * duplication, because the two surfaces ask different questions of one source:
 * the generation selector asks *which model can drive this run* and answers
 * with pipeline eligibility. This one asks *what is in the catalog, how do I
 * know, and when does it stop being true* — so it carries provenance
 * (`verifiedAt`, and how old that is), the derivation reason behind every
 * `free`, expiry and its warning window, price, and the models the sync
 * deliberately left out.
 *
 * What must not be duplicated is the catalog and the rule, and neither is: the
 * file is the file, and `deriveFree` is the registry's own. There is no model
 * list in this app (ADR-007) and there must never be one — a hand-maintained
 * list is wrong within a week and nothing in the build would notice.
 *
 * ── Why the snapshot is validated on the way in ────────────────────────────
 *
 * `Catalog.parse` runs over the imported JSON. It is the registry's own schema,
 * so a catalog whose shape has moved on becomes a loud failure at the seam
 * rather than `undefined` reaching a component three renders later — the same
 * reason `lib/daemon/wire.ts` parses every daemon response.
 *
 * ── Why this is a server module ────────────────────────────────────────────
 *
 * The parse and the derivation run once, on the server, and the rows cross into
 * the browser as plain data. The catalog does not change between deploys, so
 * fetching it from the browser would be a round trip to learn something the
 * HTML already carried. What the *daemon's* registry says — which is what a run
 * would actually use — is a separate, client-side read of `/v1/models`; see
 * `models-browser.tsx`.
 */

/** Days-from-expiry at which a model is flagged. The registry's constant, not a literal here. */
export const EXPIRY_WARNING_DAYS = EXPIRING_SOON_DAYS;

const REQUIRED_CAPABILITIES: readonly string[] = DEFAULT_PIPELINE_REQUIREMENTS.capabilities ?? [];

/** Why a model is or is not usable for a run, as one closed value. */
export type ModelAvailability =
  /** Free, unexpired, and carrying every capability the pipeline needs. */
  | { readonly kind: 'ready' }
  /** Usable, but the provider has recorded a withdrawal date inside the warning window. */
  | { readonly kind: 'expiring'; readonly expiresAt: string; readonly daysLeft: number }
  /** The recorded expiry has passed. The router will not attempt it. */
  | { readonly kind: 'expired'; readonly expiresAt: string }
  /** Missing a capability the pipeline requires. Pinning it produces a failed run. */
  | { readonly kind: 'incapable'; readonly missing: readonly string[] };

export interface ModelRow {
  readonly id: string;
  readonly displayName: string;
  readonly author: string;
  readonly provider: string;
  readonly contextTokens: number;
  readonly capabilities: readonly string[];
  readonly inputModalities: readonly string[];
  /**
   * Re-derived by `deriveFree`, never read from the catalog's stored flag. The
   * flag is a cache the sync wrote; ADR-007's point is that freeness is derived
   * every time, including when the assertion being ignored is our own file's.
   */
  readonly free: boolean;
  /** The derivation's own words — what makes this free, or what makes it not. */
  readonly freeReason: string;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly availability: ModelAvailability;
  /** Null means unmeasured, and is never rendered as zero. */
  readonly benchmarks: {
    readonly intelligence: number | null;
    readonly coding: number | null;
    readonly agentic: number | null;
  };
  readonly moderated: boolean;
}

export interface CatalogProvenance {
  /** What was read to produce these rows. */
  readonly source: string;
  /**
   * The catalog's `syncedAt` — the "verifiedAt" stamp. Rendered as an absolute
   * timestamp, because "3 days ago" on a page a user leaves open overnight is a
   * relative claim that goes quietly wrong.
   */
  readonly verifiedAt: string;
  /**
   * Fractional days since `verifiedAt`, rounded by whoever displays it.
   *
   * There is no `stale` boolean here, and its absence is deliberate: the
   * threshold that would decide it (`STALENESS_THRESHOLD_DAYS`) lives in the
   * registry module this file cannot import, and inventing a second threshold
   * would be this app holding an opinion about catalog freshness that the
   * package owning the catalog does not know about. The daemon's `/v1/models`
   * already reports staleness in its `source` string, and the browser shows
   * that when a daemon is answering. See the TODO(M31) at the top of this file.
   */
  readonly ageDays: number;
  /** How many models the provider listed, before derivation dropped any. The denominator. */
  readonly catalogTotal: number;
  readonly freeCount: number;
  readonly readyCount: number;
  readonly expiringCount: number;
}

export interface ExcludedRow {
  readonly id: string;
  readonly reason: string;
  readonly detail: string;
}

export interface ModelCatalogView {
  readonly models: readonly ModelRow[];
  readonly provenance: CatalogProvenance;
  /** Models the sync saw and left out. Shown, because "absent" and "rejected, here is why" differ. */
  readonly excluded: readonly ExcludedRow[];
  /** The capabilities a run requires, from the core. Named so the UI can explain `incapable`. */
  readonly requiredCapabilities: readonly string[];
}

const DAY_MS = 86_400_000;

function availabilityOf(model: CatalogModel, now: Date): ModelAvailability {
  const derivation = deriveFree(model, now);

  // Expiry is checked before capability, because an expired model's missing
  // capability is not the fact that changed — the model is gone either way, and
  // reporting the lesser problem would send the reader looking for a fix that
  // does not exist.
  if (derivation.expired && model.expiresAt !== null) {
    return { kind: 'expired', expiresAt: model.expiresAt };
  }

  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !(model.capabilities as readonly string[]).includes(capability),
  );
  if (missing.length > 0) return { kind: 'incapable', missing };

  if (derivation.expiringSoon && model.expiresAt !== null) {
    const daysLeft = Math.max(0, Math.ceil((Date.parse(model.expiresAt) - now.getTime()) / DAY_MS));
    return { kind: 'expiring', expiresAt: model.expiresAt, daysLeft };
  }

  return { kind: 'ready' };
}

function toRow(model: CatalogModel, now: Date): ModelRow {
  const derivation = deriveFree(model, now);
  return {
    id: model.id,
    displayName: model.displayName,
    author: model.author,
    provider: model.provider,
    contextTokens: model.contextTokens,
    capabilities: model.capabilities,
    inputModalities: model.inputModalities,
    free: derivation.free,
    freeReason: derivation.reason,
    inputPerMTok: model.pricing.inputPerMTok,
    outputPerMTok: model.pricing.outputPerMTok,
    availability: availabilityOf(model, now),
    benchmarks: {
      intelligence: model.benchmarks?.intelligence ?? null,
      coding: model.benchmarks?.coding ?? null,
      agentic: model.benchmarks?.agentic ?? null,
    },
    moderated: model.moderated,
  };
}

/**
 * The shipped snapshot, parsed once per process.
 *
 * The JSON is immutable data compiled into this build, so re-parsing it per
 * request would buy nothing but CPU. `Catalog.parse` throwing here is the
 * intended behaviour rather than something to guard: a build carrying a catalog
 * this schema does not recognise has a packaging fault, and a page that quietly
 * degraded to zero models would hide it.
 */
let parsed: Catalog | undefined;
function snapshot(): Catalog {
  parsed ??= Catalog.parse(catalogJson);
  return parsed;
}

/**
 * The catalog, grouped free-first and otherwise left in catalog order.
 *
 * "Free first" matches the router's default policy, so what this page lists
 * first is what a run would try first — a settings page whose order
 * contradicted the router would teach a wrong model of the system to the exact
 * user who came here to learn how it works.
 *
 * Ordering *within* the two groups is deliberately not decided here. The
 * browser sorts by whichever benchmark axis the reader picks, and it is there
 * that the rule which matters is applied: an unmeasured axis sorts last rather
 * than as zero, because a model nobody measured is not a model that scored
 * badly. Doing it once, where the control is, keeps that rule in one place.
 */
export function readModelCatalog(now: Date = new Date()): ModelCatalogView {
  const catalog = snapshot();
  const rows = catalog.models.map((model) => toRow(model, now));
  const models = [...rows.filter((row) => row.free), ...rows.filter((row) => !row.free)];

  return {
    models,
    provenance: {
      source: catalog.source,
      verifiedAt: catalog.syncedAt,
      ageDays: (now.getTime() - Date.parse(catalog.syncedAt)) / DAY_MS,
      catalogTotal: catalog.catalogTotal,
      freeCount: models.filter((row) => row.free).length,
      readyCount: models.filter((row) => row.availability.kind === 'ready').length,
      expiringCount: models.filter((row) => row.availability.kind === 'expiring').length,
    },
    excluded: catalog.excluded.map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      detail: entry.detail,
    })),
    requiredCapabilities: REQUIRED_CAPABILITIES,
  };
}
