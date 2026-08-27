/**
 * `docs/ROADMAP.md`, generated from `docs/MILESTONES.md`.
 *
 * M50 asks for a public roadmap, and asks for it to be generated rather than
 * hand-maintained, for a reason this repository has already demonstrated four
 * times: a hand-maintained restatement of a fact goes stale, and it goes stale
 * silently, because nothing reads it. `docs/MILESTONES.md`'s own header records
 * two of those — a test count that read 311 when the suite had 313, and a model
 * count that read 417 for a day after upstream dropped one.
 *
 * So the roadmap is a projection, `npm run generate:roadmap` writes it, and
 * `scripts/__tests__/roadmap.test.ts` regenerates it in memory and fails when
 * the committed file differs. Same shape as `verify:schemas` over the protocol.
 *
 * ── What it deliberately does not copy ───────────────────────────────────────
 *
 * Any of the prose. Each milestone's "definition of done" cell is several
 * hundred words of carefully qualified claims, and a generator that truncated
 * one to fit a roadmap table would turn *"Partial — the i18n half is done and
 * gated; the accessibility half is designed but unaudited"* into *"the i18n
 * half is done"*. Copying a claim badly is worse than linking to it, so the
 * roadmap carries the identifier, the title, the status and a link, and sends
 * the reader to the row for the rest.
 *
 * That also keeps this gate quiet. The only edits to `MILESTONES.md` that
 * change the roadmap are the ones that change what is *shipped* — which is the
 * only thing a roadmap is for.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = 'docs/MILESTONES.md';
export const TARGET = 'docs/ROADMAP.md';

export type Status = 'shipped' | 'in progress' | 'not started' | 'planned';

export interface Milestone {
  /** `M07`, `M04b`. */
  id: string;
  title: string;
  status: Status;
}

export interface Phase {
  /** The heading text after `## `, e.g. `Phase 3 — Models, providers, routing (M20–M25)`. */
  heading: string;
  milestones: Milestone[];
}

/**
 * Split a markdown table row into its cells.
 *
 * Escaped pipes inside a cell (`\|`) are respected, because a definition-of-done
 * cell that quotes a shell pipeline would otherwise gain a column and shift
 * every field after it.
 */
