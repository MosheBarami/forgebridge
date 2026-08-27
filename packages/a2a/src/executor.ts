import { randomUUID } from 'node:crypto';
import { attemptSummary, type ModelAttempt } from '@forgebridge/protocol';
import type { ApprovalGate, ApprovalGrant, GrantFor } from './approval.js';
import type { ForgeBridgeBackend } from './backend.js';
import { renderFailure, type ErrorDetail } from './errors.js';
import { SKILL_INVOCATION_EXTENSION_URI, WRITING_SKILLS, type ParsedInvocation, type SkillId } from './skills.js';
import type { Artifact, Message, Part } from './spec.js';
import type { TaskStore } from './tasks.js';

/**
 * Skill dispatch: one A2A task, one ForgeBridge operation, one artifact.
 *
 * Two rules shape everything here.
 *
 * The first is ADR-009: a connector translates and does not decide. So each
 * branch below is a call and a wrapping, and there is no branch that inspects a
 * ChangeSet, weighs a validation verdict, or chooses a different endpoint
 * because of something in the payload. The daemon decides; this reports.
 *
 * The second is ADR-012, and it is the reason the two writing skills look
 * different from the four reading ones. They begin by asking the approval gate
 * for a grant, and if there is none the task stops at
 * `TASK_STATE_AUTH_REQUIRED` — the specification's own state for "authentication
 * is required to proceed", an interrupted state rather than a failure, because
 * the request was legitimate and is merely waiting on a human. The backend's
 * `approve` and `rollback` methods cannot be called without the grant object,
 * so the refusal is not a check that could be forgotten: it is the only way to
 * reach those functions at all.
 */

export interface ExecutorOptions {
  backend: ForgeBridgeBackend;
  gate: ApprovalGate;
  tasks: TaskStore;
}

export class SkillExecutor {
  readonly #backend: ForgeBridgeBackend;
  readonly #gate: ApprovalGate;
  readonly #tasks: TaskStore;

  constructor(options: ExecutorOptions) {
    this.#backend = options.backend;
    this.#gate = options.gate;
    this.#tasks = options.tasks;
  }

