import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { SettingsSectionNav } from '@/components/settings/section-nav';
import { LinkSurface } from './link-surface';

/**
 * `/link` — the transport, the posture, and pairing.
 *
 * A Server Component for the strings and the layout; one Client Component for
 * everything that talks to the daemon, because the daemon listens on the
 * *user's* loopback interface and no server rendering this page can reach it.
 *
 * It shares the settings section rail. The rail lists this page as one of its
 * entries (see `section-nav.tsx` for why the surface itself is not under
 * `/settings`), so rendering the rail here is what keeps the group coherent
 * instead of dropping the user onto an island.
 *
 * TODO(M38): the shell's primary nav in `components/shell/nav.tsx` has no entry
 * for this surface, so nothing in the rail is marked current while a user is on
 * it. That file belongs to the shell rather than to this milestone; adding a
 * `link` entry to `SURFACES` is a one-line change for whoever owns it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('link.surfaceTitle') };
}

export default async function LinkPage({
  params,
}: {
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

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
            <h1 className="text-[1.5rem]">{t('link.surfaceTitle')}</h1>
            <p className="text-fg-muted">{t('link.surfaceLede')}</p>
          </header>
          <LinkSurface />
        </div>
      </div>
    </div>
  );
}
