import { SERVICE_ROOTS, type ServiceRoot } from '@forgebridge/protocol';

import type { Graph, GraphEdge, GraphNode } from './model';

/**
 * The layout, and why it is not a graph library.
 *
 * (Named `graph-layout.ts` rather than `layout.ts`: inside an App Router
 * directory that filename is reserved for a route layout.)
 *
 * (The file is `graph-layout.ts`, not `layout.ts`: this directory is an
 * App Router segment, where `layout` is a reserved filename and Next would
 * render this module as the route's layout component.)
 *
 * The brief for M37 allows a heavyweight graph library only with a
 * justification, and there is none to give here. Three reasons, in the order
 * they mattered:
 *
 *  1. **This graph is not general.** Every node has a Roblox service root, and
 *     that root is the single most meaningful thing about it — a developer
 *     asking "what talks to what" is already thinking in ServerScriptService
 *     versus ReplicatedStorage versus StarterPlayer. A force-directed solver
 *     throws that structure away and rediscovers a worse version of it. Columns
 *     by service are not a fallback for a real layout; they *are* the real
 *     layout for this domain.
 *
 *  2. **A blob cannot be navigated by keyboard.** Arbitrary 2D positions have no
 *     natural "next"; a grid does. Columns by service and rows within a column
 *     give arrow keys an exact meaning, which is what turns this from a picture
 *     into a control. Graph UIs fail WCAG at precisely this point and they fail
 *     it because of the layout choice, not in spite of it.
 *
 *  3. **It has to be stable.** A force simulation re-runs and the diagram moves;
 *     a node that jumped because an unrelated edge appeared is a node the reader
 *     has to find again. This layout is a pure function: the same graph produces
 *     the same coordinates, every time, in both directions.
 *
 * The one thing a solver buys that this does not is crossing minimisation, and
 * two barycentre sweeps recover most of that for a graph of this size in about
 * thirty lines. That trade is the whole argument.
 *
 * Coordinates here are **flow** coordinates: x grows from the reader's start
 * edge. The view mirrors them for `dir="rtl"` with `mirrorX` below, so this
 * module never knows which direction it is being drawn in — which is what keeps
 * RTL a layout rather than a mirrored stylesheet.
 */

export const NODE_WIDTH = 178;
export const NODE_HEIGHT = 46;
export const ROW_GAP = 12;
export const COLUMN_GAP = 76;
export const HEADER_HEIGHT = 30;
export const PADDING = 16;

/**
 * Column order: consumers first, providers last.
 *
 * Roughly the direction a require points. Client scripts and world objects reach
 * into shared storage; shared storage holds the remotes and the modules; the
 * server sits at the far end owning the authority. Ordering the columns along
 * that axis is what makes most edges point one way, which is what makes the
 * picture readable. It is a heuristic about how Roblox places are usually built,
 * not a rule — a back edge is drawn, routed through the same channel, and is not
 * treated as an error.
 */
const COLUMN_ORDER: readonly ServiceRoot[] = [
  'StarterGui',
  'StarterPlayer',
  'StarterPack',
  'Workspace',
  'Teams',
  'Lighting',
  'SoundService',
  'Chat',
  'TextChatService',
  'ReplicatedFirst',
  'ReplicatedStorage',
  'ServerScriptService',
  'ServerStorage',
];

function columnRank(service: ServiceRoot): number {
  const index = COLUMN_ORDER.indexOf(service);
  return index === -1 ? SERVICE_ROOTS.length : index;
}

export interface PlacedNode {
  readonly node: GraphNode;
  /** Index into `columns`, and the row within that column. The keyboard grid. */
  readonly column: number;
  readonly row: number;
  /** Flow coordinates of the box's start edge and top edge, in pixels. */
  readonly x: number;
  readonly y: number;
}

export interface PlacedColumn {
  readonly service: ServiceRoot;
  readonly x: number;
  readonly count: number;
}

export interface RoutedEdge {
  readonly edge: GraphEdge;
  /** Orthogonal polyline in flow coordinates. Mirror each x for RTL. */
  readonly points: ReadonlyArray<readonly [number, number]>;
}

