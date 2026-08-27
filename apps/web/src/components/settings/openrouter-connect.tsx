'use client';

import { useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { pageOrigin } from '@/lib/daemon/config';
import { AUTHORIZE_URL, EXCHANGE_URL, startAuthorization } from '@/lib/keys/openrouter-oauth';
import { vaultAvailability } from '@/lib/keys/vault';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';

/**
 * OpenRouter OAuth (M23) — the path where the user never handles a credential.
 *
 * What happens when the button is pressed, in order: a PKCE verifier is
 * generated and kept in this tab's `sessionStorage`, its SHA-256 challenge goes
 * on the authorization URL, and the browser leaves. OpenRouter returns to
 * `/settings/keys/callback` with a code; that page redeems it — from the
 * browser, directly against OpenRouter, because ADR-006 leaves the redemption
 * nowhere else to run — and seals the result into the vault.
 *
 * The panel names both endpoints on screen. That is not decoration: this app's
 * whole claim about keys is that the user can see where their credential goes,
 * and a "Connect" button that hides the two hosts it is about to talk to is
 * asking for the same trust every other product asks for.
 *
 * It also says, plainly, that the endpoints are transcribed rather than
 * verified from inside this repository — see the header of
 * `lib/keys/openrouter-oauth.ts` and its TODO(M23). A flow that has not been
 * exercised against a live server is a flow that might fail, and the user
 * finding that out from a clear sentence beforehand is better than finding out
 * from an error afterwards.
 */
export function OpenRouterConnect() {
  const { t, locale } = useLocale();
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const begin = async () => {
    setFailure(null);

    // The vault is where the credential lands, so a vault that cannot operate
    // means a flow that would complete and have nowhere to put its result.
    // Refusing before the redirect is better than refusing after it.
    const blocked = vaultAvailability();
    if (blocked) {
      setFailure(t(`settings.keys.vault.unavailableReason.${blocked.reason}`));
      return;
    }

    setStarting(true);
    try {
      const url = await startAuthorization({
        locale,
        origin: pageOrigin(),
        returnTo: `/${locale}/settings/keys`,
      });
      window.location.assign(url);
    } catch (error) {
      setStarting(false);
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Register labelId="reg-oauth" title={t('settings.keys.oauth.title')}>
      <div className="flex flex-col gap-4">
        <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
          {t('settings.keys.oauth.lede')}
        </p>

        <ol className="flex list-decimal flex-col gap-1 ps-5 text-[0.875rem]">
          <li>{t('settings.keys.oauth.step1')}</li>
          <li>{t('settings.keys.oauth.step2')}</li>
          <li>{t('settings.keys.oauth.step3')}</li>
        </ol>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]">
          <dt className="text-fg-muted">{t('settings.keys.oauth.authorizeAt')}</dt>
          <dd className="min-w-0 break-words text-fg">
            <Code>{AUTHORIZE_URL}</Code>
          </dd>
          <dt className="text-fg-muted">{t('settings.keys.oauth.exchangeAt')}</dt>
          <dd className="min-w-0 break-words text-fg">
            <Code>{EXCHANGE_URL}</Code>
          </dd>
        </dl>

        <p className="max-w-[var(--fb-measure)] rounded-sm border border-rule bg-attend-wash p-3 text-[0.875rem] text-fg">
          {t('settings.keys.oauth.unverified')}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button weight="secondary" onClick={() => void begin()} disabled={starting}>
            {starting ? t('settings.keys.oauth.starting') : t('settings.keys.oauth.start')}
          </Button>
        </div>

        <p aria-live="polite" className={`text-[0.8125rem] text-halt ${failure ? '' : 'fb-sr-only'}`}>
          {failure ?? ''}
        </p>
      </div>
    </Register>
  );
}
