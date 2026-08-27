'use client';

import NextLink from 'next/link';
import { usePathname } from 'next/navigation';

import { useLocale } from '@/i18n/dictionary-context';

/**
 * The settings sections.
 *
 * `link` is deliberately not under `/settings`. The transport a link uses and
 * the pairing that establishes it are the bridge's own state, not a preference
 * about it — ADR-014 puts the privacy posture in the UI *at all times*, and a
 * page that only exists three levels inside a settings tree is not "at all
 * times". So it is a surface at `/link`, and this nav is what keeps it
 * reachable from the place a user goes looking for it.
 *
 * `external: true` marks that one entry so the current-item test uses the whole
 * path rather than a `/settings` prefix.
 */
export const SETTINGS_SECTIONS = [
  { segment: '', key: 'settings.section.overview', external: false },
  { segment: 'models', key: 'settings.section.models', external: false },
  { segment: 'keys', key: 'settings.section.keys', external: false },
  { segment: 'approval', key: 'settings.section.approval', external: false },
  { segment: 'appearance', key: 'settings.section.appearance', external: false },
  { segment: 'link', key: 'settings.section.link', external: true },
] as const;

function hrefFor(locale: string, section: (typeof SETTINGS_SECTIONS)[number]): string {
  if (section.external) return `/${locale}/${section.segment}`;
  return section.segment === '' ? `/${locale}/settings` : `/${locale}/settings/${section.segment}`;
}

/**
 * A secondary nav, drawn as a list of ruled rows rather than as tabs.
 *
 * Tabs would imply the sections are alternate views of one thing; they are six
 * separate registers of the instrument, and one of them is not even inside
 * settings. The current row is the `sunken` plane and carries `aria-current`,
 * matching the primary rail so a user does not have to learn a second visual
 * language for "you are here".
 */
export function SettingsSectionNav({ label }: { label: string }) {
  const { locale, t } = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="min-w-0">
      <ul className="flex flex-wrap gap-px md:flex-col">
        {SETTINGS_SECTIONS.map((section) => {
          const href = hrefFor(locale, section);
          // Exact for the overview and for the external entry; prefix for the
          // rest, so a nested route inside a section keeps its section lit.
          const current =
            section.segment === '' || section.external
              ? pathname === href
              : pathname.startsWith(href);

          return (
            <li key={section.segment || 'overview'}>
              <NextLink
                href={href}
                aria-current={current ? 'page' : undefined}
                className={
                  'block rounded-sm px-3 py-1.5 text-[0.875rem] transition-colors duration-150 ' +
                  (current
                    ? 'bg-sunken font-semibold text-fg'
                    : 'font-normal text-fg-muted hover:bg-sunken hover:text-fg')
                }
              >
                {t(section.key)}
              </NextLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
