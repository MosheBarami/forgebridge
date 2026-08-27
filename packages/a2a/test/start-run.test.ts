import { describe, expect, it } from 'vitest';
import { SkillExecutor } from '../src/executor.js';
import { DENY_ALL_APPROVALS } from '../src/approval.js';
import { FORGEBRIDGE_SKILLS, SKILL_IDS, StartRunInput, WRITING_SKILLS, parseInvocation } from '../src/skills.js';
import { TaskStore } from '../src/tasks.js';
import type { Task } from '../src/spec.js';
import { FakeBackend, invocationMessage } from './helpers.js';

/**
 * The `start-run` skill.
 *
 * A run is a *read* as far as the user's place is concerned: it produces a
 * ChangeSet in `validated` and writes nothing. So it is not a writing skill and
 * needs no approval grant — and the tests below are what keep that from being
 * mistaken for "a run is unguarded". The guard is on the other side: nothing a
 * run produces reaches Studio until `apply-approved-changeset` finds a grant it
 * cannot issue for itself (ADR-012).
 */

function executorWith(backend: FakeBackend): { executor: SkillExecutor; tasks: TaskStore } {
  const tasks = new TaskStore();
  return { executor: new SkillExecutor({ backend, gate: DENY_ALL_APPROVALS, tasks }), tasks };
}

async function runSkill(backend: FakeBackend, input: unknown): Promise<Task> {
  const { executor, tasks } = executorWith(backend);
  const message = invocationMessage('start-run', input);
  const record = tasks.create(undefined, message);
  await executor.execute(record.id, parseInvocation(message));
  return tasks.snapshot(record);
}

describe('the start-run skill', () => {
  it('is advertised on the card, with the boundary in its description', () => {
    const skill = FORGEBRIDGE_SKILLS.find((entry) => entry.id === 'start-run');
    expect(skill).toBeDefined();
    expect(SKILL_IDS).toContain('start-run');
    expect(skill?.description).toContain('Nothing is written to the place');
    expect(skill?.description).toContain('approving it is an act this caller cannot perform');
    // The instruction that stops a calling agent taking credit for the model's
    // work, or naming the wrong model as its author.
    expect(skill?.description).toContain('complete list of models the router tried');
  });

  it('is not a writing skill, because a run writes nothing to the place', () => {
    expect(WRITING_SKILLS.has('start-run')).toBe(false);
  });

  it('completes with an artifact carrying every attempt, in order', async () => {
    const backend = new FakeBackend();
    const task = await runSkill(backend, { prompt: 'add a respawn handler' });

    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    const payload = task.artifacts?.[0]?.parts.find((part) => 'data' in part)?.data as {
      run: { attempts: { modelId: string; outcome: string }[] };
      changeSetStatus: string;
    };
    expect(payload.run.attempts.map((attempt) => [attempt.modelId, attempt.outcome])).toEqual([
      ['glm-5.2:free', 'rate-limited'],
      ['minimax-m3:free', 'ok'],
    ]);
    // The set is proposed, never approved: a run stops at the human gate.
    expect(payload.changeSetStatus).toBe('validated');
  });

  it('says which models were tried in the one line an orchestrator reads', async () => {
    const backend = new FakeBackend();
    const task = await runSkill(backend, { prompt: 'add a respawn handler' });

    const summary = task.status.message?.parts[0]?.text ?? '';
    // The protocol's own renderer, so every ForgeBridge surface says this the
    // same way.
    expect(summary).toContain('glm-5.2:free → rate-limited → minimax-m3:free');
    expect(summary).toContain('this caller cannot approve it');
  });

  it('never reaches approve, whatever it is asked for', async () => {
    const backend = new FakeBackend();
    await runSkill(backend, { prompt: 'add a respawn handler' });

    expect(backend.calls.map((call) => call.method)).toEqual(['startRun']);
  });

  it('refuses an input that describes something the run request has no field for', () => {
    // `.strict()`, and the strictness is the point: an unknown key on a run
    // request is a caller trying to describe an approval, an apply, or a
    // producer it is not — and the right answer is a loud refusal, not a
    // silently dropped field.
    expect(StartRunInput.safeParse({ prompt: 'p', approve: true }).success).toBe(false);
    expect(StartRunInput.safeParse({ prompt: 'p', producer: { kind: 'web' } }).success).toBe(false);
    expect(StartRunInput.safeParse({ prompt: 'p', stream: true }).success).toBe(false);
    expect(StartRunInput.safeParse({ prompt: 'p' }).success).toBe(true);
  });

  it('refuses a prompt the protocol would not store', () => {
    expect(StartRunInput.safeParse({ prompt: '' }).success).toBe(false);
  });
});
