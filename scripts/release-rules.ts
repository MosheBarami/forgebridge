/**
 * The release gate: the rules that decide whether this tree can be released,
 * and the rules that keep `.github/workflows/release.yml` from being able to
 * half-publish.
 *
 * Two families, one file, because they answer halves of the same question.
 *
 *   R1–R5  the *workflow* is shaped so that a partial release cannot happen —
 *          no automatic trigger, every publish gated, every credential checked
 *          before any of them is used.
 *   V1–V4  the *tree* agrees with itself about what version it is, and the
 *          release notes for that version exist.
 *
 * Every rule is a pure function over text so that `__tests__/release.test.ts`
 * can hand it a planted violation and prove it rejects one. A gate that cannot
 * fail is decoration — the standard `verify-boundaries.ts` set here first.
 *
 * ── On the word "changeset" ──────────────────────────────────────────────────
 *
 * M49 asks for "a changeset-style flow", and the obvious reading is the npm
 * `changesets` tool. This repository does not use that name for this, and the
 * reason is not taste: `ChangeSet` is already the central noun of
 * `packages/protocol` — ADR-003 is titled *changeset as unit of work* — and it
 * means a set of Roblox instance operations awaiting approval. A directory of
 * files called changesets that are release notes, next to a protocol type
 * called ChangeSet that is not, is a collision every future reader pays for.
 *
 * So the flow is the same shape under a different name: one markdown file per
 * user-visible change under `.changes/`, each declaring the bump it implies,
 * accumulated between releases and folded into `CHANGELOG.md` when one is cut.
 */

export interface ReleaseViolation {
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'V1' | 'V2' | 'V3' | 'V4';
  file: string;
  detail: string;
}

export const RELEASE_RULE_TEXT: Record<ReleaseViolation['rule'], string> = {
  R1: 'the release workflow has no automatic trigger',
  R2: 'every publishing job depends on the preflight job',
  R3: 'every publishing job is gated on the `publish` input',
  R4: 'the preflight checks every credential any publishing job uses',
  R5: 'the release that announces a version depends on every publish succeeding',
  V1: 'the requested version is semver',
  V2: 'every manifest in the tree carries the requested version',
  V3: 'CHANGELOG.md has a section for the requested version',
  V4: 'a release has at least one entry under .changes/ to account for',
};

function push(out: ReleaseViolation[], rule: ReleaseViolation['rule'], file: string, detail: string): void {
  out.push({ rule, file, detail });
}

// ── reading the workflow ─────────────────────────────────────────────────────

/**
 * A very small YAML reader, scoped to exactly what these rules need: the `on:`
 * keys, and each job's name, `needs:`, `if:` and step bodies.
 *
 * Hand-rolled rather than pulled in, for the reason the whole `scripts/`
 * directory is: this repository's dependency budget is deliberate, and a gate
 * whose own dependency tree is larger than the thing it checks is a gate nobody
 * audits. The parser is indentation-based and refuses nothing — it is used only
 * to locate blocks, and every rule below also reads the raw text, so a shape it
 * fails to understand cannot silently satisfy a rule.
 */
export interface WorkflowJob {
  id: string;
  /** The job's block, verbatim, including its own header line. */
  text: string;
  needs: string[];
  /** The job-level `if:` expression, or ''. */
  condition: string;
}

export interface ParsedWorkflow {
  /** Top-level keys under `on:`, e.g. ['workflow_dispatch']. */
  triggers: string[];
  jobs: WorkflowJob[];
}

export function parseWorkflow(text: string): ParsedWorkflow {
  const lines = text.split('\n');
  const triggers: string[] = [];
  const jobs: WorkflowJob[] = [];

  const blockOf = (start: number, indent: number): string => {
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end] ?? '';
      if (line.trim() !== '' && !/^\s*#/.test(line) && leading(line) <= indent) break;
      end += 1;
    }
    return lines.slice(start, end).join('\n');
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^on:\s*$/.test(line) || /^on:\s*\S/.test(line)) {
      const inline = /^on:\s*(\S.*)$/.exec(line);
      if (inline?.[1]) {
        for (const name of inline[1].replace(/[[\]]/g, '').split(',')) {
          if (name.trim() !== '') triggers.push(name.trim());
        }
      } else {
        for (const child of blockOf(i, 0).split('\n').slice(1)) {
          const key = /^  ([a-z_]+):/.exec(child);
          if (key?.[1]) triggers.push(key[1]);
        }
      }
    }
    if (/^jobs:\s*$/.test(line)) {
      const body = blockOf(i, 0).split('\n');
      for (let j = 1; j < body.length; j += 1) {
        const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(body[j] ?? '');
        if (!header?.[1]) continue;
        const absolute = i + j;
        const jobText = blockOf(absolute, 2);
        jobs.push({
          id: header[1],
          text: jobText,
          needs: readNeeds(jobText),
          condition: readCondition(jobText),
        });
      }
    }
  }

  return { triggers, jobs };
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

