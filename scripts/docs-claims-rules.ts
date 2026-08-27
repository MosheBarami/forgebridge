/**
 * The mechanically decidable half of the documentation gate.
 *
 * `scripts/__tests__/docs-claims.test.ts` already pins a set of hand-written
 * claims against their source of truth — the Zod schemas, the manifests, the
 * directory listing. It caught real drift. But its reach is bounded: it reads
 * two front-matter files, one section of `CONTRIBUTING.md`, and one section of
 * `docs/REPO-LAYOUT.md`. Eleven documentation defects survived two adversarial
 * review rounds, and every one of them lived in a file or a section that gate
 * does not read — `docs/THREAT-MODEL.md`, the ADRs, the rest of CONTRIBUTING,
 * the CI comments, `plugin/README.md`. Coverage that stops exactly where the
 * bugs are is not bad luck; it is the finding.
 *
 * So this file holds the rules that apply to *every* markdown file in the
 * repository, expressed as pure functions over (documents, repository facts) so
 * that each one can be handed a planted violation and shown to reject it. A gate
 * that cannot fail is decoration — the same argument `verify-boundaries.ts`
 * makes for its own self-tests.
 *
 * Each rule follows one shape:
 *
 *     find a sentence a reader would take as a statement of fact about today,
 *     decide it against the tree, and accept it anyway if it carries the
 *     milestone marker that says it is a plan.
 *
 * That second clause matters. The standard is not "delete the claim"; it is
 * "say which milestone lands it", in the style the README's Quickstart already
 * uses — `(M26)`, `(M08 — not generated yet)`, `TODO(M14/M15/M28)`.
 *
 * None of these rules read prose snapshots. They read the manifests, the
 * workflow files, and the directory listing, so editing the docs cannot break
 * them and moving a fact without the docs will.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface Violation {
  /** Rule id, matching the describe block in the test file. */
  rule: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7';
  /** Repository-relative path of the document. */
  file: string;
  /** 1-indexed line the claim sits on. */
  line: number;
  detail: string;
}

export interface Doc {
  /** Repository-relative, forward-slashed. */
  path: string;
  text: string;
}

/**
 * Everything the rules are allowed to believe about the repository. Collected
 * once from the tree; never transcribed from a document, because documents are
 * what is being checked.
 */
