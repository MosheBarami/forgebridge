'use client';

import { useId } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { Code } from '@/components/ui/code';
import { Disclosure, Field, Select } from '@/components/ui/field';
import { StatusChip } from '@/components/ui/status-dot';
import type { CatalogView, ModelChoice } from './catalog';

/**
 * Picking a model, with the facts that decide the choice on screen (M35).
 *
 * ── The ordering ──────────────────────────────────────────────────────────
 *
 * Free first, then by the published coding index. Not because free is better,
 * but because it is the default routing policy — a selector whose order
 * disagreed with the router's would teach the user a wrong model of what
 * happens when they press the button.
 *
 * ── The grouping, which is the part that matters ──────────────────────────
 *
 * The two `<optgroup>`s are "can drive a run" and "cannot". This pipeline needs
 * tool calling *and* structured output (`DEFAULT_PIPELINE_REQUIREMENTS`), and
 * at the time of writing four of the sixteen free models in the catalog have
 * both. A flat list of sixteen would be a list where three quarters of the
 * entries are choices the router will skip — the user picks one, the run log
 * explains afterwards, and the selector knew all along. So the ineligible ones
 * stay visible (a model that exists and cannot be used is a fact worth having)
 * and stay unselectable.
 *
 * ── What each row says ────────────────────────────────────────────────────
 *
 * Context window and tool calling, as the brief asks, plus structured output —
 * because without it the first two do not add up to a usable model here.
 * `<option>` cannot carry markup, so the row is a single composed line and the
 * full detail lives in the table below the control, where a screen reader and a
 * sighted reader get the same thing.
 */

function formatTokens(tokens: number, locale: string): string {
  // Thousands rather than raw digits: "1,048,576 context" is a number nobody
  // reads, "1,049K" is a size. `Intl` so the separators are the locale's.
  const thousands = Math.round(tokens / 1000);
  return `${new Intl.NumberFormat(locale).format(thousands)}K`;
}

function optionLabel(model: ModelChoice, locale: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const parts = [
    t('generate.models.context', { tokens: formatTokens(model.contextTokens, locale) }),
    model.tools ? t('generate.models.tools') : t('generate.models.noTools'),
    model.structuredOutputs ? t('generate.models.structured') : t('generate.models.noStructured'),
  ];
  return `${model.displayName} — ${parts.join(' · ')}`;
}

