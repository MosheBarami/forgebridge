import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractImportSpecifiers,
  isBannedInCore,
  packageRoot,
  packageScope,
  verifyBoundaries,
} from '../verify-boundaries.js';

let root: string;

function write(rel: string, contents: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function rules(): string[] {
  return verifyBoundaries(root).map((violation) => violation.rule);
}

/**
 * Assembled from parts for the same reason the scanner assembles its needle:
 * this file must not itself contain the string it is testing for.
 */
const OFFICIAL_INSTANCE_NAME = ['apple', 'gg'].join('.');

function cleanProtocol(): void {
  write(
    'packages/protocol/package.json',
    JSON.stringify({ name: '@forgebridge/protocol', dependencies: { zod: '^3.24.1' } }),
  );
  write('packages/protocol/src/index.ts', "import { z } from 'zod';\nexport const x = z.string();\n");
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fb-bounds-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('extractImportSpecifiers', () => {
  it('reads static, bare, dynamic and require forms', () => {
    const source = [
      "import { a } from 'alpha';",
      "import 'bravo';",
      "export { c } from 'charlie';",
      "const d = await import('delta');",
      "const e = require('echo');",
    ].join('\n');
    expect(extractImportSpecifiers(source).sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });

  it('reads multi-line import statements', () => {
    expect(extractImportSpecifiers("import {\n  a,\n  b,\n} from 'alpha';")).toContain('alpha');
  });

  it('ignores a commented-out import', () => {
    expect(extractImportSpecifiers("// import { a } from 'next';")).toEqual([]);
  });
});

describe('specifier matching', () => {
  it('keeps the scope for scoped packages and drops subpaths', () => {
    expect(packageRoot('@sentry/node')).toBe('@sentry/node');
    expect(packageRoot('@sentry/node/esm')).toBe('@sentry/node');
    expect(packageRoot('next/server')).toBe('next');
    expect(packageRoot('zod')).toBe('zod');
    expect(packageScope('@supabase/supabase-js')).toBe('@supabase');
    expect(packageScope('zod')).toBeNull();
  });

  it('bans a whole scope but does not over-match a lookalike name', () => {
    expect(isBannedInCore('@sentry/nextjs')).toBe(true);
    expect(isBannedInCore('next/server')).toBe(true);
    expect(isBannedInCore('ai')).toBe(true);
    // `ai` is banned; `ai-something-else` is a different package.
    expect(isBannedInCore('aimless')).toBe(false);
    expect(isBannedInCore('@forgebridge/protocol')).toBe(false);
  });
});

describe('verifyBoundaries', () => {
  it('passes on a tree that respects every rule', () => {
    cleanProtocol();
    write('packages/core/src/router.ts', "import { ChangeSet } from '@forgebridge/protocol';\n");
    expect(verifyBoundaries(root)).toEqual([]);
  });

  it('B1: flags a non-zod import in packages/protocol', () => {
    cleanProtocol();
    write('packages/protocol/src/hash.ts', "import { createHash } from 'node:crypto';\n");
    expect(rules()).toContain('B1');
  });

  it('B1: flags an extra runtime dependency in the protocol package.json', () => {
    cleanProtocol();
    write(
      'packages/protocol/package.json',
      JSON.stringify({ name: '@forgebridge/protocol', dependencies: { zod: '^3.24.1', uuid: '^9' } }),
    );
    expect(rules()).toContain('B1');
  });

  it('B1: allows vitest inside packages/protocol/test', () => {
    cleanProtocol();
    write('packages/protocol/test/x.test.ts', "import { it } from 'vitest';\nit('x', () => {});\n");
    expect(verifyBoundaries(root)).toEqual([]);
  });

  it('B1: ignores compiled output under dist', () => {
    cleanProtocol();
    write('packages/protocol/dist/index.js', "import 'some-bundled-thing';\n");
    expect(verifyBoundaries(root)).toEqual([]);
  });

  it('B2: flags each banned vendor SDK in packages/core', () => {
    cleanProtocol();
    for (const specifier of ['next/server', '@supabase/supabase-js', '@sentry/node', 'openai', '@anthropic-ai/sdk', 'ai']) {
      rmSync(path.join(root, 'packages/core'), { recursive: true, force: true });
      write('packages/core/src/vendor.ts', `import x from '${specifier}';\nexport default x;\n`);
      expect(rules(), specifier).toContain('B2');
    }
  });

  it('B2: allows a vendor SDK outside packages/core, where adapters live', () => {
    cleanProtocol();
    write('packages/storage-supabase/src/adapter.ts', "import { createClient } from '@supabase/supabase-js';\n");
    expect(verifyBoundaries(root)).toEqual([]);
  });

  it('B3: flags the official instance name anywhere under packages/', () => {
    cleanProtocol();
    write('packages/core/src/brand.ts', `export const HOME = '${OFFICIAL_INSTANCE_NAME}';\n`);
    expect(rules()).toContain('B3');
  });

  it('B3: reports every occurrence, not just the first in a file', () => {
    // One line per occurrence, so a multi-line fix is one CI round trip.
    cleanProtocol();
    write(
      'packages/core/src/brand.ts',
      `// ${OFFICIAL_INSTANCE_NAME}\nconst a = 1;\n// also ${OFFICIAL_INSTANCE_NAME}\n`,
    );
    const b3 = verifyBoundaries(root).filter((violation) => violation.rule === 'B3');
    expect(b3.map((violation) => violation.file)).toEqual([
      'packages/core/src/brand.ts:1',
      'packages/core/src/brand.ts:3',
    ]);
  });

  it('B3: catches the name inside a comment, not only in code', () => {
    // The realistic case: a doc comment explaining the design names the instance.
    cleanProtocol();
    write('packages/core/src/ports/x.ts', `/** ${OFFICIAL_INSTANCE_NAME} installs an adapter here. */\n`);
    expect(rules()).toContain('B3');
  });

  it('B3: flags it in the Luau plugin too, not only TypeScript', () => {
    cleanProtocol();
    write('plugin/src/transport.luau', `local host = "${OFFICIAL_INSTANCE_NAME}"\n`);
    expect(rules()).toContain('B3');
  });

  it('B3: flags it in a neutral app, not only in packages/ and plugin/', () => {
    // The violation this scope was widened for. `apps/relay` named the official
    // instance six times in its CORS tests and B3 walked three trees, none of
    // them `apps/` — so the gate reported clean because it never looked, which
    // is the one failure shape this repository keeps re-finding.
    cleanProtocol();
    write('apps/relay/test/proxy.test.ts', `const origin = 'https://${OFFICIAL_INSTANCE_NAME}';\n`);
    expect(rules()).toContain('B3');
  });

  it('B3: flags an app that did not exist when the rule was written', () => {
    // Neutrality is the default for apps, not an opt-in list. An app added
    // tomorrow is in scope on the day it lands.
    cleanProtocol();
    write('apps/desktop/src/main.ts', `const home = '${OFFICIAL_INSTANCE_NAME}';\n`);
    expect(rules()).toContain('B3');
  });

  it('B3: allows the official instance to name itself in apps/web — CONTROL', () => {
    // The legitimate shape B3 is most confusable with. `apps/web` IS the
    // official instance (ADR-001); a rule that fired here would fire on every
    // page of the flagship and be switched off within a week.
    cleanProtocol();
    write('apps/web/app/page.tsx', `export const HOME = '${OFFICIAL_INSTANCE_NAME}';\n`);
    expect(verifyBoundaries(root)).toEqual([]);
  });

  it('B3: does not exempt a sibling whose name merely starts with the exempt one', () => {
    // `apps/website` is not `apps/web`. A prefix test rather than a path test
    // would let it through, and the exemption is the whole attack surface of
    // this rule.
    cleanProtocol();
    write('apps/website/src/index.ts', `const home = '${OFFICIAL_INSTANCE_NAME}';\n`);
    expect(rules()).toContain('B3');
  });

  it('B4: flags a package importing an app by package name', () => {
    cleanProtocol();
    write('apps/web/package.json', JSON.stringify({ name: '@forgebridge/web' }));
    write('packages/core/src/leak.ts', "import { thing } from '@forgebridge/web';\n");
    expect(rules()).toContain('B4');
  });

  it('B4: flags a package reaching into apps/ by relative path', () => {
    cleanProtocol();
    write('packages/core/src/leak.ts', "import { thing } from '../../../apps/web/lib/thing.js';\n");
    expect(rules()).toContain('B4');
  });

  it('reports the offending file so a failure is actionable', () => {
    cleanProtocol();
    write('packages/core/src/vendor.ts', "import x from 'openai';\nexport default x;\n");
    const violation = verifyBoundaries(root).find((candidate) => candidate.rule === 'B2');
    expect(violation?.file).toBe('packages/core/src/vendor.ts');
    expect(violation?.detail).toContain('openai');
  });
});
