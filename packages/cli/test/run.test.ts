import { describe, expect, it } from 'vitest';
import { PRODUCER_TOKEN_HEADER, type RunResponse } from '@forgebridge/daemon';
import { DaemonClient } from '../src/client.js';
import { parseInvocation } from '../src/args.js';
import { EXIT } from '../src/exit.js';
import { runCommand } from '../src/commands/run.js';
import { captureIo, linkStatusFixture, runResponseFixture, stubTransport, testDeps } from './helpers.js';

/**
 * `forgebridge run`, from the two sides that matter.
 *
 * The command's job is to make a run *legible* — which models were tried, in
 * what order, and what has to happen next — without ever being the thing that
 * approves. So these tests assert on what was printed and on what was called,
 * not on a return value: a `run` that applied would return the same exit code
 * as one that did not.
 */

const BASE = 'http://127.0.0.1:7317';
const GLOBAL = { json: false, baseUrl: BASE, token: 'test-token' };

const INVOCATION = {
  command: 'run',
  global: GLOBAL,
  prompt: 'add a purchase handler to the shop',
  projectId: null,
  policy: null,
  pinnedModel: null,
  baseVersion: null,
  maxAttempts: null,
  verbose: false,
} as const;

describe('run reports every model it tried', () => {
  it('prints the collapsed attempt log, in the protocol’s own words', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () => runResponseFixture(),
    });

    const code = await runCommand(INVOCATION, testDeps(io, transport));

    expect(code).toBe(EXIT.OK);
    // The fixture fell back once. Both models appear, in order, with the
    // outcome that made the router move on — never only the one that answered.
    expect(io.outText()).toContain('models     glm-5.2:free → rate-limited → minimax-m3:free');
  });

  it('streams the plan and each attempt as it happens, on stderr', async () => {
    const io = captureIo();
    const response = runResponseFixture();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async (_request, onFrame) => {
        onFrame?.({ name: 'plan', data: { plan: { steps: ['write one script under ServerScriptService.Shop'] } } });
        onFrame?.({
          name: 'model-attempt-started',
          data: { modelId: 'glm-5.2:free', provider: 'openrouter', attemptIndex: 0 },
        });
        onFrame?.({
          name: 'model-attempt',
          data: { attempt: response.run.attempts[0] },
        });
        // Two of these arrive for one ChangeSet — the core computes a verdict
        // and the daemon recomputes it over a superset of the sources. Naming
        // the author is what keeps the second line from reading as a bug.
        onFrame?.({
          name: 'validation',
          data: {
            changeSetId: response.changeSetId,
            validation: { luau: { status: 'ok' }, policy: { status: 'ok' }, computedBy: 'forgebridge-core' },
          },
        });
        onFrame?.({
          name: 'validation',
          data: {
            changeSetId: response.changeSetId,
            validation: { luau: { status: 'ok' }, policy: { status: 'ok' }, computedBy: 'forgebridge-daemon@0.1.0' },
          },
        });
        onFrame?.({
          name: 'output-delta',
          data: { modelId: 'minimax-m3:free', delta: 'local total = 1' },
        });
        onFrame?.({
          name: 'model-skipped',
          data: { skipped: { modelId: 'qwen3:free', provider: 'openrouter', reason: 'circuit-open', detail: 'three failures in the last minute' } },
        });
        return response;
      },
    });

    await runCommand(INVOCATION, testDeps(io, transport));

    const err = io.errText();
    expect(err).toContain('write one script under ServerScriptService.Shop');
    // The model is named *before* the call, so ninety seconds on a rate-limited
    // model is distinguishable from a hung daemon.
    expect(err).toContain('→ glm-5.2:free (openrouter)');
    expect(err).toContain('rate-limited');
    // A skip is not an attempt and must not read like one.
    expect(err).toContain('skipped');
    expect(err).toContain('qwen3:free — circuit-open');
    // Both verdicts are shown, each naming who computed it.
    expect(err).toContain('validation luau ok, policy ok (forgebridge-core)');
    expect(err).toContain('validation luau ok, policy ok (forgebridge-daemon@0.1.0)');
    // A model's partial output is never rendered: there are thousands of these
    // fragments, and the answer itself is the ChangeSet reported at the end.
    expect(err).not.toContain('local total = 1');
    // The live log never lands on stdout, so `--json | jq` still works.
    expect(io.outText()).not.toContain('circuit-open');
  });

  it('keeps the full attempt record behind --verbose', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () => runResponseFixture(),
    });

    await runCommand({ ...INVOCATION, verbose: true }, testDeps(io, transport));

    const err = io.errText();
    expect(err).toContain('the provider answered 429');
    expect(err).toContain('tokens 812/640');
    expect(err).toContain('$0.0000');
    expect(err).toContain('free-first: 2 eligible of 6 considered');
  });

  it('does not print a model\u2019s partial output, even under --verbose', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async (_request, onFrame) => {
        for (let index = 0; index < 50; index += 1) {
          onFrame?.({ name: 'output-delta', data: { modelId: 'minimax-m3:free', delta: `chunk-${index}` } });
        }
        return runResponseFixture();
      },
    });

    await runCommand({ ...INVOCATION, verbose: true }, testDeps(io, transport));

    // Not even as a bare event name: fifty lines of `· output-delta` would bury
    // the attempt log this command exists to show, and a real run emits
    // thousands.
    expect(io.errText()).not.toContain('output-delta');
    expect(io.errText()).not.toContain('chunk-0');
  });

  it('says so when a run produced no ChangeSet at all', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () =>
        runResponseFixture({
          changeSetId: null,
          changeSetStatus: null,
          contentDigest: null,
          validation: null,
          failure: { code: 'provider_unconfigured', message: 'no model was usable', remedy: 'Configure a provider.' },
        }),
    });

    const code = await runCommand(INVOCATION, testDeps(io, transport));

    expect(code).toBe(EXIT.FAILED);
    expect(io.outText()).toContain('none — this run produced no ChangeSet');
    expect(io.errText()).toContain('provider_unconfigured: no model was usable');
    expect(io.errText()).toContain('Configure a provider.');
    // Nothing to approve, so nothing that looks like an approval is offered.
    expect(io.errText()).not.toContain('/approve');
  });
});