export interface RepoFacts {
  /** Directories under `packages/` that actually carry a package.json. */
  packages: ReadonlySet<string>;
  /** Every `scripts` key in the root manifest and in every package manifest. */
  npmScripts: ReadonlySet<string>;
  /** Every `bin` key declared by any manifest. */
  binNames: ReadonlySet<string>;
  /** The npm scope shared by the workspace packages, e.g. `forgebridge`. */
  binPrefix: string;
  /** Filename stems under `.github/workflows/`, e.g. `ci`, `dco`. */
  workflowStems: ReadonlySet<string>;
  /**
   * Every workflow file's contents with comment lines stripped, lowercased and
   * concatenated. Comments are removed on purpose: a tool named only in a `#`
   * line is a tool nobody runs, which is precisely the claim D2 exists to catch.
   */
  workflowBody: string;
  /** Repository-relative paths of files that are tests. */
  testFiles: ReadonlySet<string>;
  /**
   * Lowercased basenames of every file in the tree, extension stripped. A token
   * that names a file here — `NOTICE`, `README` — is a file, not a CI tool.
   */
  repoBasenames: ReadonlySet<string>;
  /** The root manifest's `verify:*` script names. */
  verifyGates: readonly string[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.venv']);

function walk(abs: string, root: string, out: string[] = []): string[] {
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(abs, entry.name), root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(abs, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Every markdown file in the repository, including `.github/` and `plugin/`. */
export function collectDocs(root: string): Doc[] {
  return walk(root, root)
    .filter((rel) => rel.endsWith('.md'))
    .sort()
    .map((rel) => ({ path: rel, text: readFileSync(path.join(root, rel), 'utf8') }));
}

function readManifest(file: string): { name?: string; scripts?: Record<string, string>; bin?: Record<string, string>; workspaces?: string[] } | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The directories the root manifest actually treats as workspaces, e.g.
 * `packages` and `apps` for `["packages/*", "apps/*"]`.
 *
 * Read from the manifest rather than written down here, because it has already
 * been wrong once: the list was `packages` alone, `apps/` arrived with the web
 * app, and D5 then reported `npm run dev` as a script no manifest declares —
 * while `apps/web/package.json` declared it three lines from where the gate was
 * looking. A gate that knows a subset of the workspace is a gate that fails on
 * the next directory somebody adds.
 */
function workspaceDirs(rootManifest: ReturnType<typeof readManifest>): string[] {
  const globs = rootManifest?.workspaces ?? [];
  return [...new Set(globs.map((glob) => glob.split('/')[0] ?? '').filter((dir) => dir !== ''))];
}

/** Directory names carrying a package.json directly under `parent`. */
function manifestDirs(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(parent, name, 'package.json')));
}

export function collectRepoFacts(root: string): RepoFacts {
  const rootManifest = readManifest(path.join(root, 'package.json'));

  // `packages` stays packages-only: it answers "does `packages/<name>` name a
  // real package?" for D1, and `apps/web` is not `packages/web`.
  const packages = new Set(manifestDirs(path.join(root, 'packages')));

  // Manifests, though, are every workspace's. `npmScripts` and `binNames` are
  // claims about what this repository can be asked to run, and `apps/web`
  // answering `npm run dev` is as true as `packages/cli` answering `npm test`.
  const workspaceManifests = workspaceDirs(rootManifest).flatMap((dir) =>
    manifestDirs(path.join(root, dir)).map((name) => readManifest(path.join(root, dir, name, 'package.json'))),
  );

  const manifests = [rootManifest, ...workspaceManifests].filter(
    (m): m is NonNullable<typeof m> => m !== null,
  );

  const npmScripts = new Set(manifests.flatMap((m) => Object.keys(m.scripts ?? {})));
  const binNames = new Set(manifests.flatMap((m) => Object.keys(m.bin ?? {})));

  // Derived, not assumed: the scope the workspace packages publish under is the
  // family a binary of this repository would belong to.
  const scoped = manifests.map((m) => m.name ?? '').find((name) => name.startsWith('@'));
  const binPrefix = scoped ? scoped.slice(1, scoped.indexOf('/')) : '';

  const workflowsDir = path.join(root, '.github/workflows');
  const workflowFiles = existsSync(workflowsDir)
    ? readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];
  const workflowStems = new Set(workflowFiles.map((f) => f.replace(/\.ya?ml$/, '')));
  const workflowBody = workflowFiles
    .map((f) => readFileSync(path.join(workflowsDir, f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .toLowerCase();

  const testFiles = new Set(
    walk(root, root).filter((rel) => /(\.test\.[tj]sx?|\.spec\.[tj]sx?|Spec\.luau)$/.test(rel)),
  );

  const repoBasenames = new Set(
    walk(root, root).map((rel) => path.basename(rel).replace(/\.[^.]+$/, '').toLowerCase()),
  );

  const rootScripts = Object.keys(readManifest(path.join(root, 'package.json'))?.scripts ?? {});

  return {
    packages,
    npmScripts,
    binNames,
    binPrefix,
    workflowStems,
    workflowBody,
    testFiles,
    repoBasenames,
    verifyGates: rootScripts.filter((name) => name.startsWith('verify:')),
  };
}

// ────────────────────────── milestone markers and claim units ──────────────────────────

/**
 * The marker style the README already uses: `M26`, `(M08 — not generated yet)`,
 * `TODO(M14/M15/M28)`, `M32–M39`, and the one lowercase-suffixed row, `M04b`.
 */
export const MILESTONE_MARKER = /\bM\d{2}[a-z]?\b/;

export function carriesMilestone(text: string): boolean {
  return MILESTONE_MARKER.test(text);
}

/**
 * The span a marker is allowed to cover — the answer to "does this claim carry
 * its milestone?".
 *
 * A table row is its own unit. Without that, one `| M19 | … |` row would excuse
 * every other row in the same table, and `docs/MILESTONES.md` is one long table.
 *
 * Everything else is the maximal run of non-blank lines around the claim: a
 * paragraph, a bullet list, an ASCII diagram, or a contiguous block of commands
 * inside a fence together with the comment lines above it. That last case is
 * exactly the README's Quickstart convention — the marker sits in the `#` comment
 * introducing the commands, not on each command — so this is the unit that
 * convention implies rather than one imposed on it.
 */
export function unitAt(source: string, lineIndex: number): string {
  const lines = source.split('\n');
  const at = (i: number): string => lines[i] ?? '';
  if (lineIndex < 0 || lineIndex >= lines.length) return '';
  const isRow = (i: number): boolean => /^\s*\|/.test(at(i));
  if (isRow(lineIndex)) return at(lineIndex);

  let start = lineIndex;
  while (start > 0 && at(start - 1).trim() !== '' && !isRow(start - 1)) start -= 1;
  let end = lineIndex;
  while (end < lines.length - 1 && at(end + 1).trim() !== '' && !isRow(end + 1)) end += 1;
  return lines.slice(start, end + 1).join('\n');
}

/** Line index (0-based) containing character offset `offset`. */
export function lineOf(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** True for lines inside a ``` fence. Index-aligned with `source.split('\n')`. */
export function fencedLines(source: string): boolean[] {
  let inside = false;
  return source.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inside = !inside;
      return false;
    }
    return inside;
  });
}

function push(
  out: Violation[],
  rule: Violation['rule'],
  doc: Doc,
  lineIndex: number,
  detail: string,
): void {
  out.push({ rule, file: doc.path, line: lineIndex + 1, detail });
}

// ────────────────────────────────── D1: packages ──────────────────────────────────

/**
 * D1 — a present-tense mention of `packages/<name>` must name a directory that
 * has a package.json.
 *
 * This is the rule that would have caught `packages/luau-analysis`, a package
 * that has never existed, described in the present tense in three files. A
 * directory without a manifest is not a package either — `packages/cli` is an
 * empty `src/`, and the README is right to mark it `M28 — empty`.
 */
export function checkPackageExistence(docs: readonly Doc[], facts: RepoFacts): Violation[] {
  const out: Violation[] = [];
  for (const doc of docs) {
    for (const match of doc.text.matchAll(/packages\/([a-z0-9][a-z0-9-]*)/g)) {
      const name = match[1] ?? '';
      if (facts.packages.has(name)) continue;
      const lineIndex = lineOf(doc.text, match.index ?? 0);
      if (carriesMilestone(unitAt(doc.text, lineIndex))) continue;
      push(out, 'D1', doc, lineIndex, `packages/${name} has no package.json and no milestone marker`);
    }
  }
  return out;
}

// ─────────────────────────────────── D2: CI claims ───────────────────────────────────

/**
 * Tokens that look like tool names but are not tools. This is a list of
 * *non*-tools, deliberately: the tools themselves are read out of the document
 * under test rather than matched against a list of things we thought to check,
 * because a hardcoded tool list can only ever catch the claims someone already
 * remembered.
 */
const NOT_A_TOOL = new Set([
  'ci', 'cd', 'pr', 'prs', 'adr', 'api', 'cli', 'sdk', 'mit', 'tls', 'url', 'ui', 'os',
  'e2e', 'rls', 'byok', 'mcp', 'a2a', 'http', 'https', 'json', 'yaml', 'toml', 'html',
  'todo', 'note', 'the', 'this', 'that', 'every', 'each', 'and', 'but', 'not', 'run',
  'runs', 'ran', 'job', 'jobs', 'step', 'steps', 'gate', 'gates', 'test', 'tests',
  'github', 'actions', 'workflow', 'workflows', 'main', 'node', 'npm', 'npx',
]);

const CI_CLAIM = /\bin CI\b|\bCI runs\b|\bruns? in CI\b|\bCI (?:job|gate|step|workflow)\b/i;

/**
 * How far back from the CI phrase a tool name may sit. The claims this catches
 * are lists — "`gitleaks` + Semgrep + CodeQL in CI" — so the tools are adjacent
 * to the phrase, and a wider window only picks up the rest of the sentence.
 */
const TOOL_WINDOW = 80;

/**
 * D2 — a tool a document says runs "in CI" must appear in a workflow file.
 *
 * Two shapes, both mechanical:
 *
 *   (a) the run of text immediately before a CI claim is scanned for tool-shaped
 *       tokens — backticked identifiers and capitalised words — and each must
 *       appear somewhere in the non-comment body of `.github/workflows/`.
 *   (b) a line naming `.github/workflows/` and then enumerating names with the
 *       ` · ` separator these trees use must enumerate only real workflows.
 *
 * The tool names come out of the document, never out of a list kept here: a
 * hardcoded list of tools can only catch the ones someone already thought of,
 * and the point of the rule is the tool nobody remembered. What is kept here is
 * the opposite — a short list of tokens that are *not* tools, plus the names of
 * files that actually exist in the tree, both of which are read out rather than
 * guessed at.
 *
 * What it cannot do: it does not know whether the step it found does what the
 * sentence says, only that the name occurs in something that runs. A claim
 * phrased without the words "in CI" is invisible to it, and so is a tool named
 * in lowercase prose without backticks, which is indistinguishable from an
 * ordinary noun.
 */
export function checkCiToolClaims(docs: readonly Doc[], facts: RepoFacts): Violation[] {
  const out: Violation[] = [];
  const repoNames = new Set([...facts.npmScripts, ...facts.workflowStems].map((n) => n.toLowerCase()));
  for (const doc of docs) {
    const lines = doc.text.split('\n');
    lines.forEach((line, lineIndex) => {
      const unit = unitAt(doc.text, lineIndex);

      const claim = CI_CLAIM.exec(line);
      if (claim) {
        const from = Math.max(0, claim.index - TOOL_WINDOW);
        const inWindow = (at: number): boolean => at >= from && at < claim.index;
        const candidates = new Set<string>();
        for (const m of line.matchAll(/`([A-Za-z][A-Za-z0-9-]{2,})`/g)) {
          if (inWindow(m.index ?? 0) && m[1]) candidates.add(m[1]);
        }
        for (const m of line.matchAll(/\b([A-Z][A-Za-z0-9]{2,})\b/g)) {
          const at = m.index ?? 0;
          if (!inWindow(at)) continue;
          // A capitalised word that opens a sentence, a heading, or a table cell
          // is capitalised by grammar, not because it is a name. "Boundary rules
          // … run in CI" is a heading; "Semgrep + CodeQL in CI" is a list.
          if (!/[^\s.|#!?:]\s*$/.test(line.slice(0, at))) continue;
          if (m[1]) candidates.add(m[1]);
        }
        for (const token of candidates) {
          const lower = token.toLowerCase();
          if (NOT_A_TOOL.has(lower) || repoNames.has(lower)) continue;
          // A name that is a file in this repository is a file, not a tool.
          if (facts.repoBasenames.has(lower)) continue;
          if (facts.workflowBody.includes(lower)) continue;
          if (carriesMilestone(unit)) continue;
          push(out, 'D2', doc, lineIndex, `"${token}" is claimed in CI; no workflow step names it`);
        }
      }

      if (line.includes('.github/workflows/')) {
        const after = line.slice(line.indexOf('.github/workflows/') + '.github/workflows/'.length);
        const enumerated = after.includes('·')
          ? after.split('·').map((t) => t.trim())
          : [after.split(/[\s`)\]]/)[0]];
        for (const raw of enumerated) {
          const token = (raw ?? '').replace(/\.ya?ml$/, '').trim();
          if (!/^[a-z][a-z0-9-]*$/.test(token)) continue;
          if (facts.workflowStems.has(token)) continue;
          if (carriesMilestone(unit)) continue;
          push(out, 'D2', doc, lineIndex, `.github/workflows/${token} does not exist`);
        }
      }
    });
  }
  return out;
}

