'use client';

import NextLink from 'next/link';
import { useId, useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { useBridge } from '@/lib/daemon/use-daemon';
import { parsePlaceId, validateName, type ProjectRecord } from '@/lib/projects/store';
import { useProjects } from '@/lib/projects/use-projects';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Field, TextInput } from '@/components/ui/field';
import { Register } from '@/components/ui/register';
import { StatusChip } from '@/components/ui/status-dot';
import { PathPrefixEditor } from './path-prefix-editor';

/**
 * The projects surface (M34): create, list, open, delete.
 *
 * ── What is on screen and why ─────────────────────────────────────────────
 *
 * Three registers, in the order a first-run user needs them: create, the
 * daemon-alignment note (only when there is something to say), then the list.
 *
 * The alignment note is the part that is not obvious and is the most useful
 * thing this page does. Runs are attributed to a project id; the daemon
 * generates one per process and holds a path policy against it. A project
 * created here gets a fresh uuid, and a run against *that* id falls to the
 * daemon's default policy — which is `DENY_ALL_POLICY` unless the daemon was
 * started with `--allowed-paths`. The user would see a policy violation with no
 * hint as to why. So the page compares the two ids and offers to create a
 * project on the daemon's, which is the thing that actually works.
 *
 * Everything here runs signed out (ADR-005). There is no account branch in this
 * file, not even a disabled one.
 */
export function ProjectsSurface() {
  const { t, locale } = useLocale();
  const { state, create, remove, select } = useProjects();
  const { state: bridge } = useBridge();

  const daemonProjectId = bridge.kind === 'present' ? (bridge.link?.defaultProjectId ?? null) : null;

  if (state.kind === 'loading') {
    return <p className="fb-meta">{t('common.loading')}</p>;
  }

  if (state.kind === 'unavailable') {
    return (
      <Register labelId="reg-storage" title={t('projects.storageUnavailable.title')}>
        <div className="flex max-w-[var(--fb-measure)] flex-col gap-2">
          <p className="text-[0.9375rem] text-fg-muted">{t('projects.storageUnavailable.body')}</p>
          <p className="fb-meta">{t('projects.storageUnavailable.detail', { detail: state.detail })}</p>
        </div>
      </Register>
    );
  }

  const hasDaemonProject =
    daemonProjectId !== null && state.projects.some((project) => project.id === daemonProjectId);

  return (
    <div className="flex flex-col gap-5">
      <Register labelId="reg-new-project" title={t('projects.create.title')}>
        <CreateProjectForm
          onCreate={(draft) => create(draft)}
          suggestedId={hasDaemonProject ? null : daemonProjectId}
        />
      </Register>

      {daemonProjectId !== null && !hasDaemonProject && state.projects.length > 0 ? (
        <Register labelId="reg-adopt" title={t('projects.adopt.title')}>
          <div className="flex max-w-[var(--fb-measure)] flex-col gap-3">
            <p className="text-[0.9375rem] text-fg-muted">
              {t('projects.adopt.body', {
                local: state.projects[0]?.id ?? '—',
                daemon: daemonProjectId,
              })}
            </p>
            <div>
              <Button
                weight="secondary"
                onClick={() => {
                  void create({
                    name: t('generate.composer.projectDaemonDefault'),
                    placeId: null,
                    allowedPathPrefixes: [],
                    id: daemonProjectId,
                  });
                }}
              >
                {t('projects.adopt.use')}
              </Button>
            </div>
          </div>
        </Register>
      ) : null}

      <Register
        labelId="reg-projects"
        title={t('projects.list.title')}
        meta={state.projects.length > 0 ? t('projects.count', { count: state.projects.length }) : undefined}
      >
        {state.projects.length === 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-[0.9375rem] text-fg">{t('projects.list.empty')}</p>
            <p className="fb-meta">{t('projects.list.emptyHint')}</p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {state.projects.map((project, index) => (
              <li key={project.id} className={index > 0 ? 'border-t border-rule pt-4' : ''}>
                <ProjectRow
                  project={project}
                  locale={locale}
                  daemonProjectId={daemonProjectId}
                  selected={project.id === state.selectedId}
                  onSelect={() => void select(project.id)}
                  onDelete={() => void remove(project.id)}
                  className={index > 0 ? '' : 'pb-4'}
                />
              </li>
            ))}
          </ul>
        )}
      </Register>

      <Register labelId="reg-policy-note" title={t('projects.policyNote.title')} as="aside">
        <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg-muted">
          {t('projects.policyNote.body')}
        </p>
      </Register>
    </div>
  );
}

