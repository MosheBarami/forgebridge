'use client';

import { useLocale } from '@/i18n/dictionary-context';
import { Code } from '@/components/ui/code';
import type { MechanicCard, PathScope, PlannedOperation } from './catalog';

/**
 * The pieces both the list and the detail view draw.
 *
 * Everything here is achromatic. A category is not a state of the bridge, so it
 * does not get a colour — DESIGN.md §1. Categories are told apart by their word,
 * which is also the only way a screen reader or a colour-blind reader could have
 * told them apart anyway.
 */

export function CategoryTag({ category }: { category: string }) {
  const { t } = useLocale();
  return (
    <span className="rounded-sm border border-rule bg-sunken px-2 py-0.5 text-[0.75rem] font-medium text-fg-muted">
      {t(`inventory.category.${category}`)}
    </span>
  );
}

/**
 * The path scope, as a table.
 *
 * A table rather than a bulleted list because there are two columns of meaning —
 * the path and what the recipe intends to do to it — and a list would force the
 * intent into a parenthetical that a screen reader reads as part of the path.
 *
 * Every path goes through `<Code>`, which is an explicit `dir="ltr"` island. That
 * is load-bearing under Hebrew: without it the bidi algorithm reorders the dots
 * in `ServerScriptService.ShopService` around the paragraph direction and shows
 * the reader a path the recipe does not name.
 */
export function ScopeTable({ scope }: { scope: readonly PathScope[] }) {
  const { t } = useLocale();

  return (
    <table className="w-full border-collapse text-[0.875rem]">
      <thead>
        <tr>
          <th scope="col" className="fb-label pb-2 text-start">
            {t('inventory.card.scopePath')}
          </th>
          <th scope="col" className="fb-label pb-2 text-start">
            {t('inventory.card.scopeIntent')}
          </th>
        </tr>
      </thead>
      <tbody>
        {scope.map((entry) => (
          <tr key={`${entry.path}:${entry.intent}`} className="border-t border-rule">
            <td className="py-2 pe-4 align-top">
              <Code>{entry.path}</Code>
            </td>
            <td className="py-2 align-top text-fg-muted">
              {t(`inventory.scopeIntent.${entry.intent}`)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What the recipe intends the run to produce.
 *
 * The heading above this table says "intends", and that word is doing real work:
 * a model can deviate, and the ChangeSet diff is the only account of what it
 * actually did. A plan rendered as a promise would be the same lie as a diff
 * that hides its source.
 */
export function PlanTable({ plan }: { plan: readonly PlannedOperation[] }) {
  const { t } = useLocale();

  return (
    <table className="w-full border-collapse text-[0.875rem]">
      <thead>
        <tr>
          <th scope="col" className="fb-label pb-2 text-start">
            {t('inventory.card.planOp')}
          </th>
          <th scope="col" className="fb-label pb-2 text-start">
            {t('inventory.card.planPath')}
          </th>
          <th scope="col" className="fb-label pb-2 text-start">
            {t('inventory.card.planDetail')}
          </th>
        </tr>
      </thead>
      <tbody>
        {plan.map((operation, index) => (
          <tr key={`${operation.op}:${operation.path}:${String(index)}`} className="border-t border-rule">
            <td className="py-2 pe-4 align-top whitespace-nowrap text-fg-muted">
              {t(`inventory.op.${operation.op}`)}
            </td>
            <td className="py-2 pe-4 align-top">
              <Code>{operation.path}</Code>
            </td>
            <td className="py-2 align-top">
              <Code>{operation.detail}</Code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Free-text match over one card.
 *
 * Matches the *translated* title and summary as well as the untranslated id,
 * keywords and scope paths. A Hebrew reader searching "חנות" has to find the
 * shop card, and a developer searching "ProximityPrompt" has to find it in
 * either locale — those are two different indexes over the same card and both
 * are needed.
 *
 * Deliberately substring, not fuzzy. A fuzzy match over thirteen cards produces
 * "did you mean" behaviour nobody asked for and hides the empty result that
 * tells the user their word is not in this catalog.
 */
export function cardMatches(
  card: MechanicCard,
  query: string,
  translated: { title: string; summary: string },
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  const haystack = [
    card.id,
    card.category,
    translated.title,
    translated.summary,
    ...card.keywords,
    ...card.scope.map((entry) => entry.path),
  ]
    .join('\n')
    .toLowerCase();

  return haystack.includes(needle);
}
