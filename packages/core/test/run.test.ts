import { describe, it, expect } from 'vitest';
import { ForgeBridgeError, isWithin, Validation } from '@forgebridge/protocol';
import type { Run } from '@forgebridge/protocol';
import { canTransition, assertTransition } from '../src/pipeline.js';
import { ModelRouter, type ModelCandidate } from '../src/router.js';
import type { ProjectPolicy } from '../src/policy.js';
import { executeRun, type RunDeps, type RunEvent, type RunRequest, type RunResult } from '../src/run.js';
import {
  CHANGE_SET_TOOL_NAME,
  changeSetTool,
  operationVocabulary,
  systemPrompt,
} from '../src/prompt.js';
import { ModelClientError, type CompletionEvent, type CompletionResponse, type ModelClient } from '../src/ports/model.js';
import type { AnalysisReport, SandboxPort } from '../src/ports/index.js';
import { createOp, fixedClock, PROJECT_ID, scriptOp, uuid } from './helpers.js';

const RUN_ID = uuid(20);

const FIRST: ModelCandidate = {
  id: 'first/model:free',
  provider: 'alpha',
  contextTokens: 128_000,
  capabilities: ['tools', 'structured_outputs'],
  free: true,
  pricing: { inputPerMTok: 0, outputPerMTok: 0 },
};

const SECOND: ModelCandidate = { ...FIRST, id: 'second/model:free', provider: 'beta' };

const SHOP_ONLY: ProjectPolicy = { allowedPathPrefixes: ['ServerScriptService.Shop'], autoApply: null };

const INSIDE = createOp('ServerScriptService.Shop.Handler');
const OUTSIDE = createOp('Workspace.Baseplate');

/** A model reply, by model id. Anything a handler throws reaches the router. */
type Handler = () => Promise<CompletionResponse>;

function say(text: string, extra: Partial<CompletionResponse> = {}): Handler {
  return async () => ({ text, finishReason: 'stop', ...extra });
}

function reply(operations: unknown[], extra: Record<string, unknown> = {}): Handler {
  return say(JSON.stringify({ summary: 'add a purchase handler', operations, ...extra }));
}

function modelClient(handlers: Record<string, Handler>): ModelClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async complete(request) {
      calls.push(request.model.id);
      const handler = handlers[request.model.id];
      if (!handler) throw new Error(`no reply configured for ${request.model.id}`);
      return await handler();
    },
  };
}

interface HarnessOptions {
  models: ModelClient;
  policy?: ProjectPolicy;
  candidates?: readonly ModelCandidate[];
  routingPolicy?: RunRequest['routingPolicy'];
  pinnedModelId?: string;
  analyser?: SandboxPort['analyse'];
  onEvent?: (event: RunEvent) => void;
}

async function run(options: HarnessOptions): Promise<{ result: RunResult; events: RunEvent[] }> {
  const clock = fixedClock();
  const events: RunEvent[] = [];
  let ids = 700;

  const deps: RunDeps = {
    models: options.models,
    router: new ModelRouter({ clock: clock.now }),
    clock: clock.now,
    newId: () => uuid((ids += 1)),
    computedBy: 'forgebridge-core/test',
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  };
  if (options.analyser) deps.analyser = { analyse: options.analyser };

  const request: RunRequest = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    prompt: 'add a purchase handler to the shop',
    baseVersion: 4,
    policy: options.policy ?? SHOP_ONLY,
    routingPolicy: options.routingPolicy ?? 'free-first',
    candidates: options.candidates ?? [FIRST, SECOND],
  };
  if (options.pinnedModelId) request.pinnedModelId = options.pinnedModelId;

  return { result: await executeRun(request, deps), events };
}

function stagesOf(events: RunEvent[]): Run['stage'][] {
  return events.flatMap((event) => (event.type === 'stage' ? [event.stage] : []));
}

