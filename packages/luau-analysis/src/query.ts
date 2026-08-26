/**
 * Token-level questions the rules share.
 *
 * Every helper here is deliberately conservative: when it cannot tell, it says
 * so rather than assuming. A rule built on a helper that guesses produces a
 * finding a reader cannot check, and a finding nobody trusts is one they learn
 * to click past.
 */
import type { Finding } from '@forgebridge/protocol';
import { blockAt, type Block, type Structure } from './structure.js';
import type { Token } from './tokenizer.js';

export interface RuleContext {
  tokens: readonly Token[];
  structure: Structure;
  /** Hosts `HttpService` may reach. Empty means none — the fail-closed reading. */
  allowedHttpHosts: readonly string[];
}

export type Severity = Finding['severity'];

/** Builds a finding positioned on `token`. Line and column are 1-based, as the protocol requires. */
export function findingAt(token: Token, severity: Severity, rule: string, message: string): Finding {
  return { severity, rule, message, line: token.line, column: token.column };
}

/** True when `tokens[index]` is an op with exactly this text. */
export function isOp(tokens: readonly Token[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'op' && token.text === text;
}

export function isKeyword(tokens: readonly Token[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'keyword' && token.text === text;
}

export function isName(tokens: readonly Token[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'name' && token.text === text;
}

/**
 * True when `tokens[index]` names a member — `foo.Bar` or `foo:Bar` — rather
 * than a free identifier. This is the check that keeps `settings.loadstring`
 * out of the `loadstring` rule.
 */
export function isMemberAccess(tokens: readonly Token[], index: number): boolean {
  return isOp(tokens, index - 1, '.') || isOp(tokens, index - 1, ':');
}

/**
 * True when `tokens[index]` is a free reference to the global `name` — not a
 * member, not the name being declared, and not a table key being defined.
 */
export function isGlobalReference(tokens: readonly Token[], index: number, name: string): boolean {
  const token = tokens[index];
  if (token === undefined || token.kind !== 'name' || token.text !== name) return false;
  if (isMemberAccess(tokens, index)) return false;
  // `local wait = …` and `function wait() … end` introduce a different binding.
  if (isKeyword(tokens, index - 1, 'local') || isKeyword(tokens, index - 1, 'function')) return false;
  // `{ loadstring = 1 }` and `t.loadstring = 1` define a key, they do not call one.
  if (isOp(tokens, index + 1, '=')) return false;
  return true;
}

/** Index of the `(` opening this name's call argument list, or null when it is not called directly. */
export function callParen(tokens: readonly Token[], index: number): number | null {
  return isOp(tokens, index + 1, '(') ? index + 1 : null;
}

/**
 * Splits a bracketed argument list into one index range per argument, skipping
 * commas nested inside brackets. Ranges are inclusive of the first token and
 * exclusive of the last, in the usual half-open form.
 */
export function splitArguments(
  tokens: readonly Token[],
  structure: Structure,
  openParen: number,
): { start: number; end: number }[] {
  const close = structure.bracket.get(openParen);
  if (close === undefined) return [];
  const parts: { start: number; end: number }[] = [];
  let start = openParen + 1;
  let i = start;
  while (i < close) {
    const jump = structure.bracket.get(i);
    if (jump !== undefined && jump > i) {
      i = jump + 1;
      continue;
    }
    if (isOp(tokens, i, ',')) {
      parts.push({ start, end: i });
      start = i + 1;
    }
    i += 1;
  }
  if (start < close) parts.push({ start, end: close });
  return parts;
}

/**
 * Names the `.`/`:` chain ending at `index`, outermost first:
 * `game.ReplicatedStorage.Remotes.Buy` -> `["game", "ReplicatedStorage", "Remotes", "Buy"]`.
 * Stops at anything that is not a plain name, so `t[k].Field` yields `["Field"]`.
 */
export function memberChain(tokens: readonly Token[], index: number): string[] {
  const chain: string[] = [];
  let i = index;
  for (;;) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'name') break;
    chain.unshift(token.text);
    if (!isOp(tokens, i - 1, '.') && !isOp(tokens, i - 1, ':')) break;
    i -= 2;
  }
  return chain;
}

/**
 * True when `tokens[index]` begins a call that yields the running thread.
 *
 * The set is the one that matters for a frozen Studio: `task.wait`, the
 * deprecated global `wait`, `coroutine.yield`, and `:Wait()` on a signal. A
 * caller that yields some other way — a custom promise, a `:AwaitValue()` on a
 * library object — is not recognised, which is why the loop rules say what they
 * checked rather than claiming the loop never yields.
 */
export function isYieldCall(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined || token.kind !== 'name') return false;
  if (token.text === 'wait') {
    if (isMemberAccess(tokens, index)) return isName(tokens, index - 2, 'task');
    return true;
  }
  if (token.text === 'Wait') return isOp(tokens, index - 1, ':');
  if (token.text === 'yield') return isOp(tokens, index - 1, '.') && isName(tokens, index - 2, 'coroutine');
  return false;
}

