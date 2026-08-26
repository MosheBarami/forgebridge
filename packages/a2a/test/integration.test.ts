import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDaemon, type ForgeBridgeDaemon } from '@forgebridge/daemon';
import { LocalOperatorApprovalGate } from '../src/approval.js';
import { DaemonBackend } from '../src/backend.js';
import { A2AServer } from '../src/server.js';
import { SKILL_INVOCATION_EXTENSION_URI } from '../src/skills.js';
import { A2A_EXTENSIONS_HEADER, A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from '../src/spec.js';
import { invocationMessage, makeChangeSet } from './helpers.js';

/**
 * The connector against the real daemon.
 *
 * Every other test in this package runs against a `FakeBackend`, which proves
 * that the connector does what this package believes the daemon expects. That
 * is a belief, and a connector's characteristic failure is a belief that is
 * wrong in the same way in both the code and its tests — a path off by one
 * segment, a header spelled differently, a status code nobody checked. So this
 * file starts an actual `ForgeBridgeDaemon` and drives it through
 * `DaemonBackend` and then through the whole A2A surface over HTTP.
 *
 * `@forgebridge/daemon` is a devDependency here and deliberately not a runtime
 * one: ADR-009 makes a connector a thin adapter over the core, and the daemon's
 * REST surface is one way to reach it. A connector that imported the daemon
 * could not be pointed at `apps/relay` (M17) without a code change. Importing
 * it in a test costs nothing and buys the only check that matters.
 */

const daemons: ForgeBridgeDaemon[] = [];
const servers: A2AServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

async function realDaemon(): Promise<{ daemon: ForgeBridgeDaemon; baseUrl: string }> {
  const daemon = createDaemon({
    port: 0,
    // The daemon's own default is deny-all, so a run without a policy would
    // fail for a reason no assertion here mentions.
    policy: { allowedPathPrefixes: ['ServerScriptService', 'Workspace'], autoApply: null },
  });
  daemons.push(daemon);
  const { url } = await daemon.listen();
  return { daemon, baseUrl: url };
}

function backendFor(daemon: ForgeBridgeDaemon, baseUrl: string, token = daemon.producerToken): DaemonBackend {
  return new DaemonBackend({ baseUrl, producerToken: token });
}

describe('DaemonBackend against a real daemon', () => {
  it('proposes a ChangeSet and gets back the verdict the daemon computed', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);
    const changeSet = makeChangeSet({ projectId: daemon.defaultProjectId });

    const result = await backend.propose(changeSet);
    expect(result.changeSetId).toBe(changeSet.id);
    expect(result.status).toBe('validated');
    // The verdict is the daemon's, not the fixture's. This fixture's script is
    // clean, so `ok` here is a real pass by `@forgebridge/luau-analysis` rather
    // than an absent check — the test below is what proves the analyser ran.
    expect(result.validation.luau.status).toBe('ok');
    expect(result.validation.policy.status).toBe('ok');
    expect(result.validation.computedBy).toContain('forgebridge-daemon');
  });

  it('carries the daemon\u2019s refusal of a script back to the calling agent', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);
    const changeSet = makeChangeSet({
      projectId: daemon.defaultProjectId,
      operations: [
        {
          op: 'writeScript',
          path: 'ServerScriptService.Shop',
          scriptType: 'Script',
          source: 'local run = loadstring(payload)\nrun()\n',
        },
      ],
    });

    const result = await backend.propose(changeSet);
    expect(result.validation.luau.status).toBe('fail');
    expect(result.validation.luau.findings.map((finding) => finding.rule)).toContain('luau/no-loadstring');
  });

  it('reads the diff the daemon renders for that set', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);
    const changeSet = makeChangeSet({ projectId: daemon.defaultProjectId });
    await backend.propose(changeSet);

    const diff = await backend.diff(changeSet.id);
    expect(diff.changeSetId).toBe(changeSet.id);
    expect(diff.counts.total).toBe(1);
    expect(diff.counts.scripts).toBe(1);
    expect(diff.stale).toBe(false);
  });

  it('reaches the approve route — proving the path and the producer header are right', async () => {
    // No Studio session is paired, so the daemon refuses with `link_unpaired`.
    // That refusal is the evidence: it is raised after the producer token has
    // been accepted and the ChangeSet found, so reaching it means this
    // connector addressed the right endpoint with the right credential.
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);
    const changeSet = makeChangeSet({ projectId: daemon.defaultProjectId });
    await backend.propose(changeSet);

    await expect(
      backend.approve({ skill: 'apply-approved-changeset', subject: changeSet.id, approvedBy: 'a human' }),
    ).rejects.toMatchObject({ code: 'link_unpaired' });
  });

  it('is refused by the daemon when the producer token is wrong', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl, 'not-the-token');
    await expect(backend.propose(makeChangeSet({ projectId: daemon.defaultProjectId }))).rejects.toMatchObject({
      code: 'link_unauthenticated',
    });
  });

  it('reads models and link status from the real endpoints', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);

    const models = await backend.models();
    expect(models.configured).toBe(false);

    const link = await backend.linkStatus();
    expect(link.defaultProjectId).toBe(daemon.defaultProjectId);
    expect(link.links).toEqual([]);
  });

  it('surfaces a stale base as the daemon words it, remedy included', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);
    await expect(
      backend.propose(makeChangeSet({ projectId: daemon.defaultProjectId, baseVersion: 42 })),
    ).rejects.toMatchObject({ code: 'stale_base', remedy: expect.stringContaining('version 0') });
  });

  it('surfaces a policy violation, which becomes a rejected task rather than a failed one', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const backend = backendFor(daemon, baseUrl);
    const outside = makeChangeSet({
      projectId: daemon.defaultProjectId,
      operations: [{ op: 'writeScript', path: 'Lighting.Sneaky', scriptType: 'Script', source: 'print(1)' }],
    });

    // The daemon stores a policy failure as a verdict rather than refusing the
    // submission, so this comes back on the response, not as a throw.
    const result = await backend.propose(outside);
    expect(result.validation.policy.status).toBe('fail');
  });
});

