/**
 * Publication gate — the CI half of ADR-013.
 *
 * ADR-013 is the one decision in this repository with no revisit trigger: "once
 * anything is pushed publicly it cannot be revisited." Its stated mitigation was
 * that a secret scanner runs on the first commit and on every commit after. That
 * sentence was true of the intent and false of the repository — nothing ran. A
 * one-way decision defended by a check nobody wrote is the same shape of defect
 * as a promise defended by a test nobody wrote, and it is the one where being
 * wrong cannot be undone.
 *
 * Four rules, each one a way something unrecallable reaches a public remote:
 *
 *   S1  no credential-shaped literal          — provider key prefixes, PEM private
 *                                               key blocks, JWTs. Deterministic
 *                                               shapes, matched literally.
 *   S2  no credential-named assignment with   — `apiKey = "…"`, `"secret": "…"`,
 *       a real-looking literal value            `PASSWORD=…`. Placeholders are
 *                                               allowed and are recognised as such.
 *   S3  no machine-local absolute path        — a public repo should not carry the
 *                                               maintainer's home directory, their
 *                                               account name, or the location of a
 *                                               private predecessor repo.
 *   S4  no committed environment file         — `.env*` is gitignored, but a gate
 *                                               that only trusts `.gitignore` is
 *                                               trusting the file most often edited
 *                                               in a hurry. `.env.example` is fine.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 *
 * This is not `gitleaks`, and it does not read git history. It scans the working
 * tree — which for this repository is the whole risk surface, because ADR-013's
 * whole point is that the history begins empty. A history scanner is still worth
 * having before the second commit; see the TODO in ADR-013 for what a human has
 * to decide first (a pinned action version and its provenance).
 *
 * ── Why the entropy heuristic is deliberately narrow ─────────────────────────
 *
 * A generic "long random-looking string" rule fires on checksums, lockfile
 * integrity hashes, base64 test fixtures and minified output, and a gate that
 * cries wolf is a gate someone adds an ignore file to. So S2 requires two things
 * at once: a name that says credential, and a value that does not look like a
 * placeholder. Everything the repository legitimately contains — the `0000…`
 * checksum placeholders in the brand manifest, `package-lock.json` integrity
 * fields — fails one of those halves and is not reported.
 *
 * Run:  npm run verify:no-secrets
 * Exit: 0 clean, 1 with one line per finding.
 */
import { closeSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SecretRule = 'S1' | 'S2' | 'S3' | 'S4';

export interface SecretFinding {
  rule: SecretRule;
  file: string;
  /** 1-indexed, so the output can be pasted into an editor. 0 for whole-file findings. */
  line: number;
  detail: string;
}

export const RULE_TEXT: Record<SecretRule, string> = {
  S1: 'credential-shaped literal',
  S2: 'credential-named assignment with a real-looking value',
  S3: 'machine-local absolute path',
  S4: 'committed environment file',
};

/**
 * Build output and vendored trees. Nothing here is authored, so a hit in one of
 * them is a finding about a generator rather than about this repository.
 *
 * `.next` and `out` join the list for the web app: `next build` writes the
 * absolute path of the machine that ran it into its generated route types, and
 * S3 is right to call that a machine-local path — it is simply not our file.
 * Every name here is already in a `.gitignore`, which is the same judgement
 * made twice; a gate that scanned them would fail on any developer's laptop the
 * moment they built.
 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.turbo', '.git', '.venv', '__pycache__',
  '.next', 'out',
]);

/**
 * Files exempt from the scan, by exact repo-relative path.
 *
 * This gate and its tests have to contain the shapes they search for. Rather
 * than obfuscate every pattern so the file does not match itself — which makes
 * the patterns unreadable, and unreadable security rules are how a rule stops
 * being maintained — the two files are named here and the exemption is printed
 * on every run. `package-lock.json` is exempt because npm's `integrity` fields
 * are base64 by design and there is no key material in a lockfile.
 */
export const EXEMPT_FILES: readonly string[] = [
  'scripts/verify-no-secrets.ts',
  'scripts/__tests__/verify-no-secrets.test.ts',
  'package-lock.json',
];

/**
 * S1: literal shapes that are a credential or nothing.
 *
 * Every entry here is a published, documented prefix or delimiter. Nothing is
 * guessed: a pattern that might match a credential is S2's job, not S1's.
 */
const CREDENTIAL_LITERALS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'GitLab personal access token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: 'SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'Supabase/JWT bearer', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'PEM private key block', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'PEM OpenSSH private key block', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
];

