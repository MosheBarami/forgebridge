import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RTL as a gate, not as a promise.
 *
 * `dir="rtl"` produces a correct layout only if every edge in the app is a
 * *logical* one. A single `margin-left` survives the direction flip unchanged
 * and puts a gap on the wrong side of a control; a single `border-r` leaves the
 * rail's rule on the left while the rail itself moved right. Neither breaks a
 * build, neither shows up in an English screenshot, and both are exactly the
 * kind of thing that accumulates once nobody is checking.
 *
 * So this scans the source and fails on physical-direction properties and
 * utilities. The inline-axis ones only: `top`, `bottom`, `mt-`, `pb-` and
 * friends are block-axis and mean the same thing in both directions.
 *
 * The escape hatch is `/* rtl-exempt: <reason> *\/` on the line above, and it
 * has been used zero times. If it is ever used, the reason is in the diff.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; what: string; instead: string }> = [
  // Tailwind utilities. Each negative lookahead exists because a shorter class
  // is a prefix of a longer legitimate one — `border-r` of `border-rule`,
  // `left-` of nothing yet but soon.
  { pattern: /\bm[lr]-(?:\d|\[|px\b|auto\b)/, what: 'ml-/mr-', instead: 'ms-/me-' },
  { pattern: /\bp[lr]-(?:\d|\[|px\b)/, what: 'pl-/pr-', instead: 'ps-/pe-' },
  { pattern: /\bborder-[lr](?![a-z])/, what: 'border-l/border-r', instead: 'border-s/border-e' },
  { pattern: /\brounded-[lr](?![a-z])/, what: 'rounded-l/rounded-r', instead: 'rounded-s/rounded-e' },
  { pattern: /\btext-(?:left|right)\b/, what: 'text-left/text-right', instead: 'text-start/text-end' },
  { pattern: /\bfloat-(?:left|right)\b/, what: 'float-left/float-right', instead: 'float-start/float-end' },
  { pattern: /\b(?:left|right)-(?:\d|\[|full\b|auto\b)/, what: 'left-/right-', instead: 'start-/end-' },
  // Raw CSS, for globals.css and any inline style object.
  { pattern: /(?:margin|padding|border)-(?:left|right)\b/, what: 'a physical box edge', instead: 'the -inline-start/-inline-end form' },
  { pattern: /(?<![-\w])(?:left|right)\s*:/, what: 'left:/right:', instead: 'inset-inline-start/inset-inline-end' },
];

/**
 * `dir="ltr"` islands are the deliberate exception and must stay: a mono run
 * carrying an instance path or a line of Luau is LTR content inside an RTL
 * page, and forcing it logical would let the bidi algorithm reorder a path.
 * They are not physical *layout*, so nothing above matches them — this note is
 * here so the next reader does not "fix" them.
 */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith('.test.tsx') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('every inline-axis edge is logical', () => {
  const files = sourceFiles(SRC);

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(FORBIDDEN)('uses no $what', ({ pattern, instead }) => {
    const hits: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const previous = lines[index - 1] ?? '';
        if (previous.includes('rtl-exempt:')) return;
        if (pattern.test(line)) {
          hits.push(`${path.relative(SRC, file)}:${String(index + 1)}  ${line.trim()}`);
        }
      });
    }

    expect(hits, `use ${instead} instead:\n${hits.join('\n')}`).toEqual([]);
  });
});
