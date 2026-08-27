import { describe, expect, it } from 'vitest';
import { codeOfFailure } from '../src/errors.js';
import { objectOf, startRunInput } from '../src/schemas.js';
import { TOOLS, type ToolDefinition } from '../src/tools.js';
import { contextFor, fakeDaemon, payloadOf } from './fake-daemon.js';

/**
 * `forge.start_run` — the one tool that spends the user's model credit, and the
 * one whose answer is written by a model other than the one calling it.
 *
 * Two things are being held here. That the attempt list reaches the caller
 * whole (ADR-008), because a connector that reported only the model which
 * succeeded would be misreporting who wrote the code. And that a run is on the
 * propose side of the gate (ADR-012) — the tool's description says so, because
 * the description is the prompt the calling model reads, and this asserts the
 * sentence is actually there.
 */

const startRun = TOOLS.find((tool) => tool.name === 'forge.start_run') as ToolDefinition;

describe('forge.start_run', () => {
  it('is registered with the boundary stated in the text a model reads', () => {
    expect(startRun).toBeDefined();
    expect(startRun.description).toContain('does NOT change the place');
    expect(startRun.description).toContain('Approval is a human action');
    expect(startRun.description).toMatch(/never approved/);
    // The instruction that stops a caller taking credit for the model's work.
    expect(startRun.description).toContain('run.attempts');
    expect(startRun.destructiveHint).toBe(false);
  });

  it('returns every model the router tried, in order, unedited', async () => {
    const daemon = fakeDaemon();
    const result = await startRun.handler({ prompt: 'add a purchase handler' }, contextFor(daemon));
    const payload = payloadOf(result);

    expect(
      (payload['attempts'] as { modelId: string; outcome: string }[]).map((a) => [a.modelId, a.outcome]),
    ).toEqual([
      ['glm-5.2:free', 'rate-limited'],
      ['minimax-m3:free', 'ok'],
    ]);
  });

  it('reports the ChangeSet as proposed and nothing as applied', async () => {
    const daemon = fakeDaemon();
    const payload = payloadOf(await startRun.handler({ prompt: 'add a purchase handler' }, contextFor(daemon)));

    expect(payload['applied']).toBe(false);
    expect(payload['approved']).toBe(false);
    expect(payload['changeSetStatus']).toBe('validated');
    expect(payload['nextStep']).toContain('Nothing has changed in the place');
    expect(payload['nextStep']).toContain('Approval is a human action');
    // And no request on the way there went near the approve path.
    expect(daemon.paths().filter((entry) => entry.includes('approve'))).toEqual([]);
  });

  it('stamps the producer and the stream itself, so the model cannot', async () => {
    const daemon = fakeDaemon();
    await startRun.handler(
      // Both fields offered by a caller that read the wire schema rather than
      // this tool's; both are absent from the input shape and so are stripped.
      { prompt: 'p', stream: true, producer: { kind: 'web' } } as Record<string, unknown>,
      contextFor(daemon),
    );

    const body = daemon.requests.find((request) => request.path === '/v1/runs')?.body as Record<string, unknown>;
    expect(body['stream']).toBe(false);
    expect(body['producer']).toEqual({ kind: 'mcp' });
  });

  it('resolves the project the way every other tool does', async () => {
    const daemon = fakeDaemon();
    await startRun.handler({ prompt: 'p' }, contextFor(daemon, { defaultProjectId: null }));

    // No project id in the arguments and none configured, so the daemon's own
    // default is read from `GET /v1/link` rather than the model being asked for
    // a uuid it could look up.
    expect(daemon.paths()).toContain('GET /v1/link');
    const body = daemon.requests.find((request) => request.path === '/v1/runs')?.body as Record<string, unknown>;
    expect(body['projectId']).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('has no field a caller could use to approve its own work', () => {
    const shape = Object.keys(startRunInput);
    expect(shape).not.toContain('approve');
    expect(shape).not.toContain('autoApply');
    expect(shape).not.toContain('validation');
    // And a request that tries anyway is parsed against the shape, which drops
    // what it does not name.
    const parsed = objectOf(startRunInput).parse({ prompt: 'p', approve: true });
    expect(parsed).not.toHaveProperty('approve');
  });

  it('refuses a prompt the protocol would not store', () => {
    const parsed = objectOf(startRunInput).safeParse({ prompt: '' });
    expect(parsed.success).toBe(false);
  });

  it('carries a daemon refusal back as a code the model can branch on', async () => {
    const daemon = fakeDaemon();
    daemon.failWith = {
      status: 503,
      body: { code: 'provider_unconfigured', message: 'no model client is wired into this daemon' },
    };

    // Thrown by the handler; the registration wrapper is what turns it into a
    // result, so the failure is built here the same way.
    const error = await startRun.handler({ prompt: 'p' }, contextFor(daemon)).catch((thrown: unknown) => thrown);
    const { toolFailure } = await import('../src/errors.js');
    expect(codeOfFailure(toolFailure(error))).toBe('provider_unconfigured');
  });
});
