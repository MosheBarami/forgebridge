import type { Finding, ScriptType, Validation } from '@forgebridge/protocol';

/**
 * Sandbox port — where model-authored Luau is inspected and where tests run.
 *
 * Both operations touch text an untrusted caller wrote (THREAT-MODEL T2), and
 * static analysis is not exempt: running a parser over hostile input is still
 * running code on hostile input. An implementation gets no network, no
 * filesystem beyond what the request carries, and a budget it is killed for
 * exceeding.
 */

export interface ResourceBudget {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SourceUnderAnalysis {
  /** The instance path the source will live at. Used to attribute findings. */
  path: string;
  /**
   * Absent when the ChangeSet does not state one. Only `writeScript` declares a
   * script type; Luau arriving as `createInstance` with a `Source` property, or
   * as `setProperty` of `Source`, lands on whatever class already sits at the
   * path, which this layer cannot see. Optional rather than guessed: a wrong
   * class in a finding a human reads is worse than an absent one.
   */
  scriptType?: ScriptType | undefined;
  source: string;
}

export interface AnalysisRequest {
  sources: readonly SourceUnderAnalysis[];
  /**
   * Hosts a script may reach through `HttpService`. Empty means none, and the
   * analyser reports every egress call as a finding — the fail-closed reading,
   * matching how an empty path allowlist is read by the policy check.
   */
  allowedHttpHosts: readonly string[];
  budget: ResourceBudget;
}

export interface AnalysisReport {
  /** Same three-valued verdict the protocol's `Validation.luau` carries. */
  status: Validation['luau']['status'];
  findings: Finding[];
  /** True when the budget cut the analysis short. A truncated pass is never reported as `ok`. */
  truncated: boolean;
}

export type TestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

export interface TestRequest {
  projectId: string;
  changeSetId: string;
  budget: ResourceBudget;
}

export interface TestReport {
  outcome: TestOutcome;
  total: number;
  failed: number;
  /** Captured output, already clipped to `budget.maxOutputBytes` by the adapter. */
  output: string;
  durationMs: number;
}

export interface SandboxPort {
  analyse(request: AnalysisRequest): Promise<AnalysisReport>;
  test(request: TestRequest): Promise<TestReport>;
}
