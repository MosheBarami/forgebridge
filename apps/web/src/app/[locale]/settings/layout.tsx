import type { ReactNode } from 'react';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { SettingsSectionNav } from '@/components/settings/section-nav';

/**
 * The settings area: a section list on the inline start, the section on the
 * inline end.
 *
 * A second rail rather than tabs, for the reason `section-nav.tsx` gives. The
 * whole layout is logical-axis (`md:flex-row` plus `border-e` on the rail), so
 * `dir="rtl"` puts the section list on the reader's start edge by construction
 * rather than by a mirrored stylesheet — the rule the repository's
 * `logical-properties.test.ts` enforces.
 *
 * The nav is a landmark with its own name. The shell already contributes one
 * `navigation` landmark; a second unnamed one would give a screen-reader user
 * two identical entries in their landmark list, which is worse than one.
 */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));

  return (
    <div className="flex flex-col gap-6">
      <p className="fb-label">{t('shell.nav.settings')}</p>

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <div className="shrink-0 border-b border-rule pb-4 md:w-52 md:border-b-0 md:border-e md:pb-0 md:pe-4">
          <SettingsSectionNav label={t('settings.sectionNav')} />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
