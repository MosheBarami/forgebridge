/**
 * The mechanically decidable half of `docs/MILESTONES.md`.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 *
 * `scripts/__tests__/docs-claims.test.ts` and `scripts/docs-claims-rules.ts`
 * already read every markdown file in the repository, and they are good at it.
 * They cannot, however, decide this one, and the reason is structural rather
 * than an oversight:
 *
 *   D1, D3 and D6 each end the same way — find a claim, check it against the
 *   tree, and **accept it anyway if the surrounding unit carries a milestone
 *   marker**, because `(M26)` means "planned", not "lying". `unitAt` makes a
 *   table row its own unit. Every row of `docs/MILESTONES.md` opens with `| M07`.
 *
 * So the exemption that is exactly right for a README sentence promising
 * `packages/opencloud` at M48 is unconditionally satisfied by every line of the
 * document whose entire job is to say which of those promises have been kept.
 * That is not a hypothesis: `the existing gate cannot see a milestone row` below
 * plants an imaginary package, an imaginary npm script and an imaginary test
 * file in one row, shows D1, D3 and D6 report nothing, and shows the same two
 * claims reported immediately when they appear in an ordinary paragraph.
 *
 * ── What this file adds, and what it deliberately does not duplicate ─────────
 *
 * The rules below re-decide the same kinds of claim **without** the milestone
 * exemption, and only for rows that carry the ✅ — because for a done row the id
 * is not a promise about the future, it is a claim about today. A row without a
 * tick may name whatever it is going to build.
 *
 * D9 (`checkCitedTodos`) has no milestone exemption and therefore already
 * reaches this document. So C6 **calls it** rather than reimplementing it; what
 * this file adds there is only the scoping and a self-test proving the
 * delegation is live, since a delegation nobody exercises is the same decoration
 * as a gate that cannot fail.
 *
 * ── The shape every rule takes ───────────────────────────────────────────────
 *
 *     parse the table into rows, decide one property of one row against the
 *     tree, and return a violation naming the row and the fact that refuted it.
 *
 * Every rule is a pure function over (rows, facts) so a self-test can hand it a
 * planted violation and prove it rejects it — and every planted violation is
 * paired with a CONTROL: the closest legitimate shape, proved to pass. A
 * fail-closed rule that fires on correct input is not a stricter gate, it is a
 * broken one, and this repository has already paid for learning that once.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  type Doc,
  type RepoFacts,
  checkCitedTodos,
  checkClaimedTests,
  checkNpmScripts,
  checkPackageExistence,
  collectDocs,
  collectRepoFacts,
  resolveCitedPath,
} from '../docs-claims-rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MILESTONES_PATH = 'docs/MILESTONES.md';

const facts: RepoFacts = collectRepoFacts(ROOT);
const MILESTONES = readFileSync(path.join(ROOT, MILESTONES_PATH), 'utf8');

// ────────────────────────────────── the table ──────────────────────────────────

export interface Violation {
  /** Rule id, matching a describe block below, so a failure is greppable. */
  rule: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9';
  /** Milestone id, or the document region, the violation belongs to. */
  where: string;
  detail: string;
}

export interface Row {
  /** `M07`, `M04b`. Never carries the tick. */
  id: string;
  /** The row claims this milestone is finished in this tree. */
  ticked: boolean;
  /** Exactly what the `#` cell said, tick included. Checked by C1. */
  idCell: string;
  title: string;
  /** Predecessor status: NEW | PART | DEL. Provenance, not a claim about today. */
  was: string;
  /** The definition-of-done cell, which is where every checkable claim lives. */
  dod: string;
  /** Number of cells the row actually parsed into. 4 is the only right answer. */
  cells: number;
  /** 1-indexed. */
  line: number;
}

/**
 * Rows, in document order.
 *
 * Deliberately keyed off `^|` plus an `M`-shaped first cell rather than off the
 * section headings: a row moved into the wrong phase is still a row, and C1
 * catches ordering separately. Splitting on a bare `|` also means a cell that
 * contains an unescaped pipe parses into more than four cells — which is not a
 * parser weakness to work around but the defect C1 reports, because a Markdown
 * renderer will do exactly the same thing and silently shred the row.
 */
export function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((line, index) => {
    if (!/^\|\s*M\d{2}/.test(line)) return;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const idCell = cells[0] ?? '';
    rows.push({
      id: (idCell.match(/^M\d{2}[a-z]?/) ?? [''])[0],
      ticked: idCell.includes('✅'),
      idCell,
      title: cells[1] ?? '',
      was: cells[2] ?? '',
      dod: cells[3] ?? '',
      cells: cells.length,
      line: index + 1,
    });
  });
  return rows;
}

const ROWS = parseRows(MILESTONES);

