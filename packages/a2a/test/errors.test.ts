import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ErrorCode, ForgeBridgeError } from '@forgebridge/protocol';
import { A2A_ERRORS, JSONRPC_ERRORS, REJECTING_CODES, renderFailure, taskStateForFailure } from '../src/errors.js';
import { SKILL_INVOCATION_EXTENSION_URI } from '../src/skills.js';
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from '../src/spec.js';
import { majorMinor } from '../src/server.js';
import type { A2AServer } from '../src/server.js';
import { forgeBridgeError, invocationMessage, startServer, type StartedServer } from './helpers.js';

const running: A2AServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function serve(overrides = {}): Promise<StartedServer> {
  const started = await startServer(overrides);
  running.push(started.server);
  return started;
}

describe('the two error layers stay apart', () => {
  it('maps every ForgeBridge error code to a terminal task state, none left unhandled', () => {
    for (const code of ErrorCode.options) {
      const state = taskStateForFailure(code);
      expect(['TASK_STATE_REJECTED', 'TASK_STATE_FAILED']).toContain(state);
      expect(state).toBe(REJECTING_CODES.has(code) ? 'TASK_STATE_REJECTED' : 'TASK_STATE_FAILED');
    }
  });

  it('carries the daemon’s remedy through, because it is the half a caller can act on', () => {
    const rendered = renderFailure(new ForgeBridgeError('stale_base', 'built against version 3', 'Rebase to 7.'));
    expect(rendered.state).toBe('TASK_STATE_FAILED');
    expect(rendered.summary).toContain('Rebase to 7.');
    expect(rendered.detail['@type']).toBe('type.googleapis.com/google.rpc.ErrorInfo');
    expect(rendered.detail.reason).toBe('STALE_BASE');
  });

  it('says nothing about itself when it is the one that broke', () => {
    // The daemon's rule: an internal error never carries an internal detail. A
    // remote agent is a weaker audience for a stack trace than a local one.
    const rendered = renderFailure(new TypeError('cannot read properties of undefined (reading "id")'));
    expect(rendered.state).toBe('TASK_STATE_FAILED');
    expect(rendered.summary).not.toContain('undefined');
    expect(rendered.detail.reason).toBe('INTERNAL');
  });
});

