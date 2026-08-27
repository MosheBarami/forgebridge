import { describe, expect, it } from 'vitest';
import { CONFORMANCE_CASES, ConformanceFailure, assertConformant, formatReport, summarise } from '../src/index.js';
import type { CaseResult } from '../src/report.js';

const stub = (id: string, outcome: CaseResult['outcome'], failures: string[] = []): CaseResult => ({
  case: { id, title: `title of ${id}`, requirement: `requirement of ${id}`, source: `source of ${id}` },
  outcome,
  failures,
  notes: [],
  durationMs: 1,
});

describe('the report', () => {
  it('is conformant when nothing failed, unsupported cases included', () => {
    const report = summarise('adapter', new Date().toISOString(), [stub('a', 'pass'), stub('b', 'unsupported')], 2);
    expect(report).toMatchObject({ passed: 1, unsupported: 1, failed: 0, ok: true });
    expect(() => assertConformant(report)).not.toThrow();
  });

  it('is not conformant when a case failed, and says which and why', () => {
    const report = summarise('adapter', new Date().toISOString(), [stub('a', 'fail', ['it did the wrong thing'])], 2);
    expect(report.ok).toBe(false);

    let thrown: unknown;
    try {
      assertConformant(report);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConformanceFailure);
    const message = (thrown as Error).message;
    // A connector author reading CI output has usually never read the ADR the
    // case defends, so the failure carries the requirement and its source.
    expect(message).toContain('requirement of a');
    expect(message).toContain('source of a');
    expect(message).toContain('it did the wrong thing');
  });

  it('renders unsupported cases without pretending they passed', () => {
    const rendered = formatReport(summarise('adapter', new Date().toISOString(), [stub('b', 'unsupported')], 1));
    expect(rendered).toContain('SKIP  b');
    expect(rendered).toContain('0 passed, 0 failed, 1 unsupported');
  });
});

describe('the case list', () => {
  it('has unique ids and says what each case requires and where the requirement comes from', () => {
    const ids = CONFORMANCE_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of CONFORMANCE_CASES) {
      expect(testCase.requirement.length, testCase.id).toBeGreaterThan(20);
      expect(testCase.source.length, testCase.id).toBeGreaterThan(5);
      expect(testCase.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('keeps the approval gate ahead of the approval that opens it', () => {
    const ids = CONFORMANCE_CASES.map((testCase) => testCase.id);
    // The only ordering the suite depends on: the case that approves works on
    // the ChangeSet the case before it was refused.
    expect(ids.indexOf('apply-refused-without-approval')).toBeLessThan(ids.indexOf('apply-after-human-approval'));
  });
});
