/**
 * Brand-asset provenance gate — the CI half of `docs/BRAND-ASSETS.md`.
 *
 * The policy is "official assets only, provenance always". A policy without a
 * gate decays in three months, so this script is the gate: every byte under
 * `assets/brands/` must be traceable to a vendor's own brand page, under stated
 * terms, on a stated date, with a hash that proves the file has not been
 * swapped since a human looked at it.
 *
 * Run:  npm run verify:assets
 * Exit: 0 clean, 1 with one line per violation.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AssetViolation {
  /** Matches a numbered rule in docs/BRAND-ASSETS.md so a failure is greppable. */
  rule: string;
  where: string;
  detail: string;
}

/** Files under assets/brands/ that are ours, not vendor marks, and so need no entry. */
const NOT_BRAND_ASSETS = new Set(['manifest.json', 'README.md', '.gitkeep', '.DS_Store']);

/**
 * Hosts that mean "nobody filled this in yet". A manifest that passes CI while
 * pointing at example.com is worse than one that fails: it looks verified.
 */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'localhost', 'todo', 'tbd'];

const REQUIRED_TEXT_FIELDS = ['sourceUrl', 'licence', 'retrievedAt', 'constraints'] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface ManifestEntry {
  files?: unknown;
  sha256?: unknown;
  usage?: unknown;
  generated?: unknown;
  [field: string]: unknown;
}

function listFilesRecursively(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      found.push(...listFilesRecursively(abs, base));
    } else if (dirent.isFile()) {
      found.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return found;
}

