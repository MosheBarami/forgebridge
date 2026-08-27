'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useDeferredValue, useMemo } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { Code } from '@/components/ui/code';
import { CARD_CATEGORIES, CARDS, cardKey, type CardCategory } from './catalog';
import { CategoryTag, cardMatches } from './card-parts';

/**
 * Browse, search, filter.
 *
 * Two things about the state, both deliberate:
 *
 * 1. **It lives in the URL**, as `?q=` and `?category=`. A user filters to
 *    "persistence", opens the DataStore card, reads it, and presses Back — with
 *    component state that returns them to an unfiltered list and they have to
 *    do it again. `router.replace` rather than `push` so typing a query does not
 *    push a history entry per keystroke; the filter is a view of this page, not
 *    a place you navigated to.
 *
 * 2. **It needs no daemon and no account.** This whole surface is static data
 *    plus a dictionary. ADR-005 says signed-out is the common mode, and the
 *    catalog is the one part of this app that has nothing to ask anybody for —
 *    so it asks for nothing, and there is no probe, no gate and no empty state
 *    conditioned on a session anywhere in this file.
 */
export function InventoryBrowser() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const query = params.get('q') ?? '';
  const rawCategory = params.get('category');
  const category: CardCategory | null =
    rawCategory !== null && (CARD_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as CardCategory)
      : null;

  // The input stays fully controlled by the URL, but the filtering work is
  // deferred, so a fast typist never waits on a re-render of the whole list.
  const deferredQuery = useDeferredValue(query);

  const setParam = useCallback(
    (key: 'q' | 'category', value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || value.length === 0) next.delete(key);
      else next.set(key, value);
      const search = next.toString();
      router.replace(search.length > 0 ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const visible = useMemo(
    () =>
      CARDS.filter((card) => {
        if (category !== null && card.category !== category) return false;
        return cardMatches(card, deferredQuery, {
          title: t(cardKey(card.id, 'title')),
          summary: t(cardKey(card.id, 'summary')),
        });
      }),
    [category, deferredQuery, t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="inventory-search" className="fb-sr-only">
            {t('inventory.search.label')}
          </label>
          <input
            id="inventory-search"
            type="search"
            value={query}
            onChange={(event) => {
              setParam('q', event.target.value);
            }}
            placeholder={t('inventory.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-sm border border-rule bg-raised px-3 py-1.5 text-[0.875rem] text-fg placeholder:text-fg-faint"
          />
        </div>

        {/*
          A filter group, not a tab list: several of these could reasonably be on
          at once in a later revision, and `aria-pressed` describes a toggle
          honestly today without promising the single-selection semantics `role
          ="tab"` would. The chips are achromatic — a category is not a state of
          the bridge, and chroma in this system means state (DESIGN.md §1).
        */}
        <div role="group" aria-label={t('inventory.filter.label')} className="flex flex-wrap gap-2">
          <FilterChip
            pressed={category === null}
            label={t('inventory.filter.all')}
            count={CARDS.length}
            onClick={() => {
              setParam('category', null);
            }}
          />
          {CARD_CATEGORIES.map((name) => (
            <FilterChip
              key={name}
              pressed={category === name}
              label={t(`inventory.category.${name}`)}
              count={CARDS.filter((card) => card.category === name).length}
              onClick={() => {
                setParam('category', category === name ? null : name);
              }}
            />
          ))}
        </div>
      </div>

      {/*
        The count is a live region because filtering happens without a page
        change: a screen-reader user who types into the search box gets no
        announcement at all otherwise, and "polite" is right because they are
        still typing.
      */}
      <p aria-live="polite" className="fb-meta">
        {t('inventory.results.count', { shown: visible.length, total: CARDS.length })}
      </p>

      {visible.length === 0 ? (
        <div className="flex max-w-[var(--fb-measure)] flex-col gap-2 rounded-sm border border-rule bg-surface p-4">
          <p className="text-[0.9375rem] text-fg">{t('inventory.results.none')}</p>
          <p className="fb-meta">{t('inventory.results.noneHint')}</p>
        </div>
      ) : (
        <ul className="grid list-none gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((card) => (
            <li key={card.id} className="flex">
              <Link
                href={`/${locale}/inventory/${card.id}`}
                className="fb-register flex w-full flex-col gap-2 p-4 transition-colors duration-150 hover:bg-raised"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.9375rem] font-semibold text-fg">
                    {t(cardKey(card.id, 'title'))}
                  </span>
                  <CategoryTag category={card.category} />
                </span>
                <span className="text-[0.875rem] text-fg-muted">
                  {t(cardKey(card.id, 'summary'))}
                </span>
                <span className="fb-meta flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/*
                    One path, as a sample of the scope. It is the first `creates`
                    entry rather than the first entry outright, because the path
                    a developer recognises a mechanic by is the thing it builds,
                    not the folder it reads from.
                  */}
                  <Code>{primaryPath(card.scope)}</Code>
                  <span>
                    {t('inventory.card.opCount', { count: card.plan.length })}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function primaryPath(scope: readonly { path: string; intent: string }[]): string {
  return (scope.find((entry) => entry.intent === 'creates') ?? scope[0])?.path ?? '';
}

function FilterChip({
  pressed,
  label,
  count,
  onClick,
}: {
  pressed: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={
        'inline-flex items-center gap-2 rounded-sm border px-2.5 py-1 text-[0.8125rem] font-medium ' +
        'transition-colors duration-150 ' +
        (pressed
          ? 'border-fg bg-sunken text-fg'
          : 'border-rule bg-transparent text-fg-muted hover:bg-sunken hover:text-fg')
      }
    >
      <span>{label}</span>
      {/*
        The count is hidden from the accessible name: "Economy 3" read as the
        button's label makes the group harder to scan by voice, and the visible
        results line already states how many cards a filter leaves.
      */}
      <span aria-hidden="true" className="font-mono text-[0.6875rem] text-fg-faint" dir="ltr">
        {count}
      </span>
    </button>
  );
}
