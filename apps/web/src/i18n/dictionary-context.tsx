'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { createTranslate, type Dictionary, type Translate } from './translate';
import type { Locale } from './config';

/**
 * Client components need the dictionary too, and a Server Component cannot pass
 * a function across the boundary — so the *data* crosses and the function is
 * rebuilt here. The locale rides along because a client component that formats
 * a date or a number needs it and should not re-derive it from the URL.
 */
export interface LocaleContextValue {
  readonly locale: Locale;
  readonly dir: 'ltr' | 'rtl';
  readonly t: Translate;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  locale,
  dir,
  dictionary,
  children,
}: {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  dictionary: Dictionary;
  children: ReactNode;
}) {
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, dir, t: createTranslate(dictionary) }),
    [locale, dir, dictionary],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Throws when used outside the provider rather than returning a silent default.
 * A component rendering raw keys because it was mounted in the wrong tree is a
 * bug that should surface in development, not a cosmetic glitch in production.
 */
export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) {
    throw new Error('useLocale must be used inside <LocaleProvider> — see app/[locale]/layout.tsx');
  }
  return value;
}
