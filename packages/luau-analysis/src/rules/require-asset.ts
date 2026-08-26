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
import type { Rule } from './index.js';

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

      // Exactly one token, and it is a number: `require(1234567)`. Anything
      // else — a path, a variable, an expression — is not something this rule
      // can call unreviewed, and it says so rather than guessing.
      if (first.end - first.start !== 1) continue;
      const argument = tokens[first.start];
      if (argument === undefined || argument.kind !== 'number') continue;

      findings.push(
        findingAt(
          token,
          'error',
          'luau/require-unreviewed-asset',
          `\`require(${argument.text})\` downloads a model from the Roblox catalog and runs its code inside ` +
            'your place, at whatever version its author has published at the moment it runs. Nobody in this ' +
            'review has read that code, and the author can change it after you ship. Copy the module into ' +
            'the place and require it by path — `require(script.Parent.ModuleName)` — or vendor it into ' +
            'ReplicatedStorage where it shows up in a diff.',
        ),
      );
    }

    return findings;
  },
};
