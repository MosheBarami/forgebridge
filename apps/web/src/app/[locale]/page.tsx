import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { BridgeSurface } from './bridge-surface';

/**
 * The root page: the bridge itself.
 *
 * A Server Component that renders its strings and hands off to one Client
 * Component for everything that talks to the daemon. That split is not a
 * performance choice — the daemon listens on the *user's* loopback interface,
 * so a server rendering this page cannot reach it, whether that server is
 * apple.gg or a self-hoster's box. See README, "Why the daemon is called from
 * the browser".
 */
export default async function BridgePage({
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
        <h1 className="text-[1.75rem]">{t('bridge.title')}</h1>
        <p className="text-fg-muted">{t('bridge.lede')}</p>
      </header>
      <BridgeSurface />
    </div>
  );
}
