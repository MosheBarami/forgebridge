import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CliError, EXIT, exitCodeFor, operationFailed, usageError } from '../src/exit.js';
import { DaemonClient } from '../src/client.js';
import { linkCommand } from '../src/commands/link.js';
import { modelsCommand } from '../src/commands/models.js';
import { runCommand } from '../src/commands/run.js';
import { dispatch } from '../src/index.js';
import { captureIo, linkStatusFixture, modelsFixture, runResponseFixture, stubTransport, testDeps } from './helpers.js';

const BASE = 'http://127.0.0.1:7317';
const GLOBAL = { json: false, baseUrl: BASE, token: 'test-token' };

const RUN_INVOCATION = {
  command: 'run',
  global: GLOBAL,
  prompt: 'build a shop',
  projectId: null,
  policy: null,
  pinnedModel: null,
  baseVersion: null,
  maxAttempts: null,
  verbose: false,
} as const;

describe('the exit-code contract', () => {
  it('assigns each code exactly once', () => {
    expect(EXIT).toEqual({ OK: 0, FAILED: 1, USAGE: 2, UNREACHABLE: 3 });
    expect(new Set(Object.values(EXIT)).size).toBe(4);
  });

  it('maps a thrown CliError to its own code', () => {
    expect(exitCodeFor(usageError('bad flag'))).toBe(EXIT.USAGE);
    expect(exitCodeFor(operationFailed('refused'))).toBe(EXIT.FAILED);
    expect(exitCodeFor(new CliError(EXIT.UNREACHABLE, 'nothing there'))).toBe(EXIT.UNREACHABLE);
  });

  it('treats an unexpected exception as a failed operation, not a usage error', () => {
    // The command line was accepted; something after it broke. Reporting 2
    // would send a CI job back to re-read its own flags over a bug in here.
    expect(exitCodeFor(new TypeError('undefined is not a function'))).toBe(EXIT.FAILED);
    expect(exitCodeFor('a thrown string')).toBe(EXIT.FAILED);
  });
});

describe('3 is reserved for "there is no daemon"', () => {
  it('reports an unreachable transport distinctly from a refusal', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      fetch: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7317'), { code: 'ECONNREFUSED' });
      },
    });

    const error = (await client.health().catch((thrown: unknown) => thrown)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(EXIT.UNREACHABLE);
    expect(error.message).toContain(BASE);
    expect(error.remedy).toMatch(/forgebridge daemon/);
  });

  it('reports a refusal the daemon actually made as 1, with its own remedy', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: 'stale_base',
            message: 'changeset was built against version 2; the project is at 9',
            remedy: 'Rebuild against version 9 and resubmit.',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    });

    const error = (await client.diff(randomUUID()).catch((thrown: unknown) => thrown)) as CliError;
    expect(error.exitCode).toBe(EXIT.FAILED);
    // The protocol error code survives to the terminal; so does its remedy.
    expect(error.message).toMatch(/^stale_base: /);
    expect(error.remedy).toBe('Rebuild against version 9 and resubmit.');
  });

  it('falls back to the status when a refusal is not a ProtocolError', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async () => new Response('<html>502</html>', { status: 502 }),
    });
    const error = (await client.health().catch((thrown: unknown) => thrown)) as CliError;
    expect(error.exitCode).toBe(EXIT.FAILED);
    expect(error.message).toMatch(/HTTP 502/);
  });

  it('treats a 200 that does not match the contract as a failure, not a crash', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      fetch: async () =>
        new Response(JSON.stringify({ surprise: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const error = (await client.linkStatus().catch((thrown: unknown) => thrown)) as CliError;
    expect(error.exitCode).toBe(EXIT.FAILED);
    expect(error.message).toMatch(/does not recognise/);
  });
});

