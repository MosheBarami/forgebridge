/**
 * Locales and their writing direction.
 *
 * `dir` lives beside the locale rather than being derived at the point of use,
 * because every place that needs it — the `<html>` element, the middleware, the
 * locale switch, a test — must agree, and a second `locale === 'he'` check
 * somewhere is how they stop agreeing.
 */
export const LOCALES = ['en', 'he'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_DIR: Record<Locale, 'ltr' | 'rtl'> = {
  en: 'ltr',
  he: 'rtl',
};

/** Endonyms. A language picker that names languages in *your* language is a
 *  picker you cannot use when you do not read the language it is written in. */
export const LOCALE_NAME: Record<Locale, string> = {
  en: 'English',
  he: 'עברית',
};

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

export function dirFor(locale: Locale): 'ltr' | 'rtl' {
  return LOCALE_DIR[locale];
}

/** The cookie the locale switch writes so a return visit lands where the user left. */
export const LOCALE_COOKIE = 'fb-locale';

/**
 * Pick a locale from an `Accept-Language` header.
 *
 * Deliberately small: quality values are parsed, subtags are matched on their
 * primary language (`he-IL` matches `he`), and anything unrecognised falls to
 * the default. There is no negotiation library here because there are two
 * locales, and a dependency that resolves two locales is a dependency.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const entry of ranked) {
    const primary = entry.tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
