import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ApplyResult,
  ChangeSet,
  LIMITS,
  SERVICE_ROOTS,
  STRUCTURAL_PROPERTIES,
} from '../../packages/protocol/src/index.js';
import { NEUTRAL_TREES } from '../verify-boundaries.js';
import {
  type Doc,
  type RepoFacts,
  type Violation,
  carriesMilestone,
  checkBinNames,
  checkBlindRelayClaims,
  checkCiToolClaims,
  checkClaimedTests,
  checkNpmScripts,
  checkPackageExistence,
  checkVerifyGateCoverage,
  collectDocs,
  collectRepoFacts,
  unitAt,
  checkLayoutCoverage,
  checkCitedTodos,
  checkAbsenceClaims,
  checkDirectoryListings,
  checkSurfaceCounts,
} from '../docs-claims-rules.js';

/**
 * A gate over the *claims* the documentation makes.
 *
 * Every finding this file pins was the same defect wearing a different hat: a
 * sentence a reader can check, that did not survive checking. The README called
 * the relay a "blind pipe" and cited the ADR that forbids the phrase; a promise
 * said it was "checked by a test" that nobody had written; `PROTOCOL.md`
 * declared an `ApplyResult.applied` field the schema does not have, in a
 * document whose own first rule is that a field not in the Zod schema does not
 * exist. None of those are typos. They are the project's pitch, and the pitch
 * rests entirely on being checkable.
 *
 * So they get a gate, the same as the boundary rules and the asset provenance.
 * These assertions are written against the *source of truth* — the Zod schemas,
 * the package manifests, the directory listing — rather than against a snapshot
 * of the prose, so they keep working as the prose is edited and start failing
 * the moment the underlying fact moves without it.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

const README = read('README.md');
const ARCHITECTURE = read('docs/ARCHITECTURE.md');
const PROTOCOL = read('docs/PROTOCOL.md');
const MILESTONES = read('docs/MILESTONES.md');
const GOVERNANCE = read('docs/GOVERNANCE.md');
const CI = read('.github/workflows/ci.yml');
const CONTRIBUTING = read('CONTRIBUTING.md');
const REPO_LAYOUT = read('docs/REPO-LAYOUT.md');
const ADR_013 = read('docs/architecture/adr-013-fresh-public-repo.md');
const SCHEMA_README = read('packages/protocol/schema/README.md');
const ROOT_MANIFEST = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

/** The two most-read pages. A claim wrong in both is wrong twice as loudly. */
const FRONT_MATTER: ReadonlyArray<readonly [string, string]> = [
  ['README.md', README],
  ['docs/ARCHITECTURE.md', ARCHITECTURE],
];

