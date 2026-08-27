import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { SettingsOverview } from '@/components/settings/settings-overview';

/**
 * Settings → Overview (M38).
 *
 * A Server Component for the strings and the heading; one Client Component for
 * the values, because every value on this page comes from somewhere only the
 * browser can reach — the preference store in IndexedDB, the key vault, and a
 * daemon listening on the user's own loopback interface.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('settings.section.overview') };
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const t = createTranslate(await getDictionary(resolved));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('settings.overview.title')}</h1>
        <p className="text-fg-muted">{t('settings.overview.lede')}</p>
      </header>
      <SettingsOverview locale={resolved} />
    </div>
  );
}
