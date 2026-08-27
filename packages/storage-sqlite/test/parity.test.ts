/**
 * The parity test (M40, ADR-005).
 *
 * ADR-005's third rationale is that "adapter parity is testable — one suite,
 * two backends, both green or the build fails", and its revisit trigger is
 * *"If adapter parity tests start being skipped for SQLite, the abstraction has
 * failed and local mode should become an explicitly reduced feature set rather
 * than a fake peer."* This file is the SQLite half of that sentence:
 * `DAEMON_STORE_SUITE` is the array `packages/daemon/test/store.test.ts` runs
 * against `InMemoryDaemonStore`, imported here and run against the SQLite
 * adapter. Neither host can pass by having its own version of a case.
 *
 * It is imported from the daemon's *source* rather than from its built package
 * on purpose. A parity claim about a suite read out of a stale `dist/` is a
 * claim about whatever that build contained, which is not the same thing as
 * "the same suite".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DAEMON_STORE_SUITE, suiteChangeSet, suiteLink } from '../../daemon/src/store-suite.js';
import { createSqliteDaemonStore, type SqliteDaemonStore } from '../src/store.js';

const open: SqliteDaemonStore[] = [];
const directories: string[] = [];

async function memoryStore(): Promise<SqliteDaemonStore> {
  const store = await createSqliteDaemonStore({ location: ':memory:' });
  open.push(store);
  return store;
}

/** A real file in a real directory, for the cases that must survive a reopen. */
function scratchFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'forgebridge-parity-'));
  directories.push(directory);
  return path.join(directory, 'daemon.sqlite');
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SqliteDaemonStore satisfies the shared store suite', () => {
  for (const testCase of DAEMON_STORE_SUITE) {
    it(testCase.name, async () => {
      const store = await memoryStore();
      try {
        await testCase.run(store);
      } catch (error) {
        if (error instanceof Error) error.message = `${error.message}\n\nwhy this matters: ${testCase.why}`;
        throw error;
      }
    });
  }
});

describe('the suite is the same suite', () => {
  it('runs every case the in-memory store runs, and at least the ones that were there before', () => {
    // A parity test that silently ran zero cases would be green. This is the
    // assertion that makes the loop above mean something: the array is
    // non-empty, and it still contains the invariants the daemon's own tests
    // asserted before the suite was extracted.
    expect(DAEMON_STORE_SUITE.length).toBeGreaterThanOrEqual(20);
    const names = DAEMON_STORE_SUITE.map((entry) => entry.name);
    expect(names).toContain('refuses to overwrite a changeset id that already exists');
    expect(names).toContain('refuses to overwrite a journal id that already exists');
    expect(names).toContain('claims an inbound nonce once and refuses it forever after');
    expect(names).toContain('keeps the delivery queue bounded — a long-lived daemon must not grow forever');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('SqliteDaemonStore, where being on disk is the point', () => {
  it('still knows everything after the process that wrote it has gone', async () => {
    // The property the in-memory store cannot have, and the reason this adapter
    // exists: a daemon that restarts mid-review must still be able to show the
    // ChangeSet the reviewer was looking at.
    const location = scratchFile();
    const first = await createSqliteDaemonStore({ location });
    const link = suiteLink({ state: 'paired' });
    const changeSet = suiteChangeSet();
    await first.putLink(link);
    await first.putChangeSet(changeSet);
    await first.setProjectVersion(link.projectId, 4);
    await first.tryAdvanceInboundNonce(link.id, 9);
    await first.enqueueDelivery(link.id, {
      kind: 'changeset',
      changeSet,
    });
    first.close();

    const second = await createSqliteDaemonStore({ location });
    open.push(second);
    expect((await second.getLink(link.id))?.id).toBe(link.id);
    expect((await second.getChangeSet(changeSet.id))?.operations).toEqual(changeSet.operations);
    expect(await second.getProjectVersion(link.projectId)).toBe(4);
    // The replay watermark survives too. A watermark that reset on restart
    // would re-admit every envelope the daemon had already accepted.
    expect(await second.lastInboundNonce(link.id)).toBe(9);
    expect(await second.tryAdvanceInboundNonce(link.id, 9)).toBe(false);
    expect((await second.nextDelivery(link.id, 0))?.nonce).toBe(1);
  });

  it('refuses a nonce claimed by another connection to the same file', async () => {
    // The in-memory store's atomicity argument is "a Map read and write cannot
    // be interleaved without an await between them", which says nothing about a
    // second process. SQLite's write lock is what covers that case, and this is
    // the closest a single-process test can get to asserting it.
    const location = scratchFile();
    const one = await createSqliteDaemonStore({ location });
    const two = await createSqliteDaemonStore({ location });
    open.push(one, two);

    const linkId = randomUUID();
    expect(await one.tryAdvanceInboundNonce(linkId, 7)).toBe(true);
    expect(await two.tryAdvanceInboundNonce(linkId, 7)).toBe(false);
    expect(await two.tryAdvanceInboundNonce(linkId, 8)).toBe(true);
    expect(await one.lastInboundNonce(linkId)).toBe(8);
  });

  it('refuses a second changeset under a taken id even across connections', async () => {
    // Write-once has to hold against a racing *process*, not just a racing
    // handler — which is why the adapter leans on the primary key instead of
    // checking first and hoping.
    const location = scratchFile();
    const one = await createSqliteDaemonStore({ location });
    const two = await createSqliteDaemonStore({ location });
    open.push(one, two);

    const changeSet = suiteChangeSet();
    await one.putChangeSet(changeSet);
    await expect(two.putChangeSet(suiteChangeSet({ id: changeSet.id }))).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });
});
