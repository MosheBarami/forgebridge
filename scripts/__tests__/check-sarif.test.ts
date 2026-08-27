import { describe, expect, it } from 'vitest';

import { DEFAULT_SEVERITY_THRESHOLD, checkSarif, parseArgs } from '../check-sarif.js';

/**
 * The gate's own tests.
 *
 * `.github/workflows/codeql.yml` leans on this script for the only thing that
 * makes CodeQL a merge blocker rather than a tab, so a version of it that
 * returned "clean" for everything would be worse than no job at all: it would
 * put a green check next to an analysis nobody read. Every refusal below is
 * planted, and every refusal has beside it the legitimate report it is most
 * confusable with, because a gate that fires on an ordinary low-severity alert
 * is a gate somebody deletes.
 */

interface RuleSpec {
  id: string;
  severity?: string | number;
}

function report(
  rules: readonly RuleSpec[],
  results: ReadonlyArray<{ ruleId: string; level?: string }>,
): unknown {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'CodeQL',
            rules: rules.map((rule) => ({
              id: rule.id,
              ...(rule.severity === undefined
                ? {}
                : { properties: { 'security-severity': rule.severity } }),
            })),
          },
        },
        results: results.map((result) => ({
          ruleId: result.ruleId,
          ...(result.level === undefined ? {} : { level: result.level }),
          message: { text: `finding from ${result.ruleId}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'packages/core/src/pipeline.ts' },
                region: { startLine: 42 },
              },
            },
          ],
        })),
      },
    ],
  };
}

describe('a report this gate cannot read is a refusal, not a pass', () => {
  it.each([
    ['a string where an object should be', 'not a sarif document'],
    ['null', null],
    ['an array', []],
  ])('refuses %s', (_label, document) => {
    const verdict = checkSarif(document);
    expect(verdict.readable).toBe(false);
  });

  it('refuses a version it does not know', () => {
    const verdict = checkSarif({ version: '3.0.0', runs: [{ results: [] }] });
    expect(verdict.readable).toBe(false);
    expect(verdict.summary).toContain('2.1');
  });

  it('refuses a report with no runs — that is a scan that never happened', () => {
    // The most important refusal in the file. An empty report is what a
    // scanner step produces when it was skipped, and "the analysis emitted
    // nothing" must never read the same as "the analysis found nothing".
    expect(checkSarif({ version: '2.1.0', runs: [] }).readable).toBe(false);
    expect(checkSarif({ version: '2.1.0' }).readable).toBe(false);
  });

  it('refuses a run that is not an object', () => {
    expect(checkSarif({ version: '2.1.0', runs: ['not a run'] }).readable).toBe(false);
  });
});

describe('severity decides, and an unresolved severity blocks', () => {
  it('blocks a result at or above the threshold', () => {
    const verdict = checkSarif(
      report([{ id: 'js/sql-injection', severity: '9.8' }], [{ ruleId: 'js/sql-injection', level: 'error' }]),
    );
    expect(verdict.readable).toBe(true);
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]?.severity).toBe(9.8);
  });

  it('blocks exactly at the threshold, not just above it', () => {
    const verdict = checkSarif(
      report([{ id: 'js/x', severity: String(DEFAULT_SEVERITY_THRESHOLD) }], [{ ruleId: 'js/x', level: 'warning' }]),
    );
    expect(verdict.blocking).toHaveLength(1);
  });

  it('blocks an error whose rule declares no security-severity', () => {
    // The fail-closed clause. A result this gate could not score has not been
    // shown to be minor; it has not been shown to be anything.
    const verdict = checkSarif(report([{ id: 'js/mystery' }], [{ ruleId: 'js/mystery', level: 'error' }]));
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]?.reason).toContain('unknown rather than low');
  });

  it('blocks a result whose rule is not in the report at all', () => {
    const verdict = checkSarif(report([], [{ ruleId: 'js/undeclared', level: 'error' }]));
    expect(verdict.blocking).toHaveLength(1);
  });

  it('blocks a result with no level and no severity', () => {
    const verdict = checkSarif(report([{ id: 'js/mystery' }], [{ ruleId: 'js/mystery' }]));
    expect(verdict.blocking).toHaveLength(1);
  });

  it('accepts a numeric security-severity as well as the string SARIF actually uses', () => {
    // Refusing the numeric form would make the verdict depend on a producer's
    // choice of encoding rather than on the number.
    const verdict = checkSarif(report([{ id: 'js/x', severity: 9.1 }], [{ ruleId: 'js/x', level: 'error' }]));
    expect(verdict.blocking).toHaveLength(1);
  });
});

describe('the controls — what must not block, or the gate gets switched off', () => {
  it('passes a report with runs and no results', () => {
    const verdict = checkSarif(report([{ id: 'js/x', severity: '9.8' }], []));
    expect(verdict.readable).toBe(true);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.summary).toContain('1 run(s)');
  });

  it('does not block a genuinely low-severity alert', () => {
    // This is the case that would make every pull request red if the gate
    // blocked on any finding at all. It is reported and it is in the Security
    // tab; it does not stop a merge.
    const verdict = checkSarif(
      report([{ id: 'js/unused-local', severity: '3.1' }], [{ ruleId: 'js/unused-local', level: 'note' }]),
    );
    expect(verdict.results).toHaveLength(1);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.results[0]?.reason).toContain('below the');
  });

  it('does not block a warning whose rule declares a low severity', () => {
    const verdict = checkSarif(
      report([{ id: 'js/x', severity: '5.0' }], [{ ruleId: 'js/x', level: 'warning' }]),
    );
    expect(verdict.blocking).toHaveLength(0);
  });

  it('resolves a rule referenced by index rather than by id', () => {
    // Some producers point at `rule.index` instead of `ruleId`. Failing to
    // resolve those would leave them unscored and therefore blocking — correct,
    // and noisy for no reason.
    const document = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'x', rules: [{ id: 'js/low', properties: { 'security-severity': '2.0' } }] } },
          results: [{ ruleId: 'js/low', rule: { index: 0 }, level: 'warning', message: { text: 'x' } }],
        },
      ],
    };
    expect(checkSarif(document).blocking).toHaveLength(0);
  });

  it('reads rules declared by a tool extension, not only by the driver', () => {
    const document = {
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: { name: 'CodeQL' },
            extensions: [
              { name: 'codeql/javascript-queries', rules: [{ id: 'js/low', properties: { 'security-severity': '1.0' } }] },
            ],
          },
          results: [{ ruleId: 'js/low', level: 'note', message: { text: 'x' } }],
        },
      ],
    };
    expect(checkSarif(document).blocking).toHaveLength(0);
  });
});

describe('the threshold is an argument, and an unreadable one is refused', () => {
  it('takes a file and a threshold', () => {
    expect(parseArgs(['results.sarif', '--threshold', '4.5'])).toEqual({
      file: 'results.sarif',
      threshold: 4.5,
    });
  });

  it('defaults to CVSS high', () => {
    expect(parseArgs(['results.sarif']).threshold).toBe(DEFAULT_SEVERITY_THRESHOLD);
  });

  it('throws on a threshold it cannot read rather than falling back to the default', () => {
    // A typo that silently restored the default would widen what passes, which
    // is the whole family of defect this gate exists inside.
    expect(() => parseArgs(['results.sarif', '--threshold', 'high'])).toThrow(/requires a number/);
  });

  it('lowering the threshold catches what the default let through', () => {
    const document = report([{ id: 'js/x', severity: '5.0' }], [{ ruleId: 'js/x', level: 'warning' }]);
    expect(checkSarif(document).blocking).toHaveLength(0);
    expect(checkSarif(document, 4.0).blocking).toHaveLength(1);
  });
});
