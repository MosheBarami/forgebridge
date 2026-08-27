'use client';

import { useEffect, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { useDaemonSession } from '@/lib/daemon/session';
import { useBridge } from '@/lib/daemon/use-daemon';
import type { ModelsSnapshot } from '@/lib/daemon/wire';
import { DaemonEmptyState } from '@/components/daemon-empty-state';
import { LinkDetail } from '@/components/shell/link-indicator';
import { Register } from '@/components/ui/register';
import { StatusChip } from '@/components/ui/status-dot';

/**
 * The bridge surface: three registers — the link, the queue of proposed
 * changes, and the models the router has to choose between.
 *
 * When there is no daemon, this is the whole page: the empty state replaces the
 * registers rather than sitting above three empty boxes. A first-run user has
 * exactly one thing to do and the page should be about that one thing.
 *
 * TODO(M35): the queue register lists ChangeSets in `validated` and links each
 * to its diff. It cannot yet — the daemon has no "list changesets" route, only
 * `GET /v1/changesets/:id/diff`, so there is nothing to enumerate. Owner: the
 * generation-surface agent, together with whoever adds that route.
 */
export function BridgeSurface() {
  const { t, locale } = useLocale();
  const { state, refresh, refreshing } = useBridge();

  if (state.kind === 'absent') {
    return <DaemonEmptyState onRetry={refresh} retrying={refreshing} />;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Register labelId="reg-link" title={t('bridge.linkRegister')}>
        <LinkDetail />
      </Register>

      <Register labelId="reg-queue" title={t('bridge.queueRegister')}>
        <div className="flex flex-col gap-3">
          <StatusChip status="idle">{t('bridge.queueEmptyStatus')}</StatusChip>
          <p className="fb-meta">
            {t('bridge.queueEmpty', { status: t('bridge.queueEmptyStatus') })}
          </p>
          {/*
            The approval promise, stated on the surface where changes arrive
            rather than only in a doc. ADR-012 is the reason this queue exists
            at all: a run stops here, and a human decides.
          */}
          <div className="border-t border-rule pt-3">
            <p className="text-[0.875rem] font-medium text-fg">{t('approval.gate')}</p>
            <p className="fb-meta">{t('approval.explain')}</p>
          </div>
        </div>
      </Register>

      <Register
        labelId="reg-models"
        title={t('bridge.modelsRegister')}
        className="lg:col-span-2"
      >
        <ModelsRegister locale={locale} />
      </Register>
    </div>
  );
}

function ModelsRegister({ locale }: { locale: string }) {
  const { t } = useLocale();
  const { client } = useDaemonSession();
  const [snapshot, setSnapshot] = useState<ModelsSnapshot | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void client.models(controller.signal).then((result) => {
      if (live && result.ok) setSnapshot(result.data);
    });
    return () => {
      live = false;
      controller.abort();
    };
  }, [client]);

  if (!snapshot) return <p className="fb-meta">{t('common.loading')}</p>;

  /**
   * "Free" is derived from the catalog's own `free` flag, which
   * `packages/model-registry` derives from a live price of zero at
   * `verifiedAt` (ADR-007). It is never a hand-written list, and this component
   * does not second-guess it — a UI that decided for itself which models are
   * free would be exactly the stale hard-coded list the ADR exists to prevent.
   */
  const free = snapshot.models.filter((model) => model['free'] === true).length;

  if (!snapshot.configured) {
    return <p className="fb-meta">{t('bridge.modelsUnconfigured')}</p>;
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <p className="text-[0.9375rem] text-fg">
        {t('bridge.modelsCount', { count: snapshot.models.length, free })}
      </p>
      {snapshot.verifiedAt ? (
        <p className="fb-meta">
          {t('bridge.modelsVerified', {
            when: new Date(snapshot.verifiedAt).toLocaleString(locale),
          })}
        </p>
      ) : null}
    </div>
  );
}