/** One row, built for a self-test. Everything not named is deliberately valid. */
function row(over: Partial<Row> = {}): Row {
  return {
    id: 'M07',
    ticked: true,
    idCell: 'M07 ✅',
    title: 'a milestone',
    was: 'NEW',
    dod: 'Built and pinned.',
    cells: 4,
    line: 1,
    ...over,
  };
}

const report = (violations: readonly Violation[]): string =>
  violations.map((v) => `${v.rule} ${v.where} — ${v.detail}`).join('\n');

// ─────────────────────── C1: the table is shaped like a table ───────────────────────

/** The whole id vocabulary. `M04b` is the one lowercase-suffixed row. */
const EXPECTED_IDS: readonly string[] = [
  'M01', 'M02', 'M03', 'M04', 'M04b',
  ...Array.from({ length: 46 }, (_, i) => `M${String(i + 5).padStart(2, '0')}`),
];

const ID_CELL = /^M\d{2}[a-z]?(?: ✅)?$/;
const WAS_VALUES = new Set(['NEW', 'PART', 'DEL']);

/**
 * C1 — every row parses into four cells, the id cell carries an id and at most a
 * tick, and the `Was` cell is one of three words.
 *
 * Written because the id cell had become a second, undocumented status channel.
 * `M31`'s read `M31 PART`, which is neither an id nor a status but both at once,
 * and `M06`'s definition of done contained an unescaped shell alternation that
 * split its row into seven cells in every renderer. Neither was catchable by
 * anything, because nothing had ever tried to parse this table.
 */
export function checkRowShape(rows: readonly Row[]): Violation[] {
  const out: Violation[] = [];
  const seen = new Map<string, number>();

  for (const r of rows) {
    if (r.cells !== 4) {
      out.push({
        rule: 'C1',
        where: r.id || `line ${r.line}`,
        detail: `parses into ${r.cells} cells, not 4 — an unescaped | in a cell shreds the row in every renderer`,
      });
    }
    if (!ID_CELL.test(r.idCell)) {
      out.push({
        rule: 'C1',
        where: r.id || `line ${r.line}`,
        detail: `id cell is "${r.idCell}"; it may carry an id and, if the work is done here, a ✅ — nothing else`,
      });
    }
    if (!WAS_VALUES.has(r.was)) {
      out.push({
        rule: 'C1',
        where: r.id || `line ${r.line}`,
        detail: `Was is "${r.was}"; the predecessor status is NEW, PART or DEL`,
      });
    }
    const first = seen.get(r.id);
    if (first !== undefined) {
      out.push({ rule: 'C1', where: r.id, detail: `appears twice, at lines ${first} and ${r.line}` });
    } else {
      seen.set(r.id, r.line);
    }
  }

  const ids = rows.map((r) => r.id);
  for (const expected of EXPECTED_IDS) {
    if (!seen.has(expected)) out.push({ rule: 'C1', where: expected, detail: 'has no row' });
  }
  for (const id of ids) {
    if (!EXPECTED_IDS.includes(id)) out.push({ rule: 'C1', where: id, detail: 'is not one of the 50 milestones' });
  }
  const inOrder = ids.filter((id) => EXPECTED_IDS.includes(id));
  const sorted = [...inOrder].sort((a, b) => EXPECTED_IDS.indexOf(a) - EXPECTED_IDS.indexOf(b));
  if (inOrder.join(',') !== sorted.join(',')) {
    out.push({ rule: 'C1', where: 'table', detail: 'rows are not in ascending milestone order' });
  }
  return out;
}

// ───────────────────── C2: done and not-done are said, not inferred ─────────────────────

const NOT_DONE_OPENERS = ['**Partial —**', '**Not started —**', '**Removed —**'];

/**
 * C2 — an unticked row opens its definition of done by saying which kind of
 * unfinished it is; a ticked row does not contradict its own tick.
 *
 * The defect: `M17` carried a ✅ **and** the sentence "Still `PART`", so the
 * document asserted both that the milestone was complete and that it was not,
 * and a reader had no way to decide which. Counting ticks is also how the count
 * in the live-status paragraph is produced, so a row that hedges in prose while
 * carrying a tick corrupts a number too.
 *
 * The second half is deliberately narrow — the literal tokens a hedge was
 * written with — because a ticked row is *expected* to discuss what it does not
 * cover, and often should. `M40`'s row says "**Not done**:" about work it
 * correctly assigns elsewhere, and must keep passing.
 */
