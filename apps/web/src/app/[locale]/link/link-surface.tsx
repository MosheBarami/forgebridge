'use client';

import { useEffect, useState } from 'react';
import { PAIRING, TransportKind as TransportKindSchema, type Link as ProtocolLink, type TransportKind } from '@forgebridge/protocol';

import { useLocale } from '@/i18n/dictionary-context';
import { primaryLink, useBridge } from '@/lib/daemon/use-daemon';
import { DaemonEmptyState } from '@/components/daemon-empty-state';
import { PostureChip, PostureStatement, RelayReadabilityWarning } from '@/components/settings/posture';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';
import { StatusChip, type Status } from '@/components/ui/status-dot';

/**
 * The link surface: which transport is carrying changes, what that means for
 * who can read them, and how a Studio session gets attached to it.
 *
 * It is a surface of its own rather than a settings section because ADR-014's
 * mitigation is that the posture is named *at all times*, and because the
 * pairing flow is something a user does at a moment — with Studio open beside
 * the browser — rather than a preference they set once.
 *
 * ── Two honest limits, stated on screen rather than worked around ───────────
 *
 * 1. **The transport is not a choice this build can offer.** The daemon reports
 *    `local-daemon` and there is no relay in this repository to report anything
 *    else. So all three postures are shown — the user is entitled to compare
 *    them before choosing a product — with the two that do not exist marked
 *    unavailable and the reason named. That is ADR-006's mitigation pattern
 *    ("the selector shows *why* something is unavailable and what unlocks it,
 *    inline") applied to transports.
 *
 * 2. **The pairing code cannot be shown here, and that is the daemon working.**
 *    `GET /v1/link` reports only that a code is outstanding, never the code
 *    itself; the daemon's own comment says serving it "would hand it to
 *    anything that can reach the port and defeat the whole point of carrying it
 *    by hand". So this page shows the code's *status* — time left, attempts
 *    left — and points at the terminal. There is also no route to issue a new
 *    one, so "get another code" is "restart the daemon" and is written that way.
 *
 * TODO(M38): a `POST /v1/link/code` that issues a fresh pairing code to an
 * authenticated producer would let this page replace an expired code without a
 * restart. It must still refuse to *return* the code — issuing and printing are
 * the daemon's job; the browser only needs to know a new one exists. Owner: the
 * daemon maintainer.
 */

/** Every transport the protocol knows. Read from the schema, never restated. */
const ALL_TRANSPORTS = TransportKindSchema.options;

/** Which of them this build can actually put a link on. */
function availabilityKeyFor(transport: TransportKind): string | null {
  switch (transport) {
    case 'local-daemon':
      return null;
    case 'relay-tls':
      // No relay exists in this repository. ADR-004 has the transport split;
      // nothing has been built on the far end of it yet.
      return 'link.transport.unavailable.noRelay';
    case 'relay-e2e':
      // ADR-014 gates this behind a spike and an external review of a pure-Luau
      // X25519 + ChaCha20-Poly1305 implementation. Being wrong about crypto is
      // worse than being late about it.
      return 'link.transport.unavailable.gated';
    default:
      return 'link.transport.unavailable.noRelay';
  }
}

function linkStatus(link: ProtocolLink): Status {
  switch (link.state) {
    case 'paired':
      return 'live';
    case 'pairing':
      return 'attend';
    case 'expired':
    case 'revoked':
      return 'halt';
    default:
      return 'idle';
  }
}

