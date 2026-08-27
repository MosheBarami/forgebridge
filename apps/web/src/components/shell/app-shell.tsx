'use client';

import NextLink from 'next/link';
import type { ReactNode } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { LinkIndicator } from './link-indicator';
import { LocaleSwitch } from './locale-switch';
import { Nav } from './nav';
import { SkipLink } from './skip-link';
import { ThemeSwitch } from './theme-switch';

export const MAIN_ID = 'main';

/**
 * The shell: a bar, a rail, a working surface.
 *
 * The bar is where the bridge's state lives and it is pinned, because the one
 * fact this product must never let a user lose track of is who can read what is
 * flowing over their link (ADR-014). Putting it in a settings page would be
 * putting it somewhere nobody looks.
 *
 * The rail's rule runs along its inline end. Every edge, padding and offset in
 * this file is a logical property, so `dir="rtl"` produces a shell whose rail
 * sits on the reader's right *by construction* rather than by a mirrored
 * stylesheet — see DESIGN.md, "RTL is a layout, not a transform". The test in
 * `src/test/logical-properties.test.ts` is what keeps that true.
 *
 * Landmarks: one `banner`, one `navigation`, one `main`, one `contentinfo`.
 * Each is named, because a screen-reader user navigating by landmark gets a
 * list of them and "navigation" three times is a list that does not help.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t, locale } = useLocale();

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <SkipLink label={t('shell.skipToContent')} targetId={MAIN_ID} />

      <header
        aria-label={t('shell.utilityBar')}
        className="sticky top-0 z-30 border-b border-rule bg-surface"
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2">
          <NextLink
            href={`/${locale}`}
            className="text-[0.9375rem] font-semibold tracking-tight text-fg"
          >
            {t('meta.title')}
          </NextLink>

          {/* The always-on link register. */}
          <div className="min-w-0 flex-1">
            <LinkIndicator />
          </div>

          {/*
            "No account" is stated, not implied by the absence of an avatar.
            Signed-out is the product's first-class mode (ADR-005), and a user
            who cannot tell whether they are signed in cannot reason about where
            their work is.
          */}
          <span
            // No `title` tooltip: it is unreachable by keyboard and by touch.
            // The footer states the same fact in the flow of the page, where
            // everyone gets it.
            className="rounded-sm border border-rule px-2 py-0.5 text-[0.75rem] font-medium text-fg-muted"
          >
            {t('shell.signedOut.badge')}
          </span>

          <div className="flex items-center gap-4">
            <ThemeSwitch />
            <LocaleSwitch />
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <div className="shrink-0 border-b border-rule md:w-[var(--fb-rail-width)] md:border-b-0 md:border-e">
          <Nav label={t('shell.primaryNav')} />
        </div>

        <main
          id={MAIN_ID}
          // `tabIndex={-1}` so the skip link can actually move focus here.
          // Without it the browser scrolls to the anchor and leaves focus in
          // the header, which puts the next Tab back at the top of the nav.
          tabIndex={-1}
          aria-label={t('shell.mainContent')}
          className="flex-1 px-4 py-6 md:px-8 md:py-8"
        >
          {children}
        </main>
      </div>

      <footer aria-label={t('shell.footer')} className="border-t border-rule px-4 py-3">
        <p className="fb-meta">{t('shell.signedOut.explain')}</p>
      </footer>
    </div>
  );
}
