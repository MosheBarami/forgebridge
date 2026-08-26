import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LocalOperatorApprovalGate } from '../src/approval.js';
import { A2A_ERRORS } from '../src/errors.js';
import {
  INTERRUPTED_TASK_STATES,
  LEGAL_TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  TaskState,
  isLegalTransition,
} from '../src/spec.js';
import { IllegalTaskTransition, TaskStore, decodePageToken } from '../src/tasks.js';
import type { A2AServer } from '../src/server.js';
import { forgeBridgeError, invocationMessage, makeChangeSet, startServer, type StartedServer } from './helpers.js';

const running: A2AServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function serve(overrides = {}): Promise<StartedServer> {
  const started = await startServer(overrides);
  running.push(started.server);
  return started;
}

/** Any well-formed invocation. These tests are about states, not skills. */
function anyMessage() {
  return invocationMessage('query-models', {});
}

describe('the transition table itself', () => {
  it('gives every state a row, so an unlisted state cannot default to permissive', () => {
    for (const state of TaskState.options) {
      expect(LEGAL_TASK_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('lets nothing leave a terminal state', () => {
    for (const terminal of TERMINAL_TASK_STATES) {
      expect(LEGAL_TASK_TRANSITIONS[terminal]).toEqual([]);
      for (const target of TaskState.options) {
        expect(isLegalTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('lets an interrupted state resume into WORKING and be canceled, and nothing else', () => {
    for (const interrupted of INTERRUPTED_TASK_STATES) {
      expect([...LEGAL_TASK_TRANSITIONS[interrupted]].sort()).toEqual(
        ['TASK_STATE_CANCELED', 'TASK_STATE_WORKING'].sort(),
      );
    }
  });

  it('reaches CANCELED from every non-terminal state that a task can actually occupy', () => {
    const occupiable: TaskState[] = [
      'TASK_STATE_SUBMITTED',
      'TASK_STATE_WORKING',
      'TASK_STATE_INPUT_REQUIRED',
      'TASK_STATE_AUTH_REQUIRED',
    ];
    for (const state of occupiable) {
      expect(isLegalTransition(state, 'TASK_STATE_CANCELED')).toBe(true);
    }
  });

  it('never enters the proto zero value', () => {
    expect(LEGAL_TASK_TRANSITIONS.TASK_STATE_UNSPECIFIED).toEqual([]);
    for (const state of TaskState.options) {
      expect(isLegalTransition(state, 'TASK_STATE_UNSPECIFIED')).toBe(false);
    }
  });
});

describe('the store enforces the table', () => {
  it('opens a task in SUBMITTED with a server-minted id', () => {
    const store = new TaskStore();
    const record = store.create(undefined, anyMessage());
    expect(record.state).toBe('TASK_STATE_SUBMITTED');
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a backwards transition rather than writing it', () => {
    const store = new TaskStore();
    const record = store.create(undefined, anyMessage());
    store.transition(record.id, 'TASK_STATE_WORKING');
    store.transition(record.id, 'TASK_STATE_COMPLETED');

    // The illegal ones, one by one: a completed task cannot restart, cannot
    // fail, and cannot be canceled.
    for (const target of ['TASK_STATE_WORKING', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'] as const) {
      expect(() => store.transition(record.id, target)).toThrow(IllegalTaskTransition);
    }
    expect(store.get(record.id)?.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses SUBMITTED straight to COMPLETED', () => {
    // Skipping WORKING would mean a caller polling GetTask can never observe
    // that the task was picked up, only that it was and then was not.
    const store = new TaskStore();
    const record = store.create(undefined, anyMessage());
    expect(() => store.transition(record.id, 'TASK_STATE_COMPLETED')).toThrow(IllegalTaskTransition);
  });

  it('refuses to move a task it has never seen', () => {
    const store = new TaskStore();
    expect(() => store.transition(randomUUID(), 'TASK_STATE_WORKING')).toThrow(IllegalTaskTransition);
  });

  it('resumes an AUTH_REQUIRED task into WORKING', () => {
    const store = new TaskStore();
    const record = store.create(undefined, anyMessage());
    store.transition(record.id, 'TASK_STATE_WORKING');
    store.transition(record.id, 'TASK_STATE_AUTH_REQUIRED');
    expect(() => store.transition(record.id, 'TASK_STATE_WORKING')).not.toThrow();
  });

  it('omits history entirely when historyLength is 0 (section 3.2.4)', () => {
    const store = new TaskStore();
    const record = store.create(undefined, anyMessage());
    expect(store.snapshot(record, { historyLength: 0 }).history).toBeUndefined();
    expect(store.snapshot(record, {}).history?.length).toBe(1);
  });

  it('pages with an opaque cursor and reports totalSize across the whole match', () => {
    const store = new TaskStore();
    for (let i = 0; i < 5; i += 1) store.create('ctx', anyMessage());

    const first = store.list({ pageSize: 2 });
    expect(first.tasks.length).toBe(2);
    expect(first.totalSize).toBe(5);
    expect(first.nextPageToken).not.toBe('');

    const second = store.list({ pageSize: 2, pageToken: first.nextPageToken });
    expect(second.tasks.map((task) => task.id)).not.toEqual(first.tasks.map((task) => task.id));

    const last = store.list({ pageSize: 10 });
    expect(last.nextPageToken).toBe('');
    // A malformed cursor restarts the listing rather than throwing: it is a
    // position, not an authorisation.
    expect(decodePageToken('not-a-cursor')).toBe(0);
  });

  it('drops terminal tasks first when it hits its ceiling and never drops one in flight', () => {
    const store = new TaskStore({ maxTasks: 3 });
    const inFlight = store.create(undefined, anyMessage());
    store.transition(inFlight.id, 'TASK_STATE_WORKING');
    for (let i = 0; i < 5; i += 1) {
      const record = store.create(undefined, anyMessage());
      store.transition(record.id, 'TASK_STATE_WORKING');
      store.transition(record.id, 'TASK_STATE_COMPLETED');
    }
    expect(store.get(inFlight.id)).toBeDefined();
  });
});

describe('lifecycle over the wire', () => {
  it('runs SUBMITTED to COMPLETED and attaches the result as an artifact, not a message', async () => {
    const started = await serve();
    const { body } = await started.rpc('SendMessage', { message: invocationMessage('query-models', {}) });

    const task = body.result.task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    // Section 3.7: "Messages SHOULD NOT be used to deliver task outputs."
    expect(task.artifacts?.length).toBe(1);
    expect(task.artifacts[0].parts.some((part: any) => 'data' in part)).toBe(true);
  });

  it('rejects a message that names no skill, and does so as a task state not a JSON-RPC error', async () => {
    const started = await serve();
    const { body } = await started.rpc('SendMessage', {
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'please build me a shop' }] },
    });

    expect(body.error).toBeUndefined();
    expect(body.result.task.status.state).toBe('TASK_STATE_REJECTED');
  });

  it('fails a task when the daemon refuses, and distinguishes refusal from breakage', async () => {
    const started = await serve();

    // policy_violation is the daemon reading the set and saying no: REJECTED.
    started.backend.failNext('propose', forgeBridgeError('policy_violation', 'outside the allowed paths'));
    const rejected = await started.rpc('SendMessage', {
      message: invocationMessage('propose-changeset', { changeSet: makeChangeSet() }),
    });
    expect(rejected.body.result.task.status.state).toBe('TASK_STATE_REJECTED');

    // link_unpaired is nobody refusing anything: FAILED, and worth retrying.
    started.backend.failNext('propose', forgeBridgeError('link_unpaired', 'no Studio session'));
    const failed = await started.rpc('SendMessage', {
      message: invocationMessage('propose-changeset', { changeSet: makeChangeSet() }),
    });
    expect(failed.body.result.task.status.state).toBe('TASK_STATE_FAILED');
  });

  it('cancels a task in flight and refuses to cancel a terminal one', async () => {
    const started = await serve({ gate: new LocalOperatorApprovalGate() });

    // An apply with no approval parks in AUTH_REQUIRED, which is non-terminal.
    const parked = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId: randomUUID() }),
    });
    const taskId = parked.body.result.task.id;
    expect(parked.body.result.task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');

    const canceled = await started.rpc('CancelTask', { id: taskId });
    expect(canceled.body.result.task.status.state).toBe('TASK_STATE_CANCELED');

    const again = await started.rpc('CancelTask', { id: taskId });
    expect(again.body.error.code).toBe(A2A_ERRORS.taskNotCancelable.code);
  });

  it('refuses to cancel a task that completed', async () => {
    const started = await serve();
    const created = await started.rpc('SendMessage', { message: invocationMessage('query-models', {}) });
    const { body } = await started.rpc('CancelTask', { id: created.body.result.task.id });
    expect(body.error.code).toBe(A2A_ERRORS.taskNotCancelable.code);
    expect(body.error.data[0].reason).toBe(A2A_ERRORS.taskNotCancelable.reason);
  });

  it('refuses a further message on a terminal task instead of silently opening a new one', async () => {
    const started = await serve();
    const created = await started.rpc('SendMessage', { message: invocationMessage('query-models', {}) });
    const taskId = created.body.result.task.id;

    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('query-models', {}, { taskId }),
    });
    expect(body.error.code).toBe(-32602);
  });

  it('resumes an AUTH_REQUIRED task when the same task id is messaged again', async () => {
    const gate = new LocalOperatorApprovalGate();
    const started = await serve({ gate });
    const changeSetId = randomUUID();

    const parked = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }),
    });
    const taskId = parked.body.result.task.id;

    gate.record({ skill: 'apply-approved-changeset', subject: changeSetId, approvedBy: 'a human' });

    const resumed = await started.rpc('SendMessage', {
      message: invocationMessage('apply-approved-changeset', { changeSetId }, { taskId }),
    });
    expect(resumed.body.result.task.id).toBe(taskId);
    expect(resumed.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('returns immediately when asked to, and the task still reaches a settled state', async () => {
    const started = await serve();
    const { body } = await started.rpc('SendMessage', {
      message: invocationMessage('query-models', {}),
      configuration: { returnImmediately: true },
    });
    const taskId = body.result.task.id;
    expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(body.result.task.status.state);

    await started.server.handler.settled();
    const polled = await started.rpc('GetTask', { id: taskId });
    expect(polled.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('serialises every state as the proto enum name, never as lowercase', async () => {
    // Pre-1.0 A2A used "working"/"completed". Section 5.5 requires the proto
    // name. A client written against 1.0 branches on these strings.
    const started = await serve();
    const { body } = await started.rpc('SendMessage', { message: invocationMessage('query-models', {}) });
    expect(body.result.task.status.state).toMatch(/^TASK_STATE_[A-Z_]+$/);
    for (const message of body.result.task.history ?? []) {
      expect(message.role).toMatch(/^ROLE_[A-Z]+$/);
    }
  });
});
