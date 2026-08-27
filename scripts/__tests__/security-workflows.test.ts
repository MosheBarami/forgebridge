import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkActionPins,
  checkPermissions,
  checkPipPins,
  checkSemgrepFixtures,
  checkSemgrepWorkflow,
  checkThreatModelNamesWorkflows,
  semgrepRuleIds,
  type WorkflowFile,
} from '../workflow-rules.js';

/**
 * Two halves, in the shape every gate in this directory uses.
 *
 * The first half runs the rules over the real `.github/workflows/` and over the
 * real Semgrep rule set: it is what fails when somebody adds a workflow with a
 * floating `uses: owner/action@main`, installs a scanner without pinning it, or
 * writes a sixth Semgrep rule and never plants a violation of it.
 *
 * The second half plants a violation of each rule and proves the rule rejects
 * it, because a gate that cannot fail is decoration — and beside each planted
 * violation, the legitimate shape it is most confusable with, because a gate
 * that fires on ordinary content gets an ignore file rather than a fix.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const SEMGREP_RULES = 'scripts/semgrep/rules/forgebridge.yml';
const SEMGREP_FIXTURE = 'scripts/semgrep/tests/forgebridge.ts';
const SEMGREP_FIXTURE_DIR = 'scripts/semgrep';

function read(rel: string): WorkflowFile {
  return { path: rel, text: readFileSync(path.join(ROOT, rel), 'utf8') };
}

function workflows(): WorkflowFile[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => read(`.github/workflows/${name}`));
}

// ──────────────────────────── the real tree ────────────────────────────

describe('W1 — every action this repository runs is pinned', () => {
  it('finds workflows at all', () => {
    // Without this, a rename of the directory would turn every rule below into
    // a vacuous pass over an empty list.
    expect(workflows().length).toBeGreaterThanOrEqual(4);
  });

  it('has no floating action reference', () => {
    expect(checkActionPins(workflows())).toEqual([]);
  });
});

describe('W2 — every workflow declares the token scope it needs', () => {
  it('has no workflow relying on the repository default', () => {
    expect(checkPermissions(workflows())).toEqual([]);
  });
});

describe('W3 — a scanner that can block a merge is a version somebody chose', () => {
  it('installs no Python package without an exact version', () => {
    expect(checkPipPins(workflows())).toEqual([]);
  });
});

describe('W4 — every Semgrep rule has a planted violation and a control', () => {
  it('ships a rules file and a fixture', () => {
    expect(existsSync(path.join(ROOT, SEMGREP_RULES))).toBe(true);
    expect(existsSync(path.join(ROOT, SEMGREP_FIXTURE))).toBe(true);
  });

  it('declares rules', () => {
    expect(semgrepRuleIds(read(SEMGREP_RULES).text).length).toBeGreaterThanOrEqual(5);
  });

  it('annotates each rule both ways', () => {
    expect(checkSemgrepFixtures(read(SEMGREP_RULES), read(SEMGREP_FIXTURE))).toEqual([]);
  });

  it('names every rule for this repository rather than importing a stock pack', () => {
    // The brief for M42 was "rules that matter HERE, not a stock pack". A rule
    // id from a registry pack would not carry this prefix, and a `p/…` config
    // entry would not appear as a rule id at all — so this asserts the rules
    // are local and the file below asserts the workflow runs the local ones.
    for (const id of semgrepRuleIds(read(SEMGREP_RULES).text)) {
      expect(id, `${id} is not a ForgeBridge rule`).toMatch(/^forgebridge-/);
    }
  });
});

describe('W5 — the Semgrep workflow proves its rules can fail before trusting them', () => {
  it('self-tests, then scans, and does not scan its own fixtures', () => {
    expect(checkSemgrepWorkflow(read('.github/workflows/semgrep.yml'), SEMGREP_FIXTURE_DIR)).toEqual([]);
  });

  it('runs the rules in this repository, not a downloaded config', () => {
    expect(read('.github/workflows/semgrep.yml').text).toContain('--config scripts/semgrep/rules');
  });
});

describe('W6 — the threat model names every workflow that exists', () => {
  it('leaves no job undescribed', () => {
    const threatModel = readFileSync(path.join(ROOT, 'docs/THREAT-MODEL.md'), 'utf8');
    expect(checkThreatModelNamesWorkflows(threatModel, workflows().map((file) => file.path))).toEqual([]);
  });
});

describe('the CodeQL job is a gate rather than a tab', () => {
  const codeql = () => read('.github/workflows/codeql.yml').text;

  it('writes its SARIF somewhere a check can read it', () => {
    expect(codeql()).toContain('output: sarif-results');
  });

  it('runs the severity check on what it wrote', () => {
    // Without this step `analyze` succeeds whether it found one alert or a
    // hundred, and the workflow would be a green check next to an unread tab.
    expect(codeql()).toContain('scripts/check-sarif.ts');
    expect(existsSync(path.join(ROOT, 'scripts/check-sarif.ts'))).toBe(true);
  });

  it('analyses this repository\'s language', () => {
    expect(codeql()).toContain('javascript-typescript');
  });

  it('runs on pull requests and on a schedule', () => {
    // The schedule is not redundant with the PR runs: CodeQL ships new queries,
    // so a tree that has not changed can still acquire a finding.
    expect(codeql()).toMatch(/pull_request:/);
    expect(codeql()).toMatch(/schedule:/);
  });

  it('does not upload, and says why', () => {
    // The first run of this workflow on `main` failed — after analysing cleanly
    // — with "CodeQL analyses from advanced configurations cannot be processed
    // when the default setup is enabled". GitHub accepts one or the other, this
    // repository has default setup on, and no file in this tree can turn a
    // repository setting off.
    //
    // So the upload is off and the gate stays. Both halves are asserted: the
    // input, so a green `upload: always` cannot come back and break `main`
    // again, and the explanation, so whoever turns default setup off finds the
    // sentence telling them this line should come off with it. A line whose
    // reason is not written down is a line the next person deletes or keeps for
    // the wrong reason.
    expect(codeql()).toMatch(/^\s*upload: never$/m);
    expect(codeql()).toContain('default setup is enabled');
  });
});

// ──────────────────────── planted violations ────────────────────────

function fake(text: string, name = '.github/workflows/fixture.yml'): WorkflowFile {
  return { path: name, text };
}

describe('self-test: W1 rejects an action nobody pinned', () => {
  it.each([
    ['a branch', 'owner/action@main'],
    ['no ref at all', 'owner/action'],
    ['a moving alias', 'owner/action@latest'],
    ['a partial sha', 'owner/action@abc123'],
  ])('rejects %s', (_label, reference) => {
    const found = checkActionPins([fake(`jobs:\n  x:\n    steps:\n      - uses: ${reference}\n`)]);
    expect(found.map((violation) => violation.rule)).toEqual(['W1']);
  });

  it.each([
    ['a major tag', 'actions/checkout@v7'],
    ['a full version tag', 'actions/checkout@v7.0.1'],
    ['a subdirectory action', 'github/codeql-action/init@v4'],
    ['a full commit sha', `owner/action@${'a1b2c3d4'.repeat(5)}`],
    ['a local composite action', './.github/actions/setup'],
  ])('accepts %s', (_label, reference) => {
    expect(checkActionPins([fake(`      - uses: ${reference}\n`)])).toEqual([]);
  });

  it('is not fooled by a commented-out reference', () => {
    expect(checkActionPins([fake('      # - uses: owner/action@main\n')])).toEqual([]);
  });
});

describe('self-test: W2 rejects a workflow with no permissions block', () => {
  it('rejects one that inherits the repository default', () => {
    const found = checkPermissions([fake('name: X\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n')]);
    expect(found.map((violation) => violation.rule)).toEqual(['W2']);
  });

  it('accepts a top-level block', () => {
    expect(checkPermissions([fake('name: X\npermissions:\n  contents: read\n')])).toEqual([]);
  });

  it('does not accept a job-level block as a top-level one', () => {
    // A job-level block is a narrowing of whatever the top level granted. With
    // no top level there is nothing to narrow, and a second job added later
    // inherits the repository default silently.
    const found = checkPermissions([fake('jobs:\n  a:\n    permissions:\n      contents: read\n')]);
    expect(found).toHaveLength(1);
  });
});

describe('self-test: W3 rejects an unpinned scanner', () => {
  it('rejects a bare package name', () => {
    const found = checkPipPins([fake('    - run: python -m pip install semgrep\n')]);
    expect(found.map((violation) => violation.rule)).toEqual(['W3']);
  });

  it('rejects a floating range', () => {
    expect(checkPipPins([fake('    - run: pip install "semgrep>=1.0,<2"\n')])).toHaveLength(1);
  });

  it('accepts an exact pin', () => {
    expect(checkPipPins([fake('    - run: python -m pip install "semgrep==1.175.0"\n')])).toEqual([]);
  });

  it("accepts ci.yml's editable install of the local Python SDK", () => {
    // The legitimate shape this rule is most confusable with. A local path has
    // no version to pin, and a rule that demanded one would fail the step that
    // makes the cross-language drift proof runnable.
    expect(
      checkPipPins([fake('    - run: python -m pip install -e "packages/sdk-python[dev]"\n')]),
    ).toEqual([]);
  });
});

describe('self-test: W4 rejects a Semgrep rule nobody proved', () => {
  const rules = (ids: readonly string[]): WorkflowFile => ({
    path: 'rules.yml',
    text: `rules:\n${ids.map((id) => `  - id: ${id}\n    severity: ERROR\n`).join('')}`,
  });

  it('rejects a rule with no planted violation', () => {
    const found = checkSemgrepFixtures(rules(['forgebridge-x']), {
      path: 'fixture.ts',
      text: '// ok: forgebridge-x\nconst a = 1;\n',
    });
    expect(found.map((violation) => violation.detail)).toEqual([
      expect.stringContaining('never been shown to reject'),
    ]);
  });

  it('rejects a rule with no control', () => {
    const found = checkSemgrepFixtures(rules(['forgebridge-x']), {
      path: 'fixture.ts',
      text: '// ruleid: forgebridge-x\nconst a = 1;\n',
    });
    expect(found.map((violation) => violation.detail)).toEqual([
      expect.stringContaining('most confusable with'),
    ]);
  });

  it('rejects a rules file with no rules in it', () => {
    expect(checkSemgrepFixtures({ path: 'rules.yml', text: 'rules: []\n' }, { path: 'f.ts', text: '' })).toHaveLength(1);
  });

  it('is not satisfied by an annotation for a different, longer rule id', () => {
    const found = checkSemgrepFixtures(rules(['forgebridge-x']), {
      path: 'fixture.ts',
      text: '// ruleid: forgebridge-x-and-more\n// ok: forgebridge-x-and-more\n',
    });
    expect(found).toHaveLength(2);
  });

  it('accepts a rule annotated both ways', () => {
    expect(
      checkSemgrepFixtures(rules(['forgebridge-x']), {
        path: 'fixture.ts',
        text: '// ruleid: forgebridge-x\nconst a = 1;\n// ok: forgebridge-x\nconst b = 2;\n',
      }),
    ).toEqual([]);
  });
});

describe('self-test: W5 rejects a Semgrep job that trusts its rules', () => {
  const scan = 'semgrep --config scripts/semgrep/rules --error --exclude scripts/semgrep .';
  const selfTest = 'semgrep --test --config scripts/semgrep/rules scripts/semgrep/tests';

  it('rejects a workflow that never self-tests', () => {
    const found = checkSemgrepWorkflow(fake(`    - run: ${scan}\n`), SEMGREP_FIXTURE_DIR);
    expect(found.map((violation) => violation.detail)).toEqual([expect.stringContaining('--test')]);
  });

  it('rejects a scan that would report findings and exit zero', () => {
    const text = `    - run: ${selfTest}\n    - run: semgrep --config scripts/semgrep/rules --exclude scripts/semgrep .\n`;
    expect(checkSemgrepWorkflow(fake(text), SEMGREP_FIXTURE_DIR)).toHaveLength(1);
  });

  it('rejects a workflow that scans before it self-tests', () => {
    const found = checkSemgrepWorkflow(fake(`    - run: ${scan}\n    - run: ${selfTest}\n`), SEMGREP_FIXTURE_DIR);
    expect(found.map((violation) => violation.detail)).toEqual([
      expect.stringContaining('before it self-tests'),
    ]);
  });

  it('rejects a scan that reads its own planted violations', () => {
    const text = `    - run: ${selfTest}\n    - run: semgrep --config scripts/semgrep/rules --error .\n`;
    const found = checkSemgrepWorkflow(fake(text), SEMGREP_FIXTURE_DIR);
    expect(found.map((violation) => violation.detail)).toEqual([expect.stringContaining('--exclude')]);
  });

  it('accepts self-test then scan then exclusion', () => {
    expect(checkSemgrepWorkflow(fake(`    - run: ${selfTest}\n    - run: ${scan}\n`), SEMGREP_FIXTURE_DIR)).toEqual([]);
  });
});

describe('self-test: W6 rejects a workflow the threat model does not mention', () => {
  it('rejects an undescribed job', () => {
    const found = checkThreatModelNamesWorkflows('T6 says nothing.', [
      '.github/workflows/mystery.yml',
    ]);
    expect(found.map((violation) => violation.rule)).toEqual(['W6']);
  });

  it('accepts one the document names', () => {
    expect(
      checkThreatModelNamesWorkflows('`mystery.yml` runs weekly.', ['.github/workflows/mystery.yml']),
    ).toEqual([]);
  });
});
