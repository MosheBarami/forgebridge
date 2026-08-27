import { Suspense } from 'react';
import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { MapSurface } from './map-surface';

/**
 * M37 — the game map.
 *
 * A Server Component for the prose, one Client Component for everything else.
 * That split is forced twice over here: the graph's data comes from IndexedDB,
 * which no server can read, and the selected node lives in the query string,
 * which `useSearchParams` reaches — and which is why the `<Suspense>` boundary
 * below is a requirement of prerendering rather than a nicety.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);
  return { title: t('map.title'), description: t('map.lede') };
}

export default async function MapPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.75rem]">{t('map.title')}</h1>
        <p className="text-fg-muted">{t('map.lede')}</p>
      </header>

      <Suspense fallback={<p className="fb-meta">{t('common.loading')}</p>}>
        <MapSurface />
      </Suspense>
    </div>
  );
}