export function checkStateWord(rows: readonly Row[]): Violation[] {
  const out: Violation[] = [];
  for (const r of rows) {
    const opens = NOT_DONE_OPENERS.some((opener) => r.dod.startsWith(opener));
    if (!r.ticked && !opens) {
      out.push({
        rule: 'C2',
        where: r.id,
        detail: `has no ✅, so its definition of done must open with one of ${NOT_DONE_OPENERS.join(', ')} — it opens "${r.dod.slice(0, 40)}…"`,
      });
    }
    if (r.ticked && opens) {
      out.push({ rule: 'C2', where: r.id, detail: 'carries a ✅ and opens by saying it is unfinished' });
    }
    if (r.ticked && /Still `?(PART|partial)`?/.test(r.dod)) {
      out.push({
        rule: 'C2',
        where: r.id,
        detail: 'carries a ✅ and says it is still partial — a reader cannot resolve that, and the done count cannot either',
      });
    }
  }
  return out;
}

// ───────────────────────── C3: a done row's packages exist ─────────────────────────

const WORKSPACE_REF = /(packages|apps)\/([a-z0-9][a-z0-9-]*)/g;

/**
 * C3 — every `packages/x` or `apps/x` a **done** row names is a real workspace.
 *
 * D1 asks the same question of every document and forgives it here. It also asks
 * only about `packages/`, since it exists to answer "is this a package?"; a done
 * row citing `apps/relay` is making the identical claim about a directory that
 * happens to live one level over, so this rule crosses that line.
 */
export function checkDonePackages(rows: readonly Row[], repo: RepoFacts): Violation[] {
  const out: Violation[] = [];
  for (const r of rows) {
    if (!r.ticked) continue;
    for (const match of `${r.title} ${r.dod}`.matchAll(WORKSPACE_REF)) {
      const dir = `${match[1]}/${match[2]}`;
      if (repo.workspaceDirs.has(dir)) continue;
      out.push({ rule: 'C3', where: r.id, detail: `is marked done and names ${dir}, which is not a workspace in this tree` });
    }
  }
  return out;
}

// ──────────────────────── C4: a done row's npm scripts exist ────────────────────────

export function checkDoneScripts(rows: readonly Row[], repo: RepoFacts): Violation[] {
  const out: Violation[] = [];
  for (const r of rows) {
    if (!r.ticked) continue;
    for (const match of r.dod.matchAll(/npm run ([a-zA-Z][a-zA-Z0-9:_-]*)/g)) {
      const script = match[1] ?? '';
      if (repo.npmScripts.has(script)) continue;
      out.push({ rule: 'C4', where: r.id, detail: `is marked done and cites \`npm run ${script}\`, which no manifest declares` });
    }
  }
  return out;
}

// ───────────────────────── C5: a done row's cited files exist ─────────────────────────

/**
 * A backticked token this rule is willing to treat as a path.
 *
 * Restricted to the extensions `RepoFacts.sourceFiles` actually collects, which
 * keeps three families of false positive out by construction: schema and
 * workflow files (`openapi.json`, `ci.yml`) that are cited constantly and are
 * not source; model ids, which are slash-separated and extensionless
 * (`z-ai/glm-5.2:free`); and property paths (`run.attempts`), whose suffix is
 * not a source extension.
 */
const CITED_SOURCE = /^[\w][\w./-]*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|luau|py)$/;

/**
 * C5 — every source file a **done** row points at is in the tree.
 *
 * Existence only, not uniqueness: a done row is allowed to write
 * `test/conformance.test.ts` for the three connectors that each carry one, and
 * naming three files is not the failure. Naming zero is — it is the shape a row
 * takes after the file it cited as evidence was renamed or deleted, which is
 * precisely when a stale tick is most convincing.
 */
export function checkDoneFiles(rows: readonly Row[], repo: RepoFacts): Violation[] {
  const out: Violation[] = [];
  for (const r of rows) {
    if (!r.ticked) continue;
    for (const match of r.dod.matchAll(/`([^`\n]+)`/g)) {
      const cited = match[1] ?? '';
      if (!CITED_SOURCE.test(cited)) continue;
      if (resolveCitedPath(cited, MILESTONES_PATH, repo).length > 0) continue;
      out.push({ rule: 'C5', where: r.id, detail: `is marked done and offers \`${cited}\` as evidence; no such file is in the tree` });
    }
  }
  return out;
}

// ───────────────────────── C6: cited TODO markers, via D9 ─────────────────────────

/**
 * C6 — a row quoting a `TODO(Mxx)` in a named file must find it there.
 *
 * This is D9, called rather than copied. It has no milestone exemption, so it
 * already reaches this document; what is added here is the scope and the
 * self-test below, which plants a stale citation and proves the delegation
 * actually runs. The rule earns its place on this table more than anywhere else:
 * a done row's most common failure mode is citing, as a live blocker, a marker
 * the milestone that closed it already deleted.
 */
