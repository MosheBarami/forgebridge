import type { Metadata } from 'next';

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import { LocaleSwitch } from '@/components/shell/locale-switch';
import { ThemeSwitch } from '@/components/shell/theme-switch';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';

/**
 * Settings → Appearance and language.
 *
 * The controls here are **the shell's own switches**, imported rather than
 * rebuilt. That is the whole design of this page: a settings copy of a control
 * is a second control that drifts, and two theme pickers that disagree about
 * what "system" means is a bug nobody notices until a user reports that the app
 * "sometimes forgets". The page's contribution is the part the bar has no room
 * for — where each preference is stored, and why it is stored there rather than
 * with the rest of the user's work.
 *
 * Both preferences are deliberately outside the Storage port:
 *
 *   - the theme is in `localStorage` under `fb-theme`, because the inline
 *     script in the document head reads it *before first paint*, and IndexedDB
 *     is asynchronous — routing it through the port would guarantee a frame of
 *     the wrong theme on every load, on a page whose first element is a status
 *     indicator whose colour carries meaning;
 *   - the locale is a cookie, because `middleware.ts` reads it before the app
 *     renders at all, and a middleware cannot read a browser database.
 *
 * Neither is a limitation to work around. They are both "this value is needed
 * earlier than the store can answer", which is what cookies and synchronous
 * storage are for.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('settings.section.appearance') };
}

export default async function AppearanceSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('settings.appearance.title')}</h1>
        <p className="text-fg-muted">{t('settings.appearance.lede')}</p>
      </header>

      <Register labelId="reg-theme" title={t('shell.theme.label')}>
        <div className="flex flex-col gap-4">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('settings.appearance.themeBody')}
          </p>
          <ThemeSwitch />
          <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
            {t('settings.appearance.themeStorage')} <Code>{THEME_STORAGE_KEY}</Code>
          </p>
          <p className="max-w-[var(--fb-measure)] fb-meta">
            {t('settings.appearance.themeContrast')}
          </p>
        </div>
      </Register>

      <Register labelId="reg-language" title={t('shell.locale.label')}>
        <div className="flex flex-col gap-4">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('settings.appearance.localeBody')}
          </p>
          <LocaleSwitch />
          <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
            {t('settings.appearance.localeStorage')} <Code>{LOCALE_COOKIE}</Code>
          </p>
          {/*
            The RTL note. Not a boast — a statement of what changes, so a
            Hebrew reader who finds a page that did not flip has something
            concrete to report rather than "the layout looks wrong".
          */}
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.appearance.rtlNote')}</p>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.appearance.postureNote')}</p>
        </div>
      </Register>

      <Register labelId="reg-motion" title={t('settings.appearance.motionTitle')}>
        <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
          {t('settings.appearance.motionBody')}
        </p>
      </Register>
    </div>
  );
}
