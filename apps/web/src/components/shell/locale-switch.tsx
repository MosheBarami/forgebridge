'use client';

import { useId } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { useLocale } from '@/i18n/dictionary-context';
import { isLocale, LOCALES, LOCALE_COOKIE, LOCALE_NAME, type Locale } from '@/i18n/config';

/**
 * The language switch.
 *
 * Switching rewrites the first path segment rather than navigating home, so a
 * reader who is three levels into a surface stays there. It also writes a
 * cookie the middleware reads, so the *next* visit to `/` lands in the language
 * they chose instead of re-negotiating from `Accept-Language` — a user who
 * overrode their browser's header meant it.
 *
 * Each option is written in its own language. A picker that says "Hebrew" in
 * English is a picker you cannot use if English is the thing you cannot read.
 */
export function LocaleSwitch() {
  const { locale, t } = useLocale();
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();

  const switchTo = (next: Locale) => {
    if (next === locale) return;

    // `SameSite=Lax` so it survives an ordinary top-level navigation from
    // elsewhere; a year because a language choice is not a session.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;

    const segments = pathname.split('/');
    // segments[0] is the empty string before the leading slash; segments[1] is
    // the locale the middleware guaranteed is there.
    if (isLocale(segments[1])) segments[1] = next;
    else segments.splice(1, 0, next);

    router.push(segments.join('/') || `/${next}`);
    // The `<html lang>` and `dir` are rendered by the locale layout, so the
    // refresh is what makes the direction flip rather than only the strings.
    router.refresh();
  };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="fb-label">
        {t('shell.locale.label')}
      </label>
      <select
        id={id}
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) switchTo(next);
        }}
        className="rounded-sm border border-rule bg-raised px-2 py-1 text-[0.8125rem] text-fg"
      >
        {LOCALES.map((candidate) => (
          <option key={candidate} value={candidate} lang={candidate}>
            {LOCALE_NAME[candidate]}
          </option>
        ))}
      </select>
    </div>
  );
}