export function ModelPicker({
  catalog,
  value,
  onChange,
  disabled = false,
}: {
  catalog: CatalogView;
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useLocale();
  const selectId = useId();

  const eligible = catalog.models.filter((model) => model.eligible);
  const ineligible = catalog.models.filter((model) => !model.eligible);
  const selected = catalog.models.find((model) => model.id === value) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <Field
        id={selectId}
        label={t('generate.models.group.eligible')}
        hint={t('generate.models.requirements', {
          eligible: catalog.summary.eligibleCount,
          total: catalog.models.length,
        })}
      >
        {(described) => (
          <Select
            {...described}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            <optgroup label={t('generate.models.group.eligible')}>
              {eligible.map((model) => (
                <option key={model.id} value={model.id}>
                  {optionLabel(model, locale, t)}
                </option>
              ))}
            </optgroup>
            {ineligible.length > 0 ? (
              <optgroup label={t('generate.models.group.ineligible')}>
                {ineligible.map((model) => (
                  // Disabled, not hidden. "This model exists and cannot drive a
                  // run here" is a more useful thing to learn than "this model
                  // does not appear in your list".
                  <option key={model.id} value={model.id} disabled>
                    {optionLabel(model, locale, t)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        )}
      </Field>

      {selected ? <SelectedModelFacts model={selected} /> : null}

      <CatalogProvenance catalog={catalog} />
    </div>
  );
}

function SelectedModelFacts({ model }: { model: ModelChoice }) {
  const { t, locale } = useLocale();

  return (
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.8125rem]">
      <div className="inline-flex items-baseline gap-1.5">
        <dt className="fb-label">{t('generate.composer.model')}</dt>
        <dd>
          <Code>{model.id}</Code>
        </dd>
      </div>
      <div className="inline-flex items-baseline gap-1.5">
        <dt className="fb-sr-only">{t('generate.models.free')}</dt>
        <dd>
          {/*
            `live` for free rather than a fourth colour: this palette has four
            state colours and no accent (DESIGN.md §1). Free is the state the
            router prefers and the one nothing is spent on, so it reads as the
            healthy one; paid is `idle`, which is neutral rather than a warning,
            because paying for a model is not a fault.
          */}
          <StatusChip status={model.free ? 'live' : 'idle'}>
            {model.free ? t('generate.models.free') : t('generate.models.paid')}
          </StatusChip>
        </dd>
      </div>
      {/*
        The context window in full, not abbreviated: the `<option>` above shows
        "1,049K" because a dropdown row has to stay one line, but the exact
        figure is what someone deciding whether their prompt fits actually
        needs. The `dt`s here are screen-reader-only because the value already
        contains its own noun — "1,048,576 context", "coding 68.8" — and a
        visible label would say it twice.
      */}
      <div className="inline-flex items-baseline gap-1.5">
        <dt className="fb-sr-only">{t('generate.models.group.eligible')}</dt>
        <dd className="text-fg">
          {t('generate.models.context', {
            tokens: new Intl.NumberFormat(locale).format(model.contextTokens),
          })}
        </dd>
      </div>
      <div className="inline-flex items-baseline gap-1.5">
        <dt className="fb-sr-only">{t('generate.composer.model')}</dt>
        <dd className="text-fg-muted">
          {model.coding === null
            ? t('generate.models.unscored')
            : t('generate.models.coding', { score: model.coding })}
        </dd>
      </div>
      {model.eligible ? null : (
        <div className="inline-flex items-baseline gap-1.5">
          <dt className="fb-sr-only">{t('generate.models.group.ineligible')}</dt>
          <dd className="text-halt">
            {t('generate.models.ineligibleWhy', { capabilities: model.missing.join(', ') })}
          </dd>
        </div>
      )}
      <div className="w-full">
        <p className="fb-meta">{model.freeReason}</p>
      </div>
    </dl>
  );
}

/**
 * Where this list came from and how old it is.
 *
 * Stated rather than assumed, because ADR-007 accepts up to a week of lag by
 * design and the registry sets a threshold past which the snapshot must stop
 * being presented as current. When that threshold is crossed the note becomes a
 * `halt` chip: prices and capabilities on this page are then claims about a
 * catalog nobody has verified recently, and the honest thing is to say so
 * rather than to render a stale number in the same voice as a fresh one.
 */
function CatalogProvenance({ catalog }: { catalog: CatalogView }) {
  const { t, locale } = useLocale();
  const { summary } = catalog;

  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-3">
      <p className="fb-meta">
        {t('generate.models.source', {
          count: catalog.models.length,
          source: summary.source,
          when: new Date(summary.syncedAt).toLocaleDateString(locale),
        })}{' '}
        {t('generate.models.catalogTotal', { total: summary.catalogTotal })}
      </p>
      <p className="fb-meta">{t('generate.models.freeDerived')}</p>

      {summary.stale ? (
        <p>
          <StatusChip status="halt">
            {t('generate.models.stale', {
              days: Math.floor(summary.ageDays),
              threshold: summary.thresholdDays,
            })}
          </StatusChip>
        </p>
      ) : null}

      {summary.excluded.length > 0 ? (
        <Disclosure summary={t('generate.models.excluded', { count: summary.excluded.length })}>
          <ul className="flex flex-col gap-2">
            {summary.excluded.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-0.5">
                <Code>{entry.id}</Code>
                <p className="fb-meta">{entry.detail}</p>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
