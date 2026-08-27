import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The token system, checked as a system.
 *
 * A design system built on CSS custom properties has one characteristic failure
 * and it is silent: someone adds a colour to `:root`, adds it to
 * `[data-theme="dark"]` because that is the theme they were testing in, and
 * forgets the `prefers-color-scheme` block. Nothing breaks in development. It
 * breaks for a user on a dark OS who never touched the theme switch, in one
 * component, as a black-on-black label.
 *
 * So the three blocks are compared against each other here rather than trusted.
 */

const css = readFileSync(
  fileURLToPath(new URL('../app/globals.css', import.meta.url)),
  'utf8',
);

/**
 * Find a rule block by its selector.
 *
 * The selector must be followed by its opening brace. Matching the bare string
 * would find the header comment at the top of `globals.css`, which names all
 * three selectors — and did, on the first version of this file, which made
 * every assertion below compare the light block against itself and pass
 * vacuously. A gate that cannot fail is worse than no gate.
 */
function block(selector: string): string {
  const anchor = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const match = anchor.exec(css);
  expect(match, `globals.css has no "${selector} {" rule`).not.toBeNull();
  const open = (match?.index ?? 0) + (match?.[0].length ?? 0) - 1;
  const close = css.indexOf('\n}', open);
  return css.slice(open, close);
}

function tokensIn(source: string): Set<string> {
  return new Set(Array.from(source.matchAll(/(--fb-[a-z0-9-]+)\s*:/g), (m) => m[1] as string));
}

/**
 * The tokens whose value is a literal colour. These are the ones a theme has to
 * answer for; `--fb-space-4` and `--fb-font-mono` mean the same thing in both.
 * Derived from the light block rather than listed, so adding a colour to
 * `:root` and forgetting the dark blocks fails here on the next run.
 */
function colourTokensIn(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/(--fb-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gi), (m) => m[1] as string),
  );
}

const lightBlock = block(':root');
const systemDarkBlock = block(':root:not([data-theme="light"])');
const explicitDarkBlock = block(':root[data-theme="dark"]');

const light = tokensIn(lightBlock);
const systemDark = tokensIn(systemDarkBlock);
const explicitDark = tokensIn(explicitDarkBlock);
const lightColours = colourTokensIn(lightBlock);

describe('the theme token blocks', () => {
  it('defines a complete light set on :root', () => {
    // A spot check on the load-bearing ones, so that deleting a token that
    // components depend on fails here rather than in a screenshot.
    for (const required of [
      '--fb-canvas',
      '--fb-surface',
      '--fb-raised',
      '--fb-fg',
      '--fb-fg-muted',
      '--fb-rule',
      '--fb-live',
      '--fb-attend',
      '--fb-halt',
      '--fb-idle',
      '--fb-focus',
      '--fb-font-sans',
      '--fb-font-mono',
    ]) {
      expect(light.has(required), `:root is missing ${required}`).toBe(true);
    }
  });

  it('overrides exactly the same tokens in both dark blocks', () => {
    // The one that actually catches the bug: a token added to the explicit
    // theme and not to the media query, or the reverse.
    expect([...systemDark].sort()).toEqual([...explicitDark].sort());
  });

  it('gives every light colour an answer in both dark blocks', () => {
    expect(lightColours.size).toBeGreaterThan(15);
    const unanswered = [...lightColours].filter(
      (token) => !systemDark.has(token) || !explicitDark.has(token),
    );
    expect(
      unanswered,
      'these colours are defined for light only, so a dark reader gets the light value',
    ).toEqual([]);
  });

  it('themes colours and nothing else', () => {
    // Spacing, radius and type are theme-independent by design. A dark block
    // that started redefining them would mean the two themes had begun to
    // diverge structurally, which is a decision, not a token edit.
    const nonColour = [...systemDark].filter((token) => !lightColours.has(token));
    expect(nonColour).toEqual([]);
  });

  it('never introduces a dark-only token', () => {
    const orphans = [...systemDark].filter((token) => !light.has(token));
    expect(orphans, 'a token that exists only in dark has no light value to fall back to').toEqual(
      [],
    );
  });

  it('guards the media query so an explicit light choice wins over the OS', () => {
    // `:root { }` inside `@media (prefers-color-scheme: dark)` would beat
    // `[data-theme="light"]` on specificity and strand the user in dark.
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('defines a focus ring that has a value in both themes', () => {
    expect(css).toMatch(/:focus-visible\s*\{/);
    expect(light.has('--fb-focus')).toBe(true);
    expect(systemDark.has('--fb-focus')).toBe(true);
    expect(explicitDark.has('--fb-focus')).toBe(true);
  });
});
