import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCER_TOKEN_ENV } from '@forgebridge/daemon';
import { main, parseArgs } from '../src/bin.js';
import { CASE_IDS } from '../src/index.js';
import { startHarness, type Harness } from './helpers.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.restoreAllMocks();
});

/** Captures what the command printed, so the assertions read the real output. */
function captureStdout(): { text: () => string } {
  let buffer = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    buffer += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  return { text: () => buffer };
}

describe('forgebridge-conformance', () => {
  it('reads the token from the environment when no flag names one', () => {
    expect(parseArgs([], { [PRODUCER_TOKEN_ENV]: 'from-the-env' }).token).toBe('from-the-env');
    expect(parseArgs(['--token', 'from-the-flag'], { [PRODUCER_TOKEN_ENV]: 'from-the-env' }).token).toBe('from-the-flag');
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--aprove'], {})).toThrow(/unknown argument: --aprove/);
    expect(() => parseArgs(['--daemon'], {})).toThrow(/--daemon needs a value/);
  });

  it('lists the case ids', async () => {
    const out = captureStdout();
    expect(await main(['--list'], {})).toBe(0);
    expect(out.text().trim().split('\n')).toEqual([...CASE_IDS]);
  });

  it('exits 2 with an actionable message when no producer token is available', async () => {
    captureStdout();
    expect(await main([], {})).toBe(2);
  });

  it('runs green against a live daemon, and exits 0', async () => {
    harness = await startHarness();
    const out = captureStdout();

    const code = await main(['--daemon', harness.baseUrl, '--token', harness.daemon.producerToken, '--approve'], {});

    expect(code, out.text()).toBe(0);
    expect(out.text()).toContain('PASS  apply-refused-without-approval');
    expect(out.text()).toContain('SKIP  tree-read');
  });

  it('exits 1 when a case fails, and prints the case that did', async () => {
    harness = await startHarness();
    const out = captureStdout();

    // Told to build the fixture on a version the project is not at. The daemon
    // refuses with stale_base — correctly — so the propose case cannot do what
    // it is there to do, and the useful thing to assert is that the command
    // *reports* that and leaves with a non-zero code rather than printing green.
    const code = await main(
      ['--daemon', harness.baseUrl, '--token', harness.daemon.producerToken, '--base-version', '999', '--only', 'propose-returns-id-and-diff'],
      {},
    );

    expect(code).toBe(1);
    expect(out.text()).toContain('FAIL  propose-returns-id-and-diff');
    expect(out.text()).toContain('source:');
  });

  it('leaves the run case unsupported unless --run is passed, and passes it when it is', async () => {
    harness = await startHarness();

    // Without the flag there is no run surface to test, and the report says so
    // rather than reporting a case it never ran as green. The flag is opt-in
    // because a run against a real daemon calls a language model and spends
    // whoever configured it's credit — every other call this command makes is a
    // read or a proposal that costs nothing.
    const quiet = captureStdout();
    await main(
      ['--daemon', harness.baseUrl, '--token', harness.daemon.producerToken, '--only', 'run-reports-every-attempt'],
      {},
    );
    expect(quiet.text()).toContain('SKIP  run-reports-every-attempt');
    expect(quiet.text()).toContain('declares no startRun()');
    vi.restoreAllMocks();

    const loud = captureStdout();
    const code = await main(
      ['--daemon', harness.baseUrl, '--token', harness.daemon.producerToken, '--only', 'run-reports-every-attempt', '--run'],
      {},
    );
    expect(code, loud.text()).toBe(0);
    expect(loud.text()).toContain('PASS  run-reports-every-attempt');
    // The models this harness scripts, named in the notes: the run really fell
    // back, so the case checked a list with something in it to check.
    expect(loud.text()).toContain('conformance/down→provider-error');
  });

  it('emits the report as JSON when asked', async () => {
    harness = await startHarness();
    const out = captureStdout();

    await main(['--daemon', harness.baseUrl, '--token', harness.daemon.producerToken, '--only', 'link-posture', '--json'], {});

    const report = JSON.parse(out.text()) as { ok: boolean; results: Array<{ case: { id: string } }> };
    expect(report.ok).toBe(true);
    expect(report.results.map((result) => result.case.id)).toEqual(['link-posture']);
  });
});