export function checkCitedMarkers(doc: Doc, repo: RepoFacts, readSource: (rel: string) => string): Violation[] {
  return checkCitedTodos([doc], repo, readSource).map((v) => ({
    rule: 'C6' as const,
    where: `${v.file}:${v.line}`,
    detail: v.detail,
  }));
}

// ──────────────── C7 / C8: the live-status paragraphs are counted, not remembered ────────────────

/** The paragraph a reader trusts for "what is in this repository today". */
export function paragraphStartingWith(text: string, opener: string): string | null {
  return text.split(/\n\s*\n/).find((block) => block.trimStart().startsWith(opener)) ?? null;
}

/**
 * C7 — the live-status paragraph names every workspace in the tree, and no
 * others.
 *
 * Both directions, for the reason the README's layout table is checked both
 * ways: a workspace the paragraph forgot is a package a reader does not know
 * exists, and a workspace it names that was deleted is worse, because it reads
 * as evidence. This is what caught the paragraph claiming ten TypeScript
 * packages while thirteen directories under `packages/` carried a manifest.
 */
export function checkLiveStatusWorkspaces(text: string, repo: RepoFacts): Violation[] {
  const para = paragraphStartingWith(text, '**Live status,');
  if (para === null) {
    return [{ rule: 'C7', where: 'live status', detail: 'no paragraph opens with "**Live status," — the workspace list cannot be checked' }];
  }
  const named = new Set([...para.matchAll(WORKSPACE_REF)].map((m) => `${m[1]}/${m[2]}`));
  const out: Violation[] = [];
  for (const dir of repo.workspaceDirs) {
    if (!named.has(dir)) out.push({ rule: 'C7', where: 'live status', detail: `${dir} has a manifest and the paragraph does not name it` });
  }
  for (const dir of named) {
    if (!repo.workspaceDirs.has(dir)) out.push({ rule: 'C7', where: 'live status', detail: `the paragraph names ${dir}, which has no manifest in this tree` });
  }
  return out;
}

export interface CatalogFigures {
  catalogTotal: number;
  free: number;
  excluded: number;
}

/**
 * C8 — the three catalog figures match `catalog.json`.
 *
 * Each is matched on its own phrase rather than on position, so reordering the
 * sentence cannot silently swap two numbers. The paragraph also recounts that it
 * used to say 417; that sentence is history, it matches none of these phrases,
 * and it is meant to survive.
 *
 * This is the drift it exists for: the very first sync saw 417 models, upstream
 * dropped one within a day, `scripts/sync-catalog.ts` records in its own header
 * that this happened, and the sentence in `MILESTONES` went on saying 417 for as
 * long as nothing read it.
 */
export function checkCatalogFigures(text: string, actual: CatalogFigures): Violation[] {
  const stated = (pattern: RegExp): number | null => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const claims: readonly [string, number | null, number][] = [
    // `\s+` rather than a literal space: these sentences are hard-wrapped, and a
    // reflow that put the number at the end of one line and its noun at the start
    // of the next would otherwise report "no sentence states this figure" — a
    // gate failing on a document that had not changed meaning at all.
    ['models upstream', stated(/(\d+)\s+models upstream/), actual.catalogTotal],
    ['free and tool-capable', stated(/(\d+)\s+free and tool-capable/), actual.free],
    ['excluded', stated(/(\d+)\s+excluded with stated reasons/), actual.excluded],
  ];
  const out: Violation[] = [];
  for (const [label, said, real] of claims) {
    if (said === null) {
      out.push({ rule: 'C8', where: 'catalog figures', detail: `no sentence states the "${label}" figure any more` });
    } else if (said !== real) {
      out.push({ rule: 'C8', where: 'catalog figures', detail: `says ${said} ${label}; catalog.json has ${real}` });
    }
  }
  return out;
}

// ─────────────── C9: no other document contradicts a row's recorded status ───────────────

const STATUS_CITATION = /\bM(\d{2}[a-z]?) is status ([A-Z]+)\b/g;

/**
 * C9 — a document that quotes a milestone's status must quote the one the table
 * records.
 *
 * `docs/THREAT-MODEL.md` says "M45 is status NEW in `MILESTONES.md`". That is a
 * transcription of the `Was` column into a second file, and a transcription is a
 * copy that drifts. Pinned in both directions so that a row's `Was` cell and
 * every sentence quoting it move together or not at all.
 */
export function checkStatusCitations(docs: readonly Doc[], rows: readonly Row[]): Violation[] {
  const was = new Map(rows.map((r) => [r.id, r.was]));
  const out: Violation[] = [];
  for (const doc of docs) {
    if (doc.path === MILESTONES_PATH) continue;
    for (const match of doc.text.matchAll(STATUS_CITATION)) {
      const id = `M${match[1]}`;
      const quoted = match[2] ?? '';
      const recorded = was.get(id);
      if (recorded === undefined) {
        out.push({ rule: 'C9', where: doc.path, detail: `quotes a status for ${id}, which has no row` });
      } else if (recorded !== quoted) {
        out.push({ rule: 'C9', where: doc.path, detail: `says ${id} is status ${quoted}; its row records ${recorded}` });
      }
    }
  }
  return out;
}

