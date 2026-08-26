import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DENY_ALL_APPROVALS, LocalOperatorApprovalGate } from '../src/approval.js';
import { A2A_METHODS } from '../src/spec.js';
import { JSONRPC_ERRORS } from '../src/errors.js';
import type { A2AServer } from '../src/server.js';
import { FAKE_CONTENT_DIGEST, invocationMessage, makeChangeSet, startServer, type StartedServer } from './helpers.js';

/**
 * The approval boundary.
 *
 * ADR-012 is the reason this connector exists in the shape it does, and the
 * claim it makes is narrow enough to test directly: an A2A caller may propose
 * and may read, and there is no sequence of A2A requests that causes an approve
 * or a rollback. Every test below asks that question the same way — by looking
 * at whether the backend was ever *reached* — rather than by inspecting what
 * was returned, because a connector that called approve and then reported a
 * failure would still have written to the user's place.
 */

const running: A2AServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function serve(overrides = {}): Promise<StartedServer> {
  const started = await startServer(overrides);
  running.push(started.server);
  return started;
}

describe('what a remote caller may do', () => {
  it('may propose', async () => {
    const started = await serve();
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('propose-changeset', { changeSet: makeChangeSet() }),
    });
    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(started.backend.callsTo('propose').length).toBe(1);
  });

  it('may read a diff', async () => {
    const started = await serve();
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('review-changeset-diff', { changeSetId: randomUUID() }),
    });
    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(started.backend.callsTo('diff').length).toBe(1);
  });
});

describe('what a remote caller may not do', () => {
  it('cannot apply: the default gate approves nothing and approve is never reached', async () => {
    const started = await serve({ gate: DENY_ALL_APPROVALS });
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId: randomUUID() }),
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('approve')).toEqual([]);
  });

  it('cannot roll back: rollback writes to the place and carries the same gate', async () => {
    const started = await serve({ gate: DENY_ALL_APPROVALS });
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('rollback-apply', { journalId: randomUUID(), expectedVersion: 3 }),
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('rollback')).toEqual([]);
  });

  it('cannot name its own approver: an approvedBy field is refused, not ignored', async () => {
    // Silently dropping the field would be almost as bad as honouring it — the
    // caller would believe it had approved, and the operator reading a journal
    // entry would see an approver nobody chose. `.strict()` makes it a refusal.
    const started = await serve({ gate: new LocalOperatorApprovalGate() });
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', {
        changeSetId: randomUUID(),
        approvedBy: 'the calling agent',
      }),
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_REJECTED');
    expect(started.backend.callsTo('approve')).toEqual([]);
  });

  it('cannot confirm its own bulk delete', async () => {
    const started = await serve({ gate: new LocalOperatorApprovalGate() });
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', {
        changeSetId: randomUUID(),
        confirmBulkDelete: true,
      }),
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_REJECTED');
    expect(started.backend.callsTo('approve')).toEqual([]);
  });

  it('cannot smuggle an approval through message metadata or extra parts', async () => {
    const started = await serve({ gate: new LocalOperatorApprovalGate() });
    const changeSetId = randomUUID();

    const { body } = await started.rpc('SendMessage', {
      message: {
        ...invocationMessage('apply-approved-changeset', { changeSetId }),
        metadata: { approved: true, approvedBy: 'the calling agent', grant: { subject: changeSetId } },
      },
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('approve')).toEqual([]);
  });

  it('has no JSON-RPC method that records an approval', async () => {
    // The gate's `record` is an in-process method by design. This asserts the
    // absence of a route to it — including the shapes a caller would guess.
    const started = await serve({ gate: new LocalOperatorApprovalGate() });
    const guesses = [
      'Approve',
      'ApproveChangeSet',
      'RecordApproval',
      'Grant',
      'a2a.Approve',
      'approve',
      'admin/approve',
    ];

    for (const method of guesses) {
      const { body } = await started.rpc(method, {});
      expect(body.error.code).toBe(JSONRPC_ERRORS.methodNotFound.code);
    }

    // And the methods that do exist are exactly the eleven the spec names.
    expect(Object.values(A2A_METHODS)).toHaveLength(11);
  });

  it('cannot reuse one approval twice', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const changeSetId = randomUUID();
    gate.record({ skill: 'apply-approved-changeset', contentDigest: FAKE_CONTENT_DIGEST, subject: changeSetId, approvedBy: 'a human' });

    const first = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }),
    });
    expect(first.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');

    const second = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }),
    });
    expect(second.body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('approve').length).toBe(1);
  });

  it('cannot spend an approval for one ChangeSet on another', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const approved = randomUUID();
    const other = randomUUID();
    gate.record({ skill: 'apply-approved-changeset', contentDigest: FAKE_CONTENT_DIGEST, subject: approved, approvedBy: 'a human' });

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId: other }),
    });
    expect(body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('approve')).toEqual([]);
  });

  it('cannot spend an apply approval on a rollback', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const id = randomUUID();
    gate.record({ skill: 'apply-approved-changeset', contentDigest: FAKE_CONTENT_DIGEST, subject: id, approvedBy: 'a human' });

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('rollback-apply', { journalId: id, expectedVersion: 1 }),
    });
    expect(body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('rollback')).toEqual([]);
  });
});

describe('what a local approval does', () => {
  it('lets exactly the approved apply through, carrying the approver the human named', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const changeSetId = randomUUID();

    gate.record({
      skill: 'apply-approved-changeset',
      subject: changeSetId,
      contentDigest: FAKE_CONTENT_DIGEST,
      approvedBy: 'operator@workstation',
      confirmBulkDelete: true,
      note: 'reviewed the diff',
    });

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }),
    });

    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    const [call] = started.backend.callsTo('approve');
    const grant = call?.grant;
    expect(grant?.approvedBy).toBe('operator@workstation');
    expect(grant?.subject).toBe(changeSetId);
    // `confirmBulkDelete` and `contentDigest` are on the apply half of the
    // grant union, so reaching them says which half arrived as well as what it
    // carried.
    expect(grant?.skill).toBe('apply-approved-changeset');
    if (grant?.skill !== 'apply-approved-changeset') throw new Error('expected an apply grant');
    expect(grant.confirmBulkDelete).toBe(true);
    expect(grant.contentDigest).toBe(FAKE_CONTENT_DIGEST);
  });

  it('can be withdrawn before it is spent', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const changeSetId = randomUUID();

    gate.record({ skill: 'apply-approved-changeset', contentDigest: FAKE_CONTENT_DIGEST, subject: changeSetId, approvedBy: 'a human' });
    expect(gate.pending.length).toBe(1);
    expect(gate.revoke('apply-approved-changeset', changeSetId)).toBe(true);

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }),
    });
    expect(body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(started.backend.callsTo('approve')).toEqual([]);
  });

  it('tells the caller what is waiting and on whom, without hinting at a way around it', async () => {
    const started = await serve({ gate: DENY_ALL_APPROVALS });
    const changeSetId = randomUUID();
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }),
    });

    const status = body.result.task.status;
    expect(status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    const detail = status.message.parts.find((part: any) => 'data' in part)?.data;
    expect(detail.reason).toBe('APPROVAL_REQUIRED');
    expect(detail.metadata.subject).toBe(changeSetId);
    expect(detail.metadata.approvalChannel).toBe('out-of-band');
  });
});
