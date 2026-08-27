import { Suspense } from 'react';
import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { OAuthCallbackSurface } from './callback-surface';

/**
 * The OAuth return address.
 *
 * `robots: noindex` because this URL is only ever meaningful with a
 * single-use authorization code on it, and a search engine holding a copy of
 * one is a copy nobody intended to make.
 *
 * The Suspense boundary is required, not decorative: `useSearchParams` in a
 * Client Component opts the route into client-side rendering, and Next refuses
 * to build the page without a boundary to render while that happens.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('settings.keys.callback.title'), robots: { index: false, follow: false } };
}

export default async function OAuthCallbackPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('settings.keys.callback.title')}</h1>
        <p className="text-fg-muted">{t('settings.keys.callback.lede')}</p>
      </header>
      <Suspense fallback={<p className="fb-meta">{t('common.loading')}</p>}>
        <OAuthCallbackSurface />
      </Suspense>
    </div>
  );
}
