'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { LIMITS, type Finding, type Validation } from '@forgebridge/protocol';

import { useLocale } from '@/i18n/dictionary-context';
import type { ChangeSetDiff } from '@/lib/daemon/wire';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Field, TextInput } from '@/components/ui/field';
import { Register } from '@/components/ui/register';
import { StatusChip, StatusDot, type Status } from '@/components/ui/status-dot';
import { resolveDiff, sourceBytes, type ResolvedOperation } from './diff-model';

/**
 * The diff, and the decision (M35). This is the safety surface.
 *
 * ── Three rules, all from ADR-012 and DESIGN.md §6 ────────────────────────
 *
 * 1. **The code is shown, in full, never behind a disclosure.** A diff that
 *    collapses source behind "12 changes" is not a diff, and a user who
 *    approved one did not approve what they think they did. Every operation
 *    that installs Luau renders its Luau inline and untruncated — including the
 *    two forms that are easy to miss, `createInstance` carrying `Source` and
 *    `setProperty` of `Source`. See `diff-model.ts`: the Studio plugin reported
 *    "0 scripts" over a ChangeSet that installed one, and that is the defect
 *    this component is built not to repeat.
 *
 * 2. **The approve control is in this register's footer, after the
 *    operations.** Not in a toolbar above them, not beside the run button. An
 *    approval a user reaches before scrolling past the code is an approval they
 *    gave without reading it, and the placement is the only thing standing
 *    between those two.
 *
 * 3. **Approve carries the content digest.** The daemon requires the digest the
 *    diff reported, so a yes is a statement about the operations on this page
 *    rather than about an id those operations could be swapped under. This
 *    component cannot offer approval without a loaded diff, because without one
 *    it has no digest — which is the gate working rather than an obstacle.
 *
 * And one rule of this component's own: **when it cannot account for every
 * script the daemon says the set contains, it refuses to offer approval at
 * all.** `undisclosedScripts` is that check. It should never fire; if it does,
 * it fires in front of the person about to approve.
 */

function verdictStatus(status: 'ok' | 'warn' | 'fail'): Status {
  return status === 'ok' ? 'live' : status === 'warn' ? 'attend' : 'halt';
}

export interface ApprovalOutcome {
  readonly kind: 'approved' | 'rejected' | 'error';
  readonly message: string;
}

export function DiffReview({
  diff,
  onApprove,
  onReject,
  outcome,
  approving,
}: {
  diff: ChangeSetDiff;
  onApprove: (request: { approvedBy: string; note?: string; confirmBulkDelete: boolean }) => void;
  onReject: () => void;
  outcome: ApprovalOutcome | null;
  approving: boolean;
}) {
  const { t } = useLocale();
  const resolved = useMemo(() => resolveDiff(diff), [diff]);

  const validationFailed =
    diff.validation !== undefined &&
    (diff.validation.luau.status === 'fail' || diff.validation.policy.status === 'fail');

  return (
    <Register
      labelId="reg-diff"
      title={t('generate.diff.title')}
      meta={<Code>{diff.changeSetId}</Code>}
    >
      <div className="flex flex-col gap-5">
        <Header diff={diff} resolved={resolved} />

        {resolved.undisclosedScripts > 0 ? (
          <UndisclosedAlarm counted={diff.counts.scripts} shown={resolved.shownScripts} />
        ) : null}

        {diff.stale ? (
          <Notice status="halt">
            {t('generate.diff.stale', { base: diff.baseVersion, current: diff.currentVersion })}
          </Notice>
        ) : null}

        <ValidationPanel validation={diff.validation ?? null} />

        <Operations resolved={resolved} />

        <Digest diff={diff} />

        {/*
          The footer. Below every operation, below the code, below the digest —
          which is the placement rule from DESIGN.md §6, and the only part of
          this file that is about where a control sits rather than what it says.
        */}
        <div className="border-t border-rule pt-4">
          <ApprovalFooter
            diff={diff}
            blocked={
              validationFailed
                ? 'validation'
                : diff.stale
                  ? 'stale'
                  : resolved.undisclosedScripts > 0
                    ? 'undisclosed'
                    : null
            }
            onApprove={onApprove}
            onReject={onReject}
            outcome={outcome}
            approving={approving}
          />
        </div>
      </div>
    </Register>
  );
}

