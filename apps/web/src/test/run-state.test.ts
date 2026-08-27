import { describe, expect, it } from 'vitest';
import type { ModelAttempt } from '@forgebridge/protocol';

import { classifyFrame } from '@/app/[locale]/generate/run-frames';
import { attemptLine, initialRunView, reduceRun, type RunView } from '@/app/[locale]/generate/run-state';

/**
 * The run reducer, pinned against ADR-008.
 *
 * The claim these tests protect: **every model the router tried is visible, and
 * the list never shrinks.** A run log that quietly dropped an attempt would be
 * a silent substitution arriving one second late, which is precisely what the
 * ADR is written against.
 */

function attempt(modelId: string, outcome: ModelAttempt['outcome']): ModelAttempt {
  return {
    modelId,
    outcome,
    startedAt: '2026-08-27T10:00:00.000Z',
    durationMs: 1200,
  };
}

/** Feed a list of raw stream payloads through the classifier and the reducer. */
function fold(payloads: unknown[]): RunView {
  return payloads.reduce<RunView>((view, payload) => reduceRun(view, classifyFrame(payload)), initialRunView());
}

describe('the fallback chain is complete and append-only', () => {
  it('records every attempt in order, including the ones that failed', () => {
    const view = fold([
      { type: 'model-attempt-started', at: 'x', modelId: 'z-ai/glm-5.2:free', provider: 'openrouter', attemptIndex: 0 },
      { type: 'model-attempt', at: 'x', attempt: attempt('z-ai/glm-5.2:free', 'rate-limited') },
      { type: 'model-attempt-started', at: 'x', modelId: 'minimax/minimax-m3:free', provider: 'openrouter', attemptIndex: 1 },
      { type: 'model-attempt', at: 'x', attempt: attempt('minimax/minimax-m3:free', 'ok') },
    ]);

    expect(view.attempts.map((a) => a.modelId)).toEqual([
      'z-ai/glm-5.2:free',
      'minimax/minimax-m3:free',
    ]);
    // The shape the brief names, rendered by the protocol's own `attemptSummary`.
    expect(attemptLine(view)).toBe('z-ai/glm-5.2:free → rate-limited → minimax/minimax-m3:free');
  });

  it('shows the in-flight model on the collapsed line so a live run does not look stalled', () => {
    const view = fold([
      { type: 'model-attempt', at: 'x', attempt: attempt('a:free', 'rate-limited') },
      { type: 'model-attempt-started', at: 'x', modelId: 'b:free', provider: 'openrouter', attemptIndex: 1 },
    ]);

    expect(view.inFlight?.modelId).toBe('b:free');
    expect(attemptLine(view)).toBe('a:free → rate-limited → b:free');
  });

  it('clears the in-flight model when its attempt lands', () => {
    const view = fold([
      { type: 'model-attempt-started', at: 'x', modelId: 'a:free', provider: 'openrouter', attemptIndex: 0 },
      { type: 'model-attempt', at: 'x', attempt: attempt('a:free', 'ok') },
    ]);

    expect(view.inFlight).toBeNull();
  });

  it('never lets the final run frame shrink the streamed attempt list', () => {
    // The guard that matters: a settled response carrying fewer attempts than
    // were streamed would make the log lose a model the router really tried.
    const streamed = fold([
      { type: 'model-attempt', at: 'x', attempt: attempt('a:free', 'rate-limited') },
      { type: 'model-attempt', at: 'x', attempt: attempt('b:free', 'ok') },
    ]);

    const settled = reduceRun(
      streamed,
      classifyFrame({
        run: {
          id: '11111111-1111-4111-8111-111111111111',
          projectId: '22222222-2222-4222-8222-222222222222',
          prompt: 'p',
          stage: 'done',
          status: 'succeeded',
          // Deliberately short — one attempt, where two were streamed.
          attempts: [attempt('b:free', 'ok')],
          changeSetIds: [],
          startedAt: '2026-08-27T10:00:00.000Z',
          finishedAt: '2026-08-27T10:00:05.000Z',
        },
        plan: { steps: ['one'] },
        changeSetId: null,
        changeSetStatus: null,
        contentDigest: null,
        validation: null,
        skipped: [],
        ordering: null,
        failure: null,
      }),
    );

    expect(settled.attempts.map((a) => a.modelId)).toEqual(['a:free', 'b:free']);
    expect(settled.finished).toBe(true);
  });
});

