'use client';

import { useId } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { ROUTING_POLICIES, type RoutingPolicyName } from '@/lib/daemon/wire';
import type { ProjectRecord } from '@/lib/projects/store';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Field, Select, TextArea } from '@/components/ui/field';
import { Register } from '@/components/ui/register';
import type { CatalogView } from './catalog';
import { ModelPicker } from './model-picker';

/**
 * The composer (M35): a prompt, a project, a model, a routing policy.
 *
 * ── Why this is not a chat box ────────────────────────────────────────────
 *
 * DESIGN.md's whole premise is that this is a workshop and not a chat app. A
 * prompt here is a *work order*: it is written once, it names a project and a
 * model, and what comes back is a proposal to be reviewed rather than a reply
 * to be read. So there is no message history, no assistant bubble and no
 * centred input — it is a form, in a register, with its parameters visible
 * beside it.
 *
 * ── The two preconditions, stated rather than implied ─────────────────────
 *
 * A run needs a daemon and a producer token. When either is missing the button
 * is disabled *and* the reason is on screen with the remedy — a disabled
 * control with no explanation is the interface equivalent of a shrug, and for a
 * signed-out first-time visitor "no daemon" is the expected state rather than
 * an error (ADR-005).
 */

export interface ComposerValue {
  readonly prompt: string;
  readonly modelId: string;
  readonly policy: RoutingPolicyName;
  readonly projectId: string | null;
}

export function Composer({
  catalog,
  value,
  onChange,
  onStart,
  onCancel,
  onReset,
  running,
  finished,
  projects,
  daemonReady,
  hasToken,
  promptError,
}: {
  catalog: CatalogView;
  value: ComposerValue;
  onChange: (next: ComposerValue) => void;
  onStart: () => void;
  onCancel: () => void;
  onReset: () => void;
  running: boolean;
  finished: boolean;
  projects: readonly ProjectRecord[];
  daemonReady: boolean;
  hasToken: boolean;
  promptError: string | null;
}) {
  const { t } = useLocale();
  const promptId = useId();
  const projectId = useId();
  const policyId = useId();

  const blocked = !daemonReady || !hasToken;

  return (
    <Register labelId="reg-composer" title={t('generate.composer.title')}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) onStart();
        }}
      >
        <Field id={promptId} label={t('generate.composer.prompt')} error={promptError}>
          {(described) => (
            <TextArea
              {...described}
              value={value.prompt}
              disabled={running}
              // The protocol's own ceiling on a prompt. Restating a smaller
              // number here would refuse work the daemon would have accepted.
              maxLength={50_000}
              placeholder={t('generate.composer.promptPlaceholder')}
              onChange={(event) => onChange({ ...value, prompt: event.target.value })}
            />
          )}
        </Field>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Field
              id={projectId}
              label={t('generate.composer.project')}
              hint={t('generate.composer.projectHint')}
            >
              {(described) => (
                <Select
                  {...described}
                  value={value.projectId ?? ''}
                  disabled={running}
                  onChange={(event) =>
                    onChange({ ...value, projectId: event.target.value === '' ? null : event.target.value })
                  }
                >
                  {/*
                    The empty option is not "none" — it means "let the daemon
                    use its own default project", which is what omitting
                    `projectId` from the request actually does. Labelling it
                    "no project" would describe a state the wire does not have.
                  */}
                  <option value="">{t('generate.composer.projectDaemonDefault')}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field id={policyId} label={t('generate.composer.policy')}>
              {(described) => (
                <Select
                  {...described}
                  value={value.policy}
                  disabled={running}
                  onChange={(event) =>
                    onChange({ ...value, policy: event.target.value as RoutingPolicyName })
                  }
                >
                  {ROUTING_POLICIES.map((policy) => (
                    <option key={policy} value={policy}>
                      {t(`generate.policy.${policy}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {value.policy === 'pinned' ? (
              // Pinning is the one policy that changes the safety story of the
              // run log: with no fallback there is no chain to show, and a
              // rate-limited model is a failed run rather than a substitution.
              <p className="fb-meta">{t('generate.policy.pinnedNote')}</p>
            ) : null}
          </div>

          <ModelPicker
            catalog={catalog}
            value={value.modelId}
            disabled={running}
            onChange={(modelId) => onChange({ ...value, modelId })}
          />
        </div>

        {blocked ? (
          <p className="max-w-[var(--fb-measure)] border-s-2 border-attend bg-attend-wash p-3 text-[0.875rem] text-fg">
            {!daemonReady ? t('generate.composer.needsDaemon') : t('generate.composer.needsToken')}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" weight="primary" disabled={running || blocked}>
            {running ? t('generate.composer.starting') : t('generate.composer.start')}
          </Button>

          {running ? (
            <Button onClick={onCancel}>{t('generate.composer.cancel')}</Button>
          ) : null}

          {finished && !running ? (
            <Button onClick={onReset}>{t('generate.composer.reset')}</Button>
          ) : null}

          {/*
            The model that will actually be tried first, echoed beside the
            button. `pinned` is the only policy where the selection is binding;
            under every other policy the router orders candidates itself and the
            picked model is a preference, not a promise — so the label says
            which of the two this is rather than implying the stronger one.
          */}
          <p className="fb-meta">
            {value.policy === 'pinned' ? (
              <Code>{value.modelId}</Code>
            ) : (
              t(`generate.policy.${value.policy}`)
            )}
          </p>
        </div>
      </form>
    </Register>
  );
}