describe('a clean run', () => {
  it('stops at awaiting-approval with a validated ChangeSet and one recorded attempt', async () => {
    const { result } = await run({ models: modelClient({ [FIRST.id]: reply([INSIDE]) }) });

    expect(result.failure).toBeUndefined();
    expect(result.run.stage).toBe('awaiting-approval');
    // Not `succeeded`: the run is waiting for a person, and a run marked
    // finished here would claim work nobody did.
    expect(result.run.status).toBe('running');
    expect(result.run.finishedAt).toBeNull();

    expect(result.changeSet?.status).toBe('validated');
    expect(result.changeSet?.baseVersion).toBe(4);
    expect(result.changeSet?.runId).toBe(RUN_ID);
    expect(result.run.changeSetIds).toEqual([result.changeSet?.id]);

    expect(result.run.attempts).toHaveLength(1);
    expect(result.run.attempts[0]).toMatchObject({ modelId: FIRST.id, providerSlug: 'alpha', outcome: 'ok' });
  });

  it('never reaches an applying stage, whatever the policy says', async () => {
    const { events } = await run({ models: modelClient({ [FIRST.id]: reply([INSIDE]) }) });
    expect(stagesOf(events)).toEqual(['planning', 'generating', 'validating', 'awaiting-approval']);
  });

  it('streams the plan before any model is called, and the attempt log after', async () => {
    const seen: RunEvent['type'][] = [];
    const { result } = await run({
      models: modelClient({ [FIRST.id]: reply([INSIDE]) }),
      onEvent: (event) => seen.push(event.type),
    });

    expect(seen.indexOf('plan')).toBeLessThan(seen.indexOf('model-attempt-started'));
    expect(seen).toContain('model-attempt');
    expect(seen).toContain('validation');
    expect(seen).toContain('change-set');
    expect(result.plan.steps.join('\n')).toContain(FIRST.id);
    expect(result.plan.steps.join('\n')).toContain('tree version 4');
  });

  it('survives an event sink that throws', async () => {
    const { result } = await run({
      models: modelClient({ [FIRST.id]: reply([INSIDE]) }),
      onEvent: () => {
        throw new Error('the observer exploded');
      },
    });
    expect(result.run.stage).toBe('awaiting-approval');
  });
});

describe('fallback', () => {
  it('records both the rate-limited model and the one that worked, in order', async () => {
    const models = modelClient({
      [FIRST.id]: async () => {
        throw new ModelClientError('rate-limited', '429 from alpha', { retryAfterMs: 5_000 });
      },
      [SECOND.id]: reply([INSIDE]),
    });

    const { result } = await run({ models });

    expect(models.calls).toEqual([FIRST.id, SECOND.id]);
    expect(result.run.attempts.map((attempt) => [attempt.modelId, attempt.outcome])).toEqual([
      [FIRST.id, 'rate-limited'],
      [SECOND.id, 'ok'],
    ]);
    expect(result.run.attempts[0]?.note).toContain('429 from alpha');
    expect(result.run.stage).toBe('awaiting-approval');
  });

  it('classifies an unrecognised throw as provider-error rather than guessing', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: async () => {
          throw new Error('socket hang up');
        },
        [SECOND.id]: reply([INSIDE]),
      }),
    });
    expect(result.run.attempts[0]?.outcome).toBe('provider-error');
  });

  it('records a refusal without blaming the provider for it', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: say('I will not do that', { finishReason: 'refusal' }),
        [SECOND.id]: reply([INSIDE]),
      }),
    });
    expect(result.run.attempts[0]?.outcome).toBe('refused');
    expect(result.run.attempts[1]?.outcome).toBe('ok');
  });

  it('reports the usage of an attempt that failed as well as one that worked', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: say('{ not json', { usage: { promptTokens: 900, completionTokens: 3, costUsd: 0 } }),
        [SECOND.id]: reply([INSIDE]),
      }),
    });
    expect(result.run.attempts[0]).toMatchObject({
      outcome: 'invalid-output',
      promptTokens: 900,
      completionTokens: 3,
      costUsd: 0,
    });
  });
});

describe('pinned', () => {
  it('refuses to fall back, and fails with the one attempt it made', async () => {
    const models = modelClient({
      [FIRST.id]: async () => {
        throw new ModelClientError('rate-limited', '429 from alpha');
      },
      [SECOND.id]: reply([INSIDE]),
    });

    const { result } = await run({ models, routingPolicy: 'pinned', pinnedModelId: FIRST.id });

    expect(models.calls).toEqual([FIRST.id]);
    expect(result.run.attempts).toHaveLength(1);
    expect(result.run.stage).toBe('failed');
    expect(result.failure?.code).toBe('rate_limited');
    expect(result.plan.steps[0]).toContain('no fallback');
  });

  it('does not silently substitute when the pinned model is malformed either', async () => {
    const models = modelClient({
      [FIRST.id]: say('not a ChangeSet at all'),
      [SECOND.id]: reply([INSIDE]),
    });
    const { result } = await run({ models, routingPolicy: 'pinned', pinnedModelId: FIRST.id });

    expect(models.calls).toEqual([FIRST.id]);
    expect(result.run.attempts.map((attempt) => attempt.outcome)).toEqual(['invalid-output']);
    expect(result.changeSet).toBeUndefined();
  });
});

