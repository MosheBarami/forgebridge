/**
 * The two ways generated Luau stops Studio responding.
 *
 * These are not security findings in the usual sense — nobody's data leaks —
 * but they are the ones that cost a user their afternoon. A `while true` with no
 * yield hangs Studio from the moment the script runs, and the only way out is
 * killing the process, which takes unsaved work with it. That is the failure
 * mode ForgeBridge exists to keep away from a place (THREAT-MODEL asset 2).
 */
import type { Finding } from '@forgebridge/protocol';
import {
  anyToken,
  bindingOf,
  endOfExpression,
  findingAt,
  inlineHandlerBlock,
  isKeyword,
  isMemberAccess,
  isOp,
  isYieldCall,
  startOfPrefixExpression,
  type RuleContext,
} from '../query.js';
import { enclosingBlocks, enclosingFunction, enclosingLoop, type Block, type Structure } from '../structure.js';
import type { Rule } from './index.js';

/** RunService signals that fire once per frame. Work here has about a frame to finish. */
const PER_FRAME_SIGNALS: ReadonlySet<string> = new Set(['Heartbeat', 'Stepped', 'RenderStepped']);

const CONNECT_METHODS: ReadonlySet<string> = new Set(['Connect', 'ConnectParallel', 'Once']);

interface LoopFacts {
  /** The `while`, `repeat` or `for` keyword introducing the loop. */
  keyword: number;
  kind: 'while' | 'repeat' | 'for';
  block: Block;
  /** A yield that can run, on this loop's own thread — not one inside a nested closure or a dead branch. */
  yields: boolean;
  /** A `break` that can run and belongs to this loop, not to a nested one. */
  breaks: boolean;
  /** A `return` that can run, from the function this loop is in rather than from a nested closure. */
  returns: boolean;
}

function describeLoop(context: RuleContext, block: Block): LoopFacts | null {
  const { tokens, structure } = context;
  let keyword: number;
  let kind: LoopFacts['kind'];

  if (block.kind === 'repeat') {
    keyword = block.open;
    kind = 'repeat';
  } else if (block.kind === 'do' && block.loopKeyword !== undefined) {
    keyword = block.loopKeyword;
    kind = isKeyword(tokens, keyword, 'for') ? 'for' : 'while';
  } else {
    return null;
  }

  const bodyStart = block.open + 1;
  const bodyEnd = block.close;
  const ownFunction = enclosingFunction(structure, keyword);

  const yields = anyToken(bodyStart, bodyEnd, (i) => {
    if (!isYieldCall(tokens, i)) return false;
    // A `task.wait()` inside a closure declared in the loop yields that closure,
    // not this loop. Counting it would report a freeze as safe.
    const fn = enclosingFunction(structure, i);
    if (fn?.self !== ownFunction?.self) return false;
    // And a yield in a branch that never runs is not a yield, for the same
    // reason a `break` there is not a way out.
    return !inDeadBranch(context, i, block);
  });

  const breaks = anyToken(bodyStart, bodyEnd, (i) => {
    if (!isKeyword(tokens, i, 'break')) return false;
    if (enclosingLoop(structure, i)?.self !== block.self) return false;
    // A `break` written inside a closure declared in the loop belongs to no
    // loop at all — Luau rejects it — but this analyser has no grammar to
    // reject it with, so it would otherwise silence the rule on a source that
    // spins forever and does not even compile.
    if (enclosingFunction(structure, i)?.self !== ownFunction?.self) return false;
    return !inDeadBranch(context, i, block);
  });

  const returns = anyToken(bodyStart, bodyEnd, (i) => {
    if (!isKeyword(tokens, i, 'return')) return false;
    const fn = enclosingFunction(structure, i);
    if (fn?.self !== ownFunction?.self) return false;
    return !inDeadBranch(context, i, block);
  });

  return { keyword, kind, block, yields, breaks, returns };
}

/**
 * Whether the tokens in `[start, end)` are a single literal value, and if so
 * whether Luau reads it as true.
 *
 * Only `false` and `nil` are falsy in Luau: `0` and `""` are both true. So
 * `while 1 do`, `while "go" do` and `while ((true)) do` spin exactly as hard as
 * `while true do`, and a check that recognised only the bare keyword `true`
 * missed all three. Returns null for anything else, which is every real
 * condition — this decides literals, not reachability.
 */
function staticTruthiness(context: RuleContext, start: number, end: number): boolean | null {
  const { tokens, structure } = context;
  let from = start;
  let to = end;
  // Parentheses around a literal change nothing, however many there are.
  while (to - from >= 2 && isOp(tokens, from, '(') && structure.bracket.get(from) === to - 1) {
    from += 1;
    to -= 1;
  }
  if (to - from !== 1) return null;

  const token = tokens[from];
  if (token === undefined) return null;
  if (token.kind === 'number' || token.kind === 'string') return true;
  if (token.kind !== 'keyword') return null;
  if (token.text === 'true') return true;
  if (token.text === 'false' || token.text === 'nil') return false;
  return null;
}

