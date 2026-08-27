/**
 * `npm run release:check` and `npm run release:notes` — the two commands
 * `.github/workflows/release.yml` runs before it builds anything.
 *
 * The rules live in `release-rules.ts` as pure functions so they can be handed
 * planted violations; this file is the part that reads the tree and prints.
 *
 * Both commands report **every** problem they find rather than the first. A
 * release blocked three times in a row for three different reasons is how a
 * person ends up running the publish by hand.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changelogSection,
  checkChangeEntries,
  checkChangelog,
  checkCredentialPreflight,
  checkManualOnly,
  checkPublishGating,
  checkVersion,
  parseWorkflow,
  readChangeEntry,
  requiredBump,
  type ChangeEntry,
  type ReleaseViolation,
  type VersionedFile,
} from './release-rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHANGES_DIR = '.changes';
export const RELEASE_WORKFLOW = '.github/workflows/release.yml';

function read(rel: string): string {
  const abs = path.join(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

/**
 * Every file in the tree that declares the project's version.
 *
 * Collected from the workspace globs rather than listed here, so a package
 * added tomorrow is covered on the day it lands. `apps/*` are private and never
 * published, and they are still included: a release where `apps/web` says 0.1.0
 * and everything else says 0.2.0 is a tree that disagrees with itself, and this
 * is the one moment anybody looks.
 */
export function versionedFiles(root: string = ROOT): VersionedFile[] {
  const out: VersionedFile[] = [];

  const manifest = (rel: string): void => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    try {
      const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { version?: unknown };
      out.push({ path: rel, version: typeof parsed.version === 'string' ? parsed.version : null });
    } catch {
      out.push({ path: rel, version: null });
    }
  };

  manifest('package.json');
  for (const workspace of ['packages', 'apps']) {
    const dir = path.join(root, workspace);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      manifest(`${workspace}/${entry.name}/package.json`);
    }
  }

  const pyproject = path.join(root, 'packages/sdk-python/pyproject.toml');
  if (existsSync(pyproject)) {
    const text = readFileSync(pyproject, 'utf8');
    const found = /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
    out.push({ path: 'packages/sdk-python/pyproject.toml', version: found });
  }

  const config = path.join(root, 'plugin/src/Config.luau');
  if (existsSync(config)) {
    const text = readFileSync(config, 'utf8');
    const found = /^Config\.PLUGIN_VERSION\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
    out.push({ path: 'plugin/src/Config.luau', version: found });
  }

  return out;
}

export function changeEntries(root: string = ROOT): ChangeEntry[] {
  const dir = path.join(root, CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map((name) => readChangeEntry(`${CHANGES_DIR}/${name}`, readFileSync(path.join(dir, name), 'utf8')));
}

/** Everything wrong with releasing `version` from this tree. */
export function releaseReport(version: string, root: string = ROOT): ReleaseViolation[] {
  const workflowText = read(RELEASE_WORKFLOW);
  const workflow = parseWorkflow(workflowText);
  const entries = changeEntries(root);
  return [
    ...checkManualOnly(RELEASE_WORKFLOW, workflow),
    ...checkPublishGating(RELEASE_WORKFLOW, workflow),
    ...checkCredentialPreflight(RELEASE_WORKFLOW, workflow),
    ...checkVersion(version, versionedFiles(root)),
    ...checkChangelog(version, read('CHANGELOG.md')),
    ...checkChangeEntries(entries),
  ];
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv: readonly string[]): number {
  const command = argv[0] === 'notes' ? 'notes' : 'check';
  const version = flag(argv, 'version');
  if (version === undefined || version === '') {
    process.stderr.write('release: --version <semver> is required\n');
    return 2;
  }

  if (command === 'notes') {
    const section = changelogSection(read('CHANGELOG.md'), version);
    if (section === null) {
      process.stderr.write(`release: CHANGELOG.md has no section for ${version}\n`);
      return 1;
    }
    const out = flag(argv, 'out');
    // The heading is dropped: the release page already carries the version as
    // its title, and repeating it is the sort of small wrongness that makes a
    // generated page read as generated.
    const body = section.split('\n').slice(1).join('\n').trim();
    if (out === undefined) {
      process.stdout.write(`${body}\n`);
    } else {
      mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      writeFileSync(path.resolve(out), `${body}\n`, 'utf8');
      process.stderr.write(`release: wrote ${out}\n`);
    }
    return 0;
  }

  const violations = releaseReport(version);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`${violation.rule}  ${violation.file}: ${violation.detail}\n`);
    }
    process.stderr.write(`\nrelease:check: ${violations.length} problem(s). Nothing was built and nothing was published.\n`);
    return 1;
  }

  const entries = changeEntries();
  process.stdout.write(
    [
      `release:check: ok — this tree can be released as ${version}.`,
      `  versions     ${versionedFiles().length} file(s) agree`,
      `  notes        CHANGELOG.md has a section for ${version}`,
      `  entries      ${entries.length} under ${CHANGES_DIR}/, largest bump: ${requiredBump(entries) ?? 'none'}`,
      `  workflow     ${RELEASE_WORKFLOW} is manual-only, gated, and checks every credential it uses`,
      '',
    ].join('\n'),
  );
  return 0;
}

/* c8 ignore start -- the process shim. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
/* c8 ignore stop */
