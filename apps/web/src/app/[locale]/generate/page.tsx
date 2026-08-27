import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { readCatalog } from './catalog';
import { GenerateSurface } from './generate-surface';

/**
 * Generation (M35).
 *
 * The catalog is read here, on the server, and handed down as a prop. It is
 * build-time data — `packages/model-registry/data/catalog.json`, synced by a
 * script — so fetching it from the browser would be a network round trip to
 * learn something this HTML could have carried, and importing the registry into
 * a client bundle is impossible anyway: it reads the file with `node:fs`.
 *
 * Everything below `GenerateSurface` is a Client Component, because everything
 * below it talks to the daemon on the user's loopback interface, which no
 * server can reach.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  return { title: createTranslate(dictionary)('generate.title') };
}

export default async function GeneratePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);
  const catalog = readCatalog();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.75rem]">{t('generate.title')}</h1>
        <p className="text-fg-muted">{t('generate.lede')}</p>
      </header>
      <GenerateSurface catalog={catalog} />
    </div>
  );
}