describe('protocol-level errors use the codes the spec assigns', () => {
  it('answers an unknown method with -32601', async () => {
    const started = await serve();
    const { body } = await started.rpc('DoTheThing', {});
    expect(body.error.code).toBe(JSONRPC_ERRORS.methodNotFound.code);
  });

  it('answers unparseable JSON with -32700 and a null id', async () => {
    const started = await serve();
    const response = await fetch(`http://127.0.0.1:${started.port}/a2a/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      },
      body: '{not json',
    });
    const body = await response.json();
    expect(body.error.code).toBe(JSONRPC_ERRORS.parse.code);
    expect(body.id).toBeNull();
  });

  it('answers a malformed envelope with -32600', async () => {
    const started = await serve();
    const response = await fetch(`http://127.0.0.1:${started.port}/a2a/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      },
      // A JSON-RPC batch. Not implemented, and this is the honest answer for it.
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'GetTask' }]),
    });
    const body = await response.json();
    expect(body.error.code).toBe(JSONRPC_ERRORS.invalidRequest.code);
  });

  it('answers bad params with -32602 and names the offending fields', async () => {
    const started = await serve();
    const { body } = await started.rpc('GetTask', { notAnId: 1 });
    expect(body.error.code).toBe(JSONRPC_ERRORS.invalidParams.code);
    const badRequest = body.error.data.find((entry: any) => entry['@type'].endsWith('google.rpc.BadRequest'));
    expect(badRequest.fieldViolations[0].field).toBe('id');
  });

  it('answers an unknown task with -32001 and reveals nothing else', async () => {
    const started = await serve();
    const { body } = await started.rpc('GetTask', { id: randomUUID() });
    expect(body.error.code).toBe(A2A_ERRORS.taskNotFound.code);
    expect(body.error.message).toBe(A2A_ERRORS.taskNotFound.message);
    expect(body.error.data[0].domain).toBe('a2a-protocol.org');
  });

  it('refuses streaming with UnsupportedOperationError, as section 3.3.4 requires of an undeclared capability', async () => {
    const started = await serve();
    for (const method of ['SendStreamingMessage', 'SubscribeToTask']) {
      const { body } = await started.rpc(method, { id: randomUUID() });
      expect(body.error.code).toBe(A2A_ERRORS.unsupportedOperation.code);
    }
  });

  it('refuses the push-notification methods with PushNotificationNotSupportedError', async () => {
    const started = await serve();
    for (const method of [
      'CreateTaskPushNotificationConfig',
      'GetTaskPushNotificationConfig',
      'ListTaskPushNotificationConfigs',
      'DeleteTaskPushNotificationConfig',
    ]) {
      const { body } = await started.rpc(method, {});
      expect(body.error.code).toBe(A2A_ERRORS.pushNotificationNotSupported.code);
    }
  });

  it('refuses the extended agent card with UnsupportedOperationError, not NotConfigured', async () => {
    // Section 3.3.4 distinguishes them: NotConfigured is for an agent that
    // declares the capability and has no card. This one declares it false.
    const started = await serve();
    const { body } = await started.rpc('GetExtendedAgentCard');
    expect(body.error.code).toBe(A2A_ERRORS.unsupportedOperation.code);
  });

  it('refuses a caller that has not declared the required extension', async () => {
    const started = await serve();
    const { body } = await started.rpc(
      'SendMessage',
      { message: invocationMessage('query-models', {}) },
      { declareExtension: false },
    );
    expect(body.error.code).toBe(A2A_ERRORS.extensionSupportRequired.code);
  });

  it('accepts the extension declared on the message instead of the header', async () => {
    const started = await serve();
    const { body } = await started.rpc(
      'SendMessage',
      {
        message: invocationMessage('query-models', {}, { extensions: [SKILL_INVOCATION_EXTENSION_URI] }),
      },
      { declareExtension: false },
    );
    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('version negotiation', () => {
  it('ignores the patch component, because section 3.6 says a patch is not negotiated', async () => {
    expect(majorMinor('1.0.1')).toBe('1.0');
    const started = await serve();
    const { body } = await started.rpc(
      'ListTasks',
      {},
      { headers: { [A2A_VERSION_HEADER]: '1.0.7' } },
    );
    expect(body.error).toBeUndefined();
  });

  it('refuses an absent version header, because section 3.6.2 says absent means 0.3', async () => {
    // Surprising but correct: "Agents MUST interpret empty value as 0.3
    // version." This interface speaks 1.0 only, and feeding 1.0 responses to a
    // 0.3 client is a worse failure than a clear refusal.
    const started = await serve();
    const response = await fetch(`http://127.0.0.1:${started.port}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }),
    });
    const body = await response.json();
    expect(body.error.code).toBe(A2A_ERRORS.versionNotSupported.code);
    expect(body.error.data[0].metadata.requested).toBe('0.3');
  });

  it('refuses a version it does not speak', async () => {
    const started = await serve();
    const { body } = await started.rpc('ListTasks', {}, { headers: { [A2A_VERSION_HEADER]: '2.0' } });
    expect(body.error.code).toBe(A2A_ERRORS.versionNotSupported.code);
  });

  it('accepts the version as a request parameter, which section 3.6.1 permits', async () => {
    const started = await serve();
    const response = await fetch(
      `http://127.0.0.1:${started.port}/a2a/v1?${A2A_VERSION_HEADER}=${A2A_PROTOCOL_VERSION}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }),
      },
    );
    const body = await response.json();
    expect(body.error).toBeUndefined();
  });
});

describe('transport-level refusals', () => {
  it('refuses an unauthenticated call with 401 and an authentication challenge', async () => {
    const started = await serve();
    const response = await fetch(`http://127.0.0.1:${started.port}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('refuses a wrong token, and never leaks the right one', async () => {
    const started = await serve();
    const { status, body } = await started.rpc('ListTasks', {}, { headers: { authorization: 'Bearer wrong' } });
    expect(status).toBe(401);
    expect(JSON.stringify(body)).not.toContain('test-token');
  });

  it('refuses a body that is not JSON with 415', async () => {
    const started = await serve();
    const { status } = await started.rpc('ListTasks', {}, { headers: { 'content-type': 'text/plain' } });
    expect(status).toBe(415);
  });

  it('accepts the application/a2a+json media type the spec registers', async () => {
    const started = await serve();
    const { body } = await started.rpc('ListTasks', {}, { headers: { 'content-type': 'application/a2a+json' } });
    expect(body.error).toBeUndefined();
  });

  it('refuses a GET on the JSON-RPC endpoint', async () => {
    const started = await serve();
    const response = await fetch(`http://127.0.0.1:${started.port}/a2a/v1`);
    expect(response.status).toBe(405);
  });

  it('reports a daemon that cannot be reached as a transport failure, not an internal one', async () => {
    const started = await serve();
    started.backend.failNext('models', forgeBridgeError('provider_unconfigured', 'the daemon could not be reached'));
    const { body } = await started.rpc('SendMessage', { message: invocationMessage('query-models', {}) });
    expect(body.result.task.status.state).toBe('TASK_STATE_FAILED');
    const detail = body.result.task.status.message.parts.find((part: any) => 'data' in part)?.data;
    expect(detail.reason).toBe('PROVIDER_UNCONFIGURED');
  });
});

describe('interface routing (section 8.3.2)', () => {
  it('requires the declared tenant on every request when the interface declares one', async () => {
    const started = await serve({ tenant: 'studio-a' });
    expect(started.server.card.supportedInterfaces[0]?.tenant).toBe('studio-a');

    const missing = await started.rpc('ListTasks', {});
    expect(missing.body.error.code).toBe(JSONRPC_ERRORS.invalidParams.code);

    const wrong = await started.rpc('ListTasks', { tenant: 'studio-b' });
    expect(wrong.body.error.code).toBe(JSONRPC_ERRORS.invalidParams.code);

    const right = await started.rpc('ListTasks', { tenant: 'studio-a' });
    expect(right.body.error).toBeUndefined();
  });

  it('refuses a tenant when the interface declares none, rather than ignoring it', async () => {
    // A tenant this interface never published is a client routing key meant for
    // some other interface. Answering it anyway is how one instance quietly
    // serves another's traffic.
    const started = await serve();
    const { body } = await started.rpc('ListTasks', { tenant: 'somebody-else' });
    expect(body.error.code).toBe(JSONRPC_ERRORS.invalidParams.code);
  });
});
