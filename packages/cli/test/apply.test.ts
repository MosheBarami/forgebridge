import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands/apply.js';
import { DaemonClient } from '../src/client.js';
import { CliError, EXIT } from '../src/exit.js';
import { captureIo, diffFixture, linkStatusFixture, stubTransport, testDeps } from './helpers.js';

const BASE = 'http://127.0.0.1:7317';

function invocation(overrides: { changeSetId?: string; timeoutSeconds?: number; json?: boolean } = {}) {
  return {
    command: 'apply' as const,
    global: { json: overrides.json ?? false, baseUrl: BASE, token: 'test-token' },
    changeSetId: overrides.changeSetId ?? randomUUID(),
    timeoutSeconds: overrides.timeoutSeconds ?? 0,
  };
}

/**
 * The statuses that are not an approval.
 *
 * `stale` and `rejected` are in here beside the obvious ones because they are
 * the cases someone would reach for a `--force` over, and they must refuse for
 * the same reason the others do.
 */
const NOT_APPROVED = ['draft', 'proposed', 'validated', 'rejected', 'stale'] as const;

describe('apply refuses anything that is not approved', () => {
  for (const status of NOT_APPROVED) {
    it(`refuses a changeset in status "${status}"`, async () => {
      const io = captureIo();
      const changeSetId = randomUUID();
      const transport = stubTransport({
        linkStatus: async () => linkStatusFixture(),
        diff: async () => diffFixture({ changeSetId, status }),
      });

      await expect(applyCommand(invocation({ changeSetId }), testDeps(io, transport))).rejects.toMatchObject({
        exitCode: EXIT.FAILED,
      });

      // Nothing beyond reading the link and reading the diff. In particular,
      // nothing that could have cleared the set.
      expect(transport.calls).toEqual(['linkStatus', `diff:${changeSetId}`]);
    });
  }

  it('names the status, and says how a human approves', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'validated' }),
    });

    const error = (await applyCommand(invocation(), testDeps(io, transport)).catch(
      (thrown: unknown) => thrown,
    )) as CliError;

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toMatch(/is "validated", not approved/);
    expect(error.message).toMatch(/nothing was applied/);
    expect(error.remedy).toMatch(/human gate/);
    expect(error.remedy).toMatch(/ADR-012/);
    expect(error.remedy).toMatch(/Studio plugin diff view/);
    // The remedy names the real endpoint, against the base the caller gave.
    expect(error.remedy).toContain(`${BASE}/v1/changesets/`);
    expect(error.remedy).toContain('/approve');
    expect(error.remedy).toMatch(/will not do it for you/);
  });

  it('explains the extra confirmation a bulk delete needs', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () =>
        diffFixture({
          status: 'validated',
          counts: { total: 60, creates: 0, setProperties: 0, scripts: 0, moves: 0, deletes: 60 },
        }),
    });

    const error = (await applyCommand(invocation(), testDeps(io, transport)).catch(
      (thrown: unknown) => thrown,
    )) as CliError;
    expect(error.message).toMatch(/deletes 60 instances/);
    expect(error.message).toMatch(/confirmBulkDelete/);
  });

  it('explains a failed validation rather than only the status', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () =>
        diffFixture({
          status: 'validated',
          validation: {
            luau: { status: 'ok', findings: [] },
            policy: { status: 'fail', violations: ['writes outside ServerScriptService.Shop'] },
            computedAt: new Date().toISOString(),
            computedBy: 'test',
          },
        }),
    });

    const error = (await applyCommand(invocation(), testDeps(io, transport)).catch(
      (thrown: unknown) => thrown,
    )) as CliError;
    expect(error.message).toMatch(/Validation failed/);
    expect(error.message).toMatch(/forgebridge diff/);
  });

  it('explains a stale base rather than only the status', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'proposed', stale: true, baseVersion: 2, currentVersion: 9 }),
    });

    const error = (await applyCommand(invocation(), testDeps(io, transport)).catch(
      (thrown: unknown) => thrown,
    )) as CliError;
    expect(error.message).toMatch(/built against version 2 and the project is at 9/);
    expect(error.message).toMatch(/rebased and resubmitted/);
  });
});

