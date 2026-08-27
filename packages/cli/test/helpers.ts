import { randomUUID } from 'node:crypto';
import type { ChangeSetDiff, LinkStatusResponse, ModelsSnapshot, RunResponse } from '@forgebridge/daemon';
import type { Io } from '../src/index.js';
import type { Deps } from '../src/commands/context.js';
import type { Transport } from '../src/client.js';

/** An `Io` that keeps the two streams apart, because which one a line lands on is load-bearing. */
export interface CapturedIo extends Io {
  stdout: string[];
  stderr: string[];
  outText(): string;
  errText(): string;
}

export function captureIo(colour = false): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    colour,
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    outText: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
  };
}

export function linkStatusFixture(overrides: Partial<LinkStatusResponse> = {}): LinkStatusResponse {
  return {
    transport: 'local-daemon',
    privacyPosture: 'Local — nothing leaves this machine',
    protocolVersion: '1.0.0',
    defaultProjectId: randomUUID(),
    links: [],
    pairing: null,
    ...overrides,
  };
}

export function diffFixture(overrides: Partial<ChangeSetDiff> = {}): ChangeSetDiff {
  return {
    changeSetId: randomUUID(),
    projectId: randomUUID(),
    summary: 'add a shop handler',
    status: 'validated',
    baseVersion: 3,
    currentVersion: 3,
    stale: false,
    counts: { total: 1, creates: 1, setProperties: 0, scripts: 0, moves: 0, deletes: 0 },
    // What an approver echoes back on approve. The daemon renders it on every
    // diff, so a fixture without one is a diff no daemon would ever serve.
    contentDigest: 'sha256:the-digest-this-diff-reported',
    operations: [
      {
        index: 0,
        op: 'createInstance',
        paths: ['ServerScriptService.Shop'],
        summary: 'create Folder at ServerScriptService.Shop',
        destructive: false,
      },
    ],
    treeAware: false,
    ...overrides,
  };
}

/**
 * A run that fell back once and ended at the human gate.
 *
 * Two attempts rather than one, deliberately: a fixture whose run only ever
 * tried the model that worked would let a renderer that prints the last attempt
 * pass every assertion about the attempt log (ADR-008).
 */
export function runResponseFixture(overrides: Partial<RunResponse> = {}): RunResponse {
  const changeSetId = randomUUID();
  return {
    run: {
      id: randomUUID(),
      projectId: randomUUID(),
      prompt: 'build a shop',
      stage: 'awaiting-approval',
      status: 'running',
      attempts: [
        {
          modelId: 'glm-5.2:free',
          outcome: 'rate-limited',
          startedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 1200,
          note: 'the provider answered 429',
        },
        {
          modelId: 'minimax-m3:free',
          outcome: 'ok',
          startedAt: '2026-01-01T00:00:02.000Z',
          durationMs: 4800,
          promptTokens: 812,
          completionTokens: 640,
          costUsd: 0,
        },
      ],
      changeSetIds: [changeSetId],
      producer: { kind: 'cli' },
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
    },
    plan: { steps: ['write one script under ServerScriptService.Shop'] },
    changeSetId,
    changeSetStatus: 'validated',
    contentDigest: 'sha256:the-digest-this-run-reported',
    validation: {
      luau: { status: 'ok', findings: [] },
      policy: { status: 'ok', violations: [] },
      computedAt: '2026-01-01T00:00:07.000Z',
      computedBy: 'forgebridge-daemon@0.1.0',
    },
    skipped: [],
    ordering: {
      policy: 'free-first',
      candidatesConsidered: 6,
      candidatesEligible: 2,
      order: ['glm-5.2:free', 'minimax-m3:free'],
    },
    failure: null,
    ...overrides,
  };
}

export function modelsFixture(overrides: Partial<ModelsSnapshot> = {}): ModelsSnapshot {
  return {
    configured: true,
    source: 'test-registry',
    verifiedAt: new Date().toISOString(),
    models: [],
    ...overrides,
  };
}

/**
 * A transport that answers from fixtures and records what was asked of it.
 *
 * Every method defaults to throwing: a command reaching for something the test
 * did not arrange should fail loudly rather than receive `undefined` and carry
 * on. That is what makes "apply called nothing that could approve" a real
 * assertion rather than a hope.
 */
export function stubTransport(handlers: Partial<Transport> = {}): Transport & { calls: string[] } {
  const calls: string[] = [];
  const refuse = (name: string) => (): never => {
    throw new Error(`stub transport: ${name} was called but not arranged`);
  };
  return {
    calls,
    health: async (...args) => (calls.push('health'), (handlers.health ?? refuse('health'))(...args)),
    linkStatus: async (...args) => (calls.push('linkStatus'), (handlers.linkStatus ?? refuse('linkStatus'))(...args)),
    models: async (...args) => (calls.push('models'), (handlers.models ?? refuse('models'))(...args)),
    diff: async (...args) => (calls.push(`diff:${args[0]}`), (handlers.diff ?? refuse('diff'))(...args)),
    rollback: async (...args) => (calls.push('rollback'), (handlers.rollback ?? refuse('rollback'))(...args)),
    startRun: async (...args) => (calls.push('startRun'), (handlers.startRun ?? refuse('startRun'))(...args)),
  };
}

/** Deps with an instant clock and a no-op sleep, so poll loops do not really wait. */
export function testDeps(io: CapturedIo, transport: Transport, overrides: Partial<Deps> = {}): Deps {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    io,
    createTransport: () => transport,
    now: () => clock,
    // Advancing the clock by exactly what was slept keeps a timeout loop
    // terminating in a test without any real elapsed time.
    sleep: async (ms) => {
      clock += ms;
    },
    ...overrides,
  };
}
