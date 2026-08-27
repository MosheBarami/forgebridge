import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The weekly catalog-drift workflow (M21), checked rather than trusted.
 *
 * This lives in `packages/model-registry` because the workflow exists for one
 * reason: to keep `data/catalog.json` in this package honest. It is the only
 * thing standing between a snapshot taken once and a snapshot that is quietly
 * wrong — the catalog total already moved 417 → 416 inside a day of the first
 * sync, so this is not a hypothetical.
 *
 * The rules below are the workflow's own claims about itself, expressed as pure
 * functions so each can be handed a planted violation and shown to reject it. A
 * gate that cannot fail is decoration, and a workflow comment saying "this runs
 * the repository gates itself" is exactly the kind of claim that stops being
 * true the first time somebody simplifies a step.
 *
 * Deliberately NOT checked here: that every `uses:` is pinned and that the file
 * declares `permissions:`. `scripts/workflow-rules.ts` (W1, W2) already checks
 * those across every workflow in the repository, and a second implementation of
 * the same rule is two rules that can disagree.
 */

const WORKFLOW_PATH = fileURLToPath(
  new URL('../../../.github/workflows/catalog-drift.yml', import.meta.url),
);

const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');

type Rule = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';

export interface Finding {
  rule: Rule;
  detail: string;
}

/**
 * C1 — it runs on a schedule. A drift job somebody has to remember to run is a
 *      drift job that stops being run.
 * C2 — it opens a pull request and never writes to the base branch. ADR-007's
 *      whole argument for a snapshot is that a change arrives as a diff a human
 *      reads; a job that pushed to main would be the silent update it exists to
 *      replace.
 * C3 — the commit is signed off. A PR opened by Actions does not trigger the DCO
 *      workflow, so the sign-off has to be made here or it is simply absent.
 * C4 — when it finds drift it runs the repository's own checks. Same reason: CI
 *      does not run on this pull request, so a branch that skipped the gates
 *      would be the one branch in the repository exempt from them.
 * C5 — it never passes `--allow-shrink`. That flag exists so a *human* can say
 *      "yes, the catalog really did lose a fifth of its models"; a job that
 *      passed it would turn the truncated-read incident behind ADR-007 into an
 *      automatic pull request that deletes models.
 * C6 — it disables build telemetry, because it runs Turborepo and Promise 3 says
 *      no telemetry by default.
 */
export function inspect(text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  const uncommented = lines
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

  if (!/^\s*schedule:/m.test(uncommented) || !/^\s*-\s*cron:/m.test(uncommented)) {
    out.push({ rule: 'C1', detail: 'no schedule with a cron trigger' });
  }

  if (!/gh pr create/.test(uncommented)) {
    out.push({ rule: 'C2', detail: 'nothing opens a pull request' });
  }
  for (const line of uncommented.split('\n')) {
    if (!/\bgit push\b/.test(line)) continue;
    // A push to the branch this job owns is the point. A push that names the
    // base branch, in any of its spellings, is the thing that must not appear.
    if (/\b(main|master|HEAD:main|HEAD:master)\b/.test(line)) {
      out.push({ rule: 'C2', detail: `pushes to the base branch: ${line.trim()}` });
    }
  }

  const commit = /git commit\s+(-[^\n]*)/.exec(uncommented);
  if (!commit) {
    out.push({ rule: 'C3', detail: 'nothing commits the synced catalog' });
  } else if (!/(^|\s)-s(\s|$)|--signoff/.test(commit[1] ?? '')) {
    out.push({ rule: 'C3', detail: 'the drift commit is not signed off (DCO does not run on this PR)' });
  }

  // As a command on its own line, not merely as a string somewhere in the file.
  // The pull-request body this job writes *says* both of these were run, and a
  // rule satisfied by that sentence would be a rule the prose can keep true
  // after the step that did the work is gone.
  for (const required of ['npm run test', 'npm run verify:no-secrets']) {
    const asCommand = new RegExp(`^\\s*${required.replace(/[:]/g, '[:]')}\\s*$`, 'm');
    if (!asCommand.test(uncommented)) {
      out.push({ rule: 'C4', detail: `does not run \`${required}\` on a drift branch CI will not see` });
    }
  }

  if (/--allow-shrink/.test(uncommented)) {
    out.push({ rule: 'C5', detail: 'passes --allow-shrink, which is a human’s decision to make' });
  }

  for (const variable of ['TURBO_TELEMETRY_DISABLED', 'DO_NOT_TRACK']) {
    if (!uncommented.includes(variable)) {
      out.push({ rule: 'C6', detail: `does not set ${variable}` });
    }
  }

  return out;
}

