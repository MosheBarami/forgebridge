'use client';

import { useEffect, useId, useMemo, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { useDaemonSession } from '@/lib/daemon/session';
import type { ModelsSnapshot } from '@/lib/daemon/wire';
import { usePreferences } from '@/lib/settings/use-preferences';
import { ROUTING_POLICIES } from '@/lib/daemon/wire';
import type { ModelCatalogView, ModelRow } from '@/lib/models/catalog';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';
import { StatusChip, type Status } from '@/components/ui/status-dot';
import { Field, Select, TextInput } from '@/components/ui/field';
import { CheckboxRow, FieldGroup } from './field';

/**
 * The model catalog, browsable.
 *
 * Everything on this screen comes from `packages/model-registry`. There is no
 * list in this file, no fallback list, and no "popular models" shortcut — a
 * hand-maintained model list is wrong within a week and nothing in the build
 * would notice (ADR-007). The rows arrive as a prop from a Server Component
 * that read the shipped snapshot; this component filters and orders them, and
 * asks the daemon what *its* registry says.
 *
 * Five things it insists on showing, because each is a fact a user needs and
 * most model pickers omit:
 *
 *   - **Why a model is free.** Not a "FREE" badge: the derivation's own
 *     sentence. `token-priced at 0 in/out; text output` is a claim someone can
 *     check, and it is the claim that keeps `google/lyria-3-pro-preview` — $0
 *     per token, $0.08 per generated song — out of the list.
 *   - **When the catalog was verified**, as an absolute timestamp with its age
 *     beside it. Sixteen models from a catalog nobody has synced in a month are
 *     sixteen claims about a market that moves weekly.
 *   - **What the daemon's own registry says**, which is the catalog a run would
 *     actually use, and which can differ from the one this deployment shipped.
 *   - **The expiry warning.** Any model within `EXPIRY_WARNING_DAYS` of a
 *     recorded withdrawal date says so, with the date and the days remaining.
 *   - **The models that were excluded, and why.** "Not in the list" and "we
 *     looked at it and it bills per song" are different facts, and only the
 *     second one survives someone asking where their favourite model went.
 */

const SORTS = ['coding', 'intelligence', 'agentic', 'context', 'name'] as const;
type Sort = (typeof SORTS)[number];

function availabilityStatus(row: ModelRow): Status {
  switch (row.availability.kind) {
    case 'ready':
      return 'live';
    case 'expiring':
      return 'attend';
    case 'expired':
      return 'halt';
    case 'incapable':
      return 'idle';
    default:
      return 'idle';
  }
}

function sortValue(row: ModelRow, sort: Sort): number | null {
  switch (sort) {
    case 'coding':
      return row.benchmarks.coding;
    case 'intelligence':
      return row.benchmarks.intelligence;
    case 'agentic':
      return row.benchmarks.agentic;
    case 'context':
      return row.contextTokens;
    case 'name':
      return null;
    default:
      return null;
  }
}

export function ModelsBrowser({ view }: { view: ModelCatalogView }) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [usableOnly, setUsableOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('coding');
  const resultsId = useId();
  const searchId = useId();
  const sortId = useId();

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = view.models.filter((row) => {
      if (freeOnly && !row.free) return false;
      if (usableOnly && row.availability.kind !== 'ready' && row.availability.kind !== 'expiring') {
        return false;
      }
      if (needle.length === 0) return true;
      return (
        row.id.toLowerCase().includes(needle) ||
        row.displayName.toLowerCase().includes(needle) ||
        row.author.toLowerCase().includes(needle)
      );
    });

    if (sort === 'name') {
      return [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName, locale));
    }
    // Unscored last, never as zero — a model nobody measured is not a model
    // that scored badly. This is the one place that rule is applied: the server
    // groups free-first and leaves the rest in catalog order precisely so this
    // ordering lives with the control that chooses it.
    return [...filtered]
      .map((row, position) => ({ row, position, score: sortValue(row, sort) }))
      .sort((a, b) => {
        if (a.score === null && b.score === null) return a.position - b.position;
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        if (a.score !== b.score) return b.score - a.score;
        return a.position - b.position;
      })
      .map((entry) => entry.row);
  }, [view.models, query, freeOnly, usableOnly, sort, locale]);

  return (
    <div className="flex flex-col gap-5">
      <Provenance view={view} />

      <RoutingRegister view={view} />

      <Register
        labelId="reg-catalog"
        title={t('settings.models.catalog')}
        meta={t('settings.models.showing', { shown: rows.length, total: view.models.length })}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:gap-6">
            <Field
              id={searchId}
              label={t('settings.models.search')}
              hint={t('settings.models.searchHint')}
              className="min-w-0 flex-1"
            >
              {(control) => (
                <TextInput
                  {...control}
                  type="search"
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  // The result count is the live region; the input points at it
                  // so a screen reader user knows where the answer appeared.
                  aria-controls={resultsId}
                  className="font-mono"
                />
              )}
            </Field>

            <Field id={sortId} label={t('settings.models.sort')}>
              {(control) => (
                <Select
                  {...control}
                  value={sort}
                  onChange={(event) => setSort(event.target.value as Sort)}
                >
                  {SORTS.map((option) => (
                    <option key={option} value={option}>
                      {t(`settings.models.sortBy.${option}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <FieldGroup legend={t('settings.models.filters')}>
            <CheckboxRow
              label={t('settings.models.freeOnly')}
              description={t('settings.models.freeOnlyHint')}
              checked={freeOnly}
              onChange={setFreeOnly}
            />
            <CheckboxRow
              label={t('settings.models.usableOnly')}
              description={t('settings.models.usableOnlyHint', {
                capabilities: view.requiredCapabilities.join(', '),
              })}
              checked={usableOnly}
              onChange={setUsableOnly}
            />
          </FieldGroup>

          {/*
            Polite, and it says the number rather than "results updated": a
            count is the thing that changed and the thing worth hearing.
          */}
          <p id={resultsId} aria-live="polite" className="fb-meta">
            {t('settings.models.showing', { shown: rows.length, total: view.models.length })}
          </p>

          {rows.length === 0 ? (
            <p className="fb-meta">{t('settings.models.noMatches')}</p>
          ) : (
            <ul className="flex list-none flex-col gap-px">
              {rows.map((row) => (
                <ModelCard key={row.id} row={row} />
              ))}
            </ul>
          )}
        </div>
      </Register>

      <Register
        labelId="reg-excluded"
        title={t('settings.models.excluded')}
        meta={String(view.excluded.length)}
      >
        <div className="flex flex-col gap-3">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('settings.models.excludedLede')}
          </p>
          <ul className="flex list-none flex-col gap-3">
            {view.excluded.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 border-b border-rule pb-3 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-3">
                  <Code>{entry.id}</Code>
                  <span className="fb-label">{entry.reason}</span>
                </div>
                <p className="max-w-[var(--fb-measure)] fb-meta">{entry.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      </Register>
    </div>
  );
}

function Provenance({ view }: { view: ModelCatalogView }) {
  const { t, locale } = useLocale();
  const { provenance } = view;

  return (
    <Register
      labelId="reg-provenance"
      title={t('settings.models.provenance')}
      meta={<Code>{provenance.source}</Code>}
    >
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.875rem]">
          <dt className="text-fg-muted">{t('settings.models.verifiedAt')}</dt>
          <dd className="min-w-0 text-fg">
            {/*
              Absolute, not "3 days ago". A relative timestamp on a page a user
              leaves open overnight is a claim that goes quietly wrong, and this
              one is the provenance behind every price on the screen.
            */}
            <time dateTime={provenance.verifiedAt}>
              {new Date(provenance.verifiedAt).toLocaleString(locale)}
            </time>
          </dd>

          <dt className="text-fg-muted">{t('settings.models.counts')}</dt>
          <dd className="min-w-0 text-fg">
            {t('settings.models.countsValue', {
              listed: view.models.length,
              free: provenance.freeCount,
              total: provenance.catalogTotal,
            })}
          </dd>

          <dt className="text-fg-muted">{t('settings.models.ready')}</dt>
          <dd className="min-w-0 text-fg">
            {t('settings.models.readyValue', {
              ready: provenance.readyCount,
              capabilities: view.requiredCapabilities.join(', '),
            })}
          </dd>

          <dt className="text-fg-muted">{t('settings.models.age')}</dt>
          <dd className="min-w-0 text-fg">
            {t('settings.models.ageValue', { days: Math.floor(provenance.ageDays) })}
          </dd>
        </dl>

        <LiveProvenance snapshotVerifiedAt={provenance.verifiedAt} />

        {provenance.expiringCount > 0 ? (
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
            {t('settings.models.expiringSummary', { count: provenance.expiringCount })}
          </p>
        ) : null}
      </div>
    </Register>
  );
}

/**
 * The default routing policy and the optional pin.
 *
 * It sits on this page rather than on the generation surface because it is a
 * *default* — a run may override it — and because the choice only makes sense
 * next to the catalog it is choosing between. `pinned` is the one policy that
 * needs a second value, so the model select is disabled until it is chosen and
 * the reason is on the field rather than in a tooltip.
 */
function RoutingRegister({ view }: { view: ModelCatalogView }) {
  const { t } = useLocale();
  const { state, update } = usePreferences();
  const { routing } = state.value;
  const policyId = useId();
  const pinnedId = useId();

  const pinnable = view.models.filter(
    (row) => row.availability.kind === 'ready' || row.availability.kind === 'expiring',
  );

  return (
    <Register labelId="reg-routing" title={t('settings.models.routing')}>
      <div className="flex flex-col gap-4">
        <Field id={policyId} label={t('settings.models.policy')} hint={t('settings.models.policyHint')}>
          {(control) => (
            <Select
              {...control}
              value={routing.policy}
              disabled={state.status === 'loading'}
              onChange={(event) => {
                const policy = event.target.value as (typeof ROUTING_POLICIES)[number];
                void update((current) => ({
                  ...current,
                  routing: { ...current.routing, policy },
                }));
              }}
            >
              {ROUTING_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {t(`settings.models.policyName.${policy}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          id={pinnedId}
          label={t('settings.models.pinned')}
          hint={
            routing.policy === 'pinned'
              ? t('settings.models.pinnedHint')
              : t('settings.models.pinnedInactive')
          }
        >
          {(control) => (
            <Select
              {...control}
              value={routing.pinnedModelId ?? ''}
              disabled={state.status === 'loading' || routing.policy !== 'pinned'}
              onChange={(event) => {
                const value = event.target.value;
                void update((current) => ({
                  ...current,
                  routing: {
                    ...current.routing,
                    pinnedModelId: value.length > 0 ? value : null,
                  },
                }));
              }}
              className="font-mono"
            >
              <option value="">{t('settings.models.pinnedNone')}</option>
              {pinnable.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {state.status === 'unavailable' ? (
          <p className="text-[0.8125rem] text-halt">
            {t('settings.storageUnavailable', { detail: state.detail })}
          </p>
        ) : null}

        <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
          {t('settings.models.routingScope')}
        </p>
      </div>
    </Register>
  );
}

function ModelCard({ row }: { row: ModelRow }) {
  const { t, locale } = useLocale();
  const availability = row.availability;

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-rule p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[0.9375rem] font-medium text-fg">{row.displayName}</p>
          <Code>{row.id}</Code>
        </div>
        <StatusChip status={availabilityStatus(row)}>
          {t(`settings.models.availability.${availability.kind}`)}
        </StatusChip>
      </div>

      {/*
        The free claim and its derivation, together and always. A badge without
        the reason is an assertion; the reason is what makes it checkable.
      */}
      <p className="text-[0.875rem] text-fg">
        {row.free ? t('settings.models.isFree') : t('settings.models.notFree')}{' '}
        <span className="text-fg-muted">— {row.freeReason}</span>
      </p>

      {availability.kind === 'expiring' ? (
        <p className="rounded-sm border border-rule bg-attend-wash p-2 text-[0.875rem] text-fg">
          {t('settings.models.expiring', {
            days: availability.daysLeft,
            when: new Date(availability.expiresAt).toLocaleDateString(locale),
          })}
        </p>
      ) : null}

      {availability.kind === 'expired' ? (
        <p className="rounded-sm border border-rule bg-halt-wash p-2 text-[0.875rem] text-fg">
          {t('settings.models.expired', {
            when: new Date(availability.expiresAt).toLocaleDateString(locale),
          })}
        </p>
      ) : null}

      {availability.kind === 'incapable' ? (
        <p className="text-[0.875rem] text-fg-muted">
          {t('settings.models.incapable', { missing: availability.missing.join(', ') })}
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
        <dt className="text-fg-muted">{t('settings.models.author')}</dt>
        <dd className="min-w-0 text-fg">{row.author}</dd>

        <dt className="text-fg-muted">{t('settings.models.context')}</dt>
        <dd className="min-w-0 text-fg">
          <span dir="ltr">{row.contextTokens.toLocaleString(locale)}</span>
        </dd>

        <dt className="text-fg-muted">{t('settings.models.capabilities')}</dt>
        <dd className="min-w-0 break-words text-fg">
          <Code>{row.capabilities.join(' ') || '—'}</Code>
        </dd>

        <dt className="text-fg-muted">{t('settings.models.benchmarks')}</dt>
        <dd className="min-w-0 text-fg">
          <Benchmarks row={row} />
        </dd>
      </dl>
    </li>
  );
}

/**
 * Three axes, each independently nullable.
 *
 * An unmeasured axis renders as the word for "unmeasured", never as `0` and
 * never as `—` on its own: zero is a score somebody gave, and this is the
 * absence of one. Keeping the two visually distinct is the same rule the
 * registry's `rank` follows when it sorts unscored models last.
 */
function Benchmarks({ row }: { row: ModelRow }) {
  const { t, locale } = useLocale();
  const axes = [
    ['intelligence', row.benchmarks.intelligence],
    ['coding', row.benchmarks.coding],
    ['agentic', row.benchmarks.agentic],
  ] as const;

  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {axes.map(([axis, score]) => (
        <span key={axis} className="inline-flex items-baseline gap-1">
          <span className="text-fg-muted">{t(`settings.models.axis.${axis}`)}</span>
          {score === null ? (
            <span className="text-fg-faint">{t('settings.models.unmeasured')}</span>
          ) : (
            <span dir="ltr" className="font-mono">
              {score.toLocaleString(locale)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * What the *daemon's* registry says, next to what this build shipped.
 *
 * The two can differ, and when they do the difference is the fact that matters:
 * the page is showing the snapshot compiled into this deployment, while a run
 * would use whatever the daemon on this machine has. A settings page that
 * showed only one of them would be quietly answering a different question from
 * the one the reader is asking.
 *
 * It is also where staleness comes from. `ModelsSnapshot.source` already
 * carries the registry's own verdict — the daemon appends "(stale: synced N
 * days ago)" past its threshold — so it is rendered verbatim rather than
 * re-decided here against a second threshold this app invented.
 */
function LiveProvenance({ snapshotVerifiedAt }: { snapshotVerifiedAt: string }) {
  const { t, locale } = useLocale();
  const { client } = useDaemonSession();
  const [live, setLive] = useState<ModelsSnapshot | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    void client.models(controller.signal).then((result) => {
      if (!alive) return;
      setLive(result.ok ? result.data : null);
      setAsked(true);
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [client]);

  if (!asked) return <p className="fb-meta">{t('common.loading')}</p>;

  if (!live) {
    return <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.models.liveNone')}</p>;
  }
  if (!live.configured) {
    return <p className="max-w-[var(--fb-measure)] fb-meta">{t('bridge.modelsUnconfigured')}</p>;
  }

  const same = live.verifiedAt !== null && live.verifiedAt === snapshotVerifiedAt;

  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-3">
      <p className="fb-label">{t('settings.models.liveTitle')}</p>
      <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
        {same
          ? t('settings.models.liveSame', { count: live.models.length })
          : t('settings.models.liveDiffers', {
              count: live.models.length,
              when:
                live.verifiedAt === null
                  ? t('link.detail.never')
                  : new Date(live.verifiedAt).toLocaleString(locale),
            })}
      </p>
      <p className="fb-meta" dir="ltr" lang="en">
        {live.source}
      </p>
    </div>
  );
}
