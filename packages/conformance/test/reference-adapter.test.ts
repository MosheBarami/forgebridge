import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@forgebridge/protocol';
import { CASE_IDS, assertConformant, formatReport, runConformanceSuite } from '../src/index.js';
import { startHarness, type Harness } from './helpers.js';

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

  it('records the daemon’s two known gaps as unsupported, not as failures', async () => {
    harness = await startHarness();
    const report = await runConformanceSuite(harness.adapter, harness.options);
    const unsupported = report.results.filter((result) => result.outcome === 'unsupported').map((result) => result.case.id);

    // `/v1` serves no tree snapshot and has no runs route yet. Both refusals
    // are honest ones, so the suite records the gap and stays green — and both
    // cases start passing the day the endpoints land, with no edit here.
    expect(unsupported).toEqual(['tree-read', 'run-reports-every-attempt', 'surface-portable']);
    expect(report.ok).toBe(true);
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