describe('2 is reserved for a command line that was never attempted', () => {
  it('refuses a producer route with no token before making a request', async () => {
    let called = false;
    const client = new DaemonClient({
      baseUrl: BASE,
      fetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });

    const error = (await client.diff(randomUUID()).catch((thrown: unknown) => thrown)) as CliError;
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.remedy).toMatch(/FORGEBRIDGE_PRODUCER_TOKEN/);
    expect(called).toBe(false);
  });

  it('refuses `link --code`, because a pairing code belongs to the plugin', async () => {
    const io = captureIo();
    const transport = stubTransport();

    const error = (await linkCommand(
      { command: 'link', global: GLOBAL, code: 'ABCD2345' },
      testDeps(io, transport),
    ).catch((thrown: unknown) => thrown)) as CliError;

    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.message).toMatch(/redeemed by the Studio plugin, not by the CLI/);
    expect(error.remedy).toMatch(/single-use code/);
    // Refused before any request: redeeming it is the harm, so it never happens.
    expect(transport.calls).toEqual([]);
  });
});

describe('1 is reserved for an operation the transport could not do', () => {
  it('fails when a run tried every model and produced nothing', async () => {
    // The daemon answers 201 for this: a run that got five refusals still has
    // an attempt list, and a ProtocolError body has nowhere to put one. So the
    // outcome is read off `failure`, and a CLI that branched on the HTTP status
    // would report success for a run that produced nothing.
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () =>
        runResponseFixture({
          run: {
            ...runResponseFixture().run,
            stage: 'failed',
            status: 'failed',
            attempts: [
              { modelId: 'glm-5.2:free', outcome: 'rate-limited', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 900 },
              { modelId: 'minimax-m3:free', outcome: 'rate-limited', startedAt: '2026-01-01T00:00:01.000Z', durationMs: 800 },
            ],
            changeSetIds: [],
          },
          changeSetId: null,
          changeSetStatus: null,
          contentDigest: null,
          validation: null,
          failure: { code: 'provider_unconfigured', message: 'every candidate refused this run' },
        }),
    });

    const code = await runCommand(RUN_INVOCATION, testDeps(io, transport));

    expect(code).toBe(EXIT.FAILED);
    expect(transport.calls).toEqual(['linkStatus', 'startRun']);
    // Both models are named, in order, with why the router moved on.
    expect(io.outText()).toContain('glm-5.2:free → rate-limited → minimax-m3:free');
  });

  it('fails when no registry is configured, rather than reporting zero models', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      models: async () => modelsFixture({ configured: false, models: [] }),
    });

    const error = (await modelsCommand(
      { command: 'models', global: GLOBAL, free: true, capabilities: [] },
      testDeps(io, transport),
    ).catch((thrown: unknown) => thrown)) as CliError;

    expect(error.exitCode).toBe(EXIT.FAILED);
    expect(error.message).toMatch(/no model registry configured/);
  });

  it('succeeds when a configured registry simply matches nothing', async () => {
    // An empty answer from a real registry is an answer.
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      models: async () => modelsFixture({ models: [{ id: 'a/b', free: false, capabilities: ['tools'] }] }),
    });

    await expect(
      modelsCommand({ command: 'models', global: GLOBAL, free: true, capabilities: [] }, testDeps(io, transport)),
    ).resolves.toBe(EXIT.OK);
    expect(io.errText()).toMatch(/no models match/);
  });
});

describe('help and version', () => {
  it('exit 0 and document the exit codes', async () => {
    const io = captureIo();
    await expect(dispatch({ command: 'help', topic: null }, testDeps(io, stubTransport()))).resolves.toBe(EXIT.OK);
    const help = io.outText();
    for (const line of ['0  success', '2  usage error', '3  no daemon answered']) {
      expect(help).toContain(line);
    }
  });

  it('names the protocol version alongside its own', async () => {
    const io = captureIo();
    await expect(dispatch({ command: 'version' }, testDeps(io, stubTransport()))).resolves.toBe(EXIT.OK);
    expect(io.outText()).toMatch(/^forgebridge \d+\.\d+\.\d+ \(protocol \d+\.\d+\.\d+\)$/);
  });
});
