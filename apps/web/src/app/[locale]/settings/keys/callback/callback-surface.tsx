'use client';

import { useEffect, useRef, useState } from 'react';
import NextLink from 'next/link';
import { useSearchParams } from 'next/navigation';

import { useLocale } from '@/i18n/dictionary-context';
import { endFlow, readFlow } from '@/lib/keys/pkce';
import { exchangeCode } from '@/lib/keys/openrouter-oauth';
import { seal } from '@/lib/keys/vault';
import { ACTION_LINK_CLASS } from '@/components/settings/field';
import { Register } from '@/components/ui/register';
import { StatusChip, type Status } from '@/components/ui/status-dot';

/**
 * Where OpenRouter returns the browser after an authorization.
 *
 * A **page**, not a route handler. A route handler would be a server endpoint
 * that receives an authorization code, and a code plus a verifier is a
 * credential in two pieces — ADR-006 says neither half materialises on an
 * apple.gg process, and the way to guarantee that is for no such endpoint to
 * exist. So the redemption happens here, in the tab that started the flow, and
 * the result goes straight into the browser vault.
 *
 * Every outcome below is named. An OAuth callback that shows one apology for
 * five different failures teaches the user nothing and leaves them re-pressing
 * a button that will fail the same way.
 */

type Outcome =
  | { readonly kind: 'working' }
  /** The provider returned an error instead of a code. Their word for it, shown as theirs. */
  | { readonly kind: 'provider-error'; readonly detail: string }
  /** No verifier in this tab: a fresh tab, a cleared session, or a link someone else sent. */
  | { readonly kind: 'no-flow' }
  /** A `state` came back and it is not the one this tab sent. Refused without redeeming. */
  | { readonly kind: 'state-mismatch' }
  | { readonly kind: 'no-code' }
  | { readonly kind: 'failed'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'done'; readonly hint: string };

const STATUS: Record<Outcome['kind'], Status> = {
  working: 'idle',
  'provider-error': 'halt',
  'no-flow': 'attend',
  'state-mismatch': 'halt',
  'no-code': 'halt',
  failed: 'halt',
  done: 'live',
};

export function OAuthCallbackSurface() {
  const { t, locale } = useLocale();
  const params = useSearchParams();
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });
  const [returnTo, setReturnTo] = useState(`/${locale}/settings/keys`);

  // A verifier is single-use, and React 19 runs effects twice in development
  // strict mode. Redeeming twice would spend the code on the first pass and
  // show the user the second pass's failure.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const providerError = params.get('error') ?? params.get('error_description');
    if (providerError) {
      endFlow();
      setOutcome({ kind: 'provider-error', detail: providerError });
      return;
    }

    const flow = readFlow();
    if (!flow) {
      setOutcome({ kind: 'no-flow' });
      return;
    }
    setReturnTo(flow.returnTo);

    const echoed = params.get('state');
    // Absent is tolerated: OpenRouter is not documented to echo `state`, and
    // treating a parameter that may never have been supported as a failure
    // would break the flow for a reason that is ours. Present-and-wrong is
    // refused, because that is a code from somewhere else.
    if (echoed !== null && echoed !== flow.state) {
      endFlow();
      setOutcome({ kind: 'state-mismatch' });
      return;
    }

    const code = params.get('code');
    if (!code) {
      endFlow();
      setOutcome({ kind: 'no-code' });
      return;
    }

    void (async () => {
      const result = await exchangeCode(code, flow.codeVerifier);
      // Cleared on both paths: a verifier that outlives its flow is a secret
      // sitting in storage for no reason.
      endFlow();

      if (!result.ok) {
        setOutcome({ kind: 'failed', reason: result.reason, detail: result.detail });
        return;
      }

      try {
        const entry = await seal('openrouter', result.credential, 'oauth');
        setOutcome({ kind: 'done', hint: entry.hint });
      } catch (error) {
        setOutcome({
          kind: 'failed',
          reason: 'vault',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [params]);

  return (
    <Register labelId="reg-callback" title={t('settings.keys.callback.title')}>
      <div className="flex flex-col gap-4">
        <StatusChip status={STATUS[outcome.kind]}>
          {t(`settings.keys.callback.state.${outcome.kind}`)}
        </StatusChip>

        <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
          {t(`settings.keys.callback.body.${outcome.kind}`)}
        </p>

        {outcome.kind === 'provider-error' || outcome.kind === 'failed' ? (
          <p className="max-w-[var(--fb-measure)] fb-meta" dir="ltr" lang="en">
            {outcome.kind === 'failed'
              ? `${outcome.reason}: ${outcome.detail}`
              : outcome.detail}
          </p>
        ) : null}

        {outcome.kind === 'failed' ? (
          <p className="max-w-[var(--fb-measure)] fb-meta">
            {t(`settings.keys.callback.remedy.${outcome.reason}`)}
          </p>
        ) : null}

        {outcome.kind === 'done' ? (
          <p className="fb-meta">{t('settings.keys.callback.hint', { hint: outcome.hint })}</p>
        ) : null}

        <div>
          <NextLink href={returnTo} className={ACTION_LINK_CLASS}>
            {t('settings.keys.callback.back')}
          </NextLink>
        </div>
      </div>
    </Register>
  );
}
