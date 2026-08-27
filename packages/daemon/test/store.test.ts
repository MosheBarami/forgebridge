/**
 * `InMemoryDaemonStore` against the shared store suite (ADR-005, M40).
 *
 * The cases used to live in this file. They now live in
 * `../src/store-suite.ts`, because ADR-005's argument for a port with two
 * adapters is that "adapter parity is testable — one suite, two backends, both
 * green or the build fails", and a suite that lives inside one adapter's test
 * file cannot deliver that. The SQLite adapter runs the same array, from the
 * same module, in `packages/storage-sqlite/test/parity.test.ts`.
 *
 * What stays here: the properties that are true of *this* implementation and
 * are not part of the port's contract — the injected clock, and the fact that a
 * Map read and write cannot be interleaved without an `await` between them.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DAEMON_STORE_SUITE, suiteLink } from '../src/store-suite.js';
import { InMemoryDaemonStore } from '../src/store.js';

describe('InMemoryDaemonStore satisfies the shared store suite', () => {
  for (const testCase of DAEMON_STORE_SUITE) {
    it(testCase.name, async () => {
      // A fresh store per case: a suite whose cases can see each other's writes
      // is a suite whose failures depend on ordering.
      try {
        await testCase.run(new InMemoryDaemonStore());
      } catch (error) {
        // The `why` is attached on the way past because a parity failure is
        // usually read by whoever wrote the *other* adapter.
        if (error instanceof Error) error.message = `${error.message}\n\nwhy this matters: ${testCase.why}`;
        throw error;
      }
    });
  }
});

describe('InMemoryDaemonStore, beyond the shared contract', () => {
  it('stamps deliveries with the injected clock rather than reading the wall clock', async () => {
    // Not a suite case: a persistent adapter is free to let SQLite stamp the
    // row. What the port promises is an ISO timestamp, which the suite checks.
    const store = new InMemoryDaemonStore({ now: () => Date.parse('2026-02-14T09:00:00.000Z') });
    const record = await store.enqueueDelivery(randomUUID(), {
      kind: 'rollback',
      journalId: randomUUID(),
      changeSetId: randomUUID(),
      expectedVersion: 0,
      restoresToVersion: 0,
      steps: [{ index: 0, inverse: { inverse: 'deleteCreated', path: 'Workspace.Scratch' } }],
    });
    expect(record.createdAt).toBe('2026-02-14T09:00:00.000Z');
  });

  it('holds links by reference-free copy, so a caller mutating its own object cannot rewrite the store', async () => {
    const store = new InMemoryDaemonStore();
    const link = suiteLink({ state: 'paired' });
    await store.putLink(link);
    await store.patchLink(link.id, { state: 'revoked' });
    // The caller's object is untouched: `patchLink` builds a new record.
    expect(link.state).toBe('paired');
    expect((await store.getLink(link.id))?.state).toBe('revoked');
  });
});
