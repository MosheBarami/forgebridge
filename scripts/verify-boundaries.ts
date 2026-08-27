/**
 * Repository boundary gate — the CI half of `docs/REPO-LAYOUT.md`.
 *
 * Four rules, each protecting a promise that is otherwise only prose:
 *
 *   B1  packages/protocol imports nothing but zod        — the contract must be
 *       importable from any runtime, forever. One dependency is the budget.
 *   B2  packages/core imports no vendor SDK              — vendors live behind
 *       ports (ADR-005/011); a direct import makes self-hosting a fiction.
 *   B3  nothing outside the official instance names it  — ADR-001: the core is
 *                                                           neutral or it is not
 *                                                           adoptable by rivals.
 *   B4  no package imports an app                        — apps depend on
 *                                                           packages, never back.
 *
 * The import scanner is deliberately simple: anchored statement matching plus
 * literal-string dynamic imports. A false positive is loud and fixable in one
 * line; a missed violation would quietly undo a promise, which is the failure
 * that matters here.
 *
 * Run:  npm run verify:boundaries
 * Exit: 0 clean, 1 with one line per violation.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BoundaryViolation {
  rule: 'B1' | 'B2' | 'B3' | 'B4';
  file: string;
  detail: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.git', '.venv', '__pycache__']);

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** B1: everything `packages/protocol/src` is allowed to reach for. */
const PROTOCOL_ALLOWED = new Set(['zod']);
/** B1: additionally allowed in `packages/protocol/test`, which ships to nobody. */
const PROTOCOL_TEST_ALLOWED = new Set(['vitest', '@forgebridge/protocol']);

/**
 * B2: vendors banned from `packages/core`. Entries are matched against both the
 * package root and the scope, so a bare scope like `@sentry` bans every package
 * in it (`@sentry/node`, `@sentry/nextjs`, …) while `next` also catches
 * `next/server`.
 */
const CORE_BANNED = ['next', '@supabase', '@sentry', 'openai', '@anthropic-ai', 'ai'];

/**
 * B3: assembled from parts so that this file — which must name the string in
 * order to search for it — does not itself trip the rule if the scan scope is
 * ever widened to include scripts/.
 */
const OFFICIAL_INSTANCE_NAME = ['apple', 'gg'].join('.');

/**
 * Trees that must stay neutral. `docs/` and the root README legitimately name it.
 *
 * Exported so `docs/REPO-LAYOUT.md` can be checked against it: the document
 * states this rule's scope in prose, and a stated scope wider than the enforced
 * one is a rule a reader will believe and a machine will not apply.
 *
 * `apps` is here as a *tree*, with the official instance exempted below by name,
 * and that direction matters. Listing the neutral apps individually would mean a
 * newly added app is silently out of scope until somebody remembers to add it —
 * and an app nobody added to the list reads, in a green CI log, exactly like an
 * app with nothing wrong in it. Naming the one exemption instead makes every
 * future app neutral by default. `apps/relay` was added while B3 still scanned
  * three trees. No violation was found when the scope was widened — apps/relay was
 * already clean. The gate was widened because a rule that reads "everything
 * outside apps/web stays neutral" while scanning three named directories is a
 * rule nobody can rely on, not because it caught anything.
 * seeing any of them.
 */
export const NEUTRAL_TREES: readonly string[] = ['packages', 'plugin', 'examples', 'apps'];

/**
 * The one path inside `NEUTRAL_TREES` that ADR-001 exempts: `apps/web` *is* the
 * official instance, so naming itself is its job rather than a violation.
 */
export const OFFICIAL_INSTANCE_TREE = 'apps/web';

