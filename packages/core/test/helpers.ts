import { ChangeSet, Link } from '@forgebridge/protocol';
import type { ApplyResult, ChangeSet as ChangeSetType, JournalEntry, Run } from '@forgebridge/protocol';
import type {
  ChangeSetStore,
  JournalStore,
  LinkStore,
  Page,
  PageRequest,
  PolicyStore,
  ProjectRecord,
  ProjectStore,
  RunPatch,
  RunStore,
  SettingsStore,
  StoragePort,
  TransportPort,
  TreeSnapshot,
  TreeStore,
} from '../src/ports/index.js';
import type { ProjectPolicy } from '../src/policy.js';

/** A clock the test drives by hand. Nothing here ever sleeps. */
export function fixedClock(startMs = Date.parse('2026-08-26T00:00:00.000Z')) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

export function uuid(n: number): string {
  const tail = n.toString(16).padStart(12, '0');
  return `11111111-1111-4111-8111-${tail}`;
}

export const PROJECT_ID = uuid(1);

export interface MakeSetOptions {
  id?: string;
  projectId?: string;
  runId?: string;
  baseVersion?: number;
  summary?: string;
}

export function makeChangeSet(operations: unknown[], options: MakeSetOptions = {}): ChangeSetType {
  return ChangeSet.parse({
    id: options.id ?? uuid(900),
    projectId: options.projectId ?? PROJECT_ID,
    ...(options.runId ? { runId: options.runId } : {}),
    baseVersion: options.baseVersion ?? 0,
    summary: options.summary ?? 'a test change',
    operations,
    createdAt: '2026-08-26T00:00:00.000Z',
  });
}

export function createOp(path: string, className = 'Folder') {
  return { op: 'createInstance', path, className, properties: {} };
}

export function deleteOp(path: string) {
  return { op: 'deleteInstance', path };
}

export function scriptOp(path: string, source = 'print("hi")') {
  return { op: 'writeScript', path, scriptType: 'ModuleScript', source };
}

export function moveOp(path: string, to: string) {
  return { op: 'moveInstance', path, to };
}

/**
 * A setProperty whose *value* names another instance.
 *
 * The operation's own `path` is the thing being written; `ref` is a second path
 * that appears nowhere else in the operation. `pathsOf` reports both, which is
 * the only reason the policy allowlist ever sees the second one.
 */
export function refOp(path: string, ref: string, property = 'PrimaryPart') {
  return { op: 'setProperty', path, property, value: { t: 'InstanceRef', path: ref } };
}

/** A createInstance carrying an InstanceRef inside its property bag. */
export function createRefOp(path: string, ref: string, property = 'PrimaryPart') {
  return {
    op: 'createInstance',
    path,
    className: 'Model',
    properties: { [property]: { t: 'InstanceRef', path: ref } },
  };
}

export function pairedLink(projectId = PROJECT_ID) {
  return Link.parse({
    id: uuid(2),
    projectId,
    transport: 'local-daemon',
    state: 'paired',
    createdAt: '2026-08-26T00:00:00.000Z',
  });
}

/**
 * An in-memory StoragePort. It exists to prove the pipeline drives the port
 * correctly; it is not a reference adapter, and it deliberately implements the
 * compare-and-set methods honestly so a double-apply test can fail.
 */
export class MemoryStorage implements StoragePort {
  readonly projectRows = new Map<string, ProjectRecord>();
  readonly runRows = new Map<string, Run>();
  readonly setRows = new Map<string, ChangeSetType>();
  readonly applyRows = new Map<string, ApplyResult>();
  readonly journalRows = new Map<string, JournalEntry>();
  readonly linkRows = new Map<string, Link>();
  readonly policyRows = new Map<string, ProjectPolicy>();
  readonly settingRows = new Map<string, string>();
  readonly treeVersions = new Map<string, number>();
  readonly treeRows = new Map<string, TreeSnapshot>();

  projects: ProjectStore = {
    get: async (id) => this.projectRows.get(id) ?? null,
    create: async (project) => void this.projectRows.set(project.id, project),
    rename: async (id, name) => {
      const row = this.projectRows.get(id);
      if (row) this.projectRows.set(id, { ...row, name });
    },
    list: async (ownerId, page) =>
      pageOf([...this.projectRows.values()].filter((row) => row.ownerId === ownerId), page),
    delete: async (id) => void this.projectRows.delete(id),
  };

  trees: TreeStore = {
    currentVersion: async (projectId) => this.treeVersions.get(projectId) ?? 0,
    get: async (projectId) => this.treeRows.get(projectId) ?? null,
    append: async (projectId, expectedVersion, instances, capturedAt) => {
      const current = this.treeVersions.get(projectId) ?? 0;
      if (current !== expectedVersion) return null;
      const next = current + 1;
      this.treeVersions.set(projectId, next);
      this.treeRows.set(projectId, { projectId, version: next, instances, capturedAt });
      return next;
    },
    recordConsumerVersion: async (projectId, version) => void this.treeVersions.set(projectId, version),
  };