function readNeeds(jobText: string): string[] {
  const inline = /^\s{4}needs:\s*\[([^\]]*)\]/m.exec(jobText);
  if (inline?.[1] !== undefined) {
    return inline[1]
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  const single = /^\s{4}needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(jobText);
  if (single?.[1]) return [single[1]];
  const list = /^\s{4}needs:\s*\n((?:\s{6}-\s*[A-Za-z0-9_-]+\s*\n?)+)/m.exec(jobText);
  if (list?.[1]) {
    return [...list[1].matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1] ?? '');
  }
  return [];
}

function readCondition(jobText: string): string {
  return /^\s{4}if:\s*(.+)$/m.exec(jobText)?.[1]?.trim() ?? '';
}

/**
 * Comment lines removed, so that a job is judged by what it runs rather than by
 * what it says about itself.
 *
 * This is not a nicety. The `build` job's comment explains that `npm pack`
 * produces what `npm publish` would upload — and with comments included, that
 * sentence made the build job look like a publishing job and R3 reported it as
 * an ungated publish. A rule that fires on a true sentence in a correct file is
 * a rule somebody deletes.
 */
export function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Jobs whose steps publish to a public registry. Detected by what they run, not by their name. */
const PUBLISH_MARKERS: readonly RegExp[] = [
  /npm\s+publish\b/,
  /gh-action-pypi-publish@/,
  /twine\s+upload\b/,
  /\buv\s+publish\b/,
];

export function isPublishingJob(job: WorkflowJob): boolean {
  const code = withoutComments(job.text);
  return PUBLISH_MARKERS.some((marker) => marker.test(code));
}

/** The job every publishing job must depend on. Found by what it does, not by being called "preflight". */
export function preflightJobId(workflow: ParsedWorkflow): string | null {
  const candidates = workflow.jobs.filter((job) => {
    if (isPublishingJob(job)) return false;
    const code = withoutComments(job.text);
    return /missing|secrets\./.test(code) && /exit 1/.test(code);
  });
  return candidates[0]?.id ?? null;
}

// ── R1: no automatic trigger ─────────────────────────────────────────────────

/** Triggers that would let a release start without a person choosing to start one. */
const AUTOMATIC_TRIGGERS = new Set(['push', 'release', 'schedule', 'create', 'pull_request', 'repository_dispatch']);

export function checkManualOnly(path: string, workflow: ParsedWorkflow): ReleaseViolation[] {
  const out: ReleaseViolation[] = [];
  for (const trigger of workflow.triggers) {
    if (!AUTOMATIC_TRIGGERS.has(trigger)) continue;
    push(
      out,
      'R1',
      path,
      `\`on: ${trigger}\` would start a release without a person choosing to. ` +
        'A tag can be pushed by accident; a publish to two public registries cannot be taken back.',
    );
  }
  if (!workflow.triggers.includes('workflow_dispatch')) {
    push(out, 'R1', path, 'no `workflow_dispatch` trigger, so this workflow cannot be started deliberately either');
  }
  return out;
}

// ── R2/R3/R5: the publish jobs are gated ─────────────────────────────────────

export function checkPublishGating(path: string, workflow: ParsedWorkflow): ReleaseViolation[] {
  const out: ReleaseViolation[] = [];
  const preflight = preflightJobId(workflow);
  const publishing = workflow.jobs.filter(isPublishingJob);

  if (publishing.length === 0) {
    // Fail closed. "I found no publishing job" and "every publishing job is
    // correctly gated" must not be the same answer — that is the exact shape
    // every bypass this repository has found so far took.
    push(out, 'R2', path, 'no publishing job was recognised in this workflow, so none of R2, R3 or R5 could be decided');
    return out;
  }

  if (preflight === null) {
    push(out, 'R2', path, 'no preflight job was recognised — no job checks credentials and exits non-zero');
    return out;
  }

  for (const job of publishing) {
    if (!job.needs.includes(preflight)) {
      push(out, 'R2', path, `job "${job.id}" publishes without depending on "${preflight}"`);
    }
    if (!/inputs\.publish/.test(job.condition)) {
      push(out, 'R3', path, `job "${job.id}" publishes without an \`if:\` gated on the publish input`);
    }
  }

  // R5: whatever announces the release must wait for every publish. A GitHub
  // release created while one registry rejected the version is a tag blessing a
  // state that does not exist.
  const announcing = workflow.jobs.filter(
    (job) => !isPublishingJob(job) && /action-gh-release@|gh release create/.test(withoutComments(job.text)),
  );
  for (const job of announcing) {
    const missing = publishing.map((p) => p.id).filter((id) => !job.needs.includes(id));
    if (missing.length > 0) {
      push(
        out,
        'R5',
        path,
        `job "${job.id}" announces the release without depending on ${missing.join(', ')}`,
      );
    }
  }

  return out;
}

// ── R4: the preflight checks every credential the publishes use ──────────────

/** Every `secrets.X` and `vars.X` referenced anywhere in the workflow. */
export function referencedCredentials(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[2] ?? '';
    // GITHUB_TOKEN is minted per run by Actions; there is nothing to configure
    // and nothing for a preflight to find missing.
    if (name === 'GITHUB_TOKEN') continue;
    found.add(`${match[1]}.${name}`);
  }
  return [...found].sort();
}

