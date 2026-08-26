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
  bindingOf,
  callParen,
  endOfExpression,
  findingAt,
  findKeywordAfter,
  inlineHandlerBlock,
  isKeyword,
  isMemberAccess,
  isOp,
  parameterList,
  startOfPrefixExpression,
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

/** The ways a script subscribes to a signal. `Once` fires the handler too. */
const CONNECT_METHODS: ReadonlySet<string> = new Set(['Connect', 'ConnectParallel', 'Once']);

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
  const bound = serverEventNames(context);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    // `<signal>:Connect(function(player, …) … end)`, keyed on the method rather
    // than on the property name so the receiver can be resolved separately.
    if (token.kind === 'name' && CONNECT_METHODS.has(token.text) && isOp(tokens, i - 1, ':')) {
      if (!isServerEvent(context, bound, i)) continue;
      const body = inlineHandlerBlock(context, i);
      if (body === null) continue;
      handlers.push({ signal: 'OnServerEvent', body, functionIndex: body.open });
      continue;
    }

    // `remote.OnServerInvoke = function(player, …)`, and the bracket spelling of
    // the same assignment. A RemoteFunction handler is a property rather than a
    // signal, so there is no `Connect` here to key on — and no local-binding
    // case either, because assigning a function to a local sets no property.
    const invokeEquals =
      token.kind === 'name' && token.text === 'OnServerInvoke' && isOp(tokens, i - 1, '.')
        ? i + 1
        : token.kind === 'string' &&
            token.value === 'OnServerInvoke' &&
            isOp(tokens, i - 1, '[') &&
            isOp(tokens, i + 1, ']')
          ? i + 2
          : -1;
    if (invokeEquals === -1 || !isOp(tokens, invokeEquals, '=')) continue;
    if (!isKeyword(tokens, invokeEquals + 1, 'function')) continue;
    const block = structure.blocks.find(
      (candidate) => candidate.open === invokeEquals + 1 && candidate.kind === 'function',
    );
    if (block === undefined) continue;
    handlers.push({ signal: 'OnServerInvoke', body: block, functionIndex: block.open });
  }

  return handlers;
}

/**
 * True when the `:Connect` whose method name sits at `method` is subscribing to
 * a `RemoteEvent`'s `OnServerEvent`.
 *
 * Three spellings reach the same signal and all three are ordinary code:
 * `Remotes.Buy.OnServerEvent:Connect(…)`, `Remotes.Buy["OnServerEvent"]:Connect(…)`,
 * and either of those bound to a local first —
 *
 *   local ev = Remotes.GiveCash.OnServerEvent
 *   ev:Connect(function(player, amount) … end)
 *
 * The rule used to require the literal token run `OnServerEvent` `:` `Connect`,
 * so both of the others turned it off even with the handler written inline
 * underneath. Both were confirmed against the built analyser: `status: 'ok'`,
 * zero findings, on a handler that adds a client-supplied number to a balance.
 * This is the vector that costs a real place its economy, so a spelling missed
 * here is the expensive kind of miss.
 *
 * A receiver this check cannot read — `signals[name]:Connect(…)` — is not
 * treated as a remote. Every finding here names a parameter of a handler and
 * says the client controls it; saying that about a handler for some other
 * signal is a false accusation a reader can check, and one of those teaches
 * them to stop reading the rest.
 */
function isServerEvent(context: RuleContext, bound: ReadonlySet<string>, method: number): boolean {
  const { tokens, structure } = context;
  // The `:` is at `method - 1`, so the receiver ends at `method - 2`.
  const end = method - 2;
  const receiver = tokens[end];
  if (receiver === undefined) return false;

  if (isOp(tokens, end, ']')) {
    const open = structure.bracket.get(end);
    // Exactly one token between the brackets, and a string this analyser could
    // decode: `remote[k]` and `remote["OnServer" .. "Event"]` name nothing.
    if (open === undefined || open !== end - 2) return false;
    const key = tokens[open + 1];
    return key !== undefined && key.kind === 'string' && key.value === 'OnServerEvent';
  }

  if (receiver.kind !== 'name') return false;
  if (receiver.text === 'OnServerEvent' && isOp(tokens, end - 1, '.')) return true;
  // `thing.ev:Connect(…)` is a field of somebody else's table, not the local.
  if (isMemberAccess(tokens, end)) return false;
  return bound.has(receiver.text);
}

/** Local names bound to an `OnServerEvent` — `local ev = Remotes.GiveCash.OnServerEvent`. */
function serverEventNames(context: RuleContext): Set<string> {
  const { tokens } = context;
  const names = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    // `… .OnServerEvent` — the value ends at the name.
    if (token.kind === 'name' && token.text === 'OnServerEvent' && isOp(tokens, i - 1, '.')) {
      bindSignal(context, names, i);
      continue;
    }

    // `… ["OnServerEvent"]` — it ends at the `]`.
    if (token.kind === 'string' && token.value === 'OnServerEvent') {
      if (isOp(tokens, i - 1, '[') && isOp(tokens, i + 1, ']')) bindSignal(context, names, i + 1);
    }
  }

  return names;
}

/** Records the local `valueEnd`'s expression is assigned to, when it is assigned to one. */
function bindSignal(context: RuleContext, names: Set<string>, valueEnd: number): void {
  const binding = bindingOf(context, startOfPrefixExpression(context, valueEnd), valueEnd);
  if (binding !== null) names.add(binding.name);
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
