'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import {
  HEADER_HEIGHT,
  NODE_HEIGHT,
  NODE_WIDTH,
  PADDING,
  mirrorX,
  type GraphLayout,
  type PlacedNode,
} from './graph-layout';

/**
 * The graph.
 *
 * The single decision this component is built around: **the nodes are real HTML
 * buttons, and the SVG underneath draws nothing you can click.** The obvious
 * implementation puts everything in the SVG and adds `tabindex` to `<g>`
 * elements, and it fails four ways at once — the focus ring in `globals.css`
 * does not apply, the label goes through `<text>` where the bidi algorithm has
 * no paragraph to work with, hit targets are whatever the vector says, and hover
 * and disabled styling need reimplementing. Buttons in the normal flow, absolute
 * positioned, get all four for free.
 *
 * So: `<svg aria-hidden>` for the lines, HTML for everything a person touches.
 *
 * **Direction.** `graph-layout.ts` works in flow coordinates and knows nothing about
 * direction. Node buttons use `inset-inline-start`, which the browser mirrors.
 * The SVG has no logical properties, so every x it draws goes through
 * `mirrorX`. That is the whole RTL story here, and it is why the picture under
 * `dir="rtl"` reads start-to-end like the text around it instead of being a
 * left-to-right diagram with the labels flipped.
 *
 * **Keyboard.** One tab stop for the whole graph, then arrow keys: up and down
 * within a service column, start and end across columns — and "across" follows
 * the reading direction, so ArrowLeft moves toward the start under RTL. Enter or
 * Space opens a node. This is the part graph UIs usually skip, and it is only
 * cheap here because the layout is a grid rather than a cloud of coordinates.
 */
