'use client';

import { useLocale } from '@/i18n/dictionary-context';
import { Code } from '@/components/ui/code';
import { StatusChip } from '@/components/ui/status-dot';
import { edgesFor } from './build-graph';
import type { Graph, GraphEdge, GraphNode } from './model';

/**
 * The drill-in.
 *
 * "Clicking a node drills into that script" is the M37 line, and this is where
 * it lands. Three things it has to do honestly:
 *
 *  1. **Show the Luau when this app holds it, and say so plainly when it does
 *     not.** A node from a snapshot that captured no source, or a ghost node
 *     that only a reference knows about, has no code to show. "No source here"
 *     is a fact about the data; an empty code block would look like an empty
 *     script.
 *
 *  2. **Make the edges traversable.** Every inbound and outbound edge is a
 *     button that selects the node at the other end. That is not a convenience —
 *     it is the second, complete keyboard route through the graph, and it is the
 *     one that works without knowing the arrow-key model exists.
 *
 *  3. **Show the evidence.** Each edge names the text the extractor matched. The
 *     scanner reads what a script says rather than what it computes, so a wrong
 *     edge is possible; an edge you can trace to a line is a wrong edge somebody
 *     can report, and one you cannot is a wrong edge somebody starts distrusting
 *     the whole picture over.
 */
export function NodePanel({
  graph,
  node,
  onSelect,
}: {
  graph: Graph;
  node: GraphNode;
  onSelect: (path: string) => void;
}) {
  const { t } = useLocale();
  const { inbound, outbound } = edgesFor(graph, node.path);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Code>{node.path}</Code>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-[0.875rem]">
          <dt className="fb-label">{t('map.node.class')}</dt>
          <dd>
            {node.className === null ? (
              <span className="text-fg-muted">{t('map.node.classUnknown')}</span>
            ) : (
              <Code>{node.className}</Code>
            )}
          </dd>

          <dt className="fb-label">{t('map.node.origin.label')}</dt>
          <dd className="text-fg">{t(`map.node.origin.${node.origin}`)}</dd>

          {node.changeSetId === undefined ? null : (
            <>
              <dt className="fb-label">{t('map.node.changeSet')}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Code>{node.changeSetId}</Code>
                {/*
                  The one place chroma appears on this surface, and only for the
                  reason DESIGN.md §1 reserves it: a ChangeSet sitting in
                  `validated` is a thing waiting for a human (ADR-012). Any other
                  status is idle here, because this surface is not the approval
                  gate and must not imply it is. The word is always present —
                  the chip renders it, never the colour alone.
                */}
                {node.changeSetStatus === undefined ? null : (
                  <StatusChip status={node.changeSetStatus === 'validated' ? 'attend' : 'idle'}>
                    {node.changeSetStatus}
                  </StatusChip>
                )}
              </dd>
            </>
          )}
        </dl>
        <p className="fb-meta">{t(`map.node.originExplain.${node.origin}`)}</p>
      </div>

      <EdgeList
        title={t('map.node.outbound')}
        empty={t('map.node.noOutbound')}
        edges={outbound}
        other={(edge) => edge.to}
        onSelect={onSelect}
      />

      <EdgeList
        title={t('map.node.inbound')}
        empty={t('map.node.noInbound')}
        edges={inbound}
        other={(edge) => edge.from}
        onSelect={onSelect}
      />

      <section aria-label={t('map.node.source')} className="flex flex-col gap-2">
        <h3 className="fb-label">{t('map.node.source')}</h3>
        {node.source === undefined ? (
          <p className="fb-meta">{t('map.node.sourceUnknown')}</p>
        ) : (
          <Code block className="max-h-96 overflow-y-auto">
            {node.source}
          </Code>
        )}
      </section>
    </div>
  );
}

function EdgeList({
  title,
  empty,
  edges,
  other,
  onSelect,
}: {
  title: string;
  empty: string;
  edges: readonly GraphEdge[];
  other: (edge: GraphEdge) => string;
  onSelect: (path: string) => void;
}) {
  const { t } = useLocale();

  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="fb-label">{title}</h3>
      {edges.length === 0 ? (
        <p className="fb-meta">{empty}</p>
      ) : (
        <ul className="flex list-none flex-col gap-2">
          {edges.map((edge) => {
            const target = other(edge);
            return (
              <li key={`${edge.from}|${edge.to}|${edge.kind}`}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(target);
                  }}
                  className="flex w-full flex-col gap-1 rounded-sm border border-rule bg-raised px-2 py-1.5 text-start transition-colors duration-150 hover:bg-sunken"
                >
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="fb-meta">{t(`map.edge.kind.${edge.kind}`)}</span>
                    <Code>{target}</Code>
                  </span>
                  {/*
                    The matched text. `<Code>` and not a plain span: it is Luau,
                    and under Hebrew an un-isolated run of operators and dots
                    would be reordered around the paragraph direction.
                  */}
                  <Code className="truncate opacity-80">{edge.evidence}</Code>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
