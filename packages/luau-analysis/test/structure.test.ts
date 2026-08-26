import { describe, expect, it } from 'vitest';
import { analyse } from '../src/analyse.js';
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

/**
 * Round four of the adversarial review, and the same defect class as the three
 * before it: a recogniser that meets a shape it does not know and answers with
 * the reading that keeps quiet.
 *
 * An `if` is classified by the token in front of it, and two of those tokens
 * were classified wrongly in OPPOSITE directions — one statement read as a
 * value, one value read as a statement. Alone each is a loud `fail` on correct
 * Luau. Together in one file they cancel: the block stack balances, no error is
 * reported, and every block range around them is wrong. That is the outcome
 * this package least wants, because the verdict then says the source was read.
 *
 * All of these were reproduced against the built analyser before being fixed.
 */
describe('fail-closed regressions: telling an `if` statement from an if-expression', () => {
  it('reads an `if` statement that follows a generic type annotation', () => {
    // `>` closes a type-argument list as well as being the comparison operator.
    // Read as a comparison, the `if` after it was a value, pushed no block, and
    // its `end` closed the enclosing block instead: `local queue: Array<Job>`
    // followed by an ordinary `if` returned
    // `unexpected "end" — no block is open here` on valid Luau.
    const sources = [
      'local queue: Array<Job>\nif queue then drain(queue) end\n',
      'local function all(): Array<Item>\n  if cached then return cached end\n  return {}\nend\n',
      'local m: Map<string, Array<Item>>\nif m then print(1) end\n',
      'local t: {[string]: Handler<Event>}\nif t then print(1) end\n',
    ];
    for (const source of sources) {
      const { structure } = structureOf(source);
      expect(structure.error, source).toBeUndefined();
      expect(structure.blocks.filter((block) => block.kind === 'if').length, source).toBe(1);
    }
  });

  it('still reads an if-expression written on the right of a comparison', () => {
    // The control for the fix above, and the reason `>` cannot simply be moved
    // out of the expression-position set: after a real comparison the `if` is a
    // value, and reading it as a statement would demand an `end` that correct
    // code does not have.
    for (const source of [
      'local total = budget > if premium then 200 else 50\nprint(total)\n',
      'local ok = tries < limit and score > if boosted then 10 else 1\nprint(ok)\n',
    ]) {
      const { structure } = structureOf(source);
      expect(structure.error, source).toBeUndefined();
      expect(structure.blocks, source).toHaveLength(0);
    }
  });

  it('reads an if-expression in a keyword position that can only hold a value', () => {
    // `until`, `while`, `elseif` and `if` are each followed by an expression and
    // never by a statement, so an `if` after one of them is the expression form.
    // Left out of the set, `until if done then …` opened a block that never gets
    // an `end`, and the source was reported as unterminated.
    const sources: [string, string[]][] = [
      ['repeat step() until if done then true else tries > 3\n', ['repeat']],
      ['while if paused then false else running do work() end\n', ['do']],
      ['if a then x() elseif if b then c else d then y() end\n', ['if']],
    ];
    for (const [source, kinds] of sources) {
      const { structure } = structureOf(source);
      expect(structure.error, source).toBeUndefined();
      expect(structure.blocks.map((block) => block.kind), source).toEqual(kinds);
    }
  });

  it('still reads ordinary `while`, `until` and `elseif` code as blocks', () => {
    // The control for the keywords added above: they only ever introduce a
    // value when the token after them is `if`, and nothing else about them moved.
    const { structure } = structureOf(
      'while ready do\n  repeat step() until done\n  if a then x() elseif b then y() else z() end\nend\n',
    );
    expect(structure.error).toBeUndefined();
    expect(structure.blocks.map((block) => block.kind).sort()).toEqual(['do', 'if', 'repeat']);
  });

  it('does not let two misreadings cancel into a balanced stack with wrong ranges', () => {
    // Both bugs in one file. The `until if` opened a block it should not have,
    // the `if` after the generic annotation failed to open one it should have,
    // the counts matched, and `analyseStructure` returned no error — over a
    // phantom `if` block spanning lines 1 to 3 while the real `if` on line 3 had
    // no block at all. Reproduced as `{"status":"ok","findings":[]}`.
    const source = 'repeat step() until if done then true else false\nlocal m: Map<string, number>\nif m then print(1) end\n';
    const { tokens, structure } = structureOf(source);
    expect(structure.error).toBeUndefined();
    expect(
      structure.blocks.map((block) => `${block.kind} ${tokens[block.open]?.line}..${tokens[block.close]?.line}`),
    ).toEqual(['repeat 1..1', 'if 3..3']);
  });

  it('refuses an if-expression whose `else` never arrives', () => {
    // The backstop under all of the above. An if-expression always has an
    // `else`; one that goes out of scope still waiting for a branch keyword is
    // proof that the `if` was misread, and the honest report of that is a
    // refusal rather than a recovery that leaves the ranges wrong.
    expect(structureOf('local x = if ready then 1\nprint(x)\n').structure.error?.message).toContain(
      'never arrives',
    );
  });
});

/**
 * The invariant the README states, exercised where it is decided: a source the
 * recogniser could not read must reach the caller as `fail`. `analyse` is the
 * only thing that turns a structure error into a verdict, so a structure error
 * that is not a `fail` is the invariant broken, whatever `analyseStructure`
 * itself returned.
 */
describe('an unreadable source is never a pass', () => {
  it('reports every shape the recogniser refuses as a fail, and nothing else', () => {
    const unreadable = [
      'if a then\n  print(1)\n',                       // block never closed
      'print(1)\nend\n',                               // surplus `end`
      'repeat\n  x()\nend\n',                         // closed with the wrong keyword
      'local t = { 1, 2\n',                            // bracket never closed
      'local t = (1]\n',                               // bracket closed by the wrong one
      'local x = if ready then 1\nprint(x)\n',         // if-expression with no `else`
    ];
    for (const source of unreadable) {
      const result = analyse(source);
      expect(result.status, source).toBe('fail');
      // One finding, naming the refusal: no other rule ran, so nothing else may
      // claim to have checked anything.
      expect(result.findings.map((finding) => finding.rule), source).toEqual(['luau/syntax-error']);
    }
  });
});