// ── header ──────────────────────────────────────────────────────────────────

function Header({
  diff,
  resolved,
}: {
  diff: ChangeSetDiff;
  resolved: ReturnType<typeof resolveDiff>;
}) {
  const { t } = useLocale();

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[var(--fb-measure)] text-[1rem] text-fg">{diff.summary}</p>

      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={diff.status === 'validated' ? 'attend' : 'idle'}>{diff.status}</StatusChip>
        {resolved.destructiveCount > 0 ? (
          <StatusChip status="halt">
            {t('generate.diff.op.deleteInstance')} · {resolved.destructiveCount}
          </StatusChip>
        ) : null}
        {diff.counts.scripts > 0 ? (
          <StatusChip status="attend">{t('generate.diff.scripts', { count: diff.counts.scripts })}</StatusChip>
        ) : null}
      </div>

      <p className="fb-meta">
        {t('generate.diff.counts', {
          total: diff.counts.total,
          creates: diff.counts.creates,
          setProperties: diff.counts.setProperties,
          moves: diff.counts.moves,
          deletes: diff.counts.deletes,
        })}
      </p>
      <p className="max-w-[var(--fb-measure)] fb-meta">{t('generate.diff.countsNote')}</p>

      {/*
        The daemon holds a version counter, not a tree, and says so on every
        diff it serves (`treeAware: false`). A diff view that quietly showed one
        side would be implying the other side was checked.
      */}
      <p className="max-w-[var(--fb-measure)] fb-meta border-t border-rule pt-3">
        {t('generate.diff.treeUnaware')}
      </p>
    </div>
  );
}

/**
 * The alarm that must never fire.
 *
 * `halt`, at the top of the register, above the operations — because if this is
 * on screen then the list below it is missing a script, and a reviewer who
 * scrolls past it to the code is scrolling past the reason the code is
 * incomplete.
 */
function UndisclosedAlarm({ counted, shown }: { counted: number; shown: number }) {
  const { t } = useLocale();

  return (
    <section
      aria-labelledby="diff-undisclosed"
      // `role="alert"` so it is announced the moment it renders. Everything
      // else on this page can wait for the reader; this cannot.
      role="alert"
      className="flex flex-col gap-2 border-s-2 border-halt bg-halt-wash p-3"
    >
      <h3 id="diff-undisclosed" className="text-[0.9375rem] font-semibold text-fg">
        {t('generate.diff.undisclosed.title')}
      </h3>
      <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">
        {t('generate.diff.undisclosed.body', { counted, shown })}
      </p>
    </section>
  );
}

function Notice({ status, children }: { status: Status; children: ReactNode }) {
  const tone = status === 'halt' ? 'border-halt bg-halt-wash' : 'border-attend bg-attend-wash';
  return (
    <p className={`max-w-[var(--fb-measure)] border-s-2 p-3 text-[0.875rem] text-fg ${tone}`}>
      {children}
    </p>
  );
}

// ── validation ──────────────────────────────────────────────────────────────