// ══════════════════════════════════ the gate ══════════════════════════════════

describe('the existing gate cannot see a milestone row', () => {
  // The justification for every rule above, stated as a test rather than as a
  // paragraph, because "the other gate does not cover this" is a claim about the
  // tree and this repository does not accept those without evidence.
  //
  // If this test ever fails it is good news and this file should shrink: it
  // would mean D1/D3/D6 grew a way to decide a milestone row, and the rules here
  // that duplicate them should be deleted rather than left as a second opinion.
  const claim = 'Built in `packages/imaginary`, run with `npm run imaginary:gate`, pinned by `packages/imaginary/test/nope.test.ts`';
  const asRow: Doc[] = [{
    path: MILESTONES_PATH,
    text: `| # | Milestone | Was | Definition of done |\n|---|---|---|---|\n| M07 ✅ | protocol | NEW | ${claim} |\n`,
  }];
  const asProse: Doc[] = [{ path: 'README.md', text: `${claim}\n` }];

  it('reports nothing for an imaginary package, script and test inside a row', () => {
    expect(checkPackageExistence(asRow, facts)).toHaveLength(0);
    expect(checkNpmScripts(asRow, facts)).toHaveLength(0);
    expect(checkClaimedTests(asRow, facts)).toHaveLength(0);
  });

  it('reports the same claims immediately when they are an ordinary sentence', () => {
    // Same words, same tree, no table row around them. The difference is the
    // milestone exemption and nothing else.
    expect(checkPackageExistence(asProse, facts).length).toBeGreaterThan(0);
    expect(checkNpmScripts(asProse, facts).length).toBeGreaterThan(0);
  });
});

describe('the table parses', () => {
  it('finds all fifty rows plus M04b', () => {
    expect(ROWS.map((r) => r.id)).toEqual([...EXPECTED_IDS]);
  });

  it('reads the tick off the id cell and nothing else', () => {
    const m07 = ROWS.find((r) => r.id === 'M07');
    expect(m07?.ticked).toBe(true);
    expect(m07?.was).toBe('NEW');
  });
});

describe('C1 — the table is shaped like a table', () => {
  it('passes on the real document', () => {
    expect(report(checkRowShape(ROWS))).toBe('');
  });

  it('rejects a status word smuggled into the id cell', () => {
    // The real defect: `M31`'s id cell read `M31 PART`.
    expect(report(checkRowShape([row({ id: 'M31', idCell: 'M31 PART' })]))).toContain('C1 M31');
  });

  it('rejects a row an unescaped pipe has shredded', () => {
    // The real defect: M06 quoted a shell alternation and became seven cells.
    expect(report(checkRowShape([row({ cells: 7 })]))).toContain('not 4');
  });

  it('rejects a Was cell that is not one of the three predecessor states', () => {
    expect(report(checkRowShape([row({ was: 'DONE' })]))).toContain('predecessor status');
  });

  it('rejects a duplicated id, a missing row and a row out of order', () => {
    expect(report(checkRowShape([row({ id: 'M07' }), row({ id: 'M07', line: 9 })]))).toContain('appears twice');
    expect(report(checkRowShape([]))).toContain('M07 — has no row');
    const swapped = [row({ id: 'M09', idCell: 'M09' }), row({ id: 'M08', idCell: 'M08', line: 2 })];
    expect(report(checkRowShape(swapped))).toContain('ascending milestone order');
  });

  it('CONTROL: accepts a bare id, a ticked id, and the lowercase-suffixed row', () => {
    // The three legitimate id cells. A rule that could not tell `M04b` from
    // `M31 PART` would be the fail-noisy version of this one.
    const legitimate = [
      row({ id: 'M04', idCell: 'M04' }),
      row({ id: 'M04b', idCell: 'M04b', line: 2 }),
      row({ id: 'M07', idCell: 'M07 ✅', line: 3 }),
    ];
    expect(checkRowShape(legitimate).filter((v) => !v.detail.includes('has no row'))).toEqual([]);
  });
});

