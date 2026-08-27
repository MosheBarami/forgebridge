/**
 * The rules that keep the security workflows honest.
 *
 * `.github/workflows/` gained four jobs at M42 — CodeQL, Semgrep, dependency
 * review and SBOM — and each of them is a claim in `docs/THREAT-MODEL.md` T6.
 * The repository already has a gate for "a document claims a tool runs in CI"
 * (`docs-claims-rules.ts` rule D2). What it did not have is the converse and
 * the mechanics: that the workflows themselves are pinned, least-privileged,
 * that the scanner they install is a version somebody chose, that the Semgrep
 * rules are self-tested before they are trusted, and that a workflow which
 * exists is a workflow the threat model names.
 *
 * Six rules, expressed as pure functions over file contents so that each one can
 * be handed a planted violation and shown to reject it — the standard
 * `verify-boundaries.ts` and `verify-no-secrets.ts` already set here. A gate
 * that cannot fail is decoration.
 *
 *   W1  every `uses:` is pinned to a tag or a commit           — a floating
 *                                                                `@main` is
 *                                                                someone else's
 *                                                                write access to
 *                                                                this repository.
 *   W2  every workflow declares top-level `permissions:`       — the default is
 *                                                                whatever the
 *                                                                repository
 *                                                                setting says,
 *                                                                which is not a
 *                                                                decision this
 *                                                                file made.
 *   W3  every `pip install` names an exact version             — a scanner that
 *                                                                floats is a
 *                                                                dependency
 *                                                                nobody pinned,
 *                                                                in the workflow
 *                                                                whose subject is
 *                                                                supply chain.
 *   W4  every Semgrep rule has a planted violation *and* a     — rule 3 and rule
 *       control in the fixtures                                  4, made
 *                                                                mechanical.
 *   W5  the Semgrep workflow self-tests before it scans, and   — a rule set
 *       excludes the fixtures from the scan                      whose self-test
 *                                                                never runs is
 *                                                                decoration; a
 *                                                                scan that reads
 *                                                                its own planted
 *                                                                violations is
 *                                                                noise.
 *   W6  the threat model names every workflow that exists      — T6 has already
 *                                                                had to be
 *                                                                corrected once
 *                                                                for describing
 *                                                                jobs that did
 *                                                                not run.
 *
 * These are checked by `scripts/__tests__/security-workflows.test.ts`, which the
 * `Gate self-tests` step in `.github/workflows/ci.yml` already runs — it invokes
 * `vitest --dir scripts`, so a rule added here needs no change to that file.
 */

export interface WorkflowFile {
  /** Repository-relative, forward-slashed: `.github/workflows/codeql.yml`. */
  path: string;
  text: string;
}

export interface WorkflowViolation {
  rule: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6';
  file: string;
  /** 1-indexed. 0 for a whole-file finding. */
  line: number;
  detail: string;
}

export const WORKFLOW_RULE_TEXT: Record<WorkflowViolation['rule'], string> = {
  W1: 'unpinned action reference',
  W2: 'workflow without an explicit top-level permissions block',
  W3: 'pip install without an exact version',
  W4: 'Semgrep rule without both a planted violation and a control',
  W5: 'Semgrep workflow that does not self-test, or that scans its own fixtures',
  W6: 'workflow the threat model does not name',
};

function push(
  out: WorkflowViolation[],
  rule: WorkflowViolation['rule'],
  file: string,
  line: number,
  detail: string,
): void {
  out.push({ rule, file, line, detail });
}

/** `# …` to end of line, outside quotes. Good enough for `uses:` and `run:` lines. */
function stripComment(line: string): string {
  const at = line.indexOf('#');
  return at === -1 ? line : line.slice(0, at);
}

// ────────────────────────────────── W1: pinned actions ──────────────────────────────────

/**
 * A reference this rule accepts: `owner/repo@v4`, `owner/repo/path@v4.2.1`, or
 * `owner/repo@<40 hex>`.
 *
 * A full commit SHA is the stronger form — a tag can be moved, a commit cannot —
 * and this rule deliberately accepts both rather than demanding the stronger
 * one. Demanding SHAs would mean every Dependabot bump to these workflows is a
 * hand-edit, and a rule that makes the maintained thing painful gets the
 * treatment every such rule gets. TODO(M42): move to SHA pins with a bot that
 * keeps them current, which is a decision about tooling a human should make.
 */
