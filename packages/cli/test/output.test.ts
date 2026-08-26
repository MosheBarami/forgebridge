import { describe, expect, it } from 'vitest';
import { renderTable, shouldUseColour, truncate } from '../src/output.js';
import { humanCount, humanDuration, relativeTime } from '../src/format.js';

const ESC = '\u001B';

describe('colour is a terminal courtesy, not a default', () => {
  it('emits colour only on a TTY', () => {
    expect(shouldUseColour({ isTTY: true }, {}, false)).toBe(true);
    expect(shouldUseColour({ isTTY: false }, {}, false)).toBe(false);
    expect(shouldUseColour({}, {}, false)).toBe(false);
  });

  it('never colours machine output', () => {
    // Escape sequences inside a JSON document are a parse failure waiting to
    // happen, on the one mode whose whole point is being parsed.
    expect(shouldUseColour({ isTTY: true }, {}, true)).toBe(false);
    expect(shouldUseColour({ isTTY: true }, { FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('honours NO_COLOR by presence, whatever its value', () => {
    for (const value of ['', '0', 'false', '1']) {
      expect(shouldUseColour({ isTTY: true }, { NO_COLOR: value }, false)).toBe(false);
    }
  });

  it('lets FORCE_COLOR override an absent TTY', () => {
    expect(shouldUseColour({ isTTY: false }, { FORCE_COLOR: '1' }, false)).toBe(true);
    // NO_COLOR wins: the switch someone went looking for beats the one a CI
    // image set for them.
    expect(shouldUseColour({ isTTY: false }, { FORCE_COLOR: '1', NO_COLOR: '' }, false)).toBe(false);
  });
});

describe('tables', () => {
  it('aligns columns and carries no escape sequences of its own', () => {
    const table = renderTable(
      [{ header: 'MODEL' }, { header: 'CONTEXT', align: 'right' }],
      [
        ['a/short', '8,192'],
        ['a/considerably-longer-id', '200,000'],
      ],
    );
    const [header, rule, first, second] = table.split('\n');
    expect(header).toMatch(/^MODEL\s+CONTEXT$/);
    expect(rule).toMatch(/^─+\s+─+$/);
    expect(first).toContain('  8,192');
    expect(second).toContain('200,000');
    expect(table).not.toContain(ESC);
  });

  it('sizes to the widest cell, including the header', () => {
    const table = renderTable([{ header: 'LONGHEADER' }], [['x']]);
    expect(table.split('\n')[1]).toHaveLength('LONGHEADER'.length);
  });

  it('renders with no rows at all', () => {
    expect(renderTable([{ header: 'MODEL' }], []).split('\n')).toHaveLength(2);
  });
});

describe('truncation and counts', () => {
  it('collapses whitespace and marks what it cut', () => {
    expect(truncate('one   two\nthree', 100)).toBe('one two three');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abcd', 4)).toBe('abcd');
  });

  it('groups long numbers so a context window is readable', () => {
    expect(humanCount(200_000)).toBe('200,000');
    expect(humanCount(8192)).toBe('8,192');
  });
});

describe('durations', () => {
  it('rounds to a unit a person reads at a glance', () => {
    expect(humanDuration(3)).toBe('3s');
    expect(humanDuration(90)).toBe('1m');
    expect(humanDuration(3600)).toBe('1h');
    expect(humanDuration(7800)).toBe('2h 10m');
    expect(humanDuration(200_000)).toBe('2d');
  });

  it('does not invent a duration from a nonsense input', () => {
    expect(humanDuration(Number.NaN)).toBe('unknown');
    expect(humanDuration(-1)).toBe('unknown');
  });

  it('reports a never-seen link as never, not as a very long time ago', () => {
    expect(relativeTime(null)).toBe('never');
    expect(relativeTime('not a date')).toBe('unknown');
  });

  it('shows clock skew rather than hiding it at zero', () => {
    // A link last seen after now means the two clocks disagree, which is worth
    // seeing rather than rounding away.
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(relativeTime('2026-01-01T00:01:00.000Z', now)).toMatch(/^in the future/);
    expect(relativeTime('2025-12-31T23:59:00.000Z', now)).toBe('1m ago');
  });
});
