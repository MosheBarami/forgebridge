'use client';

import NextLink from 'next/link';

import { useLocale } from '@/i18n/dictionary-context';
import { useBridge, primaryLink } from '@/lib/daemon/use-daemon';
import { usePreferences } from '@/lib/settings/use-preferences';
import { useVault } from '@/lib/keys/use-vault';
import { PostureStatement } from './posture';
import { ACTION_LINK_CLASS } from './field';
import { Register } from '@/components/ui/register';
import { StatusChip } from '@/components/ui/status-dot';

/**
 * The settings overview: the current answer to each section's question, in one
 * screen, with a way into the section that owns it.
 *
 * Deliberately not a menu. A settings index that lists six links and six
 * descriptions makes the user open all six to find out what their settings
 * *are*. Every row here states the value first — auto-apply off, free-first,
 * one credential held, this posture — and offers the link second.
 *
 * Two rows are honest about not knowing:
 *
 *   - the daemon's own provider credential, which no route reports (see the
 *     header of `settings/keys/page.tsx`);
 *   - the link, while the daemon has not answered yet, which is `probing`
 *     rather than a guess at either outcome.
 */
export function SettingsOverview({ locale }: { locale: string }) {
  const { t } = useLocale();
  const { state: preferences } = usePreferences();
  const { state: bridge } = useBridge();
  const vault = useVault();

  const { autoApply, routing } = preferences.value;
  const link = bridge.kind === 'present' ? primaryLink(bridge.link) : null;
  const transport = bridge.kind === 'present' ? (link?.transport ?? bridge.health.transport) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Register labelId="ov-approval" title={t('settings.section.approval')}>
        <div className="flex flex-col gap-3">
          <StatusChip status={autoApply?.enabled ? 'attend' : 'live'}>
            {t(autoApply?.enabled ? 'settings.overview.autoOn' : 'settings.overview.autoOff')}
          </StatusChip>
          <p className="fb-meta">
            {autoApply?.enabled
              ? t('settings.overview.autoScope', { prefix: autoApply.pathPrefix })
              : t('settings.overview.autoOffBody')}
          </p>
          <NextLink href={`/${locale}/settings/approval`} className={ACTION_LINK_CLASS}>
            {t('settings.overview.open')}
          </NextLink>
        </div>
      </Register>

      <Register labelId="ov-models" title={t('settings.section.models')}>
        <div className="flex flex-col gap-3">
          <p className="text-[0.9375rem] text-fg">
            {t(`settings.models.policyName.${routing.policy}`)}
          </p>
          <p className="fb-meta">
            {routing.policy === 'pinned' && routing.pinnedModelId
              ? t('settings.overview.pinnedTo', { model: routing.pinnedModelId })
              : t('settings.overview.catalogHint')}
          </p>
          <NextLink href={`/${locale}/settings/models`} className={ACTION_LINK_CLASS}>
            {t('settings.overview.open')}
          </NextLink>
        </div>
      </Register>

      <Register labelId="ov-keys" title={t('settings.section.keys')}>
        <div className="flex flex-col gap-3">
          <StatusChip status={vault.entries.length > 0 ? 'live' : 'idle'}>
            {t(
              vault.entries.length > 0
                ? 'settings.overview.vaultHeld'
                : 'settings.overview.vaultEmpty',
            )}
          </StatusChip>
          {/*
            The second sentence is the important one: whatever the vault holds,
            this page cannot say whether the *daemon* has a credential, because
            no route reports it. Saying so here stops the chip above from being
            read as an answer to the question the user actually has.
          */}
          <p className="fb-meta">{t('settings.overview.daemonCredentialUnknown')}</p>
          <NextLink href={`/${locale}/settings/keys`} className={ACTION_LINK_CLASS}>
            {t('settings.overview.open')}
          </NextLink>
        </div>
      </Register>

      <Register labelId="ov-link" title={t('settings.section.link')}>
        <div className="flex flex-col gap-3">
          {bridge.kind === 'probing' ? (
            <p className="fb-meta">{t('link.checking')}</p>
          ) : bridge.kind === 'absent' ? (
            <>
              <StatusChip status="halt">{t('link.state.unreachable')}</StatusChip>
              <p className="fb-meta">{t('settings.overview.noDaemon')}</p>
            </>
          ) : transport ? (
            <PostureStatement
              transport={transport}
              posture={bridge.link?.privacyPosture}
              showGloss={false}
            />
          ) : null}
          <NextLink href={`/${locale}/link`} className={ACTION_LINK_CLASS}>
            {t('settings.overview.open')}
          </NextLink>
        </div>
      </Register>

      <Register
        labelId="ov-storage"
        title={t('settings.overview.storageTitle')}
        className="lg:col-span-2"
      >
        <div className="flex flex-col gap-3">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
            {t('settings.overview.storageBody')}
          </p>
          {preferences.status === 'unavailable' ? (
            <p className="text-[0.8125rem] text-halt">
              {t('settings.storageUnavailable', { detail: preferences.detail })}
            </p>
          ) : (
            <p className="fb-meta">{t('settings.overview.storageAdoption')}</p>
          )}
        </div>
      </Register>
    </div>
  );
}
