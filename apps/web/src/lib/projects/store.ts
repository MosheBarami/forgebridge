import { InstancePath, SERVICE_ROOTS } from '@forgebridge/protocol';

import type { Collection, StoragePort, StoredRecord } from '@/lib/storage';

/**
 * A project, as this app stores it (M34).
 *
 * Owned by the projects and generation surfaces. It lives under `lib/` rather
 * than beside a page because both of them need it: the generation surface picks
 * the project a run is attributed to, and writes the observed tree version back
 * after it reads a diff.
 *
 * ── What a project is here, and what it deliberately is not ────────────────
 *
 * The daemon has **no project resource**. Its whole notion of a project is a
 * uuid it generates once per process (`defaultProjectId`), a version counter
 * (`getProjectVersion`) and a path policy (`getProjectPolicy`) — there is no
 * `POST /v1/projects`, no list, no delete. `packages/daemon/src/server.ts` has
 * the entire route table and none of it is about projects.
 *
 * So a project in this app is a **local naming of a wire identifier**, and the
 * honest consequences of that are visible in this file rather than papered over:
 *
 *   - `id` is the uuid that goes on the wire as `StartRunRequest.projectId`.
 *     It is the project, as far as the daemon is concerned.
 *   - `allowedPathPrefixes` is what the *user* intends to allow. The daemon
 *     enforces its own policy, taken from `--allowed-paths` at startup, and it
 *     does not read this field — nothing on `/v1` can set a project policy. So
 *     this is recorded as intent and rendered as intent (`project.policyNote`),
 *     never as a guarantee. TODO(M38): when the daemon grows a route that sets
 *     `ProjectPolicy`, push this through it and re-word that string.
 *   - `treeSnapshotVersion` is the last version *this browser observed*, from
 *     `ChangeSetDiff.currentVersion`. It is not a snapshot of a tree — the
 *     daemon holds no tree, which it declares as `treeAware: false` on every
 *     diff — and the field name says "version", not "tree", for that reason.
 *     TODO(M09/M37): a real snapshot arrives when a consumer reports one.
 *
 * Storage is the ADR-005 port, so all of this works with no account, and M33's
 * adoption of local state into an account gets a `list` to walk.
 */

const COLLECTION: Collection = 'projects';

export interface ProjectRecord extends StoredRecord {
  /** The uuid sent as `projectId`. Immutable: it is the identity, not a label. */
  readonly id: string;
  readonly name: string;
  /**
   * The Roblox place this project is about, when the user knows it.
   *
   * Null rather than 0: a place id of zero is not "no place", and a field that
   * cannot tell them apart is a field that will eventually be sent as one.
   */
  readonly placeId: number | null;
  /** Intent, not enforcement — see the note above. Validated as instance paths. */
  readonly allowedPathPrefixes: readonly string[];
  /** Last `currentVersion` this browser saw on a diff for this project. */
  readonly treeSnapshotVersion: number;
  /** When this browser observed that version, or null if it never has. */
  readonly versionObservedAt: string | null;
  readonly createdAt: string;
  /** Stamped by the storage adapter on every put. Never written by a caller. */
  readonly updatedAt: string;
}

/** A project the user is composing. `id` is assigned on save. */
export interface ProjectDraft {
  readonly name: string;
  readonly placeId: number | null;
  readonly allowedPathPrefixes: readonly string[];
  /** Supplied when adopting the daemon's own project id; otherwise generated. */
  readonly id?: string;
}

// ── validation ──────────────────────────────────────────────────────────────

export const MAX_NAME_LENGTH = 80;

/**
 * Roblox place ids are positive integers, and they are large — comfortably past
 * 2^32 for anything created recently, which is why this is bounded by
 * `MAX_SAFE_INTEGER` rather than by a 32-bit limit somebody half-remembers.
 */
export function parsePlaceId(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false };
  return { ok: true, value };
}

/**
 * A path prefix is validated with the protocol's own `InstancePath`, not with a
 * regex written here.
 *
 * That matters more than it looks. `path.ts` restricts segments to safe
 * identifiers *specifically* so a Roblox instance name cannot smuggle a `.`
 * past a prefix check, and it pins the addressable service roots. A second,
 * looser validator in this app would accept prefixes the policy layer will
 * later reject — telling the user their scope was saved when the thing that
 * enforces scope disagrees.
 */
export function validatePathPrefix(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  const parsed = InstancePath.safeParse(trimmed);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'not an instance path' };
  }
  return { ok: true, value: trimmed };
}

/** The service roots a prefix may start from, for a picker. Protocol-owned. */
export const PATH_ROOTS: readonly string[] = SERVICE_ROOTS;

