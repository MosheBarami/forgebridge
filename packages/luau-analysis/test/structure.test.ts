import { describe, expect, it } from 'vitest';
import { analyseStructure, blockAt, enclosingFunction, enclosingLoop } from '../src/structure.js';
import { tokenize } from '../src/tokenizer.js';

function structureOf(source: string) {
  const lexed = tokenize(source);
  expect(lexed.error).toBeUndefined();
  return { tokens: lexed.tokens, structure: analyseStructure(lexed.tokens) };
}

describe('analyseStructure', () => {
  it('pairs every block form', () => {
    const { structure } = structureOf(
      'local function f()\n  if a then\n    for i = 1, 2 do\n      repeat x() until b\n    end\n  end\nend\n',
    );
    expect(structure.error).toBeUndefined();
    expect(structure.blocks.map((block) => block.kind).sort()).toEqual(['do', 'function', 'if', 'repeat']);
    expect(structure.blocks.every((block) => block.close > block.open)).toBe(true);
  });

  it('marks the `do` of a loop with the keyword that opened it', () => {
    const { tokens, structure } = structureOf('while ready do step() end\n');
    const loop = structure.blocks.find((block) => block.kind === 'do');
    expect(loop?.loopKeyword).toBeDefined();
    expect(tokens[loop?.loopKeyword as number]?.text).toBe('while');
  });

  it('treats an `if` expression as a value, not a block', () => {
    // Luau's if-expression has no `end`. Counting it as a block opener would
    // report this perfectly good line as an unterminated block.
    const { structure } = structureOf('local label = if ready then "go" else "wait"\nprint(label)\n');
    expect(structure.error).toBeUndefined();
    expect(structure.blocks).toHaveLength(0);
  });

  it('still sees an `if` statement in the same file', () => {
    const { structure } = structureOf('local a = if ready then 1 else 2\nif a > 1 then print(a) end\n');
    expect(structure.error).toBeUndefined();
    expect(structure.blocks.map((block) => block.kind)).toEqual(['if']);
  });

  it('does not read an `if` after a type suffix as an expression', () => {
    // Regression: `?`, `|`, `&`, `:` and `::` end a type, and the statement
    // after one may be an ordinary `if`. Reading them as expression positions
    // reported three of this repository's own plugin sources as unbalanced.
    const sources = [
      'local function find(k: string): string?\n  if k == "" then return nil end\n  return k\nend\n',
      'type Status = "on" | "off"\nlocal s: Status = "on"\nif s == "on" then print(1) end\n',
      'local n = (value :: number)\nif n > 0 then print(n) end\n',
      'local function tag(self: Thing, name: string)\n  if name ~= "" then self.name = name end\nend\n',
    ];
    for (const source of sources) {
      const { structure } = structureOf(source);
      expect(structure.error, source).toBeUndefined();
      expect(structure.blocks.some((block) => block.kind === 'if'), source).toBe(true);
    }
  });

  it('reads a chained if-expression, where the second `if` follows `then` or `else`', () => {
    // Regression: `then` and `else` were read as statement positions without
    // exception, so the second `if` in each of these opened a block that needed
    // an `end` it never gets — a `fail` on correct Luau, which is the most
    // expensive way this package can be wrong.
    const sources = [
      'local label = if ready then "go" else if fast then "run" else "wait"\nprint(label)\n',
      'local label = if ready then if fast then "go" else "jog" else "wait"\nprint(label)\n',
      'local n = if a then 1 elseif b then 2 else if c then 3 else 4\nprint(n)\n',
    ];
    for (const source of sources) {
      const { structure } = structureOf(source);
      expect(structure.error, source).toBeUndefined();
      expect(structure.blocks, source).toHaveLength(0);
    }
  });

  it('still reads an `if` statement written directly after `then` or `else`', () => {
    // The control, and the shape that made the naive fix unavailable: `then`
    // and `else` introduce a statement far more often than they introduce a
    // value, and reading these as expressions would unbalance every block above.
    const source = 'if ready then\n  if fast then go() end\nelse\n  if slow then hold() end\nend\n';
    const { structure } = structureOf(source);
    expect(structure.error).toBeUndefined();
    expect(structure.blocks.map((block) => block.kind)).toEqual(['if', 'if', 'if']);
  });

  it('does not let an if-expression inside a branch claim the branch keywords around it', () => {
    const source = 'if ready then\n  local x = if fast then 1 else 2\n  print(x)\nelse\n  print(0)\nend\n';
    const { structure } = structureOf(source);
    expect(structure.error).toBeUndefined();
    expect(structure.blocks.map((block) => block.kind)).toEqual(['if']);
    // And the if-expression's own `then`/`else` are marked as such, so a rule
    // splitting the `if` block into arms does not read them as another arm.
    expect(structure.expressionBranches.size).toBe(2);
  });

  it('refuses an unbalanced block instead of guessing where it ends', () => {
    expect(structureOf('if a then\n  print(1)\n').structure.error?.message).toContain('never closed');
    expect(structureOf('print(1)\nend\n').structure.error?.message).toContain('unexpected "end"');
    expect(structureOf('repeat\n  x()\nend\n').structure.error?.message).toContain('it needs "until"');
  });

  it('refuses an unbalanced bracket', () => {
    expect(structureOf('local t = { 1, 2\n').structure.error?.message).toContain('is never closed');
    expect(structureOf('local t = (1]\n').structure.error?.message).toContain('is closed by');
  });

  it('answers which function and which loop a token is inside', () => {
    const source = 'local function outer()\n  while true do\n    local inner = function() break end\n  end\nend\n';
    const { tokens, structure } = structureOf(source);
    const breakIndex = tokens.findIndex((token) => token.kind === 'keyword' && token.text === 'break');
    expect(blockAt(structure, breakIndex)?.kind).toBe('function');
    // The `break` is lexically inside the while, but its own function is the
    // inner closure — which is exactly the distinction the loop rules need.
    expect(enclosingFunction(structure, breakIndex)?.kind).toBe('function');
    expect(enclosingLoop(structure, breakIndex)?.kind).toBe('do');
  });
});