/** True when this loop's own condition can never end it. */
function isUnconditional(context: RuleContext, facts: LoopFacts): boolean {
  if (facts.kind === 'while') {
    // `facts.block.open` is the `do`, so the condition is everything between.
    return staticTruthiness(context, facts.keyword + 1, facts.block.open) === true;
  }
  if (facts.kind === 'repeat') {
    // `until false` — and `until false or done` is a real condition, which is
    // why the range comes from `endOfExpression` rather than from one token.
    const start = facts.block.close + 1;
    return staticTruthiness(context, start, endOfExpression(context, start)) === false;
  }
  return false;
}

/**
 * True when `index` sits in a branch of an `if` inside `loop` that can never
 * run: the `then` of an `if` whose condition is a literal false, or the arms
 * after an `if` whose condition is a literal true.
 *
 * Deliberately narrow. General reachability is not a question a token stream
 * can answer, but `if false then break end` is, and it is valid Luau: before
 * this check that `break` counted, so a loop that hangs Studio for ever was
 * reported as one that can leave. Anything less obvious than a literal is
 * treated as reachable, which keeps the rule firing rather than guessing.
 */
function inDeadBranch(context: RuleContext, index: number, loop: Block): boolean {
  const { structure } = context;
  for (const block of enclosingBlocks(structure, index)) {
    if (block.self === loop.self) break;
    if (block.kind !== 'if') continue;
    for (const arm of ifArms(context, block)) {
      if (index < arm.start || index >= arm.end) continue;
      if (arm.condition === null) {
        // The `else`: dead only when an earlier arm always runs.
        if (arm.precededByCertainArm) return true;
        continue;
      }
      if (staticTruthiness(context, arm.condition.start, arm.condition.end) === false) return true;
      if (arm.precededByCertainArm) return true;
    }
  }
  return false;
}

interface IfArm {
  /** Condition range, or null for the `else` arm. */
  condition: { start: number; end: number } | null;
  /** Body range, half-open. */
  start: number;
  end: number;
  /** True when an earlier arm of the same `if` has a condition that is always true. */
  precededByCertainArm: boolean;
}

/**
 * The arms of an `if` block: each condition and the body it guards.
 *
 * `then`, `elseif` and `else` tokens that belong to an if-*expression* written
 * inside one of the branches are skipped — `structure.expressionBranches` is
 * what tells them apart — because such a token is part of a value, not the
 * start of another arm.
 */
/**
 * Arms are read once per `if` block and kept.
 *
 * Without this, a `break` nested N ifs deep re-reads every one of them, and a
 * source built out of nothing but nested ifs turns a linear rule into a cubic
 * one. The analyser's token budget bounds how bad that gets, but a budget is
 * not a reason to spend it.
 */
const ARM_CACHE = new WeakMap<Structure, Map<number, IfArm[]>>();

function ifArms(context: RuleContext, block: Block): IfArm[] {
  const { tokens, structure } = context;
  let cache = ARM_CACHE.get(structure);
  if (cache === undefined) {
    cache = new Map<number, IfArm[]>();
    ARM_CACHE.set(structure, cache);
  }
  const cached = cache.get(block.self);
  if (cached !== undefined) return cached;

  const marks: number[] = [];
  for (let i = block.open + 1; i < block.close; i += 1) {
    if (structure.innermost[i] !== block.self) continue;
    if (structure.expressionBranches.has(i)) continue;
    const token = tokens[i];
    if (token === undefined || token.kind !== 'keyword') continue;
    if (token.text === 'then' || token.text === 'elseif' || token.text === 'else') marks.push(i);
  }

  const arms: IfArm[] = [];
  let condition: { start: number; end: number } | null = { start: block.open + 1, end: -1 };
  let precededByCertainArm = false;

  for (let m = 0; m < marks.length; m += 1) {
    const mark = marks[m] as number;
    const token = tokens[mark] as { text: string };
    const nextMark = (marks[m + 1] as number | undefined) ?? block.close;

    if (token.text === 'then') {
      if (condition === null) {
        // A `then` with no condition in front of it: give up rather than guess.
        cache.set(block.self, arms);
        return arms;
      }
      condition.end = mark;
      arms.push({ condition, start: mark + 1, end: nextMark, precededByCertainArm });
      // Once one arm's condition is always true, every arm after it is dead.
      if (staticTruthiness(context, condition.start, condition.end) === true) precededByCertainArm = true;
      condition = null;
      continue;
    }

    if (token.text === 'elseif') {
      condition = { start: mark + 1, end: -1 };
      continue;
    }

    // `else`
    arms.push({ condition: null, start: mark + 1, end: nextMark, precededByCertainArm });
    condition = null;
  }

  cache.set(block.self, arms);
  return arms;
}