function walk(dir: string, repoRoot: string, out: string[] = [], excluded: readonly string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      const child = path.join(dir, dirent.name);
      const childRel = path.relative(repoRoot, child).split(path.sep).join('/');
      // Pruned at the directory rather than filtered at the file: `apps/web` is
      // a built Next.js tree, and descending into it to discard every path
      // would mean reading its build output on every run of the gate.
      if (excluded.includes(childRel)) continue;
      walk(child, repoRoot, out, excluded);
    } else if (dirent.isFile()) {
      out.push(path.relative(repoRoot, path.join(dir, dirent.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

function isProbablyBinary(buffer: Buffer): boolean {
  // A NUL byte in the first block is the cheap, reliable tell for binary data.
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Import specifiers referenced by a source file. Static forms are anchored to
 * the start of a line so a commented-out `// import x from 'next'` is not read
 * as an import; dynamic forms require a plain string literal argument.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const statik = /^[ \t]*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"\n]+)['"]/gm;
  const bareImport = /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm;
  const dynamic = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  for (const pattern of [statik, bareImport, dynamic]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** `@scope/name/sub` -> `@scope/name`; `next/server` -> `next`. */
export function packageRoot(specifier: string): string {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/');
  return segments[0] ?? specifier;
}

/** `@scope/name/sub` -> `@scope`; unscoped specifiers have no scope. */
export function packageScope(specifier: string): string | null {
  if (!specifier.startsWith('@')) return null;
  return specifier.split('/')[0] ?? null;
}

export function isBannedInCore(specifier: string, banned: readonly string[] = CORE_BANNED): boolean {
  const scope = packageScope(specifier);
  return banned.includes(packageRoot(specifier)) || (scope !== null && banned.includes(scope));
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

function readIfText(abs: string): string | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    return null;
  }
  if (isProbablyBinary(buffer)) return null;
  return buffer.toString('utf8');
}

function appPackageNames(repoRoot: string): string[] {
  const appsDir = path.join(repoRoot, 'apps');
  if (!existsSync(appsDir)) return [];
  const names: string[] = [];
  for (const dirent of readdirSync(appsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifest = path.join(appsDir, dirent.name, 'package.json');
    if (!existsSync(manifest) || !statSync(manifest).isFile()) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) names.push(parsed.name);
    } catch {
      // A malformed app manifest is that app's problem, not this gate's.
    }
  }
  return names;
}

export function verifyBoundaries(repoRoot: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const appNames = new Set(appPackageNames(repoRoot));

  // ── B1 ────────────────────────────────────────────────────────────────────
  const protocolDir = path.join(repoRoot, 'packages', 'protocol');
  if (existsSync(protocolDir)) {
    const protocolManifest = path.join(protocolDir, 'package.json');
    if (existsSync(protocolManifest)) {
      try {
        const parsed = JSON.parse(readFileSync(protocolManifest, 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        for (const dependency of Object.keys(parsed.dependencies ?? {})) {
          if (!PROTOCOL_ALLOWED.has(dependency)) {
            violations.push({
              rule: 'B1',
              file: 'packages/protocol/package.json',
              detail: `Runtime dependency "${dependency}". The protocol package depends on zod and nothing else.`,
            });
          }
        }
      } catch (error) {
        violations.push({
          rule: 'B1',
          file: 'packages/protocol/package.json',
          detail: `Could not be parsed: ${(error as Error).message}`,
        });
      }
    }

    for (const rel of walk(protocolDir, repoRoot)) {
      if (!CODE_EXTENSIONS.has(path.extname(rel))) continue;
      const isTest = rel.startsWith('packages/protocol/test/') || rel.endsWith('.test.ts');
      const source = readIfText(path.join(repoRoot, rel));
      if (source === null) continue;
      for (const specifier of extractImportSpecifiers(source)) {
        if (isRelative(specifier)) continue;
        const root = packageRoot(specifier);
        if (PROTOCOL_ALLOWED.has(root)) continue;
        if (isTest && PROTOCOL_TEST_ALLOWED.has(root)) continue;
        violations.push({
          rule: 'B1',
          file: rel,
          detail: `imports "${specifier}". packages/protocol may import zod and its own relative modules only.`,
        });
      }
    }
  }

  // ── B2 ────────────────────────────────────────────────────────────────────
  const coreDir = path.join(repoRoot, 'packages', 'core');
  for (const rel of walk(coreDir, repoRoot)) {
    if (!CODE_EXTENSIONS.has(path.extname(rel))) continue;
    const source = readIfText(path.join(repoRoot, rel));
    if (source === null) continue;
    for (const specifier of extractImportSpecifiers(source)) {
      if (isRelative(specifier)) continue;
      if (isBannedInCore(specifier)) {
        violations.push({
          rule: 'B2',
          file: rel,
          detail: `imports "${specifier}". packages/core reaches vendors through ports only — put this behind an adapter package (ADR-005, ADR-011).`,
        });
      }
    }
  }

  // ── B3 and B4 ─────────────────────────────────────────────────────────────
  for (const tree of NEUTRAL_TREES) {
    for (const rel of walk(path.join(repoRoot, tree), repoRoot, [], [OFFICIAL_INSTANCE_TREE])) {
      const source = readIfText(path.join(repoRoot, rel));
      if (source === null) continue;

      // Every occurrence, not just the first in the file: reporting one at a
      // time turns a three-line fix into three CI round trips.
      source.split('\n').forEach((text, index) => {
        if (!text.includes(OFFICIAL_INSTANCE_NAME)) return;
        violations.push({
          rule: 'B3',
          file: `${rel}:${index + 1}`,
          detail:
            `names the official instance. Everything outside ${OFFICIAL_INSTANCE_TREE} stays neutral ` +
            '(ADR-001) — refer to "the official instance" instead.',
        });
      });

      if (!rel.startsWith('packages/')) continue;
      if (!CODE_EXTENSIONS.has(path.extname(rel))) continue;
      for (const specifier of extractImportSpecifiers(source)) {
        const reachesIntoApps = isRelative(specifier)
          ? specifier.split('/').includes('apps')
          : specifier === 'apps' || specifier.startsWith('apps/') || appNames.has(packageRoot(specifier));
        if (reachesIntoApps) {
          violations.push({
            rule: 'B4',
            file: rel,
            detail: `imports "${specifier}". Apps depend on packages; no package may depend on an app.`,
          });
        }
      }
    }
  }

  return violations;
}

const RULE_TEXT: Record<BoundaryViolation['rule'], string> = {
  B1: 'packages/protocol imports nothing but zod',
  B2: 'packages/core imports no vendor SDK',
  B3: 'nothing outside apps/web names the official instance',
  B4: 'no package imports an app',
};

function main(): void {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const violations = verifyBoundaries(repoRoot);

  if (violations.length === 0) {
    console.log('verify-boundaries: ok — B1 B2 B3 B4 all clean.');
    return;
  }

  console.error(`verify-boundaries: ${violations.length} violation(s) — see docs/REPO-LAYOUT.md\n`);
  for (const violation of violations) {
    console.error(`  [${violation.rule}: ${RULE_TEXT[violation.rule]}] ${violation.file}`);
    console.error(`      ${violation.detail}`);
  }
  console.error('');
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
