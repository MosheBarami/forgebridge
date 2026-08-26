import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXEMPT_FILES, scanText, verifyNoSecrets, type SecretRule } from '../verify-no-secrets.js';

/**
 * The gate's own tests.
 *
 * ADR-013 is one-way, so this gate is the last thing between a credential and a
 * public remote — and a gate that cannot fail is decoration. Every rule below is
 * shown rejecting a violating fixture *and* accepting the legitimate shape it is
 * most likely to be confused with, because the second half is what stops the
 * first from being switched off.
 *
 * The credential-shaped fixtures are assembled from parts. A test that contained
 * a literal `sk-…` would be caught by the gate it is testing, which is exactly
 * the right behaviour and exactly the wrong way to write the test.
 */

let root: string;

function write(rel: string, contents: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function rulesFor(text: string): SecretRule[] {
  return scanText('fixture.ts', text).map((finding) => finding.rule);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fb-secrets-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('S1 — credential-shaped literals', () => {
  it.each([
    ['OpenAI-style key', `const k = "${'sk-'}${'A'.repeat(24)}";`],
    ['GitHub token', `const k = "${'ghp_'}${'b'.repeat(36)}";`],
    ['AWS access key id', `const k = "${'AKIA'}${'ABCDEFGHIJKLMNOP'}";`],
    ['Slack token', `const k = "${'xoxb-'}${'1234567890-abcdefghij'}";`],
    ['Google API key', `const k = "${'AIza'}${'a'.repeat(35)}";`],
    ['Stripe live key', `const k = "${'sk_live_'}${'c'.repeat(24)}";`],
    ['JWT bearer', `const k = "${'eyJhbGciOiJIUzI1NiJ9'}.${'eyJzdWIiOiIxMjM0NSJ9'}.${'sig'}";`],
    ['PEM private key', `${'-----BEGIN'} ${'RSA'} ${'PRIVATE KEY-----'}`],
  ])('catches a %s', (_name, fixture) => {
    expect(rulesFor(fixture)).toContain('S1');
  });

  it('does not fire on a checksum or an npm integrity field', () => {
    expect(rulesFor('"sha256": "0000000000000000000000000000000000000000000000000000000000000000"')).toEqual([]);
    expect(rulesFor('"integrity": "sha512-abcdefghijklmnopqrstuvwxyz0123456789=="')).toEqual([]);
  });
});

describe('S2 — credential-named assignments', () => {
  it('catches a password assigned a real-looking literal', () => {
    expect(rulesFor(`const password = "${'hunter2'}${'Qx91zLp4'}";`)).toContain('S2');
  });

  it('catches a client secret in a config object', () => {
    expect(rulesFor(`{ "client_secret": "${'aB3xY9k2Lp71vR'}" }`)).toContain('S2');
  });

  it('allows an explicit placeholder', () => {
    expect(rulesFor('const apiKey = "<your-api-key-here>";')).toEqual([]);
    expect(rulesFor('API_KEY=changeme-0000-0000')).toEqual([]);
    expect(rulesFor('const apiKey = process.env.OPENAI_API_KEY ?? "";')).toEqual([]);
  });

  it('allows a type annotation, which is not an assignment at all', () => {
    // The first draft of this rule read `sessionKey: Uint8Array` as an
    // assignment and reported thirty findings on a clean repository.
    expect(rulesFor('  sessionKey: Uint8Array;')).toEqual([]);
    expect(rulesFor('  apiKey: z.string().min(1),')).toEqual([]);
    expect(rulesFor("export type SecretsBackendKind = 'keychain' | 'file';")).toEqual([]);
  });

  it('allows an identifier that names a credential without being one', () => {
    // The same distinction verify-no-key-storage.ts draws for `sessionKeyId`.
    expect(rulesFor(`const sessionKeyId = "${'01H8XYZ0123456789'}";`)).toEqual([]);
    expect(rulesFor(`const apiKeyHeader = "${'x-forgebridge-key01'}";`)).toEqual([]);
  });
});

describe('S3 — machine-local absolute paths', () => {
  it('catches a maintainer home directory', () => {
    const findings = scanText('docs/X.md', 'the repo lives at /Users/somebody/projects/thing');
    expect(findings.map((f) => f.rule)).toContain('S3');
    expect(findings[0]?.detail).toContain('/Users/somebody');
  });

  it('catches a Windows profile directory', () => {
    expect(rulesFor('C:\\Users\\somebody\\forgebridge')).toContain('S3');
  });

  it('allows the CI runner home, which is generic and not anybody', () => {
    expect(rulesFor('working-directory: /home/runner/work/forgebridge')).toEqual([]);
    expect(rulesFor('WORKDIR /home/node/app')).toEqual([]);
  });

  it('reports the line number so the finding is actionable', () => {
    const findings = scanText('docs/X.md', 'clean\nclean\n/Users/somebody/x\n');
    expect(findings[0]?.line).toBe(3);
  });
});

describe('S4 — committed environment files', () => {
  it('catches a .env and a .env.local', () => {
    write('.env', 'TOKEN=abc\n');
    write('apps/web/.env.local', 'TOKEN=abc\n');
    const rules = verifyNoSecrets(root).map((f) => f.rule);
    expect(rules.filter((r) => r === 'S4')).toHaveLength(2);
  });

  it('allows the committed template', () => {
    write('.env.example', 'OPENAI_API_KEY=\n');
    expect(verifyNoSecrets(root)).toEqual([]);
  });
});

describe('the scan itself', () => {
  it('walks nested directories and skips node_modules', () => {
    write('src/deep/nested/config.ts', 'const p = "/Users/somebody/x";\n');
    write('node_modules/pkg/index.js', 'const p = "/Users/somebody/x";\n');
    const files = verifyNoSecrets(root).map((f) => f.file);
    expect(files).toEqual(['src/deep/nested/config.ts']);
  });

  it('skips binary files rather than decoding them as text', () => {
    const abs = path.join(root, 'logo.png');
    writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    expect(verifyNoSecrets(root)).toEqual([]);
  });

  it('names its exemptions rather than hiding them', () => {
    // The gate cannot scan the file that has to contain every pattern it looks
    // for. That is defensible only while the exemption is visible and small.
    expect(EXEMPT_FILES).toContain('scripts/verify-no-secrets.ts');
    expect(EXEMPT_FILES.length).toBeLessThanOrEqual(3);
  });
});

describe('the repository this gate ships in', () => {
  it('is clean', () => {
    // ADR-013 has no revisit trigger. This assertion is the reason the ADR's
    // mitigation sentence is now true.
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    expect(verifyNoSecrets(repoRoot)).toEqual([]);
  });
});