describe('run proposes and never approves', () => {
  it('prints the changeset id, how to review it, and how a human approves it', async () => {
    const io = captureIo();
    const response = runResponseFixture();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () => response,
    });

    await runCommand(INVOCATION, testDeps(io, transport));

    expect(io.outText()).toContain(`changeset  ${response.changeSetId}  validated`);
    expect(io.errText()).toContain(`forgebridge diff ${response.changeSetId}`);
    expect(io.errText()).toContain('approving is a separate act a model cannot perform');
    // The approve command carries the digest this run reported, so pasting it
    // approves the operations that were shown rather than an id.
    expect(io.errText()).toContain(`-d '{"contentDigest":"${response.contentDigest}"`);
    // And the command itself called nothing that could approve.
    expect(transport.calls).toEqual(['linkStatus', 'startRun']);
  });

  it('offers no approve command for a set that cannot be approved', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () =>
        runResponseFixture({
          changeSetStatus: 'rejected',
          failure: { code: 'policy_violation', message: 'outside the allowed paths' },
        }),
    });

    const code = await runCommand(INVOCATION, testDeps(io, transport));

    expect(code).toBe(EXIT.FAILED);
    expect(io.errText()).toContain('is "rejected", not "validated"');
    expect(io.errText()).not.toContain('curl -fsS -X POST');
  });

  it('exposes no approve method on the transport it was handed', () => {
    const client = new DaemonClient({ baseUrl: BASE, token: 'test-token' });
    expect('approve' in client).toBe(false);
  });
});