describe('a second agent drives a run over A2A', () => {
  it('discovers the card, proposes, reads the diff, and is stopped at apply', async () => {
    const { daemon, baseUrl } = await realDaemon();
    const gate = new LocalOperatorApprovalGate();
    const server = new A2AServer({
      backend: backendFor(daemon, baseUrl),
      gate,
      endpointUrl: 'https://forgebridge.test/a2a/v1',
      bearerToken: 'agent-token',
      port: 0,
    });
    servers.push(server);
    const { port } = await server.listen();

    const rpc = async (method: string, params: unknown): Promise<any> => {
      const response = await fetch(`http://127.0.0.1:${port}/a2a/v1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer agent-token',
          [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
          [A2A_EXTENSIONS_HEADER]: SKILL_INVOCATION_EXTENSION_URI,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      });
      return await response.json();
    };

    // 1. Discovery.
    const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).json();
    expect(card.skills.map((skill: { id: string }) => skill.id)).toContain('propose-changeset');

    // 2. Check the link before proposing, as the skill description advises.
    const status = await rpc('SendMessage', { message: invocationMessage('studio-link-status', {}) });
    expect(status.result.task.status.state).toBe('TASK_STATE_COMPLETED');

    // 3. Propose.
    const changeSet = makeChangeSet({ projectId: daemon.defaultProjectId });
    const proposed = await rpc('SendMessage', {
      message: invocationMessage('propose-changeset', { changeSet }),
    });
    expect(proposed.result.task.status.state).toBe('TASK_STATE_COMPLETED');

    // 4. Read the diff.
    const reviewed = await rpc('SendMessage', {
      message: invocationMessage('review-changeset-diff', { changeSetId: changeSet.id }),
    });
    const artifact = reviewed.result.task.artifacts[0];
    const diff = artifact.parts.find((part: any) => 'data' in part).data;
    expect(diff.changeSetId).toBe(changeSet.id);
    expect(diff.counts.scripts).toBe(1);

    // 5. And stop. The agent that built this ChangeSet cannot clear it.
    const applied = await rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId: changeSet.id }),
    });
    expect(applied.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(await daemon.store.getChangeSet(changeSet.id)).toMatchObject({ status: 'validated' });

    // 6. A human approves out of band, and only then does the daemon see an
    //    approve at all -- which here reaches `link_unpaired`, because there is
    //    no Studio session in this test to deliver to.
    gate.record({ skill: 'apply-approved-changeset', subject: changeSet.id, approvedBy: 'operator@workstation' });
    const resumed = await rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId: changeSet.id }),
    });
    expect(resumed.result.task.status.state).toBe('TASK_STATE_FAILED');
    const detail = resumed.result.task.status.message.parts.find((part: any) => 'data' in part).data;
    expect(detail.reason).toBe('LINK_UNPAIRED');
  });
});
