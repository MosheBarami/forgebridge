import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIVACY_POSTURE, TransportKind } from '@forgebridge/protocol';

/**
 * ADR-014's one rule, enforced over this app's own source.
 *
 * The ADR is a decision whose entire content is *do not say this yet*, and the
 * claim has been found in three separate files across two review rounds — which
 * is why `scripts/docs-claims-rules.ts` has a rule (D5) for it. That rule reads
 * markdown. This one reads TypeScript, because the sentence is just as
 * available to a comment, a log line or a response field, and the response
 * field is the one a user would actually see.
 *
 * The rule is not "never write these words": the ADR has to be discussable. It
 * is "never write them without citing the milestone that would make them true",
 * which is exactly D5's standard.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, '../src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) sourceFiles(abs, out);
    else if (abs.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** The same phrases D5 looks for, applied to code. */
const FORBIDDEN: readonly RegExp[] = [
  /end[\s‐-―-]?to[\s‐-―-]?end[\s\S]{0,20}encrypt/gi,
  /\bE2E[\s\S]{0,20}encrypt/gi,
];

const CITES_M19 = /\bM19\b|ADR-014|relay-e2e/i;

/** The paragraph or statement a match sits in — D5's `unitAt`, for source. */
function unitAround(source: string, offset: number): string {
  const lines = source.split('\n');
  let line = 0;
  let seen = 0;
  for (; line < lines.length; line += 1) {
    seen += (lines[line] as string).length + 1;
    if (seen > offset) break;
  }
  let start = line;
  while (start > 0 && (lines[start - 1] as string).trim() !== '') start -= 1;
  let end = line;
  while (end < lines.length - 1 && (lines[end + 1] as string).trim() !== '') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

describe('nothing in this app claims to be more private than it is', () => {
  it('never says end-to-end encrypted without citing M19 or ADR-014', () => {
    const offences: string[] = [];
    for (const file of sourceFiles(SOURCE)) {
      const source = readFileSync(file, 'utf8');
      for (const phrase of FORBIDDEN) {
        for (const match of source.matchAll(phrase)) {
          const unit = unitAround(source, match.index ?? 0);
          if (CITES_M19.test(unit)) continue;
          offences.push(`${path.relative(SOURCE, file)}: ${(match[0] ?? '').replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('catches the claim when it is planted — the gate can fail', () => {
    // A gate that cannot fail is decoration.
    const planted = 'const banner = "your changes are end-to-end encrypted";';
    const found = FORBIDDEN.some((phrase) => {
      phrase.lastIndex = 0;
      return phrase.test(planted);
    });
    expect(found).toBe(true);
    expect(CITES_M19.test(planted)).toBe(false);
  });

  it('accepts the sentence when it names the milestone that would make it true — CONTROL', () => {
    const legitimate = 'TODO(M19): relay-e2e is where payloads become end-to-end encrypted.';
    const matched = FORBIDDEN.some((phrase) => {
      phrase.lastIndex = 0;
      return phrase.test(legitimate);
    });
    expect(matched).toBe(true);
    expect(CITES_M19.test(legitimate)).toBe(true);
  });
});

describe('the posture string is the protocol’s, not this app’s', () => {
  it('serves the exact string for this transport', () => {
    // Never paraphrased and never softened. A transport that can read every
    // ChangeSet crossing it does not get to write its own description.
    expect(PRIVACY_POSTURE['relay-tls']).toBe('Relay — the relay operator can read your changes');
  });

  it('is a transport the protocol knows about', () => {
    expect(TransportKind.options).toContain('relay-tls');
  });

  it('does not hardcode the sentence anywhere in the source', () => {
    // If the string were written out here, a change to `PRIVACY_POSTURE` would
    // leave this app repeating the old one — which is the failure mode a
    // lookup exists to prevent.
    for (const file of sourceFiles(SOURCE)) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.relative(SOURCE, file)).not.toContain(PRIVACY_POSTURE['relay-tls']);
    }
  });
});
