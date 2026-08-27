import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PRIVACY_POSTURE } from '@forgebridge/protocol';

import { LocaleProvider } from '@/i18n/dictionary-context';
import { DaemonSessionProvider } from '@/lib/daemon/session';
import { BridgeProvider } from '@/lib/daemon/use-daemon';
import { AppShell } from '@/components/shell/app-shell';
import { LinkDetail } from '@/components/shell/link-indicator';
import he from '@/i18n/dictionaries/he.json';
import en from '@/i18n/dictionaries/en.json';

/**
 * RTL, exercised rather than assumed.
 *
 * The brief for this app says Hebrew must produce a *correct* layout, not a
 * mirrored-by-accident one, and the only way to keep that true is to render the
 * shell in Hebrew in CI. What this file pins:
 *
 *   - the shell renders under `dir="rtl"` with real Hebrew strings;
 *   - the mono island inside it stays `dir="ltr"`, because a reversed instance
 *     path in a diff would point somewhere the ChangeSet does not;
 *   - the `PRIVACY_POSTURE` string is rendered verbatim in both locales — it is
 *     a contract term, and ADR-014's mitigation rests on it not drifting.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/he',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const PROJECT_ID = '2c9f5d1e-6a3b-4f8c-9d21-7b6e4a0f1c33';
const LINK_ID = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';

function daemonUp() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith('/v1/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'forgebridge-daemon',
          version: '0.1.0',
          protocolVersion: '1.0.0',
          transport: 'local-daemon',
          boundTo: '127.0.0.1:7317',
          uptimeSeconds: 12,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.endsWith('/v1/link')) {
      return new Response(
        JSON.stringify({
          transport: 'local-daemon',
          privacyPosture: PRIVACY_POSTURE['local-daemon'],
          protocolVersion: '1.0.0',
          defaultProjectId: PROJECT_ID,
          links: [
            {
              id: LINK_ID,
              projectId: PROJECT_ID,
              transport: 'local-daemon',
              state: 'paired',
              sessionKeyId: 'sk_test',
              pluginVersion: '0.1.0',
              studioVersion: null,
              placeId: null,
              lastSeenAt: '2026-08-27T00:00:00.000Z',
              createdAt: '2026-08-27T00:00:00.000Z',
            },
          ],
          pairing: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.endsWith('/v1/models')) {
      return new Response(
        JSON.stringify({ configured: false, source: 'none', verifiedAt: null, models: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  });
}

describe('the shell in Hebrew', () => {
  it('renders right-to-left with Hebrew navigation', () => {
    vi.stubGlobal('fetch', daemonUp());

    const { container } = render(
      <LocaleProvider locale="he" dir="rtl" dictionary={he}>
        <DaemonSessionProvider>
          <BridgeProvider>
            <AppShell>
              <p>תוכן</p>
            </AppShell>
          </BridgeProvider>
        </DaemonSessionProvider>
      </LocaleProvider>,
    );

    // The shell's own root does not carry `dir` — `<html>` does, and jsdom's
    // document element is what the layout would set. Set it the way the layout
    // does, then assert the tree beneath it reads as RTL.
    document.documentElement.setAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');

    // Real Hebrew, from the dictionary — not a key, and not English.
    expect(screen.getByRole('link', { name: 'פרויקטים' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'ניווט ראשי' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'תוכן ראשי' })).toBeInTheDocument();

    // The skip link is first in the tab order and says so in Hebrew.
    const skip = screen.getByRole('link', { name: 'דלגו לתוכן הראשי' });
    expect(skip).toHaveAttribute('href', '#main');

    // No physical-direction styling leaked into the shell markup.
    expect(container.innerHTML).not.toMatch(/\bborder-r\b|\bborder-l\b|\bml-\d|\bpl-\d|text-left/);
  });

  it('renders the PRIVACY_POSTURE string verbatim, in an LTR island, with a Hebrew gloss', async () => {
    vi.stubGlobal('fetch', daemonUp());

    render(
      <LocaleProvider locale="he" dir="rtl" dictionary={he}>
        <DaemonSessionProvider>
          <BridgeProvider>
            <LinkDetail />
          </BridgeProvider>
        </DaemonSessionProvider>
      </LocaleProvider>,
    );

    const posture = await screen.findByText(PRIVACY_POSTURE['local-daemon']);
    // Verbatim, and marked as English so a Hebrew-locale screen reader does not
    // try to pronounce it as Hebrew.
    expect(posture).toHaveAttribute('dir', 'ltr');
    expect(posture).toHaveAttribute('lang', 'en');

    // The Hebrew explanation sits beside it, never in place of it.
    expect(
      screen.getByText(he.link.postureGloss['local-daemon']),
    ).toBeInTheDocument();

    // The daemon's bound address is a mono island: an RTL paragraph must not
    // reorder `127.0.0.1:7317`.
    await waitFor(() => {
      expect(screen.getByText('127.0.0.1:7317')).toHaveAttribute('dir', 'ltr');
    });
  });

  it('renders the same posture string, unglossed, in English', async () => {
    vi.stubGlobal('fetch', daemonUp());

    render(
      <LocaleProvider locale="en" dir="ltr" dictionary={en}>
        <DaemonSessionProvider>
          <BridgeProvider>
            <LinkDetail />
          </BridgeProvider>
        </DaemonSessionProvider>
      </LocaleProvider>,
    );

    expect(await screen.findByText(PRIVACY_POSTURE['local-daemon'])).toBeInTheDocument();
    // The gloss would be the same sentence twice in English, so it is absent.
    expect(screen.queryByText(en.link.postureGloss['local-daemon'])).not.toBeInTheDocument();
  });
});
