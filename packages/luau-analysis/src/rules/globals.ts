/**
 * Globals that hand a script more power than a generated Roblox script has any
 * business holding, plus the two deprecated scheduler globals that models still
 * reach for because a decade of forum posts use them.
 */
import type { Finding } from '@forgebridge/protocol';
import { callParen, findingAt, isGlobalReference, type RuleContext } from '../query.js';
import type { Rule } from './index.js';

export const noLoadstring: Rule = {
  id: 'luau/no-loadstring',
  severities: ['error'],
  summary: 'A reference to the `loadstring` global, which compiles a string into a running function.',
  run(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (let i = 0; i < context.tokens.length; i += 1) {
      const token = context.tokens[i];
      if (token === undefined || !isGlobalReference(context.tokens, i, 'loadstring')) continue;
      findings.push(
        findingAt(
          token,
          'error',
          'luau/no-loadstring',
          '`loadstring` turns a string into running code, so whatever can influence that string can run ' +
            'code on your server — and it hides from review what this script actually does. Roblox also ' +
            'disables it by default (`ServerScriptService.LoadStringEnabled`), so this line fails at ' +
            'runtime in an ordinary place. Write the behaviour as a normal function, or put it in a ' +
            'ModuleScript and `require` it by path.',
        ),
      );
    }
    return findings;
  },
};

export const noGetfenvSetfenv: Rule = {
  id: 'luau/no-getfenv-setfenv',
  severities: ['error'],
  summary: 'A reference to `getfenv` or `setfenv`, which rewrite a function\'s global environment.',
  run(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (let i = 0; i < context.tokens.length; i += 1) {
      const token = context.tokens[i];
      if (token === undefined) continue;
      const name = ['getfenv', 'setfenv'].find((candidate) => isGlobalReference(context.tokens, i, candidate));
      if (name === undefined) continue;
      findings.push(
        findingAt(
          token,
          'error',
          'luau/no-getfenv-setfenv',
          `\`${name}\` reaches into a function's global environment. In a Roblox place that is how a script ` +
            'makes its own calls unreadable — to a reviewer and to this analyser — and using either one ' +
            'switches the whole script out of Luau\'s optimised path. If you need state per caller, pass it ' +
            'as an argument or capture it in an upvalue.',
        ),
      );
    }
    return findings;
  },
};

const DEPRECATED: Record<string, string> = {
  wait:
    '`wait()` is the deprecated scheduler global: it throttles under load and resumes later than the ' +
    'interval you asked for, which is why timing built on it drifts. Use `task.wait()`.',
  spawn:
    '`spawn()` is deprecated and does not start the thread now — it defers it, so code after it runs ' +
    'first and by a delay you do not control. Use `task.spawn()` to run it immediately, or `task.defer()` ' +
    'if deferring was the point.',
  delay:
    '`delay()` is deprecated and inherits the same throttled clock as `wait()`. Use `task.delay()`.',
};

export const deprecatedWaitSpawn: Rule = {
  id: 'luau/deprecated-wait-spawn',
  severities: ['warning'],
  summary: 'A call to the global `wait`, `spawn` or `delay` rather than the `task` library.',
  run(context: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (let i = 0; i < context.tokens.length; i += 1) {
      const token = context.tokens[i];
      if (token === undefined || token.kind !== 'name') continue;
      const message = DEPRECATED[token.text];
      if (message === undefined) continue;
      if (!isGlobalReference(context.tokens, i, token.text)) continue;
      // Only a call. A local named `spawn` that is merely read is somebody's
      // variable, and flagging it would teach readers to ignore this rule.
      if (callParen(context.tokens, i) === null) continue;
      findings.push(findingAt(token, 'warning', 'luau/deprecated-wait-spawn', message));
    }
    return findings;
  },
};
