import { describe, expect, it } from 'vitest';
import { DENY_ALL_ROLLBACKS, LocalOperatorRollbackGate } from '../src/approval.js';
import { DaemonClient } from '../src/daemon-client.js';
import { codeOfFailure } from '../src/errors.js';
import { registerForgeBridgeTools, type McpServerLike } from '../src/register.js';
import { TOOLS } from '../src/tools.js';
import type { ToolResult } from '../src/errors.js';
import { BASE_URL, DEFAULT_LINK_ID, contextFor, fakeDaemon, payloadOf, proposalArgs } from './fake-daemon.js';

/**
 * ADR-012 in the form of assertions.
 *
 * The rule is that a model must not be able to clear its own work. On this
 * connector that is enforced structurally — there is no approve call anywhere
 * in the package — so the tests are about absence, and absence has to be
 * checked from more than one direction:
 *
 *   1. propose does not approve, and apply refuses what propose produced;
 *   2. no tool, called with any plausible arguments, ever issues a request to
 *      an approve path;
 *   3. the client cannot be talked into building one out of an id.
 *
 * (1) alone would pass a connector that approved in some other tool. (2) alone
 * would pass one whose refusal text lied about why. Together they say what
 * ADR-012 says.
 *
 * The last block covers the other write on this surface. `forge.apply_changeset`
 * was gated from the start and `forge.rollback` was not, which made the rule
 * true of one mutation and false of the other.
 */

const JOURNAL_A = '44444444-4444-4444-8444-444444444444';
const JOURNAL_B = '55555555-5555-4555-8555-555555555555';

function rollbackTool(): (typeof TOOLS)[number] {
  return TOOLS.find((tool) => tool.name === 'forge.rollback')!;
}

/** Records what was registered, so the real registration path is exercised. */
function recordingServer(): { server: McpServerLike; handlers: Map<string, (args: unknown) => Promise<ToolResult>> } {
  const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
  return {
    handlers,
    server: {
      registerTool: (name, _config, handler) => {
        handlers.set(name, handler);
        return undefined;
      },
    },
  };
}

/** Arguments good enough for each tool to reach the transport, per tool. */
const PLAUSIBLE_ARGS: Record<string, unknown> = {
  'forge.list_projects': {},
  'forge.read_tree': { path: 'ServerScriptService' },
  'forge.read_script': { path: 'ServerScriptService.Shop' },
  'forge.propose_changeset': proposalArgs(),
  'forge.diff_changeset': { changeSetId: '33333333-3333-4333-8333-333333333333' },
  'forge.apply_changeset': { changeSetId: '33333333-3333-4333-8333-333333333333' },
  'forge.run_tests': {},
  'forge.rollback': { journalId: '44444444-4444-4444-8444-444444444444', expectedVersion: 0 },
  'forge.tail_output': { link: DEFAULT_LINK_ID },
  'forge.list_models': {},
  'forge.link_status': {},
};

describe('propose does not apply', () => {
  it('returns an id and a diff, having changed nothing', async () => {
    const daemon = fakeDaemon();
    const propose = TOOLS.find((tool) => tool.name === 'forge.propose_changeset');
    expect(propose).toBeDefined();

    const result = await propose!.handler(proposalArgs(), contextFor(daemon));
    const payload = payloadOf(result);

    expect(payload['applied']).toBe(false);
    expect(payload['approved']).toBe(false);
    expect(typeof payload['changeSetId']).toBe('string');
    expect(payload['diff']).not.toBeNull();
    expect(daemon.paths()).toEqual([
      'POST /v1/changesets',
      `GET /v1/changesets/${payload['changeSetId'] as string}/diff`,
    ]);
  });
});

