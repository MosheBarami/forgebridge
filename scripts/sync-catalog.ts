/**
 * Regenerates `packages/model-registry/data/catalog.json` from the live OpenRouter
 * catalog. ADR-007: the registry is synced data, and `free` is derived, never asserted.
 *
 *   npm run sync:catalog             rewrite the snapshot
 *   npm run sync:catalog -- --check  exit 1 if the snapshot is stale
 *
 * `--check` is run by the weekly drift workflow (.github/workflows/catalog-drift.yml),
 * NOT by pull-request CI. That is deliberate: upstream can change at any hour, and a PR
 * that fails because a third party withdrew a model is a PR blocked on something its
 * author cannot fix. Staleness is surfaced as a reviewable PR, not as a red build.
 *
 * The cost of that choice, stated plainly: between weekly runs the committed snapshot can
 * be behind. It has already happened once — the catalog total moved 417 -> 416 within a
 * day of the first sync. `verifiedAt` on every entry is what lets a reader tell.
 *
 * Two properties matter more here than anything else:
 *
 * 1. It must read the WHOLE catalog. The incident behind ADR-007 was a catalog check
 *    that read a truncated result set and reported two live models as absent, with
 *    complete confidence. Every exit path below either proves the fetch was complete
 *    or fails loudly; none of them publishes a partial catalog.
 * 2. A run with no upstream change must produce a ZERO diff. The weekly drift PR (M21)
 *    is only worth reading if a diff means something actually changed; a file that
 *    churns on every run trains reviewers to skim it, which is how a model silently
 *    disappearing gets merged.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The free-derivation rule lives in exactly one place. A second copy here would drift
// from it, and defending the word "free" is the entire point of ADR-007 - see the
// google/lyria counterexample the rule exists for.
//
// `deriveFree` judges a catalog row, not a raw OpenRouter payload: it wants the two
// token rates already converted to USD per million, the billing unit named, and any
// non-token charge quantified. `toDerivable` below does that conversion, and it does it
// with the same readers `buildEntry` uses - so the verdict describes exactly the numbers
// that get written into the file next to it, rather than a parallel reading of them.
//
// `reason` is stored verbatim as `freeReason` - e.g. "token-priced at 0 in/out; text output".
import { deriveFree, type DerivableModel } from '../packages/model-registry/src/derive.js';
// The schema the registry validates this file against on load. Imported so the script
// cannot publish a snapshot its only consumer refuses to read.
import { Catalog as CatalogSchema } from '../packages/model-registry/src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(HERE, '../packages/model-registry/data/catalog.json');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Fixed header fields. They are part of the file's contract; do not reword them casually. */
const CATALOG_HEADER = {
  // TODO(M08): this schema file does not exist yet. `packages/model-registry/schema/catalog.schema.json`
  // must be generated from the Zod definitions in `packages/model-registry/src/types.ts`
  // (see the matching TODO there) rather than hand-written, or the two drift.
  $schema: '../schema/catalog.schema.json',
  generator: 'scripts/sync-catalog.ts',
  source: 'OpenRouter model catalog (live)',
  note: 'Generated. Do not hand-edit — run `npm run sync:catalog`. `free` is DERIVED (see freeReason), never asserted.',
  benchmarkSource:
    'Artificial Analysis indices (intelligence/coding/agentic) as reported inside the OpenRouter '
    + 'catalog payload per model. Recorded so a ranking can be traced to a source rather than '
    + 'appearing as an unattributed number; see TODO(M20).',
} as const;

/**
 * The `supported_parameters` values that decide whether a model can drive the pipeline,
 * in a fixed order so the rendered array is byte-stable. Everything else OpenRouter
 * reports (temperature, seed, penalties) is a knob rather than a capability and would
 * only add churn to the weekly diff.
 */
const CAPABILITY_PARAMETERS = [
  'tools',
  'tool_choice',
  'structured_outputs',
  'response_format',
  'reasoning',
] as const;

/** Without tool calling a model cannot drive a ChangeSet, however free it is. */
const REQUIRED_CAPABILITY = 'tools';

