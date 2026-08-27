import { describe, expect, it } from 'vitest';

import { buildGraph } from './build-graph';
import { EXAMPLE_INSTANCES } from './example-place';
import { NODE_WIDTH, layoutGraph, mirrorX } from './graph-layout';

/**
 * The layout, held to the three claims its header makes.
 *
 * The RTL block is the one worth having. `dir="rtl"` producing "a correct
 * layout, not a mirrored-by-accident one" is a promise this app makes in
 * DESIGN.md §4, and for a diagram it is the promise most easily broken in a way
 * nobody notices in an English screenshot: the node boxes are positioned with a
 * logical property and mirror themselves, while the SVG underneath them has no
 * logical properties at all. If the two ever disagree, every edge in the graph
 * points at the wrong box — and it looks completely fine in English.
 */

const graph = buildGraph({ instances: EXAMPLE_INSTANCES, proposed: [] });

describe('the graph layout', () => {
  it('is a pure function of the graph', () => {
    expect(layoutGraph(graph)).toEqual(layoutGraph(graph));
  });

  it('gives every node a column of its own service and a unique row within it', () => {
    const layout = layoutGraph(graph);
    const seen = new Set<string>();

    for (const placed of layout.nodes) {
      const column = layout.columns[placed.column];
      expect(column?.service).toBe(placed.node.service);

      const cell = `${String(placed.column)}:${String(placed.row)}`;
      expect(seen.has(cell), `two nodes share cell ${cell}`).toBe(false);
      seen.add(cell);
    }
  });

  it('keeps every node inside the reported canvas', () => {
    const layout = layoutGraph(graph);
    for (const placed of layout.nodes) {
      expect(placed.x).toBeGreaterThanOrEqual(0);
      expect(placed.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(placed.y).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it('routes an edge from one placed node to another, orthogonally', () => {
    const layout = layoutGraph(graph);
    expect(layout.edges.length).toBe(graph.edges.length);

    for (const routed of layout.edges) {
      // Every segment is horizontal or vertical: a mirrored right angle is
      // still a right angle, which is what lets the RTL flip be a coordinate
      // transform rather than a second routing pass.
      for (let i = 1; i < routed.points.length; i += 1) {
        const [px, py] = routed.points[i - 1] as readonly [number, number];
        const [x, y] = routed.points[i] as readonly [number, number];
        expect(px === x || py === y).toBe(true);
      }
    }
  });

  it('orders columns from consumers toward providers', () => {
    const layout = layoutGraph(graph);
    const services = layout.columns.map((column) => column.service);
    // StarterGui and StarterPlayer hold the client code that reaches into
    // ReplicatedStorage; ServerScriptService owns the authority at the far end.
    expect(services.indexOf('StarterGui')).toBeLessThan(services.indexOf('ReplicatedStorage'));
    expect(services.indexOf('ReplicatedStorage')).toBeLessThan(
      services.indexOf('ServerScriptService'),
    );
  });
});

describe('mirroring for dir="rtl"', () => {
  const layout = layoutGraph(graph);

  it('leaves left-to-right untouched', () => {
    expect(mirrorX(40, layout.width, false)).toBe(40);
  });

  it('puts a box mirrored by the SVG where the browser puts the button', () => {
    /*
     * The invariant that keeps the two halves in register.
     *
     * A node button is positioned with `inset-inline-start: x`, so under RTL the
     * browser lays its physical left edge at `width - x - NODE_WIDTH`. The SVG
     * has no such property and mirrors coordinates by hand. These two have to
     * agree for every node, or the edges point at empty space.
     */
    for (const placed of layout.nodes) {
      const browserPhysicalStart = layout.width - placed.x - NODE_WIDTH;
      const svgMirroredFarEdge = mirrorX(placed.x + NODE_WIDTH, layout.width, true);
      expect(svgMirroredFarEdge).toBe(browserPhysicalStart);
    }
  });

  it('reverses the reading order of the columns without reordering them', () => {
    const flow = layout.columns.map((column) => column.x);
    const mirrored = layout.columns.map((column) =>
      mirrorX(column.x + NODE_WIDTH, layout.width, true),
    );

    // Ascending in flow coordinates, descending in physical ones: the first
    // column is still the first thing read, it is simply read from the right.
    for (let i = 1; i < flow.length; i += 1) {
      expect(flow[i] as number).toBeGreaterThan(flow[i - 1] as number);
      expect(mirrored[i] as number).toBeLessThan(mirrored[i - 1] as number);
    }
  });
});