describe('C2 — done and not-done are said, not inferred', () => {
  it('passes on the real document', () => {
    expect(report(checkStateWord(ROWS))).toBe('');
  });

  it('rejects an unticked row that does not say which kind of unfinished it is', () => {
    const hedged = row({ id: 'M22', ticked: false, idCell: 'M22', dod: 'Selector exists; broaden to the full adapter set.' });
    expect(report(checkStateWord([hedged]))).toContain('C2 M22');
  });

  it('rejects a ticked row that says it is still partial', () => {
    // The real defect: M17 carried ✅ and the sentence "Still `PART`".
    expect(report(checkStateWord([row({ id: 'M17', dod: 'Built. **Still `PART`**: state is in memory only.' })])))
      .toContain('cannot resolve that');
  });

  it('rejects a ticked row that opens by calling itself partial', () => {
    expect(report(checkStateWord([row({ dod: '**Partial —** most of it is there.' })]))).toContain('unfinished');
  });

  it('CONTROL: a ticked row may say at length what it does not cover', () => {
    // M40's real shape, and the reason the second half of this rule matches
    // literal hedge tokens rather than the idea of a caveat. A done row naming
    // the work it correctly assigns elsewhere is the honest kind of row, not the
    // dishonest one, and must never be what this gate fires on.
    const honest = row({
      id: 'M40',
      dod: 'Half done, and the row says which half. **Done**: two adapters over `node:sqlite`. **Not done**: `storage-supabase` does not exist, and nothing constructs either adapter yet.',
    });
    expect(checkStateWord([honest])).toEqual([]);
  });

  it('CONTROL: an unticked row opens with any of the three openers', () => {
    for (const opener of NOT_DONE_OPENERS) {
      expect(checkStateWord([row({ ticked: false, idCell: 'M22', dod: `${opener} the rest is owed.` })])).toEqual([]);
    }
  });
});

describe('C3 — a done row names packages that exist', () => {
  it('passes on the real document', () => {
    expect(report(checkDonePackages(ROWS, facts))).toBe('');
  });

  it('rejects a done row naming a package that is not in the tree', () => {
    expect(report(checkDonePackages([row({ dod: 'Shipped in `packages/imaginary`.' })], facts)))
      .toContain('not a workspace');
  });

  it('rejects a done row naming an app that is not in the tree', () => {
    // D1 would not ask this question even without the exemption: it is scoped to
    // `packages/`, and `apps/web` is not `packages/web`.
    expect(report(checkDonePackages([row({ dod: 'Deployed from `apps/console`.' })], facts)))
      .toContain('apps/console');
  });

  it('CONTROL: an UNTICKED row may name a package it is going to build', () => {
    // This is the whole reason the milestone exemption exists in D1, preserved
    // here by scoping to done rows rather than by pattern-matching prose.
    const planned = row({ id: 'M48', ticked: false, idCell: 'M48', dod: '**Not started —** `packages/opencloud`; publish-from-CLI works end to end.' });
    expect(checkDonePackages([planned], facts)).toEqual([]);
  });

  it('CONTROL: a done row naming several real workspaces passes', () => {
    expect(checkDonePackages([row({ dod: '`packages/core` over `packages/protocol`, served by `apps/relay`.' })], facts)).toEqual([]);
  });
});

describe('C4 — a done row cites npm scripts that exist', () => {
  it('passes on the real document', () => {
    expect(report(checkDoneScripts(ROWS, facts))).toBe('');
  });

  it('rejects a done row citing a script no manifest declares', () => {
    expect(report(checkDoneScripts([row({ dod: 'Enforced by `npm run verify:imaginary`.' })], facts)))
      .toContain('verify:imaginary');
  });

  it('CONTROL: every verify gate the root manifest really declares passes', () => {
    // Read out of the manifest rather than transcribed, so a renamed gate is
    // caught by the rule instead of quietly agreeing with a stale copy of itself.
    expect(facts.verifyGates.length).toBeGreaterThan(0);
    const citing = facts.verifyGates.map((gate, i) => row({ dod: `Enforced by \`npm run ${gate}\`.`, line: i + 1 }));
    expect(checkDoneScripts(citing, facts)).toEqual([]);
  });
});

describe('C5 — a done row offers evidence that exists', () => {
  it('passes on the real document', () => {
    expect(report(checkDoneFiles(ROWS, facts))).toBe('');
  });

  it('rejects a done row citing a source file that is not in the tree', () => {
    expect(report(checkDoneFiles([row({ dod: 'Pinned by `packages/protocol/test/imaginary.test.ts`.' })], facts)))
      .toContain('no such file');
  });

  it('rejects a bare filename that resolves nowhere', () => {
    expect(report(checkDoneFiles([row({ dod: 'See `nowhere.luau`.' })], facts))).toContain('nowhere.luau');
  });

  it('CONTROL: a relative path that resolves several ways is evidence, not a violation', () => {
    // `test/conformance.test.ts` exists under three connectors and the row means
    // all three. D9 calls that ambiguous because it has to *read* the file;
    // this rule only has to know one exists, so it must not inherit that
    // strictness — that would be a rule firing on the correct document.
    expect(resolveCitedPath('test/conformance.test.ts', MILESTONES_PATH, facts).length).toBeGreaterThan(1);
    expect(checkDoneFiles([row({ dod: 'Conformant via `test/conformance.test.ts`.' })], facts)).toEqual([]);
  });

  it('CONTROL: model ids, property paths and non-source files are not treated as paths', () => {
    // Every one of these is quoted in a real done row. A path detector that took
    // them for filenames would fail the document it was written to defend.
    const quoting = row({
      dod: 'Fell through `z-ai/glm-5.2:free` to `liquid/lfm-2.5-2.6b:free`; `run.attempts` records it; compared against `packages/protocol/schema/openapi.json` by `.github/workflows/ci.yml`.',
    });
    expect(checkDoneFiles([quoting], facts)).toEqual([]);
  });
});

