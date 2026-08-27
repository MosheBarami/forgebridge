'use client';

import type { ModelAttempt } from '@forgebridge/protocol';

import { useLocale } from '@/i18n/dictionary-context';
import type { SkippedModel } from '@/lib/daemon/wire';
import { Code } from '@/components/ui/code';
import { Disclosure } from '@/components/ui/field';
import { Register } from '@/components/ui/register';
import { StatusChip, StatusDot, type Status } from '@/components/ui/status-dot';
import { attemptLine, hasRoutingDetail, type RunView } from './run-state';

/**
 * The run log (M35) — ADR-008 made visible.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * "When the router moves on from a model, the run log says so — collapsed by
 * default, expandable. A silent substitution is a lie about what wrote the
 * user's code."
 *
 * So the collapsed line is always present and always complete:
 * `glm-5.2:free → rate-limited → minimax-m3:free`. It is rendered by
 * `attemptSummary` from `@forgebridge/protocol` rather than by string-building
 * here, because the CLI and the MCP surface render the same line and three
 * implementations of one sentence is three chances to disagree about what a
 * fallback looked like.
 *
 * The collapsed form is not a *summary that omits*. It names every model. What
 * expanding adds is the per-attempt detail — duration, tokens, cost, the
 * provider's own note — and the candidates that were never tried at all.
 *
 * ── Why "never tried" is a separate list ──────────────────────────────────
 *
 * A skipped candidate is not an attempt: the breaker held it out, or the
 * attempt budget ran out before the router reached it. Folding the two together
 * would put models in the fallback chain that were never called, which is a
 * `ModelAttempt` describing something that did not happen — the one thing the
 * daemon's own comment says the attempt list must never contain.
 */

/** Which state colour an outcome is. `ok` is the only one that is `live`. */
function statusOfOutcome(outcome: ModelAttempt['outcome']): Status {
  if (outcome === 'ok') return 'live';
  if (outcome === 'cancelled') return 'idle';
  return 'halt';
}

function stageStatus(view: RunView): Status {
  if (view.failure) return 'halt';
  if (view.stage === 'cancelled') return 'idle';
  if (view.stage === 'awaiting-approval') return 'attend';
  if (view.stage === 'done') return 'live';
  return view.finished ? 'idle' : 'attend';
}

