/**
 * The release gate's self-tests.
 *
 * Two halves, and both matter. The first runs each rule against the real
 * `.github/workflows/release.yml` and the real tree, so a change that breaks
 * the release fails here rather than at 2am with half a version published. The
 * second hands each rule a planted violation and proves it rejects one — a gate
 * that cannot fail is decoration, and the shape every bypass this repository
 * has found so far took is a check that returned "clean" because it did not
 * understand what it was reading.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  changelogSection,
  checkChangeEntries,
  checkChangelog,
  checkCredentialPreflight,
  checkManualOnly,
  checkPublishGating,
  checkVersion,
  isPublishingJob,
  nextVersion,
  parseWorkflow,
  preflightJobId,
  readChangeEntry,
  referencedCredentials,
  requiredBump,
  type ReleaseViolation,
} from '../release-rules.js';
import { changeEntries, releaseReport, versionedFiles } from '../release.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = '.github/workflows/release.yml';
const workflowText = readFileSync(path.join(ROOT, WORKFLOW_PATH), 'utf8');
const workflow = parseWorkflow(workflowText);

const report = (violations: readonly ReleaseViolation[]): string[] =>
  violations.map((v) => `${v.rule} ${v.file}: ${v.detail}`);

describe('the release workflow as it stands', () => {
  it('parses into jobs with their dependencies', () => {
    expect(workflow.jobs.map((job) => job.id)).toEqual([
      'preflight',
      'build',
      'publish-npm',
      'publish-pypi',
      'github-release',
    ]);
  });

  it('R1 — cannot be started by anything but a person', () => {
    expect(report(checkManualOnly(WORKFLOW_PATH, workflow))).toEqual([]);
    expect(workflow.triggers).toEqual(['workflow_dispatch']);
  });

  it('R2/R3/R5 — every publish is gated and nothing announces a release early', () => {
    expect(report(checkPublishGating(WORKFLOW_PATH, workflow))).toEqual([]);
  });

  it('R4 — the preflight checks every credential a publish uses', () => {
    expect(report(checkCredentialPreflight(WORKFLOW_PATH, workflow))).toEqual([]);
  });

  it('publishes nothing by default: the publish input defaults to false', () => {
    expect(workflowText).toMatch(/publish:[\s\S]{0,200}default:\s*false/);
  });

  it('carries no credential of its own', () => {
    // ADR-013's rule, at the one file most likely to acquire one.
    for (const credential of referencedCredentials(workflowText)) {
      expect(credential).toMatch(/^(secrets|vars)\.[A-Z_]+$/);
    }
    expect(workflowText).not.toMatch(/npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9]{20,}/);
  });
});

describe('the tree as it stands', () => {
  it('every versioned file agrees', () => {
    const files = versionedFiles(ROOT);
    // The set itself is worth asserting: a package added without a version is
    // exactly the file this rule exists to catch, and it would otherwise be
    // caught by nothing because nobody listed it.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((file) => file.path)).toContain('plugin/src/Config.luau');
    expect(files.map((file) => file.path)).toContain('packages/sdk-python/pyproject.toml');
    const declared = new Set(files.map((file) => file.version));
    expect([...declared]).toHaveLength(1);
  });

  it('can be released as the version it declares', () => {
    const version = versionedFiles(ROOT)[0]?.version ?? '';
    expect(report(releaseReport(version, ROOT))).toEqual([]);
  });

  it('has at least one release entry, and every entry is readable', () => {
    const entries = changeEntries(ROOT);
    expect(entries.length).toBeGreaterThan(0);
    expect(report(checkChangeEntries(entries))).toEqual([]);
    expect(requiredBump(entries)).not.toBeNull();
  });
});

// ── planted violations ───────────────────────────────────────────────────────

describe('R1 — a gate that cannot fail is decoration', () => {
  it('rejects a tag trigger, which is the one somebody reaches for', () => {
    const planted = workflowText.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n    tags: ["v*"]\n  workflow_dispatch:');
    const violations = checkManualOnly(WORKFLOW_PATH, parseWorkflow(planted));
    expect(violations.map((v) => v.rule)).toContain('R1');
    expect(violations[0]!.detail).toMatch(/without a person choosing to/);
  });

  it('rejects a workflow with no manual trigger either', () => {
    expect(checkManualOnly(WORKFLOW_PATH, parseWorkflow('on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n')).length).toBe(2);
  });

  it('CONTROL — workflow_dispatch alone is accepted', () => {
    expect(checkManualOnly(WORKFLOW_PATH, parseWorkflow('on:\n  workflow_dispatch:\njobs:\n'))).toEqual([]);
  });
});

describe('R2/R3/R5 — the gating rules', () => {
  const gated = `on:
  workflow_dispatch:
jobs:
  preflight:
    steps:
      - run: |
          [ -n "\${{ secrets.NPM_TOKEN }}" ] || missing+=(NPM_TOKEN)
          exit 1
  publish-npm:
    needs: [preflight]
    if: \${{ inputs.publish }}
    steps:
      - run: npm publish --workspaces
`;

  it('CONTROL — a correctly gated publish passes', () => {
    expect(report(checkPublishGating('w', parseWorkflow(gated)))).toEqual([]);
  });

  it('rejects a publish that does not depend on the preflight', () => {
    const planted = gated.replace('    needs: [preflight]\n', '');
    expect(report(checkPublishGating('w', parseWorkflow(planted)))[0]).toMatch(/publishes without depending on/);
  });

  it('rejects a publish with no `if:` on the publish input', () => {
    const planted = gated.replace('    if: ${{ inputs.publish }}\n', '');
    expect(report(checkPublishGating('w', parseWorkflow(planted)))[0]).toMatch(/without an `if:` gated/);
  });

  it('rejects a workflow with no recognisable publish, rather than calling it clean', () => {
    // "I found nothing to check" and "everything I checked is fine" must not be
    // the same answer. This is the shape of every bypass found so far.
    const violations = checkPublishGating('w', parseWorkflow('on:\n  workflow_dispatch:\njobs:\n  build:\n    steps:\n      - run: npm run build\n'));
    expect(violations[0]!.detail).toMatch(/no publishing job was recognised/);
  });

  it('rejects a release announcement that does not wait for the publishes', () => {
    const planted = `${gated}  github-release:
    needs: [preflight]
    steps:
      - uses: softprops/action-gh-release@v3.0.2
`;
    expect(report(checkPublishGating('w', parseWorkflow(planted)))[0]).toMatch(/announces the release without depending on publish-npm/);
  });
});

describe('R4 — every credential checked before any is used', () => {
  it('rejects a credential a publish uses and the preflight never checks', () => {
    const planted = `on:
  workflow_dispatch:
jobs:
  preflight:
    steps:
      - run: |
          [ -n "\${{ secrets.NPM_TOKEN }}" ] || missing+=(x)
          exit 1
  publish-pypi:
    needs: [preflight]
    if: \${{ inputs.publish }}
    steps:
      - uses: pypa/gh-action-pypi-publish@v1.14.2
        with:
          password: \${{ secrets.PYPI_API_TOKEN }}
`;
    const violations = checkCredentialPreflight('w', parseWorkflow(planted));
    expect(violations[0]!.detail).toMatch(/secrets.PYPI_API_TOKEN is used by a publishing job and is not checked/);
  });

  it('ignores GITHUB_TOKEN, which is minted per run and cannot be missing', () => {
    expect(referencedCredentials('${{ secrets.GITHUB_TOKEN }} ${{ secrets.NPM_TOKEN }}')).toEqual(['secrets.NPM_TOKEN']);
  });

  it('recognises a publishing job by what it runs, not by its name', () => {
    expect(isPublishingJob({ id: 'x', text: '      - run: twine upload dist/*', needs: [], condition: '' })).toBe(true);
    expect(isPublishingJob({ id: 'publish-docs', text: '      - run: rsync -a site/ host:', needs: [], condition: '' })).toBe(false);
  });

  it('finds the preflight by what it does, not by its name', () => {
    expect(preflightJobId(workflow)).toBe('preflight');
  });

  it('CONTROL — a job whose COMMENT mentions npm publish is not a publishing job', () => {
    // This one is not hypothetical. The real `build` job's comment explains
    // that `npm pack` produces exactly what `npm publish` would upload, and the
    // first version of this rule read that sentence and reported the build job
    // as an ungated publish. Fail-closed must not become fail-noisy: a rule
    // that fires on a true sentence in a correct file is a rule somebody
    // deletes, and then it protects nothing.
    const job = {
      id: 'build',
      text: '      # `npm pack` produces exactly what `npm publish` would upload\n      - run: npm pack --workspaces\n',
      needs: [],
      condition: '',
    };
    expect(isPublishingJob(job)).toBe(false);
  });
});

describe('V1–V4 — the tree agrees with itself', () => {
  it('rejects a version that is not semver', () => {
    expect(checkVersion('v1.2', [])[0]!.rule).toBe('V1');
  });

  it('rejects a manifest left behind at the old version', () => {
    const violations = checkVersion('0.2.0', [
      { path: 'package.json', version: '0.2.0' },
      { path: 'packages/protocol/package.json', version: '0.1.0' },
    ]);
    expect(violations[0]!.detail).toMatch(/declares 0.1.0, and this release is 0.2.0/);
  });

  it('rejects an empty file set rather than reporting agreement', () => {
    expect(checkVersion('0.2.0', [])[0]!.detail).toMatch(/no versioned file was found/);
  });

  it('CONTROL — a tree that agrees passes', () => {
    expect(checkVersion('0.2.0', [{ path: 'package.json', version: '0.2.0' }])).toEqual([]);
  });

  it('rejects a missing CHANGELOG section, and an empty one', () => {
    expect(checkChangelog('0.2.0', '# Changelog\n\n## 0.1.0 — x\n\n- y\n')[0]!.rule).toBe('V3');
    expect(checkChangelog('0.2.0', '# Changelog\n\n## 0.2.0 — x\n\n')[0]!.detail).toMatch(/is empty/);
  });

  it('reads both CHANGELOG heading spellings', () => {
    expect(changelogSection('## [0.2.0] - 2026-01-01\nbody\n', '0.2.0')).toContain('body');
    expect(changelogSection('## 0.2.0 — 2026-01-01\nbody\n', '0.2.0')).toContain('body');
  });

  it('rejects a release entry with no readable bump, rather than assuming patch', () => {
    // Assuming patch is exactly how a breaking change ships as one.
    const entry = readChangeEntry('.changes/x.md', 'it got better\n');
    expect(entry.bump).toBeNull();
    expect(checkChangeEntries([entry])[0]!.detail).toMatch(/no readable `bump:` line/);
  });

  it('rejects a release with no entries at all', () => {
    expect(checkChangeEntries([])[0]!.detail).toMatch(/at least one entry/);
  });

  it('CONTROL — a well-formed entry passes and its bump is read', () => {
    const entry = readChangeEntry('.changes/x.md', 'bump: minor\n\nA new thing.\n');
    expect(entry.bump).toBe('minor');
    expect(checkChangeEntries([entry])).toEqual([]);
  });

  it('takes the largest bump any entry asks for', () => {
    const entries = ['patch', 'major', 'minor'].map((bump, i) => readChangeEntry(`${i}.md`, `bump: ${bump}\n\nx\n`));
    expect(requiredBump(entries)).toBe('major');
  });

  it('computes the next version', () => {
    expect(nextVersion('0.1.3', 'patch')).toBe('0.1.4');
    expect(nextVersion('0.1.3', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.1.3', 'major')).toBe('1.0.0');
  });
});