/** True when any token in [start, end) satisfies `predicate`. */
export function anyToken(
  start: number,
  end: number,
  predicate: (index: number) => boolean,
): boolean {
  for (let i = start; i < end; i += 1) if (predicate(i)) return true;
  return false;
}

/**
 * The function literal passed directly to a call — the `function(...) … end` in
 * `signal:Connect(function(...) … end)`. Returns null when the argument is a
 * named function or a variable, because then the body is somewhere else and
 * this analyser does not follow it.
 */
export function inlineHandlerBlock(context: RuleContext, callNameIndex: number): Block | null {
  const paren = callParen(context.tokens, callNameIndex);
  if (paren === null) return null;
  const fn = paren + 1;
  if (!isKeyword(context.tokens, fn, 'function')) return null;
  const block = blockAt(context.structure, fn);
  return block !== null && block.kind === 'function' && block.open === fn ? block : null;
}

export interface Parameter {
  name: string;
  /** Token index of the parameter's name, for positioning a finding. */
  index: number;
}

export interface ParameterList {
  parameters: Parameter[];
  /** True when the list ends in `...`, whose contents this analyser cannot name. */
  vararg: boolean;
  varargIndex: number;
  /**
   * First token of the function's body — after the closing `)` of the parameter
   * list. A rule looking for *uses* of a parameter must start here, or the
   * declaration itself reads as the first use and the finding points at the
   * wrong line.
   */
  bodyStart: number;
}

/** Reads the parameter list of the `function` keyword at `functionIndex`. */
export function parameterList(context: RuleContext, functionIndex: number): ParameterList {
  const { tokens, structure } = context;
  let paren = functionIndex + 1;
  // `function Foo.Bar:Baz(…)` — skip the name before the parameter list.
  while (paren < tokens.length && !isOp(tokens, paren, '(')) {
    const token = tokens[paren];
    if (token === undefined || (token.kind !== 'name' && !isOp(tokens, paren, '.') && !isOp(tokens, paren, ':'))) break;
    paren += 1;
  }
  if (!isOp(tokens, paren, '(')) {
    return { parameters: [], vararg: false, varargIndex: -1, bodyStart: functionIndex + 1 };
  }

  const parameters: Parameter[] = [];
  let vararg = false;
  let varargIndex = -1;
  for (const part of splitArguments(tokens, structure, paren)) {
    for (let i = part.start; i < part.end; i += 1) {
      const token = tokens[i];
      if (token === undefined) break;
      if (token.kind === 'op' && token.text === '...') {
        vararg = true;
        varargIndex = i;
        break;
      }
      if (token.kind === 'name') {
        parameters.push({ name: token.text, index: i });
        break;
      }
    }
  }
  return { parameters, vararg, varargIndex, bodyStart: (structure.bracket.get(paren) ?? paren) + 1 };
}

/**
 * End of the expression starting at `from`, scanning over bracketed groups and
 * stopping at the first token that can only begin a new statement. An
 * approximation, used where a rule needs a rough span rather than a parse.
 */
export function endOfExpression(context: RuleContext, from: number): number {
  const { tokens, structure } = context;
  const STOP = new Set(['end', 'until', 'else', 'elseif', 'then', 'do', 'local', 'return', 'while', 'repeat', 'for', 'if']);
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind === 'eof') break;
    const jump = structure.bracket.get(i);
    if (jump !== undefined && jump > i) {
      i = jump + 1;
      continue;
    }
    if (token.kind === 'keyword' && STOP.has(token.text)) break;
    if (token.kind === 'op' && token.text === ';') break;
    i += 1;
  }
  return i;
}

/** Index of the first `keyword` token at bracket depth zero after `from`, or -1. */
export function findKeywordAfter(context: RuleContext, from: number, keyword: string, limit: number): number {
  const { tokens, structure } = context;
  let i = from;
  while (i < limit && i < tokens.length) {
    const jump = structure.bracket.get(i);
    if (jump !== undefined && jump > i) {
      i = jump + 1;
      continue;
    }
    if (isKeyword(tokens, i, keyword)) return i;
    i += 1;
  }
  return -1;
}