// ── create ──────────────────────────────────────────────────────────────────

function CreateProjectForm({
  onCreate,
  suggestedId,
}: {
  onCreate: (draft: {
    name: string;
    placeId: number | null;
    allowedPathPrefixes: readonly string[];
    id?: string;
  }) => Promise<ProjectRecord | null>;
  /** The daemon's project id, when this browser has no project on it yet. */
  suggestedId: string | null;
}) {
  const { t } = useLocale();
  const nameId = useId();
  const placeId = useId();

  const [name, setName] = useState('');
  const [place, setPlace] = useState('');
  const [prefixes, setPrefixes] = useState<readonly string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (): void => {
    const parsedName = validateName(name);
    const parsedPlace = parsePlaceId(place);
    setNameError(parsedName.ok ? null : t('projects.create.nameRequired'));
    setPlaceError(parsedPlace.ok ? null : t('projects.create.placeIdInvalid'));
    if (!parsedName.ok || !parsedPlace.ok) return;

    setBusy(true);
    void onCreate({
      name: parsedName.value,
      placeId: parsedPlace.value,
      allowedPathPrefixes: prefixes,
      // Adopting the daemon's id at creation is offered here rather than only
      // in the separate register above, because at first run there is no list
      // yet and the register has nothing to compare against.
      ...(suggestedId ? { id: suggestedId } : {}),
    }).then(() => {
      setBusy(false);
      setName('');
      setPlace('');
      setPrefixes([]);
    });
  };

  return (
    <form
      className="flex max-w-[var(--fb-measure)] flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field id={nameId} label={t('projects.create.name')} error={nameError}>
        {(described) => (
          <TextInput
            {...described}
            value={name}
            disabled={busy}
            maxLength={80}
            placeholder={t('projects.create.namePlaceholder')}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(null);
            }}
          />
        )}
      </Field>

      <Field
        id={placeId}
        label={t('projects.create.placeId')}
        hint={t('projects.create.placeIdHelp')}
        error={placeError}
      >
        {(described) => (
          <TextInput
            {...described}
            // `inputMode` rather than `type="number"`: a number input brings
            // spinners, scroll-wheel mutation and locale-dependent grouping to
            // a field that is an identifier, not a quantity.
            inputMode="numeric"
            dir="ltr"
            className="font-mono"
            value={place}
            disabled={busy}
            placeholder="0000000000"
            onChange={(event) => {
              setPlace(event.target.value);
              if (placeError) setPlaceError(null);
            }}
          />
        )}
      </Field>

      <PathPrefixEditor value={prefixes} onChange={setPrefixes} disabled={busy} />

      {suggestedId ? (
        // Stated before the button, not after: the user is about to create a
        // project whose id was chosen for them, and the reason it was chosen —
        // it is the id the daemon holds a policy for — is the difference between
        // a run that works and a policy violation they cannot diagnose.
        <p className="fb-meta">
          {t('projects.adopt.use')} — <Code>{suggestedId}</Code>
        </p>
      ) : null}

      <div>
        <Button type="submit" weight="primary" disabled={busy}>
          {t('projects.create.submit')}
        </Button>
      </div>
    </form>
  );
}

// ── a row ───────────────────────────────────────────────────────────────────