export interface GraphLayout {
  readonly columns: readonly PlacedColumn[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly RoutedEdge[];
  readonly width: number;
  readonly height: number;
}

/**
 * Flow x to physical x.
 *
 * A node box occupies `[x, x + NODE_WIDTH]` in flow coordinates. Under RTL the
 * view positions it with `inset-inline-start: x`, which puts its physical left
 * edge at `width - x - NODE_WIDTH` — exactly what `mirrorX` gives for the box's
 * far corner. The SVG underneath has no logical properties of its own, so it
 * calls this for every coordinate and the two stay in register.
 */
export function mirrorX(x: number, width: number, rtl: boolean): number {
  return rtl ? width - x : x;
}

export function layoutGraph(graph: Graph): GraphLayout {
  const byService = new Map<ServiceRoot, GraphNode[]>();
  for (const node of graph.nodes) {
    const bucket = byService.get(node.service);
    if (bucket) bucket.push(node);
    else byService.set(node.service, [node]);
  }

  const services = [...byService.keys()].sort((a, b) => columnRank(a) - columnRank(b));

  // Deterministic starting order inside every column, before any sweep.
  const order: string[][] = services.map((service) =>
    (byService.get(service) as GraphNode[])
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
      .map((node) => node.path),
  );

  reduceCrossings(order, graph.edges, indexOfColumn(services, graph.nodes));

  const nodeByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const placed: PlacedNode[] = [];
  const position = new Map<string, PlacedNode>();

  order.forEach((paths, column) => {
    paths.forEach((path, row) => {
      const node = nodeByPath.get(path);
      if (!node) return;
      const entry: PlacedNode = {
        node,
        column,
        row,
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + HEADER_HEIGHT + row * (NODE_HEIGHT + ROW_GAP),
      };
      placed.push(entry);
      position.set(path, entry);
    });
  });

  const rows = order.reduce((most, column) => Math.max(most, column.length), 0);
  const width = PADDING * 2 + services.length * (NODE_WIDTH + COLUMN_GAP);
  const height =
    PADDING * 2 + HEADER_HEIGHT + Math.max(rows, 1) * (NODE_HEIGHT + ROW_GAP) - ROW_GAP;

  const columns: PlacedColumn[] = services.map((service, index) => ({
    service,
    x: PADDING + index * (NODE_WIDTH + COLUMN_GAP),
    count: order[index]?.length ?? 0,
  }));

  const edges: RoutedEdge[] = [];
  for (const edge of graph.edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (!from || !to) continue;
    edges.push({ edge, points: route(from, to) });
  }

  return { columns, nodes: placed, edges, width, height };
}

function indexOfColumn(
  services: readonly ServiceRoot[],
  nodes: readonly GraphNode[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const node of nodes) {
    const index = services.indexOf(node.service);
    if (index !== -1) map.set(node.path, index);
  }
  return map;
}

/**
 * Two barycentre sweeps, forward then back.
 *
 * The classic Sugiyama ordering heuristic reduced to what a graph of this size
 * needs. Each node takes the mean row of its neighbours in the adjacent column;
 * a node with no neighbour there keeps its current row, so an isolated node does
 * not drift to the top and displace connected ones. Stable sort, so ties keep
 * the alphabetical order the caller established.
 *
 * Four passes rather than iterating to a fixed point: the improvement is almost
 * entirely in the first two, and a loop that runs until nothing moves can
 * oscillate between two equally good orders, which would make the layout depend
 * on how many times it happened to run.
 */
function reduceCrossings(
  order: string[][],
  edges: readonly GraphEdge[],
  columnOf: ReadonlyMap<string, number>,
): void {
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    if (columnOf.get(edge.from) === columnOf.get(edge.to)) continue;
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      const list = neighbours.get(a);
      if (list) list.push(b);
      else neighbours.set(a, [b]);
    }
  }

  const rowOf = (path: string): number => {
    const column = columnOf.get(path);
    if (column === undefined) return -1;
    return order[column]?.indexOf(path) ?? -1;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    const forward = pass % 2 === 0;
    const indices = order.map((_, index) => index);
    for (const column of forward ? indices : indices.reverse()) {
      const paths = order[column];
      if (!paths || paths.length < 2) continue;

      const anchor = forward ? column - 1 : column + 1;
      const weights = new Map<string, number>();
      paths.forEach((path, row) => {
        const rows = (neighbours.get(path) ?? [])
          .filter((other) => columnOf.get(other) === anchor)
          .map(rowOf)
          .filter((value) => value >= 0);
        weights.set(
          path,
          rows.length === 0 ? row : rows.reduce((sum, value) => sum + value, 0) / rows.length,
        );
      });

      order[column] = paths
        .map((path, row) => ({ path, row }))
        .sort((a, b) => {
          const delta = (weights.get(a.path) as number) - (weights.get(b.path) as number);
          return delta !== 0 ? delta : a.row - b.row;
        })
        .map((entry) => entry.path);
    }
  }
}

/**
 * An orthogonal polyline between two boxes, routed through the channel between
 * their columns.
 *
 * Orthogonal rather than curved, and through a shared channel rather than
 * point-to-point, because the columns already read as an instrument schematic
 * and a bundle of beziers over them would read as a different drawing sitting on
 * top. Straight runs also survive the RTL mirror without any special case: a
 * mirrored right angle is still a right angle.
 */
function route(from: PlacedNode, to: PlacedNode): Array<readonly [number, number]> {
  const fromMidY = from.y + NODE_HEIGHT / 2;
  const toMidY = to.y + NODE_HEIGHT / 2;

  // The channel sits in the gap after the earlier of the two columns, so a
  // forward edge and the back edge answering it share one vertical run.
  const channelColumn = Math.min(from.column, to.column);
  const channelX = PADDING + channelColumn * (NODE_WIDTH + COLUMN_GAP) + NODE_WIDTH + COLUMN_GAP / 2;

  if (from.column === to.column) {
    // Same column: out the end edge, down the channel, back in the end edge.
    const startX = from.x + NODE_WIDTH;
    const endX = to.x + NODE_WIDTH;
    return [
      [startX, fromMidY],
      [channelX, fromMidY],
      [channelX, toMidY],
      [endX, toMidY],
    ];
  }

  const forward = from.column < to.column;
  const startX = forward ? from.x + NODE_WIDTH : from.x;
  const endX = forward ? to.x : to.x + NODE_WIDTH;

  return [
    [startX, fromMidY],
    [channelX, fromMidY],
    [channelX, toMidY],
    [endX, toMidY],
  ];
}
