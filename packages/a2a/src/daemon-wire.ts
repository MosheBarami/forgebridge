import { z } from 'zod';
import { Validation } from '@forgebridge/protocol';

/**
 * The daemon `/v1` responses this connector reads, and only those.
 *
 * `packages/daemon/src/wire.ts` already declares these shapes, and its own
 * TODO(M31) says they belong in `@forgebridge/protocol` so that the daemon and
 * `apps/relay` cannot drift. They are re-declared here rather than imported for
 * one reason: importing them would make a connector depend on a specific
 * *server*, when ADR-009 says a connector is a thin adapter over the core and
 * the daemon's REST surface is one way to reach it. A connector that imports
 * `@forgebridge/daemon` cannot be pointed at `apps/relay` without a code change.
 *
 * They are also deliberately narrow: each schema below describes the fields
 * this package actually reads, and passes the rest through untouched. A
 * connector that re-validated every field of a response it merely forwards
 * would turn an additive server change into a broken connector.
 *
 * TODO(M31): delete this file and import the shapes from `@forgebridge/protocol`
 * once the conformance suite forces them to be promoted. Owner: the protocol
 * maintainer, as the additive `/v1` change `packages/daemon/src/wire.ts`
 * already describes. Until then, a field added to a daemon response reaches an
 * A2A caller verbatim but is invisible to any code here.
 */

/** `POST /v1/changesets` — 201. */
export const ProposeResponse = z
  .object({
    changeSetId: z.string().uuid(),
    status: z.string(),
    baseVersion: z.number().int().min(0),
    validation: Validation,
  })
  .passthrough();
export type ProposeResponse = z.infer<typeof ProposeResponse>;

/**
 * `GET /v1/changesets/:id/diff` — 200.
 *
 * `operations` is `unknown[]` here on purpose. The per-operation diff shape is
 * the daemon's rendering concern and this package neither reads nor reasons
 * about it; it forwards it into an artifact. Parsing it would buy nothing and
 * would make every future field the daemon adds a validation failure here.
 */
export const DiffResponse = z
  .object({
    changeSetId: z.string().uuid(),
    projectId: z.string().uuid(),
    summary: z.string(),
    status: z.string(),
    baseVersion: z.number().int().min(0),
    currentVersion: z.number().int().min(0),
    stale: z.boolean(),
    counts: z
      .object({
        total: z.number().int().min(0),
        creates: z.number().int().min(0),
        setProperties: z.number().int().min(0),
        scripts: z.number().int().min(0),
        moves: z.number().int().min(0),
        deletes: z.number().int().min(0),
      })
      .passthrough(),
    /**
     * What an approver must echo back on approve, and the one field of this
     * response the approval path in this package depends on: an
     * `ApplyApprovalGrant` is not constructible without it.
     *
     * Declared rather than left to `.passthrough()` because the rule at the top
     * of this file is that a schema names the fields this package reads, and a
     * local approval UI reading the digest off an untyped bag would be reading
     * it by luck. Optional, because a diff is a read: a daemon too old to
     * render a digest should still be readable here, and the honest refusal for
     * that case belongs at `POST /v1/changesets/:id/approve`, which is where the
     * binding is actually enforced — not at the read that precedes it.
     */
    contentDigest: z.string().min(1).optional(),
    operations: z.array(z.unknown()),
    validation: Validation.optional(),
  })
  .passthrough();
export type DiffResponse = z.infer<typeof DiffResponse>;

/** `POST /v1/changesets/:id/approve` — 202. */
export const ApproveResponse = z
  .object({
    changeSetId: z.string().uuid(),
    status: z.string(),
    nonce: z.number().int().min(0),
  })
  .passthrough();
export type ApproveResponse = z.infer<typeof ApproveResponse>;

/**
 * `POST /v1/journal/:id/rollback` — 202.
 *
 * `status` is `"dispatched"`, not `"rolled back"`. The inverse operations live
 * on the Studio plugin that captured them, so only the plugin can complete a
 * rollback; the daemon's own TODO(M11) records that the protocol currently has
 * no way for it to report completion. Anything this connector tells an A2A
 * caller must preserve that distinction rather than rounding "dispatched" up to
 * "done".
 */
export const RollbackResponse = z
  .object({
    journalId: z.string().uuid(),
    changeSetId: z.string().uuid(),
    status: z.string(),
    nonce: z.number().int().min(0),
  })
  .passthrough();
export type RollbackResponse = z.infer<typeof RollbackResponse>;

/**
 * `POST /v1/runs` — 201.
 *
 * Narrow, like every schema here: the fields this package reads are declared
 * and the rest passes through. `run.attempts` is declared in full, though, and
 * that is not an accident — it is the field ADR-008 is about, and a connector
 * that let it arrive through `.passthrough()` would have no way to say anything
 * true about it in the artifact summary a calling agent reads.
 *
 * `changeSetStatus` is a string here rather than the protocol's enum for the
 * reason the file's header gives: this package validates what it reads and
 * forwards the rest, and a daemon that gained a status would otherwise turn an
 * additive server change into a broken connector.
 */
export const RunResponse = z
  .object({
    run: z
      .object({
        id: z.string().uuid(),
        projectId: z.string().uuid(),
        stage: z.string(),
        status: z.string(),
        attempts: z.array(
          z
            .object({
              modelId: z.string(),
              outcome: z.string(),
              startedAt: z.string(),
              durationMs: z.number(),
            })
            .passthrough(),
        ),
        changeSetIds: z.array(z.string().uuid()),
      })
      .passthrough(),
    plan: z.object({ steps: z.array(z.string()) }).passthrough(),
    changeSetId: z.string().uuid().nullable(),
    changeSetStatus: z.string().nullable(),
    contentDigest: z.string().min(1).nullable(),
    validation: Validation.nullable(),
    skipped: z.array(z.unknown()),
    ordering: z.unknown().nullable(),
    failure: z.unknown().nullable(),
  })
  .passthrough();
export type RunResponse = z.infer<typeof RunResponse>;

/** `GET /v1/models` — 200. */
export const ModelsResponse = z
  .object({
    configured: z.boolean(),
    source: z.string(),
    verifiedAt: z.string().datetime().nullable(),
    models: z.array(z.unknown()),
  })
  .passthrough();
export type ModelsResponse = z.infer<typeof ModelsResponse>;

/**
 * `GET /v1/link` — 200.
 *
 * `links` is left unparsed for the same reason as `operations` above, with one
 * extra consideration: a `Link` carries `sessionKeyId`, `placeId` and version
 * strings about the user's machine. This connector forwards the daemon's answer
 * rather than reshaping it, so what an A2A caller sees is exactly what the
 * daemon chose to serve on a read endpoint — a decision that stays in one place
 * instead of being made again, differently, here.
 */
export const LinkStatusResponse = z
  .object({
    transport: z.string(),
    privacyPosture: z.string(),
    protocolVersion: z.string(),
    defaultProjectId: z.string().uuid(),
    links: z.array(z.unknown()),
    pairing: z.unknown().nullable(),
  })
  .passthrough();
export type LinkStatusResponse = z.infer<typeof LinkStatusResponse>;
