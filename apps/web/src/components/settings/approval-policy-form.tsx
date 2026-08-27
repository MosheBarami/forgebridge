'use client';

import { useId, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { usePreferences } from '@/lib/settings/use-preferences';
import {
  AUTO_APPLIABLE_OPS,
  NEVER_AUTO_APPLIED,
  checkPathPrefix,
  describeEnforcement,
  type PrefixRejection,
} from '@/lib/settings/approval-policy';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';
import { StatusChip } from '@/components/ui/status-dot';
import { Field, TextInput } from '@/components/ui/field';
import { CheckboxRow } from './field';

/**
 * The approval policy, as a form.
 *
 * ADR-012 gives four constraints and this component makes each one visible
 * rather than merely honoured:
 *
 * 1. **Approval by default.** The first register states what happens with the
 *    policy off, because that is the state almost every user is in, and a
 *    settings page that only describes the opt-in leaves the default
 *    undescribed.
 *
 * 2. **One folder, and the folder comes first.** The enable control is
 *    inoperable until a prefix exists — an unscoped auto-apply is not a state
 *    this form can produce, in the same way it is not a state `parseAutoApply`
 *    can return. One prefix rather than a list is the core's constraint, and it
 *    is also the one that makes the scope hard to widen by accident: a list
 *    grows one reasonable entry at a time, a single folder can only be
 *    replaced.
 *
 * 3. **Replacing the folder turns auto-apply off.** That is the deliberate
 *    friction. Editing a path in place while the switch stays on is precisely
 *    how a scope gets widened without anyone deciding to widen it; requiring
 *    the switch to be thrown again means the new folder was looked at.
 *
 * 4. **`deleteInstance` is never covered**, with the operation list beside it:
 *    four operations in, one permanently out. It is not a checkbox somebody
 *    could find, because it is not a field.
 */

function rejectionKey(rejection: PrefixRejection): string {
  return `settings.approval.scopeError.${rejection.kind}`;
}

function rejectionVars(rejection: PrefixRejection): Record<string, string> {
  switch (rejection.kind) {
    case 'invalid-path':
      return { detail: rejection.detail };
    case 'service-root':
      return { root: rejection.root };
    default:
      return {};
  }
}

export function ApprovalPolicyForm() {
  const { t } = useLocale();
  const { state, update } = usePreferences();
  const policy = state.value.autoApply;

  const [draft, setDraft] = useState('');
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const prefixId = useId();

  const enforcement = describeEnforcement();
  const loading = state.status === 'loading';

  const setPrefix = () => {
    const check = checkPathPrefix(draft);
    if (!check.ok) {
      setScopeError(t(rejectionKey(check.rejection), rejectionVars(check.rejection)));
      return;
    }
    // Replacing a folder while auto-apply is on turns it off. The alternative —
    // editing the path in place and leaving the switch alone — is how a scope
    // silently becomes a wider one.
    const wasEnabled = policy?.enabled === true;
    setScopeError(null);
    setDraft('');
    setAnnouncement(
      wasEnabled
        ? t('settings.approval.scopeChangedAndDisabled', { prefix: check.prefix })
        : t('settings.approval.scopeSet', { prefix: check.prefix }),
    );
    void update((current) => ({
      ...current,
      autoApply: { enabled: false, pathPrefix: check.prefix },
    }));
    // Committing clears the input, which disables the button that was just
    // pressed — and a browser moves focus to `<body>` when the focused element
    // becomes disabled, dropping a keyboard user out of the form entirely.
    // Focus goes back to the field it came from.
    document.getElementById(prefixId)?.focus();
  };

  const clearPrefix = () => {
    setAnnouncement(t('settings.approval.scopeCleared'));
    void update((current) => ({ ...current, autoApply: null }));
  };

  return (
    <div className="flex flex-col gap-5">
      <Register labelId="reg-default" title={t('settings.approval.defaultTitle')}>
        <div className="flex flex-col gap-3">
          <StatusChip status="attend">{t('approval.gate')}</StatusChip>
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
            {t('approval.explain')}
          </p>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.approval.digestNote')}</p>
        </div>
      </Register>

      <Register labelId="reg-autoapply" title={t('settings.approval.autoTitle')}>
        <div className="flex flex-col gap-5">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
            {t('settings.approval.autoLede')}
          </p>

          {/* ── The folder, before the switch ────────────────────────────── */}
          <div className="flex flex-col gap-3">
            {policy ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-rule p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="fb-label">{t('settings.approval.scopeCurrent')}</span>
                  <Code>{policy.pathPrefix}</Code>
                </div>
                <Button weight="secondary" onClick={clearPrefix} disabled={loading}>
                  {t('settings.approval.clear')}
                </Button>
              </div>
            ) : (
              <p className="fb-meta">{t('settings.approval.scopeEmpty')}</p>
            )}

            <Field
              id={prefixId}
              label={t('settings.approval.scopeLabel')}
              hint={t('settings.approval.scopeHint')}
              error={scopeError}
            >
              {(control) => (
                <div className="flex flex-wrap items-start gap-2">
                  <TextInput
                    {...control}
                    type="text"
                    dir="ltr"
                    spellCheck={false}
                    autoComplete="off"
                    value={draft}
                    disabled={loading}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setScopeError(null);
                    }}
                    onKeyDown={(event) => {
                      // Enter commits. This input is not inside a `<form>`, and
                      // a text field that ignores Enter is a text field people
                      // think is broken.
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        setPrefix();
                      }
                    }}
                    placeholder="ServerScriptService.Shop"
                    className="max-w-md font-mono"
                  />
                  <Button
                    weight="secondary"
                    onClick={setPrefix}
                    disabled={loading || draft.trim().length === 0}
                  >
                    {t('settings.approval.set')}
                  </Button>
                </div>
              )}
            </Field>

            <p className="max-w-[var(--fb-measure)] fb-meta">
              {t('settings.approval.onePrefixNote')}
            </p>
          </div>

          {/* ── The switch ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 border-t border-rule pt-4">
            <CheckboxRow
              label={t('settings.approval.enableLabel')}
              description={
                policy === null
                  ? t('settings.approval.enableBlocked')
                  : t('settings.approval.enableHint')
              }
              checked={policy?.enabled === true}
              disabled={loading || policy === null}
              onChange={(next) => {
                setAnnouncement(
                  t(next ? 'settings.approval.enabled' : 'settings.approval.disabled'),
                );
                void update((current) => ({
                  ...current,
                  autoApply: current.autoApply
                    ? { ...current.autoApply, enabled: next }
                    : // Unreachable while the control is disabled without a
                      // prefix, and still handled: `null` stays `null` rather
                      // than becoming an enabled policy with an empty path.
                      null,
                }));
              }}
            />

            {policy?.enabled ? (
              <p className="max-w-[var(--fb-measure)] rounded-sm border border-attend bg-attend-wash p-3 text-[0.875rem] text-fg">
                {t('settings.approval.summary', { prefix: policy.pathPrefix })}
              </p>
            ) : null}
          </div>

          {/*
            Every change on this panel is otherwise silent — a checkbox flips, a
            row of text changes. Polite, because it is worth knowing and never
            worth interrupting.
          */}
          <p aria-live="polite" className={`text-[0.8125rem] text-fg ${announcement ? '' : 'fb-sr-only'}`}>
            {announcement}
          </p>

          {state.status === 'unavailable' ? (
            <p className="text-[0.8125rem] text-halt">
              {t('settings.storageUnavailable', { detail: state.detail })}
            </p>
          ) : null}
        </div>
      </Register>

      <Register labelId="reg-never" title={t('settings.approval.neverTitle')}>
        <div className="flex flex-col gap-3">
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
            {t('settings.approval.neverBody')}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.875rem]">
            <dt className="text-fg-muted">{t('settings.approval.covered')}</dt>
            <dd className="min-w-0 break-words text-fg">
              <Code>{AUTO_APPLIABLE_OPS.join(' ')}</Code>
            </dd>
            <dt className="text-fg-muted">{t('settings.approval.neverCovered')}</dt>
            <dd className="min-w-0 break-words text-fg">
              <Code>{NEVER_AUTO_APPLIED.join(' ')}</Code>
            </dd>
          </dl>
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('settings.approval.journalNote')}</p>
        </div>
      </Register>

      <Register labelId="reg-enforcement" title={t('settings.approval.enforcementTitle')}>
        <div className="flex flex-col gap-3">
          <StatusChip status={enforcement.enforced ? 'live' : 'attend'}>
            {t(
              enforcement.enforced
                ? 'settings.approval.enforcement.yes'
                : 'settings.approval.enforcement.no',
            )}
          </StatusChip>
          <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">{t(enforcement.key)}</p>
          <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
            {t('settings.approval.projectPolicyNote')}
          </p>
        </div>
      </Register>
    </div>
  );
}