describe('malformed output', () => {
  it('is an invalid-output attempt, not a crash, and the router moves on', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: reply([{ op: 'setProperty', path: 'ServerScriptService.Shop', property: 'Parent', value: { t: 'Nil' } }]),
        [SECOND.id]: reply([INSIDE]),
      }),
    });

    expect(result.run.attempts.map((attempt) => attempt.outcome)).toEqual(['invalid-output', 'ok']);
    // The note names what the protocol refused, so a run log can explain itself.
    expect(result.run.attempts[0]?.note).toContain('moveInstance');
    expect(result.run.stage).toBe('awaiting-approval');
  });

  it('never repairs a model’s JSON into something that parses', async () => {
    const { result } = await run({
      models: modelClient({
        // A path with a separator smuggled into a name — refused, not rewritten.
        [FIRST.id]: reply([createOp('ServerScriptService.Shop.Handler-1')]),
        [SECOND.id]: reply([INSIDE]),
      }),
    });
    expect(result.run.attempts[0]?.outcome).toBe('invalid-output');
    expect(result.changeSet?.operations).toEqual([expect.objectContaining({ path: 'ServerScriptService.Shop.Handler' })]);
  });

  it('reports an empty response and a wrong envelope distinctly', async () => {
    const empty = await run({
      models: modelClient({ [FIRST.id]: say('   '), [SECOND.id]: reply([INSIDE]) }),
    });
    expect(empty.result.run.attempts[0]?.note).toContain('no content');

    const wrong = await run({
      models: modelClient({ [FIRST.id]: say('[]'), [SECOND.id]: reply([INSIDE]) }),
    });
    expect(wrong.result.run.attempts[0]?.note).toContain('an array');
  });

  it('says when a truncated response is why the JSON did not parse', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: say('{"summary":"half a', { finishReason: 'length' }),
        [SECOND.id]: reply([INSIDE]),
      }),
    });
    expect(result.run.attempts[0]?.note).toContain('output limit');
  });

  it('fails the run when every model produced something unusable', async () => {
    const { result } = await run({
      models: modelClient({ [FIRST.id]: say('nope'), [SECOND.id]: say('also nope') }),
    });
    expect(result.run.attempts.map((attempt) => attempt.outcome)).toEqual(['invalid-output', 'invalid-output']);
    expect(result.run.stage).toBe('failed');
    expect(result.run.status).toBe('failed');
    expect(result.failure?.code).toBe('provider_unconfigured');
  });
});

describe('envelopes the core will read', () => {
  it('reads a tool call by name', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: say('', {
          finishReason: 'tool-calls',
          toolCalls: [
            { name: 'something_else', arguments: '{}' },
            { name: CHANGE_SET_TOOL_NAME, arguments: JSON.stringify({ summary: 'from a tool call', operations: [INSIDE] }) },
          ],
        }),
      }),
    });
    expect(result.changeSet?.summary).toBe('from a tool call');
  });

  it('unwraps a fenced block without editing what is inside it', async () => {
    const { result } = await run({
      models: modelClient({
        [FIRST.id]: say('```json\n{"summary":"fenced","operations":[' + JSON.stringify(INSIDE) + ']}\n```'),
      }),
    });
    expect(result.changeSet?.summary).toBe('fenced');
  });

  it('prefers a stream when the adapter has one, and refuses a stream with no final response', async () => {
    const deltas: string[] = [];
    const complete = JSON.stringify({ summary: 'streamed', operations: [INSIDE] });

    const streaming: ModelClient = {
      complete: async () => {
        throw new Error('complete() must not be called when stream() exists');
      },
      async *stream(): AsyncGenerator<CompletionEvent> {
        yield { type: 'text', delta: complete.slice(0, 10) };
        yield { type: 'text', delta: complete.slice(10) };
        yield { type: 'done', response: { text: complete, finishReason: 'stop' } };
      },
    };

    const streamed = await run({
      models: streaming,
      candidates: [FIRST],
      onEvent: (event) => {
        if (event.type === 'output-delta') deltas.push(event.delta);
      },
    });
    expect(streamed.result.changeSet?.summary).toBe('streamed');
    expect(deltas.join('')).toBe(complete);

    const truncated: ModelClient = {
      complete: async () => ({ text: '', finishReason: 'stop' }),
      async *stream(): AsyncGenerator<CompletionEvent> {
        yield { type: 'text', delta: 'half' };
      },
    };
    const cut = await run({ models: truncated, candidates: [FIRST] });
    expect(cut.result.run.attempts[0]?.outcome).toBe('invalid-output');
  });
});

