'use client';

import Link from 'next/link';
import { useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';
import { CategoryTag, PlanTable, ScopeTable } from './card-parts';
import { cardKey, type MechanicCard } from './catalog';

/**
 * What a card would do, before you use it.
 *
 * The order of the page is the order of the questions: what is this, what will
 * it touch, what will it build, and — last, in full, unabridged — what exactly
 * gets sent to the model. The prompt is not behind a disclosure and it is not
 * summarised. A recipe that shows you a friendly paragraph and sends something
 * else is the inventory-shaped version of a diff that hides its source, and this
 * app does not get to have one of those either.
 */
export function CardDetail({ card }: { card: MechanicCard }) {
  const { t, locale } = useLocale();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href={`/${locale}/inventory`}
          className="fb-meta inline-flex w-fit items-center gap-1 text-fg-muted hover:text-fg"
        >
          {t('inventory.card.back')}
        </Link>

        <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[1.75rem]">{t(cardKey(card.id, 'title'))}</h1>
            <CategoryTag category={card.category} />
            <span className="fb-meta">{t(`inventory.source.${card.source}`)}</span>
          </div>
          <p className="text-fg-muted">{t(cardKey(card.id, 'summary'))}</p>
        </header>
      </div>

      {/*
        The caveat sits above the scope, not in a footnote. Every card in this
        catalog has one, because every one of these mechanics has an edge a
        generated version will get wrong or leave out, and a recipe that only
        lists what it produces is selling something.
      */}
      <p className="max-w-[var(--fb-measure)] border-s-2 border-rule-strong ps-4 text-[0.9375rem] text-fg">
        {t(cardKey(card.id, 'caveat'))}
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Register labelId="card-scope" title={t('inventory.card.scope')}>
          <div className="flex flex-col gap-3">
            <p className="fb-meta">{t('inventory.card.scopeNote')}</p>
            <div className="overflow-x-auto">
              <ScopeTable scope={card.scope} />
            </div>
          </div>
        </Register>

        <Register labelId="card-plan" title={t('inventory.card.plan')}>
          <div className="flex flex-col gap-3">
            <p className="fb-meta">{t('inventory.card.planNote')}</p>
            <div className="overflow-x-auto">
              <PlanTable plan={card.plan} />
            </div>
          </div>
        </Register>
      </div>

      <Register labelId="card-prompt" title={t('inventory.card.prompt')}>
        <div className="flex flex-col gap-3">
          <p className="fb-meta max-w-[var(--fb-measure)]">{t('inventory.card.promptNote')}</p>
          {/*
            `whitespace-pre-wrap` rather than the `<Code block>` default: the
            prompt is prose with hard line breaks, not code, and horizontal
            scrolling a paragraph is worse than wrapping it. Still an LTR island
            and still mono, because it is a literal payload and a Hebrew reader
            must see it in the order it will be sent.
          */}
          <Code block className="whitespace-pre-wrap">
            {card.prompt}
          </Code>
          <CardActions card={card} />
        </div>
      </Register>
    </div>
  );
}

function CardActions({ card }: { card: MechanicCard }) {
  const { t, locale } = useLocale();
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          weight="primary"
          onClick={() => {
            /*
             * `navigator.clipboard` is unavailable on a non-secure origin and
             * can be refused by permission policy, and both are plausible here:
             * this app is routinely opened over plain http on a LAN address
             * while somebody points it at a daemon on another machine. So a
             * failure is reported as a third state rather than swallowed — and
             * the prompt is on screen in full above, which is why the failure
             * message can honestly tell the user to select it.
             */
            const clipboard: Clipboard | undefined = navigator.clipboard;
            if (!clipboard) {
              setCopied('failed');
              return;
            }
            void clipboard.writeText(card.prompt).then(
              () => {
                setCopied('done');
              },
              () => {
                setCopied('failed');
              },
            );
          }}
        >
          {copied === 'done' ? t('common.copied') : t('inventory.card.copy')}
        </Button>

        <Link
          href={`/${locale}/generate?card=${encodeURIComponent(card.id)}`}
          className="inline-flex items-center justify-center gap-2 rounded-sm border border-rule-strong px-3 py-1.5 text-[0.875rem] font-medium text-fg transition-colors duration-150 hover:bg-sunken"
        >
          {t('inventory.card.open')}
        </Link>
      </div>

      {/*
        The honest note about that link. The generation surface is M35 and is not
        built; this link carries the card id in the query string, which is the
        contract that surface has to read. Saying so beats a link that looks like
        it will do something and lands on a placeholder.

        TODO(M35): read `?card=<id>` on the generate surface and prefill the run
        with `cardById(id).prompt`, scoped to `card.scope`. Owner: the
        generation-surface agent.
      */}
      <p className="fb-meta max-w-[var(--fb-measure)]">{t('inventory.card.openNote')}</p>

      <p aria-live="polite" className="fb-meta">
        {copied === 'failed' ? t('inventory.card.copyFailed') : ''}
      </p>
    </div>
  );
}
