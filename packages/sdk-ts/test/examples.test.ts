/**
 * The examples, checked against the API they claim to use.
 *
 * A README example that does not work is the defect this repository has already
 * caught twice in other forms, and an example directory is where it hides best:
 * nothing imports it, nothing builds it, and it reads as documentation right up
 * until somebody runs it.
 *
 * ── What this proves, and what it does not ───────────────────────────────────
 *
 * It proves that every `client.<method>(…)` the examples call is a real method on
 * `ForgeBridgeClient`, that every name they import from `@forgebridge/sdk-ts` is
 * really exported, and that the approval split the walk-through is built around
 * is a property of the files rather than of their prose.
 *
 * It does **not** prove the examples run end to end. They are `.mjs` scripts that
 * import the built package and exit the process, so running them here would need
 * a build of this package inside its own test task and a daemon per script.
 * `test/conformance.test.ts` is what exercises these same calls against a live
 * daemon; this file is what stops the examples from drifting away from the API
 * those calls belong to.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ForgeBridgeClient } from '../src/index.js';
import * as sdk from '../src/index.js';

const EXAMPLES = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples', 'typescript');

const scripts = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => ({ name, source: readFileSync(path.join(EXAMPLES, name), 'utf8') }));

const readme = readFileSync(path.join(EXAMPLES, 'README.md'), 'utf8');

it('there are examples to check', () => {
  // Fail closed. A glob that matched nothing would make every test below pass
  // by having nothing to disagree with, which is the shape of a gate that
  // silently stopped running.
  expect(scripts.length).toBeGreaterThan(0);
});

describe('every example calls an API that exists', () => {
  for (const script of scripts) {
    it(`${script.name} calls only real client methods`, () => {
      const called = [...script.source.matchAll(/\bclient\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)].map(
        (match) => match[1] as string,
      );
      expect(called.length).toBeGreaterThan(0);
      for (const method of called) {
        expect(
          typeof (ForgeBridgeClient.prototype as unknown as Record<string, unknown>)[method],
          `${script.name} calls client.${method}(), which is not a method on ForgeBridgeClient`,
        ).toBe('function');
      }
    });

    it(`${script.name} imports only real exports`, () => {
      const imports = [...script.source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@forgebridge\/sdk-ts'/g)];
      expect(imports.length).toBe(1);
      const names = (imports[0]?.[1] ?? '')
        .split(',')
        .map((name) => name.trim().split(/\s+as\s+/)[0]?.trim())
        .filter((name): name is string => Boolean(name));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(
          name in (sdk as unknown as Record<string, unknown>),
          `${script.name} imports { ${name} } from @forgebridge/sdk-ts, which does not export it`,
        ).toBe(true);
      }
    });
  }
});

describe('the walk-through keeps proposing and approving apart', () => {
  it('has no script that does both', () => {
    // ADR-012 as a property of the files. An example with a `--yes` flag on the
    // propose step would teach the opposite of what the system does, and it
    // would read as a convenience rather than as a hole.
    for (const script of scripts) {
      const proposes = script.source.includes('proposeChangeSet(') || script.source.includes('startRun(');
      const approves = script.source.includes('approveChangeSet(');
      expect(proposes && approves, `${script.name} both proposes and approves`).toBe(false);
    }
  });

  it('approves only from a digest it was given, never one it fetched', () => {
    const approve = scripts.find((script) => script.name === 'approve.mjs');
    expect(approve).toBeDefined();
    // Reading the diff again here and echoing whatever it said would approve
    // this script's idea of the set rather than the operations a person read.
    expect(approve?.source).not.toContain('getDiff(');
    expect(approve?.source).toContain('contentDigest');
  });
});

describe('the example README points at files that exist', () => {
  it('names every script it tells the reader to run', () => {
    const named = new Set(
      [...readme.matchAll(/examples\/typescript\/([A-Za-z0-9_-]+\.mjs)/g)].map((match) => match[1] as string),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect(
        scripts.some((script) => script.name === name),
        `the README tells the reader to run ${name}, which is not in examples/typescript`,
      ).toBe(true);
    }
  });

  it('offers no install command for a package that is not published', () => {
    // A README offering `npm install @forgebridge/sdk-ts` would 404. Publishing
    // is M49; until it lands, the examples run from a checkout.
    expect(readme).not.toMatch(/npm (install|i|add)\s+@forgebridge/);
    for (const script of scripts) {
      expect(script.source).not.toMatch(/npm (install|i|add)\s+@forgebridge/);
    }
  });
});