describe('C6 — a cited TODO marker is really in the tree (D9, delegated)', () => {
  const doc: Doc = { path: MILESTONES_PATH, text: MILESTONES };
  const readSource = (rel: string): string => {
    try {
      return readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      return '';
    }
  };

  it('passes on the real document', () => {
    expect(report(checkCitedMarkers(doc, facts, readSource))).toBe('');
  });

  it('rejects a marker the milestone that closed it has already deleted', () => {
    // The exact historical defect: M40 moved the journal-entry methods onto
    // `DaemonStore` and deleted the `TODO(M40)` in `packages/daemon/src/rollback.ts`,
    // and M11's row went on citing it as a live blocker.
    const stale: Doc = {
      path: MILESTONES_PATH,
      text: '| M11 ✅ | journal | NEW | blocked on `TODO(M40)` in `packages/daemon/src/rollback.ts` |\n',
    };
    expect(report(checkCitedMarkers(stale, facts, readSource))).toContain('carries no such marker');
  });

  it('rejects a citation to a file that does not exist', () => {
    const bogus: Doc = { path: MILESTONES_PATH, text: 'see `TODO(M15)` in `plugin/src/Imaginary.luau`\n' };
    expect(report(checkCitedMarkers(bogus, facts, readSource))).toContain('not a file in this repository');
  });

  it('CONTROL: a marker that is really there passes', () => {
    const live: Doc = { path: MILESTONES_PATH, text: 'see `TODO(M15)` in `plugin/src/Journal.luau`\n' };
    expect(readSource('plugin/src/Journal.luau')).toContain('TODO(M15)');
    expect(checkCitedMarkers(live, facts, readSource)).toEqual([]);
  });
});

