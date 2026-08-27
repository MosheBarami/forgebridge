import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { readModelCatalog } from '@/lib/models/catalog';
import { ModelsBrowser } from '@/components/settings/models-browser';

/**
 * Settings → Models.
 *
 * A Server Component, because the snapshot is parsed and derived once on the
 * server and the rows cross into the browser as plain data.
 *
 * `force-dynamic` because the view is time-dependent, not because it touches a
 * request. Freeness, expiry and the snapshot's age are all derived against
 * *now*: a page prerendered at build time would still be telling a visitor in
 * six weeks that a model withdrawn last month is available, and its "days since
 * that sync" would be frozen at zero forever. `readModelCatalog` takes `now` as
 * a parameter for exactly this reason.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('settings.section.models') };
}

export default async function ModelsSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  const view = readModelCatalog();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('settings.models.title')}</h1>
        <p className="text-fg-muted">{t('settings.models.lede')}</p>
      </header>
      <ModelsBrowser view={view} />
    </div>
  );
}