export const whileTrueNoYield: Rule = {
  id: 'luau/while-true-no-yield',
  severities: ['error'],
  summary: 'A `while true` (or `repeat … until false`) loop with no yield, `break` or `return`.',
  run(context: RuleContext): Finding[] {
    const { tokens, structure } = context;
    const findings: Finding[] = [];

    for (const block of structure.blocks) {
      const facts = describeLoop(context, block);
      if (facts === null || facts.kind === 'for') continue;
      if (!isUnconditional(context, facts)) continue;
      if (facts.yields || facts.breaks || facts.returns) continue;

      const token = tokens[facts.keyword];
      if (token === undefined) continue;
      const shape = facts.kind === 'while' ? '`while true do`' : '`repeat … until false`';
      findings.push(
        findingAt(
          token,
          'error',
          'luau/while-true-no-yield',
          `${shape} with nothing inside it that yields, breaks or returns never gives the scheduler a turn. ` +
            'Running this hangs Studio the moment the script executes — the window stops repainting and the ' +
            'only way out is killing the process, which loses whatever was unsaved. Put a `task.wait()` ' +
            'inside the loop if it is meant to run forever, or drive the work from an event instead of ' +
            'spinning on it.',
        ),
      );
    }

    return findings;
  },
};

export const unboundedHeartbeat: Rule = {
  id: 'luau/unbounded-heartbeat',
  severities: ['error', 'warning'],
  summary: 'A `while` or `repeat` loop inside a per-frame `RunService` handler.',
  run(context: RuleContext): Finding[] {
    const { tokens, structure } = context;
    const findings: Finding[] = [];
    const bound = perFrameSignalNames(context);

    for (let i = 0; i < tokens.length; i += 1) {
      const method = tokens[i];
      if (method === undefined || method.kind !== 'name' || !CONNECT_METHODS.has(method.text)) continue;
      if (!isOp(tokens, i - 1, ':')) continue;

      const receiver = tokens[i - 2];
      if (receiver === undefined || receiver.kind !== 'name') continue;
      // Either the signal is named right here — `RunService.Heartbeat:Connect` —
      // or it reached a local first, which is ordinary code and not evasion.
      const signalName =
        PER_FRAME_SIGNALS.has(receiver.text) && isOp(tokens, i - 3, '.')
          ? receiver.text
          : isMemberAccess(tokens, i - 2)
            ? undefined
            : bound.get(receiver.text);
      if (signalName === undefined) continue;

      const handler = inlineHandlerBlock(context, i);
      if (handler === null) continue;

      for (const block of structure.blocks) {
        if (block.open <= handler.open || block.close >= handler.close) continue;
        const facts = describeLoop(context, block);
        if (facts === null || facts.kind === 'for') continue;
        // Only loops on the handler's own thread. A loop inside a nested
        // closure runs when that closure is called, which may be nowhere near
        // the frame.
        if (enclosingFunction(structure, facts.keyword)?.self !== handler.self) continue;

        const token = tokens[facts.keyword];
        if (token === undefined) continue;
        const escapes = facts.yields || facts.breaks || facts.returns;

        findings.push(
          findingAt(
            token,
            escapes ? 'warning' : 'error',
            'luau/unbounded-heartbeat',
            escapes
              ? `\`RunService.${signalName}\` fires every frame, and this handler runs a \`${facts.kind}\` ` +
                'loop each time. The loop can exit, but nothing here bounds how long it takes, and the ' +
                'handler has roughly one frame before it is holding up the next one. Iterate a fixed slice ' +
                'with a numeric `for`, or move the loop off the frame with `task.spawn`.'
              : `\`RunService.${signalName}\` fires every frame, and this handler runs a \`${facts.kind}\` ` +
                'loop with no yield, no `break` and no `return` inside it. The first frame that reaches ' +
                'this loop never finishes: Studio stops responding and stays that way. Bound the work — a ' +
                'numeric `for` over a fixed slice — or move the loop into `task.spawn` outside the handler ' +
                'so the frame is not waiting on it.',
          ),
        );
      }
    }

    return findings;
  },
};

/**
 * Local names bound to a per-frame signal — `local heartbeat = RunService.Heartbeat`.
 *
 * The rule used to require the literal token run `.Heartbeat:Connect(function`,
 * so one intervening local turned it off. That spelling is not evasion: a
 * handler is often connected somewhere other than where the signal was looked
 * up, and a rule that only sees the one-liner reports `ok` on the other half of
 * real code.
 */
function perFrameSignalNames(context: RuleContext): Map<string, string> {
  const { tokens } = context;
  const names = new Map<string, string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'name' || !PER_FRAME_SIGNALS.has(token.text)) continue;
    if (!isOp(tokens, i - 1, '.')) continue;
    const binding = bindingOf(context, startOfPrefixExpression(context, i), i);
    if (binding !== null) names.set(binding.name, token.text);
  }

  return names;
}