export function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    const character = row[i];
    if (character === '\\' && row[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  // A markdown row starts and ends with a pipe, so the first and last cells are
  // the empty strings either side of them.
  return cells.slice(1, -1).map((cell) => cell.trim());
}

/**
 * Which status a row is in.
 *
 * The `✅` in the identifier cell is the only *positive* signal, and it is the
 * one `MILESTONES.md`'s own status legend defines. Everything else is read from
 * how the row describes itself, and anything that says nothing recognisable
 * falls through to `planned` — which is the conservative answer: a roadmap that
 * guesses "in progress" from silence is a roadmap that overstates.
 */
export function statusOf(idCell: string, definition: string): Status {
  if (idCell.includes('✅')) return 'shipped';
  if (/\bnot started\b/i.test(definition)) return 'not started';
  if (/\bpartial\b/i.test(definition)) return 'in progress';
  return 'planned';
}

const ID = /^\*{0,2}(M\d{2}[a-z]?)\*{0,2}/;

export function parseMilestones(source: string): Phase[] {
  const phases: Phase[] = [];
  let current: Phase | null = null;

  for (const line of source.split('\n')) {
    const heading = /^##\s+(Phase\s.+)$/.exec(line);
    if (heading?.[1]) {
      current = { heading: heading[1].trim(), milestones: [] };
      phases.push(current);
      continue;
    }
    if (current === null || !/^\s*\|/.test(line)) continue;

    const cells = tableCells(line);
    if (cells.length < 4) continue;
    const id = ID.exec(cells[0] ?? '')?.[1];
    if (id === undefined) continue;

    current.milestones.push({
      id,
      title: stripMarkdown(cells[1] ?? ''),
      status: statusOf(cells[0] ?? '', cells[3] ?? ''),
    });
  }

  // A phase heading with no rows under it is dropped rather than rendered
  // empty: the source has prose sections between tables, and an empty phase in
  // a roadmap reads as a phase with nothing planned.
  return phases.filter((phase) => phase.milestones.length > 0);
}

/** Inline markdown a roadmap table does not need. Links keep their text. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .trim();
}

const STATUS_MARK: Record<Status, string> = {
  shipped: '✅ shipped',
  'in progress': '◐ in progress',
  'not started': '· not started',
  planned: '· planned',
};

export function render(phases: readonly Phase[]): string {
  const all = phases.flatMap((phase) => phase.milestones);
  const count = (status: Status): number => all.filter((m) => m.status === status).length;

  const lines: string[] = [
    '<!--',
    '  GENERATED FILE — DO NOT EDIT.',
    '',
    `  Written by scripts/roadmap.ts from ${SOURCE}. Run \`npm run generate:roadmap\``,
    '  after editing that file. `scripts/__tests__/roadmap.test.ts` regenerates this',
    '  in memory and fails when the two disagree, so an edit here is reverted by the',
    '  next run and an edit there without a run is a red build.',
    '-->',
    '',
    '# Roadmap',
    '',
    `Generated from [\`MILESTONES.md\`](MILESTONES.md), which is the source of truth and`,
    'says, for every row below, exactly what it still owes. This page is the shape of',
    'the whole thing at a glance; that file is the detail, and nothing here paraphrases',
    'it — a summary of a carefully qualified claim is usually a stronger claim.',
    '',
    '| | |',
    '|---|---|',
    `| ✅ shipped | ${count('shipped')} |`,
    `| ◐ in progress | ${count('in progress')} |`,
    `| · not started or planned | ${count('not started') + count('planned')} |`,
    `| **total** | **${all.length}** |`,
    '',
    '“Shipped” means the row carries a ✅ in `MILESTONES.md`, and every ✅ there was put',
    'there against a check that was run. It does not mean the area is finished: several',
    'shipped rows name what they still owe in their own text. Follow the link.',
    '',
    '## Where to start',
    '',
    'Issues labelled **`good first issue`** are ones a first-time contributor can finish',
    'without reading the whole tree. [`COMMUNITY.md`](COMMUNITY.md) says what that label',
    'means here, what the other labels mean, and what the path from a first patch to a',
    'maintainer looks like.',
    '',
  ];

  for (const phase of phases) {
    lines.push(`## ${phase.heading}`, '', '| Milestone | | Status |', '|---|---|---|');
    for (const milestone of phase.milestones) {
      lines.push(
        `| [\`${milestone.id}\`](MILESTONES.md) | ${milestone.title} | ${STATUS_MARK[milestone.status]} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function generate(root: string = ROOT): string {
  const source = path.join(root, SOURCE);
  if (!existsSync(source)) {
    // Fail closed. A generator that writes an empty roadmap when it cannot find
    // its source has produced a document that says "nothing is planned".
    throw new Error(`roadmap: ${SOURCE} is missing, so there is nothing to generate from`);
  }
  const phases = parseMilestones(readFileSync(source, 'utf8'));
  if (phases.length === 0) {
    throw new Error(`roadmap: no milestone rows were found in ${SOURCE} — the table format may have changed`);
  }
  return render(phases);
}

/* c8 ignore start -- the process shim. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const rendered = generate();
  const target = path.join(ROOT, TARGET);
  // Read and handle the failure, rather than `existsSync` then read: the two
  // calls are a check-then-use race (`js/file-system-race`), and "absent" and
  // "unreadable" want the same answer here anyway — there is nothing to compare
  // against, so the file is stale.
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    existing = '';
  }
  if (process.argv.includes('--check')) {
    if (existing !== rendered) {
      process.stderr.write(`roadmap: ${TARGET} is stale. Run \`npm run generate:roadmap\`.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`roadmap: ${TARGET} is current.\n`);
    }
  } else {
    writeFileSync(target, rendered, 'utf8');
    process.stdout.write(`roadmap: wrote ${TARGET}\n`);
  }
}
/* c8 ignore stop */
