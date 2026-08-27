'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createStorage, StorageUnavailableError, type StoredRecord } from '@/lib/storage';
import { ProjectStore, type ProjectDraft, type ProjectRecord } from './store';

/**
 * Reading and writing projects from a component (M34).
 *
 * Three things this deliberately does:
 *
 * 1. **It treats "storage is unavailable" as a state, not a crash.** A private
 *    window with site data blocked, a full quota, or a second tab holding an
 *    older schema open all produce `StorageUnavailableError` — and for a
 *    signed-out product whose entire persistence layer is IndexedDB, that is a
 *    fact the user has to be told rather than a promise rejection in a console
 *    they are not reading.
 *
 * 2. **It keeps the selected project in the same store as the projects.** Not
 *    `localStorage`: a selection that survives in one place while the projects
 *    it points at live in another is a selection that outlives its target. The
 *    `settings` collection is already in `COLLECTIONS` for this.
 *
 * 3. **It never caches across a mount.** `list()` is one IndexedDB read of a
 *    handful of records. A module-level cache would be a second copy of the
 *    truth, and two tabs of this app would disagree about it silently.
 */

/** The one settings record this surface owns. Namespaced so M38 can add its own. */
const SELECTION_ID = 'projects.selection';

interface SelectionRecord extends StoredRecord {
  readonly id: typeof SELECTION_ID;
  readonly projectId: string | null;
}

export type ProjectsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'ready'; readonly projects: readonly ProjectRecord[]; readonly selectedId: string | null };

export interface ProjectsValue {
  readonly state: ProjectsState;
  readonly create: (draft: ProjectDraft) => Promise<ProjectRecord | null>;
  readonly update: (
    id: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'placeId' | 'allowedPathPrefixes'>>,
  ) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly select: (id: string | null) => Promise<void>;
  /** Record a project version this browser just observed on a diff. */
  readonly observeVersion: (id: string, version: number) => Promise<void>;
  readonly reload: () => void;
}

function detailOf(error: unknown): string {
  if (error instanceof StorageUnavailableError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function useProjects(): ProjectsValue {
  // The adapter is constructed once per mount and opens its database lazily, so
  // this does not touch the disk during render.
  const store = useMemo(() => {
    const storage = createStorage();
    return { projects: new ProjectStore(storage), storage };
  }, []);

  const [state, setState] = useState<ProjectsState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  // Guards a setState after unmount, and lets a slow load be ignored once a
  // newer one has answered.
  const generation = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const [projects, selection] = await Promise.all([
          store.projects.list(),
          store.storage.get<SelectionRecord>('settings', SELECTION_ID),
        ]);
        if (current !== generation.current) return;

        // A selection pointing at a deleted project is dropped rather than
        // shown as a project that is not there. It is not written back here —
        // a read should not cause a write — so it is simply not honoured.
        const selectedId =
          selection?.projectId && projects.some((project) => project.id === selection.projectId)
            ? selection.projectId
            : null;

        setState({ kind: 'ready', projects, selectedId });
      } catch (error) {
        if (current !== generation.current) return;
        setState({ kind: 'unavailable', detail: detailOf(error) });
      }
    })();

    return () => {
      generation.current += 1;
    };
  }, [store, nonce]);

  const create = useCallback(
    async (draft: ProjectDraft): Promise<ProjectRecord | null> => {
      try {
        const created = await store.projects.create(draft);
        // A newly created project becomes the selected one. The alternative —
        // create it and leave the selection where it was — means the next run
        // is attributed to a project the user just navigated away from.
        await store.storage.put<SelectionRecord>('settings', {
          id: SELECTION_ID,
          projectId: created.id,
        });
        reload();
        return created;
      } catch (error) {
        setState({ kind: 'unavailable', detail: detailOf(error) });
        return null;
      }
    },
    [store, reload],
  );

  const update = useCallback(
    async (
      id: string,
      patch: Partial<Pick<ProjectRecord, 'name' | 'placeId' | 'allowedPathPrefixes'>>,
    ): Promise<void> => {
      try {
        await store.projects.update(id, patch);
        reload();
      } catch (error) {
        setState({ kind: 'unavailable', detail: detailOf(error) });
      }
    },
    [store, reload],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await store.projects.delete(id);
        const selection = await store.storage.get<SelectionRecord>('settings', SELECTION_ID);
        if (selection?.projectId === id) {
          await store.storage.put<SelectionRecord>('settings', { id: SELECTION_ID, projectId: null });
        }
        reload();
      } catch (error) {
        setState({ kind: 'unavailable', detail: detailOf(error) });
      }
    },
    [store, reload],
  );

  const select = useCallback(
    async (id: string | null): Promise<void> => {
      try {
        await store.storage.put<SelectionRecord>('settings', { id: SELECTION_ID, projectId: id });
        reload();
      } catch (error) {
        setState({ kind: 'unavailable', detail: detailOf(error) });
      }
    },
    [store, reload],
  );

  const observeVersion = useCallback(
    async (id: string, version: number): Promise<void> => {
      try {
        await store.projects.observeVersion(id, version);
        reload();
      } catch {
        // Deliberately swallowed. This is a bookkeeping write that happens as a
        // side effect of reading a diff; failing it must not take down the diff
        // the user is in the middle of approving. The recorded version is
        // stale, which the UI already labels with when it was observed.
      }
    },
    [store, reload],
  );

  return useMemo(
    () => ({ state, create, update, remove, select, observeVersion, reload }),
    [state, create, update, remove, select, observeVersion, reload],
  );
}

/** The selected project, or null. A helper so callers do not re-derive it. */
export function selectedProject(state: ProjectsState): ProjectRecord | null {
  if (state.kind !== 'ready' || state.selectedId === null) return null;
  return state.projects.find((project) => project.id === state.selectedId) ?? null;
}
