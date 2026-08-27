import { z } from 'zod';
import { Capability } from './types.js';

/**
 * Locally-served models (M24), and why they are a separate shape from a catalog
 * row rather than a catalog row with zeros in it.
 *
 * `derive.ts` carries the reason in as many words: a local model is free because
 * there is no bill at all, not because a reported price is zero. Feeding one
 * through `deriveFree` would mean first synthesising a `Pricing` nobody
 * published — `{ inputPerMTok: 0, outputPerMTok: 0, unit: 'token' }` — and then
 * deriving "free" from the zeros we ourselves wrote. That is an asserted claim
 * wearing a derivation's clothes, which is the one thing ADR-007 exists to
 * prevent. So a local model has no `pricing` field to read, and
 * `LOCAL_FREE_REASON` states the actual ground.
 *
 * Everything here describes what a runtime *reported*. Nothing is filled in:
 *
 *   - `contextTokens` is null when the runtime did not report a context window.
 *     Null is not a small number; see `UNKNOWN_CONTEXT_TOKENS` for what the
 *     router is handed instead and what that costs.
 *   - `capabilities` is empty when the runtime did not report capabilities.
 *     Empty means *unknown*, and unknown fails closed: driving a ChangeSet needs
 *     `tools`, so a model with no reported capabilities is filtered out by the
 *     router rather than tried and then blamed for failing.
 *
 * The discovery itself — which ports are probed, what each runtime answers, and
 * how a probe that finds nothing stays silent — belongs to the daemon, in
 * `packages/daemon/src/providers/local.ts`. This package holds the shape and the
 * projections, so a locally discovered model is described in exactly one place
 * whatever discovered it.
 */

/**
 * The runtimes M24 names. Closed, unlike `ProviderId` in `types.ts`: a synced
 * catalog gains providers through a sync, but a *probe* gains a runtime only
 * when someone writes the code that knows its port and its endpoint — so an
 * unrecognised runtime slug here is a bug rather than news from upstream.
 *
 * These strings are provider ids in the router's sense: they key the circuit
 * breaker and land in `ModelAttempt.providerSlug`. Each is a valid `ProviderId`
 * (`^[a-z][a-z0-9-]*$`), so a local model and a catalogued one are namespaced
 * the same way and cannot collide by accident.
 */
export const LOCAL_RUNTIMES = ['ollama', 'lmstudio', 'llamacpp', 'vllm'] as const;
export type LocalRuntime = (typeof LOCAL_RUNTIMES)[number];

export const LocalRuntimeId = z.enum(LOCAL_RUNTIMES);

/**
 * Why a local model is free, in words a user can be shown.
 *
 * Deliberately not the catalog's `FREE_REASON` ("token-priced at 0 in/out"),
 * which would be false here: nothing published a token price at all.
 */
export const LOCAL_FREE_REASON = 'served by a local runtime; no provider bills for it';

/**
 * What a local model's context window becomes when the runtime did not report
 * one, at the point where the router demands a number.
 *
 * Zero, and chosen for its effect: `RoutingRequirements.minContextTokens` is a
 * `>=` test, so a model whose window nobody stated is filtered out by any run
 * that states a minimum, and is offered only to a run that asked for no
 * particular window. That is the fail-closed direction — the alternative is
 * inventing a plausible 8192, which would route a prompt into a model that may
 * truncate it and then record the truncation as the model's failure.
 *
 * The snapshot keeps the honest value: `localSnapshotRow` emits `contextTokens:
 * null`, so a selector shows "unknown" rather than "0".
 */
export const UNKNOWN_CONTEXT_TOKENS = 0;

export const LocalModel = z.object({
  /** The id the runtime answers to, verbatim — it is what goes back in `model`. */
  id: z.string().min(1),
  provider: LocalRuntimeId,
  displayName: z.string().min(1),
  /**
   * The OpenAI-compatible base URL this model was found on, without a trailing
   * slash — `http://127.0.0.1:11434/v1`. Recorded per model rather than per
   * runtime because it is the only thing that says where a request goes, and a
   * candidate that has travelled through the router carries no other address.
   *
   * A loopback URL is not a secret, and nothing else on this shape could be one:
   * local runtimes are reached without a credential.
   */
  endpoint: z.string().min(1),
  /** Null when the runtime did not report a context window. Never a guess. */
  contextTokens: z.number().int().positive().nullable(),
  /** Empty when the runtime reported none. Empty means unknown, and unknown routes nowhere. */
  capabilities: z.array(Capability),
  /** When the probe saw it. A local runtime can be stopped between two runs. */
  discoveredAt: z.string().datetime(),
});
export type LocalModel = z.infer<typeof LocalModel>;

