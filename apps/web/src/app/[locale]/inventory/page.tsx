import { Suspense } from 'react';
import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { InventoryBrowser } from './inventory-browser';

/**
 * M36 — the inventory of mechanic cards.
 *
 * A Server Component that renders the prose and hands the interactive half to
 * one Client Component. The split is not about the daemon here — this surface
 * never calls it — it is that search and filter state lives in the query string,
 * and `useSearchParams` is a client hook.
 *
 * The `<Suspense>` boundary is required rather than defensive: a page that reads
 * search params must declare one or Next refuses to prerender it, and this route
 * *is* prerendered (`generateStaticParams` on the locale layout, and a catalog
 * that is a compile-time constant).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);
  return { title: t('inventory.title'), description: t('inventory.lede') };
}

export default async function InventoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.75rem]">{t('inventory.title')}</h1>
        <p className="text-fg-muted">{t('inventory.lede')}</p>
      </header>

      {/*
        The ADR-012 reminder, stated where a user is about to pick something that
        sounds like a one-click action. A card is a prompt and a scope; it starts
        a run and the run stops at `validated`. Saying that here — rather than
        only on the diff screen the user has not reached yet — is the difference
        between a promise and a disclosure.
      */}
      <p className="max-w-[var(--fb-measure)] border-s-2 border-rule ps-4 text-[0.9375rem] text-fg-muted">
        {t('inventory.notApplied')}
      </p>

      <Suspense fallback={<p className="fb-meta">{t('common.loading')}</p>}>
        <InventoryBrowser />
      </Suspense>

      {/*
        TODO(M50): community submission. Left as a stated absence rather than a
        disabled "Submit a card" button — a control that does nothing teaches a
        user that controls here might do nothing, which is an expensive thing to
        teach in an app whose central claim is that its buttons mean what they
        say. The shape a submitted card has to take is `MechanicCard` in
        `catalog.ts`, and `source: 'community'` is already in that union.
      */}
      <section
        aria-labelledby="inventory-community"
        className="max-w-[var(--fb-measure)] border-t border-rule pt-4"
      >
        <h2 id="inventory-community" className="fb-label">
          {t('inventory.community.title')}
        </h2>
        <p className="fb-meta mt-1">{t('inventory.community.body')}</p>
      </section>
    </div>
  );
}
