/**
 * `require` of a numeric asset id.
 *
 * `require(script.Parent.Foo)` names a module that ships inside the place and
 * that a reviewer can read in the same diff. `require(1234567)` names a model on
 * the Roblox catalog, fetched at run time, at whatever version its author has
 * published by then. The two spellings look alike and mean entirely different
 * things about who controls the code that runs.
 */
import type { Finding } from '@forgebridge/protocol';
import { callParen, findingAt, isGlobalReference, splitArguments, type RuleContext } from '../query.js';
import type { Token } from '../tokenizer.js';
import type { Rule } from './index.js';

function isOpToken(token: { kind: string; text: string } | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'op' && token.text === text;
}

/**
 * True when the tokens in `[start, end)` call something that is not an instance
 * method: `getModuleId()`, `Loader.load(id)`, `resolve"shop"`.
 *
 * Navigating the instance tree is spelled with `:` in Roblox — `:GetService`,
 * `:FindFirstChild`, `:WaitForChild` — and a call written that way is part of
 * the path shape this rule steers people toward, so
 * `require(script:FindFirstChild("Optional"))` has to stay silent. A call
 * reached any other way returns whatever its author decided it returns, so which
 * module runs inside the place is settled at run time and nobody reviewing the
 * diff can read it.
 *
 * Luau spells a single-argument call three ways — `f(x)`, `f{t}` and `f"s"` —
 * and all three are calls, so all three are read here.
 */
function callsNonMethod(tokens: readonly Token[], start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const callee = tokens[i];
    if (callee === undefined || callee.kind !== 'name') continue;
    const next = tokens[i + 1];
    if (next === undefined) continue;
    const called = isOpToken(next, '(') || isOpToken(next, '{') || next.kind === 'string';
    if (!called) continue;
    if (isOpToken(tokens[i - 1], ':')) continue;
    return true;
  }
  return false;
}

export const requireUnreviewedAsset: Rule = {
  id: 'luau/require-unreviewed-asset',
  severities: ['error'],
  summary: 'A `require` whose argument is a numeric asset id rather than an instance in the place.',
  run(context: RuleContext): Finding[] {
    const { tokens, structure } = context;
    const findings: Finding[] = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === undefined || !isGlobalReference(tokens, i, 'require')) continue;
      const paren = callParen(tokens, i);
      if (paren === null) continue;

      const parts = splitArguments(tokens, structure, paren);
      const first = parts[0];
      if (first === undefined) continue;

      // Read the argument through any wrapping parentheses.
      //
      // Matching exactly one token meant `require((1234567))` and
      // `require(1234567 + 0)` — semantically identical Luau, and not even
      // obfuscation — walked past. One added pair of parentheses turning a
      // security rule off is the definition of fail-open.
      let start = first.start;
      let end = first.end;
      while (
        end - start >= 2 &&
        isOpToken(tokens[start], '(') &&
        isOpToken(tokens[end - 1], ')')
      ) {
        start += 1;
        end -= 1;
      }

      const inner = tokens.slice(start, end);
      if (inner.length === 0) continue;

      // A path expression is the shape we steer people toward, and it is
      // richer than `a.b.c`: `require(game:GetService("ReplicatedStorage").Modules.Shop)`
      // and `require(script:FindFirstChild("Optional"))` are ordinary, correct
      // Roblox code. So a path may contain names, dots, colons, call parens,
      // commas and string arguments — it may NOT contain a number or an
      // arithmetic operator, which are what an asset id is made of.
      const COMPUTED_OPS = new Set(['+', '-', '*', '/', '%', '^', '..']);
      const containsNumber = inner.some((t) => t.kind === 'number');
      const containsArithmetic = inner.some((t) => t.kind === 'op' && COMPUTED_OPS.has(t.text));

      // Nor is a number the only way to build a target at run time.
      // `require(getModuleId())` holds no number and no arithmetic, so the two
      // tests above both said no and the require walked past in silence — while
      // the comment on the branch below says a computed target is exactly the
      // case a reviewer needs to see. The scan runs over the argument as
      // written, not over `inner`, because the wrapping-parenthesis strip above
      // is a text trim rather than a bracket match.
      const computedCall = callsNonMethod(tokens, first.start, first.end);

      if (!containsNumber && !containsArithmetic && !computedCall) continue;

      const single = inner.length === 1 ? inner[0] : undefined;
      const numeric = single !== undefined && single.kind === 'number';

      // Fail closed on a computed target: a require whose destination is built
      // at run time is exactly the case a reviewer needs to see.
      //
      // Ordered ahead of the asset-id branch so the message stays true.
      // `require(getId(1))` carries a number without naming an asset, and
      // calling it a catalog asset id would be a claim the reader can check and
      // find wrong — the fastest way to teach someone to stop reading findings.
      if (computedCall || !containsNumber) {
        findings.push(
          findingAt(
            token,
            'warning',
            'luau/require-unreviewed-asset',
            'This `require` is given an expression rather than a path, so this check cannot tell what ' +
              'gets loaded and run inside your place. Require by path — `require(script.Parent.ModuleName)` ' +
              '— so the module being run is visible in the diff.',
          ),
        );
        continue;
      }

      const shown = numeric ? (single as { text: string }).text : inner.map((t) => t.text).join(' ');
      findings.push(
        findingAt(
          token,
          'error',
          'luau/require-unreviewed-asset',
          `\`require(${shown})\` resolves to a Roblox catalog asset id: it downloads a model and runs its ` +
            'code inside your place, at whatever version its author has published at the moment it runs. ' +
            'Nobody in this review has read that code, and the author can change it after you ship. Copy ' +
            'the module into the place and require it by path — `require(script.Parent.ModuleName)` — or ' +
            'vendor it into ReplicatedStorage where it shows up in a diff.',
        ),
      );
    }

    return findings;
  },
};
