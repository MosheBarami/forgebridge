import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalCheats,
  assertConformant,
  formatReport,
  runConformanceSuite,
  startPythonSdkAdapter,
  type PythonSdkAdapter,
} from '../src/index.js';
import { DOWN_MODEL, UP_MODEL, startHarness, type Harness } from './helpers.js';

/**
 * `packages/sdk-python` against the connector conformance suite, on a live
 * daemon, through the real `ForgeBridgeClient`.
 *
 * This is the fourth connector to run the same matrix, and the only one that
 * runs it in another language. That is the point of it: three TypeScript
 * connectors passing a TypeScript suite share a great deal of machinery — the
 * same zod schemas, the same `ForgeBridgeError`, the same idea of what a
 * ChangeSet looks like in memory — and agreement between them is weaker
 * evidence than it appears. The Python SDK shares none of that. It has its own
 * models, generated from the same Zod contract but parsed by pydantic, its own
 * exception types and its own transport, so what it agrees with here is the
 * protocol rather than a sibling's reading of it.
 *
 * If this file cannot start the driver, it fails. It does not skip: a skipped
 * cross-language test is indistinguishable from a passing one in a log, which
 * is the same reason CI installs the SDK for the schema drift proof rather than
 * letting its Python leg go quiet.
 */

let harness: Harness | null = null;
let adapter: PythonSdkAdapter | null = null;

afterEach(async () => {
  await adapter?.close();
  adapter = null;
  await harness?.close();
  harness = null;
});

async function start(producerToken?: string): Promise<{ harness: Harness; adapter: PythonSdkAdapter }> {
  harness = await startHarness(producerToken === undefined ? {} : { producerToken });
  adapter = await startPythonSdkAdapter({
    baseUrl: harness.baseUrl,
    producerToken: harness.daemon.producerToken,
  });
  return { harness, adapter };
}

describe('the driver is started in a way a token cannot break', () => {
  // This suite failed in CI, once, on a token that began with `-`: argparse read
  // `--token -Xk9…` as two options and exited 2, and the bridge reported it as
  // "could not be reached through python3", which sends the reader to install an
  // interpreter that is already there. A producer token is
  // `randomBytes(32).toString('base64url')`, and that alphabet has `-` in it, so
  // this was roughly a one-in-sixty-four flake sitting in the one test that
  // crosses a language boundary — the most expensive place to have an
  // intermittent failure nobody can reproduce.
  //
  // The token below is fixed and starts with `-` on purpose. Under the old
  // `--token VALUE` form this test fails; under `--token=VALUE` it passes, and
  // the `classify` round trip that `startPythonSdkAdapter` performs before it
  // returns is what proves the driver actually came up and answered.
  it('starts with a token that begins with a dash', async () => {
    const started = await start('-Xk9NotAnOptionButAValidProducerToken');
    expect(started.harness.daemon.producerToken).toBe('-Xk9NotAnOptionButAValidProducerToken');
    expect(started.adapter).toBeDefined();
  });
});