/** Models within this window of expiry are called out in the summary (ADR-007). */
const EXPIRY_WARNING_DAYS = 30;

/**
 * A catalog that suddenly lost a fifth of its models is far more likely to be a
 * truncated read than a real event - that is exactly the failure ADR-007 records.
 * Refuse to publish it without a human saying so.
 */
const SHRINK_REFUSAL_RATIO = 0.8;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
/** Guards the pager against an endpoint that reports a total it never satisfies. */
const MAX_PAGES = 100;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ExclusionReason = 'per-unit-pricing' | 'no-tool-calling';

export interface Benchmarks {
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
}

export interface CatalogEntry {
  id: string;
  provider: string;
  author: string;
  displayName: string;
  contextTokens: number | null;
  maxCompletionTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  capabilities: string[];
  pricing: { inputPerMTok: number; outputPerMTok: number; unit: string };
  free: boolean;
  freeReason: string;
  benchmarks: Benchmarks | null;
  moderated: boolean;
  expiresAt: string | null;
}

export interface ExcludedEntry {
  id: string;
  reason: ExclusionReason;
  detail: string;
}

export interface Catalog {
  catalogTotal: number;
  models: CatalogEntry[];
  excluded: ExcludedEntry[];
}

type RawModel = Record<string, unknown>;

class SyncError extends Error {}

// ---------------------------------------------------------------------------
// Small readers. The catalog is a remote payload, so nothing is assumed present.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * The models endpoint is public; the key is sent only so an authenticated account's
 * view of the catalog is what gets published. It is read from the environment, never
 * echoed into an error message, a log line, or the generated file.
 */
async function fetchPage(url: string, apiKey: string | undefined): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'forgebridge-sync-catalog',
  };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  let lastFailure = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return asRecord(await response.json());

      // A 4xx is a contract problem - a bad key, a moved endpoint. Retrying only
      // delays a failure a human has to read anyway.
      lastFailure = `HTTP ${response.status} ${response.statusText}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < MAX_ATTEMPTS) await delay(500 * 2 ** (attempt - 1));
  }
  throw new SyncError(`GET ${url} failed after ${MAX_ATTEMPTS} attempt(s): ${lastFailure}`);
}

/**
 * The number of models the endpoint claims exist, if it says at all. A single-envelope
 * catalog reports nothing, which is why the shrink guard below also exists.
 */
export function readReportedTotal(envelope: Record<string, unknown>): number | null {
  const meta = asRecord(envelope['meta']);
  for (const candidate of [envelope['total'], envelope['total_count'], meta['total'], meta['total_count']]) {
    const value = asFiniteNumber(candidate);
    if (value !== null && value >= 0) return Math.trunc(value);
  }
  return null;
}

/**
 * Reads every model in the catalog, or throws.
 *
 * OpenRouter answers this endpoint in a single envelope today, so the loop usually
 * runs exactly once. It exists anyway because a reader that assumes one page is
 * indistinguishable from the truncated read in ADR-007 right up to the moment it
 * reports live models as gone. If the endpoint ever starts paging, this either
 * follows it or fails; it does not quietly return page one.
 */
export async function fetchFullCatalog(apiKey: string | undefined): Promise<RawModel[]> {
  const collected = new Map<string, RawModel>();
  let reportedTotal: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      collected.size === 0 ? OPENROUTER_MODELS_URL : `${OPENROUTER_MODELS_URL}?offset=${collected.size}`;
    const envelope = await fetchPage(url, apiKey);

    const data = envelope['data'];
    if (!Array.isArray(data)) {
      throw new SyncError(`${url} returned no "data" array - the catalog endpoint's shape changed.`);
    }

    const pageTotal = readReportedTotal(envelope);
    if (pageTotal !== null) {
      if (reportedTotal !== null && pageTotal !== reportedTotal) {
        throw new SyncError(
          `The catalog changed size mid-read (${reportedTotal} then ${pageTotal}). Re-run the sync.`,
        );
      }
      reportedTotal = pageTotal;
    }

    let addedThisPage = 0;
    for (const item of data) {
      const record = asRecord(item);
      const id = asString(record['id']);
      if (!id) throw new SyncError(`${url} returned a model with no "id".`);
      if (!collected.has(id)) {
        collected.set(id, record);
        addedThisPage++;
      }
    }

    if (data.length === 0) break;
    // Nothing in the envelope claims there is more, so there is no page to ask for.
    if (reportedTotal === null) break;
    if (collected.size >= reportedTotal) break;
    if (addedThisPage === 0) {
      throw new SyncError(
        `The endpoint reports ${reportedTotal} models, returned ${collected.size}, and ignored ?offset= ` +
          `- refusing to publish a truncated catalog.`,
      );
    }
  }

  if (collected.size === 0) throw new SyncError('The catalog came back empty.');
  if (reportedTotal !== null && collected.size !== reportedTotal) {
    throw new SyncError(
      `Fetched ${collected.size} models but the endpoint reports ${reportedTotal}. ` +
        `Refusing to publish an incomplete catalog.`,
    );
  }
  return [...collected.values()];
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * OpenRouter prices are USD per token as decimal strings. Multiplying by 1e6 in binary
 * floating point renders a $1.60/M model as 1.5999999999999999 (`0.0000016 * 1e6`), which
 * is both wrong on the page and pure noise in the weekly diff. Shift the decimal point in
 * the string instead, then parse once.
 */
