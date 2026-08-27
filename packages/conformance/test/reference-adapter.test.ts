import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, ForgeBridgeError } from '@forgebridge/protocol';
import { createDaemon } from '@forgebridge/daemon';
import {
  CASE_IDS,
  DaemonRestAdapter,
  assertConformant,
  formatReport,
  runConformanceSuite,
  type ConnectorAdapter,
} from '../src/index.js';
import { DOWN_MODEL, TEST_POLICY, UP_MODEL, startHarness, type Harness } from './helpers.js';

/**
 * The reference adapter against a live daemon.
 *
 * If this file goes red, one of two things is true: the suite has drifted from
 * the protocol, or the daemon has. Either is worth stopping for — which is the
 * whole reason the reference adapter exists rather than a fake.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('the reference adapter is conformant', () => {
  it('passes every case it supports, against a live daemon', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, harness.options);

    // Rendered into the failure message rather than asserted field by field:
    // when this breaks, the reader needs the case, the requirement and the
    // source, not `expected true to be false`.
    expect(report.ok, formatReport(report)).toBe(true);
    expect(() => assertConformant(report)).not.toThrow();
    expect(report.results).toHaveLength(CASE_IDS.length);
  });

  it('reports the approval gate, both halves of it', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, harness.options);
    const outcome = (id: string): string | undefined => report.results.find((result) => result.case.id === id)?.outcome;

    expect(outcome('apply-refused-without-approval')).toBe('pass');
    expect(outcome('apply-unknown-changeset-is-not-found')).toBe('pass');
    // The half that proves the refusal is a gate and not a connector that
    // always throws: the identical ChangeSet applies once a human approves.
    expect(outcome('apply-after-human-approval')).toBe('pass');
  });

  it('records the two gaps it still has as unsupported, not as failures', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, harness.options);
    const unsupported = report.results.filter((result) => result.outcome === 'unsupported').map((result) => result.case.id);

    // Two, and each for a reason that is true today rather than one that was
    // true when it was written:
    //
    //   tree-read       — `/v1` serves no tree snapshot, so `readTree` refuses
    //                     with `not_found` and a remedy. An honest refusal, and
    //                     the case starts passing the day the endpoint lands.
    //   surface-portable — a REST surface advertises no tool list, skill list or
    //                     Agent Card for a caller to read. There is nothing here
    //                     to be portable or not.
    //
    // `run-reports-every-attempt` is *not* on this list any more: `POST /v1/runs`
    // landed, and this adapter now runs against it.
    expect(unsupported).toEqual(['tree-read', 'surface-portable']);
    expect(report.ok).toBe(true);
  });

  it('reports every model the run tried, against the daemon’s own /v1/runs', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { ...harness.options, only: ['run-reports-every-attempt'] });

    expect(report.ok, formatReport(report)).toBe(true);
    // And the notes name the models, so a reader can see the fallback rather
    // than take the pass on trust.
    expect(formatReport(report)).toContain(`${DOWN_MODEL}→provider-error`);
    expect(formatReport(report)).toContain(`${UP_MODEL}→ok`);
  });

  it('reports a run surface it does not have as unsupported, not as a pass', async () => {
    harness = await startHarness();
    // The same daemon, addressed by an adapter built without `runs`. Nothing
    // about the deployment changed; what changed is that this connector no
    // longer declares a run surface, and the suite has to say so rather than
    // report a case it never ran as green.
    const withoutRuns = new DaemonRestAdapter({ baseUrl: harness.baseUrl, producerToken: harness.daemon.producerToken });
    const report = await runConformanceSuite(withoutRuns, { ...harness.options, only: ['run-reports-every-attempt'] });

    expect(report.results[0]?.outcome).toBe('unsupported');
    expect(report.results[0]?.notes.join('\n')).toContain('declares no startRun()');
    expect(report.ok).toBe(true);
  });

  it('records a deployment with no model client as a gap, and every other refusal as a failure', async () => {
    harness = await startHarness();

    // A daemon that can do everything except call a model. `POST /v1/runs`
    // refuses with `provider_unconfigured` before a token is spent, and that is
    // a fact about the deployment rather than a breach by the connector — so
    // the case is a gap, and it says which gap.
    const bare = createDaemon({ port: 0, policy: TEST_POLICY });
    await bare.listen();
    try {
      const adapter = new DaemonRestAdapter({ baseUrl: bare.url, producerToken: bare.producerToken, runs: true });
      const report = await runConformanceSuite(adapter, { only: ['run-reports-every-attempt'] });

      expect(report.results[0]?.outcome, formatReport(report)).toBe('unsupported');
      expect(report.results[0]?.notes.join('\n')).toContain('no model client');
      expect(report.ok).toBe(true);
    } finally {
      await bare.close();
    }
  });

  it('fails the run case for a refusal that is not the one gap it excuses', async () => {
    harness = await startHarness();

    // `stale_base` is a real protocol error and a perfectly well-formed
    // refusal. It is not "this deployment has no model", so the case has to go
    // red rather than record a gap — otherwise "unsupported" becomes the answer
    // to every failure, which is the same as having no case at all.
    const adapter = new DaemonRestAdapter({ baseUrl: harness.baseUrl, producerToken: harness.daemon.producerToken, runs: true });
    const refusing: ConnectorAdapter = {
      name: adapter.name,
      linkStatus: () => adapter.linkStatus(),
      listProjects: () => adapter.listProjects(),
      readTree: (projectId) => adapter.readTree(projectId),
      propose: (input) => adapter.propose(input),
      diff: (changeSetId) => adapter.diff(changeSetId),
      apply: (changeSetId) => adapter.apply(changeSetId),
      describeError: (error) => adapter.describeError(error),
      startRun: () => Promise.reject(new ForgeBridgeError('stale_base', 'the place moved', 'Rebase and try again.')),
    };

    const report = await runConformanceSuite(refusing, { ...harness.options, only: ['run-reports-every-attempt'] });
    expect(report.results[0]?.outcome).toBe('fail');
    expect(report.results[0]?.failures.join('\n')).toMatch(/startRun\(\) refused with "stale_base"/);
  });

  it('classifies every protocol error code, from an instance and from the wire', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, { ...harness.options, only: ['error-codes-total'] });
    expect(report.ok, formatReport(report)).toBe(true);

    // Belt and braces: the case iterates the enum, and so does this.
    for (const code of ErrorCode.options) {
      expect(harness.adapter.describeError({ code, message: 'off the wire' })).toMatchObject({ code, recognised: true });
    }
    expect(harness.adapter.describeError(new Error('socket hang up'))).toMatchObject({ code: 'internal', recognised: false });
  });

  it('runs any case on its own, resolving its own prerequisites', async () => {
    harness = await startHarness();
    for (const id of ['apply-refused-without-approval', 'verdict-recomputed', 'stale-base-refused']) {
      const report = await runConformanceSuite(harness.adapter, { ...harness.options, only: [id] });
      expect(report.results.map((result) => result.case.id), formatReport(report)).toEqual([id]);
      expect(report.ok, formatReport(report)).toBe(true);
    }
  });

  it('refuses an unknown case id rather than silently running nothing', async () => {
    harness = await startHarness();
    await expect(runConformanceSuite(harness.adapter, { only: ['apply-without-approvel'] })).rejects.toThrow(
      /unknown conformance case id/,
    );
  });
});