/**
 * The router's `ModelCandidate`, satisfied structurally.
 *
 * `@forgebridge/core` is not a dependency of this package and must not become
 * one — the catalog is data, and data does not import an engine. `ModelCandidate`
 * is a structural interface for exactly this reason (see the comment on it in
 * `packages/core/src/router.ts`, which names M24), so an object with these fields
 * routes beside a catalogued one without either side importing the other.
 */
export interface LocalCandidate {
  id: string;
  provider: LocalRuntime;
  contextTokens: number;
  capabilities: readonly Capability[];
  free: boolean;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  expiresAt: null;
  expiringSoon: false;
}

/**
 * One local model as the router sees it.
 *
 * The zeroed `pricing` here is not a claim about a published price — it is the
 * router's required field, and the number is right: a run against a process on
 * this machine costs the user nothing per token. What matters is that no
 * *derivation* rests on it. `free` is true because the model is local, which is
 * what `LOCAL_FREE_REASON` says; nothing reads these zeros to decide it.
 */
export function localCandidate(model: LocalModel): LocalCandidate {
  return {
    id: model.id,
    provider: model.provider,
    contextTokens: model.contextTokens ?? UNKNOWN_CONTEXT_TOKENS,
    capabilities: model.capabilities,
    free: true,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    // A local model has no vendor to withdraw it. It is there until the runtime
    // stops, which the next probe reports rather than a date predicts.
    expiresAt: null,
    expiringSoon: false,
  };
}

/**
 * One local model as a `ModelsSnapshot` row.
 *
 * `pricing` is null and `local` is true, and both are load-bearing for whoever
 * renders this: M24's row asks for local models to appear "marked local, with no
 * pricing", and a row carrying `{ inputPerMTok: 0 }` would be rendered as the
 * price $0.00/M — a price, presented as observed, that no provider ever quoted.
 * Null is the value that makes a selector say nothing rather than say zero.
 */
export function localSnapshotRow(model: LocalModel): Record<string, unknown> {
  return {
    id: model.id,
    provider: model.provider,
    // Who serves it and who made it are the same answer for a local model, and
    // the catalog's `author` field has no better value available. Saying so is
    // more useful than an empty string that a UI renders as a missing name.
    author: model.provider,
    displayName: model.displayName,
    local: true,
    endpoint: model.endpoint,
    contextTokens: model.contextTokens,
    maxCompletionTokens: null,
    capabilities: model.capabilities,
    pricing: null,
    free: true,
    freeReason: LOCAL_FREE_REASON,
    benchmarks: null,
    expiresAt: null,
    discoveredAt: model.discoveredAt,
  };
}

/**
 * The capability names this package understands, mapped from whatever a runtime
 * called them.
 *
 * Only Ollama reports capabilities at all today (`POST /api/show` answers a
 * `capabilities` array — https://docs.ollama.com/api-reference/show-model-details).
 * Its vocabulary is open and includes entries that are not routing capabilities:
 * `completion` describes every text model. So this maps the ones that mean
 * something to the router and drops the rest. Dropping is the fail-closed
 * direction — an unrecognised string becomes an absent capability, never an
 * assumed one.
 */
const RUNTIME_CAPABILITY_NAMES: Readonly<Record<string, Capability>> = {
  tools: 'tools',
  vision: 'vision',
};

/** Runtime capability strings → the registry's closed vocabulary, unknown dropped. */
export function capabilitiesFromRuntime(reported: readonly unknown[]): Capability[] {
  const out: Capability[] = [];
  for (const raw of reported) {
    if (typeof raw !== 'string') continue;
    const mapped = RUNTIME_CAPABILITY_NAMES[raw.toLowerCase()];
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}