  /**
   * Run one invocation against a task that is `SUBMITTED` or `AUTH_REQUIRED`.
   *
   * Never throws for an execution failure: a failure is a task state, not an
   * exception (see `errors.ts`). It throws only if the task store refuses a
   * transition, which is a bug in this connector rather than a run outcome.
   */
  async execute(taskId: string, invocation: ParsedInvocation): Promise<void> {
    this.#tasks.transition(taskId, 'TASK_STATE_WORKING', agentMessage(taskId, `running ${invocation.skill}`));

    try {
      const outcome = await this.#dispatch(invocation);
      if (outcome.kind === 'awaiting-approval') {
        this.#tasks.transition(taskId, 'TASK_STATE_AUTH_REQUIRED', agentMessage(taskId, outcome.summary, [
          dataPart(outcome.detail),
        ]));
        return;
      }
      this.#tasks.addArtifact(taskId, artifactFor(invocation.skill, outcome.payload, outcome.summary));
      this.#tasks.transition(taskId, 'TASK_STATE_COMPLETED', agentMessage(taskId, outcome.summary));
    } catch (error) {
      const failure = renderFailure(error);
      this.#tasks.transition(taskId, failure.state, agentMessage(taskId, failure.summary, [dataPart(failure.detail)]));
    }
  }

  async #dispatch(invocation: ParsedInvocation): Promise<Outcome> {
    switch (invocation.skill) {
      case 'start-run': {
        const result = await this.#backend.startRun(invocation.input);
        const { run } = result;
        // The whole attempt list, collapsed into the one sentence the calling
        // agent is most likely to read. `attemptSummary` is the protocol's own
        // renderer, so every ForgeBridge surface says this the same way — and
        // the artifact beside it carries the attempts in full, because a
        // summary is not a record (ADR-008).
        const models = attemptSummary(run.attempts as ModelAttempt[]);
        return {
          kind: 'done',
          payload: result,
          summary:
            result.changeSetId === null
              ? `Run ${run.id} produced no ChangeSet (stage "${run.stage}", status "${run.status}"). Models tried: ${models}. ` +
                'Nothing was written to the place.'
              : `Run ${run.id} proposed ChangeSet ${result.changeSetId} at status "${result.changeSetStatus ?? 'unknown'}". ` +
                `Models tried: ${models}. Nothing has been written to the place; a human must approve before it can be ` +
                'applied, and this caller cannot approve it.',
        };
      }

      case 'propose-changeset': {
        const result = await this.#backend.propose(invocation.input.changeSet);
        const luau = result.validation.luau.status;
        const policy = result.validation.policy.status;
        return {
          kind: 'done',
          payload: result,
          // The verdict goes in the one-line summary because it is the fact
          // that decides what the calling agent does next, and an agent that
          // only reads the summary should not have to discover from the diff
          // that its set is already unapprovable.
          summary:
            `ChangeSet ${result.changeSetId} accepted at status "${result.status}" against baseVersion ` +
            `${result.baseVersion}. Validation: luau=${luau}, policy=${policy}. Nothing has been written to the ` +
            'place; a human must approve before it can be applied.',
        };
      }

      case 'review-changeset-diff': {
        const diff = await this.#backend.diff(invocation.input.changeSetId);
        return {
          kind: 'done',
          payload: diff,
          summary:
            `ChangeSet ${diff.changeSetId}: ${diff.counts.total} operation(s) — ${diff.counts.creates} create, ` +
            `${diff.counts.setProperties} property, ${diff.counts.scripts} script, ${diff.counts.moves} move, ` +
            `${diff.counts.deletes} delete. Status "${diff.status}", baseVersion ${diff.baseVersion} against ` +
            `current ${diff.currentVersion}${diff.stale ? ' (stale — rebase and resubmit)' : ''}.`,
        };
      }

      case 'apply-approved-changeset': {
        const changeSetId = invocation.input.changeSetId;
        const grant = await this.#requireGrant('apply-approved-changeset', changeSetId);
        if (!grant) return awaitingApproval('apply-approved-changeset', changeSetId);
        const result = await this.#backend.approve(grant);
        return {
          kind: 'done',
          payload: result,
          summary:
            `ChangeSet ${result.changeSetId} is approved and queued for the paired Studio session ` +
            `(delivery nonce ${result.nonce}). The plugin applies it and reports the outcome; this task does not ` +
            'wait for that report.',
        };
      }

      case 'rollback-apply': {
        const { journalId, expectedVersion, reason } = invocation.input;
        const grant = await this.#requireGrant('rollback-apply', journalId);
        if (!grant) return awaitingApproval('rollback-apply', journalId);
        const result = await this.#backend.rollback(grant, {
          journalId,
          expectedVersion,
          ...(reason ? { reason } : {}),
        });
        return {
          kind: 'done',
          payload: result,
          // "dispatched", not "rolled back", and still not. The plugin replays
          // the inverses after it polls, so at the moment this answers nothing
          // has been reversed and reporting otherwise would be the connector
          // inventing a fact. What changed with M11 is that the outcome is
          // reportable at all, so the summary names the skill that reports it
          // rather than leaving the caller with no next step.
          summary:
            `Rollback of journal ${result.journalId} (ChangeSet ${result.changeSetId}) was dispatched to the paired ` +
            `Studio session at delivery nonce ${result.nonce}` +
            `${result.steps === undefined ? '' : `, carrying ${result.steps} inverse operation(s)`}. ` +
            'Dispatched is not completed: the plugin replays the inverses and reports separately. Call read-journal ' +
            `with journalId ${result.journalId} for the outcome.`,
        };
      }

      case 'read-journal': {
        const journal = await this.#backend.journal(invocation.input.journalId);
        const failures = (journal.result?.outcomes ?? []).filter((outcome) => !outcome.ok);
        return {
          kind: 'done',
          payload: journal,
          // The state is said in the daemon's own word, never translated. Three
          // of the five mean a rollback did not fully happen, and an agent that
          // read "partial" as a variety of "done" would build on a tree that is
          // in neither of the two states anyone has a record of.
          summary:
            `Journal ${journal.journalId} (ChangeSet ${journal.changeSetId}) is "${journal.state}". ` +
            `The apply moved the tree ${journal.versionBefore} → ${journal.versionAfter}; this daemon holds ` +
            `${journal.inverses === null ? 'no' : journal.inverses} inverse operation(s) for it.` +
            (journal.result === null
              ? ''
              : ` The reversal replayed ${journal.result.outcomes.length - failures.length} of ` +
                `${journal.result.outcomes.length} and left the tree at version ${journal.result.newVersion}.` +
                (failures.length === 0
                  ? ''
                  : ` Inverses that could not be replayed: ${failures
                      .map((outcome) => `${outcome.index} (${outcome.error ?? 'no reason given'})`)
                      .join('; ')}. Those inverses are spent; this journal cannot be rolled back again.`)),
        };
      }

      case 'query-models': {
        const models = await this.#backend.models();
        return {
          kind: 'done',
          payload: models,
          summary: models.configured
            ? `${models.models.length} model(s) from ${models.source}, last verified ${models.verifiedAt ?? 'never'}.`
            : `No model registry is wired into this ForgeBridge instance (${models.source}).`,
        };
      }

      case 'studio-link-status': {
        const status = await this.#backend.linkStatus();
        return {
          kind: 'done',
          payload: status,
          summary:
            `Transport ${status.transport} (${status.privacyPosture}), protocol ${status.protocolVersion}, ` +
            `${status.links.length} link(s) on default project ${status.defaultProjectId}.`,
        };
      }
    }
  }

  /**
   * Ask the gate. Nothing from the request reaches it but the subject id.
   *
   * The `WRITING_SKILLS` assertion is belt and braces against a future edit:
   * if someone adds a skill to this switch that writes to the place and forgets
   * to route it through the gate, the set in `skills.ts` and the call sites
   * disagree, and this throws rather than quietly writing.
   */
  async #requireGrant<S extends ApprovalGrant['skill']>(
    skill: S,
    subject: string,
  ): Promise<GrantFor<S> | null> {
    if (!WRITING_SKILLS.has(skill)) {
      throw new Error(`skill "${skill}" asked for an approval grant but is not declared as a writing skill`);
    }
    return await this.#gate.consume(skill, subject);
  }
}