export function perMillion(perToken: string): number {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(perToken.trim());
  if (!match) throw new SyncError(`Unparseable price: ${JSON.stringify(perToken)}`);

  const sign = match[1] === '-' ? '-' : '';
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? '';
  const exponent = match[4] ? Number(match[4]) : 0;
  if (intPart.length + fracPart.length === 0) {
    throw new SyncError(`Unparseable price: ${JSON.stringify(perToken)}`);
  }

  let digits = intPart + fracPart;
  let point = intPart.length + exponent + 6;
  if (point <= 0) {
    digits = '0'.repeat(1 - point) + digits;
    point = 1;
  }
  if (point >= digits.length) digits += '0'.repeat(point - digits.length);

  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(point).replace(/0+$/, '');
  const rendered = `${whole}${fraction ? `.${fraction}` : ''}`;
  // Avoid rendering "-0" for a negative zero price.
  return Number(rendered) === 0 ? 0 : Number(`${sign}${rendered}`);
}

function isZeroPrice(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

/** Only the string entries: the derivation rule reads raw decimal strings. */
function readPricing(raw: RawModel): Record<string, string> {
  const pricing: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(raw['pricing']))) {
    if (typeof value === 'string') pricing[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) pricing[key] = String(value);
  }
  return pricing;
}

/** Priced units other than tokens, non-zero - what makes a $0/M token price a lie. */
function nonTokenCharges(pricing: Record<string, string>): string[] {
  return Object.entries(pricing)
    .filter(([unit, price]) => unit !== 'prompt' && unit !== 'completion' && !isZeroPrice(price))
    .map(([unit, price]) => `$${price} per ${unit}`)
    .sort();
}

/**
 * The largest charge levied in something other than tokens, in USD, or null when there
 * is none. This is the number `deriveFree` refuses a token-priced model over: Lyria's
 * $0/M token rate is accurate and beside the point next to $0.08 a song.
 *
 * A non-token price that will not parse as a number is skipped rather than guessed at -
 * inventing a figure here would put a fabricated price in the reason shown to a user.
 * Such an entry still reaches the exclusion `detail` through `nonTokenCharges`, which
 * quotes the provider's string verbatim.
 */
function nonTokenChargeUsd(pricing: Record<string, string>): number | null {
  let highest: number | null = null;
  for (const [unit, price] of Object.entries(pricing)) {
    if (unit === 'prompt' || unit === 'completion') continue;
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (highest === null || value > highest) highest = value;
  }
  return highest;
}

