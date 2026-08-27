/**
 * The result of running the suite, as data.
 *
 * Deliberately not a test-framework binding. The suite has to be runnable from
 * vitest inside this repo, from an SDK's own harness, from a CI job that only
 * knows how to read exit codes, and eventually from the Python SDK over a shim
 * — so it computes a report and leaves the assertion to `assertConformant`.
 */

export type CaseOutcome = 'pass' | 'fail' | 'unsupported';

export interface ConformanceCase {
  /** Stable id. Named in reports and in `ConformanceOptions.only`; never renamed. */
  id: string;
  title: string;
  /** What the connector must do, in one sentence. */
  requirement: string;
  /** Where the requirement comes from: an ADR, a protocol module, an invariant. */
  source: string;
}

export interface CaseResult {
  case: ConformanceCase;
  outcome: CaseOutcome;
  /** Why it failed, one line per broken expectation. Empty when it passed. */
  failures: string[];
  /** Why it was skipped, or anything worth reading on a pass. */
  notes: string[];
  durationMs: number;
}

export interface ConformanceReport {
  adapter: string;
  startedAt: string;
  durationMs: number;
  results: CaseResult[];
  passed: number;
  failed: number;
  unsupported: number;
  /** Conformant means no failures. An unsupported case is a gap, not a breach. */
  ok: boolean;
}

export function summarise(adapter: string, startedAt: string, results: CaseResult[], durationMs: number): ConformanceReport {
  const passed = results.filter((result) => result.outcome === 'pass').length;
  const failed = results.filter((result) => result.outcome === 'fail').length;
  const unsupported = results.filter((result) => result.outcome === 'unsupported').length;
  return { adapter, startedAt, durationMs, results, passed, failed, unsupported, ok: failed === 0 };
}

const MARK: Record<CaseOutcome, string> = { pass: 'PASS', fail: 'FAIL', unsupported: 'SKIP' };

/**
 * A report rendered for a human reading CI output.
 *
 * Failures carry the case's requirement and its source, because the reader of a
 * failing conformance run is usually a connector author who has never read the
 * ADR the case is defending — and "apply-refused-without-approval failed" tells
 * them nothing they can act on.
 */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [
    `ForgeBridge connector conformance — ${report.adapter}`,
    `${report.passed} passed, ${report.failed} failed, ${report.unsupported} unsupported (${Math.round(report.durationMs)}ms)`,
    '',
  ];

  for (const result of report.results) {
    lines.push(`${MARK[result.outcome]}  ${result.case.id} — ${result.case.title}`);
    if (result.outcome === 'fail') {
      lines.push(`      requires: ${result.case.requirement}`);
      lines.push(`      source:   ${result.case.source}`);
      for (const failure of result.failures) lines.push(`      ✗ ${failure}`);
    }
    for (const note of result.notes) lines.push(`      · ${note}`);
  }

  return lines.join('\n');
}

export class ConformanceFailure extends Error {
  constructor(readonly report: ConformanceReport) {
    super(`connector "${report.adapter}" is not conformant: ${report.failed} case(s) failed\n\n${formatReport(report)}`);
    this.name = 'ConformanceFailure';
  }
}

/** Throw unless the report is clean. The one-line binding for any test runner. */
export function assertConformant(report: ConformanceReport): void {
  if (!report.ok) throw new ConformanceFailure(report);
}