function ValidationPanel({ validation }: { validation: Validation | null }) {
  const { t, locale } = useLocale();

  if (!validation) {
    return (
      <section aria-labelledby="diff-validation" className="flex flex-col gap-2">
        <h3 id="diff-validation" className="fb-label">
          {t('generate.validation.title')}
        </h3>
        <Notice status="halt">{t('generate.validation.absent')}</Notice>
      </section>
    );
  }

  return (
    <section aria-labelledby="diff-validation" className="flex flex-col gap-3">
      <h3 id="diff-validation" className="fb-label">
        {t('generate.validation.title')}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 text-[0.875rem]">
          <span className="fb-label">{t('generate.validation.luau')}</span>
          <StatusChip status={verdictStatus(validation.luau.status)}>
            {t(`generate.validation.status.${validation.luau.status}`)}
          </StatusChip>
        </span>
        <span className="inline-flex items-center gap-2 text-[0.875rem]">
          <span className="fb-label">{t('generate.validation.policy')}</span>
          <StatusChip status={verdictStatus(validation.policy.status)}>
            {t(`generate.validation.status.${validation.policy.status}`)}
          </StatusChip>
        </span>
      </div>

      {/*
        Who computed this verdict, named. The brief asks for the label and the
        reason is in ADR-012's neighbourhood: a model-authored verdict is
        discarded by the core, and a verdict with no author is one a reader
        cannot tell apart from a model marking its own homework.
      */}
      <p className="fb-meta">
        {t('generate.validation.computedBy', {
          by: validation.computedBy,
          when: new Date(validation.computedAt).toLocaleString(locale),
        })}
      </p>
      <p className="max-w-[var(--fb-measure)] fb-meta">{t('generate.validation.computedNote')}</p>

      {validation.luau.findings.length > 0 ? (
        <FindingList findings={validation.luau.findings} />
      ) : null}

      {validation.policy.violations.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="fb-label">{t('generate.validation.violations')}</h4>
          <ul className="flex list-none flex-col gap-1 border-s-2 border-halt ps-3">
            {validation.policy.violations.map((violation, index) => (
              <li key={`${index}-${violation.slice(0, 24)}`} className="text-[0.875rem] text-fg">
                {violation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {validation.luau.findings.length === 0 && validation.policy.violations.length === 0 ? (
        <p className="fb-meta">{t('generate.validation.clean')}</p>
      ) : null}
    </section>
  );
}

function FindingList({ findings }: { findings: readonly Finding[] }) {
  const { t } = useLocale();

  return (
    <div className="flex flex-col gap-2">
      <h4 className="fb-label">{t('generate.validation.findings')}</h4>
      <ul className="flex flex-col gap-2">
        {findings.map((finding, index) => (
          <li key={`${finding.rule}-${index}`} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <StatusDot status={finding.severity === 'error' ? 'halt' : finding.severity === 'warning' ? 'attend' : 'idle'} />
              {/* The rule id is mono and LTR — it is an identifier, not prose. */}
              <Code>{finding.rule}</Code>
              {finding.operationIndex !== undefined ? (
                <span className="fb-meta">
                  {t('generate.validation.operationRef', { index: finding.operationIndex })}
                </span>
              ) : null}
              {finding.line !== undefined ? (
                <span className="fb-meta">{t('generate.validation.lineRef', { line: finding.line })}</span>
              ) : null}
            </div>
            <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">{finding.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── operations ──────────────────────────────────────────────────────────────

function Operations({ resolved }: { resolved: ReturnType<typeof resolveDiff> }) {
  const { t } = useLocale();

  return (
    <section aria-labelledby="diff-operations" className="flex flex-col gap-3">
      <h3 id="diff-operations" className="fb-label">
        {t('generate.diff.operations')}
      </h3>
      <ol className="flex flex-col gap-4">
        {resolved.operations.map((operation) => (
          <li key={operation.diff.index}>
            <OperationCard operation={operation} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function OperationCard({ operation }: { operation: ResolvedOperation }) {
  const { t } = useLocale();
  const { diff, content } = operation;

  // The op name comes from the dictionary when this build knows it, and falls
  // back to the raw wire value when it does not. A newer daemon's operation
  // shows as its own name rather than as a missing translation key.
  const opKey = `generate.diff.op.${diff.op}`;
  const opLabel = t(opKey);

  return (
    <article className="flex flex-col gap-2 border border-rule bg-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="fb-label">{String(diff.index)}</span>
        <span className="text-[0.875rem] font-semibold text-fg">
          {opLabel === opKey ? diff.op : opLabel}
        </span>
        {diff.destructive ? (
          <StatusChip status="halt">{t('generate.diff.destructive')}</StatusChip>
        ) : null}
        {operation.carriesLuau ? (
          <StatusChip status="attend">{t('generate.diff.carriesLuau')}</StatusChip>
        ) : null}
      </div>

      <p className="text-[0.875rem] text-fg-muted">{diff.summary}</p>

      <div className="flex flex-wrap items-baseline gap-2">
        <span className="fb-label">{t('generate.diff.paths')}</span>
        {diff.paths.map((path) => (
          <Code key={path}>{path}</Code>
        ))}
      </div>

      {content.kind === 'luau' ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="fb-label">{t('generate.diff.code')}</span>
            <span className="fb-meta">
              {t('generate.diff.codeBytes', { bytes: sourceBytes(content.source) })}
            </span>
          </div>
          {/*
            Rendered in full, always, with no disclosure and no truncation. The
            `Code` block is its own LTR island with `overflow-x: auto`, so a long
            Luau line scrolls rather than wrapping — DESIGN.md §5 prefers a
            horizontal scrollbar to a rewrapped line of code, and under `rtl` the
            isolation is what keeps the operators where the model put them.
          */}
          <Code block>{content.source}</Code>
        </div>
      ) : null}

      {content.kind === 'unreadable-source' ? (
        <div className="flex flex-col gap-1">
          <Notice status="halt">{t('generate.diff.unreadableSource')}</Notice>
          {content.raw.length > 0 ? <Code block>{content.raw}</Code> : null}
        </div>
      ) : null}

      {content.kind === 'value' && content.raw.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="fb-label">{t('generate.diff.value')}</span>
          <Code block>{content.raw}</Code>
        </div>
      ) : null}

      {diff.properties && Object.keys(diff.properties).length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="fb-label">{t('generate.diff.properties')}</span>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.8125rem]">
            {Object.entries(diff.properties).map(([name, value]) => (
              <div key={name} className="contents">
                <dt>
                  <Code>{name}</Code>
                </dt>
                <dd className="min-w-0 overflow-x-auto">
                  <Code>{value}</Code>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </article>
  );
}

function Digest({ diff }: { diff: ChangeSetDiff }) {
  const { t } = useLocale();

  return (
    <section aria-labelledby="diff-digest" className="flex flex-col gap-1 border-t border-rule pt-3">
      <h3 id="diff-digest" className="fb-label">
        {t('generate.diff.digest')}
      </h3>
      <p className="overflow-x-auto">
        <Code className="whitespace-pre">{diff.contentDigest}</Code>
      </p>
      <p className="max-w-[var(--fb-measure)] fb-meta">{t('generate.diff.digestNote')}</p>
    </section>
  );
}

// ── the decision ────────────────────────────────────────────────────────────

function ApprovalFooter({
  diff,
  blocked,
  onApprove,
  onReject,
  outcome,
  approving,
}: {
  diff: ChangeSetDiff;
  blocked: 'validation' | 'stale' | 'undisclosed' | null;
  onApprove: (request: { approvedBy: string; note?: string; confirmBulkDelete: boolean }) => void;
  onReject: () => void;
  outcome: ApprovalOutcome | null;
  approving: boolean;
}) {
  const { t } = useLocale();
  const byId = useId();
  const noteId = useId();
  const bulkId = useId();

  // `approvedBy` defaults to the value the wire schema defaults to, so a user
  // who does not fill it in produces the same journal entry the daemon would
  // have written anyway rather than an empty string.
  const [approvedBy, setApprovedBy] = useState('local');
  const [note, setNote] = useState('');
  const [confirmBulk, setConfirmBulk] = useState(false);

  const bulkDelete = diff.counts.deletes > LIMITS.BULK_DELETE_CONFIRM_THRESHOLD;
  const canApprove = blocked === null && !approving && (!bulkDelete || confirmBulk);

  if (outcome?.kind === 'approved' || outcome?.kind === 'rejected') {
    return (
      <div className="flex flex-col gap-2">
        <p role="status" className="text-[0.9375rem] text-fg">
          {outcome.message}
        </p>
        {outcome.kind === 'rejected' ? (
          <p className="max-w-[var(--fb-measure)] fb-meta">{t('generate.approve.rejectExplain')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="fb-label">{t('generate.approve.title')}</h3>
        <p className="max-w-[var(--fb-measure)] text-[0.875rem] text-fg">{t('generate.approve.explain')}</p>
        <p className="max-w-[var(--fb-measure)] fb-meta">{t('generate.approve.readFirst')}</p>
      </div>

      {blocked ? (
        <Notice status="halt">
          {blocked === 'validation'
            ? t('generate.approve.blockedValidation')
            : blocked === 'stale'
              ? t('generate.approve.blockedStale')
              : t('generate.approve.blockedUndisclosed')}
        </Notice>
      ) : null}

      {blocked === null ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={byId} label={t('generate.approve.approvedBy')}>
            {(described) => (
              <TextInput
                {...described}
                value={approvedBy}
                maxLength={120}
                placeholder={t('generate.approve.approvedByPlaceholder')}
                onChange={(event) => setApprovedBy(event.target.value)}
              />
            )}
          </Field>
          <Field id={noteId} label={t('generate.approve.note')}>
            {(described) => (
              <TextInput
                {...described}
                value={note}
                maxLength={500}
                placeholder={t('generate.approve.notePlaceholder')}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </Field>
        </div>
      ) : null}

      {bulkDelete && blocked === null ? (
        /*
          The protocol's bulk-delete gate, surfaced as its own deliberate
          checkbox rather than folded into the approve button. Past the
          threshold the daemon refuses an approval that does not carry
          `confirmBulkDelete`, and a UI that set the flag silently on the user's
          behalf would be answering a question the protocol asked *them*.
        */
        <div className="flex flex-col gap-2 border-s-2 border-halt bg-halt-wash p-3">
          <p className="text-[0.875rem] text-fg">
            {t('generate.approve.bulkDelete', {
              count: diff.counts.deletes,
              threshold: LIMITS.BULK_DELETE_CONFIRM_THRESHOLD,
            })}
          </p>
          <label htmlFor={bulkId} className="inline-flex items-center gap-2 text-[0.875rem] font-medium text-fg">
            <input
              id={bulkId}
              type="checkbox"
              checked={confirmBulk}
              onChange={(event) => setConfirmBulk(event.target.checked)}
              className="size-4 accent-[var(--fb-halt)]"
            />
            {t('generate.approve.bulkDeleteConfirm', { count: diff.counts.deletes })}
          </label>
        </div>
      ) : null}

      {outcome?.kind === 'error' ? (
        <Notice status="halt">
          <span className="font-medium">{t('generate.approve.error')}</span> — {outcome.message}
        </Notice>
      ) : null}

      {/*
        Two separate controls, and the approve one is `consent` — a ruled outline
        with an amber border, deliberately not the heaviest weight on screen.
        DESIGN.md §6: an approval that looks like the primary action is an
        approval people click through on the way somewhere else.

        Reject is an ordinary secondary button. Neither is red, because there is
        no `danger` variant in this system and a red button is a button people
        learn to click.
      */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          weight="consent"
          disabled={!canApprove}
          onClick={() =>
            onApprove({
              approvedBy: approvedBy.trim() || 'local',
              ...(note.trim() ? { note: note.trim() } : {}),
              confirmBulkDelete: confirmBulk,
            })
          }
        >
          {approving ? t('generate.approve.working') : t('generate.approve.button')}
        </Button>
        <Button onClick={onReject} disabled={approving}>
          {t('generate.approve.reject')}
        </Button>
      </div>
    </div>
  );
}