function sha256OfFile(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function verifyAssets(repoRoot: string): AssetViolation[] {
  const violations: AssetViolation[] = [];
  const brandsDir = path.join(repoRoot, 'assets', 'brands');
  const manifestPath = path.join(brandsDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return [
      {
        rule: 'manifest-missing',
        where: 'assets/brands/manifest.json',
        detail: 'The provenance manifest does not exist. Every brand asset needs an entry in it.',
      },
    ];
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [
        {
          rule: 'manifest-malformed',
          where: 'assets/brands/manifest.json',
          detail: 'Top level must be a JSON object keyed by vendor slug.',
        },
      ];
    }
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    return [
      {
        rule: 'manifest-malformed',
        where: 'assets/brands/manifest.json',
        detail: `Not valid JSON: ${(error as Error).message}`,
      },
    ];
  }

  // `$`-prefixed keys are documentation embedded in the manifest (JSON has no
  // comments). They are skipped for coverage so that the worked example is not
  // mistaken for a real entry — but the `generated` check below still reads
  // them, so documentation cannot become a hiding place.
  const slugs = Object.keys(manifest).filter((key) => !key.startsWith('$'));

  /** file path -> slugs claiming it, so double-claimed provenance is caught. */
  const claimedBy = new Map<string, string[]>();

  for (const [slug, raw] of Object.entries(manifest)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      if (!slug.startsWith('$')) {
        violations.push({
          rule: 'entry-malformed',
          where: `manifest.json#${slug}`,
          detail: 'Entry must be an object.',
        });
      }
      continue;
    }
    const entry = raw as ManifestEntry;

    // BRAND-ASSETS rule 5. Checked on every key including `$` documentation:
    // an AI-drawn mark is the one failure this repo must never ship.
    if (entry.generated === true) {
      violations.push({
        rule: 'generated-asset',
        where: `manifest.json#${slug}`,
        detail:
          'generated: true. Generated, redrawn or approximated marks are forbidden — ' +
          'use the official asset or a plain text label.',
      });
    }

    if (slug.startsWith('$')) continue;

    for (const field of REQUIRED_TEXT_FIELDS) {
      if (!nonEmptyString(entry[field])) {
        violations.push({
          rule: 'incomplete-provenance',
          where: `manifest.json#${slug}.${field}`,
          detail: `Missing or empty "${field}". A human fills this in from the vendor's own brand page.`,
        });
      }
    }

    if (nonEmptyString(entry.sourceUrl)) {
      const sourceUrl = entry.sourceUrl.trim();
      if (!sourceUrl.startsWith('https://')) {
        violations.push({
          rule: 'incomplete-provenance',
          where: `manifest.json#${slug}.sourceUrl`,
          detail: `sourceUrl must be an https:// URL on the vendor's own site, got "${sourceUrl}".`,
        });
      } else if (PLACEHOLDER_HOSTS.some((host) => sourceUrl.toLowerCase().includes(host))) {
        violations.push({
          rule: 'incomplete-provenance',
          where: `manifest.json#${slug}.sourceUrl`,
          detail: `sourceUrl looks like a placeholder ("${sourceUrl}"). Record the real brand/press page.`,
        });
      }
    }

    if (nonEmptyString(entry.retrievedAt) && !ISO_DATE.test(entry.retrievedAt.trim())) {
      violations.push({
        rule: 'incomplete-provenance',
        where: `manifest.json#${slug}.retrievedAt`,
        detail: `retrievedAt must be YYYY-MM-DD, got "${entry.retrievedAt}".`,
      });
    }

    if (!Array.isArray(entry.usage) || entry.usage.length === 0 || !entry.usage.every(nonEmptyString)) {
      violations.push({
        rule: 'incomplete-provenance',
        where: `manifest.json#${slug}.usage`,
        detail: 'usage must be a non-empty list of the surfaces this mark appears on.',
      });
    }

    const files = entry.files;
    if (!Array.isArray(files) || files.length === 0 || !files.every(nonEmptyString)) {
      violations.push({
        rule: 'entry-malformed',
        where: `manifest.json#${slug}.files`,
        detail: 'files must be a non-empty list of paths relative to assets/brands/.',
      });
      continue;
    }

    const hashes =
      entry.sha256 !== null && typeof entry.sha256 === 'object' && !Array.isArray(entry.sha256)
        ? (entry.sha256 as Record<string, unknown>)
        : null;
    if (hashes === null) {
      violations.push({
        rule: 'entry-malformed',
        where: `manifest.json#${slug}.sha256`,
        detail: 'sha256 must be an object mapping each listed file to its checksum.',
      });
    }

    for (const file of files as string[]) {
      const rel = file.trim();
      if (rel.startsWith('/') || rel.split('/').includes('..')) {
        violations.push({
          rule: 'entry-malformed',
          where: `manifest.json#${slug}.files`,
          detail: `"${rel}" must stay inside assets/brands/ — no absolute paths, no "..".`,
        });
        continue;
      }
      claimedBy.set(rel, [...(claimedBy.get(rel) ?? []), slug]);

      const abs = path.join(brandsDir, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        violations.push({
          rule: 'manifest-references-missing-file',
          where: `assets/brands/${rel}`,
          detail: `Listed under "${slug}" but not present on disk. Remove the entry or restore the file.`,
        });
        continue;
      }

      const recorded = hashes?.[rel];
      if (!nonEmptyString(recorded)) {
        violations.push({
          rule: 'checksum-missing',
          where: `manifest.json#${slug}.sha256["${rel}"]`,
          detail: 'No checksum recorded. Without one a silent asset swap is invisible.',
        });
        continue;
      }
      if (!SHA256_HEX.test(recorded.trim())) {
        violations.push({
          rule: 'checksum-missing',
          where: `manifest.json#${slug}.sha256["${rel}"]`,
          detail: `"${recorded}" is not a 64-character lowercase SHA-256 hex digest.`,
        });
        continue;
      }
      const actual = sha256OfFile(abs);
      if (actual !== recorded.trim()) {
        violations.push({
          rule: 'checksum-mismatch',
          where: `assets/brands/${rel}`,
          detail: `SHA-256 is ${actual}, manifest says ${recorded.trim()}. The file changed since it was reviewed.`,
        });
      }
    }

    if (hashes !== null) {
      const listed = new Set((files as string[]).map((file) => file.trim()));
      for (const hashed of Object.keys(hashes)) {
        if (!listed.has(hashed)) {
          violations.push({
            rule: 'stale-checksum',
            where: `manifest.json#${slug}.sha256["${hashed}"]`,
            detail: 'Checksum recorded for a file this entry does not list.',
          });
        }
      }
    }
  }

  for (const [rel, owners] of claimedBy) {
    if (owners.length > 1) {
      violations.push({
        rule: 'duplicate-claim',
        where: `assets/brands/${rel}`,
        detail: `Claimed by more than one entry (${owners.join(', ')}). Provenance must be unambiguous.`,
      });
    }
  }

  // BRAND-ASSETS rule 1 — the one that actually stops a stray logo landing.
  for (const rel of listFilesRecursively(brandsDir)) {
    const basename = rel.split('/').pop() ?? rel;
    if (NOT_BRAND_ASSETS.has(basename)) continue;
    if (!claimedBy.has(rel)) {
      violations.push({
        rule: 'unmanifested-asset',
        where: `assets/brands/${rel}`,
        detail:
          'No manifest entry. Add one with the official source URL, licence, retrieval date and checksum ' +
          '(see the "adding a provider" checklist in CONTRIBUTING.md).',
      });
    }
  }

  // TODO(M50): BRAND-ASSETS rule 4 — "a brand asset is referenced from code by a
  // path not listed in that entry's `usage`" — is not enforced here. `usage`
  // holds surface names ("model-selector"), not file paths, so the check needs a
  // surface->path map that only exists once apps/web lands. Owner: the apps/web
  // milestone; it must add that map and extend this script.

  return violations;
}

function main(): void {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const violations = verifyAssets(repoRoot);

  if (violations.length === 0) {
    const manifestPath = path.join(repoRoot, 'assets', 'brands', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const entries = Object.keys(manifest).filter((key) => !key.startsWith('$')).length;
    const files = listFilesRecursively(path.join(repoRoot, 'assets', 'brands')).length;
    console.log(`verify-assets: ok — ${entries} manifest entr${entries === 1 ? 'y' : 'ies'}, ${files} file(s) under assets/brands/.`);
    return;
  }

  console.error(`verify-assets: ${violations.length} violation(s) — see docs/BRAND-ASSETS.md\n`);
  for (const violation of violations) {
    console.error(`  [${violation.rule}] ${violation.where}`);
    console.error(`      ${violation.detail}`);
  }
  console.error('');
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
