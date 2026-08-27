/**
 * The roadmap is a projection of `docs/MILESTONES.md`, and this is the gate
 * that keeps it one.
 *
 * The failure it exists to stop has happened in this repository four times, in
 * four different documents: a hand-maintained restatement of a fact that went
 * stale silently, because nothing read it. `docs/MILESTONES.md`'s own header
 * records two of them. So the roadmap is generated, and the committed file is
 * regenerated here and compared — the same shape `npm run verify:schemas` uses
 * over the protocol's projections.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TARGET, generate, parseMilestones, render, statusOf, tableCells } from '../roadmap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('the committed roadmap', () => {
  it('is exactly what the generator produces from MILESTONES.md today', () => {
    const committed = readFileSync(path.join(ROOT, TARGET), 'utf8');
    // The message matters as much as the assertion: whoever hits this is
    // editing milestones, not roadmaps, and needs the command rather than a diff.
    expect(committed, `${TARGET} is stale — run \`npm run generate:roadmap\``).toBe(generate(ROOT));
  });

  it('says it is generated, in the file, where an editor will see it', () => {
    const committed = readFileSync(path.join(ROOT, TARGET), 'utf8');
    expect(committed).toContain('GENERATED FILE — DO NOT EDIT');
    expect(committed).toContain('npm run generate:roadmap');
  });

  it('covers every phase in the source and loses no milestone', () => {
    const source = readFileSync(path.join(ROOT, 'docs/MILESTONES.md'), 'utf8');
    const phases = parseMilestones(source);
    const ids = phases.flatMap((phase) => phase.milestones.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    // Every `| Mxx …` row in the source reaches the roadmap. Counted from the
    // source rather than written down here, so the assertion cannot drift.
    const rows = source.split('\n').filter((line) => /^\|\s*\*{0,2}M\d{2}[a-z]?\*{0,2}\s*(✅)?\s*\|/.test(line));
    expect(ids).toHaveLength(rows.length);
  });

  it('copies none of the definition-of-done prose', () => {
    // A summary of a carefully qualified claim is usually a stronger claim.
    // `MILESTONES.md` is full of sentences like "the i18n half is done and
    // gated; the accessibility half is designed but unaudited", and a roadmap
    // that truncated one would publish the first clause on its own.
    const rendered = generate(ROOT);
    expect(rendered).not.toContain('Partial —');
    expect(rendered).not.toContain('Not done:');
    expect(rendered.length).toBeLessThan(readFileSync(path.join(ROOT, 'docs/MILESTONES.md'), 'utf8').length);
  });
});

describe('statusOf', () => {
  it('reads a tick as shipped', () => {
    expect(statusOf('M12 ✅', 'anything')).toBe('shipped');
  });

  it('reads "Partial" as in progress', () => {
    expect(statusOf('M28', '**Partial —** built: daemon, link')).toBe('in progress');
  });

  it('reads "Not started" as not started, even when the row also says partial elsewhere', () => {
    expect(statusOf('M04b', '**Not started —** every workspace lint script is an echo')).toBe('not started');
  });

  it('falls through to planned rather than guessing in progress', () => {
    // The conservative answer. A roadmap that reads silence as progress is a
    // roadmap that overstates, which is the one thing a public roadmap must not do.
    expect(statusOf('M48', 'Publish place versions, DataStore, messaging')).toBe('planned');
  });

  it('a tick beats everything, because the legend says the tick is the claim', () => {
    expect(statusOf('M44 ✅', 'Not done: nothing under plugin/ is instrumented')).toBe('shipped');
  });
});

describe('tableCells', () => {
  it('splits an ordinary row', () => {
    expect(tableCells('| M01 ✅ | Fresh repo | NEW | Decided by X |')).toEqual([
      'M01 ✅',
      'Fresh repo',
      'NEW',
      'Decided by X',
    ]);
  });

  it('respects an escaped pipe, which would otherwise shift every later column', () => {
    expect(tableCells('| M01 | a \\| b | NEW | done |')).toEqual(['M01', 'a | b', 'NEW', 'done']);
  });
});

describe('the generator fails closed', () => {
  it('rejects a source with no milestone rows rather than emitting an empty roadmap', () => {
    // "There is nothing planned" and "I could not read the table" must not be
    // the same document.
    expect(() => parseMilestones('# nothing here')).not.toThrow();
    expect(parseMilestones('# nothing here')).toEqual([]);
    expect(() => generate(path.join(ROOT, 'packages'))).toThrow(/is missing/);
  });

  it('drops a phase heading with no rows rather than rendering it empty', () => {
    const phases = parseMilestones('## Phase 9 — nothing\n\nsome prose\n');
    expect(phases).toEqual([]);
  });

  it('renders a status line for every milestone it was given', () => {
    const rendered = render([
      { heading: 'Phase 1 — x', milestones: [{ id: 'M01', title: 'A', status: 'shipped' }] },
    ]);
    expect(rendered).toContain('| [`M01`](MILESTONES.md) | A | ✅ shipped |');
    expect(rendered).toContain('| ✅ shipped | 1 |');
  });
});
