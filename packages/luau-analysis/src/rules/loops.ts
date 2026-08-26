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
  findingAt,
  inlineHandlerBlock,
  isKeyword,
  isOp,
  isYieldCall,
  type RuleContext,
} from '../query.js';
import { enclosingFunction, enclosingLoop, type Block } from '../structure.js';
import type { Rule } from './index.js';

/** RunService signals that fire once per frame. Work here has about a frame to finish. */
const PER_FRAME_SIGNALS: ReadonlySet<string> = new Set(['Heartbeat', 'Stepped', 'RenderStepped']);

const CONNECT_METHODS: ReadonlySet<string> = new Set(['Connect', 'ConnectParallel', 'Once']);

interface LoopFacts {
  /** The `while`, `repeat` or `for` keyword introducing the loop. */
  keyword: number;
  kind: 'while' | 'repeat' | 'for';
  block: Block;
  /** A yield reached on this loop's own thread — not one inside a nested closure. */
  yields: boolean;
  /** A `break` belonging to this loop, not to a nested one. */
  breaks: boolean;
  /** A `return` from the function this loop is in, not from a nested closure. */
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
    return fn?.self === ownFunction?.self;
  });

  const breaks = anyToken(bodyStart, bodyEnd, (i) => {
    if (!isKeyword(tokens, i, 'break')) return false;
    return enclosingLoop(structure, i)?.self === block.self;
  });

  const returns = anyToken(bodyStart, bodyEnd, (i) => {
    if (!isKeyword(tokens, i, 'return')) return false;
    const fn = enclosingFunction(structure, i);
    return fn?.self === ownFunction?.self;
  });

  return { keyword, kind, block, yields, breaks, returns };
}

/** True when the loop's condition is the literal `true` (or `repeat … until false`). */
function isUnconditional(context: RuleContext, facts: LoopFacts): boolean {
  const { tokens } = context;
  if (facts.kind === 'while') {
    // `while true do`, and `while (true) do`.
    if (isKeyword(tokens, facts.keyword + 1, 'true') && isKeyword(tokens, facts.keyword + 2, 'do')) return true;
    return (
      isOp(tokens, facts.keyword + 1, '(') &&
      isKeyword(tokens, facts.keyword + 2, 'true') &&
      isOp(tokens, facts.keyword + 3, ')') &&
      isKeyword(tokens, facts.keyword + 4, 'do')
    );
  }
  if (facts.kind === 'repeat') {
    // `until false` — and only that; `until false or done` is a real condition.
    const after = facts.block.close + 2;
    const next = tokens[after];
    if (!isKeyword(tokens, facts.block.close + 1, 'false')) return false;
    return next === undefined || next.kind === 'eof' || !continuesExpression(next.kind, next.text);
  }
  return false;
}

function continuesExpression(kind: string, text: string): boolean {
  if (kind === 'keyword') return text === 'and' || text === 'or';
  if (kind !== 'op') return false;
  return !(text === ';' || text === ')' || text === '}' || text === ',');
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

    for (let i = 0; i < tokens.length; i += 1) {
      const method = tokens[i];
      if (method === undefined || method.kind !== 'name' || !CONNECT_METHODS.has(method.text)) continue;
      if (!isOp(tokens, i - 1, ':')) continue;

      const signal = tokens[i - 2];
      if (signal === undefined || signal.kind !== 'name' || !PER_FRAME_SIGNALS.has(signal.text)) continue;
      if (!isOp(tokens, i - 3, '.')) continue;

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
              ? `\`RunService.${signal.text}\` fires every frame, and this handler runs a \`${facts.kind}\` ` +
                'loop each time. The loop can exit, but nothing here bounds how long it takes, and the ' +
                'handler has roughly one frame before it is holding up the next one. Iterate a fixed slice ' +
                'with a numeric `for`, or move the loop off the frame with `task.spawn`.'
              : `\`RunService.${signal.text}\` fires every frame, and this handler runs a \`${facts.kind}\` ` +
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