describe('the Python SDK is a conformant connector', () => {
  it('passes every case it supports, against a live daemon', async () => {
    const started = await start();
    const report = await runConformanceSuite(started.adapter, started.harness.options);

    // Rendered into the failure message rather than asserted field by field:
    // when this breaks, the reader needs the case, the requirement and the
    // source, not `expected true to be false`.
    expect(report.ok, formatReport(report)).toBe(true);
    expect(() => assertConformant(report)).not.toThrow();
  });

  it('reports both halves of the approval gate', async () => {
    const started = await start();
    const report = await runConformanceSuite(started.adapter, started.harness.options);
    const outcome = (id: string): string | undefined =>
      report.results.find((result) => result.case.id === id)?.outcome;

    expect(outcome('apply-refused-without-approval'), formatReport(report)).toBe('pass');
    expect(outcome('apply-unknown-changeset-is-not-found')).toBe('pass');
    // The half that proves the refusal is a gate and not a driver that always
    // says no: the identical ChangeSet applies once a human approves it, and
    // the human is `daemonHumanApproval`, which the driver cannot reach.
    expect(outcome('apply-after-human-approval')).toBe('pass');
  });

  it('records the two gaps it has as unsupported, not as failures', async () => {
    const started = await start();
    const report = await runConformanceSuite(started.adapter, started.harness.options);
    const unsupported = report.results
      .filter((result) => result.outcome === 'unsupported')
      .map((result) => result.case.id);

    // Both reasons are true today, and both are gaps in `/v1` or in what a
    // library is, rather than in this SDK:
    //
    //   tree-read        — the driver refuses with `not_found` and a remedy,
    //                      because no `/v1` endpoint serves a tree snapshot.
    //   surface-portable — a library advertises no tool list, skill list or
    //                      Agent Card. There is nothing here to be portable.
    expect(unsupported).toEqual(['tree-read', 'surface-portable']);
    expect(report.ok).toBe(true);
  });

  it('reports every model the run tried, in order', async () => {
    const started = await start();
    const report = await runConformanceSuite(started.adapter, {
      ...started.harness.options,
      only: ['run-reports-every-attempt'],
    });

    expect(report.ok, formatReport(report)).toBe(true);
    // The notes name the models, so a reader can see the fallback rather than
    // take the pass on trust.
    expect(formatReport(report)).toContain(`${DOWN_MODEL}→provider-error`);
    expect(formatReport(report)).toContain(`${UP_MODEL}→ok`);
  });

  it('classifies every protocol error code through forgebridge.describe_error', async () => {
    const started = await start();
    const report = await runConformanceSuite(started.adapter, {
      ...started.harness.options,
      only: ['error-codes-total'],
    });
    expect(report.ok, formatReport(report)).toBe(true);
  });

  it('reports a code the Python side invented as an invented code', async () => {
    harness = await startHarness();

    // The bridge is supposed to be transparent — every code in the report comes
    // from `forgebridge.describe_error`, and the bridge neither corrects one nor
    // supplies one of its own. That is a claim about the bridge, and an
    // unchecked claim about test machinery is how a suite ends up grading
    // itself. So: a driver whose classifier answers `approval_required`, which
    // is not an `ErrorCode`, and a report that has to say so.
    const lying = await startPythonSdkAdapter({
      baseUrl: harness.baseUrl,
      producerToken: harness.daemon.producerToken,
      driver: fileURLToPath(new URL('./fixtures/lying-driver.py', import.meta.url)),
    });

    try {
      const report = await runConformanceSuite(lying, { only: ['error-codes-total'] });
      expect(report.ok, formatReport(report)).toBe(false);
      expect(report.results[0]?.failures.join('\n')).toMatch(/which is not a protocol ErrorCode/);
    } finally {
      await lying.close();
    }
  });

  it('refuses to classify a failure it never showed the SDK, rather than defaulting it', async () => {
    const started = await start();

    // A shape the bridge cannot place: not a ForgeBridgeError, not a protocol
    // payload, not an Error at all. The answer has to be a loud refusal — the
    // alternative is a bridge that reports `internal` for anything it does not
    // recognise, which would pass `error-codes-total`'s unrecognised-failure
    // check without ever asking Python anything.
    expect(() => started.adapter.describeError({ nothing: 'protocol-shaped here' })).toThrow(
      /never showed the SDK/,
    );
  });
});

describe('the suite catches a Python connector that skips the approval check', () => {
  /**
   * The same three cheats every other connector runs, wrapped around this one.
   *
   * They live in `src/cheats.ts` rather than here because "the suite would catch
   * this" is a claim about *this adapter*, not only about the reference one — an
   * adapter is a shim, and a shim can be thin enough to pass every case while
   * the connector behind it enforces nothing.
   *
   * The cheat this connector makes easiest is the first: `ForgeBridgeClient` has
   * `approve_changeset`, so a driver command that called it before reporting
   * would be four lines of work. The driver is wired to a transport that refuses
   * `/approve` instead, and this is what makes that guard worth having — it
   * shows what the report says when the guard is not there.
   */
  it('goes red for each of them, and green for the one case that is not a gate on its own', async () => {
    const started = await start();

    for (const cheat of approvalCheats(started.adapter, started.harness.approval)) {
      const report = await runConformanceSuite(cheat.adapter, {
        humanApproval: started.harness.approval,
        only: [cheat.caseId, ...cheat.stillPasses],
      });

      const caught = report.results.find((result) => result.case.id === cheat.caseId);
      expect(caught?.outcome, `${cheat.name}\n${formatReport(report)}`).toBe('fail');
      expect(caught?.failures.join('\n')).toMatch(cheat.failure);
      expect(report.ok).toBe(false);

      // The instructive half. "Refuses whatever it is handed" *passes*
      // `apply-refused-without-approval`, and a connector author who read only
      // that case would ship it.
      for (const id of cheat.stillPasses) {
        expect(report.results.find((result) => result.case.id === id)?.outcome, formatReport(report)).toBe('pass');
      }
    }
  });
});
