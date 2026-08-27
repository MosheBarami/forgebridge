'use client';

import { useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { pageOrigin, startCommand } from '@/lib/daemon/config';
import { useDaemonSession } from '@/lib/daemon/session';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';

/**
 * What a signed-out, first-time visitor sees. Which is to say: the most common
 * screen this app has.
 *
 * It is written as a route forward, not as an error. Nothing has gone wrong —
 * the daemon is a separate process the user has not started yet, and the only
 * useful thing this page can do is say exactly how to start it, with the
 * origin already filled in.
 *
 * The honest part is the two causes. A browser cannot tell "no socket is
 * listening" from "the daemon is listening and refused this origin": both come
 * back from `fetch` as the same opaque `TypeError`, because a failed CORS
 * preflight is deliberately indistinguishable from a network failure. Picking
 * one and asserting it would be wrong half the time, so both are named and the
 * `--allow-origin` flag — the cause people actually hit, and the one whose
 * symptom looks least like its cause — is called out on its own.
 */
export function DaemonEmptyState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useLocale();
  const { baseUrl, hasToken, setToken, clearToken } = useDaemonSession();
  const [draft, setDraft] = useState('');

  const origin = pageOrigin();
  const command = startCommand(origin);

  return (
    <div className="flex max-w-[var(--fb-measure)] flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('daemon.absent.title', { url: baseUrl })}</h1>
        <p className="text-fg-muted">{t('daemon.absent.lede')}</p>
      </header>

      <section aria-labelledby="daemon-causes" className="flex flex-col gap-2">
        <h2 id="daemon-causes" className="fb-label">
          {t('daemon.absent.twoCauses')}
        </h2>
        <ul className="flex list-none flex-col gap-2 border-s-2 border-rule ps-4">
          <li className="text-[0.9375rem]">{t('daemon.absent.causeNotRunning')}</li>
          <li className="text-[0.9375rem]">{t('daemon.absent.causeOriginBlocked')}</li>
        </ul>
      </section>

      <section aria-labelledby="daemon-start" className="flex flex-col gap-3">
        <h2 id="daemon-start" className="fb-label">
          {t('daemon.absent.startTitle')}
        </h2>
        <p className="text-[0.9375rem] text-fg-muted">{t('daemon.absent.startBody')}</p>
        <Code block>{command}</Code>
        <p className="fb-meta">
          {t('daemon.absent.originNote', { flag: `--allow-origin ${origin}` })}
        </p>
      </section>

      <section aria-labelledby="daemon-token" className="flex flex-col gap-3">
        <h2 id="daemon-token" className="fb-label">
          {t('daemon.absent.tokenTitle')}
        </h2>
        <p className="text-[0.9375rem] text-fg-muted">{t('daemon.absent.tokenBody')}</p>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setToken(draft);
            // Cleared from the input the moment it is accepted. The value now
            // lives in one place — a ref in `session.tsx` — rather than also
            // sitting in React state and in a DOM node the browser may offer to
            // autofill next time.
            setDraft('');
          }}
        >
          <label htmlFor="producer-token" className="fb-sr-only">
            {t('daemon.absent.tokenPlaceholder')}
          </label>
          <input
            id="producer-token"
            name="producer-token"
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('daemon.absent.tokenPlaceholder')}
            className="min-w-0 flex-1 rounded-sm border border-rule bg-raised px-2 py-1.5 font-mono text-[0.8125rem] text-fg placeholder:text-fg-faint"
          />
          <Button type="submit" weight="secondary" disabled={draft.trim().length === 0}>
            {t('daemon.absent.tokenSubmit')}
          </Button>
          {hasToken ? (
            <Button
              weight="secondary"
              onClick={() => {
                clearToken();
              }}
            >
              {t('common.dismiss')}
            </Button>
          ) : null}
        </form>
      </section>

      <div className="flex items-center gap-3 border-t border-rule pt-4">
        <Button weight="primary" onClick={onRetry} disabled={retrying}>
          {retrying ? t('daemon.absent.retrying') : t('daemon.absent.retry')}
        </Button>
        <p className="fb-meta">{t('daemon.absent.docs')}</p>
      </div>
    </div>
  );
}