// ─────────────────────────────────── D3: npm scripts ───────────────────────────────────

/**
 * D3 — every `npm run X` in a markdown file must be a script some manifest
 * declares, or carry a milestone marker.
 *
 * The cheapest rule here and the one with the widest blast radius: an advertised
 * command that does not exist wastes a contributor's first ten minutes, and
 * `CONTRIBUTING.md`'s command list has drifted before.
 */
export function checkNpmScripts(docs: readonly Doc[], facts: RepoFacts): Violation[] {
  const out: Violation[] = [];
  for (const doc of docs) {
    for (const match of doc.text.matchAll(/npm run ([a-zA-Z][a-zA-Z0-9:_-]*)/g)) {
      const script = match[1] ?? '';
      if (facts.npmScripts.has(script)) continue;
      const lineIndex = lineOf(doc.text, match.index ?? 0);
      if (carriesMilestone(unitAt(doc.text, lineIndex))) continue;
      push(out, 'D3', doc, lineIndex, `npm run ${script} is not declared by any manifest`);
    }
  }
  return out;
}

// ──────────────────────────────── D4: verify:* completeness ────────────────────────────────

/**
 * D4 — every `verify:*` gate in the root manifest must appear in CONTRIBUTING
 * *and* in ci.yml.
 *
 * The existing gate checks a bounded block of CONTRIBUTING — the "Getting set
 * up" section — which means a gate documented nowhere else in the file still
 * passes, and a gate that drifted out of the later sections is invisible. This
 * one reads the whole file. Both directions of the seam matter: a gate CI runs
 * that CONTRIBUTING never mentions is a rule a contributor learns from a red
 * build.
 */
