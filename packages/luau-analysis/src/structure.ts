/**
 * Block and bracket recogniser.
 *
 * Not a parser. It answers exactly the questions the rules ask — where does this
 * function body end, which loop is this `break` inside, is this token inside the
 * handler passed to `Connect` — and it reports an imbalance as an error rather
 * than guessing, because a rule that quietly reads the wrong range is worse than
 * a rule that does not run. `analyse` turns that error into a `fail`.
 */
import type { Token } from './tokenizer.js';

export type BlockKind = 'function' | 'if' | 'do' | 'repeat';

export interface Block {
  kind: BlockKind;
  /** Token index of the opening keyword (`function`, `if`, `do`, `repeat`). */
  open: number;
  /** Token index of the closing keyword (`end`, or `until` for a `repeat`). */
  close: number;
  /** Index of this block in `Structure.blocks`. */
  self: number;
  /** Enclosing block, or -1 at the top level. */
  parent: number;
  /**
   * For a `do` that is a loop body: the token index of the `while` or `for` that
   * introduced it. Absent on a bare `do ... end`.
   */
  loopKeyword?: number;
}

export interface StructureError {
  message: string;
  line: number;
  column: number;
}

export interface Structure {
  blocks: Block[];
  /** Matching bracket indices, both directions, for `(` `[` `{`. */
  bracket: Map<number, number>;
  /** Token index -> innermost enclosing block index, or -1. */
  innermost: Int32Array;
  error?: StructureError;
}

const OPENING_BRACKETS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Luau has both an `if` statement, which ends with `end`, and an `if` *expression*
 * (`local x = if ready then 1 else 0`), which does not. Counting the second as a
 * block opener would report a perfectly good script as unterminated, so the
 * recogniser decides by what comes before: an expression can only appear where a
 * value is expected.
 *
 * The set is deliberately explicit. A token not listed here means "statement",
 * which is the reading that keeps the block stack balanced for ordinary code.
 */
const EXPRESSION_POSITION_OPS: ReadonlySet<string> = new Set([
  '=', '(', '[', '{', ',', '..', '+', '-', '*', '/', '//', '%', '^', '#',
  '==', '~=', '<', '>', '<=', '>=',
  '+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=',
]);

/**
 * Deliberately absent from the set above, because each of them ends a *type* and
 * the next statement may perfectly well be an `if`:
 *
 *   local function find(k: string): string?
 *   if k == "" then … end          -- `?` precedes a statement, not a value
 *
 * `?`, `|`, `&`, `:` and `::` appear only in type position in Luau, so an `if`
 * after one of them is always a statement. Listing them as expression positions
 * reported three of this repository's own plugin sources as unbalanced.
 */

const EXPRESSION_POSITION_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'and', 'or', 'not', 'in',
]);

export function isIfExpression(tokens: readonly Token[], index: number): boolean {
  const previous = tokens[index - 1];
  if (previous === undefined) return false;
  if (previous.kind === 'op') return EXPRESSION_POSITION_OPS.has(previous.text);
  if (previous.kind === 'keyword') return EXPRESSION_POSITION_KEYWORDS.has(previous.text);
  return false;
}

