'use client';

import { useId, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { useVault } from '@/lib/keys/use-vault';
import type { VaultUnavailable } from '@/lib/keys/vault';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';
import { StatusChip } from '@/components/ui/status-dot';
import { Field, TextInput } from '@/components/ui/field';

/**
 * The browser key vault, on screen.
 *
 * The panel's job is not to collect a credential. It is to tell the user, in
 * the same glance, three things they are normally never told:
 *
 *   - **where the value goes when they press the button** — into this browser's
 *     own database, encrypted under a key that cannot be exported from this
 *     browser;
 *   - **where it does not go** — no request leaves this page carrying it,
 *     because this app ships no server route for it to be sent to (ADR-006);
 *   - **what it can and cannot do yet** — the daemon has no route that accepts
 *     a credential, so a value sealed here cannot start a run today.
 *
 * The third one is the uncomfortable one and it is stated first in the copy,
 * above the input, rather than in a footnote under it. A panel that took a
 * credential and let the user believe it was now in use would be the exact
 * failure this repository's review culture exists to catch.
 */
export function KeyVaultPanel() {
  const { t, locale } = useLocale();
  const vault = useVault();
  const [draft, setDraft] = useState('');
  const [justSealed, setJustSealed] = useState(false);
  const credentialId = useId();

  const entry = vault.entries.find((candidate) => candidate.providerId === 'openrouter') ?? null;

  return (
    <Register labelId="reg-vault" title={t('settings.keys.vault.title')}>
      <div className="flex flex-col gap-4">
        <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
          {t('settings.keys.vault.lede')}
        </p>

        {/*
          The limitation, above the control rather than below it. A user who
          reads only the first paragraph on this panel should still come away
          with the true picture.
        */}
        <p className="max-w-[var(--fb-measure)] rounded-sm border border-rule bg-attend-wash p-3 text-[0.875rem] text-fg">
          {t('settings.keys.vault.noEgressYet')}
        </p>

        {vault.unavailable ? (
          <VaultUnavailableNote unavailable={vault.unavailable} />
        ) : (
          <>
            {entry ? (
              <div className="flex flex-col gap-3 rounded-sm border border-rule p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip status="live">{t('settings.keys.vault.held')}</StatusChip>
                  <Code>openrouter</Code>
                  {/*
                    The last four characters. Enough to tell two credentials
                    apart, useless as one — the same affordance a provider
                    console offers, and the only thing this page ever shows of
                    a stored value.
                  */}
                  <Code>{`••••${entry.hint}`}</Code>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
                  <dt className="text-fg-muted">{t('settings.keys.vault.source')}</dt>
                  <dd className="text-fg">{t(`settings.keys.vault.sourceName.${entry.source}`)}</dd>
                  <dt className="text-fg-muted">{t('settings.keys.vault.added')}</dt>
                  <dd className="text-fg">
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString(locale)}
                    </time>
                  </dd>
                </dl>
                <div>
                  <Button
                    weight="secondary"
                    onClick={() => {
                      setJustSealed(false);
                      void vault.remove('openrouter');
                    }}
                  >
                    {t('settings.keys.vault.forget')}
                  </Button>
                </div>
              </div>
            ) : null}

            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const entered = draft;
                // Cleared before the await: the value now exists in one place
                // on its way to `crypto.subtle.encrypt`, and not also in React
                // state and a DOM node the browser may offer to autofill later.
                setDraft('');
                void vault.store('openrouter', entered, 'pasted').then(() => {
                  setJustSealed(true);
                  // Submitting clears the field, which disables the submit
                  // button — and a browser moves focus to `<body>` when the
                  // focused element becomes disabled, dropping a keyboard user
                  // out of the panel. Focus returns to the field.
                  document.getElementById(credentialId)?.focus();
                });
              }}
            >
              <Field
                id={credentialId}
                label={t('settings.keys.vault.inputLabel')}
                hint={t('settings.keys.vault.inputHint')}
                error={vault.error}
              >
                {(control) => (
                  <TextInput
                    {...control}
                    type="password"
                    dir="ltr"
                    // Never offered to a password manager and never remembered
                    // by the browser: a provider credential in an autofill
                    // store is a copy this page cannot reach and cannot erase.
                    autoComplete="off"
                    spellCheck={false}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setJustSealed(false);
                    }}
                    placeholder={t('settings.keys.vault.inputPlaceholder')}
                    className="font-mono"
                  />
                )}
              </Field>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" weight="secondary" disabled={draft.trim().length === 0}>
                  {t('settings.keys.vault.seal')}
                </Button>
                {vault.entries.length > 0 ? (
                  <Button
                    weight="secondary"
                    onClick={() => {
                      setJustSealed(false);
                      void vault.removeAll();
                    }}
                  >
                    {t('settings.keys.vault.forgetAll')}
                  </Button>
                ) : null}
              </div>

              {/* Announced, because sealing is silent otherwise — the input clears and nothing else moves. */}
              <p aria-live="polite" className={`text-[0.8125rem] text-fg ${justSealed ? '' : 'fb-sr-only'}`}>
                {justSealed ? t('settings.keys.vault.sealed') : ''}
              </p>
            </form>
          </>
        )}

        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          <p className="fb-label">{t('settings.keys.vault.mechanics')}</p>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-[0.8125rem] text-fg-muted">
            <li>{t('settings.keys.vault.mechanic1')}</li>
            <li>{t('settings.keys.vault.mechanic2')}</li>
            <li>{t('settings.keys.vault.mechanic3')}</li>
            <li>{t('settings.keys.vault.mechanic4')}</li>
          </ul>
        </div>
      </div>
    </Register>
  );
}

/**
 * Why the vault is refusing to operate.
 *
 * `insecure-context` gets its own sentence because it is the one a user can
 * act on: the page is being served over plain HTTP from somewhere that is not
 * loopback, `crypto.subtle` does not exist there, and the honest response is to
 * refuse the credential rather than store it in the clear under a panel called
 * "the vault".
 */
function VaultUnavailableNote({ unavailable }: { unavailable: VaultUnavailable }) {
  const { t } = useLocale();
  const detail = unavailable.reason === 'blocked' ? unavailable.detail : null;

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule bg-halt-wash p-3">
      <StatusChip status="halt">{t('settings.keys.vault.unavailable')}</StatusChip>
      <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
        {t(`settings.keys.vault.unavailableReason.${unavailable.reason}`)}
      </p>
      {detail ? <p className="fb-meta">{detail}</p> : null}
    </div>
  );
}
