import { describe, expect, it } from 'vitest';
import { SERVICE_ROOTS } from '@forgebridge/protocol';

import type { Collection, StoragePort, StoredRecord } from '@/lib/storage';
import {
  exportProject,
  newProjectId,
  parsePlaceId,
  ProjectStore,
  PROJECT_EXPORT_FORMAT,
  validateName,
  validatePathPrefix,
  type ProjectRecord,
} from '@/lib/projects/store';

/**
 * The project record and the rules around it (M34).
 *
 * The validation tests matter more than the CRUD ones: a path prefix that this
 * app accepts and the policy layer later rejects is a scope the user was told
 * was saved, enforced by something that disagrees.
 */

/** An in-memory `StoragePort`, so these tests need no IndexedDB. */
class MemoryStorage implements StoragePort {
  readonly kind = 'local' as const;
  private readonly data = new Map<Collection, Map<string, StoredRecord>>();
  /** Monotonic, so `updatedAt` ordering is deterministic rather than clock-dependent. */
  private tick = 0;

  private bucket(collection: Collection): Map<string, StoredRecord> {
    let found = this.data.get(collection);
    if (!found) {
      found = new Map();
      this.data.set(collection, found);
    }
    return found;
  }

  async get<T extends StoredRecord>(collection: Collection, id: string): Promise<T | null> {
    return (this.bucket(collection).get(id) as T | undefined) ?? null;
  }

  async list<T extends StoredRecord>(collection: Collection): Promise<T[]> {
    return [...this.bucket(collection).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) as T[];
  }

  async put<T extends StoredRecord>(collection: Collection, record: Omit<T, 'updatedAt'>): Promise<T> {
    this.tick += 1;
    const stamped = { ...record, updatedAt: `2026-08-27T10:00:${String(this.tick).padStart(2, '0')}.000Z` } as T;
    this.bucket(collection).set(stamped.id, stamped);
    return stamped;
  }

  async delete(collection: Collection, id: string): Promise<void> {
    this.bucket(collection).delete(id);
  }

  async clear(collection: Collection): Promise<void> {
    this.bucket(collection).clear();
  }

  async exportAll(): Promise<Record<Collection, StoredRecord[]>> {
    return { projects: await this.list('projects'), settings: [], changesets: [], runs: [], journal: [] };
  }
}

describe('path prefixes are validated by the protocol, not by a second regex', () => {
  it('accepts a real instance path', () => {
    expect(validatePathPrefix('ServerScriptService.Shop')).toEqual({
      ok: true,
      value: 'ServerScriptService.Shop',
    });
  });

  it('accepts a bare service root', () => {
    expect(validatePathPrefix('Workspace').ok).toBe(true);
  });

  it('refuses a root the protocol does not consider addressable', () => {
    const result = validatePathPrefix('Players.LocalPlayer');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/addressable service root/);
  });

  it('refuses a segment that is not a safe identifier', () => {
    // This is the restriction that stops an instance name from smuggling a `.`
    // past a prefix check — the hole that turns a path allowlist into nothing.
    const result = validatePathPrefix('Workspace.My Model');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/safe identifier/);
  });

  it('trims surrounding whitespace rather than rejecting a pasted path', () => {
    expect(validatePathPrefix('  Workspace.Spawn  ')).toEqual({ ok: true, value: 'Workspace.Spawn' });
  });

  it('offers exactly the protocol’s service roots for a picker', async () => {
    const { PATH_ROOTS } = await import('@/lib/projects/store');
    expect(PATH_ROOTS).toEqual(SERVICE_ROOTS);
  });
});