describe('validation is the core’s, never the model’s', () => {
  it('discards a model-authored verdict and recomputes it', async () => {
    const modelVerdict = {
      luau: { status: 'ok', findings: [] },
      policy: { status: 'ok', violations: [] },
      computedAt: '2020-01-01T00:00:00.000Z',
      computedBy: 'the model itself',
    };

    const { result } = await run({
      models: modelClient({
        [FIRST.id]: reply([scriptOp('ServerScriptService.Shop.Handler')], { validation: modelVerdict, status: 'approved', id: uuid(4242) }),
      }),
    });

    const validation = result.changeSet?.validation;
    expect(validation?.computedBy).toBe('forgebridge-core/test');
    expect(validation?.computedAt).not.toBe(modelVerdict.computedAt);
    // No analyser is configured, so the honest verdict is `warn` — not the `ok`
    // the model claimed for itself.
    expect(validation?.luau.status).toBe('warn');
    expect(validation?.luau.findings[0]?.rule).toBe('core/luau-analysis-unavailable');
    // The envelope fields the model tried to set are the core's, too.
    expect(result.changeSet?.status).toBe('validated');
    expect(result.changeSet?.id).not.toBe(uuid(4242));
    expect(Validation.safeParse(validation).success).toBe(true);
  });

  it('reports `ok` for a set with no scripts even without an analyser', async () => {
    const { result } = await run({ models: modelClient({ [FIRST.id]: reply([INSIDE]) }) });
    expect(result.changeSet?.validation?.luau).toEqual({ status: 'ok', findings: [] });
  });

  it('fails the run on a Luau verdict of fail, without showing an approver a doomed set', async () => {
    const report: AnalysisReport = {
      status: 'fail',
      findings: [{ severity: 'error', rule: 'luau/no-loadstring', message: 'loadstring is not allowed' }],
      truncated: false,
    };
    const { result, events } = await run({
      models: modelClient({ [FIRST.id]: reply([scriptOp('ServerScriptService.Shop.Handler')]) }),
      analyser: async () => report,
    });

    expect(result.run.stage).toBe('failed');
    expect(result.failure?.code).toBe('invalid_request');
    expect(result.failure?.remedy).toContain('luau/no-loadstring');
    expect(result.changeSet?.status).toBe('rejected');
    expect(stagesOf(events)).not.toContain('awaiting-approval');
  });
});

describe('policy', () => {
  it('fails a ChangeSet that reaches outside the allowed prefixes', async () => {
    const { result } = await run({
      models: modelClient({ [FIRST.id]: reply([INSIDE, OUTSIDE]) }),
    });

    expect(result.run.stage).toBe('failed');
    expect(result.failure?.code).toBe('policy_violation');
    expect(result.decision?.policy.status).toBe('fail');
    expect(result.decision?.policy.violations[0]).toContain('Workspace.Baseplate');
    // The set is returned so a caller can show what was refused and why.
    expect(result.changeSet?.status).toBe('rejected');
    expect(result.changeSet?.validation?.policy.status).toBe('fail');
  });

  it('is not a routing failure: the model that wrote it still succeeded', async () => {
    const models = modelClient({ [FIRST.id]: reply([OUTSIDE]), [SECOND.id]: reply([INSIDE]) });
    const { result } = await run({ models });

    // Falling back here would be shopping for a model that agrees with us; the
    // policy is the project's answer, not this model's mistake to retry.
    expect(models.calls).toEqual([FIRST.id]);
    expect(result.run.attempts.map((attempt) => attempt.outcome)).toEqual(['ok']);
  });

  it('permits nothing when the project has no policy at all', async () => {
    const { result } = await run({
      models: modelClient({ [FIRST.id]: reply([INSIDE]) }),
      policy: { allowedPathPrefixes: [], autoApply: null },
    });
    expect(result.failure?.code).toBe('policy_violation');
    expect(result.decision?.policy.violations[0]).toContain('no usable path policy');
  });
});