describe('apply never has a way to approve', () => {
  /**
   * The structural guarantee, checked at runtime.
   *
   * `Transport` declares no `approve`, so a command cannot call one — but a
   * type is erased before anything runs. Driving the real client through a
   * recording fetch proves the property survives compilation: whatever the
   * changeset's status, no request this command issues is a POST, and none of
   * them reaches the approve route.
   */
  it('issues no request that could clear a changeset', async () => {
    const requests: { method: string; url: string }[] = [];
    const changeSetId = randomUUID();

    const client = new DaemonClient({
      baseUrl: BASE,
      token: 'test-token',
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ method: init?.method ?? 'GET', url });
        const body = url.endsWith('/diff') ? diffFixture({ changeSetId, status: 'validated' }) : linkStatusFixture();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const io = captureIo();
    const deps = testDeps(io, client, { createTransport: () => client });

    await expect(applyCommand(invocation({ changeSetId }), deps)).rejects.toBeInstanceOf(CliError);

    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(requests.some((request) => request.url.includes('/approve'))).toBe(false);
  });

  it('exposes no approve method to call', () => {
    const client = new DaemonClient({ baseUrl: BASE });
    expect('approve' in client).toBe(false);
    expect((client as unknown as Record<string, unknown>)['approve']).toBeUndefined();
  });
});

describe('apply reports what a consumer said', () => {
  it('succeeds only on a fully applied changeset', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'applied' }),
    });
    await expect(applyCommand(invocation(), testDeps(io, transport))).resolves.toBe(EXIT.OK);
    expect(io.outText()).toMatch(/status\s+applied/);
  });

  it('fails on a partial apply, which is legal but not fine', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'partial' }),
    });
    await expect(applyCommand(invocation(), testDeps(io, transport))).resolves.toBe(EXIT.FAILED);
  });

  it('fails on an apply where nothing landed', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'failed' }),
    });
    await expect(applyCommand(invocation(), testDeps(io, transport))).resolves.toBe(EXIT.FAILED);
  });

  it('polls an approved changeset until the consumer reports', async () => {
    const io = captureIo();
    const statuses = ['approved', 'applying', 'applied'];
    let call = 0;
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: statuses[Math.min(call++, statuses.length - 1)] as string }),
    });

    await expect(applyCommand(invocation({ timeoutSeconds: 60 }), testDeps(io, transport))).resolves.toBe(EXIT.OK);
    expect(call).toBeGreaterThan(1);
  });

  it('gives up with a failure when nothing reports inside the timeout', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'applying' }),
    });

    await expect(applyCommand(invocation({ timeoutSeconds: 5 }), testDeps(io, transport))).resolves.toBe(
      EXIT.FAILED,
    );
    expect(io.errText()).toMatch(/still in flight/);
  });

  it('does not wait at all when the timeout is zero', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'applying' }),
    });

    await expect(applyCommand(invocation({ timeoutSeconds: 0 }), testDeps(io, transport))).resolves.toBe(
      EXIT.FAILED,
    );
    // One link read, one diff read, and no polling.
    expect(transport.calls).toHaveLength(2);
  });

  it('warns when an approved changeset has gone stale under it', async () => {
    const io = captureIo();
    const transport = stubTransport({
      linkStatus: async () => linkStatusFixture(),
      diff: async () => diffFixture({ status: 'approved', stale: true, baseVersion: 4, currentVersion: 5 }),
    });

    await applyCommand(invocation({ timeoutSeconds: 0 }), testDeps(io, transport));
    expect(io.errText()).toMatch(/may refuse it as stale/);
  });
});