describe('place ids', () => {
  it('treats an empty field as “not stated”, not as zero', () => {
    // A place id of zero is not "no place", and a field that cannot tell them
    // apart is a field that will eventually be sent as one.
    expect(parsePlaceId('')).toEqual({ ok: true, value: null });
    expect(parsePlaceId('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts a large positive integer', () => {
    expect(parsePlaceId('7654321098')).toEqual({ ok: true, value: 7_654_321_098 });
  });

  it('refuses zero, negatives and anything non-numeric', () => {
    expect(parsePlaceId('0').ok).toBe(false);
    expect(parsePlaceId('-5').ok).toBe(false);
    expect(parsePlaceId('12.5').ok).toBe(false);
    expect(parsePlaceId('abc').ok).toBe(false);
  });
});

describe('names', () => {
  it('trims and requires something left over', () => {
    expect(validateName('  Tycoon  ')).toEqual({ ok: true, value: 'Tycoon' });
    expect(validateName('   ').ok).toBe(false);
    expect(validateName('x'.repeat(81)).ok).toBe(false);
  });
});

describe('generated ids', () => {
  it('produces a well-formed v4 uuid the daemon’s schema would accept', () => {
    // The daemon parses `projectId` with `z.string().uuid()`. Thirty-two random
    // hex characters would be refused, so the version and variant bits matter.
    for (let i = 0; i < 20; i += 1) {
      expect(newProjectId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe('the store', () => {
  it('creates, lists newest first, and deletes', async () => {
    const store = new ProjectStore(new MemoryStorage());

    const first = await store.create({ name: 'One', placeId: null, allowedPathPrefixes: [] });
    const second = await store.create({ name: 'Two', placeId: 123, allowedPathPrefixes: ['Workspace'] });

    expect((await store.list()).map((p) => p.id)).toEqual([second.id, first.id]);

    await store.delete(first.id);
    expect(await store.get(first.id)).toBeNull();
    expect((await store.list()).map((p) => p.name)).toEqual(['Two']);
  });

  it('adopts a supplied id, so a project can be created on the daemon’s own', async () => {
    const store = new ProjectStore(new MemoryStorage());
    const daemonId = '44444444-4444-4444-8444-444444444444';

    const created = await store.create({
      name: 'The daemon’s project',
      placeId: null,
      allowedPathPrefixes: [],
      id: daemonId,
    });

    expect(created.id).toBe(daemonId);
  });

  it('starts with no observed version rather than pretending it saw zero', async () => {
    const store = new ProjectStore(new MemoryStorage());
    const created = await store.create({ name: 'One', placeId: null, allowedPathPrefixes: [] });

    expect(created.treeSnapshotVersion).toBe(0);
    // The distinction the UI renders: "version 0" and "never observed" are
    // different facts about a project.
    expect(created.versionObservedAt).toBeNull();
  });

  it('moves the observed version forward and never backwards', async () => {
    const store = new ProjectStore(new MemoryStorage());
    const created = await store.create({ name: 'One', placeId: null, allowedPathPrefixes: [] });

    await store.observeVersion(created.id, 7);
    expect((await store.get(created.id))?.treeSnapshotVersion).toBe(7);

    // A diff for an older ChangeSet reports the version at the time it is read,
    // so out-of-order reads are normal. Letting one lower the number would make
    // the projects list flicker backwards for no reason a user could explain.
    await store.observeVersion(created.id, 3);
    expect((await store.get(created.id))?.treeSnapshotVersion).toBe(7);

    await store.observeVersion(created.id, 9);
    expect((await store.get(created.id))?.treeSnapshotVersion).toBe(9);
  });

  it('records version 0 the first time it is genuinely observed', async () => {
    const store = new ProjectStore(new MemoryStorage());
    const created = await store.create({ name: 'One', placeId: null, allowedPathPrefixes: [] });

    await store.observeVersion(created.id, 0);
    const after = await store.get(created.id);

    expect(after?.treeSnapshotVersion).toBe(0);
    // The timestamp is what changed: the browser has now actually seen a
    // version, which it had not before.
    expect(after?.versionObservedAt).not.toBeNull();
  });

  it('updates the mutable fields and leaves identity alone', async () => {
    const store = new ProjectStore(new MemoryStorage());
    const created = await store.create({ name: 'One', placeId: null, allowedPathPrefixes: [] });

    const updated = await store.update(created.id, {
      name: 'Renamed',
      allowedPathPrefixes: ['ServerScriptService.Shop'],
    });

    expect(updated?.id).toBe(created.id);
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(updated?.name).toBe('Renamed');
    expect(updated?.allowedPathPrefixes).toEqual(['ServerScriptService.Shop']);
  });

  it('returns null when updating something that is not there', async () => {
    const store = new ProjectStore(new MemoryStorage());
    expect(await store.update('missing', { name: 'x' })).toBeNull();
  });
});

describe('export', () => {
  it('produces a versioned envelope M33 can read back', async () => {
    const store = new ProjectStore(new MemoryStorage());
    const created = await store.create({ name: 'One', placeId: 5, allowedPathPrefixes: ['Workspace'] });

    const exported = exportProject(created as ProjectRecord);

    expect(exported.format).toBe(PROJECT_EXPORT_FORMAT);
    expect(exported.project).toEqual(created);
    expect(Date.parse(exported.exportedAt)).not.toBeNaN();
  });
});
