import { describe, expect, it } from 'vitest';

import { referencesIn } from './references';
import { buildGraph } from './build-graph';
import { EXAMPLE_INSTANCES } from './example-place';

/**
 * The extractor, pinned by the shapes real Roblox code is written in.
 *
 * The last block is the one that matters most: it asserts what this scanner
 * *cannot* do. A test that only proves the happy cases would let somebody
 * "improve" the resolver into guessing at a runtime lookup, and a guessed edge
 * on a dependency map is worse than a missing one — the missing edge is a gap
 * the surface already tells the reader about, and the guessed one is a line they
 * have no reason to doubt.
 */

const SELF = 'ServerScriptService.ShopService';

describe('resolving instance chains', () => {
  it('follows a GetService alias through a WaitForChild', () => {
    const found = referencesIn(
      SELF,
      [
        'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
        'local Remotes = ReplicatedStorage:WaitForChild("Remotes")',
        'Remotes.PurchaseItem:InvokeServer("sword")',
      ].join('\n'),
    );

    expect(found).toContainEqual(
      expect.objectContaining({
        kind: 'remote',
        target: 'ReplicatedStorage.Remotes.PurchaseItem',
      }),
    );
  });

  it('reads a require through a dotted service access', () => {
    const found = referencesIn(
      SELF,
      'local Catalog = require(game.ReplicatedStorage.ShopCatalog)\n',
    );
    expect(found).toEqual([
      expect.objectContaining({ kind: 'require', target: 'ReplicatedStorage.ShopCatalog' }),
    ]);
  });

  it('resolves script.Parent relative to the script that holds the text', () => {
    const found = referencesIn(SELF, 'local Stats = require(script.Parent.LeaderstatsService.Stats)');
    expect(found[0]?.target).toBe('ServerScriptService.LeaderstatsService.Stats');
  });

  it('resolves require(script.Child) inside the script itself', () => {
    const found = referencesIn('ServerScriptService.LeaderstatsService', 'require(script.Stats)');
    expect(found[0]?.target).toBe('ServerScriptService.LeaderstatsService.Stats');
  });

  it('sees a remote through an OnServerEvent connection', () => {
    const found = referencesIn(
      SELF,
      [
        'local RS = game:GetService("ReplicatedStorage")',
        'RS.Remotes.SetSprinting.OnServerEvent:Connect(function(player) end)',
      ].join('\n'),
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: 'remote',
        target: 'ReplicatedStorage.Remotes.SetSprinting',
      }),
    );
  });

  it('sees a remote assigned through OnServerInvoke', () => {
    const found = referencesIn(
      SELF,
      [
        'local RS = game:GetService("ReplicatedStorage")',
        'RS.Remotes.PurchaseItem.OnServerInvoke = function() return false end',
      ].join('\n'),
    );
    expect(found.map((reference) => reference.target)).toContain(
      'ReplicatedStorage.Remotes.PurchaseItem',
    );
  });

  it('accepts a bracketed string child', () => {
    const found = referencesIn(
      SELF,
      'local RS = game:GetService("ReplicatedStorage")\nrequire(RS["ShopCatalog"])',
    );
    expect(found[0]?.target).toBe('ReplicatedStorage.ShopCatalog');
  });

  it('carries the matched text as evidence', () => {
    const found = referencesIn(SELF, 'require(game.ReplicatedStorage.ShopCatalog)');
    expect(found[0]?.evidence).toContain('game.ReplicatedStorage.ShopCatalog');
  });

  it('ignores a require that only appears inside a comment', () => {
    const found = referencesIn(
      SELF,
      ['-- require(game.ReplicatedStorage.Old)', '--[[ require(game.ServerStorage.Older) ]]'].join(
        '\n',
      ),
    );
    expect(found).toEqual([]);
  });
});

describe('what the extractor refuses to guess', () => {
  it('reports a runtime-built child lookup as unresolved rather than inventing a path', () => {
    const found = referencesIn(
      SELF,
      [
        'local RS = game:GetService("ReplicatedStorage")',
        'local name = "Purchase" .. "Item"',
        'RS.Remotes[name]:InvokeServer()',
      ].join('\n'),
    );
    // The chain stops at the bracket it cannot read, so the reference is to
    // `ReplicatedStorage.Remotes` or is null — never to a fabricated leaf.
    for (const reference of found) {
      expect(reference.target).not.toBe('ReplicatedStorage.Remotes.PurchaseItem');
    }
  });

  it('resolves nothing rooted at an unknown local', () => {
    expect(referencesIn(SELF, 'require(someTable.Thing)')[0]?.target).toBeNull();
  });

  it('refuses a path that walks above a service root', () => {
    expect(referencesIn('ReplicatedStorage.Thing', 'require(script.Parent.Parent)')[0]?.target).toBe(
      null,
    );
  });
});

describe('the example place, read by the real extractor', () => {
  const graph = buildGraph({ instances: EXAMPLE_INSTANCES, proposed: [] });

  it('draws a connected graph rather than a list of islands', () => {
    expect(graph.nodes.length).toBeGreaterThan(6);
    expect(graph.edges.length).toBeGreaterThan(6);
  });

  it('joins the shop across the client/server boundary', () => {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'StarterGui.ShopGui.Controller',
        to: 'ReplicatedStorage.Remotes.PurchaseItem',
        kind: 'remote',
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'ServerScriptService.ShopService',
        to: 'ReplicatedStorage.Remotes.PurchaseItem',
        kind: 'remote',
      }),
    );
  });

  it('finds the shared module three services require', () => {
    const requirers = graph.edges
      .filter((edge) => edge.to === 'ServerScriptService.LeaderstatsService.Stats')
      .map((edge) => edge.from);
    expect(requirers).toContain('ServerScriptService.ShopService');
    expect(requirers).toContain('ServerScriptService.CheckpointService');
    expect(requirers).toContain('ServerScriptService.CoinService');
  });

  it('counts the instances it chose not to draw instead of dropping them silently', () => {
    // Folders that nothing requires and no remote points at: they are part of
    // the place, they are not part of the map, and the number says so.
    expect(graph.omittedInstances).toBeGreaterThan(0);
  });

  it('marks everything as living in the place, since the example is a snapshot', () => {
    const origins = new Set(graph.nodes.map((node) => node.origin));
    expect(origins.has('proposed')).toBe(false);
  });
});
