/**
 * Token-level questions the rules share.
 *
 * Every helper here is deliberately conservative: when it cannot tell, it says
 * so rather than assuming. A rule built on a helper that guesses produces a
 * finding a reader cannot check, and a finding nobody trusts is one they learn
 * to click past.
 */
import type { Finding } from '@forgebridge/protocol';
import { analyseStructure, blockAt, type Block, type Structure } from './structure.js';
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

/** Tokens that may appear between the names of a declaration list: the separators and the type annotations. */
const DECLARATION_LIST_OPS: ReadonlySet<string> = new Set([',', ':', '.', '?', '|', '&', '->', '::', '<', '>']);

/**
 * True when the name at `index` is one a `local` statement or a parameter list
 * is *introducing*, at any position in the list.
 *
 * Checking only the token immediately before — `local` or `function` — saw the
 * first name and no other, so `local ok, loadstring = pcall(f)` and
 * `function handler(player, spawn)` reported a declaration as a use of the
 * global. A rule that fires on the line that shadows the global is a rule
 * people learn to click past.
 */
export function isDeclaredName(tokens: readonly Token[], index: number): boolean {
  if (isKeyword(tokens, index - 1, 'local') || isKeyword(tokens, index - 1, 'function')) return true;

  let i = index - 1;
  let sawSeparator = false;
  while (i >= 0) {
    const token = tokens[i];
    if (token === undefined) return false;

    if (isKeyword(tokens, i, 'local')) return true;

    // A parameter list: `function f(a, spawn)`, `local function f(a, spawn)`,
    // `function(a, spawn)`. The `(` is this list's only left edge.
    if (isOp(tokens, i, '(')) {
      let j = i - 1;
      while (j >= 0) {
        const before = tokens[j];
        if (before === undefined) break;
        if (before.kind === 'name' || (before.kind === 'op' && DECLARATION_LIST_OPS.has(before.text))) {
          j -= 1;
          continue;
        }
        break;
      }
      return isKeyword(tokens, j, 'function');
    }

    // Crossing declaration-list punctuation is fine: a comma separates entries,
    // and `:` `.` `<` `>` and friends sit inside one entry's type annotation.
    // Crossing any of them means the NEXT name back is legitimately part of
    // this list.
    if (token.kind === 'op' && DECLARATION_LIST_OPS.has(token.text)) {
      sawSeparator = true;
      i -= 1;
      continue;
    }

    if (token.kind === 'name') {
      // THE STATEMENT BOUNDARY. Two names with no separator between them are
      // two different statements, not one declaration list. Without this the
      // walk crossed out of `local cache` into the statement below it, so
      //     local cache
      //     loadstring(payload)()
      // read `loadstring` as a name being declared — silently disarming every
      // rule built on isGlobalReference at once: no-loadstring,
      // no-getfenv-setfenv, require-unreviewed-asset and deprecated-wait-spawn.
      // Two tokens of prefix turned the analyser off.
      if (!sawSeparator) return false;
      sawSeparator = false;
      i -= 1;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * True when `tokens[index]` is a free reference to the global `name` — not a
 * member, not a name being declared, and not a table key being defined.
 */
export function isGlobalReference(tokens: readonly Token[], index: number, name: string): boolean {
  const token = tokens[index];
  if (token === undefined || token.kind !== 'name' || token.text !== name) return false;
  if (isMemberAccess(tokens, index)) return false;
  // `local wait = …`, `local ok, wait = …` and `function wait() … end` all
  // introduce a different binding.
  if (isDeclaredName(tokens, index)) return false;
  // `{ loadstring = 1 }` and `t.loadstring = 1` define a key, they do not call one.
  if (isOp(tokens, index + 1, '=')) return false;
  return true;
}

/** Index of the `(` opening this name's call argument list, or null when it is not called directly. */
export function callParen(tokens: readonly Token[], index: number): number | null {
  return isOp(tokens, index + 1, '(') ? index + 1 : null;
}

/**
 * True when the name at `index` is being called. Luau spells a single-argument
 * call three ways — `f(x)`, `f"str"` and `f{tbl}` — and all three are calls.
 */
export function isCalled(tokens: readonly Token[], index: number): boolean {
  if (isOp(tokens, index + 1, '(') || isOp(tokens, index + 1, '{')) return true;
  const next = tokens[index + 1];
  return next !== undefined && next.kind === 'string';
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
 * True when `tokens[index]` begins a call this analyser recognises as yielding
 * the running thread, judged on the call alone.
 *
 * The set is the one that matters for a frozen Studio: `task.wait`, the
 * deprecated global `wait`, `coroutine.yield`, and `:Wait()` on a signal. A
 * caller that yields some other way — a custom promise, a `:AwaitValue()` on a
 * library object — is not recognised, which is why the loop rules say what they
 * checked rather than claiming the loop never yields.
 */
function isRecognisedYieldCall(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined || token.kind !== 'name') return false;
  // A mention is not a yield. `local resume = task.wait` inside a spin loop
  // names the function and never calls it, and reading that as a yield reports
  // a loop that hangs Studio as safe.
  if (!isCalled(tokens, index)) return false;
  if (token.text === 'wait') {
    if (isMemberAccess(tokens, index)) return isName(tokens, index - 2, 'task');
    return true;
  }
  if (token.text === 'Wait') return isOp(tokens, index - 1, ':');
  if (token.text === 'yield') return isOp(tokens, index - 1, '.') && isName(tokens, index - 2, 'coroutine');
  return false;
}

/**
 * Per token array: does this source define a `Wait` that this analyser cannot
 * see yielding? Computed once, because the answer is a property of the file and
 * `isYieldCall` is asked it once per token of every loop body.
 */
const UNYIELDING_WAIT = new WeakMap<readonly Token[], boolean>();

/**
 * The structure of a token array, for the question above.
 *
 * `analyseStructure` has already run over these tokens by the time a rule calls
 * in, but `isYieldCall` is a token predicate and is not handed the result. A
 * second pass, memoised per file and only paid when the file defines a `Wait`
 * at all, is cheaper than widening a signature every rule calls.
 */
const STRUCTURE = new WeakMap<readonly Token[], Structure>();

function structureFor(tokens: readonly Token[]): Structure {
  let structure = STRUCTURE.get(tokens);
  if (structure === undefined) {
    structure = analyseStructure(tokens);
    STRUCTURE.set(tokens, structure);
  }
  return structure;
}

/** Token index of the `function` keyword of a `Wait` this file defines, for each definition it can see. */
function waitDefinitions(tokens: readonly Token[]): number[] {
  const definitions: number[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'name' || token.text !== 'Wait') continue;

    // `function Signal:Wait(…)`, `function Signal.Wait(…)`, `function Wait(…)`:
    // walk back over the name path to the keyword that opened it.
    if (isMemberAccess(tokens, i) || isKeyword(tokens, i - 1, 'function')) {
      let j = i;
      while (j > 0 && (isOp(tokens, j - 1, '.') || isOp(tokens, j - 1, ':'))) j -= 2;
      if (isKeyword(tokens, j - 1, 'function')) {
        definitions.push(j - 1);
        continue;
      }
    }

    // `Wait = function(…)` — the field or local spelling of the same thing.
    if (isOp(tokens, i + 1, '=') && isKeyword(tokens, i + 2, 'function')) definitions.push(i + 2);
  }

  return definitions;
}

/** First token of a function block's body: past the name path and past the parameter list. */
function bodyStart(tokens: readonly Token[], structure: Structure, block: Block): number {
  for (let i = block.open + 1; i < block.close; i += 1) {
    if (!isOp(tokens, i, '(')) continue;
    return (structure.bracket.get(i) ?? i) + 1;
  }
  return block.open + 1;
}

/**
 * True when this source defines a `Wait` of its own that this analyser cannot
 * see yielding.
 *
 * `:Wait()` is credited as a yield because on an `RBXScriptSignal` it is one.
 * Nothing in a token stream says the receiver is a signal, so a script that
 * writes its own
 *
 *   local o = {}
 *   function o:Wait() end
 *   while true do o:Wait() step() end
 *
 * cleared `luau/while-true-no-yield` while spinning for ever — reproduced
 * against the built analyser as `ok` with zero findings.
 *
 * The check is the definition, not the call site: a custom signal class whose
 * `Wait` really does yield — `function Signal:Wait() … coroutine.yield() … end`
 * — keeps the credit, because that is ordinary Roblox code and a rule that
 * fires on it is one people learn to click past. Only a `Wait` defined here
 * with no yield this analyser recognises inside it withdraws the credit, and it
 * withdraws it for every `:Wait()` in the file, because which definition a
 * given call reaches is the name resolution this package does not have.
 */
function definesUnyieldingWait(tokens: readonly Token[]): boolean {
  const cached = UNYIELDING_WAIT.get(tokens);
  if (cached !== undefined) return cached;

  let answer = false;
  const definitions = waitDefinitions(tokens);
  if (definitions.length > 0) {
    const structure = structureFor(tokens);
    for (const at of definitions) {
      const block = structure.error === undefined ? blockAt(structure, at) : null;
      if (block === null || block.kind !== 'function' || block.open !== at || block.close < 0) {
        // A definition whose body cannot be delimited is one we cannot see
        // yield, which is the same answer as a body that does not.
        answer = true;
        break;
      }
      // From after the parameter list, not from the `function` keyword: the
      // definition's own header spells `o:Wait(`, which `isRecognisedYieldCall`
      // reads as a `:Wait()` call, so every definition looked like it yielded
      // into itself and the check answered `false` for all of them.
      const body = bodyStart(tokens, structure, block);
      if (!anyToken(body, block.close, (i) => isRecognisedYieldCall(tokens, i))) {
        answer = true;
        break;
      }
    }
  }

  UNYIELDING_WAIT.set(tokens, answer);
  return answer;
}

/**
 * True when `tokens[index]` begins a call that yields the running thread.
 *
 * Everything `isRecognisedYieldCall` accepts, minus the one member of that set
 * a script can define for itself: see `definesUnyieldingWait`.
 */
export function isYieldCall(tokens: readonly Token[], index: number): boolean {
  if (!isRecognisedYieldCall(tokens, index)) return false;
  return tokens[index]?.text !== 'Wait' || !definesUnyieldingWait(tokens);
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

const PREFIX_OPERATOR_OPS: ReadonlySet<string> = new Set(['-', '#']);
const BINARY_OPERATOR_OPS: ReadonlySet<string> = new Set([
  '+', '-', '*', '/', '//', '%', '^', '..', '==', '~=', '<', '>', '<=', '>=', '::',
]);
const LITERAL_KEYWORDS: ReadonlySet<string> = new Set(['nil', 'true', 'false']);

/** True when the token at `index` is a unary operator: the `-` of `-x`, the `#` of `#t`, `not`. */
function isPrefixOperator(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (token.kind === 'op') return PREFIX_OPERATOR_OPS.has(token.text);
  return token.kind === 'keyword' && token.text === 'not';
}

/** True when the token at `index` is a binary operator, `and` and `or` included. */
function isBinaryOperator(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (token.kind === 'op') return BINARY_OPERATOR_OPS.has(token.text);
  return token.kind === 'keyword' && (token.text === 'and' || token.text === 'or');
}

/** True when the token at `index` closes an operand — a value sits immediately to its left. */
function endsOperand(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (token.kind === 'name' || token.kind === 'string' || token.kind === 'number') return true;
  if (token.kind === 'keyword') return LITERAL_KEYWORDS.has(token.text) || token.text === 'end';
  return token.kind === 'op' && (token.text === ')' || token.text === ']' || token.text === '}' || token.text === '...');
}

/** True when the token at `index` opens an operand — a value starts here. */
function startsOperand(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (token.kind === 'name' || token.kind === 'string' || token.kind === 'number') return true;
  if (token.kind === 'keyword') return LITERAL_KEYWORDS.has(token.text) || token.text === 'function';
  return token.kind === 'op' && (token.text === '(' || token.text === '{' || token.text === '...');
}

/**
 * End of the expression starting at `from`, exclusive.
 *
 * This walks the expression rather than sweeping to the next stop keyword,
 * because a sweep does not know where a construct ends. The `until` of a
 * `repeat` is followed by its condition and then by the next statement, with no
 * terminator between them, so the old sweep read
 *
 *   repeat step() until done
 *   use(amount)
 *
 * as one range covering `use(amount)` — and `remote-validation`, which treats an
 * `until` condition as a place a value is *tested*, counted `amount` as checked
 * when nothing had checked it. Two operands cannot sit side by side inside one
 * expression, so `done` followed by `use` is where this stops.
 *
 * Still not a parser: anything it does not recognise ends the expression, which
 * makes the range shorter. For every caller a shorter guard range means fewer
 * things treated as validated, which is the direction a security rule should
 * round in.
 */
export function endOfExpression(context: RuleContext, from: number): number {
  const { tokens, structure } = context;
  let i = from;
  let wantOperand = true;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind === 'eof') break;
    const jump = structure.bracket.get(i);
    const opensGroup = jump !== undefined && jump > i;

    if (wantOperand) {
      // A prefix operator does not satisfy the operand; the next token still must.
      if (isPrefixOperator(tokens, i)) { i += 1; continue; }
      if (opensGroup) { i = (jump as number) + 1; wantOperand = false; continue; }
      if (isKeyword(tokens, i, 'function')) {
        const block = blockAt(structure, i);
        if (block === null || block.open !== i || block.close < 0) break;
        i = block.close + 1;
        wantOperand = false;
        continue;
      }
      if (!startsOperand(tokens, i)) break;
      i += 1;
      wantOperand = false;
      continue;
    }

    // An operand is in hand: only a suffix or a binary operator continues it.
    if (opensGroup) { i = (jump as number) + 1; continue; }   // `f(x)`, `t[k]`, `f{…}`
    if (token.kind === 'string') { i += 1; continue; }        // `f"str"`
    if (token.kind === 'op' && (token.text === '.' || token.text === ':')) { i += 1; wantOperand = true; continue; }
    if (isBinaryOperator(tokens, i)) { i += 1; wantOperand = true; continue; }
    break;
  }
  return i;
}

/**
 * First token of the prefix expression that ends at `index`: the `game` of
 * `game:GetService(…)`, the `Remotes` of `Remotes.Buy.OnServerEvent`, the `(`
 * of `(handle).Value`.
 */
export function startOfPrefixExpression(context: RuleContext, index: number): number {
  const { tokens, structure } = context;
  let i = index;
  for (;;) {
    if (i <= 0) return Math.max(i, 0);
    const opener = structure.bracket.get(i);
    if (opener !== undefined && opener < i) {
      // A group is a call or index *suffix* when a value sits before it, and
      // the start of the expression when nothing does.
      if (!endsOperand(tokens, opener - 1)) return opener;
      i = opener - 1;
      continue;
    }
    const token = tokens[i];
    if (token === undefined) return i;
    if ((token.kind === 'name' || token.kind === 'string') && isMemberAccess(tokens, i)) {
      i -= 2;
      continue;
    }
    return i;
  }
}

/** First token of the complete value expression that ends at `end`, operators and all. */
function startOfValue(context: RuleContext, end: number): number {
  const { tokens, structure } = context;
  let start = end + 1;
  let i = end;

  for (;;) {
    if (i < 0) break;
    const token = tokens[i];
    if (token === undefined) break;

    // One operand, right to left.
    if (isKeyword(tokens, i, 'end')) {
      const block = blockAt(structure, i);
      if (block === null || block.close !== i) break;
      start = block.open;
      i = block.open - 1;
    } else if (endsOperand(tokens, i)) {
      start = startOfPrefixExpression(context, i);
      i = start - 1;
    } else {
      break;
    }

    // Prefix operators belong to the operand just read.
    while (i >= 0 && isPrefixOperator(tokens, i)) {
      start = i;
      i -= 1;
    }

    // A binary operator means another operand precedes it.
    if (!isBinaryOperator(tokens, i)) break;
    i -= 1;
  }

  return start;
}

/** Tokens that may sit inside an assignment's target list: the names, the separators, and the type annotations. */
const TARGET_LIST_OPS: ReadonlySet<string> = new Set([',', ':', '.', '?', '|', '&', '->', '::', '<', '>']);

/**
 * First token of the target list of the assignment whose `=` is at `equals`.
 *
 * Walks back over `local H: HttpService`, `a, b`, `Services.Http`. It stops at
 * a statement boundary, which in Luau is where two operands would otherwise sit
 * side by side: in
 *
 *   print(1)
 *   Services.Http = game:GetService("HttpService")
 *
 * the `)` ends an operand and `Services` starts one, and nothing joins them.
 */
function startOfTargetList(context: RuleContext, equals: number): number {
  const { tokens, structure } = context;
  let start = equals;
  for (;;) {
    const i = start - 1;
    if (i < 0) break;
    const token = tokens[i];
    if (token === undefined) break;

    const opener = structure.bracket.get(i);
    const acceptable =
      (opener !== undefined && opener < i) ||
      token.kind === 'name' ||
      token.kind === 'string' ||
      token.kind === 'number' ||
      (token.kind === 'keyword' && LITERAL_KEYWORDS.has(token.text)) ||
      (token.kind === 'op' && TARGET_LIST_OPS.has(token.text));
    if (!acceptable) break;
    if (endsOperand(tokens, i) && startsOperand(tokens, start)) break;

    start = opener !== undefined && opener < i ? opener : i;
  }
  return start;
}

/**
 * The plain name a target names — `H` in `local H: HttpService`, `Http` in
 * `Services.Http` — or null for a target this analyser cannot follow, such as
 * `t[key]`.
 */
function targetName(context: RuleContext, start: number, end: number): { name: string; index: number } | null {
  const { tokens } = context;
  const first = tokens[start];
  if (first === undefined || first.kind !== 'name') return null;

  let last = start;
  let i = start + 1;
  while (i < end) {
    if (!isOp(tokens, i, '.')) break;   // `:` starts a type annotation; anything else ends the target
    const field = tokens[i + 1];
    if (field === undefined || field.kind !== 'name') return null;
    last = i + 1;
    i += 2;
  }
  const token = tokens[last];
  return token === undefined ? null : { name: token.text, index: last };
}

/**
 * True when the token at `index` carries the expression before it further —
 * a suffix, or a binary operator.
 */
function continuesValue(context: RuleContext, index: number): boolean {
  const { tokens, structure } = context;
  const token = tokens[index];
  if (token === undefined) return false;
  const jump = structure.bracket.get(index);
  if (jump !== undefined && jump > index) return true;
  if (token.kind === 'string') return true;
  if (isBinaryOperator(tokens, index)) return true;
  return token.kind === 'op' && (token.text === '.' || token.text === ':');
}

export interface Binding {
  /** The plain name the value is bound to. */
  name: string;
  /** Token index of that name, for positioning a finding. */
  index: number;
}

/**
 * The name bound to the value expression spanning `[start, end]`, or null when
 * it is not the whole right-hand side of one slot of an assignment.
 *
 * The version this replaces assumed the token before the `=` was the bound
 * name, which is wrong in both of the shapes real code uses:
 *
 *   local H: HttpService = game:GetService("HttpService")   -- bound the TYPE name
 *   local a, H = 1, game:GetService("HttpService")          -- found a comma
 *
 * so `H` was not in the service-name set, and every `H:GetAsync(url)` after it
 * fell through to the unresolved-receiver branch — a warning, where an error
 * naming the host belongs. The binding set is read by more than one rule, so a
 * miss here is a miss everywhere it is used.
 */
export function bindingOf(context: RuleContext, start: number, end: number): Binding | null {
  const { tokens } = context;

  // The value must end where the caller says it does. In
  // `local x = game:GetService("HttpService").Parent` what is bound is the
  // parent, not the service.
  if (continuesValue(context, end + 1)) return null;

  // Walk back to the `=`, counting the values in front of this one. The token
  // before a value in an assignment is the `=` itself or the comma after the
  // previous value; anything else means this expression is not a right-hand
  // side at all, and walking on would find the `=` of the statement before it.
  let i = start - 1;
  let slot = 0;
  let equals = -1;
  for (;;) {
    if (isOp(tokens, i, '=')) { equals = i; break; }
    if (!isOp(tokens, i, ',')) return null;
    slot += 1;
    const previous = startOfValue(context, i - 1);
    if (previous > i - 1) return null;   // nothing readable before the comma
    i = previous - 1;
  }

  const listStart = startOfTargetList(context, equals);
  const targets = splitTargets(context, listStart, equals);
  const target = targets[slot];
  if (target === undefined) return null;
  return targetName(context, target.start, target.end);
}

/** Splits `[start, end)` into one range per depth-zero comma-separated target. */
function splitTargets(context: RuleContext, start: number, end: number): { start: number; end: number }[] {
  const { tokens, structure } = context;
  const parts: { start: number; end: number }[] = [];
  let from = start;
  let i = start;
  while (i < end) {
    const jump = structure.bracket.get(i);
    if (jump !== undefined && jump > i) {
      i = jump + 1;
      continue;
    }
    if (isOp(tokens, i, ',')) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
    i += 1;
  }
  if (from < end) parts.push({ start: from, end });
  return parts;
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