/** S2: names that say "this value is a credential". */
const CREDENTIAL_NAME = /(?:api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|session[_-]?key|service[_-]?role[_-]?key)/i;

/**
 * S2: names that carry a credential marker without being one. `sessionKeyId`
 * names a key; `apiKeyName` labels one. The same distinction
 * `verify-no-key-storage.ts` draws, kept in step with it by hand — both gates
 * would have to be wrong in the same way for a real key to pass, and the
 * corresponding test fixture in each file makes that visible.
 */
const IDENTIFIER_SUFFIX = /(?:id|name|hash|ref|scope|count|label|prefix|env|var|header|field|column)["']?$/i;

/**
 * S2: values that are obviously not a live credential. A repository that could
 * not write `password: "changeme"` in an example would be a repository whose
 * examples are useless.
 */
const PLACEHOLDER = [
  /^\s*$/,
  /^[<{[]/,                        // <your-key>, {{SECRET}}, [redacted]
  /\$\{/,                          // ${SUPABASE_KEY}
  /process\.env|import\.meta\.env|os\.environ|System\.getenv/,
  /^(?:x{3,}|\.{3,}|\*{3,}|-{3,}|0+|1+)$/i,
  /^(?:your|my|the|some|a)[-_ ]/i,
  /(?:example|placeholder|redacted|changeme|dummy|fake|sample|todo|tbd|none|null|undefined|test[-_]?only)/i,
];

/**
 * S3: `/Users/<who>/`, `/home/<who>/`, `C:\Users\<who>\`. The account names
 * below are the ones a CI runner or a piece of generic documentation genuinely
 * uses; anything else is somebody's actual machine.
 */
const GENERIC_ACCOUNTS = new Set(['runner', 'root', 'ubuntu', 'node', 'user', 'username', 'you', 'me', 'app', 'vscode', 'docker']);
const LOCAL_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g;

/** S4: an env file that is not the committed template. */
function isEnvFile(rel: string): boolean {
  const base = path.basename(rel);
  if (base === '.env.example' || base === '.env.sample' || base === '.env.template') return false;
  return base === '.env' || base.startsWith('.env.');
}

function isProbablyBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 1024);
  return window.includes(0);
}

function walk(dir: string, repoRoot: string, out: string[] = []): string[] {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      walk(abs, repoRoot, out);
    } else if (dirent.isFile()) {
      out.push(path.relative(repoRoot, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER.some((pattern) => pattern.test(value.trim()));
}

/**
 * The second half of S2: does the *value* look like key material?
 *
 * A credential is long and mixes letter classes. A prose default does not:
 * `secretsBackend: 'keychain'` is configuration, `clientSecret: 'aB3xY9k2Lp71'`
 * is a leak. Twelve characters with at least one digit and at least one letter
 * is the line, and it is drawn on the value so that a legitimate enum member,
 * a header name or a URL fragment never trips it.
 */
function looksLikeCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 12) return false;
  if (/\s/.test(trimmed)) return false; // a sentence, not a token
  return /[0-9]/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

/**
 * Scan one file's text. Exported because the fixtures in the test suite are the
 * only honest way to prove each rule rejects something — running the gate over a
 * clean repository proves only that the repository is clean.
 */
export function scanText(rel: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    for (const { name, pattern } of CREDENTIAL_LITERALS) {
      if (pattern.test(line)) {
        findings.push({
          rule: 'S1',
          file: rel,
          line: lineNumber,
          detail: `${name} — this shape is a credential or nothing; rotate it, then remove it`,
        });
      }
    }

    // `apiKey: "…"`, `apiKey = '…'`, `API_KEY=…`. The value must be a *quoted
    // string literal*: `sessionKey: Uint8Array` and `apiKey: z.string()` are a
    // type annotation and a schema, and a version of this rule that read them as
    // assignments reported thirty findings on a clean repository — which is
    // precisely how a gate gets an ignore file and stops being a gate. The value
    // is captured so `looksLikePlaceholder` runs against the value alone: a line
    // that mentions "example" elsewhere must not excuse a live key.
    const assignment = /["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[:=]\s*(["'`])([^"'`\n]{8,})\2/g;
    let match: RegExpExecArray | null;
    while ((match = assignment.exec(line)) !== null) {
      const [, name, , value] = match as unknown as [string, string, string, string];
      if (!CREDENTIAL_NAME.test(name)) continue;
      if (IDENTIFIER_SUFFIX.test(name)) continue;
      if (looksLikePlaceholder(value)) continue;
      if (!looksLikeCredentialValue(value)) continue;
      findings.push({
        rule: 'S2',
        file: rel,
        line: lineNumber,
        detail: `"${name}" is assigned a literal that does not look like a placeholder — use an env var or a placeholder`,
      });
    }

    for (const local of line.matchAll(LOCAL_PATH)) {
      const account = (local[1] ?? '').toLowerCase();
      if (GENERIC_ACCOUNTS.has(account)) continue;
      findings.push({
        rule: 'S3',
        file: rel,
        line: lineNumber,
        detail: `"${local[0]}" names a real account's home directory; describe the location instead of hard-coding this machine's`,
      });
    }
  });

  return findings;
}

export function verifyNoSecrets(repoRoot: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const exempt = new Set(EXEMPT_FILES);

  for (const rel of walk(repoRoot, repoRoot)) {
    if (isEnvFile(rel)) {
      findings.push({
        rule: 'S4',
        file: rel,
        line: 0,
        detail: 'an environment file is present in the tree; it belongs in .gitignore and nowhere else',
      });
      continue;
    }
    if (exempt.has(rel)) continue;

    const abs = path.join(repoRoot, rel);
    // One descriptor, opened once, for both the size and the bytes. `statSync`
    // on a path followed by `readFileSync` on the same path is a check-then-use
    // race (`js/file-system-race`) — and here the check decides whether the
    // gate scans a file at all, so losing that race is a file that skipped the
    // secret scan. `fstatSync` and `readFileSync` on the descriptor are the
    // same file by construction.
    let buffer: Buffer;
    // A path this walk found and cannot now open is not a file with no secrets
    // in it — it is a file this gate did not read. Throwing stops the run with
    // the path named; `continue` would report clean over a gap. There is no
    // `S5` for it on purpose: this is the gate failing, not the tree.
    const handle = openSync(abs, 'r');
    try {
      if (fstatSync(handle).size > 2 * 1024 * 1024) continue;
      buffer = readFileSync(handle);
    } finally {
      closeSync(handle);
    }
    if (isProbablyBinary(buffer)) continue;

    findings.push(...scanText(rel, buffer.toString('utf8')));
  }

  return findings;
}

function main(): void {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const findings = verifyNoSecrets(repoRoot);

  if (findings.length === 0) {
    console.log('verify-no-secrets: ok — S1 S2 S3 S4 all clean.');
    console.log(`  exempt       ${EXEMPT_FILES.join(', ')}`);
    console.log('  not covered  git history (this gate reads the working tree only — see the');
    console.log('               gitleaks TODO in ADR-013), and any credential that is not');
    console.log('               shaped like one and is not named like one.');
    return;
  }

  console.error(
    `verify-no-secrets: ${findings.length} finding(s) — see docs/architecture/adr-013-fresh-public-repo.md\n`,
  );
  for (const finding of findings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  [${finding.rule}: ${RULE_TEXT[finding.rule]}] ${where}`);
    console.error(`      ${finding.detail}`);
  }
  console.error('');
  console.error('ADR-013 has no revisit trigger. Fix this before the push, not after.');
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
