/**
 * `SqliteStoragePort` against the three rules that shaped the port (ADR-005).
 *
 * The rules are stated in `packages/core/src/ports/storage.ts` as constraints on
 * *signatures* — no interactive transactions, no Postgres-only constructs, no
 * OFFSET paging — and the reason each exists is a behaviour. This file asserts
 * the behaviours, because a signature that permits the right implementation is
 * not the same thing as the right implementation.
 *
 * There is no second adapter to run these against yet — `storage-supabase` is
 * unwritten. When it lands, the cases here are the ones to lift into a shared
 * suite the way `DAEMON_STORE_SUITE` already is; until then this file says what
 * it is, which is one adapter's tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ChangeSet, Link, Run } from '@forgebridge/protocol';
import type { ChangeSet as ChangeSetType, JournalEntry } from '@forgebridge/protocol';
import type { ProjectRecord } from '@forgebridge/core';
import { createSqliteStoragePort, type SqliteStoragePort } from '../src/storage.js';

const open: SqliteStoragePort[] = [];

async function store(): Promise<SqliteStoragePort> {
  const port = await createSqliteStoragePort({ location: ':memory:' });
  open.push(port);
  return port;
}

afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: randomUUID(),
    ownerId: null,
    name: 'a shop game',
    placeId: null,
    createdAt: '2026-02-14T09:00:00.000Z',
    ...overrides,
  };
}

function changeSet(projectId: string, overrides: Record<string, unknown> = {}): ChangeSetType {
  return ChangeSet.parse({
    id: randomUUID(),
    projectId,
    baseVersion: 0,
    summary: 'add a shop script',
    operations: [
      { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("hi")' },
    ],
    status: 'validated',
    createdAt: '2026-02-14T09:00:00.000Z',
    ...overrides,
  });
}

function journalEntry(projectId: string, appliedAt: string): JournalEntry {
  return {
    id: randomUUID(),
    projectId,
    changeSetId: randomUUID(),
    summary: 'add a shop script',
    applied: [],
    inverses: [],
    versionBefore: 0,
    versionAfter: 1,
    appliedAt,
    rolledBackAt: null,
  };
}

// ── projects, and the mode ADR-005 exists for ────────────────────────────────

describe('projects', () => {
  it('stores a project with no owner, which is what signed-out means', async () => {
    // ADR-005 rejected "Supabase everywhere, anonymous sessions" because "an
    // anonymous account is still an account". A null owner is what that
    // decision looks like in a row.
    const port = await store();
    const record = project({ ownerId: null, placeId: 12345 });
    await port.projects.create(record);
    expect(await port.projects.get(record.id)).toEqual(record);
  });

  it('lists only the requested owner scope, and keeps the two scopes apart', async () => {
    const port = await store();
    const owner = randomUUID();
    const mine = project({ ownerId: owner, createdAt: '2026-02-14T09:00:00.000Z' });
    const theirs = project({ ownerId: randomUUID() });
    const anonymous = project({ ownerId: null });
    for (const record of [mine, theirs, anonymous]) await port.projects.create(record);

    const signedIn = await port.projects.list(owner, { limit: 10 });
    expect(signedIn.items.map((entry) => entry.id)).toEqual([mine.id]);

    const signedOut = await port.projects.list(null, { limit: 10 });
    expect(signedOut.items.map((entry) => entry.id)).toEqual([anonymous.id]);
  });

  it('pages by keyset, newest first, with no gaps and no repeats', async () => {
    const port = await store();
    const owner = randomUUID();
    const created: ProjectRecord[] = [];
    for (let i = 0; i < 7; i += 1) {
      const record = project({
        ownerId: owner,
        name: `project ${i}`,
        createdAt: `2026-02-1${i}T09:00:00.000Z`,
      });
      created.push(record);
      await port.projects.create(record);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Awaited<ReturnType<typeof port.projects.list>> = await port.projects.list(owner, {
        limit: 3,
        cursor,
      });
      seen.push(...result.items.map((entry) => entry.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...created].reverse().map((entry) => entry.id));
  });

  it('is stable when a row is inserted between pages', async () => {
    // The reason the port bans OFFSET: under OFFSET, an insert at the head
    // shifts every later page by one and the caller silently re-reads a row it
    // has already processed. A keyset cursor names a position, not a count.
    const port = await store();
    const owner = randomUUID();
    for (let i = 0; i < 4; i += 1) {
      await port.projects.create(project({ ownerId: owner, createdAt: `2026-02-0${i + 1}T09:00:00.000Z` }));
    }
    const first = await port.projects.list(owner, { limit: 2 });
    await port.projects.create(project({ ownerId: owner, createdAt: '2026-02-28T09:00:00.000Z' }));
    const second = await port.projects.list(owner, { limit: 2, cursor: first.nextCursor });

    const overlap = second.items.filter((entry) => first.items.some((seen) => seen.id === entry.id));
    expect(overlap).toEqual([]);
  });

  it('refuses a cursor issued by a different listing', async () => {
    // Decoded without the listing name, such a cursor is a syntactically valid
    // position in the wrong sequence — the page it returns is wrong in a way no
    // error ever mentions.
    const port = await store();
    const projectId = randomUUID();
    await port.projects.create(project({ id: projectId }));
    const projects = await port.projects.list(null, { limit: 1 });
    expect(projects.nextCursor).toBeNull();

    const run = Run.parse({
      id: randomUUID(),
      projectId,
      prompt: 'x',
      stage: 'queued',
      status: 'running',
      attempts: [],
      changeSetIds: [],
      startedAt: '2026-02-14T09:00:00.000Z',
      finishedAt: null,
    });
    await port.runs.create(run);
    await port.runs.create({ ...run, id: randomUUID(), startedAt: '2026-02-13T09:00:00.000Z' });
    const runs = await port.runs.listByProject(projectId, { limit: 1 });
    expect(runs.nextCursor).not.toBeNull();

    await expect(port.projects.list(null, { limit: 1, cursor: runs.nextCursor })).rejects.toThrow(
      /not issued by the projects listing/,
    );
    await expect(port.projects.list(null, { limit: 1, cursor: 'not base64 at all!!' })).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('renames and deletes', async () => {
    const port = await store();
    const record = project();
    await port.projects.create(record);
    await port.projects.rename(record.id, 'a tycoon game');
    expect((await port.projects.get(record.id))?.name).toBe('a tycoon game');
    await port.projects.delete(record.id);
    expect(await port.projects.get(record.id)).toBeNull();
  });
});

// ── trees ────────────────────────────────────────────────────────────────────

describe('trees', () => {
  it('starts at version zero and appends by compare-and-set', async () => {
    const port = await store();
    const projectId = randomUUID();
    expect(await port.trees.currentVersion(projectId)).toBe(0);

    expect(await port.trees.append(projectId, 0, { children: [] }, '2026-02-14T09:00:00.000Z')).toBe(1);
    expect(await port.trees.currentVersion(projectId)).toBe(1);
    // The second writer at the same expected version loses. There is no
    // last-write-wins path here by construction: the caller reports stale_base.
    expect(await port.trees.append(projectId, 0, { children: ['late'] }, '2026-02-14T09:00:01.000Z')).toBeNull();
    expect((await port.trees.get(projectId))?.instances).toEqual({ children: [] });
  });

  it('keeps every version and hands back the one asked for', async () => {
    const port = await store();
    const projectId = randomUUID();
    await port.trees.append(projectId, 0, { v: 1 }, '2026-02-14T09:00:00.000Z');
    await port.trees.append(projectId, 1, { v: 2 }, '2026-02-14T09:01:00.000Z');
    expect((await port.trees.get(projectId, 1))?.instances).toEqual({ v: 1 });
    expect((await port.trees.get(projectId))?.version).toBe(2);
    expect(await port.trees.get(projectId, 99)).toBeNull();
  });

  it('lets the consumer report a version ahead of any tree we hold', async () => {
    // The port says so plainly: recordConsumerVersion is a weaker claim than a
    // stored tree, so `get()` returns an older snapshot than `currentVersion()`
    // names. Storing an invented tree to make the two agree would be a lie
    // about what is in the user's place.
    const port = await store();
    const projectId = randomUUID();
    await port.trees.append(projectId, 0, { v: 1 }, '2026-02-14T09:00:00.000Z');
    await port.trees.recordConsumerVersion(projectId, 5, '2026-02-14T09:05:00.000Z');

    expect(await port.trees.currentVersion(projectId)).toBe(5);
    expect((await port.trees.get(projectId))?.version).toBe(1);
    // …and a set generated now must declare 5, so an append at 1 is refused.
    expect(await port.trees.append(projectId, 1, { v: 2 }, '2026-02-14T09:06:00.000Z')).toBeNull();
    expect(await port.trees.append(projectId, 5, { v: 6 }, '2026-02-14T09:06:00.000Z')).toBe(6);
  });

  it('stores the instance tree opaquely', async () => {
    // The core has no business understanding a Roblox model format, and a
    // format change must not require a core release.
    const port = await store();
    const projectId = randomUUID();
    const opaque = { anything: [1, 'two', { three: null }], nested: { deep: { deeper: true } } };
    await port.trees.append(projectId, 0, opaque, '2026-02-14T09:00:00.000Z');
    expect((await port.trees.get(projectId))?.instances).toEqual(opaque);
  });
});

// ── runs and change sets ─────────────────────────────────────────────────────

describe('runs', () => {
  it('creates, patches and lists newest first', async () => {
    const port = await store();
    const projectId = randomUUID();
    const base = Run.parse({
      id: randomUUID(),
      projectId,
      prompt: 'add a purchase handler',
      stage: 'queued',
      status: 'running',
      attempts: [],
      changeSetIds: [],
      startedAt: '2026-02-14T09:00:00.000Z',
      finishedAt: null,
    });
    await port.runs.create(base);
    await port.runs.patch(base.id, { stage: 'generating' });
    await port.runs.patch(base.id, {
      attempts: [
        {
          modelId: 'first/model:free',
          provider: 'alpha',
          outcome: 'ok',
          startedAt: '2026-02-14T09:00:00.000Z',
          endedAt: '2026-02-14T09:00:03.000Z',
        },
      ],
    });

    const stored = await port.runs.get(base.id);
    expect(stored?.stage).toBe('generating');
    expect(stored?.attempts).toHaveLength(1);
    // The prompt, which no patch touched, is unchanged.
    expect(stored?.prompt).toBe('add a purchase handler');

    const older = { ...base, id: randomUUID(), startedAt: '2026-02-13T09:00:00.000Z' };
    await port.runs.create(older);
    const page = await port.runs.listByProject(projectId, { limit: 10 });
    expect(page.items.map((run) => run.id)).toEqual([base.id, older.id]);
  });

  it('replaces the attempt list rather than appending to it', async () => {
    // Array-append semantics differ between the two backends, and the core
    // holds the authoritative list in memory for the life of the run anyway.
    const port = await store();
    const run = Run.parse({
      id: randomUUID(),
      projectId: randomUUID(),
      prompt: 'x',
      stage: 'queued',
      status: 'running',
      attempts: [],
      changeSetIds: [],
      startedAt: '2026-02-14T09:00:00.000Z',
      finishedAt: null,
    });
    await port.runs.create(run);
    const attempt = {
      modelId: 'a/b',
      provider: 'a',
      outcome: 'ok' as const,
      startedAt: '2026-02-14T09:00:00.000Z',
      endedAt: '2026-02-14T09:00:01.000Z',
    };
    await port.runs.patch(run.id, { attempts: [attempt] });
    await port.runs.patch(run.id, { attempts: [attempt, { ...attempt, modelId: 'c/d' }] });
    expect((await port.runs.get(run.id))?.attempts).toHaveLength(2);
  });

  it('ignores a patch for a run that does not exist rather than inventing one', async () => {
    const port = await store();
    await port.runs.patch(randomUUID(), { stage: 'done' });
    expect(await port.runs.get(randomUUID())).toBeNull();
  });
});

describe('change sets', () => {
  it('refuses a status change from an unexpected status', async () => {
    // The compare-and-set the port made one method: a plain setStatus turns a
    // double-approve or a double-apply into a silently destructive race.
    const port = await store();
    const projectId = randomUUID();
    const set = changeSet(projectId);
    await port.changeSets.save(set);

    expect(await port.changeSets.setStatus(set.id, 'approved', 'validated')).toBe(true);
    expect(await port.changeSets.setStatus(set.id, 'approved', 'validated')).toBe(false);
    expect((await port.changeSets.get(set.id))?.status).toBe('approved');
    expect(await port.changeSets.setStatus(randomUUID(), 'approved', 'validated')).toBe(false);
  });

  it('keeps the stored document in step with the status column', async () => {
    // The failure a document-storing adapter is most likely to have: a status
    // that moves in one place and not the other, so the diff a reviewer opens
    // still says "validated" for a set that has already applied.
    const port = await store();
    const set = changeSet(randomUUID());
    await port.changeSets.save(set);
    await port.changeSets.setStatus(set.id, 'applied', 'validated');
    expect((await port.changeSets.get(set.id))?.status).toBe('applied');
    expect((await port.changeSets.get(set.id))?.operations).toEqual(set.operations);
  });

  it('lists the sets a run proposed, and records the apply result whole', async () => {
    const port = await store();
    const projectId = randomUUID();
    const runId = randomUUID();
    const first = changeSet(projectId, { runId, createdAt: '2026-02-14T09:00:00.000Z' });
    const second = changeSet(projectId, { runId, createdAt: '2026-02-14T09:01:00.000Z' });
    await port.changeSets.save(first);
    await port.changeSets.save(second);
    await port.changeSets.save(changeSet(projectId));

    expect((await port.changeSets.listByRun(runId)).map((entry) => entry.id)).toEqual([first.id, second.id]);

    const result = {
      changeSetId: first.id,
      outcomes: [
        { index: 0, ok: true },
        { index: 1, ok: false, error: { code: 'invalid_request' as const, message: 'no such parent' } },
      ],
      newVersion: 2,
      journalId: randomUUID(),
      appliedAt: '2026-02-14T09:02:00.000Z',
      pluginVersion: '0.1.0',
    };
    await port.changeSets.recordApplyResult(first.id, result);
    // Kept whole: a partial apply is evidence, and the outcomes list is what
    // tells a user which operations landed.
    expect(await port.changeSets.getApplyResult(first.id)).toEqual(result);
    expect(await port.changeSets.getApplyResult(second.id)).toBeNull();
  });
});

// ── journal, links, policies, settings ───────────────────────────────────────

describe('journal', () => {
  it('lists newest first and marks an entry rolled back', async () => {
    const port = await store();
    const projectId = randomUUID();
    const older = journalEntry(projectId, '2026-02-13T09:00:00.000Z');
    const newer = journalEntry(projectId, '2026-02-14T09:00:00.000Z');
    await port.journal.save(older);
    await port.journal.save(newer);

    const page = await port.journal.listByProject(projectId, { limit: 10 });
    expect(page.items.map((entry) => entry.id)).toEqual([newer.id, older.id]);

    await port.journal.markRolledBack(newer.id, '2026-02-14T10:00:00.000Z');
    expect((await port.journal.get(newer.id))?.rolledBackAt).toBe('2026-02-14T10:00:00.000Z');
    expect((await port.journal.get(older.id))?.rolledBackAt).toBeNull();
  });

  it('prunes to the most recent, returns how many went, and agrees with the listing', async () => {
    // Journals are the one entity that grows without bound: a delete's inverse
    // carries the whole removed subtree (ADR-012). Prune keeps by the same
    // order the listing shows, so the two cannot disagree about which entries
    // are "the most recent".
    const port = await store();
    const projectId = randomUUID();
    const other = randomUUID();
    for (let day = 1; day <= 6; day += 1) {
      await port.journal.save(journalEntry(projectId, `2026-02-0${day}T09:00:00.000Z`));
    }
    await port.journal.save(journalEntry(other, '2026-02-01T09:00:00.000Z'));

    expect(await port.journal.prune(projectId, 2)).toBe(4);
    const kept = await port.journal.listByProject(projectId, { limit: 10 });
    expect(kept.items.map((entry) => entry.appliedAt)).toEqual([
      '2026-02-06T09:00:00.000Z',
      '2026-02-05T09:00:00.000Z',
    ]);
    // Another project's entries are untouched.
    expect((await port.journal.listByProject(other, { limit: 10 })).items).toHaveLength(1);
    expect(await port.journal.prune(projectId, 2)).toBe(0);
  });
});

describe('links, policies and settings', () => {
  it('finds a project link, changes its state and touches it', async () => {
    const port = await store();
    const projectId = randomUUID();
    const link = Link.parse({
      id: randomUUID(),
      projectId,
      transport: 'local-daemon',
      state: 'pairing',
      createdAt: '2026-02-14T09:00:00.000Z',
    });
    await port.links.save(link);
    expect((await port.links.getByProject(projectId))?.id).toBe(link.id);

    await port.links.setState(link.id, 'paired');
    expect((await port.links.get(link.id))?.state).toBe('paired');
    await port.links.touch(link.id, '2026-02-14T09:30:00.000Z');
    expect((await port.links.get(link.id))?.lastSeenAt).toBe('2026-02-14T09:30:00.000Z');

    expect(await port.links.getByProject(randomUUID())).toBeNull();
  });

  it('reports an unwritten policy as null, which the core reads as deny-all', async () => {
    const port = await store();
    const projectId = randomUUID();
    expect(await port.policies.get(projectId)).toBeNull();
    await port.policies.set(projectId, { allowedPathPrefixes: ['Workspace'], autoApply: null });
    expect((await port.policies.get(projectId))?.allowedPathPrefixes).toEqual(['Workspace']);
  });

  it('keeps settings scoped, and treats scope as a free string', async () => {
    // Scope is not an enum because settings outlive any enum the core would
    // guess today. An adapter with a CHECK constraint here would quietly turn
    // that sentence into a lie.
    const port = await store();
    await port.settings.set('install', 'theme', 'dark');
    await port.settings.set('user:42', 'theme', 'light');
    await port.settings.set('project:xyz/experimental', 'autoApply', 'false');

    expect(await port.settings.get('install', 'theme')).toBe('dark');
    expect(await port.settings.get('user:42', 'theme')).toBe('light');
    expect(await port.settings.get('user:99', 'theme')).toBeNull();
    expect(await port.settings.list('project:xyz/experimental')).toEqual({ autoApply: 'false' });

    await port.settings.delete('install', 'theme');
    expect(await port.settings.get('install', 'theme')).toBeNull();
    // Deleting what is not there is not an error: the caller is expressing an
    // end state, not a transition.
    await port.settings.delete('install', 'theme');
  });
});
