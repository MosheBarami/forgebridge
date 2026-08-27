import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PRIVACY_POSTURE, type TransportKind } from '@forgebridge/protocol';

import { LocaleProvider } from '@/i18n/dictionary-context';
import en from '@/i18n/dictionaries/en.json';
import he from '@/i18n/dictionaries/he.json';
import { PostureChip, PostureStatement, RelayReadabilityWarning } from './posture';

/**
 * ADR-014, as a gate.
 *
 * The mitigation this project accepted in exchange for shipping without
 * end-to-end encryption is a UI claim: the posture is named in the UI at all
 * times, in the protocol's own words, never as a padlock and never as the word
 * "encrypted" for a relay that is not. That is a promise about rendered text,
 * which makes it something a test can hold.
 *
 * The failure mode these are written against is not malice. It is a future
 * change that shortens the relay string for a narrow viewport, or translates it
 * "for consistency", or swaps it for an icon plus a tooltip. Each of those is a
 * reasonable-sounding UI decision that would break the one claim this product
 * cannot afford to break.
 */

function renderIn(locale: 'en' | 'he', node: React.ReactNode) {
  return render(
    <LocaleProvider
      locale={locale}
      dir={locale === 'he' ? 'rtl' : 'ltr'}
      dictionary={locale === 'he' ? he : en}
    >
      {node}
    </LocaleProvider>,
  );
}

const TRANSPORTS: TransportKind[] = ['local-daemon', 'relay-tls', 'relay-e2e'];

describe('the posture statement', () => {
  it.each(TRANSPORTS)('renders %s verbatim from the protocol', (transport) => {
    renderIn('en', <PostureStatement transport={transport} />);
    expect(screen.getByText(PRIVACY_POSTURE[transport])).toBeInTheDocument();
  });

  it.each(TRANSPORTS)('renders %s verbatim in Hebrew too, in English, marked as English', (transport) => {
    renderIn('he', <PostureStatement transport={transport} />);
    const statement = screen.getByText(PRIVACY_POSTURE[transport]);
    // A contract term is not translated. It is marked `lang="en"` so a screen
    // reader in a Hebrew page pronounces it in English, and `dir="ltr"` so the
    // bidi algorithm leaves its punctuation where the protocol put it.
    expect(statement).toHaveAttribute('lang', 'en');
    expect(statement).toHaveAttribute('dir', 'ltr');
  });

  it('never lets a server describe its own privacy posture', () => {
    // This test used to assert the opposite — that the component "prefers what
    // the daemon asserted about itself". That is the defect: `privacyPosture` is
    // `z.string()` on the wire, so a relay could answer with
    // "Relay — end-to-end encrypted" and have this app say it, in its own voice,
    // over a transport that sends plaintext with a MAC.
    //
    // The sentence now comes only from the local PRIVACY_POSTURE map, keyed by a
    // transport parsed against the frozen enum — the same defence
    // packages/cli/src/posture.ts already had.
    renderIn('en', <PostureStatement transport="relay-tls" />);
    expect(screen.getByText(PRIVACY_POSTURE['relay-tls'])).toBeInTheDocument();
    expect(screen.queryByText(/end-to-end encrypted/i)).toBeNull();
  });

  it('shows the local sentence for the transport, whatever the server is called', () => {
    // The control: a local daemon still gets the local-daemon sentence.
    renderIn('en', <PostureStatement transport="local-daemon" />);
    expect(screen.getByText(PRIVACY_POSTURE['local-daemon'])).toBeInTheDocument();
  });

  it('adds a Hebrew gloss beneath the English statement, and only in Hebrew', () => {
    const hebrew = renderIn('he', <PostureStatement transport="relay-tls" />);
    expect(hebrew.container.textContent).toContain(
      (he as { link: { postureGloss: Record<string, string> } }).link.postureGloss['relay-tls'],
    );
    hebrew.unmount();

    const english = renderIn('en', <PostureStatement transport="relay-tls" />);
    expect(english.container.textContent).not.toContain(
      (en as { link: { postureGloss: Record<string, string> } }).link.postureGloss['relay-tls'],
    );
  });
});

describe('a relay that is not end-to-end encrypted', () => {
  it('says the operator can read the changes, in those words', () => {
    renderIn('en', <PostureStatement transport="relay-tls" />);
    expect(screen.getByText(/the relay operator can read your changes/i)).toBeInTheDocument();
  });

  it('never calls itself encrypted', () => {
    const { container } = renderIn('en', <PostureStatement transport="relay-tls" />);
    expect(container.textContent?.toLowerCase()).not.toContain('encrypted');
  });

  it('carries the extra readability warning, which the other transports do not', () => {
    const relay = renderIn('en', <RelayReadabilityWarning transport="relay-tls" />);
    expect(relay.container.textContent?.length ?? 0).toBeGreaterThan(0);
    relay.unmount();

    for (const transport of ['local-daemon', 'relay-e2e'] as const) {
      const other = renderIn('en', <RelayReadabilityWarning transport={transport} />);
      expect(other.container.textContent).toBe('');
      other.unmount();
    }
  });
});

describe('the posture chip', () => {
  it.each(TRANSPORTS)('pairs %s with the sentence, never a marker alone', (transport) => {
    const { container } = renderIn('en', <PostureChip transport={transport} />);
    expect(screen.getByText(PRIVACY_POSTURE[transport])).toBeInTheDocument();
    // The coloured dot is decorative and hidden; the sentence is the label.
    // A colour alone fails WCAG 2.2 §1.4.1 and fails a new user who has not yet
    // learned what green means here.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
