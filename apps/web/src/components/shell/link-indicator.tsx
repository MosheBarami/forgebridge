'use client';

import type { ReactNode } from 'react';
import type { Link as ProtocolLink } from '@forgebridge/protocol';

import { useLocale } from '@/i18n/dictionary-context';
import { postureFor, primaryLink, useBridge, type BridgeState } from '@/lib/daemon/use-daemon';
import { Code } from '@/components/ui/code';
import { StatusDot, type Status } from '@/components/ui/status-dot';

/**
 * The link register — the one thing that is on screen everywhere.
 *
 * ADR-014's mitigation, in its own words: "the link indicator names the posture
 * in the UI at all times ('Local — private' / 'Relay — apple.gg can read
 * changes' / 'Relay — end-to-end encrypted'), never a padlock icon alone."
 *
 * So the string below is the protocol's, verbatim, character for character. It
 * is not translated, not shortened for a narrow viewport, not replaced by an
 * icon, and never abbreviated to the word "encrypted" for a relay that is not.
 * Three of the five things this product does differently rest on a user
 * believing what this line says; a paraphrase that drifted by one word would
 * spend that.
 *
 * On the Hebrew locale that means an English sentence appears in a Hebrew
 * interface. That is the deliberate trade: the posture is a contract term, and
 * a translation of a contract term is a second string that can disagree with
 * the first. The Hebrew gloss lives underneath it in the detail view, marked as
 * what it is — an explanation, not the statement.
 */

function statusFor(state: BridgeState, link: ProtocolLink | null): Status {
  if (state.kind !== 'present') return state.kind === 'probing' ? 'idle' : 'halt';
  if (!link) return 'attend';
  switch (link.state) {
    case 'paired':
      return 'live';
    case 'pairing':
      return 'attend';
    case 'expired':
    case 'revoked':
      return 'halt';
    default:
      return 'attend';
  }
}

function stateKey(state: BridgeState, link: ProtocolLink | null): string {
  if (state.kind === 'probing') return 'link.checking';
  if (state.kind === 'absent') return 'link.state.unreachable';
  if (!link) return 'link.state.unpaired';
  return `link.state.${link.state}`;
}

/**
 * The compact form, for the utility bar.
 *
 * `aria-live="polite"` because the value changes without the user doing
 * anything — a Studio session pairs, a daemon is started in another window —
 * and a state change nobody is told about is a state change nobody acts on.
 * Polite rather than assertive: it is worth knowing, never worth interrupting.
 */
export function LinkIndicator() {
  const { t } = useLocale();
  const { state } = useBridge();
  const link = state.kind === 'present' ? primaryLink(state.link) : null;
  const posture =
    state.kind === 'present' ? postureFor(state.link, link?.transport ?? state.health.transport) : null;

  return (
    <div
      aria-live="polite"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className="fb-label">{t('link.label')}</span>

      <span className="inline-flex items-center gap-2 text-[0.875rem] font-medium text-fg">
        <StatusDot status={statusFor(state, link)} />
        {t(stateKey(state, link))}
      </span>

      {posture ? (
        // `lang="en"` and `dir="ltr"` so a screen reader in a Hebrew page
        // pronounces this English sentence in English, and the bidi algorithm
        // leaves its punctuation where the protocol put it.
        <span lang="en" dir="ltr" className="fb-meta min-w-0">
          {posture}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The full form, for the bridge page: the same posture string plus the facts
 * behind it — which daemon, which protocol, which project, which plugin.
 */
export function LinkDetail() {
  const { t, locale } = useLocale();
  const { state } = useBridge();

  if (state.kind === 'probing') {
    return <p className="fb-meta">{t('link.checking')}</p>;
  }
  if (state.kind === 'absent') {
    return null; // The empty state owns this case; see `daemon-empty-state.tsx`.
  }

  const link = primaryLink(state.link);
  const transport = link?.transport ?? state.health.transport;
  const posture = postureFor(state.link, transport);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="inline-flex items-center gap-2 text-[0.9375rem] font-medium text-fg">
          <StatusDot status={statusFor(state, link)} />
          {t(stateKey(state, link))}
        </span>

        {posture ? (
          <p lang="en" dir="ltr" className="text-[0.875rem] text-fg">
            {posture}
          </p>
        ) : null}

        {/*
          The gloss. Only shown when the interface language is not the language
          the posture string is written in — in English it would be the same
          sentence twice.
        */}
        {locale !== 'en' ? (
          <p className="fb-meta">{t(`link.postureGloss.${transport}`)}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]">
        <Fact label={t('link.detail.daemon')}>
          <Code>{state.health.version}</Code>
        </Fact>
        <Fact label={t('link.detail.protocol')}>
          <Code>{state.health.protocolVersion}</Code>
        </Fact>
        <Fact label={t('link.detail.boundTo')}>
          <Code>{state.health.boundTo}</Code>
        </Fact>
        {state.link ? (
          <Fact label={t('link.detail.project')}>
            <Code>{state.link.defaultProjectId}</Code>
          </Fact>
        ) : null}
        {link ? (
          <>
            <Fact label={t('link.detail.plugin')}>
              <Code>{link.pluginVersion ?? '—'}</Code>
            </Fact>
            <Fact label={t('link.detail.lastSeen')}>
              {link.lastSeenAt ? (
                <time dateTime={link.lastSeenAt}>
                  {new Date(link.lastSeenAt).toLocaleString(locale)}
                </time>
              ) : (
                <span className="text-fg-faint">{t('link.detail.never')}</span>
              )}
            </Fact>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </>
  );
}
