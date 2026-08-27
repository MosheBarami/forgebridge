/**
 * Turn a SARIF report into a merge decision.
 *
 * CodeQL uploads its results to the repository's Security tab and, by itself,
 * does not fail anything: the `analyze` action succeeds whether it found one
 * alert or a hundred. A scanner whose output nobody is obliged to read is the
 * same shape of defect as a gate that cannot fail — it looks like a control in
 * a list of controls and blocks nothing. So `.github/workflows/codeql.yml`
 * writes the SARIF to a file as well as uploading it, and this script decides
 * whether the job passes.
 *
 * ── The decision ─────────────────────────────────────────────────────────────
 *
 * A result is **blocking** when either:
 *
 *   - its rule carries `properties["security-severity"]` at or above the
 *     threshold (default 7.0, which is CVSS "high"); or
 *   - no `security-severity` can be resolved for it *and* its SARIF `level` is
 *     `error`, or it has no level at all.
 *
 * The second clause is the fail-closed half and it is the one to read. A result
 * whose severity this script cannot work out has not been shown to be minor; it
 * has not been shown to be anything. Treating "I could not resolve this" as
 * "this is below the threshold" would reproduce, in the gate written to catch
 * the defect, the exact defect this repository keeps finding: a check that
 * recognises nothing and reports a pass.
 *
 * A result at `note` or `warning` level with a resolved severity below the
 * threshold is printed and does not block. That is the fail-noisy half of the
 * bargain (rule 4): every low-severity alert CodeQL raises would otherwise
 * block every pull request, and a gate in that state gets deleted rather than
 * satisfied. Those alerts are still in the Security tab, where the upload put
 * them.
 *
 * ── What is refused outright ─────────────────────────────────────────────────
 *
 * Not-SARIF, unreadable JSON, a version this script does not know, and a report
 * carrying no `runs` at all. The last one matters most: an empty report is what
 * a scan that never ran produces, and "the analysis emitted nothing" and "the
 * analysis found nothing" must not be the same answer. A report with runs and
 * zero results *is* a clean report and passes.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 *
 * It is not a SARIF validator and it does not check the taxonomy, the fixes,
 * the artifacts or the code-flow graphs. It reads `runs[].results[]` and the
 * rule metadata those results point at, and nothing else.
 *
 * Run:  npx tsx scripts/check-sarif.ts <file.sarif> [--threshold 7.0]
 * Exit: 0 clean, 1 with one line per blocking result.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** CVSS 7.0 is the bottom of "high". Chosen here so the number has a source. */
export const DEFAULT_SEVERITY_THRESHOLD = 7.0;

export interface SarifResultSummary {
  ruleId: string;
  /** As reported, or `null` when the report gave none. */
  level: string | null;
  /** Parsed from the rule's `security-severity` property, or null when absent. */
  severity: number | null;
  location: string;
  message: string;
  blocking: boolean;
  /** Why it blocks, or why it does not. Printed either way. */
  reason: string;
}

export interface SarifVerdict {
  /** Thrown-away distinction made explicit: a report that could not be read at all. */
  readable: boolean;
  /** One line, printed on every run, readable or not. */
  summary: string;
  runs: number;
  results: SarifResultSummary[];
  blocking: SarifResultSummary[];
}