export function checkCredentialPreflight(path: string, workflow: ParsedWorkflow): ReleaseViolation[] {
  const out: ReleaseViolation[] = [];
  const preflightId = preflightJobId(workflow);
  const preflight = workflow.jobs.find((job) => job.id === preflightId);
  if (preflight === undefined) {
    push(out, 'R4', path, 'no preflight job was recognised, so no credential check could be found');
    return out;
  }

  const usedByPublishers = new Set(
    workflow.jobs.filter(isPublishingJob).flatMap((job) => referencedCredentials(withoutComments(job.text))),
  );
  const checked = new Set(referencedCredentials(withoutComments(preflight.text)));

  for (const credential of [...usedByPublishers].sort()) {
    if (checked.has(credential)) continue;
    push(
      out,
      'R4',
      path,
      `${credential} is used by a publishing job and is not checked by "${preflight.id}". ` +
        'Discovering it is missing after the first registry has accepted the version is the failure this rule exists for.',
    );
  }
  return out;
}

// ── V1–V4: the tree agrees with itself ───────────────────────────────────────

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface VersionedFile {
  /** Repository-relative path. */
  path: string;
  /** The version it declares, or null when the file has none this reader can find. */
  version: string | null;
}

export function checkVersion(version: string, files: readonly VersionedFile[]): ReleaseViolation[] {
  const out: ReleaseViolation[] = [];
  if (!SEMVER.test(version)) {
    push(out, 'V1', 'input', `"${version}" is not a semver version`);
    return out;
  }
  if (files.length === 0) {
    push(out, 'V2', 'tree', 'no versioned file was found, so V2 could not be decided');
    return out;
  }
  for (const file of files) {
    if (file.version === version) continue;
    push(
      out,
      'V2',
      file.path,
      file.version === null
        ? 'declares no version this check could read'
        : `declares ${file.version}, and this release is ${version}`,
    );
  }
  return out;
}

/**
 * The CHANGELOG section for a version.
 *
 * Sections are `## <version> — <date>` or `## [<version>] - <date>`; both
 * spellings are accepted because both are in the wild and neither is worth an
 * argument. Returns the body, or null.
 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?\\b`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end] ?? '')) end += 1;
  return lines.slice(start, end).join('\n').trim();
}

export function checkChangelog(version: string, changelog: string): ReleaseViolation[] {
  const section = changelogSection(changelog, version);
  if (section === null) {
    return [{ rule: 'V3', file: 'CHANGELOG.md', detail: `has no section for ${version}` }];
  }
  const body = section.split('\n').slice(1).join('\n').trim();
  if (body === '') {
    return [
      {
        rule: 'V3',
        file: 'CHANGELOG.md',
        detail: `the section for ${version} is empty — a release with no described changes is a release nobody can review`,
      },
    ];
  }
  return [];
}

/** The bumps a `.changes/` entry may declare. */
export type Bump = 'major' | 'minor' | 'patch';

export interface ChangeEntry {
  path: string;
  bump: Bump | null;
  summary: string;
}

/**
 * Read one `.changes/` entry.
 *
 * The format is one line of `bump: patch|minor|major`, then prose. Anything
 * else leaves `bump` null, which V4 reports — an entry whose bump nobody can
 * read cannot be folded into a version number, and guessing "patch" is how a
 * breaking change ships as one.
 */
export function readChangeEntry(path: string, text: string): ChangeEntry {
  const bump = /^bump:\s*(major|minor|patch)\s*$/m.exec(text)?.[1] as Bump | undefined;
  const summary = text
    .split('\n')
    .filter((line) => !/^bump:/.test(line) && line.trim() !== '')
    .join(' ')
    .trim();
  return { path, bump: bump ?? null, summary };
}

/** The largest bump any entry asks for. Null when there are no readable entries. */
export function requiredBump(entries: readonly ChangeEntry[]): Bump | null {
  if (entries.some((entry) => entry.bump === 'major')) return 'major';
  if (entries.some((entry) => entry.bump === 'minor')) return 'minor';
  if (entries.some((entry) => entry.bump === 'patch')) return 'patch';
  return null;
}

export function nextVersion(current: string, bump: Bump): string {
  const match = SEMVER.exec(current);
  if (match === null) throw new Error(`"${current}" is not a semver version`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function checkChangeEntries(entries: readonly ChangeEntry[]): ReleaseViolation[] {
  const out: ReleaseViolation[] = [];
  if (entries.length === 0) {
    push(out, 'V4', '.changes/', 'a release needs at least one entry describing what changed');
    return out;
  }
  for (const entry of entries) {
    if (entry.bump === null) {
      push(out, 'V4', entry.path, 'declares no readable `bump:` line, so the version it implies cannot be computed');
    }
    if (entry.summary === '') {
      push(out, 'V4', entry.path, 'has a bump and no prose — the CHANGELOG entry it becomes would be blank');
    }
  }
  return out;
}
