import { z } from 'zod';

/**
 * Why the router moved on from a model. Recorded per attempt and shown to the
 * user, because a silent substitution is a lie about what wrote their code.
 */
export const AttemptOutcome = z.enum([
  'ok',
  'rate-limited',
  'context-exceeded',
  'capability-missing',
  'provider-error',
  'timeout',
  'refused',
  'invalid-output',
  'cancelled',
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

export const ModelAttempt = z.object({
  modelId: z.string().max(200),
  providerSlug: z.string().max(80).optional(),
  outcome: AttemptOutcome,
  startedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  promptTokens: z.number().int().min(0).optional(),
  completionTokens: z.number().int().min(0).optional(),
  /** Zero for free models. Present so a self-hoster can see their own spend. */
  costUsd: z.number().min(0).optional(),
  note: z.string().max(500).optional(),
});
export type ModelAttempt = z.infer<typeof ModelAttempt>;

export const RunStage = z.enum([
  'queued', 'planning', 'generating', 'validating',
  'awaiting-approval', 'applying', 'testing', 'done', 'failed', 'cancelled',
]);

export const RunStatus = z.enum(['running', 'succeeded', 'failed', 'cancelled']);

export const Run = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  prompt: z.string().min(1).max(50_000),
  stage: RunStage.default('queued'),
  status: RunStatus.default('running'),
  /**
   * Every model the router tried, in order, with why it moved on. This array
   * is the run's permanent record — a run is not reproducible without it.
   */
  attempts: z.array(ModelAttempt).default([]),
  changeSetIds: z.array(z.string().uuid()).default([]),
  /** Set only when the producer was an external agent rather than the web app. */
  producer: z.object({
    kind: z.enum(['web', 'mcp', 'a2a', 'cli', 'sdk', 'rest']),
    client: z.string().max(120).optional(),
  }).optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});
export type Run = z.infer<typeof Run>;

/** One line for the collapsed run log: "GLM 5.2 → rate limited → MiniMax M3". */
export function attemptSummary(attempts: ModelAttempt[]): string {
  if (attempts.length === 0) return 'no model attempted';
  return attempts
    .map((a, i) => (i === attempts.length - 1 && a.outcome === 'ok' ? a.modelId : `${a.modelId} → ${a.outcome}`))
    .join(' → ');
}