export function checkVerifyGateCoverage(
  facts: RepoFacts,
  contributing: string,
  ciWorkflow: string,
): Violation[] {
  const out: Violation[] = [];
  for (const gate of facts.verifyGates) {
    if (!contributing.includes(`npm run ${gate}`)) {
      out.push({
        rule: 'D4',
        file: 'CONTRIBUTING.md',
        line: 0,
        detail: `${gate} is a declared gate that CONTRIBUTING never tells anyone to run`,
      });
    }
    if (!ciWorkflow.includes(`npm run ${gate}`)) {
      out.push({
        rule: 'D4',
        file: '.github/workflows/ci.yml',
        line: 0,
        detail: `${gate} is a declared gate that no CI job runs`,
      });
    }
  }
  return out;
}

// ───────────────────────────────────── D5: blind relay ─────────────────────────────────────

/**
 * The claim ADR-014 exists to forbid. Bounded gaps rather than same-line
 * matching, because the worst instance of it is an ASCII diagram that labels our
 * own trust boundary `blind` on one line and `pipe` on the next.
 */
const BLIND_PHRASES: readonly RegExp[] = [
  /blind[\s\S]{0,40}(?:pipe|relay)/gi,
  /(?:pipe|relay)[\s\S]{0,40}blind/gi,
  /end[\s‐-―-]?to[\s‐-―-]?end[\s\S]{0,20}encrypt/gi,
  /\bE2E[\s\S]{0,20}encrypt/gi,
];