interface SarifRule {
  id?: unknown;
  properties?: { 'security-severity'?: unknown } | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Every rule a run declares, by id and by index.
 *
 * Both, because SARIF lets a result point at its rule either way — `ruleId` is
 * the id, `rule.index` is a position in `tool.driver.rules`, and CodeQL uses
 * the first while some extensions use the second. Reading only one of them
 * would leave the other's results with an unresolved severity, which under the
 * rule above blocks them; correct, but noisy for no reason.
 */
function rulesOf(run: Record<string, unknown>): { byId: Map<string, SarifRule>; byIndex: SarifRule[] } {
  const byId = new Map<string, SarifRule>();
  const byIndex: SarifRule[] = [];
  const tool = asRecord(run['tool']);
  const drivers: unknown[] = [];
  if (tool) {
    if (tool['driver']) drivers.push(tool['driver']);
    for (const extension of asArray(tool['extensions'])) drivers.push(extension);
  }
  for (const driver of drivers) {
    const record = asRecord(driver);
    if (!record) continue;
    for (const entry of asArray(record['rules'])) {
      const rule = asRecord(entry);
      if (!rule) continue;
      byIndex.push(rule as SarifRule);
      if (typeof rule['id'] === 'string') byId.set(rule['id'], rule as SarifRule);
    }
  }
  return { byId, byIndex };
}

/**
 * `security-severity` is a *string* in SARIF — "9.8", not 9.8 — because SARIF
 * property bags are untyped and CodeQL writes it that way. A number is accepted
 * too rather than refused, since refusing it would make this gate's behaviour
 * depend on a producer's choice of encoding.
 */
function severityOf(rule: SarifRule | undefined): number | null {
  const raw = rule?.properties?.['security-severity'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function locationOf(result: Record<string, unknown>): string {
  const first = asRecord(asArray(result['locations'])[0]);
  const physical = asRecord(first?.['physicalLocation']);
  const artifact = asRecord(physical?.['artifactLocation']);
  const uri = typeof artifact?.['uri'] === 'string' ? (artifact['uri'] as string) : '(no location)';
  const region = asRecord(physical?.['region']);
  const line = typeof region?.['startLine'] === 'number' ? (region['startLine'] as number) : null;
  return line === null ? uri : `${uri}:${line}`;
}

function messageOf(result: Record<string, unknown>): string {
  const message = asRecord(result['message']);
  const text = message?.['text'];
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : '(no message)';
}

/**
 * The whole decision, as a pure function over parsed JSON, so the self-tests can
 * hand it a planted report rather than run CodeQL.
 */
export function checkSarif(document: unknown, threshold = DEFAULT_SEVERITY_THRESHOLD): SarifVerdict {
  const root = asRecord(document);
  if (!root) {
    return unreadable('the file did not parse as a SARIF object');
  }
  const version = root['version'];
  if (typeof version !== 'string' || !version.startsWith('2.1')) {
    return unreadable(
      `the report declares version ${JSON.stringify(version)}; this gate reads SARIF 2.1.x only`,
    );
  }
  if (!Array.isArray(root['runs']) || root['runs'].length === 0) {
    // The important refusal. This is what a scan that never started produces,
    // and it must not read as a clean bill of health.
    return unreadable('the report contains no runs, so nothing was analysed');
  }

  const results: SarifResultSummary[] = [];
  for (const entry of root['runs']) {
    const run = asRecord(entry);
    if (!run) {
      return unreadable('a run in this report is not an object');
    }
    const { byId, byIndex } = rulesOf(run);
    for (const raw of asArray(run['results'])) {
      const result = asRecord(raw);
      if (!result) continue;

      const ruleId = typeof result['ruleId'] === 'string' ? (result['ruleId'] as string) : '(no rule id)';
      const ruleRef = asRecord(result['rule']);
      const index = typeof ruleRef?.['index'] === 'number' ? (ruleRef['index'] as number) : null;
      const rule = byId.get(ruleId) ?? (index !== null ? byIndex[index] : undefined);
      const severity = severityOf(rule);
      const level = typeof result['level'] === 'string' ? (result['level'] as string) : null;

      let blocking: boolean;
      let reason: string;
      if (severity !== null) {
        blocking = severity >= threshold;
        reason = blocking
          ? `security-severity ${severity} is at or above the ${threshold} threshold`
          : `security-severity ${severity} is below the ${threshold} threshold`;
      } else if (level === null || level === 'error') {
        blocking = true;
        reason =
          'no security-severity could be resolved for this rule and the result is an error, ' +
          'so its severity is unknown rather than low';
      } else {
        blocking = false;
        reason = `no security-severity, and the result is level "${level}" rather than an error`;
      }

      results.push({
        ruleId,
        level,
        severity,
        location: locationOf(result),
        message: messageOf(result),
        blocking,
        reason,
      });
    }
  }

  const blocking = results.filter((result) => result.blocking);
  return {
    readable: true,
    runs: root['runs'].length,
    results,
    blocking,
    summary:
      `${root['runs'].length} run(s), ${results.length} result(s), ` +
      `${blocking.length} at or above the ${threshold} threshold`,
  };
}

function unreadable(why: string): SarifVerdict {
  return { readable: false, summary: why, runs: 0, results: [], blocking: [] };
}

export function parseArgs(argv: readonly string[]): { file: string | null; threshold: number } {
  let file: string | null = null;
  let threshold = DEFAULT_SEVERITY_THRESHOLD;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--threshold') {
      const value = Number.parseFloat(argv[index + 1] ?? '');
      // A threshold this script could not read is not silently replaced with the
      // default: a typo would then quietly widen what passes.
      if (!Number.isFinite(value)) throw new Error('--threshold requires a number, e.g. --threshold 7.0');
      threshold = value;
      index += 1;
    } else if (argument !== undefined && !argument.startsWith('-')) {
      file = argument;
    }
  }
  return { file, threshold };
}

function main(): void {
  let options: { file: string | null; threshold: number };
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`check-sarif: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (!options.file) {
    console.error('check-sarif: usage — npx tsx scripts/check-sarif.ts <file.sarif> [--threshold 7.0]');
    process.exitCode = 1;
    return;
  }

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(options.file, 'utf8'));
  } catch (error) {
    // Unreadable is a refusal, not a pass. A missing file is the shape a
    // scanner-step failure takes when the step before this one was skipped.
    console.error(
      `check-sarif: could not read ${options.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const verdict = checkSarif(document, options.threshold);
  if (!verdict.readable) {
    console.error(`check-sarif: refusing — ${verdict.summary}`);
    process.exitCode = 1;
    return;
  }

  for (const result of verdict.results) {
    if (result.blocking) continue;
    console.log(`  [reported] ${result.ruleId} ${result.location} — ${result.reason}`);
  }

  if (verdict.blocking.length === 0) {
    console.log(`check-sarif: ok — ${verdict.summary}.`);
    console.log('  not covered  results below the threshold are reported above and in the');
    console.log('               Security tab; this gate blocks on high severity and on any');
    console.log('               result whose severity it could not resolve.');
    return;
  }

  console.error(`check-sarif: ${verdict.blocking.length} blocking result(s) — ${verdict.summary}\n`);
  for (const result of verdict.blocking) {
    console.error(`  [${result.ruleId}] ${result.location}`);
    console.error(`      ${result.message}`);
    console.error(`      ${result.reason}`);
  }
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
