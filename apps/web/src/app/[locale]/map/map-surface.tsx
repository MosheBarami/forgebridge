'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ChangeSet } from '@forgebridge/protocol';

import { useLocale } from '@/i18n/dictionary-context';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Register } from '@/components/ui/register';
import { createStorage } from '@/lib/storage';
import { StoredProject, type TreeInstanceRecord } from './model';
import { buildGraph, type ProposedSet } from './build-graph';
import { layoutGraph } from './graph-layout';
import { GraphView } from './graph-view';
import { NodePanel } from './node-panel';
import { EXAMPLE_INSTANCES } from './example-place';

/**
 * M37, assembled.
 *
 * Where the data comes from, restated here because it is the thing a reader of
 * this file will want first: the **local Storage port**, and nothing else. Not
 * the daemon — `GET /v1/changesets/:id/diff` answers `treeAware: false` and the
 * `/v1` surface has no route that would return a place's tree, so there is
 * nothing there to ask for. Not a server route — this app has none that touch a
 * daemon, by ADR-006's construction. Two collections, both readable with no
 * account (ADR-005):
 *
 *   projects     a `tree` snapshot, once M34 captures one
 *   changesets   proposed operations, once M35 keeps them
 *
 * Neither is written today, which is why the honest first state of this surface
 * is empty and says which milestone owes it what. The reading code is real: the
 * moment either lands, this draws.
 */

interface LoadState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly instances: readonly TreeInstanceRecord[];
  readonly proposed: readonly ProposedSet[];
  readonly unreadable: number;
}

const EMPTY: LoadState = { status: 'loading', instances: [], proposed: [], unreadable: 0 };

