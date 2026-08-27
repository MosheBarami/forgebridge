'use client';

import Link from 'next/link';

import { useLocale } from '@/i18n/dictionary-context';

/**
 * Inside the locale segment, so it renders with the shell, the right language
 * and the right direction. A 404 that drops the user out of their language is
 * a 404 they cannot read their way out of.
 */
export default function NotFound() {
  const { t, locale } = useLocale();

  return (
    <div className="flex max-w-[var(--fb-measure)] flex-col gap-3">
      <h1 className="text-[1.5rem]">{t('notFound.title')}</h1>
      <p className="text-fg-muted">{t('notFound.body')}</p>
      <p>
        <Link href={`/${locale}`} className="font-medium text-fg underline underline-offset-4">
          {t('notFound.home')}
        </Link>
      </p>
    </div>
  );
}
