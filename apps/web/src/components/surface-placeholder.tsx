'use client';

import { useLocale } from '@/i18n/dictionary-context';
import { Code } from '@/components/ui/code';

/**
 * A surface that is not built yet, saying so.
 *
 * Every nav entry routes here rather than to a 404, and every one of them names
 * the milestone that owns it. That is the difference between "the shell is
 * broken" and "this page is somebody's next job" — a reviewer opening the app
 * should be able to tell which, in one glance, without reading MILESTONES.md.
 *
 * TODO(M34, M35, M36, M37, M38): each surface replaces its own placeholder.
 */
export function SurfacePlaceholder({ milestone, titleKey }: { milestone: string; titleKey: string }) {
  const { t } = useLocale();

  return (
    <div className="flex max-w-[var(--fb-measure)] flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[1.5rem]">{t(titleKey)}</h1>
        <p className="fb-label">{t('placeholder.reserved', { milestone })}</p>
      </header>
      <p className="text-fg-muted">{t('placeholder.notBuilt')}</p>
      <p className="fb-meta">
        {t('placeholder.seeMilestones')} — <Code>{`docs/MILESTONES.md`}</Code>
      </p>
    </div>
  );
}