type Outcome =
  | { kind: 'done'; payload: unknown; summary: string }
  | { kind: 'awaiting-approval'; summary: string; detail: ErrorDetail };

function awaitingApproval(skill: SkillId, subject: string): Outcome {
  return {
    kind: 'awaiting-approval',
    summary:
      `"${skill}" needs an approval for ${subject} that this caller cannot grant. A human, or a local policy acting ` +
      'for one, must approve it out of band; re-send this request afterwards. Nothing has been written to the place.',
    detail: {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'APPROVAL_REQUIRED',
      domain: 'forgebridge.protocol',
      metadata: { skill, subject, approvalChannel: 'out-of-band' },
    },
  };
}

/** §3.7: results are artifacts, not messages. */
function artifactFor(skill: SkillId, payload: unknown, summary: string): Artifact {
  return {
    artifactId: randomUUID(),
    name: skill,
    description: summary,
    parts: [
      { data: payload, mediaType: 'application/json' },
      { text: summary, mediaType: 'text/plain' },
    ],
    extensions: [SKILL_INVOCATION_EXTENSION_URI],
  };
}

function dataPart(value: unknown): Part {
  return { data: value, mediaType: 'application/json' };
}

/**
 * A status message from this agent. §3.7 lists exactly this use — "status
 * messages to inform clients about task progress" — and warns that messages are
 * not a reliable delivery mechanism, which is why nothing a caller needs lives
 * only here. The artifact is the record.
 */
function agentMessage(taskId: string, text: string, extraParts: readonly Part[] = []): Message {
  return {
    messageId: randomUUID(),
    taskId,
    role: 'ROLE_AGENT',
    parts: [{ text, mediaType: 'text/plain' }, ...extraParts],
  };
}

/** Exported for the server, which reports the same shape when it rejects a task at creation. */
export function agentStatusMessage(taskId: string, text: string, extraParts: readonly Part[] = []): Message {
  return agentMessage(taskId, text, extraParts);
}
