import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Hebrew } from 'next/font/google';

import '../globals.css';

import { DEFAULT_LOCALE, LOCALES, dirFor, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { LocaleProvider } from '@/i18n/dictionary-context';
import { createTranslate } from '@/i18n/translate';
import { DaemonSessionProvider } from '@/lib/daemon/session';
import { BridgeProvider } from '@/lib/daemon/use-daemon';
import { AppShell } from '@/components/shell/app-shell';
import { ThemeScript } from '@/components/shell/theme-script';

/**
 * This is the root layout. There is no `app/layout.tsx` above it, deliberately:
 * `<html lang>` and `<html dir>` depend on the locale, the locale is a route
 * parameter, and a layout above the parameter cannot read it. Every request
 * reaches a locale segment because `middleware.ts` guarantees the prefix.
 */

/**
 * Self-hosted at build time by `next/font`, not linked from Google's CDN.
 *
 * A product whose default posture is "nothing leaves this machine" should not
 * make every visitor's browser announce itself to a third party to render a
 * heading. `next/font/google` downloads the files during `next build` and
 * serves them from this origin, which also removes the layout shift a remote
 * stylesheet would cause.
 *
 * The pairing is IBM Plex: a technical face with a Hebrew companion cut from
 * the same skeleton, so switching to `dir="rtl"` changes the direction of the
 * page without changing its typographic voice. DESIGN.md has the longer answer.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexSansHebrew = IBM_Plex_Sans_Hebrew({
  subsets: ['hebrew'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans-he',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

/** Two locales, both prerendered. */
export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

/** An unknown locale is a 404, not a silent fallback to English. */
export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const resolved = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const dictionary = await getDictionary(resolved);
  const t = createTranslate(dictionary);

  return {
    title: { default: t('meta.title'), template: `%s — ${t('meta.title')}` },
    description: t('meta.description'),
    // No `metadataBase`: this app is deployed to apple.gg *and* self-hosted at
    // whatever origin a self-hoster chooses, and a base URL baked into the
    // build would be wrong for one of them.
    applicationName: t('meta.title'),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const dir = dirFor(locale);
  const dictionary = await getDictionary(locale);

  return (
    <html
      lang={locale}
      dir={dir}
      // The inline script in <head> writes `data-theme` before first paint;
      // React must not treat the difference from the server HTML as an error.
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexSansHebrew.variable} ${plexMono.variable}`}
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <LocaleProvider locale={locale} dir={dir} dictionary={dictionary}>
          {/*
            The daemon session wraps everything because the link register in the
            shell needs it, and because a token pasted on one surface must still
            be there when the user navigates to another. It holds the producer
            token in memory only — see `lib/daemon/session.tsx`.
          */}
          <DaemonSessionProvider>
            {/*
              One probe loop for the whole tree. The pinned link register, the
              bridge page's link detail and the surface around it all read the
              same daemon state; three independent hooks would mean three timers
              and, while the daemon is absent, three rejected cross-origin
              requests every five seconds.
            */}
            <BridgeProvider>
              <AppShell>{children}</AppShell>
            </BridgeProvider>
          </DaemonSessionProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