const PINNED = /@(?:v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/;

export function checkActionPins(files: readonly WorkflowFile[]): WorkflowViolation[] {
  const out: WorkflowViolation[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((raw, index) => {
      const match = /^\s*-?\s*uses:\s*(\S+)/.exec(stripComment(raw));
      const reference = match?.[1];
      if (!reference) return;
      // A local composite action and a Docker reference are pinned by other
      // means — the tree itself, and the image digest — and are out of scope
      // rather than silently accepted: neither exists in this repository, and a
      // rule that pretended to check them would be claiming reach it lacks.
      if (reference.startsWith('./') || reference.startsWith('docker://')) return;
      if (PINNED.test(reference)) return;
      push(
        out,
        'W1',
        file.path,
        index + 1,
        `"${reference}" is not pinned; use owner/repo@vN or owner/repo@<40-char commit sha>`,
      );
    });
  }
  return out;
}

// ─────────────────────────────── W2: explicit permissions ───────────────────────────────

export function checkPermissions(files: readonly WorkflowFile[]): WorkflowViolation[] {
  const out: WorkflowViolation[] = [];
  for (const file of files) {
    const hasTopLevel = file.text.split('\n').some((line) => /^permissions:/.test(line));
    if (hasTopLevel) continue;
    push(
      out,
      'W2',
      file.path,
      0,
      'no top-level `permissions:` block; declare the token scope this workflow needs ' +
        'rather than inheriting whatever the repository default happens to be',
    );
  }
  return out;
}

// ──────────────────────────── W3: pinned scanner installs ────────────────────────────

/**
 * Arguments that are not a package specifier: flags, and the editable-install
 * path form `pip install -e "packages/sdk-python[dev]"` that `ci.yml` uses to
 * put the Python SDK on the path. A local path has no version to pin.
 */
function isPackageSpecifier(token: string): boolean {
  if (token.startsWith('-')) return false;
  if (token.includes('/') || token.startsWith('.')) return false;
  return /^[A-Za-z][A-Za-z0-9._-]*/.test(token);
}

export function checkPipPins(files: readonly WorkflowFile[]): WorkflowViolation[] {
  const out: WorkflowViolation[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((raw, index) => {
      const line = stripComment(raw);
      if (!/\bpip\s+install\b/.test(line)) return;
      const after = line.slice(line.indexOf('install') + 'install'.length);
      let editable = false;
      for (const token of after.split(/\s+/)) {
        const cleaned = token.replace(/^["']|["']$/g, '').trim();
        if (cleaned === '') continue;
        if (cleaned === '-e' || cleaned === '--editable') {
          editable = true;
          continue;
        }
        if (!isPackageSpecifier(cleaned)) continue;
        if (editable) continue;
        if (cleaned.includes('==')) continue;
        push(
          out,
          'W3',
          file.path,
          index + 1,
          `"${cleaned}" is installed without an exact version; pin it with == so the scanner ` +
            'that gates a merge is the scanner somebody chose',
        );
      }
    });
  }
  return out;
}

// ───────────────────── W4: every Semgrep rule is planted and controlled ─────────────────────

/** `  - id: forgebridge-fail-open-catch` in a Semgrep rules file. */
export function semgrepRuleIds(rulesYaml: string): string[] {
  return [...rulesYaml.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)]
    .map((match) => match[1] ?? '')
    .filter((id) => id !== '');
}

export function checkSemgrepFixtures(
  rulesFile: WorkflowFile,
  fixture: WorkflowFile,
): WorkflowViolation[] {
  const out: WorkflowViolation[] = [];
  const ids = semgrepRuleIds(rulesFile.text);
  if (ids.length === 0) {
    push(out, 'W4', rulesFile.path, 0, 'declares no rules; a rules file with nothing in it is not a scan');
    return out;
  }
  for (const id of ids) {
    // Word-boundary anchored so `forgebridge-fail-open-catch` is not satisfied
    // by an annotation for a longer id that happens to start with it.
    const planted = new RegExp(`//\\s*ruleid:\\s*${escapeForRegExp(id)}\\s*$`, 'm').test(fixture.text);
    const control = new RegExp(`//\\s*ok:\\s*${escapeForRegExp(id)}\\s*$`, 'm').test(fixture.text);
    if (!planted) {
      push(
        out,
        'W4',
        fixture.path,
        0,
        `no "// ruleid: ${id}" annotation; the rule has never been shown to reject anything`,
      );
    }
    if (!control) {
      push(
        out,
        'W4',
        fixture.path,
        0,
        `no "// ok: ${id}" annotation; the rule has never been shown to leave the legitimate ` +
          'shape it is most confusable with alone',
      );
    }
  }
  return out;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ───────────────── W5: the Semgrep workflow self-tests, and skips its fixtures ─────────────────

export function checkSemgrepWorkflow(
  workflow: WorkflowFile,
  fixtureDir: string,
): WorkflowViolation[] {
  const out: WorkflowViolation[] = [];
  const text = workflow.text;

  const testIndex = text.indexOf('--test');
  if (testIndex === -1) {
    push(
      out,
      'W5',
      workflow.path,
      0,
      'never runs `semgrep --test`; rules nobody proved can reject anything are decoration',
    );
  }

  // The scanning invocation is the one carrying `--error`: `--test` exits
  // non-zero on its own and does not take that flag.
  const scanIndex = text.indexOf('--error');
  if (scanIndex === -1) {
    push(
      out,
      'W5',
      workflow.path,
      0,
      'the scan does not pass `--error`, so semgrep would report findings and exit 0',
    );
  }

  if (testIndex !== -1 && scanIndex !== -1 && testIndex > scanIndex) {
    push(
      out,
      'W5',
      workflow.path,
      0,
      'scans before it self-tests; prove the rules can fail before trusting what they say',
    );
  }

  if (scanIndex !== -1 && !new RegExp(`--exclude\\s+["']?${escapeForRegExp(fixtureDir)}`).test(text)) {
    push(
      out,
      'W5',
      workflow.path,
      0,
      `the scan does not \`--exclude ${fixtureDir}\`; it would report the planted violations ` +
        'in its own fixtures and fail every run',
    );
  }

  return out;
}

// ─────────────────── W6: the threat model names every workflow that exists ───────────────────

export function checkThreatModelNamesWorkflows(
  threatModel: string,
  workflowFiles: readonly string[],
): WorkflowViolation[] {
  const out: WorkflowViolation[] = [];
  for (const file of workflowFiles) {
    const name = file.split('/').pop() ?? file;
    if (threatModel.includes(name)) continue;
    push(
      out,
      'W6',
      'docs/THREAT-MODEL.md',
      0,
      `T6 does not name ${name}. A job that runs and is not in the threat model is a control ` +
        'nobody can audit; a job the threat model describes and that does not run is the ' +
        'defect T6 has already been corrected for once.',
    );
  }
  return out;
}