export function analyseStructure(tokens: readonly Token[]): Structure {
  const blocks: Block[] = [];
  const bracket = new Map<number, number>();
  const innermost = new Int32Array(tokens.length).fill(-1);

  /** Block ids, innermost last. Ids are allocated when a block opens, so a rule can ask for the parent of a block that is still being read. */
  const blockStack: number[] = [];
  const bracketStack: { index: number; expected: string }[] = [];
  /** Index of the most recent `while`/`for` whose `do` has not been seen yet. */
  let pendingLoop: number | null = null;

  const top = (): number => (blockStack.length === 0 ? -1 : (blockStack[blockStack.length - 1] as number));

  const open = (kind: BlockKind, at: number, loopKeyword?: number): void => {
    const block: Block = { kind, open: at, close: -1, self: blocks.length, parent: top() };
    if (loopKeyword !== undefined) block.loopKeyword = loopKeyword;
    blocks.push(block);
    blockStack.push(block.self);
  };

  /** Named `refuse`, not `error`: the key-custody gate reads a bare `error(…)` call as a log sink. */
  const refuse = (message: string, token: Token | undefined): Structure => ({
    blocks,
    bracket,
    innermost,
    error: { message, line: token?.line ?? 1, column: token?.column ?? 1 },
  });

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    innermost[i] = top();

    if (token.kind === 'op') {
      const closer = OPENING_BRACKETS[token.text];
      if (closer !== undefined) {
        bracketStack.push({ index: i, expected: closer });
        continue;
      }
      if (token.text === ')' || token.text === ']' || token.text === '}') {
        const opener = bracketStack.pop();
        if (opener === undefined) return refuse(`unmatched "${token.text}"`, token);
        if (opener.expected !== token.text) {
          return refuse(`"${tokens[opener.index]?.text}" is closed by "${token.text}"`, token);
        }
        bracket.set(opener.index, i);
        bracket.set(i, opener.index);
      }
      continue;
    }

    if (token.kind !== 'keyword') continue;

    switch (token.text) {
      case 'while':
      case 'for':
        pendingLoop = i;
        break;

      case 'do':
        open('do', i, pendingLoop ?? undefined);
        pendingLoop = null;
        break;

      case 'if':
        // An `if` expression has no `end`; treating it as a block opener would
        // unbalance every block above it and report good code as broken.
        if (!isIfExpression(tokens, i)) open('if', i);
        break;

      case 'function':
        open('function', i);
        break;

      case 'repeat':
        open('repeat', i);
        break;

      case 'end': {
        const id = blockStack.pop();
        if (id === undefined) return refuse('unexpected "end" — no block is open here', token);
        const block = blocks[id] as Block;
        if (block.kind === 'repeat') {
          return refuse(`"repeat" on line ${tokens[block.open]?.line} is closed by "end"; it needs "until"`, token);
        }
        block.close = i;
        break;
      }

      case 'until': {
        const id = blockStack.pop();
        if (id === undefined) return refuse('unexpected "until" — no "repeat" is open here', token);
        const block = blocks[id] as Block;
        if (block.kind !== 'repeat') {
          return refuse(`"${block.kind}" on line ${tokens[block.open]?.line} is closed by "until"; it needs "end"`, token);
        }
        block.close = i;
        break;
      }

      default:
        break;
    }
  }

  if (bracketStack.length > 0) {
    const opener = bracketStack[bracketStack.length - 1] as { index: number };
    return refuse(`"${tokens[opener.index]?.text}" is never closed`, tokens[opener.index]);
  }
  if (blockStack.length > 0) {
    const block = blocks[blockStack[blockStack.length - 1] as number] as Block;
    const closer = block.kind === 'repeat' ? 'until' : 'end';
    return refuse(`"${block.kind}" is never closed — this block needs a matching "${closer}"`, tokens[block.open]);
  }

  // The walk recorded the *enclosing* block for every token, which is what a
  // rule wants for a token inside a body. Re-point each block's own keywords at
  // itself so `blockAt(block.open)` is that block rather than its parent.
  for (const block of blocks) {
    innermost[block.open] = block.self;
    innermost[block.close] = block.self;
  }

  return { blocks, bracket, innermost };
}

/** The innermost block containing `index`, or null at the top level. */
export function blockAt(structure: Structure, index: number): Block | null {
  const at = structure.innermost[index];
  if (at === undefined || at < 0) return null;
  return structure.blocks[at] ?? null;
}

/** `index` and its enclosing blocks, innermost first. */
export function enclosingBlocks(structure: Structure, index: number): Block[] {
  const chain: Block[] = [];
  let current = blockAt(structure, index);
  while (current !== null) {
    chain.push(current);
    current = current.parent < 0 ? null : structure.blocks[current.parent] ?? null;
  }
  return chain;
}

/** The innermost enclosing `function` block, or null when at file scope. */
export function enclosingFunction(structure: Structure, index: number): Block | null {
  return enclosingBlocks(structure, index).find((block) => block.kind === 'function') ?? null;
}

/** The innermost enclosing loop — a `repeat`, or a `do` introduced by `while`/`for`. */
export function enclosingLoop(structure: Structure, index: number): Block | null {
  return (
    enclosingBlocks(structure, index).find(
      (block) => block.kind === 'repeat' || (block.kind === 'do' && block.loopKeyword !== undefined),
    ) ?? null
  );
}
