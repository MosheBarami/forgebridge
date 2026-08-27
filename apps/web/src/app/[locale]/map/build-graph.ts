import type { ChangeSet } from '@forgebridge/protocol';

import {
  isSystemClass,
  kindOf,
  nameOfPath,
  serviceOf,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeOrigin,
  type TreeInstanceRecord,
} from './model';
import { referencesIn } from './references';

/**
 * Sources into a graph.
 *
 * The rule that decides what gets a node: **behaviour, and whatever behaviour
 * points at.** A Roblox place is mostly parts, and a node per part is a picture
 * of a place rather than a map of its systems. So scripts, modules, remotes and
 * bindables are in by class; everything else is in only if an edge lands on it,
 * and the rest is counted in `omittedInstances` so the omission is visible
 * rather than silent.
 *
 * Precedence between the two sources is deliberate and one-directional: a
 * snapshot instance is what *is*, a ChangeSet operation is what is *proposed*.
 * Where both describe the same path the snapshot wins the `origin`, because a
 * path that already exists does not become hypothetical by being edited. The
 * proposed source still attaches, because that is the text the run will install
 * and it is the text whose references belong on the map.
 */

export interface ProposedSet {
  readonly changeSetId: string;
  readonly status: string;
  readonly changeSet: ChangeSet;
}

export interface GraphSources {
  readonly instances: readonly TreeInstanceRecord[];
  readonly proposed: readonly ProposedSet[];
}

/**
 * The cap. A graph past this size is not a diagram any more, it is a wall.
 *
 * Chosen rather than computed: at 120 nodes a service column is already about
 * thirty rows tall on a laptop, which is the point where scrolling costs more
 * than the overview is worth. Nodes past the cap are counted, not dropped
 * quietly.
 */
export const MAX_NODES = 120;

interface Draft {
  path: string;
  className: string | null;
  origin: NodeOrigin;
  source?: string;
  changeSetId?: string;
  changeSetStatus?: string;
}

const ORIGIN_RANK: Readonly<Record<NodeOrigin, number>> = {
  referenced: 0,
  proposed: 1,
  place: 2,
};

export function buildGraph(sources: GraphSources, unreadableRecords = 0): Graph {
  const drafts = new Map<string, Draft>();

  const upsert = (path: string, patch: Omit<Draft, 'path'>): void => {
    const existing = drafts.get(path);
    if (!existing) {
      drafts.set(path, { path, ...patch });
      return;
    }
    // `place` outranks `proposed`, which outranks `referenced`. A path we have
    // seen for real never degrades to a ghost because a later source was vaguer.
    drafts.set(path, {
      ...existing,
      className: existing.className ?? patch.className,
      source: existing.source ?? patch.source,
      changeSetId: existing.changeSetId ?? patch.changeSetId,
      changeSetStatus: existing.changeSetStatus ?? patch.changeSetStatus,
      origin: ORIGIN_RANK[patch.origin] > ORIGIN_RANK[existing.origin] ? patch.origin : existing.origin,
    });
  };

  for (const instance of sources.instances) {
    if (serviceOf(instance.path) === null) continue;
    upsert(instance.path, {
      className: instance.className,
      origin: 'place',
      source: instance.source,
    });
  }

  for (const set of sources.proposed) {
    for (const operation of set.changeSet.operations) {
      if (serviceOf(operation.path) === null) continue;
      if (operation.op === 'createInstance') {
        upsert(operation.path, {
          className: operation.className,
          origin: 'proposed',
          changeSetId: set.changeSetId,
          changeSetStatus: set.status,
        });
      } else if (operation.op === 'writeScript') {
        upsert(operation.path, {
          className: operation.scriptType,
          origin: 'proposed',
          source: operation.source,
          changeSetId: set.changeSetId,
          changeSetStatus: set.status,
        });
      }
      // `setProperty`, `moveInstance` and `deleteInstance` are changes to a
      // node's state or its place in the tree, not claims that a node exists.
      // They deliberately create nothing here: a map that grew a node because a
      // set deleted one would be drawing the opposite of what happened.
    }
  }

  // Edges, from whatever source text we hold. A node without source contributes
  // no edges and says so in its panel; it is not a node we failed on.
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  for (const draft of [...drafts.values()]) {
    if (draft.source === undefined) continue;
    for (const reference of referencesIn(draft.path, draft.source)) {
      if (reference.target === null || reference.target === draft.path) continue;
      if (serviceOf(reference.target) === null) continue;

      const key = `${draft.path} ${reference.target} ${reference.kind}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);

      upsert(reference.target, { className: null, origin: 'referenced' });
      edges.push({
        from: draft.path,
        to: reference.target,
        kind: reference.kind,
        evidence: reference.evidence,
      });
    }
  }

  const endpoints = new Set<string>();
  for (const edge of edges) {
    endpoints.add(edge.from);
    endpoints.add(edge.to);
  }

  const kept: GraphNode[] = [];
  let omitted = 0;

  // Sorted before the cap, so which nodes survive it is deterministic rather
  // than a function of Map insertion order. The same sources must draw the same
  // graph twice.
  const ordered = [...drafts.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));

  for (const draft of ordered) {
    const service = serviceOf(draft.path);
    if (service === null) continue;

    const interesting =
      endpoints.has(draft.path) ||
      (draft.className !== null && isSystemClass(draft.className)) ||
      draft.origin === 'proposed';

    if (!interesting || kept.length >= MAX_NODES) {
      omitted += 1;
      continue;
    }

    kept.push({
      path: draft.path,
      name: nameOfPath(draft.path),
      service,
      className: draft.className,
      kind: kindOf(draft.className),
      origin: draft.origin,
      ...(draft.source === undefined ? {} : { source: draft.source }),
      ...(draft.changeSetId === undefined ? {} : { changeSetId: draft.changeSetId }),
      ...(draft.changeSetStatus === undefined ? {} : { changeSetStatus: draft.changeSetStatus }),
    });
  }

  const present = new Set(kept.map((node) => node.path));

  return {
    nodes: kept,
    // An edge whose other end fell to the cap would draw a line to nothing.
    edges: edges.filter((edge) => present.has(edge.from) && present.has(edge.to)),
    omittedInstances: omitted,
    unreadableRecords,
  };
}

/** Everything pointing at, and out of, one node. Used by the panel. */
export function edgesFor(
  graph: Graph,
  path: string,
): { inbound: readonly GraphEdge[]; outbound: readonly GraphEdge[] } {
  return {
    inbound: graph.edges.filter((edge) => edge.to === path),
    outbound: graph.edges.filter((edge) => edge.from === path),
  };
}
