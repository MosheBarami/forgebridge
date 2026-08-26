import { describe, expect, it } from 'vitest';
import { LIMITS, STRUCTURAL_PROPERTIES } from '@forgebridge/protocol';
import { codeOfFailure } from '../src/errors.js';
import { objectOf, proposeChangeSetInput } from '../src/schemas.js';
import { registerForgeBridgeTools, type McpServerLike } from '../src/register.js';
import { TOOLS } from '../src/tools.js';
import type { ToolResult } from '../src/errors.js';
import { contextFor, fakeDaemon, proposalArgs } from './fake-daemon.js';

/**
 * Malformed input is refused before it reaches the place.
 *
 * The point of deriving these schemas from `@forgebridge/protocol` rather than
 * writing them again is that the protocol's three named refusals — a path that
 * is not a safe identifier, a `setProperty` on `Parent` or `Name`, a bag that
 * exceeds a bound — apply to an MCP caller for free. These tests check that the
 * derivation actually carries them, because a connector that re-declared a
 * looser shape would look identical until the day it let one of them through.
 */

const propose = objectOf(proposeChangeSetInput);

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'ModuleScript', source: 'return {}', ...overrides };
}

describe('propose_changeset input', () => {
  it('accepts a well-formed proposal', () => {
    expect(propose.safeParse(proposalArgs()).success).toBe(true);
  });

  it('refuses a path that is not a safe identifier', () => {
    // The exact smuggling `path.ts` exists to stop: a dot inside a name.
    const result = propose.safeParse(proposalArgs({ operations: [operation({ path: 'ServerScriptService.Sh op' })] }));
    expect(result.success).toBe(false);
  });

  it('refuses a path whose root is not an addressable service', () => {
    expect(propose.safeParse(proposalArgs({ operations: [operation({ path: 'NotAService.Thing' })] })).success).toBe(false);
  });

  it.each(STRUCTURAL_PROPERTIES)('refuses setProperty on %s', (property) => {
    const result = propose.safeParse(
      proposalArgs({
        operations: [{ op: 'setProperty', path: 'Workspace.Part', property, value: { t: 'String', v: 'x' } }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts the moveInstance that replaces them', () => {
    const result = propose.safeParse(
      proposalArgs({ operations: [{ op: 'moveInstance', path: 'Workspace.Part', to: 'ReplicatedStorage.Part' }] }),
    );
    expect(result.success).toBe(true);
  });

  it('refuses an unknown operation kind', () => {
    expect(propose.safeParse(proposalArgs({ operations: [{ op: 'evalLuau', path: 'Workspace.X' }] })).success).toBe(false);
  });

  it('refuses an empty operation list and one past the protocol ceiling', () => {
    expect(propose.safeParse(proposalArgs({ operations: [] })).success).toBe(false);
    const tooMany = Array.from({ length: LIMITS.MAX_OPERATIONS + 1 }, () => operation());
    expect(propose.safeParse(proposalArgs({ operations: tooMany })).success).toBe(false);
  });

  it('refuses an empty summary and a negative baseVersion', () => {
    expect(propose.safeParse(proposalArgs({ summary: '' })).success).toBe(false);
    expect(propose.safeParse(proposalArgs({ baseVersion: -1 })).success).toBe(false);
  });

  it('refuses a projectId that is not a uuid', () => {
    expect(propose.safeParse(proposalArgs({ projectId: 'the-shop' })).success).toBe(false);
  });
});

describe('a malformed call never reaches the daemon', () => {
  it('comes back as invalid_request with the field named', async () => {
    const daemon = fakeDaemon();
    const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
    const server: McpServerLike = {
      registerTool: (name, _config, handler) => {
        handlers.set(name, handler);
        return undefined;
      },
    };
    registerForgeBridgeTools(server, contextFor(daemon));

    const result = await handlers.get('forge.propose_changeset')!(proposalArgs({ operations: [operation({ path: 'Nope.X' })] }));

    expect(result.isError).toBe(true);
    expect(codeOfFailure(result)).toBe('invalid_request');
    expect(result.content[0]?.text).toContain('operations');
    expect(daemon.requests).toHaveLength(0);
  });

  it('is refused by the handler itself, not only by the client that calls it', async () => {
    // The SDK validates against the declared input schema before it dispatches.
    // The handler validates anyway: it has to be correct when it is called
    // directly, and a validation that only exists in the caller is a validation
    // that disappears the moment someone writes a second caller.
    const tool = TOOLS.find((entry) => entry.name === 'forge.diff_changeset')!;
    await expect(tool.handler({ changeSetId: 'not-a-uuid' }, contextFor(fakeDaemon()))).rejects.toThrow();
  });
});

describe('the whole-ChangeSet rule travels with the schema', () => {
  it('flags a delete of a path an earlier operation also touched', async () => {
    const daemon = fakeDaemon();
    const tool = TOOLS.find((entry) => entry.name === 'forge.propose_changeset')!;

    // Each operation is individually valid; the set is not. That rule lives in
    // ChangeSet.superRefine, which only runs because this connector assembles a
    // real ChangeSet rather than posting the fields it was handed.
    await expect(
      tool.handler(
        proposalArgs({
          operations: [
            { op: 'writeScript', path: 'Workspace.Doomed', scriptType: 'Script', source: 'print("hi")' },
            { op: 'deleteInstance', path: 'Workspace.Doomed' },
          ],
        }),
        contextFor(daemon),
      ),
    ).rejects.toThrow();

    expect(daemon.requests).toHaveLength(0);
  });
});