describe('the shipped catalog-drift workflow', () => {
  it('satisfies every rule above', () => {
    expect(inspect(WORKFLOW)).toEqual([]);
  });

  it('syncs the catalog this package ships, by path', () => {
    expect(WORKFLOW).toContain('packages/model-registry/data/catalog.json');
    expect(WORKFLOW).toContain('npm run sync:catalog');
  });

  it('refuses a sync that wrote outside the catalog rather than dropping the file', () => {
    // The quiet failure this guards: a sync that also wrote somewhere else, with
    // the drift step looking at one path, would leave that file uncommitted and
    // unreviewed until it surfaced inside an unrelated pull request.
    expect(WORKFLOW).toContain('git status --porcelain');
    expect(WORKFLOW).toMatch(/The sync wrote outside/);
  });

  it('does not run on a fork, where it could not open the pull request anyway', () => {
    expect(WORKFLOW).toContain("github.repository == 'MosheBarami/forgebridge'");
  });
});

describe('each rule rejects the violation it exists for', () => {
  /** Every mutation below is a plausible simplification of the real file. */
  const planted: [Rule, string][] = [
    ['C1', WORKFLOW.replace(/^\s*-\s*cron:.*$/m, '')],
    ['C2', WORKFLOW.replace('gh pr create', 'echo would-have-opened-a-pr')],
    ['C2', WORKFLOW.replace('git push --force origin "${branch}"', 'git push origin HEAD:main')],
    ['C3', WORKFLOW.replace('git commit -s -m', 'git commit -m')],
    // Only the step is removed; the pull-request body still claims both ran,
    // which is the state this rule has to notice.
    ['C4', WORKFLOW.replace(/^(\s*)npm run test\s*$/m, '$1echo skipped')],
    ['C4', WORKFLOW.replace(/^(\s*)npm run verify:no-secrets\s*$/m, '$1echo skipped')],
    ['C5', WORKFLOW.replace('npm run sync:catalog', 'npm run sync:catalog -- --allow-shrink')],
    ['C6', WORKFLOW.replace('TURBO_TELEMETRY_DISABLED: 1', '')],
  ];

  for (const [rule, mutated] of planted) {
    it(`${rule} fails on a planted violation`, () => {
      // The mutation must have actually changed something, or the test would
      // pass by proving nothing.
      expect(mutated).not.toBe(WORKFLOW);
      expect(inspect(mutated).map((finding) => finding.rule)).toContain(rule);
    });
  }

  it('CONTROL: a workflow that pushes its own drift branch is not mistaken for one that pushes to main', () => {
    // The legitimate shape C2 is most confusable with. `git push --force origin
    // "${branch}"` is the whole point of the job and must not be flagged.
    expect(inspect(WORKFLOW).filter((finding) => finding.rule === 'C2')).toEqual([]);
  });

  it('CONTROL: a comment mentioning main does not count as pushing to it', () => {
    const commented = WORKFLOW.replace(
      'git push --force origin "${branch}"',
      '# never: git push origin main\n          git push --force origin "${branch}"',
    );
    expect(inspect(commented).filter((finding) => finding.rule === 'C2')).toEqual([]);
  });
});
