/**
 * The daemon store conformance suite — one executable definition of what a
 * `DaemonStore` must do, run against every implementation (ADR-005, M40).
 *
 * ADR-005's whole argument for a port with two adapters is that "adapter parity
 * is testable — one suite, two backends, both green or the build fails", and
 * its revisit trigger is the day that stops being true: *"If adapter parity
 * tests start being skipped for SQLite, the abstraction has failed."* A suite
 * that lives inside one adapter's test file cannot satisfy that, because the
 * other adapter is then verified by a second set of tests written by whoever
 * wrote the second adapter — which is not parity, it is two opinions.
 *
 * So the cases live here, in a module both adapters import, in the same shape
 * `packages/conformance` already uses for connectors: framework-free cases a
 * host runs however it likes. Two hosts run them today —
 * `packages/daemon/test/store.test.ts` against `InMemoryDaemonStore`, and
 * `packages/storage-sqlite/test/parity.test.ts` against the SQLite adapter —
 * and neither can pass by having its own version of a case.
 *
 * ── Why these cases and not others ───────────────────────────────────────────
 *
 * Every case here is either (a) an invariant a handler depends on for
 * correctness — the two write-once refusals, the compare-and-swap on the
 * inbound nonce — or (b) a bound a long-running daemon depends on for
 * survival. Round-trip cases are included for the methods where an adapter
 * could plausibly lose a field in serialisation, and left out where the only
 * thing they would prove is that a Map works.
 *
 * The suite uses `node:assert` rather than a test framework's `expect`, because
 * the two hosts run under different circumstances and a suite that can only be
 * driven by one runner is a suite the second adapter will eventually be excused
 * from.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChangeSet, JournalEntry, Link, Run } from '@forgebridge/protocol';
import type {
  ApplyResult,
  ChangeSet as ChangeSetType,
  JournalEntry as JournalEntryType,
  Link as LinkType,
  RollbackResult,
} from '@forgebridge/protocol';
import { NONCE_ORIGIN } from './envelope.js';
import { RETENTION, type DaemonStore, type JournalRecord, type RunRecord } from './store.js';
import type { DeliveryPayload } from './wire.js';

export interface DaemonStoreCase {
  /** Used verbatim as the test name by both hosts, so a failure names the same case in both. */
  readonly name: string;
  /**
   * What breaks in the product when this case fails. Printed alongside the
   * assertion, because a parity failure is usually read by whoever wrote the
   * *second* adapter, who has no reason to know why the first one behaves this
   * way.
   */
  readonly why: string;
  run(store: DaemonStore): Promise<void>;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

