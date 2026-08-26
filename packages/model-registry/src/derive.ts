import { TEXT_MODALITY, TOKEN_UNIT } from './types.js';

/**
 * ADR-007's free-derivation rule.
 *
 *   free  ⟺  input tokens priced at 0
 *        AND output tokens priced at 0
 *        AND the model is token-priced (not per-request / per-image / per-song / per-clip)
 *        AND its output modality is text
 *
 * The last two clauses are not defensive padding. The first live sync of the
 * OpenRouter catalog returned 19 models at $0/M tokens, two of which —
 * `google/lyria-3-pro-preview` and `google/lyria-3-clip-preview` — genuinely
 * report a token price of zero and bill $0.08 per generated song and $0.04 per
 * 30-second clip. Their token price is not their price. A `price === 0` check
 * would have listed both as free, and the first user to pick one would have been
 * charged. `test/derive.test.ts` pins that exact pair.
 *
 * The direction of error is chosen deliberately: this rule will sometimes refuse
 * to call a genuinely free model free. That costs a listing. The opposite error
 * costs a user money they were promised they would not spend, which is the one
 * claim the whole product rests on (C1).
 *
 * A note on ids, since it changes what "the price" even refers to: OpenRouter's
 * `:free` suffix marks a *distinct, throttled tier*, not a variant of the paid
 * model. `z-ai/glm-5.2:free` and `z-ai/glm-5.2` are separate catalog entries with
 * separate endpoints and separate prices — the paid one's cheapest endpoint is
 * $0.4186/M input. Deriving freeness from the canonical slug's pricing, or
 * resolving one id to the other anywhere, misreports both price and availability.
 *
 * TODO(M24): locally-served models (Ollama, LM Studio, llama.cpp, vLLM) are free
 * because there is no bill at all, not because a reported price is zero. They
 * carry no provider pricing to derive from, so M24 must add an explicit local
 * path here rather than synthesising a zeroed `Pricing` — a synthesised zero is
 * exactly the kind of asserted-not-derived claim this file exists to prevent.
 */

const DAY_MS = 86_400_000;

/** A model within this many days of its expiry is flagged; the router deprioritises it. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * The reason recorded for every model that passes. A shared constant because the
 * sync script writes it into `freeReason` and the tests compare against it — two
 * copies of this string would drift and nobody would notice.
 */
export const FREE_REASON = 'token-priced at 0 in/out; text output';

/**
 * The least a value must carry to be judged. Structural rather than a Zod parse
 * so that both a `CatalogModel` and a half-built record inside the sync script
 * can be passed without either side owning the other's shape.
 */
export interface DerivableModel {
  pricing: {
    inputPerMTok: number;
    outputPerMTok: number;
    unit: string;
    perUnitUsd?: number | null;
  };
  outputModalities: readonly string[];
  expiresAt?: string | null;
}

export interface FreeDerivation {
  /** The four-clause rule above, and nothing else. */
  free: boolean;
  /** Why, in words that can be shown to a user. */
  reason: string;
  /** Expiry is within `EXPIRING_SOON_DAYS`. */
  expiringSoon: boolean;
  /** The recorded expiry has passed. */
  expired: boolean;
}

/**
 * Expiry is reported alongside `free`, not folded into it.
 *
 * `free` is a claim about price; expiry is a claim about availability. Collapsing
 * them would make `reason` lie — an expired model would report itself as "not
 * free", which is false and sends whoever reads it looking for a price that was
 * never the problem. Callers that need a usable model (see
 * `ModelRegistry.freeModels`) filter on both.
 */
export function deriveFree(model: DerivableModel, now: Date = new Date()): FreeDerivation {
  const expiry = parseExpiry(model.expiresAt);
  const msUntilExpiry = expiry === null ? null : expiry.getTime() - now.getTime();
  const expired = msUntilExpiry !== null && msUntilExpiry <= 0;
  const expiringSoon =
    msUntilExpiry !== null && msUntilExpiry > 0 && msUntilExpiry <= EXPIRING_SOON_DAYS * DAY_MS;

  const verdict = (free: boolean, reason: string): FreeDerivation => ({
    free,
    reason,
    expiringSoon,
    expired,
  });

  const { pricing } = model;

  // Checked before the token rates, because this is precisely the case where the
  // token rates are accurate and irrelevant.
  if (pricing.unit !== TOKEN_UNIT) {
    const rate = typeof pricing.perUnitUsd === 'number' ? `$${pricing.perUnitUsd} ` : '';
    return verdict(false, `billed ${rate}per ${pricing.unit}, not per token`);
  }

  // Token-priced *and* carrying a per-unit charge is contradictory input. Refuse
  // it rather than pick whichever half makes the model look cheaper.
  if (typeof pricing.perUnitUsd === 'number' && pricing.perUnitUsd > 0) {
    return verdict(false, `reports token pricing but also a $${pricing.perUnitUsd} per-unit charge`);
  }

  if (pricing.inputPerMTok !== 0 || pricing.outputPerMTok !== 0) {
    return verdict(
      false,
      `token-priced at $${pricing.inputPerMTok}/M in, $${pricing.outputPerMTok}/M out`,
    );
  }

  if (!outputsOnlyText(model.outputModalities)) {
    return verdict(
      false,
      `emits ${model.outputModalities.join('+')}, not text; token price is not the whole price`,
    );
  }

  return verdict(true, FREE_REASON);
}

/**
 * Text-only, not merely text-inclusive. A model that also emits audio, images or
 * video has an artefact to bill for, and that bill does not appear in the token
 * rates — which is the Lyria failure in general form.
 */
function outputsOnlyText(modalities: readonly string[]): boolean {
  return modalities.length > 0 && modalities.every((modality) => modality === TEXT_MODALITY);
}

/**
 * A date-only expiry (`2026-09-30`) parses as the *start* of that day in UTC, so
 * the model is treated as gone for the whole of its final date. Failing closed by
 * a few hours costs one routing candidate; failing open costs a run that dies
 * partway through against a model that no longer exists.
 *
 * An unparseable string reads as "no expiry recorded" — `ExpiryDate` in
 * `types.ts` is the gate that stops one ever reaching here from the catalog.
 */
function parseExpiry(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