describe('an agent cannot chain propose then apply', () => {
  it('refuses to apply the changeset it just proposed', async () => {
    const daemon = fakeDaemon({ status: 'validated' });
    const context = contextFor(daemon);
    const propose = TOOLS.find((tool) => tool.name === 'forge.propose_changeset')!;
    const apply = TOOLS.find((tool) => tool.name === 'forge.apply_changeset')!;

    const changeSetId = payloadOf(await propose.handler(proposalArgs(), context))['changeSetId'] as string;

    // The chain, exactly as an agent would attempt it.
    await expect(apply.handler({ changeSetId }, context)).rejects.toMatchObject({ code: 'not_approved' });

    expect(daemon.paths().some((entry) => entry.includes('/approve'))).toBe(false);
  });

  it('reports not_approved as a readable tool result, not a transport failure', async () => {
    const daemon = fakeDaemon({ status: 'validated' });
    const { server, handlers } = recordingServer();
    registerForgeBridgeTools(server, contextFor(daemon));

    const result = await handlers.get('forge.apply_changeset')!({
      changeSetId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result.isError).toBe(true);
    expect(codeOfFailure(result)).toBe('not_approved');
    // The refusal has to tell the model what to do instead, because the model
    // is the only party that can ask the human.
    expect(result.content[0]?.text).toMatch(/approve/i);
    expect(result.content[0]?.text).toContain('No tool on this server can approve');
  });

  it('reports success only once a human has approved out of band', async () => {
    const daemon = fakeDaemon({ status: 'validated' });
    const context = contextFor(daemon);
    const apply = TOOLS.find((tool) => tool.name === 'forge.apply_changeset')!;
    const changeSetId = '33333333-3333-4333-8333-333333333333';

    await expect(apply.handler({ changeSetId }, context)).rejects.toMatchObject({ code: 'not_approved' });

    // The human approves somewhere this connector cannot reach.
    daemon.status = 'approved';

    const payload = payloadOf(await apply.handler({ changeSetId }, context));
    expect(payload['approved']).toBe(true);
    expect(payload['status']).toBe('approved');
    expect(daemon.paths().some((entry) => entry.includes('/approve'))).toBe(false);
  });

  it('fails closed on a status it does not recognise', async () => {
    const daemon = fakeDaemon();
    // A daemon or a future status this build has never heard of.
    daemon.status = 'something-new' as never;
    const apply = TOOLS.find((tool) => tool.name === 'forge.apply_changeset')!;

    await expect(apply.handler({ changeSetId: '33333333-3333-4333-8333-333333333333' }, contextFor(daemon))).rejects.toMatchObject(
      { code: 'not_approved' },
    );
  });
});

describe('no tool reaches an approve path', () => {
  it('holds for every registered tool, with arguments that reach the transport', async () => {
    const daemon = fakeDaemon({ status: 'approved' });
    const { server, handlers } = recordingServer();
    const names = registerForgeBridgeTools(server, contextFor(daemon));

    expect(names).toHaveLength(11);
    for (const name of names) {
      await handlers.get(name)!(PLAUSIBLE_ARGS[name]);
    }

    expect(daemon.requests.length).toBeGreaterThan(0);
    expect(daemon.paths().filter((entry) => entry.includes('approve'))).toEqual([]);
  });

  it('is not a method the client has', () => {
    const methods = Object.getOwnPropertyNames(DaemonClient.prototype);
    expect(methods).not.toContain('approve');
    expect(methods.filter((name) => /approv/i.test(name))).toEqual([]);
  });

  it('cannot be assembled out of a changeset id', async () => {
    const daemon = fakeDaemon();
    const client = new DaemonClient({ baseUrl: BASE_URL, producerToken: 't', fetch: daemon.fetch });

    // A model-supplied id that tries to walk the path back up to approve.
    await client.diff('33333333-3333-4333-8333-333333333333/approve?x=').catch(() => undefined);

    expect(daemon.requests[0]?.path.includes('/approve')).toBe(false);
  });
});

describe('a rollback is a write, and needs the same human as an apply', () => {
  it('refuses without a clearance, and never reaches the daemon to ask', async () => {
    const daemon = fakeDaemon();
    const context = contextFor(daemon);

    await expect(
      rollbackTool().handler({ journalId: JOURNAL_A, expectedVersion: 0 }, context),
    ).rejects.toMatchObject({ code: 'not_approved' });

    // The strong form. The daemon gates this route on the producer token, which
    // this process holds — so a refusal that happened only after the request
    // went out would be no refusal at all.
    expect(daemon.requests).toEqual([]);
  });

  it('refuses when the context names no gate at all', async () => {
    // An embedder that assembles a ToolContext without having heard of the
    // field gets the refusing gate, not the open one.
    const daemon = fakeDaemon();
    const context = contextFor(daemon);
    expect(context.rollbackGate).toBeUndefined();

    await expect(
      rollbackTool().handler({ journalId: JOURNAL_A, expectedVersion: 0 }, context),
    ).rejects.toMatchObject({ code: 'not_approved' });
    expect(await DENY_ALL_ROLLBACKS.consume(JOURNAL_A)).toBeNull();
  });

  it('dispatches the journal entry a human actually cleared', async () => {
    // The control: the legitimate shape this must not become unable to do.
    const daemon = fakeDaemon();
    const gate = new LocalOperatorRollbackGate();
    gate.record({ journalId: JOURNAL_A, approvedBy: 'ada@example.com', note: 'undo the shop rewrite' });

    const payload = payloadOf(
      await rollbackTool().handler(
        { journalId: JOURNAL_A, expectedVersion: 0 },
        contextFor(daemon, { rollbackGate: gate }),
      ),
    );

    expect(payload['status']).toBe('dispatched');
    expect(payload['approvedBy']).toBe('ada@example.com');
    expect(payload['approvalNote']).toBe('undo the shop rewrite');
    expect(daemon.paths()).toEqual([`POST /v1/journal/${JOURNAL_A}/rollback`]);
  });

  it('does not let a clearance for one journal entry reverse another', async () => {
    // The case the whole gate exists for: the agent proposes a change, the user
    // clears *that* work, and the agent then reaches for something else. A
    // standing permission — a flag, a mode, a recent approval — passes this and
    // should not.
    const daemon = fakeDaemon();
    const gate = new LocalOperatorRollbackGate();
    gate.record({ journalId: JOURNAL_A, approvedBy: 'ada@example.com' });
    const context = contextFor(daemon, { rollbackGate: gate });

    await expect(
      rollbackTool().handler({ journalId: JOURNAL_B, expectedVersion: 0 }, context),
    ).rejects.toMatchObject({ code: 'not_approved' });
    expect(daemon.requests).toEqual([]);

    // And the clearance for A is still there afterwards: a refused B must not
    // quietly burn the grant the user did give.
    expect(gate.pending.map((grant) => grant.journalId)).toEqual([JOURNAL_A]);
  });

  it('spends a clearance once', async () => {
    const daemon = fakeDaemon();
    const gate = new LocalOperatorRollbackGate();
    gate.record({ journalId: JOURNAL_A, approvedBy: 'ada@example.com' });
    const context = contextFor(daemon, { rollbackGate: gate });

    await rollbackTool().handler({ journalId: JOURNAL_A, expectedVersion: 0 }, context);
    // One "yes" is one rollback. Otherwise a single clearance would let an agent
    // reverse the same entry again after the user had re-applied it.
    await expect(
      rollbackTool().handler({ journalId: JOURNAL_A, expectedVersion: 0 }, context),
    ).rejects.toMatchObject({ code: 'not_approved' });
    expect(daemon.paths()).toEqual([`POST /v1/journal/${JOURNAL_A}/rollback`]);
  });

  it('reports a malformed journal id as invalid_request, not as an approval failure', async () => {
    // The other control. Failing closed must not mean answering every bad call
    // with "ask a human" — that would train a model to ask the user to fix its
    // own typo.
    const daemon = fakeDaemon();
    await expect(
      rollbackTool().handler({ journalId: 'not-a-uuid', expectedVersion: 0 }, contextFor(daemon)),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(daemon.requests).toEqual([]);
  });
});

describe('the tool text tells the model where the boundary is', () => {
  it('says so in propose and in apply, because that text is what the model reads', () => {
    const propose = TOOLS.find((tool) => tool.name === 'forge.propose_changeset')!;
    const apply = TOOLS.find((tool) => tool.name === 'forge.apply_changeset')!;

    expect(propose.description).toMatch(/does NOT change the place/);
    expect(propose.description).toMatch(/ADR-012/);
    expect(apply.description).toMatch(/CANNOT approve/);
    expect(apply.description).toMatch(/not_approved/);
  });

  it('says it in rollback too, which is the other write on this surface', () => {
    const tool = rollbackTool();
    expect(tool.description).toMatch(/CANNOT clear a rollback/);
    expect(tool.description).toMatch(/not_approved/);
    // The model has to be told what to do instead, because asking the human is
    // the only thing that can actually resolve the refusal.
    expect(tool.description).toMatch(/forgebridge rollback/);
    expect(tool.destructiveHint).toBe(true);
  });
});