export function MapSurface() {
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const graphLabelId = useId();

  const [stored, setStored] = useState<LoadState>(EMPTY);
  const [showExample, setShowExample] = useState(false);

  useEffect(() => {
    let live = true;

    const read = async (): Promise<LoadState> => {
      const storage = createStorage();
      const instances: TreeInstanceRecord[] = [];
      const proposed: ProposedSet[] = [];
      let unreadable = 0;

      /*
       * Every record is parsed, and a record that fails is counted rather than
       * thrown on. These rows are written by other surfaces' code (M34, M35) and
       * their shapes will move; a map that refused to draw anything because one
       * project row grew a field would be a map that breaks whenever somebody
       * else ships. The count is shown, so the failure is never silent either.
       */
      for (const record of await storage.list('projects')) {
        const parsed = StoredProject.safeParse(record);
        if (!parsed.success) {
          unreadable += 1;
          continue;
        }
        if (parsed.data.tree) instances.push(...parsed.data.tree.instances);
      }

      for (const record of await storage.list('changesets')) {
        const envelope = record as { id?: unknown; status?: unknown; changeSet?: unknown };
        const parsed = ChangeSet.safeParse(envelope.changeSet);
        if (!parsed.success) {
          unreadable += 1;
          continue;
        }
        proposed.push({
          changeSetId: parsed.data.id,
          status: typeof envelope.status === 'string' ? envelope.status : parsed.data.status,
          changeSet: parsed.data,
        });
      }

      return { status: 'ready', instances, proposed, unreadable };
    };

    void read()
      .then((next) => {
        if (live) setStored(next);
      })
      .catch(() => {
        // `StorageUnavailableError` — a private window, blocked site data, a
        // full quota. A state to describe, not an exception to swallow.
        if (live) setStored({ ...EMPTY, status: 'unavailable' });
      });

    return () => {
      live = false;
    };
  }, []);

  const graph = useMemo(() => {
    if (showExample) return buildGraph({ instances: EXAMPLE_INSTANCES, proposed: [] }, 0);
    return buildGraph(
      { instances: stored.instances, proposed: stored.proposed },
      stored.unreadable,
    );
  }, [showExample, stored]);

  const layout = useMemo(() => layoutGraph(graph), [graph]);

  const selected = params.get('node');
  const selectedNode = graph.nodes.find((node) => node.path === selected) ?? null;

  const select = useCallback(
    (path: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (path === null) next.delete('node');
      else next.set('node', path);
      const search = next.toString();
      // `replace`, not `push`: walking a graph is looking around one page, and a
      // history entry per node would turn Back into "undo one glance".
      router.replace(search.length > 0 ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  if (stored.status === 'loading') {
    return <p className="fb-meta">{t('common.loading')}</p>;
  }

  if (graph.nodes.length === 0) {
    return (
      <EmptyMap
        unavailable={stored.status === 'unavailable'}
        onShowExample={() => {
          setShowExample(true);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {showExample ? (
        /*
          The example banner. Present for as long as the example is, carrying the
          control that clears it — not a toast, not a footnote. See
          `example-place.ts` for the three rules this is the visible half of.
        */
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-rule-strong bg-sunken px-4 py-2">
          <p className="text-[0.9375rem] text-fg">{t('map.example.banner')}</p>
          <Button
            weight="secondary"
            onClick={() => {
              setShowExample(false);
              select(null);
            }}
          >
            {t('map.example.clear')}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id={graphLabelId} className="fb-label">
          {t('map.graph.label')}
        </h2>
        <p className="fb-meta">
          {t('map.graph.counts', { nodes: graph.nodes.length, edges: graph.edges.length })}
        </p>
        {graph.omittedInstances > 0 ? (
          <p className="fb-meta">{t('map.graph.omitted', { count: graph.omittedInstances })}</p>
        ) : null}
        {graph.unreadableRecords > 0 ? (
          <p className="fb-meta">{t('map.graph.unreadable', { count: graph.unreadableRecords })}</p>
        ) : null}
      </div>

      <GraphView
        layout={layout}
        selected={selectedNode?.path ?? null}
        onSelect={(path) => {
          select(path);
        }}
        labelledBy={graphLabelId}
      />

      {/*
        The limits of the extractor, on the surface rather than in a doc. It reads
        what a script says, not what it computes: a require assembled from a
        variable draws no line here and cannot. A map whose gaps are undocumented
        is a map somebody eventually trusts about something it never claimed.
      */}
      <p className="fb-meta max-w-[var(--fb-measure)]">{t('map.caveat.body')}</p>

      <Register
        labelId="map-node-panel"
        title={t('map.panel.title')}
        meta={
          selectedNode === null ? null : (
            <Button
              weight="secondary"
              onClick={() => {
                select(null);
              }}
            >
              {t('map.panel.clear')}
            </Button>
          )
        }
      >
        {selectedNode === null ? (
          <p className="fb-meta">{t('map.panel.empty')}</p>
        ) : (
          <NodePanel
            graph={graph}
            node={selectedNode}
            onSelect={(path) => {
              select(path);
            }}
          />
        )}
      </Register>
    </div>
  );
}

/**
 * Nothing to draw, written as a route forward.
 *
 * Modelled on `daemon-empty-state.tsx`, and for the same reason: for everybody
 * reading this today it is not an error, it is the starting state, and the only
 * useful thing the page can do is say exactly where the data would come from and
 * who owes it.
 */
function EmptyMap({
  unavailable,
  onShowExample,
}: {
  unavailable: boolean;
  onShowExample: () => void;
}) {
  const { t } = useLocale();

  return (
    <div className="flex max-w-[var(--fb-measure)] flex-col gap-6">
      <section aria-labelledby="map-empty" className="flex flex-col gap-2">
        <h2 id="map-empty" className="text-[1.25rem]">
          {t(unavailable ? 'map.empty.unavailableTitle' : 'map.empty.title')}
        </h2>
        <p className="text-fg-muted">
          {t(unavailable ? 'map.empty.unavailableBody' : 'map.empty.body')}
        </p>
      </section>

      {unavailable ? null : (
        <section aria-labelledby="map-sources" className="flex flex-col gap-2">
          <h3 id="map-sources" className="fb-label">
            {t('map.empty.sourcesTitle')}
          </h3>
          <ul className="flex list-none flex-col gap-2 border-s-2 border-rule ps-4">
            <li className="text-[0.9375rem]">
              {t('map.empty.fromProject')} — <Code>projects</Code>
            </li>
            <li className="text-[0.9375rem]">
              {t('map.empty.fromChangeSets')} — <Code>changesets</Code>
            </li>
          </ul>
        </section>
      )}

      <section
        aria-labelledby="map-example"
        className="flex flex-col gap-3 border-t border-rule pt-4"
      >
        <h3 id="map-example" className="fb-label">
          {t('map.empty.exampleTitle')}
        </h3>
        <p className="text-[0.9375rem] text-fg-muted">{t('map.empty.exampleBody')}</p>
        <div>
          <Button weight="secondary" onClick={onShowExample}>
            {t('map.empty.exampleAction')}
          </Button>
        </div>
      </section>
    </div>
  );
}
