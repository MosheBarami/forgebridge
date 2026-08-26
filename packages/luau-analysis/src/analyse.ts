/**
 * The entry point: source in, verdict out.
 *
 * One invariant governs everything here. **A source this analyser could not read
 * is never reported as a pass.** A tokenizer error, a block that does not close,
 * a budget that ran out, a bug in a rule that throws — every one of those
 * returns `fail`, because the alternative is a rule that silently did not fire
 * and a `ok` that means "we did not look". THREAT-MODEL T2 lists this layer
 * between schema validation and the policy check; a layer that reports success
 * when it has not run is worse than no layer, because the layers after it are
 * calibrated on its answer.
 */
import { Finding, LIMITS } from '@forgebridge/protocol';
import type { RuleContext } from './query.js';
import { INCOMPLETE_RULE, RULES, SYNTAX_ERROR_RULE, type Rule } from './rules/index.js';
import { analyseStructure } from './structure.js';
import { tokenize } from './tokenizer.js';

export type AnalysisStatus = 'ok' | 'warn' | 'fail';

export interface AnalyseOptions {
  /**
   * Hosts a script may reach through `HttpService`. Empty — and the default is
   * empty — means none, and every outbound request is a finding. The
   * fail-closed reading, matching how `packages/core` reads an empty path
   * allowlist.
   */
  allowedHttpHosts?: readonly string[];
  /**
   * Rule ids to skip. A rule the caller has disabled is not run and cannot
   * contribute to the status; nothing here treats a disabled rule as passing.
   */
  disabledRules?: readonly string[];
  /**
   * Stamped onto every finding, for a caller analysing one operation of a
   * ChangeSet and wanting the findings attributed back to it.
   */
  operationIndex?: number;
  /**
   * Token ceiling. Reaching it ends the analysis with `fail` rather than a
   * partial pass. The default is generous relative to `LIMITS.MAX_SCRIPT_BYTES`;
   * it exists so a pathological input cannot hold a thread, not to constrain
   * ordinary scripts.
   */
  maxTokens?: number;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  findings: Finding[];
}

/** Roughly one token per two bytes of the largest script the protocol allows, rounded up. */
const DEFAULT_MAX_TOKENS = Math.ceil(LIMITS.MAX_SCRIPT_BYTES / 2);

export function analyse(source: string, options: AnalyseOptions = {}): AnalysisResult {
  const operationIndex = options.operationIndex;
  const stamp = (findings: Finding[]): Finding[] =>
    operationIndex === undefined ? findings : findings.map((finding) => ({ ...finding, operationIndex }));

  const fail = (rule: string, message: string, line = 1, column = 1): AnalysisResult => ({
    status: 'fail',
    findings: stamp([{ severity: 'error', rule, message, line, column }]),
  });

  try {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    const lexed = tokenize(source);
    if (lexed.error) {
      return fail(
        SYNTAX_ERROR_RULE,
        `This script does not tokenize: ${lexed.error.message}. Nothing below this point was checked, so ` +
          'none of the other rules ran and this result says nothing about the rest of the file. Fix the ' +
          'syntax and re-propose.',
        lexed.error.line,
        lexed.error.column,
      );
    }

    if (lexed.tokens.length > maxTokens) {
      return fail(
        INCOMPLETE_RULE,
        `This script is ${lexed.tokens.length} tokens, past the ${maxTokens}-token budget this analyser ` +
          'will spend on one file, so it was not checked. Split it into modules — a file this size is also ' +
          'past what a reviewer can read in a diff.',
      );
    }

    const structure = analyseStructure(lexed.tokens);
    if (structure.error) {
      return fail(
        SYNTAX_ERROR_RULE,
        `The blocks in this script do not balance: ${structure.error.message}. The analyser cannot tell ` +
          'where any function or loop ends, so no other rule ran and this result says nothing about the ' +
          'rest of the file.',
        structure.error.line,
        structure.error.column,
      );
    }

    const context: RuleContext = {
      tokens: lexed.tokens,
      structure,
      allowedHttpHosts: options.allowedHttpHosts ?? [],
    };

    const disabled = new Set(options.disabledRules ?? []);
    const findings: Finding[] = [];
    for (const rule of RULES) {
      if (disabled.has(rule.id)) continue;
      findings.push(...runRule(rule, context));
    }

    return { status: verdict(findings), findings: stamp(sortFindings(findings)) };
  } catch (error) {
    // A rule that throws has not checked anything, and the honest report of
    // that is a refusal. Swallowing it and returning what the other rules found
    // would be an `ok` covering a check that crashed.
    return fail(
      INCOMPLETE_RULE,
      'The Luau analyser failed while reading this script, so it was not checked: ' +
        `${error instanceof Error ? error.message : String(error)}. This is a bug in the analyser, not ` +
        'necessarily in the script. Please report it with the source that triggered it.',
    );
  }
}

function runRule(rule: Rule, context: RuleContext): Finding[] {
  const produced = rule.run(context);
  // The rule ids are literals in this package, but a finding that fails the
  // protocol's own schema would be rejected downstream with no explanation of
  // which rule produced it. Check here, where the rule is still named.
  for (const finding of produced) {
    const parsed = Finding.safeParse(finding);
    if (!parsed.success) {
      throw new Error(`rule ${rule.id} produced a finding the protocol rejects: ${parsed.error.message}`);
    }
  }
  return produced;
}

function verdict(findings: readonly Finding[]): AnalysisStatus {
  if (findings.some((finding) => finding.severity === 'error')) return 'fail';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warn';
  return 'ok';
}

/** Stable order — line, then column, then rule id — so a diff of two runs is a diff of the findings. */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const line = (a.line ?? 0) - (b.line ?? 0);
    if (line !== 0) return line;
    const column = (a.column ?? 0) - (b.column ?? 0);
    if (column !== 0) return column;
    return a.rule.localeCompare(b.rule);
  });
}