export function validateName(raw: string): { ok: true; value: string } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return { ok: false };
  return { ok: true, value: trimmed };
}

/**
 * A uuid, from the platform.
 *
 * `crypto.randomUUID` needs a secure context, and `http://` on a LAN address is
 * not one — a self-hoster reaching this app at `http://192.168.1.5:3000` would
 * otherwise get a `TypeError` while creating their first project. The fallback
 * is a v4 layout from `getRandomValues`, which is available in that context.
 */
export function newProjectId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // Insecure context. Fall through.
    }
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // Version 4, variant 10xx — the two bits that make this a well-formed uuid
  // rather than 32 random hex characters the daemon's `z.string().uuid()` would
  // refuse.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── the repository ──────────────────────────────────────────────────────────

/**
 * CRUD over the Storage port.
 *
 * A thin object rather than a class with a cache: `list` is the only read the
 * surfaces do, IndexedDB answers it in a frame, and a cache here would be a
 * second copy of the truth that two tabs could disagree about.
 */
export class ProjectStore {
  constructor(private readonly storage: StoragePort) {}

  /** Newest first — the adapter orders by `updatedAt`. */
  list(): Promise<ProjectRecord[]> {
    return this.storage.list<ProjectRecord>(COLLECTION);
  }

  get(id: string): Promise<ProjectRecord | null> {
    return this.storage.get<ProjectRecord>(COLLECTION, id);
  }

  async create(draft: ProjectDraft): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    return this.storage.put<ProjectRecord>(COLLECTION, {
      id: draft.id ?? newProjectId(),
      name: draft.name,
      placeId: draft.placeId,
      allowedPathPrefixes: [...draft.allowedPathPrefixes],
      treeSnapshotVersion: 0,
      versionObservedAt: null,
      createdAt: now,
    });
  }

  /**
   * Write back a subset of the mutable fields.
   *
   * `id` and `createdAt` are not in the patch type, and that is the whole
   * protection: a project whose id changed is a different project, and every
   * ChangeSet, run and journal entry that named the old one would be orphaned
   * with no error anywhere.
   */
  async update(
    id: string,
    patch: Partial<Pick<ProjectRecord, 'name' | 'placeId' | 'allowedPathPrefixes' | 'treeSnapshotVersion' | 'versionObservedAt'>>,
  ): Promise<ProjectRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const { updatedAt: _ignored, ...rest } = existing;
    return this.storage.put<ProjectRecord>(COLLECTION, { ...rest, ...patch });
  }

  /**
   * Record a version this browser just saw reported for a project.
   *
   * Only ever moves forward. A diff for an older ChangeSet reports the
   * `currentVersion` at the time it is read, so out-of-order reads are normal;
   * letting a stale read lower the recorded number would make the projects list
   * flicker backwards for no reason a user could explain.
   */
  async observeVersion(id: string, version: number): Promise<ProjectRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    if (version <= existing.treeSnapshotVersion && existing.versionObservedAt !== null) return existing;
    return this.update(id, { treeSnapshotVersion: version, versionObservedAt: new Date().toISOString() });
  }

  delete(id: string): Promise<void> {
    return this.storage.delete(COLLECTION, id);
  }
}

/**
 * What "export this project" can honestly produce today.
 *
 * Not `.rbxlx`. M34's row in MILESTONES.md asks for one and the daemon cannot
 * supply it: a `.rbxlx` is a serialisation of a *place tree*, the daemon holds
 * no tree (`ChangeSetDiff.treeAware: false`), and there is no route on `/v1`
 * that returns one. Producing a file from what this browser holds would be
 * producing a place file with no place in it.
 *
 * So the export is the project *definition* — the thing this app actually owns
 * — in a shape M33's account adoption can read back. The UI says which of the
 * two it is offering, and leaves the `.rbxlx` control disabled with the reason
 * on it rather than shipping a button that writes a broken file.
 *
 * TODO(M34): a real `.rbxlx` export needs a daemon route that asks the paired
 * Studio plugin to serialise the place and streams it back. Owner: the daemon
 * and plugin authors together; this app gains a download link and nothing else.
 */
export const PROJECT_EXPORT_FORMAT = 'forgebridge.project/v1' as const;

export interface ProjectExport {
  readonly format: typeof PROJECT_EXPORT_FORMAT;
  readonly exportedAt: string;
  readonly project: ProjectRecord;
}

export function exportProject(project: ProjectRecord): ProjectExport {
  return { format: PROJECT_EXPORT_FORMAT, exportedAt: new Date().toISOString(), project };
}