describe('the relay is not described as blind (ADR-014)', () => {
  // ADR-014 states the opposite of what the diagram used to say, and requires
  // the UI to say "can read changes" in those words. A diagram that contradicts
  // the ADR it cites is worse than one that cites nothing.
  it.each(FRONT_MATTER)('%s does not call the shipping relay a blind pipe', (_name, text) => {
    expect(text).not.toMatch(/•\s*blind pipe/);
  });

  it.each(FRONT_MATTER)('%s says the relay operator can read changes', (_name, text) => {
    expect(text).toMatch(/operator can read (your )?changes/i);
  });

  it.each(FRONT_MATTER)('%s attributes a blind relay to M19', (_name, text) => {
    // "blind" may still appear — describing the thing that has not shipped. What
    // it may not do is appear without M19 next to it.
    for (const match of text.matchAll(/blind relay|blind pipe/gi)) {
      const window = text.slice(Math.max(0, match.index - 400), match.index + 400);
      expect(window, `"${match[0]}" at ${match.index} is not tied to M19`).toContain('M19');
    }
  });

  it('keeps the bare word "blind" as a milestone description in MILESTONES', () => {
    // The one place it is honest: a row for work that is not done.
    const rows = MILESTONES.split('\n').filter((line) => /blind/i.test(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('M19');
  });
});

describe('Promise 4 matches whether the key-storage gate actually exists', () => {
  // This is the coordination point with whoever owns scripts/verify-no-key-storage.ts.
  // It fails in *both* directions on purpose: overclaiming a test that is not
  // there, and under-claiming one that is. Either way the promise and the repo
  // have drifted, and Promise 4 is the one promise about the user's money.
  const GATE = 'scripts/verify-no-key-storage.ts';
  const gateExists = existsSync(path.join(ROOT, GATE));

  /**
   * Promise 4 only — bounded at Promise 5, not by a character count. Both files
   * discuss the gates again a few paragraphs later, and a window wide enough to
   * reach that discussion would let a hollowed-out Promise 4 pass on the
   * strength of prose that is not the promise.
   */
  const promiseText = (source: string): string => {
    const start = source.indexOf('**Your keys stay yours.**');
    expect(start, 'Promise 4 not found').toBeGreaterThan(-1);
    const end = source.indexOf('5. **', start);
    expect(end, 'Promise 5 not found after Promise 4').toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it.each([
    ['README.md', README],
    ['docs/GOVERNANCE.md', GOVERNANCE],
  ])('%s states Promise 4 at the strength the repo can back', (_name, source) => {
    const promise = promiseText(source);

    if (gateExists) {
      expect(
        promise,
        `${GATE} exists — Promise 4 should now claim the gate, not a TODO`,
      ).not.toMatch(/TODO\(M43\)/);
      expect(promise, 'Promise 4 must name the gate it leans on').toMatch(/verify[:-]no-key-storage/);
    } else {
      expect(
        promise,
        `${GATE} does not exist — Promise 4 may not claim it is checked by a test`,
      ).not.toMatch(/checked by a test/);
      expect(promise, 'the missing gate must be tracked by a milestone').toMatch(/TODO\(M43\)/);
    }
  });

  it('runs the gate in CI when the promise says CI runs it', () => {
    // The promise's strength and the workflow have to move together. Claiming a
    // CI gate that no job invokes is the same defect as claiming a test nobody
    // wrote — one indirection further from the reader, and no easier to catch.
    const claimsCi = /CI gate|fails the build/i.test(promiseText(README));
    if (claimsCi) {
      expect(gateExists, 'Promise 4 claims a CI gate that does not exist').toBe(true);
      expect(CI, 'Promise 4 claims a CI gate no job runs').toContain('npm run verify:no-key-storage');
    }
  });

  it('tracks the gate in the M43 row either way', () => {
    const row = MILESTONES.split('\n').find((line) => line.startsWith('| M43 '));
    expect(row).toBeDefined();
    expect(row).toContain('verify-no-key-storage');
  });
});

describe('PROTOCOL.md matches packages/protocol', () => {
  // The document opens by saying a field not in the Zod schema does not exist.
  // Taking that literally is the cheapest possible drift gate, and it is the one
  // that would have caught `applied` before an implementer did.
  it('names every ApplyResult field', () => {
    for (const field of Object.keys(ApplyResult.shape)) {
      expect(PROTOCOL, `ApplyResult.${field} is missing from PROTOCOL.md`).toContain(field);
    }
  });

  it('does not declare an ApplyResult field the schema dropped', () => {
    expect(Object.keys(ApplyResult.shape)).not.toContain('applied');
    // `applied` is still a real name — on JournalEntry — so the assertion is
    // scoped to the ApplyResult block rather than to the whole document.
    const start = PROTOCOL.indexOf('const ApplyResult');
    expect(start).toBeGreaterThan(-1);
    const block = PROTOCOL.slice(start, PROTOCOL.indexOf('});', start));
    expect(block).toContain('outcomes:');
    expect(block).not.toMatch(/^\s*applied:/m);
  });

  it('names every top-level ChangeSet field', () => {
    // ChangeSet is a ZodEffects because of its superRefine; the object is inside.
    for (const field of Object.keys(ChangeSet._def.schema.shape)) {
      expect(PROTOCOL, `ChangeSet.${field} is missing from PROTOCOL.md`).toContain(field);
    }
  });

  it('does not invent a Validation.schema field', () => {
    // The old block declared `schema: z.literal('ok')`. Schema validity is not
    // reportable state — a ChangeSet that failed Zod never became a ChangeSet.
    const start = PROTOCOL.indexOf('const Validation');
    expect(start).toBeGreaterThan(-1);
    const block = PROTOCOL.slice(start, PROTOCOL.indexOf('});', start));
    expect(block).not.toMatch(/^\s*schema:/m);
  });

  it('documents the structural-property refusal by name', () => {
    for (const property of STRUCTURAL_PROPERTIES) {
      expect(PROTOCOL).toContain(property);
    }
    expect(PROTOCOL).toContain('STRUCTURAL_PROPERTIES');
    expect(PROTOCOL).toMatch(/setProperty.{0,80}(refuse|may not)/is);
  });

  it('documents InstanceRef as a validated path and pathsOf as covering it', () => {
    expect(PROTOCOL).toMatch(/InstanceRef.{0,60}InstancePath/s);
    expect(PROTOCOL).toMatch(/pathsOf/);
    expect(PROTOCOL).toMatch(/pathsOf.{0,400}property/is);
  });

  it('quotes the path bounds that are actually in LIMITS', () => {
    // Numbers transcribed into prose are the first thing to rot. These four are
    // quoted in the identity block and in Invariant 5, so they are checked.
    const start = PROTOCOL.indexOf('── identity ──');
    const block = PROTOCOL.slice(start, start + 700);
    expect(block).toContain(String(LIMITS.MAX_PATH_DEPTH));
    expect(block).toContain(String(LIMITS.MAX_SEGMENT_LENGTH));
    expect(PROTOCOL).toContain(String(LIMITS.MAX_OPERATIONS));
  });

  it('counts the service roots correctly', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
      'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
    const spelled = words[SERVICE_ROOTS.length];
    expect(spelled, 'SERVICE_ROOTS grew past this list').toBeDefined();
    expect(PROTOCOL).toMatch(new RegExp(`${spelled} addressable SERVICE_ROOTS`, 'i'));
  });

  it('marks the unbuilt projections with M08 rather than the present tense', () => {
    // Only Zod → TS exists. The other three arms of that pipeline diagram are M08.
    const start = PROTOCOL.indexOf('packages/protocol/src/*.ts');
    const block = PROTOCOL.slice(start, start + 900);
    for (const arm of ['OpenAPI', 'JSON Schema', 'Python models']) {
      expect(block, `${arm} is drawn without its milestone`).toContain('M08');
    }
  });
});

describe('the lint task is not advertised as a gate while it is an echo', () => {
  // Every package ships `"lint": "echo …"` and there is no linter config in the
  // repository. That is a defensible state for a skeleton; advertising it in the
  // README command comment and in a CI job title is not, because a reviewer
  // counts a green lint as a linted codebase.
  const lintScripts = readdirSync(path.join(ROOT, 'packages'))
    .map((name) => path.join(ROOT, 'packages', name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> })
    .map((manifest) => manifest.scripts?.['lint'] ?? '');

  const everyLintIsNoop = lintScripts.length > 0 && lintScripts.every((s) => s.startsWith('echo'));

  it('has a lint script in every package (so the count above is meaningful)', () => {
    expect(lintScripts.length).toBeGreaterThan(0);
    expect(lintScripts.every((s) => s.length > 0)).toBe(true);
  });

  it('keeps lint out of the README check comment while it is a no-op', () => {
    const line = README.split('\n').find((l) => l.includes('npm run check'));
    expect(line).toBeDefined();
    if (everyLintIsNoop) {
      expect(line, 'README advertises a lint gate this repo does not have').not.toContain('lint');
      expect(README, 'the missing linter must be tracked').toContain('TODO(M04)');
    }
  });

  it('keeps lint out of the CI job title while it is a no-op', () => {
    const jobTitle = CI.split('\n').find((l) => l.trimStart().startsWith('name: typecheck'));
    expect(jobTitle).toBeDefined();
    if (everyLintIsNoop) {
      expect(jobTitle, 'the CI job reads as a lint gate').not.toContain('lint');
    }
  });

  it('tracks configuring a real linter as its own milestone row', () => {
    expect(MILESTONES).toMatch(/\|\s*M04b\s*\|/);
  });
});

describe('MILESTONES does not credit M07 with M08 work', () => {
  const rowFor = (id: string): string => {
    const row = MILESTONES.split('\n').find((line) => line.startsWith(`| ${id} `));
    expect(row, `no ${id} row`).toBeDefined();
    return row as string;
  };

  it('leaves the cross-language drift gate on M08', () => {
    // M07 is ✅. Its old definition of done required OpenAPI, JSON Schema and
    // Python generation — none of which exist. An accurate test count next to an
    // inaccurate tick is what made the tick credible.
    const m07 = rowFor('M07 ✅');
    for (const claim of ['OpenAPI', 'JSON-Schema', 'Python', 'verifyNoDrift']) {
      expect(m07, `M07 still claims ${claim}`).not.toContain(claim);
    }
    expect(rowFor('M08')).toContain('verifyNoDrift');
  });

  it('reports the protocol test count that the suite actually produces', () => {
    // Counted from the source rather than transcribed, so the number cannot go
    // stale the way "32 tests green" did.
    const testDir = path.join(ROOT, 'packages/protocol/test');
    const cases = readdirSync(testDir)
      .filter((f) => f.endsWith('.test.ts'))
      .flatMap((f) => [...readFileSync(path.join(testDir, f), 'utf8').matchAll(/^\s*it\(/gm)]);
    expect(cases.length).toBeGreaterThan(0);
    expect(MILESTONES, 'the live-status test count is stale').toContain(`${cases.length} tests`);
  });
});

describe('the README marks every directory that has no code in it', () => {
  // The README's own meta-promise is that anything depending on unshipped work
  // carries its milestone. The commands honoured that; the layout table did not.
  const layoutStart = README.indexOf('## Repository layout');
  const layout = README.slice(layoutStart, README.indexOf('```', README.indexOf('```', layoutStart) + 3));

  const sourceFileCount = (dir: string): number => {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) return 0;
    let total = 0;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      total += entry.isDirectory() ? sourceFileCount(path.join(dir, entry.name)) : 1;
    }
    return total;
  };

  const listed = [...layout.matchAll(/^(packages\/[a-z-]+|apps\/[a-z-]+|examples|plugin)\/?\s+.*$/gm)];

  it('lists something', () => {
    expect(listed.length).toBeGreaterThan(3);
  });

  it.each(listed.map((m) => [m[1] as string, m[0] as string]))(
    '%s carries a milestone marker if it is empty',
    (dir, line) => {
      if (sourceFileCount(dir) === 0) {
        expect(line, `${dir} has no files and no milestone marker`).toMatch(/M\d\d/);
      }
    },
  );
});

describe('every gate the manifest declares is documented and actually invoked', () => {
  /**
   * The coordination point between whoever adds a gate and whoever writes the
   * docs. Four agents worked on this repository in parallel and the seam showed
   * exactly here: `verify:no-key-storage` was added to `package.json` and wired
   * into CI, and CONTRIBUTING's "run these before you push" block — the list a
   * contributor actually types — was never updated. The result passes locally
   * and fails in CI, which is the worst way to learn a rule exists.
   *
   * Derived from the manifest rather than from a hard-coded list, so adding the
   * next gate fails this test until both places know about it.
   */
  const gates = Object.keys(ROOT_MANIFEST.scripts ?? {}).filter((name) => name.startsWith('verify:'));

  it('declares at least the three gates the README and the ADRs lean on', () => {
    expect(gates.length).toBeGreaterThanOrEqual(3);
  });

  it.each(gates)('%s is in the CONTRIBUTING pre-push block', (gate) => {
    const start = CONTRIBUTING.indexOf('## Getting set up');
    expect(start, 'the setup section moved').toBeGreaterThan(-1);
    const block = CONTRIBUTING.slice(start, CONTRIBUTING.indexOf('### Where code goes', start));
    expect(block, `CONTRIBUTING does not tell a contributor to run ${gate}`).toContain(`npm run ${gate}`);
  });

  it.each(gates)('%s is run by a CI job', (gate) => {
    expect(CI, `no CI job runs ${gate}`).toContain(`npm run ${gate}`);
  });

  it('does not promise that `npm run check` runs them', () => {
    // It does not: `check` is `turbo run typecheck lint test build`. A
    // contributor who believes otherwise skips every gate.
    expect(ROOT_MANIFEST.scripts?.['check']).not.toMatch(/verify:/);
    const start = CONTRIBUTING.indexOf('## Getting set up');
    const block = CONTRIBUTING.slice(start, CONTRIBUTING.indexOf('### Where code goes', start));
    expect(block).toMatch(/`npm run check` does \*\*not\*\* invoke the gates/);
  });
});

describe("ADR-013's mitigation names a check that exists", () => {
  // ADR-013 is the only decision in the repository with no revisit trigger, and
  // its mitigation sentence used to name `gitleaks` — no action, no config, no
  // step. An unbacked claim in a one-way decision is the worst instance of the
  // defect this whole file exists to catch.
  it('does not claim a scanner with no invocation anywhere', () => {
    for (const scanner of ['gitleaks']) {
      const claimed = new RegExp(`\`${scanner}\` runs`).test(ADR_013);
      if (claimed) {
        expect(CI, `ADR-013 says ${scanner} runs; no CI job invokes it`).toContain(scanner);
      }
    }
  });

  it('names the working-tree gate, and CI runs it', () => {
    expect(ADR_013).toContain('scripts/verify-no-secrets.ts');
    expect(CI).toContain('npm run verify:no-secrets');
    expect(existsSync(path.join(ROOT, 'scripts/verify-no-secrets.ts'))).toBe(true);
  });

  it('states the gap it does not cover, with a milestone', () => {
    // "Working tree, not history" is a real limitation. Stating it is what
    // separates a scoped gate from an overclaimed one.
    expect(ADR_013).toMatch(/TODO\(M4\d\)/);
    expect(ADR_013).toMatch(/history/i);
  });
});

describe('REPO-LAYOUT describes the enforcement this repo actually has', () => {
  const boundaryBlock = (): string => {
    const start = REPO_LAYOUT.indexOf('## Boundary rules');
    expect(start, 'the boundary-rules section moved').toBeGreaterThan(-1);
    return REPO_LAYOUT.slice(start, REPO_LAYOUT.indexOf('## Language split', start));
  };

  const eslintConfigured =
    ['.eslintrc', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs']
      .some((file) => existsSync(path.join(ROOT, file)));

  it('does not credit ESLint with enforcing the rules while no ESLint exists', () => {
    // The heading read "enforced by ESLint `no-restricted-imports` + a CI check".
    // Half of that is a linter this repository has never had.
    if (!eslintConfigured) {
      expect(boundaryBlock(), 'REPO-LAYOUT credits a linter that is not configured')
        .not.toMatch(/enforced by ESLint/);
    }
  });

  it('names the script that does enforce them', () => {
    expect(boundaryBlock()).toContain('scripts/verify-boundaries.ts');
  });

  it('states the neutrality rule at the scope the scanner actually scans', () => {
    // The rule read "nothing outside `apps/web`", which is far wider than B3 —
    // and would make this very document, `README.md` and `NOTICE` violations.
    const block = boundaryBlock();
    for (const tree of NEUTRAL_TREES) {
      expect(block, `the neutrality rule does not name ${tree}/`).toContain(`${tree}/`);
    }
    expect(block, 'the neutrality rule still claims a scope B3 does not enforce')
      .not.toMatch(/Nothing outside `apps\/web`/);
  });

  it('marks the plugin conformance test as unbuilt while the JSON Schema is', () => {
    // Rule 4 claimed "a conformance test proves the two agree". There is no
    // committed JSON Schema to compare against and no such test.
    const schemaExists = existsSync(path.join(ROOT, 'packages/protocol/schema'));
    if (!schemaExists) {
      const block = boundaryBlock();
      expect(block, 'a conformance test is described without its milestone').toContain('M08');
      expect(block).not.toMatch(/a conformance test proves the two agree/);
    }
  });
});

describe('every document that counts the plugin tests counts them right', () => {
  // The TODO explaining why the Luau suite is not in CI quotes its size. It said
  // 103 after the suite had grown to 118 — a small number, in the one comment a
  // reviewer would use to judge how much is going unrun.
  //
  // `docs/MILESTONES.md` quotes the same number twice, and its live-status
  // paragraph now says in as many words that this file decides it. That sentence
  // is the reason the second assertion below exists: the count was allowed to
  // stay in a hand-maintained document *because* a gate reads it, and a promise
  // of enforcement with no enforcement behind it is the exact defect this whole
  // file was written to catch.
  const luauCount = readdirSync(path.join(ROOT, 'plugin/tests'))
    .filter((file) => file.endsWith('.luau') && file !== 'run.luau' && file !== 'Fake.luau')
    .reduce(
      (total, file) =>
        total + [...readFileSync(path.join(ROOT, 'plugin/tests', file), 'utf8').matchAll(/^\s*t\.test\(/gm)].length,
      0,
    );

  it('counts something', () => {
    expect(luauCount).toBeGreaterThan(50);
  });

  it('quotes the count the suite actually produces', () => {
    expect(CI, `the CI TODO is stale; the suite has ${luauCount} tests`).toContain(`${luauCount} Luau tests`);
  });

  it('finds the count on every MILESTONES line that names the plugin suite', () => {
    // The regex below reads "<n> Luau". The `M15` row said "231 tests" three
    // times, about the same suite, in a sentence that never used the word —
    // and so passed a gate written to decide exactly that number. A count is
    // only gated by the phrasing somebody happened to use unless the rule
    // follows the subject instead: any count on a line that cites a file under
    // `plugin/` is a count of this suite.
    const lines = MILESTONES.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/`plugin\/(src|tests)\//.test(line)) continue;
      for (const match of line.matchAll(/(\d+) tests?\b/g)) {
        expect(
          Number(match[1]),
          `MILESTONES line ${index + 1} says ${match[0]} of the plugin suite; plugin/tests/ has ${luauCount}`,
        ).toBe(luauCount);
      }
    }
  });

  it('finds the same count everywhere MILESTONES states one', () => {
    // Every "<n> Luau" in the document, not the first: the live-status paragraph
    // and the M41 row each carry one, and a fix applied to whichever a reader
    // happened to open is how the two came to disagree in the first place.
    const quoted = [...MILESTONES.matchAll(/(\d+) Luau/g)].map((match) => Number(match[1]));
    expect(quoted.length, 'MILESTONES no longer states the plugin test count').toBeGreaterThan(0);
    for (const stated of quoted) {
      expect(stated, `MILESTONES says ${stated} Luau tests; plugin/tests/ has ${luauCount}`).toBe(
        luauCount,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The widened gate.
//
//  Everything above this line reads five files. That was the finding: the gate
//  is genuinely good — assertions written against the Zod schemas, the package
//  manifests and the directory listing rather than against prose snapshots, and
//  it caught real drift — but its FRONT_MATTER constant is two files, its
//  CONTRIBUTING assertions are bounded to "Getting set up", and its REPO-LAYOUT
//  assertions are bounded to "Boundary rules". Eleven documentation defects
//  survived two adversarial review rounds, and every single one lived in a file
//  or a section that scope does not read: `docs/THREAT-MODEL.md`, the ADRs, the
//  rest of CONTRIBUTING, the CI comments, `plugin/README.md`.
//
//  Coverage that stops exactly where the bugs are is not bad luck. It is the
//  bug. So the rules below apply to *every* markdown file in the repository —
//  root, `docs/`, `docs/architecture/`, `plugin/`, `.github/` — and each one is
//  decidable against the tree rather than against a reading of the prose.
//
//  The rules live in `scripts/docs-claims-rules.ts` as pure functions over
//  (documents, repository facts). That is not architecture for its own sake: it
//  is what lets each rule be handed a planted violation and shown to reject it,
//  in the self-test block at the bottom. `verify-boundaries.ts` argues for its
//  own self-tests on the grounds that a gate which cannot fail is decoration.
//  A gate over documentation earns that suspicion twice over, because its
//  subject matter is claims that were believed without being checked.
// ─────────────────────────────────────────────────────────────────────────────

const DOCS = collectDocs(ROOT);
const FACTS = collectRepoFacts(ROOT);

/**
 * Failures print every offending file and line at once. A gate that reports one
 * violation per run turns a ten-minute fix into ten runs, and the documents this
 * reads are edited in sweeps.
 */
function report(violations: readonly Violation[]): string {
  return violations.map((v) => `${v.file}:${v.line} — ${v.detail}`).join('\n');
}

describe('every document that counts the JSON Schema projections counts them right', () => {
  // Same defect as the Luau count, in a second place. M11 added
  // `RollbackOutcome.schema.json` and `RollbackResult.schema.json`;
  // `packages/protocol/schema/README.md` was updated to 54 and the M08 row in
  // `docs/MILESTONES.md` went on saying 52, so two documents in the same tree
  // disagreed about a number either of them could have counted. The generator
  // is what decides it — `verify:schemas` already refuses a projection that
  // drifted — so the only thing left unchecked was the prose about it.
  const schemaCount = readdirSync(path.join(ROOT, 'packages/protocol/schema')).filter((file) =>
    file.endsWith('.schema.json'),
  ).length;

  it('counts something', () => {
    expect(schemaCount).toBeGreaterThan(10);
  });

  it('finds the same count everywhere a document states one', () => {
    // Every "<n> JSON Schema" in either document, not the first, for the same
    // reason the Luau check takes them all: a fix applied to whichever file the
    // reader happened to open is how they came to disagree.
    const stated = [
      ...[...MILESTONES.matchAll(/(\d+) JSON Schema/g)].map((m) => ['docs/MILESTONES.md', Number(m[1])] as const),
      ...[...SCHEMA_README.matchAll(/each of the (\d+)/g)].map((m) => ['packages/protocol/schema/README.md', Number(m[1])] as const),
    ];
    expect(stated.length, 'no document states the JSON Schema count any more').toBeGreaterThan(0);
    for (const [where, count] of stated) {
      expect(count, `${where} says ${count}; packages/protocol/schema/ has ${schemaCount}`).toBe(schemaCount);
    }
  });
});

describe('the widened gate reads the whole repository', () => {
  // If this ever collapses to a handful of files the rules below all pass
  // vacuously, which is the failure mode that produced the finding in the first
  // place: a green gate over a corpus that excludes the defects.
  it('collects every markdown file, not just the front matter', () => {
    expect(DOCS.length).toBeGreaterThan(20);
    for (const required of [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'docs/THREAT-MODEL.md',
      'docs/REPO-LAYOUT.md',
      'plugin/README.md',
      'docs/architecture/adr-013-fresh-public-repo.md',
      'docs/architecture/adr-014-staged-pairing-crypto.md',
    ]) {
      expect(DOCS.map((d) => d.path)).toContain(required);
    }
  });

  it('reads its facts from the tree, not from a document', () => {
    // Spot-check the derivations the rules lean on. Each is a fact a document
    // could state wrongly, which is exactly why none of them is read from one.
    expect(FACTS.packages.has('protocol')).toBe(true);
    expect(FACTS.packages.has('luau-analysis')).toBe(true);
    // A name no package has ever carried, so this stays a real negative even
    // as the workspace grows. The positive above used to be this assertion's
    // subject, back when `luau-analysis` was the milestone every document was
    // describing in the present tense before it existed.
    expect(FACTS.packages.has('ghost')).toBe(false);
    expect(FACTS.npmScripts.has('verify:boundaries')).toBe(true);
    expect(FACTS.binPrefix).toBe('forgebridge');
    expect(FACTS.workflowStems.has('ci')).toBe(true);
    expect(FACTS.verifyGates.length).toBeGreaterThanOrEqual(3);
  });

  it('does not count a tool named only in a workflow comment as running', () => {
    // `ci.yml` explains at length why the Luau suite is *not* in CI. If that
    // comment counted as a step, a document claiming "Luau tests in CI" would
    // pass on the strength of the comment saying they do not.
    expect(FACTS.workflowBody).not.toContain('luau');
    expect(FACTS.workflowBody).toContain('vitest');
  });
});

describe('D1 — a document that names packages/<x> names a real package', () => {
  // `packages/luau-analysis` was described in the present tense in three files
  // before it existed — two of them files the old gate does not read. It exists
  // now; the rule is what keeps the *next* such name honest. A directory without
  // a manifest does not count as a package either.
  it('names no package that has no manifest, without a milestone marker', () => {
    expect(report(checkPackageExistence(DOCS, FACTS))).toBe('');
  });

  it('counts a Python package as a package', () => {
    // `packages/sdk-python` carries a pyproject.toml, not a package.json, and
    // reading only package.json made D1 report a true statement about it as a
    // violation. A gate whose idea of a package is narrower than the repository's
    // fires on correct documentation, which is how a gate gets switched off.
    expect(FACTS.packages.has('sdk-python')).toBe(true);
  });

  it('still refuses a directory with no manifest of any kind — the control', () => {
    expect(FACTS.packages.has('ghost')).toBe(false);
  });
});

describe('D2 — a tool claimed "in CI" is a tool some workflow runs', () => {
  // ADR-013's mitigation named `gitleaks` when no action, config or step existed.
  // The old gate caught that one ADR by name. This catches the shape, wherever
  // it appears — including a layout tree listing workflow files that are not there.
  it('claims no CI tool and no workflow file that does not exist', () => {
    expect(report(checkCiToolClaims(DOCS, FACTS))).toBe('');
  });
});

describe('D3 — every advertised `npm run` command exists', () => {
  // The cheapest rule in the file and the one with the widest blast radius: a
  // stale command list is the first thing a new contributor types.
  it('advertises no script that no manifest declares', () => {
    expect(report(checkNpmScripts(DOCS, FACTS))).toBe('');
  });
});

describe('D4 — every verify:* gate is documented and invoked, whole-file', () => {
  /**
   * The bounded version of this check is above: it reads the "Getting set up"
   * block only. That bound is the finding in miniature — a gate mentioned
   * anywhere else in CONTRIBUTING, or dropped from the later sections, is
   * invisible to it. This one reads the whole file, and asserts both halves of
   * the seam: a gate CONTRIBUTING never mentions is a rule a contributor learns
   * from a red build, and a gate no CI job runs is a rule that does not exist.
   */
  it('names every gate somewhere in CONTRIBUTING and in ci.yml', () => {
    expect(report(checkVerifyGateCoverage(FACTS, CONTRIBUTING, CI))).toBe('');
  });
});

describe('D5 — nothing calls the relay blind except next to M19 or ADR-014', () => {
  /**
   * ADR-014 is a decision whose entire content is "do not say this yet", and the
   * claim it forbids has now been found in three separate files across two
   * review rounds — the README diagram, the threat model's trust-boundary
   * picture, and the plugin's posture list. A decision that keeps being violated
   * needs a gate rather than another reviewer.
   *
   * The match spans line breaks on purpose. The worst instance of it was an
   * ASCII diagram that labelled our own relay column `blind` on one line and
   * `pipe` on the next, which no same-line search would ever have seen.
   */
  it('ties every blind-relay and end-to-end-encryption claim to its milestone', () => {
    expect(report(checkBlindRelayClaims(DOCS))).toBe('');
  });
});

describe('D6 — a sentence claiming a test exists points at one', () => {
  /**
   * Promise 4 said it was "checked by a test" that nobody had written. That is
   * the defect this file opens with, and it is checkable in only one direction:
   * a claim can be required to *point* somewhere, and the thing it points at can
   * be required to exist.
   *
   * State the limits plainly, in a gate whose subject is overclaiming:
   *
   *   ✓ catches a present-tense test claim naming no test and no milestone.
   *   ✓ catches a claim naming a test file that was renamed or deleted.
   *   ✗ cannot tell whether the named test asserts what the sentence says. A
   *     path to any real test file satisfies it.
   *   ✗ cannot see a claim phrased outside its verb set.
   *
   * It is a traceability gate, not a proof of the claim. What it buys is that
   * every such sentence has somewhere to point, and that a reader who follows
   * the pointer finds a file rather than a belief.
   */
  it('leaves no test claim without a test file or a milestone', () => {
    expect(report(checkClaimedTests(DOCS, FACTS))).toBe('');
  });
});

describe('D7 — a command that looks like our binary is our binary', () => {
  // `forgebridge-daemon` is a real `bin`; a bare `forgebridge` is the M28 CLI and
  // the README is right to mark it. The family name is derived from the npm
  // scope rather than written here, so it follows a rename.
  it('invokes no binary this repository does not declare', () => {
    expect(report(checkBinNames(DOCS, FACTS))).toBe('');
  });
});

describe('D9 — a cited TODO marker is a marker that is really there', () => {
  // `docs/MILESTONES.md` cited `TODO(M40)` in `packages/daemon/src/rollback.ts`
  // as M11's live blocker after M40 had closed it and deleted the marker, so
  // one row called the work unfinished and the next called it done. Four
  // agents landing in parallel is how that arrives, and nothing could see it.
  it('cites no TODO that its named file does not carry', () => {
    expect(
      report(
        checkCitedTodos(DOCS, FACTS, (rel) => {
          const abs = path.join(ROOT, rel);
          return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        }),
      ),
    ).toBe('');
  });
});

describe('D8 — the layout table lists every package, and calls none of them empty', () => {
  // The rule that would have caught `apps/relay` and `packages/storage-sqlite`
  // arriving as full packages and never reaching the table, and `apps/web`
  // still being marked absent long after it built and tested. The older check
  // above runs the other way — a *listed* directory with no files must carry a
  // milestone — and a directory nobody listed was outside both.
  it('lists every workspace directory, none of them described as absent', () => {
    expect(report(checkLayoutCoverage({ path: 'README.md', text: README }, FACTS))).toBe('');
  });
});

describe('D10 — no inventory calls a directory absent while it is there', () => {
  // Six inventories in five documents described directories that had landed
  // with code and tests as directories that do not exist. `SECURITY.md` was the
  // expensive one: `apps/relay` and `apps/web` sat under a heading saying the
  // directories were absent, so the two most attackable things in the tree were
  // formally out of scope for a report.
  it('finds no directory described as absent that this tree has', () => {
    expect(report(checkAbsenceClaims(DOCS, FACTS))).toBe('');
  });

  it('reads a corpus that still contains the inventories', () => {
    // Guards the vacuous pass: if the tree-diagram and table shapes disappeared
    // from the corpus, the assertion above would be green over nothing.
    const inventoryLines = DOCS.flatMap((d) => d.text.split('\n')).filter(
      (line) => /^\s*[├└]──\s/.test(line) || /^\s*\|/.test(line),
    );
    expect(inventoryLines.length).toBeGreaterThan(100);
  });
});

describe('D11 — a quoted `ls` prints what `ls` prints', () => {
  // `docs/ARCHITECTURE.md` listed nine packages and called them "every one of
  // the nine" while `packages/` held thirteen.
  it('finds no stale directory listing', () => {
    expect(report(checkDirectoryListings(DOCS, FACTS))).toBe('');
  });

  it('still finds a listing to check', () => {
    expect(DOCS.some((d) => /`ls [a-z]+\/?`/.test(d.text))).toBe(true);
  });
});

describe('D12 — stated surface sizes match the arrays that define them', () => {
  // `seven skills` stood in three files while `SKILL_IDS` held eight, and
  // `eleven tools` in four while `tools.ts` registered twelve.
  it('counts the three surfaces out of the tree', () => {
    expect(FACTS.surfaces.tools).toBeGreaterThan(0);
    expect(FACTS.surfaces.skills).toBeGreaterThan(0);
    expect(FACTS.surfaces.commands).toBeGreaterThan(0);
  });

  it('finds no document or comment that misstates one', () => {
    const sources = [...FACTS.sourceFiles].map((rel) => ({
      path: rel,
      text: readFileSync(path.join(ROOT, rel), 'utf8'),
    }));
    expect(report(checkSurfaceCounts([...DOCS, ...sources], FACTS))).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Self-tests. Every rule above is handed a planted violation and required to
//  reject it, and handed the marked-up version and required to accept it.
//
//  Both halves matter. A rule that fires on everything is as useless as one that
//  fires on nothing — it would push authors to delete claims rather than date
//  them, and the standard here is the opposite: restate the claim as the plan it
//  is, and name the milestone that lands it.
//
//  Fixtures are in-memory. Nothing below reads or writes the real tree.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_FACTS: RepoFacts = {
  packages: new Set(['protocol']),
  treeDirs: new Set(['packages', 'packages/protocol', 'packages/protocol/src', 'apps', 'apps/relay']),
  surfaces: { tools: 12, skills: 8, commands: 8 },
  npmScripts: new Set(['check', 'verify:boundaries', 'verify:assets']),
  binNames: new Set(['acme-daemon']),
  binPrefix: 'acme',
  workflowStems: new Set(['ci', 'dco']),
  workflowBody: ['name: ci', '  - run: npm run verify-boundaries', '  - uses: actions/checkout@v4'].join('\n'),
  testFiles: new Set(['packages/protocol/test/path.test.ts', 'plugin/tests/PathSpec.luau']),
  repoBasenames: new Set(['notice', 'readme', 'security']),
  verifyGates: ['verify:boundaries', 'verify:assets'],
  workspaceDirs: new Set(['packages/protocol']),
  sourceFiles: new Set(['packages/protocol/src/index.ts', 'packages/daemon/src/rollback.ts', 'plugin/src/Journal.luau']),
};

/** One fixture document. The path matters only where a rule keys on it (D5). */
const doc = (text: string, at = 'FIXTURE.md'): Doc[] => [{ path: at, text }];

describe('self-test: claim units', () => {
  // `unitAt` decides how far a milestone marker's authority reaches. Both of
  // these properties are load-bearing for every rule above.
  it('lets a marker cover the paragraph it sits in', () => {
    const text = 'The parser lives in packages/ghost.\nIt is unbuilt (M10).\n';
    expect(carriesMilestone(unitAt(text, 0))).toBe(true);
  });

  it('does not let one table row lend its marker to the next', () => {
    // docs/MILESTONES.md is one long table. Paragraph-scoped units would make
    // every row in it excusable by any other row.
    const text = '| M19 | encrypted pairing |\n| relay | blind pipe |\n';
    expect(carriesMilestone(unitAt(text, 1))).toBe(false);
    expect(carriesMilestone(unitAt(text, 0))).toBe(true);
  });

  it('treats a run of commands and the comment above them as one unit', () => {
    // The README's Quickstart convention: the marker is in the `#` comment
    // introducing the block, not repeated on each command line.
    const text = '```bash\n# 4. Point a producer at it.   (M28)\nacme run "x"\nacme diff\n```\n';
    expect(carriesMilestone(unitAt(text, 3))).toBe(true);
  });

  it('stops a unit at a blank line', () => {
    const text = 'Unbuilt (M10).\n\nThe parser lives in packages/ghost.\n';
    expect(carriesMilestone(unitAt(text, 2))).toBe(false);
  });
});

describe('self-test: D1 rejects a package that does not exist', () => {
  it('fails on a present-tense mention of a package with no manifest', () => {
    const found = checkPackageExistence(doc('Static analysis runs in `packages/luau-analysis`.'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(found.map((v) => v.rule)).toEqual(['D1']);
    expect(report(found)).toContain('luau-analysis');
  });

  it('accepts the same mention once it carries its milestone', () => {
    expect(checkPackageExistence(doc('`packages/luau-analysis` (M10 — unbuilt) will do this.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('accepts a package that really exists', () => {
    expect(checkPackageExistence(doc('The schemas live in `packages/protocol/src`.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('reports the right line in a multi-line document', () => {
    const found = checkPackageExistence(doc('one\ntwo\nsee packages/ghost here\n'), FIXTURE_FACTS);
    expect(found.map((v) => v.line)).toEqual([3]);
  });
});

describe('self-test: D2 rejects a CI tool no workflow runs', () => {
  it('fails on a tool list that no workflow mentions', () => {
    const found = checkCiToolClaims(doc('- `gitleaks` + Semgrep + CodeQL in CI.'), FIXTURE_FACTS);
    expect(found.map((v) => v.detail).join(' ')).toContain('gitleaks');
    expect(found.map((v) => v.detail).join(' ')).toContain('Semgrep');
    expect(found.map((v) => v.detail).join(' ')).toContain('CodeQL');
  });

  it('accepts a tool a workflow actually runs', () => {
    expect(checkCiToolClaims(doc('`verify-boundaries` runs in CI on every push.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('accepts an unbuilt scanner once it is dated', () => {
    expect(checkCiToolClaims(doc('Adding `gitleaks` in CI is M42, blocked on a pinned action version.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('fails on a layout tree listing workflow files that do not exist', () => {
    const found = checkCiToolClaims(doc('└── .github/workflows/     ci · sbom · release · dco'), FIXTURE_FACTS);
    expect(found.map((v) => v.detail).sort()).toEqual([
      '.github/workflows/release does not exist',
      '.github/workflows/sbom does not exist',
    ]);
  });

  it('accepts a layout tree listing only real workflows', () => {
    expect(checkCiToolClaims(doc('└── .github/workflows/     ci · dco'), FIXTURE_FACTS)).toEqual([]);
  });

  it('does not mistake a capitalised heading or table cell for a tool name', () => {
    // "## Boundary rules (… run in CI)" and "| Official brand assets … CI gate |"
    // are grammar, not names. A rule that fired on those would be turned off.
    expect(checkCiToolClaims(doc('## Boundary rules (enforced by a script, run in CI)'), FIXTURE_FACTS)).toEqual([]);
    expect(checkCiToolClaims(doc('| C7 | Official assets only | manifest + CI gate |'), FIXTURE_FACTS)).toEqual([]);
  });
});

describe('self-test: D3 rejects a command that does not exist', () => {
  it('fails on an advertised script no manifest declares', () => {
    const found = checkNpmScripts(doc('Run `npm run plugin:build` to produce the .rbxm.'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(report(found)).toContain('plugin:build');
  });

  it('accepts a script that exists', () => {
    expect(checkNpmScripts(doc('Run `npm run check` before you push.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('accepts an unwritten script that says which milestone writes it', () => {
    expect(checkNpmScripts(doc('```\n# 1. Start the bridge.  (M14)\nnpm run daemon\n```'), FIXTURE_FACTS)).toEqual([]);
  });
});

describe('self-test: D4 rejects a gate that is undocumented or unrun', () => {
  it('fails when CONTRIBUTING never mentions a declared gate', () => {
    const found = checkVerifyGateCoverage(
      FIXTURE_FACTS,
      'Run `npm run verify:boundaries` before you push.',
      'run: npm run verify:boundaries\nrun: npm run verify:assets',
    );
    expect(found).toHaveLength(1);
    expect(found.map((v) => v.file)).toEqual(['CONTRIBUTING.md']);
    expect(report(found)).toContain('verify:assets');
  });

  it('fails when no CI job runs a declared gate', () => {
    const found = checkVerifyGateCoverage(
      FIXTURE_FACTS,
      '`npm run verify:boundaries` · `npm run verify:assets`',
      'run: npm run verify:boundaries',
    );
    expect(found.map((v) => v.file)).toEqual(['.github/workflows/ci.yml']);
  });

  it('accepts a gate that is in both', () => {
    expect(
      checkVerifyGateCoverage(
        FIXTURE_FACTS,
        '`npm run verify:boundaries` and `npm run verify:assets`',
        'run: npm run verify:boundaries\nrun: npm run verify:assets',
      ),
    ).toEqual([]);
  });

  it('sees a gate documented outside the "Getting set up" block', () => {
    // The precise widening: the bounded check above would miss this file
    // entirely, because the mention is in a later section.
    const contributing = '## Getting set up\n\nnothing here\n\n## Security\n\nRun `npm run verify:boundaries` and `npm run verify:assets`.\n';
    expect(checkVerifyGateCoverage(FIXTURE_FACTS, contributing, 'npm run verify:boundaries\nnpm run verify:assets')).toEqual([]);
  });
});

describe('self-test: D5 rejects an undated blind-relay claim', () => {
  it('fails on a posture string offered as available', () => {
    const found = checkBlindRelayClaims(doc('- **Relay — end-to-end encrypted, the relay sees only ciphertext**'));
    expect(found.map((v) => v.rule)).toEqual(['D5']);
  });

  it('fails on a diagram that splits the claim across two lines', () => {
    // The instance no same-line search would find: our own trust-boundary
    // picture labelling the relay column `blind` / `pipe`.
    const found = checkBlindRelayClaims(doc('```\n user ┊ our relay ┊ provider\n──────┊────────────┊────────\n keys ┊ blind      ┊ untrusted\n      ┊ pipe       ┊\n```'));
    expect(found.length).toBeGreaterThan(0);
  });

  it('accepts the claim when it is dated to M19', () => {
    expect(checkBlindRelayClaims(doc('A blind relay — end-to-end encrypted payloads — is **M19** and unbuilt.'))).toEqual([]);
  });

  it('accepts the claim when it cites ADR-014', () => {
    expect(checkBlindRelayClaims(doc('v2: E2E payload encryption makes the relay blind (ADR-014).'))).toEqual([]);
  });

  it('exempts ADR-014 itself, which exists to define the rule', () => {
    expect(
      checkBlindRelayClaims(
        doc('Real end-to-end encryption means shipping X25519.', 'docs/architecture/adr-014-staged-pairing-crypto.md'),
      ),
    ).toEqual([]);
  });
});

describe('self-test: D6 rejects a test claim that points nowhere', () => {
  it('fails on a present-tense claim naming no test', () => {
    const found = checkClaimedTests(doc('It is verifiable: a test asserts no outbound request carries a key.'), FIXTURE_FACTS);
    expect(found.map((v) => v.rule)).toEqual(['D6']);
  });

  it('fails on "checked by a test" with nothing to check', () => {
    expect(checkClaimedTests(doc('Your keys stay yours — checked by a test.'), FIXTURE_FACTS)).toHaveLength(1);
  });

  it('accepts a claim that names a test file which exists', () => {
    expect(
      checkClaimedTests(doc('A test asserts this: `packages/protocol/test/path.test.ts`.'), FIXTURE_FACTS),
    ).toEqual([]);
  });

  it('fails on a claim that names a test file which does not', () => {
    // The rename case. A path is only worth requiring if it is resolved.
    expect(checkClaimedTests(doc('A test asserts this: `packages/protocol/test/ghost.test.ts`.'), FIXTURE_FACTS)).toHaveLength(1);
  });

  it('accepts a claim dated to the milestone that writes the test', () => {
    expect(checkClaimedTests(doc('A test will assert this — the suite proves it in M43.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('does not pretend to check what the named test asserts', () => {
    // Stated as an executable admission rather than a caveat in a comment: a
    // path to *any* real test satisfies D6, and a reader should know that.
    expect(
      checkClaimedTests(doc('A test proves the relay is blind: `plugin/tests/PathSpec.luau`.'), FIXTURE_FACTS),
    ).toEqual([]);
  });
});

describe('self-test: D7 rejects a binary that is not declared', () => {
  it('fails on a fenced command naming a binary no manifest declares', () => {
    const found = checkBinNames(doc('```bash\nacme run "add a shop stall"\n```'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(report(found)).toContain('acme');
  });

  it('fails on a `$` prompt outside a fence', () => {
    expect(checkBinNames(doc('$ acme apply'), FIXTURE_FACTS)).toHaveLength(1);
  });

  it('accepts a binary that is declared', () => {
    expect(checkBinNames(doc('```bash\nacme-daemon --port 7317\n```'), FIXTURE_FACTS)).toEqual([]);
  });

  it('accepts an unbuilt binary that names its milestone', () => {
    expect(checkBinNames(doc('```bash\n# 4. Point a producer at it.  (M28)\nnpx acme run "x"\nnpx acme diff\n```'), FIXTURE_FACTS)).toEqual([]);
  });

  it('leaves inline prose alone', () => {
    // Inline code names things at least as often as it invokes them; a rule that
    // fired on `acme daemon` in a sentence would be noise.
    expect(checkBinNames(doc('The `acme daemon` command is the CLI entry point.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('accepts a transcript of what a declared binary prints', () => {
    // A fenced block holds output as often as it holds commands, and output is
    // prefixed `acme-daemon: …`. No bin entry can end in a colon, so without
    // the strip this line could never pass however the binary was named.
    expect(
      checkBinNames(doc('```\nacme-daemon: listening on http://127.0.0.1:7317\n```'), FIXTURE_FACTS),
    ).toEqual([]);
  });

  it('still fails on a transcript of a binary no manifest declares', () => {
    // The control for the line above. Stripping the colon must not turn the
    // rule off for sample output — a README quoting what `acme-relay` prints is
    // claiming an `acme-relay` exists.
    const found = checkBinNames(doc('```\nacme-relay: forwarding to the daemon\n```'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(report(found)).toContain('acme-relay');
  });

  it('does not fire when the repository has no scope to derive a family from', () => {
    expect(checkBinNames(doc('```bash\nacme run\n```'), { ...FIXTURE_FACTS, binPrefix: '' })).toEqual([]);
  });
});

describe('self-test: D8 rejects a layout table that hides a package', () => {
  const facts: RepoFacts = { ...FIXTURE_FACTS, workspaceDirs: new Set(['packages/protocol', 'apps/relay']) };
  const readme = (rows: string) => ({ path: 'README.md', text: `## Repository layout\n\n\`\`\`\n${rows}\n\`\`\`\n` });

  it('fires on a package with a manifest and no row', () => {
    // The `apps/relay` case: a directory nobody listed cannot be checked for
    // anything, so the one-directional check reported clean.
    const found = checkLayoutCoverage(readme('packages/protocol/   the contract   frozen'), facts);
    expect(found.map((v) => v.rule)).toEqual(['D8']);
    expect(found[0]?.detail).toContain('apps/relay/');
  });

  it('fires on a row that calls a directory absent while it has a manifest', () => {
    // The `apps/web` case: the row read "M32–M39 — absent" long after the app
    // had a manifest, a build and a test suite.
    const found = checkLayoutCoverage(
      readme(['packages/protocol/   the contract   frozen', 'apps/relay/        cloud transport   M17 — absent'].join('\n')),
      facts,
    );
    expect(found.map((v) => v.rule)).toEqual(['D8']);
    expect(found[0]?.detail).toContain('described as empty or absent');
  });

  it('fires when the layout heading has moved, rather than finding nothing to check', () => {
    // Fail closed: "I cannot find the table" and "the table is fine" must not
    // be the same answer.
    const found = checkLayoutCoverage({ path: 'README.md', text: '# ForgeBridge\n\nNo layout here.\n' }, facts);
    expect(found.map((v) => v.rule)).toEqual(['D8']);
    expect(found[0]?.detail).toContain('cannot be checked');
  });

  it('accepts a table that lists every package plainly — CONTROL', () => {
    const found = checkLayoutCoverage(
      readme(['packages/protocol/   the contract   frozen', 'apps/relay/        cloud transport   M17'].join('\n')),
      facts,
    );
    expect(found).toEqual([]);
  });

  it('still allows a directory with no manifest to be marked absent — CONTROL', () => {
    // The legitimate shape this rule is most confusable with, and the one the
    // older check exists to enforce: `examples/` and an unbuilt app are
    // supposed to say so. D8 only speaks about directories carrying a manifest.
    const found = checkLayoutCoverage(
      readme(
        [
          'packages/protocol/   the contract   frozen',
          'apps/relay/        cloud transport   M17',
          'packages/opencloud/ Open Cloud       M48 — absent',
          'examples/           SDK examples     M29 — empty',
        ].join('\n'),
      ),
      facts,
    );
    expect(found).toEqual([]);
  });
});

describe('self-test: D9 rejects a TODO citation that points nowhere', () => {
  const read = (rel: string): string =>
    rel === 'packages/daemon/src/rollback.ts'
      ? '// the journal store moved to DaemonStore in M40\n'
      : '// TODO(M15): Luau has no property reflection\n';

  it('fires when the named file no longer carries the marker', () => {
    const found = checkCitedTodos(
      doc('The inverse store is not on `DaemonStore` (`TODO(M40)` in `packages/daemon/src/rollback.ts`).'),
      FIXTURE_FACTS,
      read,
    );
    expect(found.map((v) => v.rule)).toEqual(['D9']);
    expect(found[0]?.detail).toContain('may already be done');
  });

  it('fires when the cited file is not in the repository at all', () => {
    const found = checkCitedTodos(doc('`TODO(M40)` in `packages/daemon/src/nowhere.ts` explains it.'), FIXTURE_FACTS, read);
    expect(found.map((v) => v.rule)).toEqual(['D9']);
    expect(found[0]?.detail).toContain('not a file in this repository');
  });

  it('fires when a bare filename names more than one file, rather than picking one', () => {
    // Ambiguity is a finding, not a pass: guessing which `index.ts` was meant
    // is how a gate reports clean on a pointer no reader can follow.
    const facts: RepoFacts = {
      ...FIXTURE_FACTS,
      sourceFiles: new Set(['packages/a/src/index.ts', 'packages/b/src/index.ts']),
    };
    const found = checkCitedTodos(doc('`TODO(M09)` in `index.ts` covers it.'), facts, () => '');
    expect(found.map((v) => v.rule)).toEqual(['D9']);
    expect(found[0]?.detail).toContain('names 2 files');
  });

  it('accepts a marker the file really carries — CONTROL', () => {
    const found = checkCitedTodos(
      doc('A restored deletion is a rebuild (`TODO(M15)` in `plugin/src/Journal.luau`).'),
      FIXTURE_FACTS,
      read,
    );
    expect(found).toEqual([]);
  });

  it('accepts a path written relative to the document — CONTROL', () => {
    // `plugin/README.md` writes `src/Journal.luau`, and that is a correct
    // citation, not a broken one. A rule that only understood root-relative
    // paths would fire on every package README in the tree.
    const found = checkCitedTodos(
      [{ path: 'plugin/README.md', text: 'See `TODO(M15)` in `src/Journal.luau`.' }],
      FIXTURE_FACTS,
      read,
    );
    expect(found).toEqual([]);
  });

  it('accepts any one of a multi-milestone marker — CONTROL', () => {
    const found = checkCitedTodos(
      doc('`TODO(M14/M15)` in `plugin/src/Journal.luau` is the shape.'),
      FIXTURE_FACTS,
      () => '// TODO(M15): still open\n',
    );
    expect(found).toEqual([]);
  });
});

describe('self-test: D10 rejects an absence claim about a directory that exists', () => {
  it('rejects a status cell that calls a live directory absent', () => {
    const found = checkAbsenceClaims(
      doc('| **REST + OpenAPI 3.1** | `apps/relay` | M17 — absent | the same surface |'),
      FIXTURE_FACTS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe('D10');
    expect(found[0]?.detail).toContain('apps/relay');
  });

  it('rejects a top-level tree entry that calls a live directory absent', () => {
    const found = checkAbsenceClaims(doc('├── apps/                       absent entirely'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('apps/');
  });

  it('does not let the milestone marker excuse it', () => {
    // Every other rule in this file forgives a claim carrying `(M17)`. This one
    // must not: `M17 — absent` is the exact string that survived five reviews.
    expect(checkAbsenceClaims(doc('| `apps/relay` | M17 — absent |'), FIXTURE_FACTS)).toHaveLength(1);
  });

  it('accepts an absence claim about a directory that really is absent — CONTROL', () => {
    expect(
      checkAbsenceClaims(doc('| `packages/storage-supabase` | M40 — absent |'), FIXTURE_FACTS),
    ).toEqual([]);
    expect(checkAbsenceClaims(doc('├── rfcs/                       absent'), FIXTURE_FACTS)).toEqual([]);
  });

  it('leaves prose that happens to say "does not exist" alone — CONTROL', () => {
    // `docs/MILESTONES.md` is one long table of rows that say true things are
    // unfinished. A rule that read those as claims about a directory would fire
    // on dozens of correct sentences, and the fix for that is not a longer
    // allowlist — it is not reading prose in the first place.
    const row =
      '| M16 | Plugin: console mirror | PART | the console mirror is done and the selection ' +
      'context does not exist; `apps/relay` carries the transport half and the rest is owed |';
    expect(checkAbsenceClaims(doc(row), FIXTURE_FACTS)).toEqual([]);
    expect(checkAbsenceClaims(doc('The `apps/relay` queue register does not exist yet.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('leaves a nested tree entry alone — CONTROL', () => {
    // `│   └── docs/` inside `apps/` is `apps/docs/`, which this tree does not
    // have. Reading it as the repository's `docs/` would be a false positive on
    // a correct line.
    expect(checkAbsenceClaims(doc('│   └── docs/     documentation site   M50 — absent'), FIXTURE_FACTS)).toEqual([]);
  });
});

describe('self-test: D11 rejects a stale directory listing', () => {
  it('rejects a listing that omits a directory', () => {
    const found = checkDirectoryListings(doc('`ls packages/` returns `protocol`.'), {
      ...FIXTURE_FACTS,
      treeDirs: new Set(['packages', 'packages/protocol', 'packages/opencloud']),
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('opencloud');
  });

  it('rejects a listing naming a directory that is gone', () => {
    const found = checkDirectoryListings(
      doc('`ls packages/` returns exactly `protocol storage-supabase`.'),
      FIXTURE_FACTS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('storage-supabase');
  });

  it('fails closed when the directory has nothing in it', () => {
    const found = checkDirectoryListings(doc('`ls plugins/` returns `a b`.'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('no subdirectories');
  });

  it('accepts a listing that matches the tree — CONTROL', () => {
    expect(checkDirectoryListings(doc('`ls packages/` returns `protocol`.'), FIXTURE_FACTS)).toEqual([]);
  });
});

describe('self-test: D12 rejects a misstated surface size', () => {
  it('rejects a skill count the array contradicts', () => {
    const found = checkSurfaceCounts(doc('The card advertises seven skills.'), FIXTURE_FACTS);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe('D12');
    expect(found[0]?.detail).toContain('this repository has 8');
  });

  it('rejects a tool count in a source comment, not only in markdown', () => {
    const found = checkSurfaceCounts(
      [{ path: 'packages/mcp/src/server.ts', text: ' * constructing eleven tool registrations per call.' }],
      FIXTURE_FACTS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('packages/mcp/src/server.ts');
  });

  it('fails closed when the counter finds no array to count', () => {
    const found = checkSurfaceCounts(doc('twelve tools'), {
      ...FIXTURE_FACTS,
      surfaces: { tools: -1, skills: 8, commands: 8 },
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('has moved');
  });

  it('accepts the counts the arrays really hold — CONTROL', () => {
    expect(
      checkSurfaceCounts(doc('twelve tools, eight skills and eight commands.'), FIXTURE_FACTS),
    ).toEqual([]);
  });

  it('leaves "one tool" and "two commands" alone — CONTROL', () => {
    // English, not arithmetic: `packages/mcp/README.md` says "one tool" meaning
    // some one of them, and four other files do the same with two and three.
    expect(checkSurfaceCounts(doc('Approval is never one tool call away.'), FIXTURE_FACTS)).toEqual([]);
    expect(checkSurfaceCounts(doc('The walkthrough is two commands.'), FIXTURE_FACTS)).toEqual([]);
  });

  it('leaves rule counts alone — CONTROL', () => {
    // `packages/luau-analysis` has eight entries in `RULES` and nine ids that
    // can appear in a finding. Both numbers are right about different things,
    // so this rule decides neither.
    expect(checkSurfaceCounts(doc('It carries nine rules and eight rules.'), FIXTURE_FACTS)).toEqual([]);
  });
});