function ProjectRow({
  project,
  locale,
  daemonProjectId,
  selected,
  onSelect,
  onDelete,
  className = '',
}: {
  project: ProjectRecord;
  locale: string;
  daemonProjectId: string | null;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);

  /**
   * Whether this project is the one the daemon is currently holding a policy
   * for. Three states, not two: with no daemon there is nothing to compare
   * against, and rendering that as "does not match" would be asserting a
   * mismatch nobody has observed.
   */
  const alignment: 'live' | 'attend' | 'idle' =
    daemonProjectId === null ? 'idle' : project.id === daemonProjectId ? 'live' : 'attend';
  const alignmentLabel =
    daemonProjectId === null
      ? t('projects.adopt.unknown')
      : project.id === daemonProjectId
        ? t('projects.adopt.matched')
        : t('projects.adopt.differs');

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <NextLink
            href={`/${locale}/projects/${project.id}`}
            className="rounded-sm text-[1rem] font-semibold text-fg underline decoration-rule-strong underline-offset-4 hover:decoration-fg"
          >
            {project.name}
          </NextLink>
          {selected ? <StatusChip status="live">{t('projects.row.selected')}</StatusChip> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selected ? null : (
            <Button onClick={onSelect}>{t('projects.row.select')}</Button>
          )}
          <Button onClick={() => setConfirming((open) => !open)} aria-expanded={confirming}>
            {t('projects.row.delete')}
          </Button>
        </div>
      </div>

      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.8125rem] text-fg-muted">
        <Fact label={t('projects.row.placeId')}>
          {project.placeId === null ? (
            <span className="text-fg-faint">{t('projects.row.noPlaceId')}</span>
          ) : (
            <Code>{String(project.placeId)}</Code>
          )}
        </Fact>
        <Fact label={t('projects.detail.version')}>
          {project.versionObservedAt === null ? (
            <span className="text-fg-faint">{t('projects.row.versionNever')}</span>
          ) : (
            <>
              {t('projects.row.version', { version: project.treeSnapshotVersion })}{' '}
              <span className="text-fg-faint">
                {t('projects.row.versionObserved', {
                  when: new Date(project.versionObservedAt).toLocaleString(locale),
                })}
              </span>
            </>
          )}
        </Fact>
        <Fact label={t('projects.create.prefixes')}>
          {project.allowedPathPrefixes.length === 0 ? (
            <span className="text-fg-faint">{t('projects.row.noPrefixes')}</span>
          ) : (
            t('projects.row.prefixes', { count: project.allowedPathPrefixes.length })
          )}
        </Fact>
      </dl>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusChip status={alignment}>{alignmentLabel}</StatusChip>
        <Code className="bg-transparent px-0 text-fg-faint">{project.id}</Code>
      </div>

      {confirming ? (
        /*
          Deletion is confirmed in place, in words, with the consequence spelled
          out — not in a `window.confirm` and not behind a red button. DESIGN.md
          §1: there is no `danger` variant, because a red button is a button
          people learn to click. The destructive control here is an ordinary
          secondary button whose *label* says what it does.
        */
        <div className="flex flex-col gap-2 border-s-2 border-halt bg-halt-wash p-3">
          <p className="text-[0.875rem] font-medium text-fg">
            {t('projects.row.deleteConfirm', { name: project.name })}
          </p>
          <p className="fb-meta">{t('projects.row.deleteExplain')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              {t('projects.row.deleteYes')}
            </Button>
            <Button weight="primary" onClick={() => setConfirming(false)}>
              {t('projects.row.deleteNo')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One labelled fact. A `div` between the `dl` and its `dt`/`dd` because that is
 * the only wrapper the HTML spec allows inside a definition list — a `span`
 * there is invalid markup, and invalid markup inside a `dl` is what makes a
 * screen reader stop reporting it as a list at all.
 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inline-flex items-baseline gap-1.5">
      <dt className="fb-label">{label}</dt>
      <dd className="text-fg">{children}</dd>
    </div>
  );
}