/**
 * The raw payload as the free-derivation rule wants to see it.
 *
 * `perMillion` throws on a price string it cannot read. Here that is caught and reported
 * as "not free" rather than allowed to abort the whole sync: one malformed price should
 * cost the catalog one model, not all 400 of them. The direction of that failure matches
 * the rule's own - refusing to call a model free is recoverable, calling a paid one free
 * is not.
 */
export function toDerivable(raw: RawModel, pricing: Record<string, string>): DerivableModel | null {
  try {
    return {
      pricing: {
        inputPerMTok: perMillion(pricing['prompt'] ?? '0'),
        outputPerMTok: perMillion(pricing['completion'] ?? '0'),
        // OpenRouter quotes prompt and completion per token; anything else it charges
        // for arrives as a separate key and is carried in `perUnitUsd`.
        unit: 'token',
        perUnitUsd: nonTokenChargeUsd(pricing),
      },
      outputModalities: asStringArray(asRecord(raw['architecture'])['output_modalities']),
      expiresAt: readExpiry(raw),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function readCapabilities(raw: RawModel): string[] {
  const supported = new Set(asStringArray(raw['supported_parameters']));
  return CAPABILITY_PARAMETERS.filter((parameter) => supported.has(parameter));
}

/** OpenRouter ids are `author/slug[:tier]`; `:free` is a distinct tier, not a suffix (ADR-007). */
function readAuthor(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : id;
}

function readExpiry(raw: RawModel): string | null {
  const value = asString(raw['expiration_date']);
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Benchmarks are not in the payload this script reads, so they are carried forward from
 * the committed catalog by id and are null for a model appearing for the first time.
 *
 * TODO(M20): whoever owns the benchmark source must add the fetch here. The source and
 * its field names are not documented anywhere in this repo, and a guessed field name
 * would silently produce nulls forever - so this script does not guess.
 */
function buildEntry(raw: RawModel, freeReason: string, benchmarks: Benchmarks | null): CatalogEntry {
  const id = asString(raw['id']) ?? '';
  const architecture = asRecord(raw['architecture']);
  const topProvider = asRecord(raw['top_provider']);
  const pricing = readPricing(raw);

  // Key order is part of the file's contract - see the committed catalog.json.
  return {
    id,
    provider: 'openrouter',
    author: readAuthor(id),
    displayName: asString(raw['name']) ?? id,
    contextTokens: asFiniteNumber(raw['context_length']),
    maxCompletionTokens: asFiniteNumber(topProvider['max_completion_tokens']),
    inputModalities: asStringArray(architecture['input_modalities']),
    outputModalities: asStringArray(architecture['output_modalities']),
    capabilities: readCapabilities(raw),
    pricing: {
      inputPerMTok: perMillion(pricing['prompt'] ?? '0'),
      outputPerMTok: perMillion(pricing['completion'] ?? '0'),
      unit: 'token',
    },
    free: true,
    freeReason,
    benchmarks,
    moderated: topProvider['is_moderated'] === true,
    expiresAt: readExpiry(raw),
  };
}

/**
 * Splits the live catalog into the models ForgeBridge can offer as free and the ones a
 * naive `price === 0` check would have shipped by mistake.
 *
 * `excluded` is deliberately narrow: it holds the models that *look* free - zero token
 * price - and are not usable anyway. Ordinary paid models are not listed; they are not
 * a trap anyone needs warning about.
 *
 * Both clauses the naive check misses (a non-token charge, a non-text output modality)
 * have so far described the same models: media generators billed per unit. They share
 * one reason code, and `detail` names the specific observation.
 */
export function classifyModels(raws: RawModel[], previous: Catalog | null): Catalog {
  const carriedBenchmarks = new Map<string, Benchmarks | null>();
  for (const model of previous?.models ?? []) carriedBenchmarks.set(model.id, model.benchmarks);

  const carriedExclusions = new Map<string, ExcludedEntry>();
  for (const entry of previous?.excluded ?? []) carriedExclusions.set(entry.id, entry);

  const models: CatalogEntry[] = [];
  const excluded: ExcludedEntry[] = [];

  for (const raw of raws) {
    const id = asString(raw['id']);
    if (!id) continue;

    const pricing = readPricing(raw);
    const derivable = toDerivable(raw, pricing);
    const verdict =
      derivable === null
        ? { free: false, reason: 'the provider quoted a token price this script cannot read as a number' }
        : deriveFree(derivable);

    if (verdict.free) {
      if (readCapabilities(raw).includes(REQUIRED_CAPABILITY)) {
        models.push(buildEntry(raw, verdict.reason, carriedBenchmarks.get(id) ?? null));
      } else {
        excluded.push(
          keepEditorialDetail(carriedExclusions, {
            id,
            reason: 'no-tool-calling',
            detail: 'Free by the rule, but reports no tool-calling support. Cannot drive the ForgeBridge pipeline.',
          }),
        );
      }
      continue;
    }

    // The naive check: zero token price. Anything it would have accepted and the rule
    // rejected is the interesting case, and it gets a stated reason rather than a
    // silent drop.
    if (isZeroPrice(pricing['prompt']) && isZeroPrice(pricing['completion'])) {
      const charges = nonTokenCharges(pricing);
      const detail =
        charges.length > 0
          ? `Reports $0/M tokens but is billed ${charges.join(', ')}. Token price is not this model's price.`
          : `Reports $0/M tokens but the free-derivation rule rejects it: ${verdict.reason}.`;
      excluded.push(keepEditorialDetail(carriedExclusions, { id, reason: 'per-unit-pricing', detail }));
    }
  }

  return { catalogTotal: raws.length, models: orderModels(models), excluded: orderExcluded(excluded) };
}

/**
 * Exclusion `detail` is editorial. "$0.08 per generated song" came from a human reading
 * the provider's pricing page; no field in the payload says it. A detail a human already
 * wrote wins, as long as the id and the reason still agree - only a newly excluded model
 * gets a generated one.
 */
function keepEditorialDetail(previous: Map<string, ExcludedEntry>, generated: ExcludedEntry): ExcludedEntry {
  const existing = previous.get(generated.id);
  return existing && existing.reason === generated.reason
    ? { ...generated, detail: existing.detail }
    : generated;
}

/**
 * Best coding model first, unranked models last, ties broken by id. Deterministic
 * ordering is what makes "no upstream change" render as an empty diff.
 */
export function orderModels(models: CatalogEntry[]): CatalogEntry[] {
  return [...models].sort((a, b) => {
    const left = a.benchmarks?.coding ?? null;
    const right = b.benchmarks?.coding ?? null;
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function orderExcluded(excluded: ExcludedEntry[]): ExcludedEntry[] {
  return [...excluded].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One entry per line: this file is read as a diff far more often than as a document, and
 * a per-line entry makes "this model changed" a one-line change rather than a
 * fifteen-line block. `JSON.stringify` cannot produce that shape, so it is written here.
 */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

function renderArray(name: string, items: unknown[]): string {
  if (items.length === 0) return `  ${JSON.stringify(name)}: []`;
  return `  ${JSON.stringify(name)}: [\n${items.map((item) => `    ${inline(item)}`).join(',\n')}\n  ]`;
}

export function renderCatalog(catalog: Catalog, syncedAt: string): string {
  return (
    [
      '{',
      `  "$schema": ${JSON.stringify(CATALOG_HEADER.$schema)},`,
      `  "generator": ${JSON.stringify(CATALOG_HEADER.generator)},`,
      `  "source": ${JSON.stringify(CATALOG_HEADER.source)},`,
      `  "syncedAt": ${JSON.stringify(syncedAt)},`,
      `  "catalogTotal": ${catalog.catalogTotal},`,
      `  "note": ${JSON.stringify(CATALOG_HEADER.note)},`,
      `  "benchmarkSource": ${JSON.stringify(CATALOG_HEADER.benchmarkSource)},`,
      `${renderArray('models', catalog.models)},`,
      renderArray('excluded', catalog.excluded),
      '}',
    ].join('\n') + '\n'
  );
}

/**
 * Refuse to publish a snapshot `@forgebridge/model-registry` would refuse to load.
 *
 * The registry parses `catalog.json` through a Zod schema and throws on anything
 * malformed, deliberately: a registry that degraded to zero models would send every run
 * down the "no provider configured" path, where the real fault - a bad catalog - is
 * invisible. That failure belongs here, at the moment the file is produced and a human
 * is reading the output, not at run time in somebody else's process.
 *
 * Checked against a render rather than the in-memory object so that what is validated is
 * the bytes, including the header fields `renderCatalog` adds.
 */
function assertLoadable(catalog: Catalog): void {
  const parsed = CatalogSchema.safeParse(JSON.parse(renderCatalog(catalog, new Date().toISOString())));
  if (parsed.success) return;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new SyncError(
    `The synced catalog is not loadable by @forgebridge/model-registry:\n  ${issues.join('\n  ')}\n` +
      `Refusing to publish it. Fix scripts/sync-catalog.ts, or the schema in ` +
      `packages/model-registry/src/types.ts if the provider's shape genuinely changed.`,
  );
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface Drift {
  added: string[];
  removed: string[];
  priceChanged: string[];
  capabilityChanged: string[];
  otherChanged: string[];
  excludedAdded: string[];
  excludedRemoved: string[];
  totalChanged: string | null;
  reordered: boolean;
}

function samePricing(a: CatalogEntry, b: CatalogEntry): boolean {
  return (
    a.pricing.inputPerMTok === b.pricing.inputPerMTok &&
    a.pricing.outputPerMTok === b.pricing.outputPerMTok &&
    a.pricing.unit === b.pricing.unit
  );
}

/**
 * Every live model's token price, keyed by id, used only to explain why a model left the
 * list. A price this script cannot parse is fatal for a model it publishes and merely
 * unquotable for one it is reporting on, so this reader never throws.
 */
export function livePriceIndex(raws: RawModel[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const raw of raws) {
    const id = asString(raw['id']);
    if (!id) continue;
    const pricing = readPricing(raw);
    try {
      const input = perMillion(pricing['prompt'] ?? '0');
      const output = perMillion(pricing['completion'] ?? '0');
      index.set(id, `$${input}/$${output} per M token`);
    } catch {
      index.set(id, 'price unreadable');
    }
  }
  return index;
}

export function diffCatalogs(previous: Catalog | null, next: Catalog, live?: Map<string, string>): Drift {
  const before = new Map((previous?.models ?? []).map((model) => [model.id, model]));
  const after = new Map(next.models.map((model) => [model.id, model]));

  // "Withdrawn" and "no longer free" are very different events and the weekly PR has to
  // let a reviewer tell them apart at a glance - a price that moved off zero is the one
  // that would otherwise have quietly started charging someone.
  const explainRemoval = (id: string): string => {
    if (!live) return id;
    const price = live.get(id);
    if (price === undefined) return `${id} (gone from the live catalog)`;
    const excludedNow = next.excluded.find((entry) => entry.id === id);
    if (excludedNow) return `${id} (still listed, now excluded: ${excludedNow.reason})`;
    return `${id} (still listed, no longer free: ${price})`;
  };

  const drift: Drift = {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)).map(explainRemoval),
    priceChanged: [],
    capabilityChanged: [],
    otherChanged: [],
    excludedAdded: [],
    excludedRemoved: [],
    totalChanged:
      previous && previous.catalogTotal !== next.catalogTotal
        ? `${previous.catalogTotal} -> ${next.catalogTotal}`
        : null,
    reordered: false,
  };

  for (const [id, entry] of after) {
    const old = before.get(id);
    if (!old) continue;

    if (!samePricing(old, entry)) {
      drift.priceChanged.push(
        `${id}: $${old.pricing.inputPerMTok}/$${old.pricing.outputPerMTok} -> ` +
          `$${entry.pricing.inputPerMTok}/$${entry.pricing.outputPerMTok} per M ${entry.pricing.unit}`,
      );
    }

    // Modalities are capability facts too: a model that stopped accepting images is as
    // much a routing change as one that stopped supporting tools.
    const capabilityFields: Array<keyof CatalogEntry> = ['capabilities', 'inputModalities', 'outputModalities'];
    const capabilityDelta = capabilityFields.filter((field) => inline(old[field]) !== inline(entry[field]));
    if (capabilityDelta.length > 0) {
      drift.capabilityChanged.push(
        `${id}: ${capabilityDelta
          .map((field) => `${String(field)} ${inline(old[field])} -> ${inline(entry[field])}`)
          .join('; ')}`,
      );
    }

    const otherFields: Array<keyof CatalogEntry> = [
      'displayName',
      'contextTokens',
      'maxCompletionTokens',
      'free',
      'freeReason',
      'benchmarks',
      'moderated',
      'expiresAt',
    ];
    const otherDelta = otherFields.filter((field) => inline(old[field]) !== inline(entry[field]));
    if (otherDelta.length > 0) {
      drift.otherChanged.push(`${id}: ${otherDelta.map((field) => String(field)).join(', ')}`);
    }
  }

  const excludedBefore = new Map((previous?.excluded ?? []).map((entry) => [entry.id, entry]));
  const excludedAfter = new Map(next.excluded.map((entry) => [entry.id, entry]));
  for (const [id, entry] of excludedAfter) {
    const old = excludedBefore.get(id);
    if (!old) drift.excludedAdded.push(`${id} (${entry.reason})`);
    else if (old.reason !== entry.reason) drift.excludedAdded.push(`${id} (${old.reason} -> ${entry.reason})`);
  }
  for (const id of excludedBefore.keys()) {
    if (!excludedAfter.has(id)) drift.excludedRemoved.push(id);
  }

  if (previous) {
    const beforeOrder = previous.models.map((model) => model.id).join(' ');
    const afterOrder = next.models.map((model) => model.id).join(' ');
    drift.reordered = drift.added.length === 0 && drift.removed.length === 0 && beforeOrder !== afterOrder;
  }

  return drift;
}

function describeDrift(drift: Drift): string[] {
  const lines: string[] = [];
  const section = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`  ${label} (${items.length}):`);
    for (const item of items) lines.push(`    - ${item}`);
  };

  if (drift.totalChanged) lines.push(`  catalog size: ${drift.totalChanged}`);
  section('added', drift.added);
  section('removed', drift.removed);
  section('price changed', drift.priceChanged);
  section('capability changed', drift.capabilityChanged);
  section('other fields changed', drift.otherChanged);
  section('newly excluded', drift.excludedAdded);
  section('no longer excluded', drift.excludedRemoved);
  if (drift.reordered) lines.push('  ordering changed (same models, different rank)');
  return lines;
}

// ---------------------------------------------------------------------------
// Reading the committed snapshot
// ---------------------------------------------------------------------------

interface Snapshot {
  raw: string;
  syncedAt: string;
  catalog: Catalog;
}

async function readSnapshot(): Promise<Snapshot | null> {
  let raw: string;
  try {
    raw = await readFile(CATALOG_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const parsed = asRecord(JSON.parse(raw));
  return {
    raw,
    syncedAt: asString(parsed['syncedAt']) ?? '',
    catalog: {
      catalogTotal: asFiniteNumber(parsed['catalogTotal']) ?? 0,
      models: (Array.isArray(parsed['models']) ? parsed['models'] : []) as CatalogEntry[],
      excluded: (Array.isArray(parsed['excluded']) ? parsed['excluded'] : []) as ExcludedEntry[],
    },
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function daysUntil(date: string, now: Date): number | null {
  const expiry = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(expiry)) return null;
  return Math.ceil((expiry - now.getTime()) / 86_400_000);
}

function summarise(catalog: Catalog, now: Date): string[] {
  const byReason = new Map<ExclusionReason, number>();
  for (const entry of catalog.excluded) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);

  const lines = [
    `${catalog.catalogTotal} models in the live catalog | ${catalog.models.length} free and tool-capable | ` +
      `${catalog.excluded.length} excluded`,
  ];
  if (byReason.size > 0) {
    lines.push(`  excluded: ${[...byReason].map(([reason, count]) => `${count} ${reason}`).join(', ')}`);
  }

  const expiring = catalog.models
    .map((model) => ({ model, days: model.expiresAt ? daysUntil(model.expiresAt, now) : null }))
    .filter((row): row is { model: CatalogEntry; days: number } => row.days !== null && row.days <= EXPIRY_WARNING_DAYS)
    .sort((a, b) => a.days - b.days);

  if (expiring.length === 0) {
    lines.push(`  no listed model expires within ${EXPIRY_WARNING_DAYS} days`);
  } else {
    lines.push(`  expiring within ${EXPIRY_WARNING_DAYS} days (${expiring.length}):`);
    for (const row of expiring) {
      lines.push(`    - ${row.model.id} on ${row.model.expiresAt} (${row.days} day(s))`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Usage: npm run sync:catalog [-- --check] [--allow-shrink]

  --check         Do not write. Exit 1 if the committed catalog differs from a fresh
                  sync, printing what changed. This is what CI runs.
  --allow-shrink  Publish even if the catalog lost more than ${Math.round(
    (1 - SHRINK_REFUSAL_RATIO) * 100,
  )}% of its models,
                  which otherwise reads as a truncated fetch and is refused.

  Reads OPENROUTER_API_KEY from the environment when present. The key is never logged
  and never written to disk.`;

interface Options {
  check: boolean;
  allowShrink: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false, allowShrink: false };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg === '--allow-shrink') options.allowShrink = true;
    // An unrecognised flag must fail. Silently ignoring a mistyped `--check` would
    // leave CI running a sync that can never fail.
    else throw new SyncError(`Unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return options;
}

async function run(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const previous = await readSnapshot();

  if (options.check && !previous) {
    process.stderr.write(`${CATALOG_PATH} does not exist. Run \`npm run sync:catalog\` to create it.\n`);
    return 1;
  }

  const raws = await fetchFullCatalog(process.env['OPENROUTER_API_KEY']);

  if (previous && previous.catalog.catalogTotal > 0 && !options.allowShrink) {
    if (raws.length < previous.catalog.catalogTotal * SHRINK_REFUSAL_RATIO) {
      throw new SyncError(
        `The catalog reports ${raws.length} models, down from ${previous.catalog.catalogTotal}. ` +
          `That is more likely a truncated read than a real event (ADR-007). ` +
          `Re-run; pass --allow-shrink if the drop is genuine.`,
      );
    }
  }

  const catalog = classifyModels(raws, previous?.catalog ?? null);
  assertLoadable(catalog);

  // Rendered with the *previous* stamp, so the comparison is about the catalog and not
  // about the clock. Nothing changed means nothing is written, which is what makes a
  // quiet week show up as an empty diff instead of a one-line timestamp PR.
  const unchanged = previous !== null && renderCatalog(catalog, previous.syncedAt) === previous.raw;

  for (const line of summarise(catalog, new Date())) process.stdout.write(`${line}\n`);

  if (unchanged) {
    process.stdout.write(`\nNo change: ${CATALOG_PATH} is current.\n`);
    return 0;
  }

  const drift = describeDrift(diffCatalogs(previous?.catalog ?? null, catalog, livePriceIndex(raws)));

  if (options.check) {
    process.stderr.write('\nThe committed catalog is out of date:\n');
    for (const line of drift) process.stderr.write(`${line}\n`);
    // A header field or the formatting moved without any entry changing.
    if (drift.length === 0) process.stderr.write('  formatting or header fields differ\n');
    process.stderr.write('\nRun `npm run sync:catalog` and commit the result.\n');
    return 1;
  }

  await writeFile(CATALOG_PATH, renderCatalog(catalog, new Date().toISOString()), 'utf8');
  process.stdout.write(`\nWrote ${CATALOG_PATH}\n`);
  for (const line of drift) process.stdout.write(`${line}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      // 1 is "the catalog is wrong"; 2 is "this script broke".
      process.exitCode = error instanceof SyncError ? 1 : 2;
    });
}
