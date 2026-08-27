'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { useDaemonSession } from '@/lib/daemon/session';
import { useBridge } from '@/lib/daemon/use-daemon';
import type { ChangeSetDiff, RoutingPolicyName, StartRunRequest } from '@/lib/daemon/wire';
import { useProjects } from '@/lib/projects/use-projects';
import { DaemonEmptyState } from '@/components/daemon-empty-state';
import { Register } from '@/components/ui/register';
import type { CatalogView } from './catalog';
import { Composer, type ComposerValue } from './composer';
import { DiffReview, type ApprovalOutcome } from './diff-review';
import { classifyFrame } from './run-frames';
import { RunLog } from './run-log';
import { initialRunView, reduceRun, type RunView } from './run-state';

/**
 * The generation surface (M35): compose, watch, read the diff, decide.
 *
 * ── The shape of the flow, and why it stops where it does ─────────────────
 *
 * A prompt goes to `POST /v1/runs`, the run streams back, and it ends holding a
 * ChangeSet in `validated`. That is where the machine stops. The diff is then
 * fetched separately from `GET /v1/changesets/:id/diff` — not taken from the
 * `change-set` frame that came down the same stream — and the reason is
 * ADR-012: approval must echo the `contentDigest` the diff reported. A digest
 * this app computed for itself from a side-channel copy would bind the approval
 * to something the daemon never showed anyone.
 *
 * There is no auto-apply toggle on this page. ADR-012 permits a scoped one, per
 * project, never covering `deleteInstance` — and it is deliberately not in the
 * main flow (TODO(M38): if it lands, it belongs in settings, beside the path
 * policy it is scoped by, and never beside this run button).
 *
 * ── Why the whole surface is one client component tree ────────────────────
 *
 * Everything here reads the daemon on the user's loopback interface. A server
 * cannot reach it — not apple.gg's, not a self-hoster's. See the README section
 * "Why the daemon is called from the browser"; the catalog is the one thing
 * that comes from the server, because it is a file on disk rather than a fact
 * about this user's machine.
 */

const DEFAULT_POLICY: RoutingPolicyName = 'free-first';

