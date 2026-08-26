/**
 * A server-side remote handler that uses its arguments without checking them.
 *
 * This is the exploit vector in Roblox: a `RemoteEvent` is a function the client
 * calls, and the client controls every argument past `player`. A handler that
 * reads `amount` and adds it to a balance is a handler that hands the balance to
 * anyone who can open a script executor. The mistake is easy for a model to make
 * because the wrong version reads like ordinary code.
 *
 * The check is a use-without-test check, not a proof of correct validation: it
 * asks whether the script tested the value at all before using it. That catches
 * the version with no check anywhere, which is the common one, and it will not
 * catch a check that is present but wrong.
 *
 * TODO(M10 follow-up): the stronger form needs dataflow — a value reaching a
 * sink after a test that actually constrains its type and range, with local
 * rebinding and shadowing tracked. Until that exists this rule is `warning`
 * rather than `error`, so a false positive costs a reader one line of reading
 * and never blocks a ChangeSet on its own.
 */
import type { Finding } from '@forgebridge/protocol';
import {
  callParen,
  endOfExpression,
  findingAt,
  findKeywordAfter,
  inlineHandlerBlock,
  isKeyword,
  isMemberAccess,
  isOp,
  parameterList,
  type RuleContext,
} from '../query.js';
import type { Block } from '../structure.js';
import type { Rule } from './index.js';

/**
 * Calls whose argument counts as a test of the value passed to them. Kept
 * small and obvious: each of these makes the script look at the value before
 * trusting it, which is the question this rule asks.
 */
const GUARD_CALLS: ReadonlySet<string> = new Set(['assert', 'typeof', 'type', 'tonumber']);

interface Handler {
  /** Token to attribute the handler to in a message. */
  signal: string;
  body: Block;
  /** Parameter list of the handler function. */
  functionIndex: number;
}

export const remoteNoValidation: Rule = {
  id: 'luau/remote-no-validation',
  severities: ['warning'],
  summary: 'A server-side remote handler that uses a client-supplied argument without testing it first.',
  run(context: RuleContext): Finding[] {
    const { tokens } = context;
    const findings: Finding[] = [];
    const guards = guardRanges(context);

    for (const handler of remoteHandlers(context)) {
      const { parameters, vararg, varargIndex, bodyStart } = parameterList(context, handler.functionIndex);
      const bodyEnd = handler.body.close;

      if (vararg) {
        const token = tokens[varargIndex];
        if (token !== undefined) {
          findings.push(
            findingAt(
              token,
              'warning',
              'luau/remote-no-validation',
              `This \`${handler.signal}\` handler takes \`...\`, so every argument the client sends past ` +
                '`player` arrives unnamed and unchecked. A client can send any number of arguments of any ' +
                'type. Name the arguments you expect and check each one before use.',
            ),
          );
        }
      }

      // The first parameter is the `Player` the engine supplies, not something
      // the client chose. Everything after it is attacker-controlled.
      for (const parameter of parameters.slice(1)) {
        const uses: number[] = [];
        for (let i = bodyStart; i < bodyEnd; i += 1) {
          const token = tokens[i];
          if (token === undefined || token.kind !== 'name' || token.text !== parameter.name) continue;
          if (isMemberAccess(tokens, i)) continue;
          uses.push(i);
        }
        if (uses.length === 0) continue;
        if (uses.some((index) => guards.some((range) => index >= range.start && index < range.end))) continue;

        const first = tokens[uses[0] as number];
        if (first === undefined) continue;
        findings.push(
          findingAt(
            first,
            'warning',
            'luau/remote-no-validation',
            `\`${parameter.name}\` comes from the client through \`${handler.signal}\` and is used here ` +
              'without ever being checked. A client can send a value of any type and any size — a table ' +
              'where a number is expected, a number large enough to break the arithmetic, a string a ' +
              'megabyte long — and everything downstream of this line inherits that. Test it first, for ' +
              `example \`if typeof(${parameter.name}) ~= "number" then return end\`, and bound the range ` +
              'before using it.',
          ),
        );
      }
    }

    return findings;
  },
};

/** Every `OnServerEvent:Connect(function …)` and `OnServerInvoke = function …` in the source. */
function remoteHandlers(context: RuleContext): Handler[] {
  const { tokens, structure } = context;
  const handlers: Handler[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'name') continue;

    if (token.text === 'OnServerEvent' && isOp(tokens, i - 1, '.') && isOp(tokens, i + 1, ':')) {
      const method = tokens[i + 2];
      if (method === undefined || method.kind !== 'name') continue;
      if (method.text !== 'Connect' && method.text !== 'ConnectParallel' && method.text !== 'Once') continue;
      const body = inlineHandlerBlock(context, i + 2);
      if (body === null) continue;
      handlers.push({ signal: 'OnServerEvent', body, functionIndex: body.open });
      continue;
    }

    if (token.text === 'OnServerInvoke' && isOp(tokens, i - 1, '.') && isOp(tokens, i + 1, '=')) {
      if (!isKeyword(tokens, i + 2, 'function')) continue;
      const block = structure.blocks.find((candidate) => candidate.open === i + 2 && candidate.kind === 'function');
      if (block === undefined) continue;
      handlers.push({ signal: 'OnServerInvoke', body: block, functionIndex: block.open });
    }
  }

  return handlers;
}

/**
 * Token ranges in which a value is being tested rather than used: the condition
 * of an `if`/`elseif`/`while`/`until`, and the arguments of the guard calls.
 */
function guardRanges(context: RuleContext): { start: number; end: number }[] {
  const { tokens, structure } = context;
  const ranges: { start: number; end: number }[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (token.kind === 'keyword' && (token.text === 'if' || token.text === 'elseif')) {
      const then = findKeywordAfter(context, i + 1, 'then', tokens.length);
      ranges.push({ start: i + 1, end: then === -1 ? endOfExpression(context, i + 1) : then });
      continue;
    }

    if (token.kind === 'keyword' && token.text === 'while') {
      const doAt = findKeywordAfter(context, i + 1, 'do', tokens.length);
      ranges.push({ start: i + 1, end: doAt === -1 ? endOfExpression(context, i + 1) : doAt });
      continue;
    }

    if (token.kind === 'keyword' && token.text === 'until') {
      ranges.push({ start: i + 1, end: endOfExpression(context, i + 1) });
      continue;
    }

    if (token.kind === 'name' && GUARD_CALLS.has(token.text) && !isMemberAccess(tokens, i)) {
      const paren = callParen(tokens, i);
      if (paren === null) continue;
      const close = structure.bracket.get(paren);
      if (close === undefined) continue;
      ranges.push({ start: paren + 1, end: close });
    }
  }

  return ranges;
}
