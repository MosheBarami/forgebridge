/**
 * The fixture that proves `forgebridge.yml` is a gate rather than a decoration.
 *
 * Every rule appears twice: once as a planted violation marked `ruleid:`, which
 * semgrep's `--test` mode fails if the rule does not report, and once as the
 * legitimate shape it is most confusable with, marked `ok:`, which the same run
 * fails if the rule *does* report. The second half is not politeness — a rule
 * that fires on ordinary code is a rule someone adds an ignore file to, and an
 * ignored rule and a deleted rule protect exactly as much.
 *
 * Read the `ok:` cases as the specification of what the rules deliberately
 * permit. Several of them are transcriptions of real code in this repository:
 * `analyseFailsClosed` is the shape of `packages/luau-analysis/src/analyse.ts`,
 * and `applyAfterClaim` is the shape of `RunPipeline#apply`.
 *
 * This file is excluded from the real scan by `--exclude scripts/semgrep` on the
 * command line rather than by a `paths:` entry in the rules, because a `paths:`
 * exclusion applies in `--test` mode too and would quietly stop the self-test
 * from testing anything.
 *
 * It typechecks: `scripts/tsconfig.json` includes every `.ts` under `scripts/`,
 * so a fixture that did not compile would fail `npm run typecheck` rather than
 * the rule it was written for. Nothing here is imported by anything.
 */

/* eslint-disable */

type Status = 'ok' | 'warn' | 'fail';
interface Verdict {
  status: Status;
  findings: readonly string[];
}
interface ChangeSetStore {
  setStatus(id: string, next: string, expected: string): Promise<boolean>;
}
interface Link {
  id: string;
}
interface Consumer {
  deliver(link: Link, set: { id: string }): Promise<{ nonce: number }>;
}
interface Span {
  setAttributes(attributes: Record<string, string>): void;
  addEvent(name: string, attributes: Record<string, string>): void;
}
interface ResponseLike {
  end(chunk: string): void;
  write(chunk: string): void;
}

declare function tokenize(source: string): readonly string[];
declare function ruleFindings(tokens: readonly string[]): readonly string[];
declare const store: ChangeSetStore;
declare const consumer: Consumer;
declare const link: Link;
declare const changeSet: { id: string };
declare const span: Span;
declare const res: ResponseLike;
declare const settings: { apiKey: string; keyName: string };

// ── FB1: a check that reports a pass because it could not run ───────────────

export function analyseFailsOpen(source: string): Verdict {
  // ruleid: forgebridge-fail-open-catch
  try {
    const findings = ruleFindings(tokenize(source));
    return { status: findings.length > 0 ? 'fail' : 'ok', findings };
  } catch {
    return { status: 'ok', findings: [] };
  }
}

export function tokenizerFailsOpen(source: string): { ok: boolean } {
  // ruleid: forgebridge-fail-open-catch
  try {
    tokenize(source);
    return { ok: true };
  } catch (error) {
    void error;
    return { ok: true };
  }
}

/**
 * The control, and it is the real one: this is what
 * `packages/luau-analysis/src/analyse.ts` does. A rule that threw has not
 * checked anything and the honest report of that is a refusal, so the catch
 * returns `fail`. It must not be reported.
 */
export function analyseFailsClosed(source: string): Verdict {
  // ok: forgebridge-fail-open-catch
  try {
    const findings = ruleFindings(tokenize(source));
    return { status: findings.length > 0 ? 'fail' : 'ok', findings };
  } catch (error) {
    return {
      status: 'fail',
      findings: [`the analyser failed while reading this script: ${String(error)}`],
    };
  }
}

// ── FB2: a verdict that defaults to a pass ──────────────────────────────────

declare const computedStatus: Status | undefined;
declare const computedVerdict: Verdict | undefined;

// ruleid: forgebridge-verdict-defaults-to-pass
export const statusWithFallback: Status = computedStatus ?? 'ok';

// ruleid: forgebridge-verdict-defaults-to-pass
export const verdictWithFallback: Verdict = computedVerdict ?? { status: 'ok', findings: [] };

/**
 * The control: an absent analyser is `warn` with a reason, which is what
 * `packages/core/src/validate.ts` actually returns. Defaulting to the
 * *unfinished* verdict rather than to the passing one is the whole distinction.
 */
// ok: forgebridge-verdict-defaults-to-pass
export const statusWithHonestFallback: Verdict = computedVerdict ?? {
  status: 'warn',
  findings: ['core/luau-analysis-unavailable'],
};

// ── FB3: a credential reaching a log, a response or a telemetry attribute ───

export function logsTheKey(apiKey: string): void {
  // ruleid: forgebridge-credential-to-sink
  console.log('using key', apiKey);
}

export function logsTheKeyOffAnObject(): void {
  // ruleid: forgebridge-credential-to-sink
  console.error('provider rejected', settings.apiKey);
}

export function returnsTheKey(secret: string): void {
  // ruleid: forgebridge-credential-to-sink
  res.end(secret);
}

export function tracesTheKey(accessToken: string): void {
  // ruleid: forgebridge-credential-to-sink
  span.setAttributes({ 'forgebridge.provider.token': accessToken });
}

/**
 * The controls. `keyName` labels a credential and is not one — the same
 * distinction `scripts/verify-no-key-storage.ts` and `verify-no-secrets.ts`
 * both draw — and a run id is not credential-shaped at all. Neither may be
 * reported, or every honest log line in the repository becomes a finding.
 */
export function logsTheKeyName(): void {
  // ok: forgebridge-credential-to-sink
  console.log('using key', settings.keyName);
}

export function logsARunId(runId: string): void {
  // ok: forgebridge-credential-to-sink
  console.log('run', runId);
}

// ── FB4: a privileged transition naming the wrong predecessor ───────────────

export async function approvesFromAnything(id: string): Promise<boolean> {
  // ruleid: forgebridge-privileged-status-transition
  return await store.setStatus(id, 'approved', 'proposed');
}

export async function appliesWithoutApproval(id: string): Promise<boolean> {
  // ruleid: forgebridge-privileged-status-transition
  return await store.setStatus(id, 'applying', 'validated');
}

/** The controls: the three transitions the pipeline actually performs. */
export async function approvesFromValidated(id: string): Promise<boolean> {
  // ok: forgebridge-privileged-status-transition
  return await store.setStatus(id, 'approved', 'validated');
}

export async function rejectsFromValidated(id: string): Promise<boolean> {
  // ok: forgebridge-privileged-status-transition
  return await store.setStatus(id, 'rejected', 'validated');
}

// ── FB5: an apply path that never claimed the set ───────────────────────────

export async function deliverWithoutClaim(): Promise<void> {
  // ruleid: forgebridge-deliver-without-claiming-approval
  await consumer.deliver(link, changeSet);
}

/** The control: the shape of `RunPipeline#apply` — claim first, then deliver. */
export async function applyAfterClaim(): Promise<void> {
  await store.setStatus(changeSet.id, 'applying', 'approved');
  // ok: forgebridge-deliver-without-claiming-approval
  await consumer.deliver(link, changeSet);
}
