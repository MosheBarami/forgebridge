import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { ProjectsSurface } from './projects-surface';

/**
 * Projects (M34).
 *
 * A Server Component for the headings and the metadata, handing off to one
 * Client Component for everything else — because everything else reads
 * IndexedDB and the daemon, and neither exists on a server. That split is the
 * same one the bridge page makes and for the same reason (README, "Why the
 * daemon is called from the browser").
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  return { title: createTranslate(dictionary)('projects.title') };
}

export default async function ProjectsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.75rem]">{t('projects.title')}</h1>
        <p className="text-fg-muted">{t('projects.lede')}</p>
      </header>
      <ProjectsSurface />
    </div>
  );
}
