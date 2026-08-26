export { analyse, type AnalyseOptions, type AnalysisResult, type AnalysisStatus } from './analyse.js';
export { RULES, INCOMPLETE_RULE, SYNTAX_ERROR_RULE, type Rule } from './rules/index.js';
export { hostMatches, hostOf, normaliseHost } from './rules/http-egress.js';
export { tokenize, type LexError, type Token, type TokenKind, type TokenizeResult } from './tokenizer.js';
export {
  analyseStructure,
  blockAt,
  enclosingBlocks,
  enclosingFunction,
  enclosingLoop,
  isIfExpression,
  type Block,
  type BlockKind,
  type Structure,
  type StructureError,
} from './structure.js';
export type { RuleContext, Severity } from './query.js';
