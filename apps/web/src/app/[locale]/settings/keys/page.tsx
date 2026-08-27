import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { KeyVaultPanel } from '@/components/settings/key-vault';
import { OpenRouterConnect } from '@/components/settings/openrouter-connect';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';

/**
 * Settings → Keys.
 *
 * ADR-006 has four custody rows. Three of them are reachable from a browser and
 * all three are on this page, **ordered by what actually works today** rather
 * than by what is most impressive:
 *
 *   1. the OS keychain, read by the daemon — the strongest and the only one
 *      that can drive a run right now;
 *   2. an environment variable, read by the daemon — weaker, and the page says
 *      how much weaker in the daemon's own words;
 *   3. the browser vault — the future BYOK path, real, encrypted, and with no
 *      egress yet.
 *
 * OpenRouter OAuth sits above the vault because it is the flow where a user
 * never handles a credential at all, and it lands in the vault when it works.
 *
 * ── What this page cannot tell you, and says so ────────────────────────────
 *
 * Whether the daemon actually found a credential. No route reports it: `/v1/
 * health` carries version, transport and uptime, and `/v1/models` reports the
 * registry rather than the provider. The daemon prints `Provider key: found in
 * <backend>` on the terminal at startup, and that terminal is the only place
 * the answer exists. Guessing here — by starting a run to see whether it fails
 * with `provider_unconfigured` — would spend a model attempt to learn something
 * a one-field response could carry.
 *
 * TODO(M38): a `providerCredentialConfigured: boolean` and the backend's label
 * on `GET /v1/health` would let this page answer the first question every user
 * arriving on it has. It must report *whether*, never *which value*, and the
 * daemon's `SecretsBackendInfo` already has exactly the right shape for it —
 * `{ kind, label, readableByOtherProcesses }`. Owner: the daemon maintainer.
 *
 * The commands below are transcribed from `packages/daemon/src/secrets.ts`
 * (`serviceFor`, `WELL_KNOWN_VARIABLE_NAMES`, `environmentVariableName`) rather
 * than imported: importing them would pull a Node HTTP server package into a
 * browser bundle for three strings. They are checked against that file, and the
 * same TODO(M31) that would move the `/v1` envelopes into the protocol is what
 * would let them be read from one definition instead.
 */

/** `forgebridge.provider` / account `openrouter` — `serviceFor()` in the daemon. */
const KEYCHAIN_ADD = 'security add-generic-password -U -s forgebridge.provider -a openrouter -w';
const KEYCHAIN_DELETE = 'security delete-generic-password -s forgebridge.provider -a openrouter';
/** The provider's own name, accepted so a user who already exported it need not export a second. */
const ENV_WELL_KNOWN = 'OPENROUTER_API_KEY';
/** This project's own form, from `environmentVariableName({ scope: 'provider', name: 'openrouter' })`. */
const ENV_FORGEBRIDGE = 'FORGEBRIDGE_PROVIDER_OPENROUTER';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('settings.section.keys') };
}

export default async function KeysSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('settings.keys.title')}</h1>
        <p className="text-fg-muted">{t('settings.keys.lede')}</p>
      </header>

      <Register labelId="reg-custody" title={t('settings.keys.promise')}>
        <div className="flex flex-col gap-3">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
            {t('settings.keys.promiseBody')}
          </p>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.keys.promiseGate')}</p>
          <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
            {t('settings.keys.cannotReport')}
          </p>
        </div>
      </Register>

      <Register labelId="reg-keychain" title={t('settings.keys.keychain.title')}>
        <div className="flex flex-col gap-3">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('settings.keys.keychain.lede')}
          </p>
          <Code block>{KEYCHAIN_ADD}</Code>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.keys.keychain.promptNote')}</p>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.keys.keychain.removeNote')}</p>
          <Code block>{KEYCHAIN_DELETE}</Code>
          <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
            {t('settings.keys.keychain.platforms')}
          </p>
        </div>
      </Register>

      <Register labelId="reg-env" title={t('settings.keys.env.title')}>
        <div className="flex flex-col gap-3">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('settings.keys.env.lede')}
          </p>
          <Code block>{`export ${ENV_WELL_KNOWN}='…'`}</Code>
          <p className="max-w-[var(--fb-measure)] fb-meta">
            {t('settings.keys.env.alsoAccepted')} <Code>{ENV_FORGEBRIDGE}</Code>
          </p>
          {/*
            The daemon reports this about the environment backend on its own
            startup line, and it is the reason the keychain is listed first
            here: a variable exported into a shell is visible to everything that
            shell starts, and on Linux to anything that can read
            /proc/<pid>/environ for this user.
          */}
          <p className="max-w-[var(--fb-measure)] rounded-sm border border-rule bg-attend-wash p-3 text-[0.875rem] text-fg">
            {t('settings.keys.env.exposure')}
          </p>
        </div>
      </Register>

      <OpenRouterConnect />

      <KeyVaultPanel />
    </div>
  );
}
