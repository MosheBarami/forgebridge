'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useLocale } from '@/i18n/dictionary-context';

/**
 * The surfaces this app has, and the milestone that owns each one.
 *
 * Every entry routes to a page that exists. Five of the six are honest
 * placeholders naming their milestone — a nav that links into a 404 teaches a
 * reviewer that the shell is broken when what is actually true is that the
 * surface is unbuilt, and those are different facts.
 */
export const SURFACES = [
  { segment: '', key: 'shell.nav.bridge', milestone: null },
  { segment: 'generate', key: 'shell.nav.generate', milestone: 'M35' },
  { segment: 'projects', key: 'shell.nav.projects', milestone: 'M34' },
  // M36 and M37 are built, so they carry no milestone tag. The tag means "this
  // surface is a placeholder"; leaving one on a shipped surface would teach a
  // reviewer to ignore the tags on the surfaces that really are placeholders.
  { segment: 'inventory', key: 'shell.nav.inventory', milestone: null },
  { segment: 'map', key: 'shell.nav.map', milestone: null },
  { segment: 'settings', key: 'shell.nav.settings', milestone: 'M38' },
] as const;

export function Nav({ label }: { label: string }) {
  const { locale, t } = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="p-3">
      <ul className="flex flex-col gap-px">
        {SURFACES.map((surface) => {
          const href = surface.segment === '' ? `/${locale}` : `/${locale}/${surface.segment}`;
          // Exact match for the root so it is not marked current on every page;
          // prefix match for the rest so a nested route keeps its parent lit.
          const current =
            surface.segment === '' ? pathname === href : pathname.startsWith(href);

          return (
            <li key={surface.segment || 'bridge'}>
              <Link
                href={href}
                // `aria-current="page"` is the semantic marker. The border and
                // weight below are the visual one. Neither substitutes for the
                // other: the border alone is invisible to a screen reader, and
                // the attribute alone is invisible to everyone else.
                aria-current={current ? 'page' : undefined}
                className={
                  'flex items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-[0.875rem] ' +
                  'transition-colors duration-150 ' +
                  (current
                    ? 'bg-sunken font-semibold text-fg'
                    : 'font-normal text-fg-muted hover:bg-sunken hover:text-fg')
                }
              >
                <span>{t(surface.key)}</span>
                {surface.milestone ? (
                  <span
                    className="fb-meta font-mono text-[0.6875rem] text-fg-faint"
                    dir="ltr"
                    // The milestone tag is a build fact, not part of the link's
                    // name — a screen reader announcing "Projects M34" on every
                    // item would make the nav harder to use, not more honest.
                    aria-hidden="true"
                  >
                    {surface.milestone}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
