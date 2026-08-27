import { describe, expect, it } from 'vitest';
import { registerForgeBridgeTools, renderToolName, type McpServerLike, type ToolRegistration } from '../src/register.js';
import { TOOLS, TOOL_NAMES } from '../src/tools.js';
import { codeOfFailure, type ToolResult } from '../src/errors.js';
import { contextFor, fakeDaemon, payloadOf } from './fake-daemon.js';
import { LocalOperatorRollbackGate } from '../src/approval.js';

/**
 * The surface itself: the names `docs/ARCHITECTURE.md` §5 fixes, and the fact
 * that every one of them is actually registered.
 *
 * The names are written out here rather than derived from `TOOLS`, because a
 * test that reads its expectation out of the thing under test would pass a
 * rename that broke every client configuration in the README.
 */

const ARCHITECTURE_TOOL_NAMES = [
  'forge.list_projects',
  'forge.read_tree',
  'forge.read_script',
  'forge.start_run',
  'forge.propose_changeset',
  'forge.diff_changeset',
  'forge.apply_changeset',
  'forge.run_tests',
  'forge.rollback',
  'forge.tail_output',
  'forge.list_models',
  'forge.link_status',
];

interface Registered {
  name: string;
  config: ToolRegistration;
  handler: (args: unknown) => Promise<ToolResult>;
}

function recordingServer(): { server: McpServerLike; registered: Registered[] } {
  const registered: Registered[] = [];
  return {
    registered,
    server: {
      registerTool: (name, config, handler) => {
        registered.push({ name, config, handler });
        return undefined;
      },
    },
  };
}

describe('tool registration', () => {
  it('registers exactly the twelve tools the architecture names', () => {
    const { server, registered } = recordingServer();
    const names = registerForgeBridgeTools(server, contextFor(fakeDaemon()));

    expect(names).toEqual(ARCHITECTURE_TOOL_NAMES);
    expect(registered.map((entry) => entry.name)).toEqual(ARCHITECTURE_TOOL_NAMES);
    expect(TOOL_NAMES).toEqual(ARCHITECTURE_TOOL_NAMES);
  });

  it('gives every tool a title, a description and an input schema', () => {
    const { server, registered } = recordingServer();
    registerForgeBridgeTools(server, contextFor(fakeDaemon()));

    for (const entry of registered) {
      expect(entry.config.title.length).toBeGreaterThan(0);
      // The description is the prompt the calling model reads. A stub is worse
      // than no tool: the model will call it anyway and guess at what it does.
      expect(entry.config.description.length).toBeGreaterThan(80);
      expect(entry.config.inputSchema).toBeDefined();
      expect(entry.config.annotations.openWorldHint).toBe(true);
    }
  });

  it('marks the one destructive tool and nothing else', () => {
    const destructive = TOOLS.filter((tool) => tool.destructiveHint).map((tool) => tool.name);
    expect(destructive).toEqual(['forge.rollback']);
  });

  it('renders names under a client that will not take a dot', () => {
    expect(renderToolName('forge.list_projects', '_')).toBe('forge_list_projects');
    const { server } = recordingServer();
    const names = registerForgeBridgeTools(server, contextFor(fakeDaemon()), { toolSeparator: '_' });
    expect(names[0]).toBe('forge_list_projects');
    // Under any separator the rendered names must still fit the grammar every
    // known client accepts.
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('tools that this transport does not serve', () => {
  it.each([
    ['forge.read_tree', 'not_found'],
    ['forge.read_script', 'not_found'],
    ['forge.run_tests', 'provider_unconfigured'],
  ])('%s refuses with %s rather than pretending', async (name, code) => {
    const daemon = fakeDaemon();
    const { server, registered } = recordingServer();
    registerForgeBridgeTools(server, contextFor(daemon));

    const result = await registered.find((entry) => entry.name === name)!.handler({});

    expect(result.isError).toBe(true);
    expect(codeOfFailure(result)).toBe(code);
    // It refuses without a round trip; a stub that called the daemon and
    // discarded the answer would be a stub that looks like it works.
    expect(daemon.requests).toHaveLength(0);
    // And it says which milestone lands it, so the refusal is actionable.
    expect(TOOLS.find((tool) => tool.name === name)!.description).toMatch(/M\d{2}/);
  });
});

describe('tools that this transport does serve', () => {
  it('list_projects reports the default project and its paired link', async () => {
    const daemon = fakeDaemon();
    const tool = TOOLS.find((entry) => entry.name === 'forge.list_projects')!;
    const payload = payloadOf(await tool.handler({}, contextFor(daemon)));

    const projects = payload['projects'] as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(1);
    expect(projects[0]?.['isDefault']).toBe(true);
    expect((projects[0]?.['links'] as unknown[])).toHaveLength(1);
    expect(daemon.paths()).toEqual(['GET /v1/link']);
  });

  it('tail_output returns the tail, and says how much it left behind', async () => {
    const daemon = fakeDaemon();
    const tool = TOOLS.find((entry) => entry.name === 'forge.tail_output')!;
    const payload = payloadOf(await tool.handler({ limit: 2 }, contextFor(daemon)));

    expect(payload['returned']).toBe(2);
    expect(payload['available']).toBe(3);
    expect((payload['messages'] as Array<{ message: string }>).map((m) => m.message)).toEqual(['two', 'three']);
  });

  it('rollback dispatches, once cleared, and reports that it is only dispatched', async () => {
    const daemon = fakeDaemon();
    const journalId = '44444444-4444-4444-8444-444444444444';
    const gate = new LocalOperatorRollbackGate();
    gate.record({ journalId, approvedBy: 'ada@example.com' });
    const tool = TOOLS.find((entry) => entry.name === 'forge.rollback')!;
    const payload = payloadOf(
      await tool.handler(
        { journalId, expectedVersion: 4, reason: 'the user asked' },
        contextFor(daemon, { rollbackGate: gate }),
      ),
    );

    expect(payload['status']).toBe('dispatched');
    expect(payload['approvedBy']).toBe('ada@example.com');
    expect(daemon.paths()).toEqual([`POST /v1/journal/${journalId}/rollback`]);
    expect(daemon.requests[0]?.body).toMatchObject({ expectedVersion: 4, reason: 'the user asked' });
    expect(tool.description).toMatch(/dispatched, not completed/);
  });

  it('asks the daemon for the default project when nothing configured one', async () => {
    const daemon = fakeDaemon();
    const tool = TOOLS.find((entry) => entry.name === 'forge.propose_changeset')!;
    const context = contextFor(daemon, { defaultProjectId: null });

    await tool.handler(
      { baseVersion: 0, summary: 's', operations: [{ op: 'deleteInstance', path: 'Workspace.Old' }] },
      context,
    );

    expect(daemon.paths()[0]).toBe('GET /v1/link');
    expect((daemon.requests[1]?.body as { projectId: string }).projectId).toBe('11111111-1111-4111-8111-111111111111');
  });
});