export function LinkSurface() {
  const { t, locale } = useLocale();
  const { state, refresh, refreshing } = useBridge();

  if (state.kind === 'probing') {
    return <p className="fb-meta">{t('link.checking')}</p>;
  }
  if (state.kind === 'absent') {
    return <DaemonEmptyState onRetry={refresh} retrying={refreshing} />;
  }

  const active = primaryLink(state.link);
  const activeTransport = active?.transport ?? state.health.transport;
  const links = state.link?.links ?? [];

  return (
    <div className="flex flex-col gap-5">
      <Register
        labelId="reg-posture"
        title={t('link.posture')}
        meta={<Code>{state.health.boundTo}</Code>}
      >
        <div className="flex flex-col gap-4">
          <PostureStatement transport={activeTransport} posture={state.link?.privacyPosture} />
          <RelayReadabilityWarning transport={activeTransport} />
        </div>
      </Register>

      <Register labelId="reg-transport" title={t('link.transport.title')}>
        <div className="flex flex-col gap-4">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('link.transport.lede')}
          </p>

          <ul className="flex list-none flex-col gap-px">
            {ALL_TRANSPORTS.map((transport) => {
              const unavailableKey = availabilityKeyFor(transport);
              const current = transport === activeTransport;
              return (
                <li
                  key={transport}
                  className={
                    'flex flex-col gap-2 rounded-sm border border-rule p-3 ' +
                    (current ? 'bg-sunken' : 'bg-transparent')
                  }
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Code>{transport}</Code>
                    {current ? (
                      <span className="fb-label">{t('link.transport.active')}</span>
                    ) : unavailableKey ? (
                      <span className="fb-label">{t('link.transport.unavailable.label')}</span>
                    ) : null}
                  </div>
                  <PostureChip transport={transport} />
                  {unavailableKey ? (
                    <p className="fb-meta max-w-[var(--fb-measure)]">{t(unavailableKey)}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </Register>

      <PairingRegister
        pairing={state.link?.pairing ?? null}
        hasLink={links.some((link) => link.state === 'paired')}
      />

      <Register
        labelId="reg-sessions"
        title={t('link.sessions.title')}
        meta={String(links.length)}
      >
        {links.length === 0 ? (
          <p className="fb-meta max-w-[var(--fb-measure)]">{t('link.sessions.none')}</p>
        ) : (
          <ul className="flex list-none flex-col gap-3">
            {links.map((link) => (
              <li key={link.id} className="flex flex-col gap-2 border-b border-rule pb-3 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip status={linkStatus(link)}>{t(`link.state.${link.state}`)}</StatusChip>
                  <Code>{link.transport}</Code>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
                  <dt className="text-fg-muted">{t('link.detail.plugin')}</dt>
                  <dd className="min-w-0 break-words text-fg">
                    <Code>{link.pluginVersion ?? '—'}</Code>
                  </dd>
                  <dt className="text-fg-muted">{t('link.detail.lastSeen')}</dt>
                  <dd className="min-w-0 text-fg">
                    {link.lastSeenAt ? (
                      <time dateTime={link.lastSeenAt}>
                        {new Date(link.lastSeenAt).toLocaleString(locale)}
                      </time>
                    ) : (
                      <span className="text-fg-faint">{t('link.detail.never')}</span>
                    )}
                  </dd>
                  <dt className="text-fg-muted">{t('link.sessions.keyId')}</dt>
                  <dd className="min-w-0 break-words text-fg">
                    {/*
                      The session key *identifier*, which is a hash and is safe
                      to display — the key itself is never persisted, never
                      logged and never served. The protocol's own field comment
                      draws that line; this row is what makes it visible.
                    */}
                    <Code>{link.sessionKeyId ?? '—'}</Code>
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 border-t border-rule pt-3">
          <Button weight="secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? t('daemon.absent.retrying') : t('link.sessions.refresh')}
          </Button>
        </div>
      </Register>
    </div>
  );
}

/**
 * The pairing register.
 *
 * The code's TTL is a real deadline — ten minutes, five attempts, single use,
 * all three fixed by the protocol and none of them configurable — so a user
 * halfway through typing it into Studio needs to know how long is left. The
 * countdown ticks every second but is `aria-hidden`: a live region that
 * announces a new number sixty times a minute is a live region a screen-reader
 * user turns off. The accessible content is the absolute expiry time beside it,
 * which does not change.
 */
function PairingRegister({
  pairing,
  hasLink,
}: {
  pairing: { expiresAt: string; attemptsRemaining: number } | null;
  hasLink: boolean;
}) {
  const { t, locale } = useLocale();

  return (
    <Register labelId="reg-pairing" title={t('link.pairing.title')}>
      <div className="flex flex-col gap-4">
        {pairing ? (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <StatusChip status="attend">{t('link.pairing.outstanding')}</StatusChip>
              <Countdown expiresAt={pairing.expiresAt} locale={locale} />
              <span className="fb-meta">
                {t('link.pairing.attempts', { remaining: pairing.attemptsRemaining })}
              </span>
            </div>
            <ol className="flex list-decimal flex-col gap-2 ps-5 text-[0.875rem]">
              <li>{t('link.pairing.step1')}</li>
              <li>{t('link.pairing.step2')}</li>
              <li>{t('link.pairing.step3')}</li>
            </ol>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <StatusChip status={hasLink ? 'live' : 'idle'}>
              {t(hasLink ? 'link.pairing.paired' : 'link.pairing.none')}
            </StatusChip>
            <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
              {t(hasLink ? 'link.pairing.pairedBody' : 'link.pairing.noneBody')}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          <p className="fb-label">{t('link.pairing.whyNotShown')}</p>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('link.pairing.whyNotShownBody')}</p>
          <p className="max-w-[var(--fb-measure)] fb-meta">
            {t('link.pairing.limits', {
              minutes: PAIRING.TTL_SECONDS / 60,
              attempts: PAIRING.MAX_ATTEMPTS,
              length: PAIRING.CODE_LENGTH,
            })}
          </p>
        </div>
      </div>
    </Register>
  );
}

function Countdown({ expiresAt, locale }: { expiresAt: string; locale: string }) {
  const { t } = useLocale();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Started in an effect, not during render: the server has a different clock
    // and rendering a remaining-time on it would hydrate into a mismatch.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const expiry = Date.parse(expiresAt);
  const remainingMs = now === null ? null : Math.max(0, expiry - now);

  return (
    <span className="inline-flex items-baseline gap-2">
      <time dateTime={expiresAt} className="fb-meta">
        {t('link.pairing.expiresAt', { when: new Date(expiry).toLocaleTimeString(locale) })}
      </time>
      {remainingMs === null ? null : (
        <span aria-hidden="true" className="font-mono text-[0.8125rem] text-fg-muted" dir="ltr">
          {formatRemaining(remainingMs)}
        </span>
      )}
    </span>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