describe('run over the wire', () => {
  /** One SSE frame, exactly as `writeEventFrame` in the daemon renders it. */
  function frame(name: string, data: unknown, id?: number): string {
    const lines = id === undefined ? [] : [`id: ${id}`];
    lines.push(`event: ${name}`, `data: ${JSON.stringify(data)}`, '', '');
    return lines.join('\n');
  }

  function eventStream(chunks: readonly string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }

  it('follows the stream and answers with the run the daemon settled on', async () => {
    const settled = runResponseFixture();
    const seen: string[] = [];
    let sent: Record<string, unknown> = {};

    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async (_input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return eventStream([
          ': keep-alive\n\n',
          frame('run', { ...settled, run: { ...settled.run, stage: 'queued', attempts: [] } }),
          frame('stage', { at: '2026-01-01T00:00:00.000Z', from: 'queued', stage: 'planning' }, 0),
          // Split across two writes: a frame does not arrive whole, and a
          // parser that assumed it did would drop half a run log.
          frame('model-attempt', { at: '2026-01-01T00:00:01.000Z', attempt: settled.run.attempts[0] }, 1).slice(0, 20),
          frame('model-attempt', { at: '2026-01-01T00:00:01.000Z', attempt: settled.run.attempts[0] }, 1).slice(20),
          frame('run', settled),
        ]);
      },
    });

    const response = await client.startRun({ prompt: 'build a shop' }, (received) => seen.push(received.name));

    // The stream is asked for only because a listener was given, and the client
    // sets that field itself so the request and the reader cannot disagree.
    expect(sent['stream']).toBe(true);
    expect(seen).toEqual(['stage', 'model-attempt']);
    // The last `run` frame is the answer — never a result reassembled from
    // whichever events the reader happened to catch.
    expect(response.run.attempts).toHaveLength(2);
    expect(response.run.stage).toBe('awaiting-approval');
  });

  it('asks for JSON when nobody is watching, and sends the producer token', async () => {
    const settled = runResponseFixture();
    let headers: Headers | undefined;
    let sent: Record<string, unknown> = {};

    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(settled), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const response = await client.startRun({ prompt: 'build a shop' });

    expect(sent['stream']).toBe(false);
    expect(headers?.get(PRODUCER_TOKEN_HEADER)).toBe('test-token');
    expect(response.run.attempts.map((attempt) => attempt.outcome)).toEqual(['rate-limited', 'ok']);
  });

  it('reports a refusal the daemon made before the stream opened', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: 'stale_base',
            message: 'this run was requested against version 3; the project is at 5',
            remedy: 'Re-read the project version and resubmit with 5.',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    });

    // A run refused before a token is spent answers as an ordinary JSON error,
    // whatever the request asked for, so the content type decides how the body
    // is read rather than the flag that was sent.
    await expect(client.startRun({ prompt: 'build a shop' }, () => {})).rejects.toMatchObject({
      exitCode: EXIT.FAILED,
      message: expect.stringContaining('stale_base'),
      remedy: expect.stringContaining('resubmit with 5'),
    });
  });

  it('reports a failure that arrived inside an already-open stream', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async () =>
        eventStream([
          frame('run', runResponseFixture()),
          frame('error', { code: 'internal', message: 'the run failed after the stream opened' }),
        ]),
    });

    await expect(client.startRun({ prompt: 'build a shop' }, () => {})).rejects.toMatchObject({
      message: expect.stringContaining('internal: the run failed after the stream opened'),
    });
  });

  it('refuses to invent a result from a stream that never reported the run', async () => {
    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async () => eventStream([frame('stage', { from: 'queued', stage: 'planning' })]),
    });

    await expect(client.startRun({ prompt: 'build a shop' }, () => {})).rejects.toMatchObject({
      message: expect.stringContaining('ended without reporting the run'),
    });
  });

  it('needs the producer token, and says so before sending anything', async () => {
    let called = false;
    const client = new DaemonClient({
      baseUrl: BASE,
      fetch: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });

    await expect(client.startRun({ prompt: 'build a shop' })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    expect(called).toBe(false);
  });
});

describe('the run command line', () => {
  const env = { FORGEBRIDGE_PRODUCER_TOKEN: 'test-token' };

  it('takes a prompt and defaults everything else to the transport', () => {
    const invocation = parseInvocation(['run', 'build a shop'], env);
    expect(invocation).toMatchObject({
      command: 'run',
      prompt: 'build a shop',
      policy: null,
      pinnedModel: null,
      verbose: false,
    });
  });

  it('reads --model as a pin, because naming a model means it', () => {
    expect(parseInvocation(['run', 'p', '--model', 'glm-5.2:free'], env)).toMatchObject({
      policy: 'pinned',
      pinnedModel: 'glm-5.2:free',
    });
  });

  it('refuses --policy pinned with nothing pinned', () => {
    expect(() => parseInvocation(['run', 'p', '--policy', 'pinned'], env)).toThrow(/needs --model/);
  });

  it('refuses a --model the transport would accept and then ignore', () => {
    expect(() => parseInvocation(['run', 'p', '--model', 'x', '--policy', 'cheapest'], env)).toThrow(
      /only means something under --policy pinned/,
    );
  });

  it('refuses a policy the router does not implement', () => {
    expect(() => parseInvocation(['run', 'p', '--policy', 'vibes'], env)).toThrow(/--policy must be one of/);
  });

  it('bounds --max-attempts by the protocol’s own cap', () => {
    expect(parseInvocation(['run', 'p', '--max-attempts', '3'], env)).toMatchObject({ maxAttempts: 3 });
    expect(() => parseInvocation(['run', 'p', '--max-attempts', '99'], env)).toThrow(/between 1 and 10/);
  });
});

describe('run under --json', () => {
  it('puts one document on stdout and every notice on stderr', async () => {
    const io = captureIo();
    const response = runResponseFixture();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      startRun: async () => response,
    });

    await runCommand({ ...INVOCATION, global: { ...GLOBAL, json: true } }, testDeps(io, transport));

    const parsed = JSON.parse(io.outText()) as RunResponse;
    expect(parsed.run.attempts).toHaveLength(2);
    // The privacy posture and the approval instruction are never suppressed by
    // a flag: a machine consumer redirects stdout, and would otherwise be the
    // one caller that never sees either.
    expect(io.errText()).toContain('Local — nothing leaves this machine');
    expect(io.errText()).toContain('forgebridge diff');
  });
});