describe('cancellation', () => {
  it('is recorded as cancelled, not as a model that failed', async () => {
    const controller = new AbortController();
    const clock = fixedClock();
    const events: RunEvent[] = [];
    let ids = 800;

    const result = await executeRun(
      {
        runId: RUN_ID,
        projectId: PROJECT_ID,
        prompt: 'add a purchase handler',
        baseVersion: 4,
        policy: SHOP_ONLY,
        routingPolicy: 'free-first',
        candidates: [FIRST, SECOND],
        signal: controller.signal,
      },
      {
        models: modelClient({
          [FIRST.id]: async () => {
            controller.abort();
            throw new ModelClientError('cancelled', 'the caller aborted');
          },
        }),
        router: new ModelRouter({ clock: clock.now }),
        clock: clock.now,
        newId: () => uuid((ids += 1)),
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.run.stage).toBe('cancelled');
    expect(result.run.status).toBe('cancelled');
    expect(result.run.attempts.map((attempt) => attempt.outcome)).toEqual(['cancelled']);
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.some((event) => event.type === 'failed')).toBe(false);
  });
});

describe('stage transitions', () => {
  it('only ever emits legal edges, on every path a run can take', async () => {
    const clean = await run({ models: modelClient({ [FIRST.id]: reply([INSIDE]) }) });
    const refused = await run({ models: modelClient({ [FIRST.id]: reply([OUTSIDE]) }) });
    const nothing = await run({ models: modelClient({ [FIRST.id]: say('nope'), [SECOND.id]: say('nope') }) });

    for (const { events } of [clean, refused, nothing]) {
      const stages: Run['stage'][] = ['queued', ...stagesOf(events)];
      for (let i = 0; i < stages.length - 1; i += 1) {
        expect(canTransition(stages[i]!, stages[i + 1]!)).toBe(true);
      }
    }
  });

  it('refuses a transition that would skip the human gate', () => {
    expect(() => assertTransition('generating', 'awaiting-approval')).toThrow(ForgeBridgeError);
    expect(() => assertTransition('validating', 'done')).toThrow(/illegal run transition/);
    expect(() => assertTransition('awaiting-approval', 'generating')).toThrow(ForgeBridgeError);
  });
});

describe('the prompt', () => {
  const context = { prompt: 'add a shop', allowedPathPrefixes: ['ServerScriptService.Shop'], baseVersion: 4 };

  it('lists exactly the operations the parser accepts', () => {
    const vocabulary = operationVocabulary();
    // Written as the object the parser actually reads, `op` field and all.
    // A heading like `createInstance { … }` was read by three of the four
    // models in the first live run as "key the object by the operation name",
    // and every one of those sets was refused on the discriminator.
    expect(vocabulary).toEqual([
      '{"op":"createInstance", path, className, properties?}',
      '{"op":"setProperty", path, property, value}',
      '{"op":"writeScript", path, scriptType, source}',
      '{"op":"moveInstance", path, to}',
      '{"op":"deleteInstance", path}',
    ]);
    const text = systemPrompt(context);
    for (const line of vocabulary) expect(text).toContain(line);
  });

  it('names this project’s allowed prefixes, and says an outside path is refused whole', () => {
    const text = systemPrompt(context);
    expect(text).toContain('ServerScriptService.Shop');
    expect(text).toContain('not trimmed to fit');
    // Every path the prompt shows as an example is one this project accepts.
    for (const [, path] of text.matchAll(/"path":"([^"]+)"/g)) {
      expect(isWithin(path, 'ServerScriptService.Shop')).toBe(true);
    }
    expect(systemPrompt({ ...context, allowedPathPrefixes: [] })).toContain('no allowed path prefixes');
  });

  it('refuses Parent and Name on setProperty, and points at moveInstance', () => {
    const text = systemPrompt(context);
    expect(text).toMatch(/setProperty may not write Parent or Name/);
    expect(text).toContain('moveInstance');
  });

  it('tells the model its verdict will be discarded, and offers the tool by name', () => {
    expect(systemPrompt(context)).toContain('validation verdict');
    expect(changeSetTool(context).name).toBe(CHANGE_SET_TOOL_NAME);
  });
});
