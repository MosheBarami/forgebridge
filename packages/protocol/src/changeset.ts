import { z } from 'zod';
import { Operation } from './operation.js';
import { LIMITS } from './limits.js';

export const Finding = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  /** Stable rule id, e.g. "luau/no-loadstring". Used for suppression and docs. */
  rule: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
  message: z.string().max(2000),
  /** Index into ChangeSet.operations, when the finding is about one operation. */
  operationIndex: z.number().int().min(0).optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
});
export type Finding = z.infer<typeof Finding>;

/**
 * Validation is always computed by the core and never accepted from a producer.
 * It rides on the ChangeSet so that a consumer that receives one out of band
 * can still see the verdict — but a consumer must treat a ChangeSet whose
 * validation it did not witness as unvalidated.
 */
export const Validation = z.object({
  luau: z.object({
    status: z.enum(['ok', 'warn', 'fail']),
    findings: z.array(Finding).max(1000).default([]),
  }),
  policy: z.object({
    status: z.enum(['ok', 'fail']),
    violations: z.array(z.string().max(500)).max(200).default([]),
  }),
  /** Set by the core when it computed this verdict. */
  computedAt: z.string().datetime(),
  computedBy: z.string().max(120),
});
export type Validation = z.infer<typeof Validation>;

export const ChangeSetStatus = z.enum([
  'draft',      // producer is still building it
  'proposed',   // submitted, awaiting validation
  'validated',  // validation computed, awaiting approval
  'approved',   // cleared to apply
  'applying',   // handed to a consumer
  'applied',    // fully applied
  'partial',    // some operations applied, some failed
  'failed',     // nothing applied
  'rejected',   // a human or a policy refused it
  'stale',      // baseVersion no longer current
]);
export type ChangeSetStatus = z.infer<typeof ChangeSetStatus>;

export const ChangeSet = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    runId: z.string().uuid().optional(),
    /**
     * The tree_snapshot version this set was built against. Checked on apply;
     * a mismatch is refused with `stale_base` rather than merged. There is no
     * last-write-wins path in this protocol.
     */
    baseVersion: z.number().int().min(0),
    /** One line, human-facing. Shown in the approval UI and the journal. */
    summary: z.string().min(1).max(300),
    operations: z.array(Operation).min(1).max(LIMITS.MAX_OPERATIONS),
    validation: Validation.optional(),
    status: ChangeSetStatus.default('proposed'),
    createdAt: z.string().datetime(),
    /** Non-semantic extension point. Consumers ignore what they do not know. */
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((set, ctx) => {
    // Two operations addressing the same path in one set are almost always a
    // model looping; the ordering is then load-bearing in a way no reviewer
    // will notice in a diff. Allowed, but surfaced.
    const seen = new Map<string, number>();
    set.operations.forEach((operation, index) => {
      if (operation.op === 'deleteInstance') {
        const previous = seen.get(operation.path);
        if (previous !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['operations', index],
            message: `operation ${index} deletes "${operation.path}", which operation ${previous} also touches`,
          });
        }
      }
      seen.set(operation.path, index);
    });
  });

export type ChangeSet = z.infer<typeof ChangeSet>;

/** Serialised size guard. Applied after parse, where the shape is known good. */
export function withinSizeLimit(set: ChangeSet): boolean {
  return new TextEncoder().encode(JSON.stringify(set)).length <= LIMITS.MAX_CHANGESET_BYTES;
}

/** How many instances this set would destroy. Drives the bulk-delete gate. */
export function deletionCount(set: ChangeSet): number {
  return set.operations.filter((operation) => operation.op === 'deleteInstance').length;
}