  runs: RunStore = {
    create: async (run) => void this.runRows.set(run.id, { ...run }),
    get: async (id) => {
      const row = this.runRows.get(id);
      return row ? { ...row } : null;
    },
    patch: async (id, patch: RunPatch) => {
      const row = this.runRows.get(id);
      if (row) this.runRows.set(id, { ...row, ...patch });
    },
    listByProject: async (projectId, page) =>
      pageOf([...this.runRows.values()].filter((row) => row.projectId === projectId), page),
  };

  changeSets: ChangeSetStore = {
    save: async (set) => void this.setRows.set(set.id, set),
    get: async (id) => this.setRows.get(id) ?? null,
    setStatus: async (id, next, expected) => {
      const row = this.setRows.get(id);
      if (!row || row.status !== expected) return false;
      this.setRows.set(id, { ...row, status: next });
      return true;
    },
    recordApplyResult: async (id, result) => void this.applyRows.set(id, result),
    getApplyResult: async (id) => this.applyRows.get(id) ?? null,
    listByRun: async (runId) => [...this.setRows.values()].filter((row) => row.runId === runId),
  };

  journal: JournalStore = {
    save: async (entry) => void this.journalRows.set(entry.id, entry),
    get: async (id) => this.journalRows.get(id) ?? null,
    listByProject: async (projectId, page) =>
      pageOf([...this.journalRows.values()].filter((row) => row.projectId === projectId), page),
    markRolledBack: async (id, at) => {
      const row = this.journalRows.get(id);
      if (row) this.journalRows.set(id, { ...row, rolledBackAt: at });
    },
    prune: async () => 0,
  };

  links: LinkStore = {
    getByProject: async (projectId) =>
      [...this.linkRows.values()].find((row) => row.projectId === projectId) ?? null,
    get: async (id) => this.linkRows.get(id) ?? null,
    save: async (link) => void this.linkRows.set(link.id, link),
    setState: async (id, state) => {
      const row = this.linkRows.get(id);
      if (row) this.linkRows.set(id, { ...row, state });
    },
    touch: async (id, lastSeenAt) => {
      const row = this.linkRows.get(id);
      if (row) this.linkRows.set(id, { ...row, lastSeenAt });
    },
  };

  policies: PolicyStore = {
    get: async (projectId) => this.policyRows.get(projectId) ?? null,
    set: async (projectId, policy) => void this.policyRows.set(projectId, policy),
  };

  settings: SettingsStore = {
    get: async (scope, key) => this.settingRows.get(`${scope}::${key}`) ?? null,
    set: async (scope, key, value) => void this.settingRows.set(`${scope}::${key}`, value),
    delete: async (scope, key) => void this.settingRows.delete(`${scope}::${key}`),
    list: async (scope) => {
      const out: Record<string, string> = {};
      for (const [composite, value] of this.settingRows) {
        if (composite.startsWith(`${scope}::`)) out[composite.slice(scope.length + 2)] = value;
      }
      return out;
    },
  };
}

function pageOf<T>(items: T[], page: PageRequest): Page<T> {
  return { items: items.slice(0, page.limit), nextCursor: null };
}

export interface MemoryTransportOptions {
  link?: Link | null;
  result?: (set: ChangeSetType) => unknown;
  failAwait?: Error;
}

export class MemoryTransport implements TransportPort {
  readonly delivered: ChangeSetType[] = [];
  #options: MemoryTransportOptions;

  constructor(options: MemoryTransportOptions = {}) {
    this.#options = options;
  }

  describe() {
    return { kind: 'local-daemon' as const, posture: 'Local — nothing leaves this machine' };
  }

  async status(projectId: string): Promise<Link | null> {
    if (this.#options.link === null) return null;
    return this.#options.link ?? pairedLink(projectId);
  }

  async deliver(link: Link, set: ChangeSetType) {
    this.delivered.push(set);
    return { linkId: link.id, nonce: this.delivered.length, deliveredAt: '2026-08-26T00:00:10.000Z' };
  }

  async awaitApplyResult(changeSetId: string): Promise<ApplyResult> {
    if (this.#options.failAwait) throw this.#options.failAwait;
    const set = this.delivered.find((candidate) => candidate.id === changeSetId);
    if (!set) throw new Error(`nothing was delivered for ${changeSetId}`);
    const built = this.#options.result
      ? this.#options.result(set)
      : {
          changeSetId,
          outcomes: set.operations.map((_operation, index) => ({ index, ok: true })),
          newVersion: set.baseVersion + 1,
          journalId: uuid(500),
          appliedAt: '2026-08-26T00:00:20.000Z',
          pluginVersion: '2.0.0',
        };
    return built as ApplyResult;
  }

  async readOutput() {
    return [];
  }
}