export function RunLog({ view }: { view: RunView }) {
  const { t, locale } = useLocale();

  return (
    <Register
      labelId="reg-run"
      title={t('generate.run.title')}
      meta={
        view.runId ? (
          <span className="inline-flex items-baseline gap-1.5">
            {t('generate.run.runId')} <Code>{view.runId}</Code>
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {/*
          `aria-live="polite"` on the stage: it changes without the user doing
          anything, and a run that has moved from generating to validating is
          worth knowing about. Polite, never assertive — it is progress, not an
          interruption.
        */}
        <div aria-live="polite" className="flex flex-wrap items-center gap-3">
          <StatusChip status={stageStatus(view)}>{t(`generate.run.stage.${view.stage}`)}</StatusChip>
          {view.inFlight ? (
            <span className="fb-meta">
              {t('generate.run.inFlight', { model: view.inFlight.modelId })}
            </span>
          ) : null}
        </div>

        <PlanList view={view} />

        {hasRoutingDetail(view) ? <Chain view={view} locale={locale} /> : null}

        {view.failure ? <Failure view={view} /> : null}

        {view.cancelledReason ? (
          <p className="fb-meta">{t('generate.run.cancelledReason', { reason: view.cancelledReason })}</p>
        ) : null}

        {view.unrecognised.length > 0 ? (
          /*
            Frames this build could not parse. Reported rather than swallowed:
            the log above has holes in it and the reader is entitled to know
            that is what they are looking at, not to be shown a shorter list
            that looks complete.
          */
          <Disclosure
            summary={t('generate.run.unrecognised', { count: view.unrecognised.length })}
          >
            <ul className="flex flex-col gap-1">
              {view.unrecognised.map((entry, index) => (
                <li key={`${entry.type ?? 'unknown'}-${index}`} className="fb-meta">
                  <Code>{entry.type ?? '—'}</Code> {entry.detail}
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </div>
    </Register>
  );
}

function PlanList({ view }: { view: RunView }) {
  const { t } = useLocale();

  if (view.plan.length === 0) {
    return (
      <p className="fb-meta">
        {view.finished ? t('generate.run.planEmpty') : t('generate.run.stage.planning')}
      </p>
    );
  }

  return (
    <section aria-labelledby="run-plan" className="flex flex-col gap-2">
      <h3 id="run-plan" className="fb-label">
        {t('generate.run.plan')}
      </h3>
      {/*
        An ordered list because the steps are ordered — the model said it would
        do these things in this sequence. `list-decimal` with the marker inside
        so the numbers sit in the text flow and mirror correctly under `rtl`.
      */}
      <ol className="flex list-inside list-decimal flex-col gap-1 text-[0.875rem] text-fg">
        {view.plan.map((step, index) => (
          <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
        ))}
      </ol>
    </section>
  );
}

function Chain({ view, locale }: { view: RunView; locale: string }) {
  const { t } = useLocale();

  return (
    <section aria-labelledby="run-chain" className="flex flex-col gap-2">
      <h3 id="run-chain" className="fb-label">
        {t('generate.run.chain')}
      </h3>

      {/*
        The collapsed line. Always rendered, whether or not the disclosure is
        open — this is the sentence ADR-008 is about and it does not live behind
        a toggle.
      */}
      <p className="overflow-x-auto">
        <Code className="whitespace-pre">{attemptLine(view)}</Code>
      </p>

      <Disclosure summary={t('generate.run.expand')}>
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col gap-2">
            {view.attempts.map((attempt, index) => (
              <li key={`${attempt.modelId}-${attempt.startedAt}-${index}`}>
                <AttemptRow attempt={attempt} index={index} locale={locale} />
              </li>
            ))}
            {view.inFlight ? (
              <li>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.8125rem]">
                  <StatusDot status="attend" />
                  <Code>{view.inFlight.modelId}</Code>
                  <span className="text-fg-muted">
                    {t('generate.run.inFlight', { model: view.inFlight.provider })}
                  </span>
                </div>
              </li>
            ) : null}
          </ol>

          {view.skipped.length > 0 ? <SkippedList skipped={view.skipped} /> : null}

          <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-2">
            {t('generate.run.adr')}
          </p>
        </div>
      </Disclosure>
    </section>
  );
}

function AttemptRow({
  attempt,
  index,
  locale,
}: {
  attempt: ModelAttempt;
  index: number;
  locale: string;
}) {
  const { t } = useLocale();
  const number = new Intl.NumberFormat(locale);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2">
          <StatusDot status={statusOfOutcome(attempt.outcome)} />
          <Code>{attempt.modelId}</Code>
        </span>
        {/* The dot never carries the outcome alone — the word is beside it. */}
        <span className="text-[0.8125rem] font-medium text-fg">
          {t(`generate.run.outcome.${attempt.outcome}`)}
        </span>
        <span className="fb-meta">{t('generate.run.attemptIndex', { index: index + 1 })}</span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 fb-meta">
        <span>{t('generate.run.duration', { ms: number.format(attempt.durationMs) })}</span>
        {attempt.promptTokens !== undefined && attempt.completionTokens !== undefined ? (
          <span>
            {t('generate.run.tokens', {
              prompt: number.format(attempt.promptTokens),
              completion: number.format(attempt.completionTokens),
            })}
          </span>
        ) : null}
        {/*
          Cost is shown when the daemon reported one, and zero is shown as "no
          charge" rather than as "$0.00". They are the same number and different
          statements: a free model was not billed, and a paid model that
          rounded to zero was.
        */}
        {attempt.costUsd !== undefined ? (
          <span>
            {attempt.costUsd === 0
              ? t('generate.run.costFree')
              : t('generate.run.cost', { cost: attempt.costUsd.toFixed(4) })}
          </span>
        ) : null}
        {attempt.providerSlug ? <Code>{attempt.providerSlug}</Code> : null}
      </div>

      {attempt.note ? <p className="fb-meta text-fg">{attempt.note}</p> : null}
    </div>
  );
}

function SkippedList({ skipped }: { skipped: readonly SkippedModel[] }) {
  const { t, locale } = useLocale();
  const number = new Intl.NumberFormat(locale);

  return (
    <section aria-labelledby="run-skipped" className="flex flex-col gap-2 border-t border-rule pt-3">
      <h4 id="run-skipped" className="fb-label">
        {t('generate.run.skipped')}
      </h4>
      <ul className="flex flex-col gap-1">
        {skipped.map((entry, index) => (
          <li key={`${entry.modelId}-${index}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-2">
              <StatusDot status="idle" />
              <Code>{entry.modelId}</Code>
            </span>
            <span className="text-[0.8125rem] text-fg">
              {t(`generate.run.skippedReason.${entry.reason}`)}
            </span>
            <span className="fb-meta">{entry.detail}</span>
            {entry.retryAfterMs !== undefined ? (
              <span className="fb-meta">
                {t('generate.run.skippedRetry', { ms: number.format(entry.retryAfterMs) })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Failure({ view }: { view: RunView }) {
  const { t } = useLocale();
  if (!view.failure) return null;

  return (
    <section
      aria-labelledby="run-failure"
      className="flex flex-col gap-2 border-s-2 border-halt bg-halt-wash p-3"
    >
      <h3 id="run-failure" className="text-[0.875rem] font-semibold text-fg">
        {t('generate.run.failure')}
      </h3>
      <p className="text-[0.875rem] text-fg">{view.failure.message}</p>
      {view.failure.remedy ? (
        <p className="fb-meta">
          <span className="fb-label">{t('generate.run.remedy')}</span> {view.failure.remedy}
        </p>
      ) : null}
      <p className="fb-meta">
        <Code>{view.failure.code}</Code>
      </p>
    </section>
  );
}