const M19_OR_ADR014 = /\bM19\b|ADR-014|adr-014-/i;

/**
 * D5 — nothing may describe the relay as blind, or the link as end-to-end
 * encrypted, except next to M19 or ADR-014.
 *
 * ADR-014 is a decision whose entire content is "do not say this yet", and the
 * claim has been found in three separate files across two review rounds. A
 * decision that keeps being violated is a decision that needs a gate rather than
 * a reviewer.
 *
 * The ADR itself is exempt by path: requiring the document that defines the rule
 * to cite itself on every line is noise, not rigour.
 *
 * What it cannot do: it is lexical. A denial ("the relay is *not* blind") is
 * accepted only because the surrounding paragraph cites M19 and ADR-014 anyway —
 * this rule does not parse negation, and a paragraph that denies the claim
 * without citing either is expected to fail and to be fixed by citing them.
 */
export function checkBlindRelayClaims(docs: readonly Doc[]): Violation[] {
  const out: Violation[] = [];
  for (const doc of docs) {
    if (/docs\/architecture\/adr-014-/.test(doc.path)) continue;
    const seen = new Set<number>();
    for (const phrase of BLIND_PHRASES) {
      for (const match of doc.text.matchAll(phrase)) {
        const lineIndex = lineOf(doc.text, match.index ?? 0);
        if (seen.has(lineIndex)) continue;
        if (M19_OR_ADR014.test(unitAt(doc.text, lineIndex))) continue;
        seen.add(lineIndex);
        const quoted = (match[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        push(out, 'D5', doc, lineIndex, `"${quoted}" is not tied to M19 or ADR-014`);
      }
    }
  }
  return out;
}

// ──────────────────────────────────── D6: claimed tests ────────────────────────────────────

const TEST_CLAIM: readonly RegExp[] = [
  /\b(?:a|an|the|this|one)\s+(?:test|suite|spec)\b[^.\n]{0,80}?\b(?:asserts?|proves?|pins?|guarantees?|verifies|feeds)\b/gi,
  /\b(?:checked|defended|backed|proven|pinned|guaranteed)\s+by\s+(?:a\s+|the\s+)?tests?\b/gi,
  /\btests?\s+(?:assert|prove|pin)s?\b/gi,
];

const TEST_PATH = /[\w./-]*(?:\.test\.[tj]sx?|\.spec\.[tj]sx?|Spec\.luau)/g;

/**
 * D6 — a sentence claiming that a test asserts, proves or pins something must be
 * traceable: it carries either a milestone marker or the path of a test file
 * that exists.
 *
 * This is the achievable version of "claimed tests exist", and the limits are
 * worth stating exactly, in a gate whose whole purpose is catching overclaims:
 *
 *   ✓ catches   a claim naming no test at all, in the present tense, with no
 *               milestone — the shape of Promise 4 before anyone wrote the gate,
 *               and of ADR-006's "a test asserts no outbound request…".
 *   ✓ catches   a claim naming a test file that was deleted or renamed.
 *   ✗ cannot    tell whether the test it names asserts what the sentence says.
 *               A path to any real test file satisfies it.
 *   ✗ cannot    see a claim phrased outside the verb set above.
 *   ✗ cannot    distinguish a claim from a description of a claim — a sentence
 *               *about* unbacked test claims satisfies it by citing a real path.
 *
 * It is a traceability gate, not a proof. What it buys is that every such
 * sentence now has somewhere to point, and a reviewer following the pointer
 * finds a file rather than a belief.
 */
export function checkClaimedTests(docs: readonly Doc[], facts: RepoFacts): Violation[] {
  const out: Violation[] = [];
  for (const doc of docs) {
    const seen = new Set<number>();
    for (const claim of TEST_CLAIM) {
      for (const match of doc.text.matchAll(claim)) {
        const lineIndex = lineOf(doc.text, match.index ?? 0);
        if (seen.has(lineIndex)) continue;
        const unit = unitAt(doc.text, lineIndex);
        if (carriesMilestone(unit)) continue;
        const cited = [...unit.matchAll(TEST_PATH)]
          .map((m) => (m[0] ?? '').replace(/^[`(]/, ''))
          .some((candidate) =>
            [...facts.testFiles].some((file) => file === candidate || file.endsWith(`/${candidate}`)),
          );
        if (cited) continue;
        seen.add(lineIndex);
        const quoted = (match[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
        push(out, 'D6', doc, lineIndex, `"${quoted}" names no test file and no milestone`);
      }
    }
  }
  return out;
}

// ────────────────────────────────────── D7: bin names ──────────────────────────────────────

/**
 * D7 — a command in a code fence (or on a `$ ` line) whose name belongs to this
 * repository's binary family must match a `bin` entry in some manifest.
 *
 * The family is derived from the workspace scope rather than named here, so it
 * follows a rename. `forgebridge-daemon` is a real bin; a bare `forgebridge` is
 * the M28 CLI, and the README is right to mark it.
 *
 * What it cannot do: it only reads runnable-looking lines — fenced commands and
 * `$ ` lines. An inline `` `forgebridge daemon` `` in a prose sentence or a table
 * cell is not checked, because inline code is used for names as often as for
 * invocations and the false-positive rate would make the gate noise.
 *
 * A trailing colon is stripped before the manifest is consulted, because a
 * fenced block just as often holds a binary's *output* as its invocation, and
 * that output is prefixed `forgebridge-mcp: …`. No `bin` entry can end in a
 * colon, so without the strip such a line could never satisfy the rule however
 * the binary was named — a rule nothing can pass is a rule someone deletes.
 * Stripping rather than skipping keeps the gate's reach over that output: a
 * transcript of what `forgebridge-relay` prints still fails while there is no
 * `forgebridge-relay`, which is the claim worth catching in a sample.
 */
export function checkBinNames(docs: readonly Doc[], facts: RepoFacts): Violation[] {
  const out: Violation[] = [];
  if (!facts.binPrefix) return out;
  for (const doc of docs) {
    const lines = doc.text.split('\n');
    const fenced = fencedLines(doc.text);
    lines.forEach((line, lineIndex) => {
      const dollar = /^\s*\$\s+/.test(line);
      if (!fenced[lineIndex] && !dollar) return;
      const tokens = line.replace(/^\s*\$\s+/, '').trim().split(/\s+/);
      let head = tokens[0] ?? '';
      if (head === 'npx' || head === 'sudo' || head === 'bunx' || head === 'pnpm') head = tokens[1] ?? '';
      head = head.replace(/:$/, '');
      if (head !== facts.binPrefix && !head.startsWith(`${facts.binPrefix}-`)) return;
      if (facts.binNames.has(head)) return;
      if (carriesMilestone(unitAt(doc.text, lineIndex))) return;
      push(out, 'D7', doc, lineIndex, `\`${head}\` is not a bin entry in any manifest`);
    });
  }
  return out;
}

/** Every rule, for a single report over the whole tree. */
export function checkAll(docs: readonly Doc[], facts: RepoFacts, root: string): Violation[] {
  const readOr = (rel: string): string => {
    const abs = path.join(root, rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : '';
  };
  return [
    ...checkPackageExistence(docs, facts),
    ...checkCiToolClaims(docs, facts),
    ...checkNpmScripts(docs, facts),
    ...checkVerifyGateCoverage(facts, readOr('CONTRIBUTING.md'), readOr('.github/workflows/ci.yml')),
    ...checkBlindRelayClaims(docs),
    ...checkClaimedTests(docs, facts),
    ...checkBinNames(docs, facts),
  ];
}