export function GenerateSurface({ catalog }: { catalog: CatalogView }) {
  const { t } = useLocale();
  const { client, hasToken } = useDaemonSession();
  const { state: bridge, refresh, refreshing } = useBridge();
  const { state: projectsState, observeVersion } = useProjects();

  const projects = projectsState.kind === 'ready' ? projectsState.projects : [];
  const selectedId = projectsState.kind === 'ready' ? projectsState.selectedId : null;

  // The first eligible model, which is also the one `free-first` would reach
  // for. Falling back to the first entry of any kind keeps the control from
  // being empty on a catalog where nothing qualifies — a state that would
  // otherwise render a select with no options and no explanation.
  const defaultModel =
    catalog.models.find((model) => model.eligible)?.id ?? catalog.models[0]?.id ?? '';

  const [composer, setComposer] = useState<ComposerValue>({
    prompt: '',
    modelId: defaultModel,
    policy: DEFAULT_POLICY,
    projectId: null,
  });
  const [promptError, setPromptError] = useState<string | null>(null);

  const [run, setRun] = useState<RunView | null>(null);
  const [running, setRunning] = useState(false);

  const [diff, setDiff] = useState<ChangeSetDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const [approving, setApproving] = useState(false);
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);

  // The in-flight run's abort handle. A ref rather than state: aborting must
  // not depend on a render having happened, and the value is never read during
  // one.
  const abort = useRef<AbortController | null>(null);

  // The selection made on the projects page is the default here. `??` rather
  // than a copy-on-mount so a user who changes it in another tab and comes back
  // sees the change instead of a stale snapshot.
  useEffect(() => {
    setComposer((current) => (current.projectId === null && selectedId ? { ...current, projectId: selectedId } : current));
  }, [selectedId]);

  // A run left in flight when this surface unmounts is a socket nobody is
  // reading and a daemon spending model credit on output that will be thrown
  // away. The daemon records that hang-up as `cancelled`, which is the truthful
  // outcome rather than `failed`.
  useEffect(() => () => abort.current?.abort(), []);

  const start = useCallback(() => {
    if (composer.prompt.trim().length === 0) {
      setPromptError(t('generate.composer.promptRequired'));
      return;
    }
    setPromptError(null);
    setDiff(null);
    setDiffError(null);
    setOutcome(null);
    setRun(initialRunView());
    setRunning(true);

    const controller = new AbortController();
    abort.current = controller;

    const request: StartRunRequest = {
      prompt: composer.prompt.trim(),
      policy: composer.policy,
      stream: true,
      producer: { kind: 'web', client: 'apps/web' },
      ...(composer.projectId ? { projectId: composer.projectId } : {}),
      // Only sent under `pinned`. Under every other policy the router orders
      // the candidates itself, and sending a pin it would ignore would make the
      // request say something the run does not do.
      ...(composer.policy === 'pinned' && composer.modelId ? { pinnedModel: composer.modelId } : {}),
    };

    void (async () => {
      try {
        for await (const payload of client.startRunStreaming(request, controller.signal)) {
          const frame = classifyFrame(payload);
          setRun((current) => reduceRun(current ?? initialRunView(), frame));
        }
      } catch (error) {
        // An abort is the user pressing Stop; anything else is the socket
        // dying mid-run. Both end the run, and only the second is a failure.
        if (!controller.signal.aborted) {
          setRun((current) =>
            reduceRun(current ?? initialRunView(), {
              kind: 'refused',
              error: {
                code: 'internal',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          );
        }
      } finally {
        if (abort.current === controller) abort.current = null;
        setRunning(false);
      }
    })();
  }, [client, composer, t]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    setRunning(false);
  }, []);

  const reset = useCallback(() => {
    setRun(null);
    setDiff(null);
    setDiffError(null);
    setOutcome(null);
  }, []);

  // ── the diff ──────────────────────────────────────────────────────────────

  const changeSetId = run?.changeSetId ?? null;

  useEffect(() => {
    // Fetched only once the run has settled. Asking for a diff of a ChangeSet
    // that is still being written would be reading a set mid-validation, and
    // the digest of a set that is still moving is a digest that will not match
    // by the time anyone approves it.
    if (!changeSetId || !run?.finished) return;

    const controller = new AbortController();
    setDiffLoading(true);
    setDiffError(null);

    void client.diff(changeSetId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setDiffLoading(false);
      if (result.ok) {
        setDiff(result.data);
        // The one place this app learns a project's current version. Recorded
        // against the project the run named, not against the daemon's default,
        // because those can differ — see the projects surface.
        if (composer.projectId) void observeVersion(composer.projectId, result.data.currentVersion);
        return;
      }
      setDiffError(
        result.reason === 'protocol'
          ? result.error.message
          : result.reason === 'unauthenticated'
            ? t('daemon.error.unauthenticated')
            : result.reason === 'invalid-response'
              ? `${t('daemon.error.invalidResponse')} ${result.detail}`
              : t('daemon.error.unreachable'),
      );
    });

    return () => controller.abort();
    // `observeVersion` is intentionally absent: it changes identity on every
    // reload of the project list, and depending on it would re-fetch the diff
    // each time a project record is written — including the write this effect
    // itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, changeSetId, run?.finished, composer.projectId, t]);

  // ── the decision ──────────────────────────────────────────────────────────

  const approve = useCallback(
    (request: { approvedBy: string; note?: string; confirmBulkDelete: boolean }) => {
      if (!diff) return;
      setApproving(true);
      setOutcome(null);

      void client
        .approve(diff.changeSetId, {
          // The digest from the diff that is on screen. Not recomputed, not
          // remembered from the run — this is the value the approver was shown.
          contentDigest: diff.contentDigest,
          approvedBy: request.approvedBy,
          ...(request.note ? { note: request.note } : {}),
          confirmBulkDelete: request.confirmBulkDelete,
        })
        .then((result) => {
          setApproving(false);
          setOutcome(
            result.ok
              ? { kind: 'approved', message: t('generate.approve.done', { nonce: result.data.nonce }) }
              : {
                  kind: 'error',
                  message:
                    result.reason === 'protocol'
                      ? [result.error.message, result.error.remedy].filter(Boolean).join(' — ')
                      : result.reason === 'unauthenticated'
                        ? t('daemon.error.unauthenticated')
                        : result.reason === 'invalid-response'
                          ? `${t('daemon.error.invalidResponse')} ${result.detail}`
                          : t('daemon.error.unreachable'),
                },
          );
        });
    },
    [client, diff, t],
  );

  const reject = useCallback(() => {
    // There is no reject route on the daemon. This clears the surface and says
    // so in `generate.approve.rejectExplain` rather than implying the daemon
    // was told: the set stays `validated` on the daemon until its process ends,
    // and is never applied without an approval — so nothing is left pending in
    // the user's place.
    setOutcome({ kind: 'rejected', message: t('generate.approve.rejected') });
  }, [t]);

  // ── render ────────────────────────────────────────────────────────────────

  if (bridge.kind === 'absent') {
    // The whole page, not a banner above a disabled form. For a signed-out
    // first-time visitor this *is* the state, and there is exactly one useful
    // thing to do from here.
    return <DaemonEmptyState onRetry={refresh} retrying={refreshing} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <Composer
        catalog={catalog}
        value={composer}
        onChange={setComposer}
        onStart={start}
        onCancel={cancel}
        onReset={reset}
        running={running}
        finished={run?.finished ?? false}
        projects={projects}
        daemonReady={bridge.kind === 'present'}
        hasToken={hasToken}
        promptError={promptError}
      />

      {run ? <RunLog view={run} /> : null}

      {diffLoading ? (
        <Register labelId="reg-diff-loading" title={t('generate.diff.title')}>
          <p className="fb-meta">{t('generate.diff.loading')}</p>
        </Register>
      ) : null}

      {diffError ? (
        <Register labelId="reg-diff-error" title={t('generate.diff.title')}>
          <div className="flex flex-col gap-2">
            <p className="text-[0.9375rem] text-fg">{t('generate.diff.error')}</p>
            <p className="fb-meta">{diffError}</p>
          </div>
        </Register>
      ) : null}

      {diff ? (
        <DiffReview
          diff={diff}
          onApprove={approve}
          onReject={reject}
          outcome={outcome}
          approving={approving}
        />
      ) : null}

      {!run ? (
        <Register labelId="reg-diff-empty" title={t('generate.diff.title')}>
          <div className="flex max-w-[var(--fb-measure)] flex-col gap-2">
            <p className="text-[0.9375rem] text-fg">{t('generate.diff.none')}</p>
            {/*
              The approval promise, stated before there is anything to approve.
              A user should learn that this product stops for them from the page
              that would otherwise look like every other prompt box.
            */}
            <p className="fb-meta">{t('approval.explain')}</p>
          </div>
        </Register>
      ) : null}
    </div>
  );
}
