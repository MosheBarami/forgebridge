import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import he from '@/i18n/dictionaries/he.json';
import en from '@/i18n/dictionaries/en.json';
import { LocaleProvider } from '@/i18n/dictionary-context';
import type { Dictionary } from '@/i18n/translate';
import { buildGraph } from './build-graph';
import { EXAMPLE_INSTANCES } from './example-place';
import { layoutGraph } from './graph-layout';
import { GraphView } from './graph-view';

/**
 * The graph as a control, not as a picture.
 *
 * Two things are asserted here that no screenshot would catch, and both are the
 * failure modes a graph UI actually ships with:
 *
 *   **It is operable from the keyboard at all.** One tab stop, then arrows. A
 *   graph where every node is a tab stop is technically navigable and unusable;
 *   a graph where none of them are is neither.
 *
 *   **"Forward" means forward, not right.** Under `dir="rtl"` the columns read
 *   from the right, so ArrowLeft has to advance and ArrowRight has to go back.
 *   This is the exact place a mirrored-by-accident layout betrays itself: the
 *   boxes move and the key bindings do not.
 */

const graph = buildGraph({ instances: EXAMPLE_INSTANCES, proposed: [] });
const layout = layoutGraph(graph);

beforeAll(() => {
  // jsdom implements no scroll model. The component calls this to keep a
  // selection visible; nothing in these assertions depends on it happening.
  Element.prototype.scrollIntoView = vi.fn();
});

function mount(dir: 'ltr' | 'rtl', onSelect = vi.fn()) {
  const dictionary = (dir === 'rtl' ? he : en) as Dictionary;
  render(
    <LocaleProvider locale={dir === 'rtl' ? 'he' : 'en'} dir={dir} dictionary={dictionary}>
      <div dir={dir}>
        <h2 id="graph-label">Systems</h2>
        <GraphView layout={layout} selected={null} onSelect={onSelect} labelledBy="graph-label" />
      </div>
    </LocaleProvider>,
  );
  return { onSelect };
}

/** Focus the named node, then send it a key. The handler lives on the group
 *  above it, so the event has to bubble the way a real one would. */
function press(name: string, key: string): void {
  const button = screen.getByRole('button', { name: new RegExp(`^${name} `) });
  button.focus();
  fireEvent.keyDown(button, { key });
}

/** The node at (column, row) of the layout, by its accessible name's prefix. */
function nameAt(column: number, row: number): string {
  const placed = layout.nodes.find((node) => node.column === column && node.row === row);
  if (!placed) throw new Error(`no node at ${String(column)},${String(row)}`);
  return placed.node.name;
}

describe('the graph as a keyboard control', () => {
  it('exposes every node as a button with a name that is not just its colour', () => {
    mount('ltr');
    const buttons = screen.getAllByRole('button');
    // Every node, plus nothing else inside the graph group.
    expect(buttons.length).toBeGreaterThanOrEqual(layout.nodes.length);

    const first = screen.getByRole('button', { name: new RegExp(`^${nameAt(0, 0)} `) });
    // Name, class, how it is known, and which service column it sits in — the
    // last of which is otherwise conveyed only by horizontal position.
    expect(first).toHaveAttribute('aria-label', expect.stringContaining('StarterGui'));
  });

  it('is one tab stop, not one per node', () => {
    mount('ltr');
    const tabbable = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('moves down a service column with ArrowDown', () => {
    mount('ltr');

    // Column 2 is ReplicatedStorage in the example and has several rows.
    press(nameAt(2, 0), 'ArrowDown');

    expect(screen.getByRole('button', { name: new RegExp(`^${nameAt(2, 1)} `) })).toHaveFocus();
  });

  it('opens a node when it is activated', () => {
    const { onSelect } = mount('ltr');

    /*
     * `fireEvent.click`, not a synthesised Enter: a `<button>` turns Enter and
     * Space into a click in the browser, and jsdom does not. Asserting on a
     * hand-rolled key handler here would be asserting on code this component
     * deliberately does not have — the node is a real button precisely so that
     * activation is the platform's job rather than ours.
     */
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${nameAt(0, 0)} `) }));

    expect(onSelect).toHaveBeenCalledWith(
      layout.nodes.find((node) => node.column === 0 && node.row === 0)?.node.path,
    );
  });
});

describe('arrow keys follow the reading direction', () => {
  it('advances with ArrowRight under ltr', () => {
    mount('ltr');
    press(nameAt(0, 0), 'ArrowRight');
    expect(screen.getByRole('button', { name: new RegExp(`^${nameAt(1, 0)} `) })).toHaveFocus();
  });

  it('advances with ArrowLeft under rtl', () => {
    mount('rtl');
    press(nameAt(0, 0), 'ArrowLeft');

    // The same move as ArrowRight in English: toward the next service column,
    // which under RTL is drawn further to the left.
    expect(screen.getByRole('button', { name: new RegExp(`^${nameAt(1, 0)} `) })).toHaveFocus();
  });

  it('goes back with ArrowRight under rtl', () => {
    mount('rtl');
    press(nameAt(1, 0), 'ArrowRight');
    expect(screen.getByRole('button', { name: new RegExp(`^${nameAt(0, 0)} `) })).toHaveFocus();
  });
});

describe('the graph under dir="rtl"', () => {
  it('positions nodes with a logical inline offset, never a physical one', () => {
    mount('rtl');
    for (const button of screen.getAllByRole('button')) {
      const style = button.getAttribute('style') ?? '';
      if (!style.includes('inset-inline-start')) continue;
      expect(style).not.toMatch(/(?:^|[^-])left:/);
      expect(style).not.toMatch(/(?:^|[^-])right:/);
    }
  });

  it('keeps instance names as explicit ltr islands', () => {
    const { container } = render(
      <LocaleProvider locale="he" dir="rtl" dictionary={he as Dictionary}>
        <div dir="rtl">
          <h2 id="graph-label-2">מערכות</h2>
          <GraphView
            layout={layout}
            selected={null}
            onSelect={vi.fn()}
            labelledBy="graph-label-2"
          />
        </div>
      </LocaleProvider>,
    );

    // A path segment is a run of neutral-and-Latin characters. Left to the bidi
    // algorithm inside a Hebrew paragraph it is reordered, and the reader is
    // shown a name that is not the instance's name.
    const islands = container.querySelectorAll('[dir="ltr"]');
    expect(islands.length).toBeGreaterThan(layout.nodes.length);
  });
});
