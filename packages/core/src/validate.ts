import type { ChangeSet, Finding, Validation } from '@forgebridge/protocol';
import type { ResourceBudget, SandboxPort, SourceUnderAnalysis } from './ports/index.js';

/**
 * The Luau half of a validation verdict.
 *
 * It lives here, apart from both run drivers, because the rules below are the
 * kind that rot when they are written twice: each one exists to stop the core
 * reporting a check it did not perform, and a second copy that drifted by one
 * `status` would report exactly that.
 *
 * The analyser is reached through a port. `@forgebridge/luau-analysis` is not
 * on the vendor ban list in `scripts/verify-boundaries.ts`, so importing it
 * directly would pass CI — but it would also make the analyser a hard
 * dependency of the engine, and the daemon already runs it at submit inside its
 * own trust boundary. A port keeps "which analyser, in which sandbox" a
 * deployment's decision, which is the same reason `SandboxPort` exists.
 */

/**
 * Just the analysis half of `SandboxPort`. A full `SandboxPort` satisfies it,
 * so a caller that has one passes it unchanged.
 */
export type LuauAnalysisPort = Pick<SandboxPort, 'analyse'>;

/** Budget defaults, shared by both run drivers so they cannot diverge. */
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 30_000;
export const MAX_SANDBOX_OUTPUT_BYTES = 262_144;

export interface LuauAnalysisOptions {
  analyser?: LuauAnalysisPort | undefined;
  /** Hosts scripts in this ChangeSet may reach. Empty means none, and every egress call is a finding. */
  allowedHttpHosts?: readonly string[];
  budget: ResourceBudget;
}

/** Every script this ChangeSet would write, in operation order. */
export function scriptsUnderAnalysis(set: ChangeSet): SourceUnderAnalysis[] {
  return set.operations.flatMap((operation) =>
    operation.op === 'writeScript'
      ? [{ path: operation.path as string, scriptType: operation.scriptType, source: operation.source }]
      : [],
  );
}

export async function analyseChangeSet(
  set: ChangeSet,
  options: LuauAnalysisOptions,
): Promise<Validation['luau']> {
  const sources = scriptsUnderAnalysis(set);

  if (!options.analyser) {
    // Reporting `ok` here would claim a check that never ran. `warn` plus a
    // finding says exactly what happened, and the auto-apply gate reads it.
    const finding: Finding = {
      severity: 'warning',
      rule: 'core/luau-analysis-unavailable',
      message: 'No Luau analyser is configured; this ChangeSet was not statically checked.',
    };
    return { status: sources.length === 0 ? 'ok' : 'warn', findings: sources.length === 0 ? [] : [finding] };
  }

  if (sources.length === 0) return { status: 'ok', findings: [] };

  const report = await options.analyser.analyse({
    sources,
    allowedHttpHosts: options.allowedHttpHosts ?? [],
    budget: options.budget,
  });

  if (report.truncated && report.status === 'ok') {
    // A pass that ran out of budget has not seen everything, so it cannot say
    // `ok`. The analyser is told this; the core enforces it anyway.
    return {
      status: 'warn',
      findings: [
        ...report.findings,
        {
          severity: 'warning',
          rule: 'core/luau-analysis-truncated',
          message: 'Static analysis hit its budget before finishing; the verdict covers only part of the source.',
        },
      ],
    };
  }

  return { status: report.status, findings: report.findings };
}

/** The first error-severity finding, formatted for a `remedy` field. */
export function firstErrorFinding(luau: Validation['luau']): string | undefined {
  const finding = luau.findings.find((candidate) => candidate.severity === 'error');
  return finding ? `${finding.rule}: ${finding.message}`.slice(0, 500) : undefined;
}