describe('C7 — the live-status paragraph names every workspace, and only those', () => {
  it('passes on the real document', () => {
    expect(report(checkLiveStatusWorkspaces(MILESTONES, facts))).toBe('');
  });

  it('rejects a paragraph that has fallen behind a package landing', () => {
    // Exactly how this went wrong: the paragraph said ten TypeScript packages
    // and two apps, and stayed that way while three more workspaces landed.
    const short = '**Live status, today** — `packages/protocol` and `apps/web`, and nothing else.\n';
    expect(report(checkLiveStatusWorkspaces(short, facts))).toContain('does not name it');
  });

  it('rejects a paragraph that still names a workspace that was deleted', () => {
    const over = `**Live status, today** — ${[...facts.workspaceDirs].map((d) => `\`${d}\``).join(', ')} and \`packages/removed\`.\n`;
    expect(report(checkLiveStatusWorkspaces(over, facts))).toContain('packages/removed');
  });

  it('rejects the paragraph disappearing entirely', () => {
    expect(report(checkLiveStatusWorkspaces('# nothing here\n', facts))).toContain('cannot be checked');
  });

  it('CONTROL: naming exactly the tree passes, in any order', () => {
    const exact = `**Live status, today** — ${[...facts.workspaceDirs].reverse().map((d) => `\`${d}\``).join(' and ')}.\n`;
    expect(checkLiveStatusWorkspaces(exact, facts)).toEqual([]);
  });
});

describe('C8 — the catalog figures are counted from the catalog', () => {
  interface CatalogFile {
    catalogTotal: number;
    models: readonly unknown[];
    excluded: readonly unknown[];
  }
  const catalog = JSON.parse(
    readFileSync(path.join(ROOT, 'packages/model-registry/data/catalog.json'), 'utf8'),
  ) as CatalogFile;
  const actual: CatalogFigures = {
    catalogTotal: catalog.catalogTotal,
    free: catalog.models.length,
    excluded: catalog.excluded.length,
  };

  it('passes on the real document', () => {
    expect(report(checkCatalogFigures(MILESTONES, actual))).toBe('');
  });

  it('rejects the figure that actually drifted', () => {
    // 417 was true for about a day. `scripts/sync-catalog.ts` records upstream
    // dropping to 416 in its own header, and this sentence said 417 for as long
    // as nothing read it.
    const stale = '417 models upstream, 16 free and tool-capable, 3 excluded with stated reasons.';
    expect(report(checkCatalogFigures(stale, { ...actual, catalogTotal: 416 }))).toContain('says 417');
  });

  it('rejects each of the three figures independently', () => {
    const text = '416 models upstream, 99 free and tool-capable, 99 excluded with stated reasons.';
    const violations = checkCatalogFigures(text, { catalogTotal: 416, free: 16, excluded: 3 });
    expect(violations).toHaveLength(2);
  });

  it('rejects a figure being dropped rather than corrected', () => {
    expect(report(checkCatalogFigures('the catalog is fine', actual))).toContain('no sentence states');
  });

  it('CONTROL: a hard wrap between the number and its noun is not a missing figure', () => {
    const wrapped = '416\nmodels upstream, 16 free and\ntool-capable, 3 excluded with stated reasons.';
    expect(checkCatalogFigures(wrapped, { catalogTotal: 416, free: 16, excluded: 3 }))
      .toEqual([{ rule: 'C8', where: 'catalog figures', detail: 'no sentence states the "free and tool-capable" figure any more' }]);
    // Only the phrase a wrap actually split mid-phrase is lost; the two the wrap
    // fell between number and noun are read. That is the boundary of what `\s+`
    // buys, stated rather than assumed.
  });

  it('CONTROL: the paragraph may recount the number it used to say', () => {
    // The real paragraph explains that it said 417 until this audit. That
    // sentence is history and is meant to survive, so the rule matches the three
    // phrases that assert a present figure and nothing else.
    const withHistory = `${MILESTONES}\n\nIt said 417 for a week and 999 before that.`;
    expect(checkCatalogFigures(withHistory, actual)).toEqual([]);
  });
});

describe('C9 — no other document contradicts a row\'s recorded status', () => {
  const docs = collectDocs(ROOT);

  it('passes on the real tree', () => {
    expect(report(checkStatusCitations(docs, ROWS))).toBe('');
  });

  it('is actually reading a citation rather than finding none', () => {
    // Without this, the assertion above would pass just as happily if the regex
    // matched nothing anywhere — the shape of gate this repository keeps finding.
    const cited = docs.flatMap((d) => (d.path === MILESTONES_PATH ? [] : [...d.text.matchAll(STATUS_CITATION)]));
    expect(cited.length).toBeGreaterThan(0);
  });

  it('rejects a document quoting a status the table does not record', () => {
    const wrong: Doc[] = [{ path: 'docs/THREAT-MODEL.md', text: 'M45 is status DEL in MILESTONES.md.\n' }];
    expect(report(checkStatusCitations(wrong, ROWS))).toContain('its row records NEW');
  });

  it('rejects a document quoting a milestone that has no row', () => {
    const wrong: Doc[] = [{ path: 'docs/THREAT-MODEL.md', text: 'M99 is status NEW.\n' }];
    expect(report(checkStatusCitations(wrong, ROWS))).toContain('has no row');
  });

  it('CONTROL: the citation that is right today passes', () => {
    const right: Doc[] = [{ path: 'docs/THREAT-MODEL.md', text: 'M45 is status NEW in MILESTONES.md.\n' }];
    expect(checkStatusCitations(right, ROWS)).toEqual([]);
  });
});

describe('every rule, against the document as committed', () => {
  // The gate proper. Each rule is asserted individually above so a failure names
  // itself; this is the one that fails if any of them regress together.
  it('reports nothing', () => {
    const readSource = (rel: string): string => {
      try {
        return readFileSync(path.join(ROOT, rel), 'utf8');
      } catch {
        return '';
      }
    };
    const catalog = JSON.parse(
      readFileSync(path.join(ROOT, 'packages/model-registry/data/catalog.json'), 'utf8'),
    ) as { catalogTotal: number; models: unknown[]; excluded: unknown[] };

    const all: Violation[] = [
      ...checkRowShape(ROWS),
      ...checkStateWord(ROWS),
      ...checkDonePackages(ROWS, facts),
      ...checkDoneScripts(ROWS, facts),
      ...checkDoneFiles(ROWS, facts),
      ...checkCitedMarkers({ path: MILESTONES_PATH, text: MILESTONES }, facts, readSource),
      ...checkLiveStatusWorkspaces(MILESTONES, facts),
      ...checkCatalogFigures(MILESTONES, {
        catalogTotal: catalog.catalogTotal,
        free: catalog.models.length,
        excluded: catalog.excluded.length,
      }),
      ...checkStatusCitations(collectDocs(ROOT), ROWS),
    ];
    expect(report(all)).toBe('');
  });
});