export function suiteLink(overrides: Record<string, unknown> = {}): LinkType {
  // Built through the frozen schema rather than cast into shape, so a fixture
  // that drifts from the contract fails here instead of inside an adapter.
  return Link.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    transport: 'local-daemon',
    state: 'paired',
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

export function suiteChangeSet(overrides: Record<string, unknown> = {}): ChangeSetType {
  return ChangeSet.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    baseVersion: 0,
    summary: 'add a shop script',
    operations: [
      { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("hello")' },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

export function suiteJournal(id: string, overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    id,
    projectId: randomUUID(),
    changeSetId: randomUUID(),
    summary: 'add a shop script',
    versionBefore: 0,
    versionAfter: 1,
    appliedAt: new Date().toISOString(),
    rollbackRequestedAt: null,
    rolledBackAt: null,
    ...overrides,
  };
}

export function suiteRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const run = Run.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    prompt: 'add a purchase handler to the shop',
    stage: 'awaiting-approval',
    status: 'running',
    attempts: [],
    changeSetIds: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  return {
    run,
    plan: { steps: ['route: one candidate', 'generate: one ChangeSet'] },
    changeSetId: null,
    contentDigest: null,
    validation: null,
    skipped: [],
    ordering: null,
    failure: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function suiteJournalEntry(overrides: Record<string, unknown> = {}): JournalEntryType {
  return JournalEntry.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    changeSetId: randomUUID(),
    summary: 'add a shop script',
    applied: [
      {
        index: 0,
        operation: {
          op: 'writeScript',
          path: 'ServerScriptService.Shop',
          scriptType: 'Script',
          source: 'print("hello")',
        },
      },
    ],
    // One of every inverse the protocol has, including the opaque one: an
    // adapter that serialises these must give all five back unchanged, and
    // `restoreSubtree` carries a whole model format the server cannot read.
    inverses: [
      { inverse: 'deleteCreated', path: 'Workspace.Scratch' },
      { inverse: 'restoreProperty', path: 'Workspace.Part', property: 'Anchored', previous: false },
      { inverse: 'restoreSource', path: 'ServerScriptService.Shop', previousSource: 'print("old")' },
      { inverse: 'moveBack', path: 'Workspace.Moved', from: 'ReplicatedStorage.Moved' },
      { inverse: 'restoreSubtree', parentPath: 'Workspace', serialised: 'PFJPQkxPWCE4AAAA' },
    ],
    versionBefore: 3,
    versionAfter: 4,
    appliedAt: new Date().toISOString(),
    rolledBackAt: null,
    ...overrides,
  });
}

const rollbackPayload = (journalId: string): DeliveryPayload => ({
  kind: 'rollback',
  journalId,
  changeSetId: randomUUID(),
  expectedVersion: 0,
  // M11: a rollback delivery carries the inverses it is asking to have replayed.
  // Without them it is the pre-M11 shape, which a consumer must refuse rather
  // than execute as a reversal with no work to do.
  restoresToVersion: 0,
  steps: [{ index: 0, inverse: { inverse: 'deleteCreated', path: 'Workspace.Scratch' } }],
});

function isInvalidRequest(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'invalid_request';
}

// ── the cases ────────────────────────────────────────────────────────────────

export const DAEMON_STORE_SUITE: readonly DaemonStoreCase[] = [
  {
    name: 'reports an absent link, version, policy, changeset, journal, run and apply result as absent',
    why:
      'Every one of these is a "not configured" that a handler turns into a different answer than ' +
      '"configured to nothing". An adapter that invents an empty row for a missing one collapses the two.',
    async run(store) {
      const unknown = randomUUID();
      assert.equal(await store.getLink(unknown), null);
      assert.equal(await store.getProjectPolicy(unknown), null);
      assert.equal(await store.getChangeSet(unknown), null);
      assert.equal(await store.getJournal(unknown), null);
      assert.equal(await store.getRun(unknown), null);
      assert.equal(await store.getApplyResult(unknown), null);
      assert.equal(await store.getJournalEntry(unknown), null);
      assert.equal(await store.getRollbackResult(unknown), null);
      assert.equal(await store.getProjectVersion(unknown), 0);
      assert.deepEqual(await store.recentOutput(unknown, 10), []);
      assert.equal(await store.nextDelivery(unknown, 0), null);
      assert.equal(await store.lastOutboundNonce(unknown), NONCE_ORIGIN);
      assert.equal(await store.lastInboundNonce(unknown), NONCE_ORIGIN);
    },
  },

  {
    name: 'round-trips a link and lists every one it holds',
    why: 'The link is how the daemon knows which Studio session a project is paired with.',
    async run(store) {
      const link = suiteLink({ sessionKeyId: 'k_9f2e', pluginVersion: '0.1.0', placeId: 12345 });
      const second = suiteLink();
      await store.putLink(link);
      await store.putLink(second);
      assert.deepEqual(await store.getLink(link.id), link);
      // As a set, not a sequence: `listLinks` promises completeness and the
      // port promises no order, so an adapter that returns insertion order and
      // one that returns creation order are both correct. Asserting a sequence
      // here would pin an ordering no caller was given.
      assert.deepEqual(
        new Set((await store.listLinks()).map((entry) => entry.id)),
        new Set([link.id, second.id]),
      );
    },
  },

  {
    name: 'patches a link and refuses to patch one that does not exist',
    why:
      'The poll handler patches lastSeenAt on every request. Returning a fabricated link for an ' +
      'unknown id would let a revoked or forged link id look live.',
    async run(store) {
      const link = suiteLink();
      await store.putLink(link);
      const patched = await store.patchLink(link.id, { state: 'revoked', lastSeenAt: '2026-02-14T09:00:00.000Z' });
      assert.equal(patched?.state, 'revoked');
      assert.equal(patched?.lastSeenAt, '2026-02-14T09:00:00.000Z');
      assert.equal((await store.getLink(link.id))?.state, 'revoked');
      // Untouched fields survive the patch.
      assert.equal((await store.getLink(link.id))?.projectId, link.projectId);
      assert.equal(await store.patchLink(randomUUID(), { state: 'revoked' }), null);
    },
  },

  {
    name: 'finds only paired links for the requested project',
    why: 'A revoked link that still answered findPairedLink would let a revoked session receive a ChangeSet.',
    async run(store) {
      const projectId = randomUUID();
      await store.putLink(suiteLink({ projectId, state: 'revoked' }));
      await store.putLink(suiteLink({ projectId: randomUUID(), state: 'paired' }));
      assert.equal(await store.findPairedLink(projectId), null);

      const live = suiteLink({ projectId, state: 'paired' });
      await store.putLink(live);
      assert.equal((await store.findPairedLink(projectId))?.id, live.id);
    },
  },

  {
    name: 'prefers the most recently seen paired link when a project has several',
    why:
      'A user who reopens Studio pairs again without revoking the old link. Delivering to the stale ' +
      'one means the ChangeSet arrives in a window nobody is looking at.',
    async run(store) {
      const projectId = randomUUID();
      const older = suiteLink({
        projectId,
        createdAt: '2026-02-14T08:00:00.000Z',
        lastSeenAt: '2026-02-14T08:30:00.000Z',
      });
      const newer = suiteLink({
        projectId,
        createdAt: '2026-02-14T09:00:00.000Z',
        lastSeenAt: '2026-02-14T09:30:00.000Z',
      });
      await store.putLink(older);
      await store.putLink(newer);
      assert.equal((await store.findPairedLink(projectId))?.id, newer.id);
    },
  },

  {
    name: 'reports a project at version 0 before anything is applied, and remembers what is set',
    why: 'The version is what a ChangeSet declares as its baseVersion; an invented one makes a stale set look fresh.',
    async run(store) {
      const projectId = randomUUID();
      assert.equal(await store.getProjectVersion(projectId), 0);
      await store.setProjectVersion(projectId, 7);
      assert.equal(await store.getProjectVersion(projectId), 7);
      await store.setProjectVersion(projectId, 8);
      assert.equal(await store.getProjectVersion(projectId), 8);
    },
  },

  {
    name: 'reports a project with no policy as null rather than as an empty allowlist',
    why:
      '"Not configured" and "configured to permit nothing" are different facts, and only the caller ' +
      'gets to decide what the first one means. The daemon substitutes DENY_ALL_POLICY.',
    async run(store) {
      const projectId = randomUUID();
      assert.equal(await store.getProjectPolicy(projectId), null);

      await store.setProjectPolicy(projectId, { allowedPathPrefixes: ['Workspace'], autoApply: null });
      assert.deepEqual((await store.getProjectPolicy(projectId))?.allowedPathPrefixes, ['Workspace']);

      await store.setProjectPolicy(projectId, {
        allowedPathPrefixes: ['ServerScriptService.Shop'],
        autoApply: { enabled: true, pathPrefix: 'ServerScriptService.Shop' },
      });
      const policy = await store.getProjectPolicy(projectId);
      assert.deepEqual(policy?.allowedPathPrefixes, ['ServerScriptService.Shop']);
      assert.equal(policy?.autoApply?.enabled, true);
      assert.equal(policy?.autoApply?.pathPrefix, 'ServerScriptService.Shop');
    },
  },

  {
    name: 'refuses to overwrite a changeset id that already exists',
    why:
      'The id is the handle the diff a human read, the approval and the ApplyResult all name the work ' +
      'by. A second set written under it inherits the reviewed one name and its cleared status, which ' +
      'is a review bypass rather than an update.',
    async run(store) {
      const first = suiteChangeSet();
      await store.putChangeSet(first);

      const swapped = suiteChangeSet({
        id: first.id,
        projectId: first.projectId,
        operations: [
          { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("pwned")' },
        ],
      });
      await assert.rejects(() => store.putChangeSet(swapped), isInvalidRequest);
      assert.deepEqual((await store.getChangeSet(first.id))?.operations, first.operations);
    },
  },

  {
    name: 'still lets the status of a stored set move, and keeps everything else',
    why:
      'The control for the rule above: write-once is about content, not about the lifecycle. A set ' +
      'that could never be marked approved or applied would be a store that refuses the one mutation ' +
      'the protocol requires.',
    async run(store) {
      const changeSet = suiteChangeSet();
      await store.putChangeSet(changeSet);

      assert.equal((await store.setChangeSetStatus(changeSet.id, 'approved'))?.status, 'approved');
      const stored = await store.getChangeSet(changeSet.id);
      assert.equal(stored?.status, 'approved');
      assert.deepEqual(stored?.operations, changeSet.operations);
      assert.equal(stored?.summary, changeSet.summary);
      assert.equal(stored?.baseVersion, changeSet.baseVersion);
      assert.equal(stored?.projectId, changeSet.projectId);
    },
  },

  {
    name: 'answers a status change for an unknown changeset with null rather than creating one',
    why: 'An approval that silently created the set it was approving would be an approval of nothing.',
    async run(store) {
      assert.equal(await store.setChangeSetStatus(randomUUID(), 'approved'), null);
    },
  },

  {
    name: 'assigns strictly increasing nonces starting above the cursor origin',
    why: 'The consumer polls with a cursor. A repeated or decreasing nonce makes it skip a delivery or replay one.',
    async run(store) {
      const linkId = randomUUID();
      const first = await store.enqueueDelivery(linkId, rollbackPayload(randomUUID()));
      const second = await store.enqueueDelivery(linkId, rollbackPayload(randomUUID()));

      assert.equal(first.nonce, NONCE_ORIGIN + 1);
      assert.equal(second.nonce, first.nonce + 1);
      assert.equal(await store.lastOutboundNonce(linkId), second.nonce);
      assert.equal(first.linkId, linkId);
      assert.ok(typeof first.createdAt === 'string' && first.createdAt.length > 0);
    },
  },

  {
    name: 'returns the first delivery above the cursor and nothing when caught up',
    why: 'This is the whole long-poll contract; getting it wrong is either a missed apply or an infinite loop.',
    async run(store) {
      const linkId = randomUUID();
      const first = await store.enqueueDelivery(linkId, rollbackPayload(randomUUID()));
      const second = await store.enqueueDelivery(linkId, rollbackPayload(randomUUID()));

      assert.equal((await store.nextDelivery(linkId, 0))?.nonce, first.nonce);
      assert.equal((await store.nextDelivery(linkId, first.nonce))?.nonce, second.nonce);
      assert.equal(await store.nextDelivery(linkId, second.nonce), null);
    },
  },

  {
    name: 'round-trips a delivery payload through the queue',
    why:
      'The payload is what the plugin executes. An adapter that serialises it must give back the same ' +
      'object; a dropped field is a rollback that restores the wrong version.',
    async run(store) {
      const linkId = randomUUID();
      const payload = rollbackPayload(randomUUID());
      await store.enqueueDelivery(linkId, payload);
      assert.deepEqual((await store.nextDelivery(linkId, 0))?.payload, payload);
    },
  },

  {
    name: 'keeps the delivery queue bounded — a long-lived daemon must not grow forever',
    why:
      'A daemon runs for weeks. An unbounded queue is a slow leak that presents as "Studio got laggy" ' +
      'long before anyone suspects the bridge.',
    async run(store) {
      const linkId = randomUUID();
      for (let i = 0; i < RETENTION.DELIVERIES_PER_LINK + 20; i += 1) {
        await store.enqueueDelivery(linkId, rollbackPayload(randomUUID()));
      }
      // Nonces keep climbing even though the oldest entries were dropped: the
      // counter is the consumer's cursor, not the queue length.
      assert.equal(await store.lastOutboundNonce(linkId), RETENTION.DELIVERIES_PER_LINK + 20);
      assert.equal((await store.nextDelivery(linkId, 0))?.nonce, 21);
    },
  },

  {
    name: 'queues each link separately',
    why: 'Two paired Studio sessions must not read each other deliveries.',
    async run(store) {
      const [one, two] = [randomUUID(), randomUUID()];
      await store.enqueueDelivery(one, rollbackPayload(randomUUID()));
      await store.enqueueDelivery(one, rollbackPayload(randomUUID()));
      const only = await store.enqueueDelivery(two, rollbackPayload(randomUUID()));

      assert.equal(await store.lastOutboundNonce(one), NONCE_ORIGIN + 2);
      assert.equal(await store.lastOutboundNonce(two), NONCE_ORIGIN + 1);
      assert.equal((await store.nextDelivery(two, 0))?.nonce, only.nonce);
    },
  },

  {
    name: 'claims an inbound nonce once and refuses it forever after',
    why:
      'The replay guard is this one call. A caller that read the watermark and then wrote it would have ' +
      'a window between the two in which a duplicate reads the same old value and is admitted as well — ' +
      'and an adapter that awaits real I/O between the two would widen that window to a round trip.',
    async run(store) {
      const linkId = randomUUID();
      assert.equal(await store.tryAdvanceInboundNonce(linkId, 5), true);
      assert.equal(await store.tryAdvanceInboundNonce(linkId, 5), false);
      assert.equal(await store.lastInboundNonce(linkId), 5);
    },
  },

  {
    name: 'never moves the inbound watermark backwards, whatever order handlers finish in',
    why: 'Out-of-order arrival is normal on a long-poll transport; accepting the older one re-admits a replay.',
    async run(store) {
      const linkId = randomUUID();
      assert.equal(await store.tryAdvanceInboundNonce(linkId, 5), true);
      assert.equal(await store.tryAdvanceInboundNonce(linkId, 2), false);
      assert.equal(await store.lastInboundNonce(linkId), 5);
    },
  },

  {
    name: 'refuses an inbound nonce that is not a non-negative safe integer',
    why:
      'The value arrives from across a trust boundary. NaN compares false against everything, so a ' +
      'guard written as a plain comparison admits it and then stores it as the watermark, disabling ' +
      'the replay check for the rest of the session.',
    async run(store) {
      const linkId = randomUUID();
      for (const nonce of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        assert.equal(await store.tryAdvanceInboundNonce(linkId, nonce), false, `nonce ${nonce}`);
      }
      assert.equal(await store.lastInboundNonce(linkId), NONCE_ORIGIN);
    },
  },

  {
    name: 'tracks the inbound watermark per link',
    why: 'One session advancing its counter must not let another session replay up to the same number.',
    async run(store) {
      const [one, two] = [randomUUID(), randomUUID()];
      assert.equal(await store.tryAdvanceInboundNonce(one, 3), true);
      assert.equal(await store.tryAdvanceInboundNonce(two, 1), true);
      assert.equal(await store.lastInboundNonce(one), 3);
      assert.equal(await store.lastInboundNonce(two), 1);
      // …and the lower watermark on `two` still refuses its own replay.
      assert.equal(await store.tryAdvanceInboundNonce(two, 1), false);
    },
  },

  {
    name: 'round-trips an apply result, whole',
    why:
      'A partial apply is evidence. The outcomes list is what tells a user which operations landed, ' +
      'and an adapter that stored a summary instead would make a partial apply unexplainable.',
    async run(store) {
      const changeSetId = randomUUID();
      const result: ApplyResult = {
        changeSetId,
        outcomes: [
          { index: 0, ok: true },
          { index: 1, ok: false, error: 'no such parent' },
        ],
        newVersion: 3,
        journalId: randomUUID(),
        appliedAt: new Date().toISOString(),
        pluginVersion: '0.1.0',
      };
      await store.putApplyResult(result);
      assert.deepEqual(await store.getApplyResult(changeSetId), result);
    },
  },

  {
    name: 'refuses to overwrite a journal id that already exists',
    why:
      'The consumer holds the inverse operations under this id. A second record claiming it describes a ' +
      'different apply, and writing it would leave the first apply with no route back at all ' +
      '(THREAT-MODEL T2 layer 5).',
    async run(store) {
      const id = randomUUID();
      await store.putJournal(suiteJournal(id, { versionBefore: 0, versionAfter: 1 }));
      await assert.rejects(
        () => store.putJournal(suiteJournal(id, { versionBefore: 1, versionAfter: 2 })),
        isInvalidRequest,
      );
      assert.equal((await store.getJournal(id))?.versionAfter, 1);
    },
  },

  {
    name: 'patches a journal without letting its id move, and refuses an unknown one',
    why:
      'Rollback marks the entry requested and then rolled back. An id that could be patched to a ' +
      'different value would rename the handle the consumer holds the inverses under.',
    async run(store) {
      const id = randomUUID();
      await store.putJournal(suiteJournal(id));
      const patched = await store.patchJournal(id, {
        id: randomUUID(),
        rollbackRequestedAt: '2026-02-14T10:00:00.000Z',
        rolledBackAt: '2026-02-14T10:00:02.000Z',
      });
      assert.equal(patched?.id, id);
      assert.equal(patched?.rolledBackAt, '2026-02-14T10:00:02.000Z');
      assert.equal((await store.getJournal(id))?.rollbackRequestedAt, '2026-02-14T10:00:00.000Z');
      assert.equal(await store.patchJournal(randomUUID(), { rolledBackAt: null }), null);
    },
  },

  {
    name: 'round-trips a journal record whole',
    why: 'The version bracket is what a rollback restores to; losing either end makes the entry unusable.',
    async run(store) {
      const record = suiteJournal(randomUUID(), { versionBefore: 4, versionAfter: 5 });
      await store.putJournal(record);
      assert.deepEqual(await store.getJournal(record.id), record);
    },
  },

  {
    name: 'mirrors console output in order and keeps only the most recent',
    why:
      'The mirror is a debugging aid with no upper bound on how much a runaway script prints. Unbounded, ' +
      'it is the same slow leak as the delivery queue.',
    async run(store) {
      const linkId = randomUUID();
      const at = new Date().toISOString();
      for (let i = 0; i < RETENTION.OUTPUT_PER_LINK + 5; i += 1) {
        await store.appendOutput(linkId, [{ level: 'print', message: `line ${i}`, at }]);
      }
      const recent = await store.recentOutput(linkId, 10);
      assert.equal(recent.length, 10);
      assert.equal(recent.at(-1)?.message, `line ${RETENTION.OUTPUT_PER_LINK + 4}`);
      assert.equal(recent[0]?.message, `line ${RETENTION.OUTPUT_PER_LINK - 5}`);
      assert.equal(recent[0]?.level, 'print');
    },
  },

  {
    name: 'appends a batch of output as a batch',
    why: 'The plugin uploads several lines per poll; splitting or reordering them scrambles a stack trace.',
    async run(store) {
      const linkId = randomUUID();
      const at = new Date().toISOString();
      await store.appendOutput(linkId, [
        { level: 'print', message: 'one', at },
        { level: 'warning', message: 'two', at },
        { level: 'error', message: 'three', at },
      ]);
      assert.deepEqual(
        (await store.recentOutput(linkId, 10)).map((message) => message.message),
        ['one', 'two', 'three'],
      );
      assert.equal((await store.recentOutput(linkId, 1))[0]?.message, 'three');
      // An empty append is a no-op rather than an error: the poll handler calls
      // it unconditionally with whatever the plugin sent.
      await store.appendOutput(linkId, []);
      assert.equal((await store.recentOutput(linkId, 10)).length, 3);
    },
  },

  {
    name: 'round-trips a run record, attempts included',
    why:
      'ADR-008 calls the attempt list the run permanent record: a caller whose connection dropped ' +
      'mid-run must still be able to ask which models were tried and why the router moved on.',
    async run(store) {
      const base = suiteRunRecord();
      const record: RunRecord = {
        ...base,
        run: {
          ...base.run,
          attempts: [
            {
              modelId: 'first/model:free',
              providerSlug: 'alpha',
              outcome: 'provider-error',
              startedAt: '2026-02-14T09:00:00.000Z',
              durationMs: 1000,
              note: 'upstream returned 503',
            },
            {
              modelId: 'second/model:free',
              providerSlug: 'beta',
              outcome: 'ok',
              startedAt: '2026-02-14T09:00:01.000Z',
              durationMs: 3000,
              promptTokens: 812,
              completionTokens: 240,
            },
          ],
          changeSetIds: [randomUUID()],
        },
        changeSetId: randomUUID(),
        contentDigest: 'a3f5c9e18b6d47029f1c8e5a2b7d4306f8e1c9a5b2d7e403f6c8a1b9d2e5f704',
      };
      await store.putRun(record);
      assert.deepEqual(await store.getRun(record.run.id), record);
    },
  },

  {
    name: 'rewrites a run record rather than refusing the second write',
    why:
      'The write-once rule that governs changesets and journals deliberately does not apply here: a run ' +
      'id is minted by this daemon for a run this daemon is executing, and the record is rewritten as ' +
      'that run moves through its stages.',
    async run(store) {
      const record = suiteRunRecord();
      await store.putRun(record);
      await store.putRun({
        ...record,
        run: { ...record.run, stage: 'done', status: 'succeeded', finishedAt: '2026-02-14T09:05:00.000Z' },
      });
      const stored = await store.getRun(record.run.id);
      assert.equal(stored?.run.stage, 'done');
      assert.equal(stored?.run.status, 'succeeded');
    },
  },

  {
    name: 'keeps the most recent runs and evicts the oldest',
    why: 'A producer scripting a hundred runs an hour would otherwise grow this store for as long as the process is up.',
    async run(store) {
      const ids: string[] = [];
      for (let i = 0; i < RETENTION.RUNS + 5; i += 1) {
        const record = suiteRunRecord();
        ids.push(record.run.id);
        await store.putRun(record);
      }
      assert.equal(await store.getRun(ids[0]!), null, 'the oldest run should have been evicted');
      assert.notEqual(await store.getRun(ids[ids.length - 1]!), null, 'the newest run should still be there');
      assert.equal(await store.getRun(ids[4]!), null);
      assert.notEqual(await store.getRun(ids[5]!), null);
    },
  },

  {
    name: 'round-trips a journal entry, every inverse included',
    why:
      'The inverses are the only route back from a destructive apply. An adapter that dropped one — ' +
      'the opaque restoreSubtree most plausibly — would report a clean rollback that left part of the ' +
      "user's place deleted.",
    async run(store) {
      const entry = suiteJournalEntry();
      await store.putJournalEntry(entry);
      assert.deepEqual(await store.getJournalEntry(entry.id), entry);
      assert.equal(await store.getJournalEntry(randomUUID()), null);
    },
  },

  {
    name: 'refuses a second journal entry under an id that already carries inverses',
    why:
      'The inverses of an apply are captured once, before it runs. A second upload would replace the ' +
      'only copy of the operations a rollback would replay — with operations no human approved.',
    async run(store) {
      const entry = suiteJournalEntry();
      await store.putJournalEntry(entry);
      await assert.rejects(
        () => store.putJournalEntry(suiteJournalEntry({ id: entry.id, summary: 'something else' })),
        isInvalidRequest,
      );
      assert.equal((await store.getJournalEntry(entry.id))?.summary, entry.summary);
    },
  },

  {
    name: 'records a rollback result and lets a second attempt replace it',
    why:
      'The control for the rule above: the *entry* is write-once, the *result* is not. A partial replay ' +
      'leaves inverses unspent and a second attempt is a legitimate thing to ask for — a store that ' +
      'refused the second result would make the retry unreportable.',
    async run(store) {
      const journalId = randomUUID();
      const changeSetId = randomUUID();
      const partial: RollbackResult = {
        journalId,
        changeSetId,
        outcomes: [
          { index: 0, ok: true },
          { index: 1, ok: false, error: 'the instance was already gone' },
        ],
        newVersion: 5,
        rolledBackAt: '2026-02-14T10:00:00.000Z',
        pluginVersion: '0.1.0',
      };
      await store.putRollbackResult(partial);
      assert.deepEqual(await store.getRollbackResult(journalId), partial);

      const retried: RollbackResult = {
        ...partial,
        outcomes: [
          { index: 0, ok: true },
          { index: 1, ok: true },
        ],
        newVersion: 6,
        rolledBackAt: '2026-02-14T10:05:00.000Z',
      };
      await store.putRollbackResult(retried);
      assert.deepEqual(await store.getRollbackResult(journalId), retried);
      assert.equal(await store.getRollbackResult(randomUUID()), null);
    },
  },

  {
    name: 'moves a rewritten run to the young end of the retention window',
    why:
      'A plain overwrite leaves an existing key where it was first inserted, which lets a burst of newer ' +
      'runs evict the record of a run that has not finished yet — the one case where losing the record ' +
      'costs a user something they were waiting for.',
    async run(store) {
      const longRunning = suiteRunRecord();
      await store.putRun(longRunning);
      for (let i = 0; i < RETENTION.RUNS - 1; i += 1) await store.putRun(suiteRunRecord());

      // Still in the window, and touched by a stage change.
      await store.putRun({ ...longRunning, run: { ...longRunning.run, stage: 'generating' } });

      for (let i = 0; i < 10; i += 1) await store.putRun(suiteRunRecord());
      assert.equal((await store.getRun(longRunning.run.id))?.run.stage, 'generating');
    },
  },
];
