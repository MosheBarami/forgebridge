'use client';

import { PRIVACY_POSTURE, type TransportKind } from '@forgebridge/protocol';

import { useLocale } from '@/i18n/dictionary-context';
import { StatusChip, type Status } from '@/components/ui/status-dot';

/**
 * The privacy posture, rendered the way ADR-014 requires and no other way.
 *
 * The mitigation clause, verbatim: *"the link indicator names the posture in
 * the UI at all times ('Local — private' / 'Relay — apple.gg can read changes'
 * / 'Relay — end-to-end encrypted'), never a padlock icon alone."*
 *
 * So the string below is `PRIVACY_POSTURE[transport]` from the protocol,
 * character for character. It is not translated, not shortened, not truncated
 * for a narrow viewport and never replaced by an icon. In particular the
 * `relay-tls` string says *"the relay operator can read your changes"* — those
 * words, that claim — and no code path in this app substitutes the word
 * "encrypted" for it. A relay under TLS is encrypted *to a server that reads
 * the plaintext*, and calling that "encrypted" in a product whose competitor's
 * users would not know the difference is precisely the lie the ADR was written
 * to refuse.
 *
 * `lang="en"` and `dir="ltr"` on the string: in the Hebrew locale this is an
 * English sentence inside an RTL page, and both attributes are needed for a
 * screen reader to pronounce it in English and for the bidi algorithm to leave
 * its punctuation where the protocol put it. The Hebrew gloss beneath it is
 * marked as what it is — an explanation, not the statement.
 */

/**
 * `live` only for the two transports where nothing unauthorised can read the
 * payload. `relay-tls` is `attend`, not `live` and not `halt`: it works, it is
 * a legitimate choice, and it has a consequence the user must keep in mind —
 * which is exactly what `attend` means in this palette.
 */
const POSTURE_STATUS: Record<TransportKind, Status> = {
  'local-daemon': 'live',
  'relay-tls': 'attend',
  'relay-e2e': 'live',
};

export function PostureStatement({
  transport,
  /** The daemon's own `privacyPosture` when there is one; it asserted it about itself. */
  posture,
  showGloss = true,
}: {
  transport: TransportKind;
  posture?: string | undefined;
  showGloss?: boolean;
}) {
  const { t, locale } = useLocale();
  // Prefer what the daemon said; fall back to the protocol constant keyed by
  // transport. Both paths produce one of the three exact strings — there is no
  // third source and no place a paraphrase could enter.
  const statement = posture && posture.length > 0 ? posture : PRIVACY_POSTURE[transport];

  return (
    <div className="flex flex-col gap-2">
      <p lang="en" dir="ltr" className="text-[0.9375rem] font-medium text-fg">
        {statement}
      </p>
      {showGloss && locale !== 'en' ? (
        <p className="fb-meta">{t(`link.postureGloss.${transport}`)}</p>
      ) : null}
    </div>
  );
}

/**
 * The posture as a one-line chip, for a row in a list of transports.
 *
 * The chip pairs the state colour with the posture text, never the colour
 * alone — `StatusDot` is `aria-hidden` and the sentence is the label.
 */
export function PostureChip({ transport }: { transport: TransportKind }) {
  return (
    <StatusChip status={POSTURE_STATUS[transport]}>
      <span lang="en" dir="ltr">
        {PRIVACY_POSTURE[transport]}
      </span>
    </StatusChip>
  );
}

/**
 * The extra sentence a relay-under-TLS link gets, on top of its posture string.
 *
 * It is not a duplicate of the posture: the posture states the fact, this
 * states what follows from it — that the operator's staff, the operator's
 * logs and anyone who compels the operator sees the Luau a model wrote for
 * your place, and that switching to the local daemon is the fix. It renders
 * only for `relay-tls`, because on the other two transports it would be false.
 */
export function RelayReadabilityWarning({ transport }: { transport: TransportKind }) {
  const { t } = useLocale();
  if (transport !== 'relay-tls') return null;

  return (
    <p className="max-w-[var(--fb-measure)] rounded-sm border border-rule bg-attend-wash p-3 text-[0.875rem] text-fg">
      {t('link.relayWarning')}
    </p>
  );
}
