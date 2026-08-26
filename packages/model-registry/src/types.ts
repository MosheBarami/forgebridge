import { z } from 'zod';

/**
 * The shape of `data/catalog.json` — the synced snapshot ADR-007 makes the only
 * defensible answer to "what models exist and what do they cost".
 *
 * These schemas are the gate the sync script writes through and the registry
 * reads back. A malformed catalog fails at load, loudly, rather than halfway
 * through a run when a price turns out to be a string.
 *
 * TODO(M08): `catalog.json` points `$schema` at `../schema/catalog.schema.json`,
 * which does not exist yet. M08 generates JSON Schema from the Zod definitions
 * in CI; whoever lands M08 must emit that file from `Catalog` below rather than
 * hand-writing it, or the two drift.
 */

const usd = z.number().finite().nonnegative();

/**
 * Capabilities are a closed set: the router branches on them, and "whatever
 * string the provider used this week" is not branchable. The sync script maps
 * each provider's own flags onto these names, so an unrecognised provider flag
 * is dropped at sync time instead of reaching the catalog as a surprise.
 */
export const Capability = z.enum([
  'tools',
  'tool_choice',
  'structured_outputs',
  'response_format',
  'reasoning',
  'vision',
  'audio',
  'video',
]);
export type Capability = z.infer<typeof Capability>;

/**
 * Modalities and billing units stay open strings, unlike capabilities.
 *
 * A capability we do not recognise is merely one the router will never ask for.
 * A billing *unit* we do not recognise is money we cannot account for — so the
 * set stays open and `deriveFree` fails closed on anything that is not `token`.
 * Closing this enum would turn a unit nobody has seen before into either a parse
 * crash across the whole catalog or, far worse, a silent `free: true`.
 */
export const Modality = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'modality must be a lowercase token');
export type Modality = z.infer<typeof Modality>;

export const TEXT_MODALITY = 'text';
export const TOKEN_UNIT = 'token';

/**
 * Provider ids are open for the same reason the catalog is data: a new provider
 * arrives through a sync, not through an edit to this package. A closed enum
 * would make the registry the bottleneck on adding one, which is the coupling
 * ADR-007 exists to remove.
 */
export const ProviderId = z.string().regex(/^[a-z][a-z0-9-]*$/, 'provider id must be a lowercase slug');
export type ProviderId = z.infer<typeof ProviderId>;

export const Pricing = z.object({
  /** USD per million input tokens. */
  inputPerMTok: usd,
  /** USD per million output tokens. */
  outputPerMTok: usd,
  /**
   * What the provider actually bills by. `token` is the only unit for which the
   * two rates above are the whole price — see `deriveFree`, and the Lyria
   * counterexample it is pinned against.
   */
  unit: z.string().min(1),
  /** USD per `unit`, when the unit is not tokens. Null when the provider did not report one. */
  perUnitUsd: usd.nullish(),
});
export type Pricing = z.infer<typeof Pricing>;

/**
 * Published benchmark scores, each independently nullable: a provider may score
 * a model on coding and not on agentic use. Null means *unmeasured*, and every
 * consumer has to keep that distinct from zero.
 */
export const Benchmarks = z.object({
  intelligence: z.number().finite().nullable(),
  coding: z.number().finite().nullable(),
  agentic: z.number().finite().nullable(),
});
export type Benchmarks = z.infer<typeof Benchmarks>;

/** The benchmark axes a caller may rank by. Closed — each maps to a field above. */
export const RankBy = z.enum(['coding', 'intelligence', 'agentic']);
export type RankBy = z.infer<typeof RankBy>;

/**
 * `YYYY-MM-DD` or a full ISO timestamp. Validated here so that by the time
 * `deriveFree` reads it, an unparseable date is already impossible — an expiry
 * we silently failed to parse is a model that vanishes mid-run with no warning.
 */
export const ExpiryDate = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'unparseable expiry date');

export const CatalogModel = z.object({
  /**
   * The provider's model id, verbatim and never normalised. The `:free` suffix
   * is part of the id, not decoration — see `ModelRegistry.byId`.
   */
  id: z.string().min(1),
  provider: ProviderId,
  /** Who made the model, as distinct from who serves it. */
  author: z.string().min(1),
  displayName: z.string().min(1),
  contextTokens: z.number().int().positive(),
  maxCompletionTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(Modality).min(1),
  outputModalities: z.array(Modality).min(1),
  capabilities: z.array(Capability),
  pricing: Pricing,
  /**
   * Derived at sync time, and re-derived by the registry on every read. Treat it
   * as a cache of `deriveFree`, never as an assertion to be trusted.
   */
  free: z.boolean(),
  /** Why `free` holds the value it does, in words a user can be shown. */
  freeReason: z.string().min(1),
  benchmarks: Benchmarks.nullable(),
  moderated: z.boolean(),
  expiresAt: ExpiryDate.nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

/**
 * A model the sync saw and deliberately left out, with the reason recorded.
 *
 * Exclusions are catalogued rather than dropped because "it is not in the list"
 * and "we looked at it and it charges $0.08 a song" are different facts, and only
 * the second one survives someone asking why their favourite model is missing.
 * `reason` is an open string: the sync may learn to distinguish new grounds for
 * exclusion without a lockstep change here.
 */
export const ExcludedModel = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  detail: z.string().min(1),
});
export type ExcludedModel = z.infer<typeof ExcludedModel>;

export const Catalog = z.object({
  $schema: z.string().optional(),
  /** The script that produced this file, so a reader knows what to re-run. */
  generator: z.string().min(1),
  /** What was actually read — the provenance behind every price below. */
  source: z.string().min(1),
  syncedAt: z.string().datetime(),
  /**
   * How many models the provider listed in total, including every one that did
   * not survive derivation. It is the denominator: without it, "16 free models"
   * is a number with nothing behind it, and a sync that silently truncated its
   * result set would look identical to one that did not.
   */
  catalogTotal: z.number().int().nonnegative(),
  note: z.string().optional(),
  models: z.array(CatalogModel),
  excluded: z.array(ExcludedModel),
});
export type Catalog = z.infer<typeof Catalog>;

/**
 * A provider summarised from the models actually present in the catalog. Counted,
 * never declared: a hand-written provider list is the same staleness trap as a
 * hand-written model list.
 */
export const ProviderInfo = z.object({
  id: ProviderId,
  /** The catalog's own `source` — what was read to produce these entries. */
  source: z.string().min(1),
  modelCount: z.number().int().nonnegative(),
  freeCount: z.number().int().nonnegative(),
  /** Distinct model authors reached through this provider, in catalog order. */
  authors: z.array(z.string().min(1)),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;
