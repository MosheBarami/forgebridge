import { describe, expect, it } from 'vitest';
import { InstancePath } from '@forgebridge/protocol';

import en from '@/i18n/dictionaries/en.json';
import he from '@/i18n/dictionaries/he.json';
import { CARDS, CARD_CATEGORIES, cardKey } from './catalog';

/**
 * The catalog is data, and data that is not checked drifts.
 *
 * Three classes of failure this closes, all of which have exactly one symptom
 * for a user — a card that looks fine and does not work:
 *
 *   a path that the protocol could never address, so the run it starts is
 *   refused at submit and the user is told their prompt was bad;
 *   a card with no dictionary entry, which renders as the raw key
 *   `inventory.cards.shop.title` in the middle of a list of real titles;
 *   a Hebrew dictionary that has fallen behind the English one, which is
 *   invisible to everyone who does not read Hebrew — which is most reviewers.
 *
 * TODO(M50): a community submission runs this same set of assertions
 * server-side before it is accepted. The rules a submitted card has to satisfy
 * should be these rules, not a second, looser copy of them.
 */

function lookup(dictionary: unknown, key: string): unknown {
  let node: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('the mechanic card catalog', () => {
  it('ships a real starter set', () => {
    // M36 asks for at least twelve genuinely common Roblox mechanics.
    expect(CARDS.length).toBeGreaterThanOrEqual(12);
  });

  it('has unique ids that are safe URL segments', () => {
    const ids = CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it.each(CARDS)('$id names only addressable instance paths', (card) => {
    for (const entry of card.scope) {
      const parsed = InstancePath.safeParse(entry.path);
      expect(parsed.success, `${card.id}: scope path "${entry.path}" is not addressable`).toBe(true);
    }
    for (const operation of card.plan) {
      const parsed = InstancePath.safeParse(operation.path);
      expect(parsed.success, `${card.id}: plan path "${operation.path}" is not addressable`).toBe(
        true,
      );
    }
  });

  it.each(CARDS)('$id plans only inside its declared scope', (card) => {
    // Segment-aware containment, the same rule `isWithin` uses in the protocol:
    // a plan that wrote to `ServerScriptService.ShopAdmin` under a scope of
    // `ServerScriptService.Shop` would be a card whose stated scope is a lie.
    for (const operation of card.plan) {
      const covered = card.scope.some((entry) => {
        if (entry.intent === 'reads') return false;
        const prefix = entry.path.split('.');
        const target = operation.path.split('.');
        if (target.length < prefix.length) return false;
        return prefix.every((segment, index) => target[index] === segment);
      });
      expect(covered, `${card.id}: plans ${operation.path}, which no writable scope covers`).toBe(
        true,
      );
    }
  });

  it.each(CARDS)('$id is in a known category and has a real prompt', (card) => {
    expect(CARD_CATEGORIES).toContain(card.category);
    // Not a length check for its own sake: a one-line prompt is a card that
    // will not constrain a model, and a card that does not constrain a model is
    // a card whose scope table is decoration.
    expect(card.prompt.trim().length).toBeGreaterThan(200);
    expect(card.scope.length).toBeGreaterThan(0);
    expect(card.plan.length).toBeGreaterThan(0);
  });

  it.each(CARDS)('$id is translated in every locale', (card) => {
    for (const [name, dictionary] of [
      ['en', en],
      ['he', he],
    ] as const) {
      for (const field of ['title', 'summary', 'caveat'] as const) {
        const value = lookup(dictionary, cardKey(card.id, field));
        expect(typeof value, `${name} is missing ${cardKey(card.id, field)}`).toBe('string');
        expect(String(value).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has no orphan card entries in either dictionary', () => {
    const ids = new Set(CARDS.map((card) => card.id));
    for (const [name, dictionary] of [
      ['en', en],
      ['he', he],
    ] as const) {
      const entries = lookup(dictionary, 'inventory.cards');
      expect(typeof entries).toBe('object');
      for (const key of Object.keys(entries as Record<string, unknown>)) {
        expect(ids.has(key), `${name}: inventory.cards.${key} names no card in the catalog`).toBe(
          true,
        );
      }
    }
  });

  it('translates every category and scope intent in every locale', () => {
    const keys = [
      ...CARD_CATEGORIES.map((name) => `inventory.category.${name}`),
      'inventory.scopeIntent.creates',
      'inventory.scopeIntent.writes',
      'inventory.scopeIntent.reads',
      'inventory.source.starter',
      'inventory.source.community',
    ];
    for (const [name, dictionary] of [
      ['en', en],
      ['he', he],
    ] as const) {
      for (const key of keys) {
        expect(typeof lookup(dictionary, key), `${name} is missing ${key}`).toBe('string');
      }
    }
  });
});
