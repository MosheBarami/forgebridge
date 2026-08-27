import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import en from '@/i18n/dictionaries/en.json';
import he from '@/i18n/dictionaries/he.json';
import { LocaleProvider } from '@/i18n/dictionary-context';
import type { Dictionary } from '@/i18n/translate';
import { CARDS, cardKey } from './catalog';
import { InventoryBrowser } from './inventory-browser';

/**
 * The catalog as something you can actually find a card in.
 *
 * The assertion worth having here is the last one: **search matches the
 * translated title.** The obvious implementation indexes the card's id and its
 * English keywords, passes every test a reviewer who reads English would write,
 * and leaves a Hebrew reader typing a Hebrew word into a box that never matches
 * anything. That is not a translation gap, it is a broken feature — and it is
 * invisible in every screenshot of the working locale.
 */

const replace = vi.fn();
let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/inventory',
  useSearchParams: () => search,
}));

afterEach(() => {
  search = new URLSearchParams();
  replace.mockReset();
});

function mount(locale: 'en' | 'he', query = '') {
  search = new URLSearchParams(query);
  render(
    <LocaleProvider
      locale={locale}
      dir={locale === 'he' ? 'rtl' : 'ltr'}
      dictionary={(locale === 'he' ? he : en) as Dictionary}
    >
      <div dir={locale === 'he' ? 'rtl' : 'ltr'}>
        <InventoryBrowser />
      </div>
    </LocaleProvider>,
  );
}

/** The card links, which is every link this component renders. */
function cardLinks(): HTMLElement[] {
  return screen.getAllByRole('link');
}

describe('browsing the catalog', () => {
  it('lists every card with no filter, and needs no daemon or account to do it', () => {
    mount('en');
    expect(cardLinks()).toHaveLength(CARDS.length);
  });

  it('narrows to one category', () => {
    mount('en', 'category=persistence');
    const expected = CARDS.filter((card) => card.category === 'persistence');
    expect(cardLinks()).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('ignores a category that is not in the catalog rather than showing nothing', () => {
    // A hand-edited or stale URL should degrade to "everything", not to an
    // empty page the user has no way to read as "your link was wrong".
    mount('en', 'category=nonsense');
    expect(cardLinks()).toHaveLength(CARDS.length);
  });

  it('matches an untranslated keyword a developer would type', () => {
    mount('en', 'q=ProximityPrompt');
    expect(cardLinks()).toHaveLength(1);
  });

  it('matches an instance path from a card scope', () => {
    mount('en', 'q=ServerScriptService.DataService');
    expect(cardLinks()).toHaveLength(1);
  });

  it('writes the query into the URL instead of holding it in component state', () => {
    mount('en');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shop' } });
    expect(replace).toHaveBeenCalledWith('/en/inventory?q=shop', { scroll: false });
  });

  it('says how many of how many are showing', () => {
    mount('en', 'category=economy');
    const shown = CARDS.filter((card) => card.category === 'economy').length;
    expect(
      screen.getByText(`Showing ${String(shown)} of ${String(CARDS.length)} cards.`),
    ).toBeInTheDocument();
  });
});

describe('search in Hebrew', () => {
  it('matches a card by its translated title', () => {
    // The Hebrew title of the shop card, from the dictionary rather than from a
    // literal here — a test that hard-codes the string passes after somebody
    // improves the translation and stops testing anything.
    const title = (
      he as unknown as { inventory: { cards: Record<string, { title: string }> } }
    ).inventory.cards['shop']?.title;
    expect(typeof title).toBe('string');

    mount('he', `q=${encodeURIComponent(title as string)}`);
    expect(cardLinks()).toHaveLength(1);
    expect(screen.getByText(title as string)).toBeInTheDocument();
  });

  it('renders every card title from the Hebrew dictionary, not the English one', () => {
    mount('he');
    for (const card of CARDS.slice(0, 3)) {
      const key = cardKey(card.id, 'title');
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, segment) =>
            typeof node === 'object' && node !== null
              ? (node as Record<string, unknown>)[segment]
              : undefined,
          he,
        );
      expect(screen.getByText(String(value))).toBeInTheDocument();
    }
  });
});
