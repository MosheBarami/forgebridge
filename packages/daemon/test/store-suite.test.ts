/**
 * The suite's own self-test: plant a violation, prove the suite rejects it.
 *
 * Both `InMemoryDaemonStore` and the SQLite adapter passed `DAEMON_STORE_SUITE`
 * on the first run. That is either good news or evidence that the suite cannot
 * fail, and this repository has a standing answer to that ambiguity — a gate
 * that cannot fail is decoration, so every gate here plants a violation and
 * shows the gate catching it.
 *
 * Each case below wraps the working store and breaks exactly one behaviour, in
 * the way a real adapter would most plausibly break it: reading the watermark
 * and then writing it, checking for an id before inserting it, returning an
 * empty policy for a missing row, forgetting to trim. All four are mistakes
 * somebody would make while writing a second adapter and would not notice —
 * which is the definition of what a parity suite is for.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '@forgebridge/protocol';
import { DAEMON_STORE_SUITE } from '../src/store-suite.js';
import { InMemoryDaemonStore, type DaemonStore, type DeliveryRecord } from '../src/store.js';

/** Run every case against `store`; return the names of the ones that failed. */
async function failures(store: () => DaemonStore): Promise<string[]> {
  const failed: string[] = [];
  for (const testCase of DAEMON_STORE_SUITE) {
    try {
      await testCase.run(store());
    } catch {
      failed.push(testCase.name);
    }
  }
  return failed;
}

/** The control: the real store fails nothing. Without this, every case below is vacuous. */
describe('the suite passes a correct store', () => {
  it('reports no failures against InMemoryDaemonStore', async () => {
    expect(await failures(() => new InMemoryDaemonStore())).toEqual([]);
  });
});

describe('the suite rejects a store with a planted defect', () => {
  it('catches a replay guard that reads and then writes instead of comparing and swapping', async () => {
    // The exact mistake `DaemonStore.tryAdvanceInboundNonce` warns about: two
    // envelopes carrying the same nonce both read the old watermark and both
    // apply. Written here as an unconditional accept, which is what the racy
    // version degrades to under the suite's sequential calls.
    const failed = await failures(() =>
      broken({ async tryAdvanceInboundNonce() { return true; } }),
    );
    expect(failed).toContain('claims an inbound nonce once and refuses it forever after');
    expect(failed).toContain('never moves the inbound watermark backwards, whatever order handlers finish in');
    expect(failed).toContain('refuses an inbound nonce that is not a non-negative safe integer');
  });

  it('catches a store that overwrites a changeset id instead of refusing it', async () => {
    // `INSERT OR REPLACE`, which is what an adapter reaches for when the first
    // insert fails in development. The result is a review bypass: a second
    // proposal inherits the reviewed one's id and its cleared status.
    const failed = await failures(() => {
      const sets = new Map<string, ChangeSet>();
      return broken({
        async putChangeSet(changeSet) {
          sets.set(changeSet.id, changeSet);
        },
        async getChangeSet(id) {
          return sets.get(id) ?? null;
        },
        async setChangeSetStatus(id, status) {
          const existing = sets.get(id);
          if (!existing) return null;
          const updated = { ...existing, status };
          sets.set(id, updated);
          return updated;
        },
      });
    });
    expect(failed).toContain('refuses to overwrite a changeset id that already exists');
    // …and the control case still passes, so the suite is distinguishing
    // "write-once" from "immutable", not simply failing everything.
    expect(failed).not.toContain('still lets the status of a stored set move, and keeps everything else');
  });

  it('catches a store that reports a missing policy as an empty allowlist', async () => {
    const failed = await failures(() =>
      broken({ async getProjectPolicy() { return { allowedPathPrefixes: [], autoApply: null }; } }),
    );
    expect(failed).toContain(
      'reports a project with no policy as null rather than as an empty allowlist',
    );
    expect(failed).toContain(
      'reports an absent link, version, policy, changeset, journal, run and apply result as absent',
    );
  });

  it('catches a store that never trims its delivery queue', async () => {
    // An adapter that wrote the INSERT and forgot the retention DELETE. It
    // behaves correctly for every short session and leaks for as long as the
    // daemon is up, which is precisely the defect no adapter author finds by
    // using their own adapter.
    const failed = await failures(() => {
      const queue: DeliveryRecord[] = [];
      let nonce = 0;
      return broken({
        async enqueueDelivery(linkId, payload) {
          nonce += 1;
          const record: DeliveryRecord = { linkId, nonce, payload, createdAt: new Date().toISOString() };
          queue.push(record);
          return record;
        },
        async nextDelivery(linkId, since) {
          return queue.find((entry) => entry.linkId === linkId && entry.nonce > since) ?? null;
        },
        async lastOutboundNonce() {
          return nonce;
        },
      });
    });
    expect(failed).toContain('keeps the delivery queue bounded — a long-lived daemon must not grow forever');
  });

  it('catches a store that loses a field when it serialises a record', async () => {
    // The failure a document-storing adapter is most likely to have: a field
    // that survives in memory and is dropped on the way to a column.
    const failed = await failures(() => {
      const store = new InMemoryDaemonStore();
      return broken(
        {
          async getRun(runId) {
            const record = await store.getRun(runId);
            if (!record) return null;
            return { ...record, contentDigest: null };
          },
        },
        store,
      );
    });
    expect(failed).toContain('round-trips a run record, attempts included');
  });
});

/** A working store with some methods replaced. */
function broken(overrides: Partial<DaemonStore>, base: DaemonStore = new InMemoryDaemonStore()): DaemonStore {
  return new Proxy(base, {
    get(target, property, receiver) {
      const override = (overrides as Record<string | symbol, unknown>)[property];
      if (typeof override === 'function') return override;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DaemonStore;
}