describe('skipped candidates are kept apart from attempts', () => {
  it('does not fold a never-tried model into the fallback chain', () => {
    // A skipped candidate was never called. Putting it in `attempts` would be a
    // `ModelAttempt` describing something that did not happen.
    const view = fold([
      {
        type: 'model-skipped',
        at: 'x',
        skipped: { modelId: 'c:free', provider: 'openrouter', reason: 'circuit-open', detail: 'breaker open' },
      },
      { type: 'model-attempt', at: 'x', attempt: attempt('a:free', 'ok') },
    ]);

    expect(view.skipped.map((s) => s.modelId)).toEqual(['c:free']);
    expect(view.attempts.map((a) => a.modelId)).toEqual(['a:free']);
    expect(attemptLine(view)).toBe('a:free');
  });
});

describe('the run id and the plan', () => {
  it('takes the run id from the first run frame, which is the only place it arrives', () => {
    const view = fold([
      {
        run: {
          id: '33333333-3333-4333-8333-333333333333',
          projectId: '22222222-2222-4222-8222-222222222222',
          prompt: 'p',
          stage: 'queued',
          status: 'running',
          attempts: [],
          changeSetIds: [],
          startedAt: '2026-08-27T10:00:00.000Z',
          finishedAt: null,
        },
        plan: { steps: [] },
        changeSetId: null,
        changeSetStatus: null,
        contentDigest: null,
        validation: null,
        skipped: [],
        ordering: null,
        failure: null,
      },
      { type: 'plan', at: 'x', plan: { steps: ['read the prompt', 'write a script'] } },
    ]);

    expect(view.runId).toBe('33333333-3333-4333-8333-333333333333');
    expect(view.finished).toBe(false);
    expect(view.plan).toEqual(['read the prompt', 'write a script']);
  });
});

describe('frames this build does not understand', () => {
  it('counts an unmodelled event type instead of dropping it silently', () => {
    const view = fold([{ type: 'some-future-event', at: 'x', payload: 1 }]);

    expect(view.unrecognised).toHaveLength(1);
    expect(view.unrecognised[0]?.type).toBe('some-future-event');
    // The attempt list is untouched — an unknown frame is not an attempt.
    expect(view.attempts).toEqual([]);
  });

  it('classifies a bare protocol error as a refusal and ends the run', () => {
    const view = fold([
      { code: 'provider_unconfigured', message: 'no model client is wired in' },
    ]);

    expect(view.failure?.code).toBe('provider_unconfigured');
    expect(view.finished).toBe(true);
    expect(view.runId).toBeNull();
  });

  it('rejects a malformed model-attempt rather than putting undefined in the chain', () => {
    // A cast would have produced `undefined → rate-limited` on the collapsed
    // line, which is the ADR-008 failure reached from the other direction.
    const view = fold([{ type: 'model-attempt', at: 'x', attempt: { outcome: 'ok' } }]);

    expect(view.attempts).toEqual([]);
    expect(view.unrecognised).toHaveLength(1);
  });
});

describe('terminal frames', () => {
  it('records a cancellation as cancelled, which is not a failure', () => {
    const view = fold([{ type: 'cancelled', at: 'x', reason: 'the caller hung up' }]);

    expect(view.status).toBe('cancelled');
    expect(view.failure).toBeNull();
    expect(view.cancelledReason).toBe('the caller hung up');
  });

  it('carries a failure’s remedy through', () => {
    const view = fold([
      {
        type: 'failed',
        at: 'x',
        failure: { code: 'policy_violation', message: 'outside the allowed paths', remedy: 'widen the policy' },
      },
    ]);

    expect(view.failure?.remedy).toBe('widen the policy');
    expect(view.status).toBe('failed');
  });
});

describe('an empty run', () => {
  it('says no model was attempted rather than rendering an empty chain', () => {
    expect(attemptLine(initialRunView())).toBe('no model attempted');
  });
});
