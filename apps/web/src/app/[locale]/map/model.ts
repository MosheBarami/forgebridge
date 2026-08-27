import { z } from 'zod';
import { SERVICE_ROOTS, type ServiceRoot } from '@forgebridge/protocol';

/**
 * The map's domain, and — more importantly — where its data is supposed to come
 * from.
 *
 * This is the part of M37 that has to be stated plainly rather than assumed.
 * **The daemon holds no tree snapshot.** `GET /v1/changesets/:id/diff` returns
 * `treeAware: false` and says so in `packages/daemon/src/wire.ts`; there is no
 * route on the `/v1` surface that would answer "what is in this place". So a
 * map that fetched a snapshot from the daemon would be a map drawing something
 * nobody has.
 *
 * What this app can honestly draw is the union of two things it does hold, both
 * through the local Storage port (ADR-005), both working with no account:
 *
 *   1. a **project tree snapshot**, once M34 captures and stores one; and
 *   2. the **operations of ChangeSets** this browser has kept.
 *
 * Neither is written yet. That is why the empty state on this surface names both
 * milestones instead of showing a spinner: nothing is loading, the data does not
 * exist, and a surface that spins forever while waiting for a feature nobody is
 * building this week is worse than one that says so.
 *
 * Both shapes are *parsed*, not cast. They are written by other agents' code and
 * a record whose shape moved should be skipped with a count the user can see,
 * not turned into `undefined` three renders later.
 */

/** One instance in a captured tree. `source` is present only for script classes. */
export const TreeInstanceRecord = z.object({
  path: z.string().min(1),
  className: z.string().min(1),
  source: z.string().optional(),
});
export type TreeInstanceRecord = z.infer<typeof TreeInstanceRecord>;

export const ProjectTreeSnapshot = z.object({
  /** Matches `ChangeSet.baseVersion` — the version an apply is checked against. */
  version: z.number().int().min(0),
  capturedAt: z.string().datetime(),
  instances: z.array(TreeInstanceRecord),
});
export type ProjectTreeSnapshot = z.infer<typeof ProjectTreeSnapshot>;

/**
 * A project as the Storage port holds it.
 *
 * `.catchall` rather than a closed object: M34 owns this record and will add
 * fields to it. A map that refused to read a project because it grew a
 * `thumbnail` would be a map that breaks every time somebody else ships.
 *
 * TODO(M34): the projects surface writes `tree` when it captures a snapshot.
 * Until it does, every project read here has `tree: undefined` and this surface
 * falls back to ChangeSet operations alone. Owner: the projects-surface agent.
 */
export const StoredProject = z
  .object({
    id: z.string(),
    updatedAt: z.string(),
    name: z.string().optional(),
    tree: ProjectTreeSnapshot.optional(),
  })
  .catchall(z.unknown());
export type StoredProject = z.infer<typeof StoredProject>;

/**
 * What kind of thing a node is.
 *
 * Derived from `className`, never asserted separately: two fields that can
 * disagree about the same instance is one field too many.
 */
export type NodeKind =
  | 'script'
  | 'localScript'
  | 'module'
  | 'remoteEvent'
  | 'remoteFunction'
  | 'bindable'
  | 'folder'
  | 'instance';

/**
 * How this app came to know about the node. This distinction is the honest core
 * of the surface and it is drawn differently in the graph:
 *
 *   place       it is in a captured tree snapshot — it exists
 *   proposed    it appears only in a ChangeSet that has not been applied
 *   referenced  a script's text points at it and neither of the above knows it
 *
 * `referenced` is not a defect in the extractor: a require of a path that is not
 * in the snapshot is usually a real broken reference, and showing it as a ghost
 * node is more useful than dropping the edge and pretending the graph is whole.
 */
export type NodeOrigin = 'place' | 'proposed' | 'referenced';

export interface GraphNode {
  /** The dotted `InstancePath`. Unique, and the node's id. */
  readonly path: string;
  /** Final segment. Always a safe identifier, so always an LTR run. */
  readonly name: string;
  readonly service: ServiceRoot;
  /** `null` when only a reference told us this path exists. */
  readonly className: string | null;
  readonly kind: NodeKind;
  readonly origin: NodeOrigin;
  /** The Luau, when this app holds it. Absent is common and is said out loud. */
  readonly source?: string;
  /** For a `proposed` node: which ChangeSet, and where that set had got to. */
  readonly changeSetId?: string;
  readonly changeSetStatus?: string;
}

export type EdgeKind = 'require' | 'remote';

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** The text the extractor matched. Shown in the panel, so a wrong edge is
   *  traceable to the line that produced it rather than to a black box. */
  readonly evidence: string;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /**
   * Instances the snapshot held that this map did not draw, and why it is a
   * number rather than a silent omission: a developer looking at a graph of
   * their 40 000-part place needs to know it is a graph of the systems, not of
   * the place.
   */
  readonly omittedInstances: number;
  /** Stored records that failed to parse. Surfaced, never swallowed. */
  readonly unreadableRecords: number;
}

const CLASS_KIND: Readonly<Record<string, NodeKind>> = {
  Script: 'script',
  LocalScript: 'localScript',
  ModuleScript: 'module',
  RemoteEvent: 'remoteEvent',
  RemoteFunction: 'remoteFunction',
  BindableEvent: 'bindable',
  BindableFunction: 'bindable',
  Folder: 'folder',
};

export function kindOf(className: string | null): NodeKind {
  if (className === null) return 'instance';
  return CLASS_KIND[className] ?? 'instance';
}

/**
 * The classes that get a node of their own even when nothing references them.
 *
 * A place is mostly parts, and a node per part is a picture of a place rather
 * than a map of its systems. So the default inclusion rule is "things that hold
 * behaviour or carry it across the client/server boundary"; anything else earns
 * a node by being at the end of an edge.
 */
export function isSystemClass(className: string): boolean {
  return CLASS_KIND[className] !== undefined && className !== 'Folder';
}

export function serviceOf(path: string): ServiceRoot | null {
  const root = path.split('.')[0];
  return (SERVICE_ROOTS as readonly string[]).includes(root as string)
    ? (root as ServiceRoot)
    : null;
}

export function nameOfPath(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? path;
}
