import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Link } from '@forgebridge/protocol';
import { NONCE_ORIGIN } from '../src/envelope.js';
import { InMemoryDaemonStore, RETENTION, type JournalRecord } from '../src/store.js';
import type { DeliveryPayload } from '../src/wire.js';

function makeLink(overrides: Record<string, unknown> = {}) {
  return Link.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    transport: 'local-daemon',
    state: 'paired',
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

const rollback = (journalId: string): DeliveryPayload => ({
  kind: 'rollback',
  journalId,
  changeSetId: randomUUID(),
  expectedVersion: 0,
});

describe('InMemoryDaemonStore deliveries', () => {
  it('assigns strictly increasing nonces starting above the cursor origin', async () => {
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();

    const first = await store.enqueueDelivery(linkId, rollback(randomUUID()));
    const second = await store.enqueueDelivery(linkId, rollback(randomUUID()));

    expect(first.nonce).toBe(NONCE_ORIGIN + 1);
    expect(second.nonce).toBe(first.nonce + 1);
    expect(await store.lastOutboundNonce(linkId)).toBe(second.nonce);
  });

  it('returns the first delivery above the cursor and nothing when caught up', async () => {
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();
    const first = await store.enqueueDelivery(linkId, rollback(randomUUID()));
    const second = await store.enqueueDelivery(linkId, rollback(randomUUID()));

    expect((await store.nextDelivery(linkId, 0))?.nonce).toBe(first.nonce);
    expect((await store.nextDelivery(linkId, first.nonce))?.nonce).toBe(second.nonce);
    expect(await store.nextDelivery(linkId, second.nonce)).toBeNull();
  });

  it('keeps the queue bounded — a long-lived daemon must not grow forever', async () => {
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();
    for (let i = 0; i < RETENTION.DELIVERIES_PER_LINK + 20; i += 1) {
      await store.enqueueDelivery(linkId, rollback(randomUUID()));
    }
    // Nonces keep climbing even though the oldest entries were dropped.
    expect(await store.lastOutboundNonce(linkId)).toBe(RETENTION.DELIVERIES_PER_LINK + 20);
    expect(await store.nextDelivery(linkId, 0)).not.toBeNull();
    expect((await store.nextDelivery(linkId, 0))?.nonce).toBe(21);
  });
});

describe('InMemoryDaemonStore inbound watermark', () => {
  it('claims a nonce once and refuses it forever after', async () => {
    // The replay guard is this one call. A caller that read the watermark and
    // then wrote it would have a window between the two in which a duplicate
    // reads the same old value and is admitted as well.
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();

    expect(await store.tryAdvanceInboundNonce(linkId, 5)).toBe(true);
    expect(await store.tryAdvanceInboundNonce(linkId, 5)).toBe(false);
    expect(await store.lastInboundNonce(linkId)).toBe(5);
  });

  it('never moves backwards, whatever order handlers finish in', async () => {
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();

    expect(await store.tryAdvanceInboundNonce(linkId, 5)).toBe(true);
    expect(await store.tryAdvanceInboundNonce(linkId, 2)).toBe(false);

    expect(await store.lastInboundNonce(linkId)).toBe(5);
  });

  it('refuses a nonce that is not a non-negative safe integer', async () => {
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();

    for (const nonce of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await store.tryAdvanceInboundNonce(linkId, nonce), String(nonce)).toBe(false);
    }
    expect(await store.lastInboundNonce(linkId)).toBe(NONCE_ORIGIN);
  });

  it('tracks each link separately', async () => {
    const store = new InMemoryDaemonStore();
    const [one, two] = [randomUUID(), randomUUID()];

    expect(await store.tryAdvanceInboundNonce(one, 3)).toBe(true);
    expect(await store.tryAdvanceInboundNonce(two, 1)).toBe(true);
    expect(await store.lastInboundNonce(one)).toBe(3);
  });
});

describe('InMemoryDaemonStore journals', () => {
  it('refuses to overwrite a journal id that already exists', async () => {
    // The consumer holds the inverses under this id. A second record claiming
    // it describes a different apply, and writing it would leave the first
    // apply with no route back at all (THREAT-MODEL T2 layer 5).
    const store = new InMemoryDaemonStore();
    const id = randomUUID();
    const first = makeJournal(id, { versionBefore: 0, versionAfter: 1 });
    await store.putJournal(first);

    await expect(store.putJournal(makeJournal(id, { versionBefore: 1, versionAfter: 2 }))).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect((await store.getJournal(id))?.versionAfter).toBe(1);
  });
});

describe('InMemoryDaemonStore project policy', () => {
  it('reports a project with no policy as null rather than as an empty allowlist', async () => {
    // "Not configured" and "configured to permit nothing" are different facts,
    // and only the caller gets to decide what the first one means.
    const store = new InMemoryDaemonStore();
    const projectId = randomUUID();
    expect(await store.getProjectPolicy(projectId)).toBeNull();

    await store.setProjectPolicy(projectId, { allowedPathPrefixes: ['Workspace'], autoApply: null });
    expect((await store.getProjectPolicy(projectId))?.allowedPathPrefixes).toEqual(['Workspace']);
  });
});

function makeJournal(id: string, overrides: Partial<JournalRecord> = {}): JournalRecord {
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

describe('InMemoryDaemonStore links and versions', () => {
  it('reports a project at version 0 before anything is applied', async () => {
    const store = new InMemoryDaemonStore();
    expect(await store.getProjectVersion(randomUUID())).toBe(0);
  });

  it('finds only paired links for the requested project', async () => {
    const store = new InMemoryDaemonStore();
    const projectId = randomUUID();
    await store.putLink(makeLink({ projectId, state: 'revoked' }));
    await store.putLink(makeLink({ projectId: randomUUID(), state: 'paired' }));
    expect(await store.findPairedLink(projectId)).toBeNull();

    const live = makeLink({ projectId, state: 'paired' });
    await store.putLink(live);
    expect((await store.findPairedLink(projectId))?.id).toBe(live.id);
  });
});

describe('InMemoryDaemonStore console mirror', () => {
  it('keeps only the most recent messages', async () => {
    const store = new InMemoryDaemonStore();
    const linkId = randomUUID();
    const at = new Date().toISOString();
    for (let i = 0; i < RETENTION.OUTPUT_PER_LINK + 5; i += 1) {
      await store.appendOutput(linkId, [{ level: 'print', message: `line ${i}`, at }]);
    }
    const recent = await store.recentOutput(linkId, 10);
    expect(recent).toHaveLength(10);
    expect(recent.at(-1)?.message).toBe(`line ${RETENTION.OUTPUT_PER_LINK + 4}`);
  });
});