export function GraphView({
  layout,
  selected,
  onSelect,
  labelledBy,
}: {
  layout: GraphLayout;
  selected: string | null;
  onSelect: (path: string) => void;
  labelledBy: string;
}) {
  const { t, dir } = useLocale();
  const rtl = dir === 'rtl';
  const hintId = useId();
  const markerId = useId();

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focusPath, setFocusPath] = useState<string | null>(null);

  const first = layout.nodes[0]?.node.path ?? null;
  // The one node in the tab order. Selection wins, then whatever was focused
  // last, then the first node — so tabbing back into the graph returns you to
  // where you were rather than to the top-left corner.
  const roving = selected ?? focusPath ?? first;

  const byColumn = useMemo(() => {
    const map = new Map<number, PlacedNode[]>();
    for (const placed of layout.nodes) {
      const bucket = map.get(placed.column);
      if (bucket) bucket.push(placed);
      else map.set(placed.column, [placed]);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.row - b.row);
    return map;
  }, [layout]);

  const positionOf = useMemo(() => {
    const map = new Map<string, PlacedNode>();
    for (const placed of layout.nodes) map.set(placed.node.path, placed);
    return map;
  }, [layout]);

  const move = useCallback(
    (from: PlacedNode, deltaColumn: number, deltaRow: number, jump: 'none' | 'first' | 'last') => {
      let column = from.column + deltaColumn;
      // Skip nothing: every column in `layout.columns` has at least one node.
      column = Math.max(0, Math.min(layout.columns.length - 1, column));
      const bucket = byColumn.get(column) ?? [];
      if (bucket.length === 0) return;

      let row: number;
      if (jump === 'first') row = 0;
      else if (jump === 'last') row = bucket.length - 1;
      else if (deltaColumn !== 0) row = Math.min(from.row, bucket.length - 1);
      else row = Math.max(0, Math.min(bucket.length - 1, from.row + deltaRow));

      const target = bucket[row];
      if (!target) return;
      setFocusPath(target.node.path);
      buttons.current.get(target.node.path)?.focus();
    },
    [byColumn, layout.columns.length],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      /*
       * The active node comes from the DOM, not from React state.
       *
       * `focusPath` is set by an `onFocus` handler, and a keypress can arrive in
       * the same tick as the focus that preceded it — before that state has
       * flushed and before this callback has been rebuilt with it. Reading the
       * focused element instead makes the handler agree with what the user's
       * focus ring is on, which is the only definition of "active" that cannot
       * be a render behind. `focusPath` still does its own job below: deciding
       * which node holds the single tab stop.
       */
      const origin = event.target as HTMLElement | null;
      const focused = origin?.closest<HTMLElement>('[data-node-path]')?.dataset['nodePath'];
      const path = focused ?? roving;
      const active = path === null || path === undefined ? null : positionOf.get(path);
      if (!active) return;

      // "Next" and "previous" are reading-order words, not physical ones.
      const forwardKey = rtl ? 'ArrowLeft' : 'ArrowRight';
      const backKey = rtl ? 'ArrowRight' : 'ArrowLeft';

      switch (event.key) {
        case 'ArrowDown':
          move(active, 0, 1, 'none');
          break;
        case 'ArrowUp':
          move(active, 0, -1, 'none');
          break;
        case forwardKey:
          move(active, 1, 0, 'none');
          break;
        case backKey:
          move(active, -1, 0, 'none');
          break;
        case 'Home':
          move(active, 0, 0, 'first');
          break;
        case 'End':
          move(active, 0, 0, 'last');
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [move, positionOf, roving, rtl],
  );

  // Keep the selected node in view when selection changes from outside the
  // graph — the panel's inbound/outbound links are how most traversal actually
  // happens, and a selection you cannot see is not a selection.
  useEffect(() => {
    if (selected === null) return;
    buttons.current.get(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  const mx = (x: number): number => mirrorX(x, layout.width, rtl);

  return (
    <div className="flex flex-col gap-2">
      <p id={hintId} className="fb-meta">
        {t('map.graph.hint')}
      </p>

      {/*
        The scroller. DESIGN.md §5: wide content is full-bleed with its own
        overflow rather than wrapped to a text measure. A dependency graph folded
        to 72ch is not a graph.
      */}
      <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
        <div
          role="group"
          aria-labelledby={labelledBy}
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          className="relative"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            aria-hidden="true"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
            className="absolute inset-0 text-rule-strong"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" fill="currentColor" />
              </marker>
            </defs>

            {/* A rule under each column header. The only decoration in here. */}
            {layout.columns.map((column) => {
              const start = mx(column.x);
              const end = mx(column.x + NODE_WIDTH);
              return (
                <line
                  key={column.service}
                  x1={Math.min(start, end)}
                  x2={Math.max(start, end)}
                  y1={PADDING + HEADER_HEIGHT - 8}
                  y2={PADDING + HEADER_HEIGHT - 8}
                  stroke="currentColor"
                  strokeWidth={1}
                  opacity={0.6}
                />
              );
            })}

            {layout.edges.map((routed) => (
              <polyline
                key={`${routed.edge.from}|${routed.edge.to}|${routed.edge.kind}`}
                points={routed.points
                  .map(([x, y]) => `${String(mx(x))},${String(y)}`)
                  .join(' ')}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
                /* Require is a solid line, a remote call is dotted. Achromatic
                   on purpose: an edge kind is not a state of the bridge, and
                   chroma in this system means state. The legend spells both
                   out in words. */
                strokeDasharray={routed.edge.kind === 'remote' ? '2 3' : undefined}
                markerEnd={`url(#${markerId})`}
                opacity={
                  selected === null ||
                  routed.edge.from === selected ||
                  routed.edge.to === selected
                    ? 1
                    : 0.28
                }
              />
            ))}
          </svg>

          {/*
            Column headers as HTML, not `<text>`: these are translated words and
            they need a real bidi paragraph, a real font stack and a real
            ellipsis. The node labels below are instance names — safe
            identifiers, so LTR in both locales — and they carry `dir="ltr"`.
          */}
          {layout.columns.map((column) => (
            <div
              key={column.service}
              /* A service name is a Roblox API identifier, so it is neither
                 translated nor upper-cased — `.fb-label` would flatten
                 `ServerScriptService` into an unreadable run of capitals. Mono
                 and muted: the same treatment every other identifier in this app
                 gets.

                 `dir="ltr"` sits on the inner `<bdi>` rather than on this box,
                 and that is not fussiness. `dir` on an element also decides how
                 `text-align: start` resolves *inside* it — put it here and the
                 header aligns itself to the left of a column whose inline start,
                 under RTL, is the right. Isolation belongs to the identifier;
                 alignment belongs to the column. */
              className="absolute truncate text-start font-mono text-[0.6875rem] font-medium text-fg-muted"
              style={{ insetInlineStart: column.x, top: PADDING, width: NODE_WIDTH }}
            >
              <bdi dir="ltr">{column.service}</bdi>
            </div>
          ))}

          {layout.nodes.map((placed) => (
            <NodeButton
              key={placed.node.path}
              placed={placed}
              selected={selected === placed.node.path}
              tabbable={roving === placed.node.path}
              register={(element) => {
                if (element) buttons.current.set(placed.node.path, element);
                else buttons.current.delete(placed.node.path);
              }}
              onFocus={() => {
                setFocusPath(placed.node.path);
              }}
              onActivate={() => {
                onSelect(placed.node.path);
              }}
            />
          ))}
        </div>
      </div>

      <Legend />
    </div>
  );
}

function NodeButton({
  placed,
  selected,
  tabbable,
  register,
  onFocus,
  onActivate,
}: {
  placed: PlacedNode;
  selected: boolean;
  tabbable: boolean;
  register: (element: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onActivate: () => void;
}) {
  const { t } = useLocale();
  const { node } = placed;

  const originLabel = t(`map.node.origin.${node.origin}`);
  const kindLabel = node.className ?? t('map.node.classUnknown');

  /*
   * Border style carries origin, and so does the tag inside the box. Two
   * channels, neither of them colour: a dashed outline alone would be a
   * distinction a low-vision reader could miss and a screen-reader user could
   * not perceive at all, and colour would spend the state palette on something
   * that is not a state of the bridge.
   */
  const border =
    node.origin === 'place'
      ? 'border-solid border-rule-strong'
      : node.origin === 'proposed'
        ? 'border-dashed border-rule-strong'
        : 'border-dotted border-rule-strong';

  return (
    <button
      type="button"
      ref={register}
      // How the group's key handler above identifies the focused node without
      // waiting for a React state update to land.
      data-node-path={node.path}
      tabIndex={tabbable ? 0 : -1}
      aria-current={selected ? 'true' : undefined}
      onFocus={onFocus}
      onClick={onActivate}
      /* The accessible name states everything the box shows plus the service
         column, which is visual-only otherwise. Order matters: the name first,
         because that is what someone is scanning for. */
      aria-label={`${node.name} — ${kindLabel} — ${originLabel} — ${node.service}`}
      className={
        'absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-sm border px-2 py-1 ' +
        'text-start transition-colors duration-150 ' +
        border +
        (selected ? ' bg-sunken' : ' bg-raised hover:bg-sunken')
      }
      style={{
        insetInlineStart: placed.x,
        top: placed.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
    >
      {/*
        `<bdi dir="ltr">` around the identifier, not `dir` on the block.

        An instance name is a safe identifier, so it is an LTR run in both
        locales and it has to be isolated or the bidi algorithm reorders it
        against the Hebrew around it. But `dir` also governs how `text-align:
        start` resolves inside the element it is on — so putting it on the block
        would left-align the name inside a box whose inline start, under RTL, is
        its right edge. `<bdi>` isolates an inline run and leaves the block's
        alignment to the button, which is what "RTL is a layout, not a
        transform" means at this scale.
      */}
      <span className="truncate font-mono text-[0.8125rem] font-medium text-fg">
        <bdi dir="ltr">{node.name}</bdi>
      </span>
      <span className="flex items-baseline gap-1.5 truncate text-[0.6875rem] text-fg-faint">
        {node.className === null ? (
          // Translated prose, so no isolation and no forced direction.
          <span className="truncate">{kindLabel}</span>
        ) : (
          <bdi dir="ltr" className="truncate font-mono">
            {node.className}
          </bdi>
        )}
        {node.origin === 'place' ? null : <span className="truncate">{originLabel}</span>}
      </span>
    </button>
  );
}

/**
 * The legend is not optional here.
 *
 * Four visual distinctions are in play — solid versus dashed versus dotted
 * boxes, and solid versus dotted lines — and every one of them is a shape rather
 * than a colour precisely so it can be named. A shape nobody named is a shape
 * only the person who drew it can read.
 */
function Legend() {
  const { t } = useLocale();

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[0.8125rem]">
      {(
        [
          ['map.legend.place', 'border-solid'],
          ['map.legend.proposed', 'border-dashed'],
          ['map.legend.referenced', 'border-dotted'],
        ] as const
      ).map(([key, style]) => (
        <div key={key} className="flex items-center gap-2">
          <dt aria-hidden="true" className={`h-3 w-6 rounded-sm border ${style} border-rule-strong`} />
          <dd className="text-fg-muted">{t(key)}</dd>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <dt aria-hidden="true" className="h-px w-6 bg-rule-strong" />
        <dd className="text-fg-muted">{t('map.legend.require')}</dd>
      </div>
      <div className="flex items-center gap-2">
        <dt
          aria-hidden="true"
          className="h-0 w-6 border-t border-dotted border-rule-strong"
        />
        <dd className="text-fg-muted">{t('map.legend.remote')}</dd>
      </div>
    </dl>
  );
}
