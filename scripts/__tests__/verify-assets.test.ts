import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyAssets } from '../verify-assets.js';

let root: string;

function brands(...segments: string[]): string {
  return path.join(root, 'assets', 'brands', ...segments);
}

function writeAsset(rel: string, contents: string): string {
  const abs = brands(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  return createHash('sha256').update(contents).digest('hex');
}

function writeManifest(manifest: unknown): void {
  writeFileSync(brands('manifest.json'), JSON.stringify(manifest, null, 2));
}

function completeEntry(rel: string, sha: string): Record<string, unknown> {
  return {
    files: [rel],
    sourceUrl: 'https://vendor.invalid/brand',
    retrievedAt: '2026-01-31',
    licence: 'Trademark of Vendor, used nominatively.',
    constraints: 'No recolouring. Not an endorsement.',
    usage: ['model-selector'],
    sha256: { [rel]: sha },
    generated: false,
  };
}

function rules(root_: string): string[] {
  return verifyAssets(root_).map((violation) => violation.rule);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fb-assets-'));
  mkdirSync(brands(), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('verifyAssets', () => {
  it('passes on an empty brands directory with an empty manifest', () => {
    writeManifest({ $about: 'notes only' });
    expect(verifyAssets(root)).toEqual([]);
  });

  it('passes on a complete entry whose checksum matches', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    writeManifest({ vendor: completeEntry('vendor/logo.svg', sha) });
    expect(verifyAssets(root)).toEqual([]);
  });

  it('fails when the manifest is missing entirely', () => {
    expect(rules(root)).toContain('manifest-missing');
  });

  it('fails when a file under assets/brands has no manifest entry', () => {
    writeAsset('vendor/logo.svg', '<svg/>');
    writeManifest({});
    expect(rules(root)).toContain('unmanifested-asset');
  });

  it('fails on an empty sourceUrl, licence or retrievedAt', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    for (const field of ['sourceUrl', 'licence', 'retrievedAt'] as const) {
      writeManifest({ vendor: { ...completeEntry('vendor/logo.svg', sha), [field]: '  ' } });
      expect(rules(root), field).toContain('incomplete-provenance');
    }
  });

  it('fails on a placeholder source URL rather than accepting it as verified', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    writeManifest({
      vendor: { ...completeEntry('vendor/logo.svg', sha), sourceUrl: 'https://example.com/brand' },
    });
    expect(rules(root)).toContain('incomplete-provenance');
  });

  it('fails when a file no longer matches its recorded SHA-256', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    writeManifest({ vendor: completeEntry('vendor/logo.svg', sha) });
    writeAsset('vendor/logo.svg', '<svg>swapped</svg>');
    expect(rules(root)).toContain('checksum-mismatch');
  });

  it('fails when an entry is flagged generated: true', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    writeManifest({ vendor: { ...completeEntry('vendor/logo.svg', sha), generated: true } });
    expect(rules(root)).toContain('generated-asset');
  });

  it('still catches generated: true inside a $-prefixed documentation key', () => {
    // $-keys are skipped for coverage, so they must not become a hiding place.
    writeManifest({ $example: { generated: true } });
    expect(rules(root)).toContain('generated-asset');
  });

  it('does not require the documented $example entry to point at real files', () => {
    writeManifest({
      $example: { files: ['nowhere/logo.svg'], sha256: {}, generated: false },
    });
    expect(verifyAssets(root)).toEqual([]);
  });

  it('fails when the manifest lists a file that is not on disk', () => {
    writeManifest({
      vendor: completeEntry('vendor/logo.svg', 'a'.repeat(64)),
    });
    expect(rules(root)).toContain('manifest-references-missing-file');
  });

  it('fails when two entries claim the same file', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    writeManifest({
      vendor: completeEntry('vendor/logo.svg', sha),
      'vendor-alias': completeEntry('vendor/logo.svg', sha),
    });
    expect(rules(root)).toContain('duplicate-claim');
  });

  it('fails when a checksum is recorded for a file the entry does not list', () => {
    const sha = writeAsset('vendor/logo.svg', '<svg/>');
    const entry = completeEntry('vendor/logo.svg', sha);
    writeManifest({
      vendor: { ...entry, sha256: { ...(entry.sha256 as object), 'vendor/gone.svg': 'b'.repeat(64) } },
    });
    expect(rules(root)).toContain('stale-checksum');
  });

  it('fails when an entry escapes assets/brands with ..', () => {
    writeManifest({
      vendor: { ...completeEntry('../../LICENSE', 'c'.repeat(64)), files: ['../../LICENSE'] },
    });
    expect(rules(root)).toContain('entry-malformed');
  });
});
