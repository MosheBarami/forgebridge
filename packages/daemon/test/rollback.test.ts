import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ForgeBridgeError,
  JournalEntry,
  Link,
  nameOf,
  parentOf,
  type InverseOperation,
  type Operation,
} from '@forgebridge/protocol';
import { canonicalJson } from '../src/envelope.js';
import { InMemoryDaemonStore, type JournalRecord } from '../src/store.js';
import {
  InMemoryJournalEntryStore,
  journalStateOf,
  planRollback,
  planRollbackFor,
  recordJournalEntry,
  recordRollbackResult,
  rollbackDeliveryFor,
  rollbackStatusOf,
  RollbackResult,
  type RollbackDeps,
} from '../src/rollback.js';
import { makeChangeSet } from './helpers.js';

/* ────────────────────────────────────────────────────────────────────────────
 * A reference consumer.
 *
 * The daemon holds no tree, so a rollback test that only exercised the daemon
 * would assert that the right inverses were listed in the right order and stop
 * exactly where the interesting question starts. ADR-012 does not promise an
 * ordered list; it promises the tree comes back.
 *
 * So this is a small stand-in for the Studio plugin: it applies operations to an
 * in-memory tree, captures inverses the way `plugin/src/Journal.luau` does, and
 * replays them. It is deliberately written from `Journal.luau`'s rules rather
 * than from `rollback.ts`'s — a fixture derived from the implementation it
 * checks agrees with that implementation by construction, including when both
 * are wrong.
 *
 * What it is not is a Roblox emulator. There is no property reflection, no
 * Archivable, no engine defaults. It models exactly the five operations the
 * protocol has and the five inverses that reverse them, which is the part the
 * journal is a record of.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Node {
  className: string;
  properties: Record<string, unknown>;
  source?: string;
  children: Record<string, Node>;
}

/** Service roots are containers too, so the tree is just the top-level one. */
type Tree = Record<string, Node>;

/** A subtree as plain data — the plugin's own format, opaque to the daemon. */
interface Described {
  name: string;
  className: string;
  properties: Record<string, unknown>;
  source?: string;
  children: Described[];
}

function node(className: string, properties: Record<string, unknown> = {}, children: Record<string, Node> = {}): Node {
  return { className, properties, children };
}

/** The record that holds the instance named by the last segment, or null. */
function containerOf(tree: Tree, path: string): Record<string, Node> | null {
  const segments = path.split('.');
  let container: Record<string, Node> = tree;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = container[segments[i] as string];
    if (!next) return null;
    container = next.children;
  }
  return container;
}

function resolve(tree: Tree, path: string): Node | null {
  const container = containerOf(tree, path);
  return container ? container[nameOf(path)] ?? null : null;
}

function describeSubtree(name: string, instance: Node): Described {
  return {
    name,
    className: instance.className,
    properties: structuredClone(instance.properties),
    ...(instance.source === undefined ? {} : { source: instance.source }),
    children: Object.entries(instance.children).map(([childName, child]) => describeSubtree(childName, child)),
  };
}

function rebuildSubtree(container: Record<string, Node>, described: Described): void {
  const rebuilt: Node = {
    className: described.className,
    properties: structuredClone(described.properties),
    ...(described.source === undefined ? {} : { source: described.source }),
    children: {},
  };
  container[described.name] = rebuilt;
  for (const child of described.children) rebuildSubtree(rebuilt.children, child);
}

class ReferenceConsumer {
  constructor(readonly tree: Tree) {}

  /** The inverse of an operation, captured before it runs. Never after. */
  capture(operation: Operation): InverseOperation {
    switch (operation.op) {
      case 'createInstance':
        return { inverse: 'deleteCreated', path: operation.path };

      case 'setProperty': {
        const target = resolve(this.tree, operation.path);
        if (!target) throw new Error(`cannot capture a previous value: "${operation.path}" does not exist`);
        // `{ t: 'Nil' }` for a property that has no value yet, so that restoring
        // it removes the key rather than leaving one the tree never had. Without
        // that the "exact prior state" assertion passes on a tree that gained a
        // property from being rolled back.
        const previous = operation.property in target.properties
          ? structuredClone(target.properties[operation.property])
          : { t: 'Nil' };
        return { inverse: 'restoreProperty', path: operation.path, property: operation.property, previous };
      }

      case 'writeScript': {
        const target = resolve(this.tree, operation.path);
        // A writeScript against a path that does not exist creates the script,
        // so its inverse is a delete rather than a source restore.
        if (!target) return { inverse: 'deleteCreated', path: operation.path };
        return { inverse: 'restoreSource', path: operation.path, previousSource: target.source ?? '' };
      }

      case 'moveInstance': {
        if (!resolve(this.tree, operation.path)) {
          throw new Error(`cannot capture a move: "${operation.path}" does not exist`);
        }
        // After the move the instance lives at `to`, so that is where a rollback
        // looks for it; `from` is where it came from and where it goes back.
        return { inverse: 'moveBack', path: operation.to, from: operation.path };
      }

      case 'deleteInstance': {
        const target = resolve(this.tree, operation.path);
        if (!target) throw new Error(`cannot capture a delete: "${operation.path}" does not exist`);
        const parentPath = parentOf(operation.path);
        if (parentPath === null) throw new Error(`"${operation.path}" is a service root and cannot be deleted`);
        return {
          inverse: 'restoreSubtree',
          parentPath,
          serialised: JSON.stringify(describeSubtree(nameOf(operation.path), target)),
        };
      }
    }
  }

  apply(operation: Operation): void {
    switch (operation.op) {
      case 'createInstance': {
        const container = containerOf(this.tree, operation.path);
        if (!container) throw new Error(`no parent for "${operation.path}"`);
        if (container[nameOf(operation.path)]) throw new Error(`"${operation.path}" already exists`);
        container[nameOf(operation.path)] = node(operation.className, structuredClone(operation.properties));
        return;
      }
      case 'setProperty': {
        const target = resolve(this.tree, operation.path);
        if (!target) throw new Error(`"${operation.path}" does not exist`);
        target.properties[operation.property] = structuredClone(operation.value);
        return;
      }
      case 'writeScript': {
        const existing = resolve(this.tree, operation.path);
        if (existing) {
          existing.source = operation.source;
          return;
        }
        const container = containerOf(this.tree, operation.path);
        if (!container) throw new Error(`no parent for "${operation.path}"`);
        container[nameOf(operation.path)] = { ...node(operation.scriptType), source: operation.source };
        return;
      }
      case 'moveInstance': {
        const from = containerOf(this.tree, operation.path);
        const moving = from?.[nameOf(operation.path)];
        if (!from || !moving) throw new Error(`"${operation.path}" does not exist`);
        const to = containerOf(this.tree, operation.to);
        if (!to) throw new Error(`no parent for "${operation.to}"`);
        delete from[nameOf(operation.path)];
        to[nameOf(operation.to)] = moving;
        return;
      }
      case 'deleteInstance': {
        const container = containerOf(this.tree, operation.path);
        if (!container?.[nameOf(operation.path)]) throw new Error(`"${operation.path}" does not exist`);
        delete container[nameOf(operation.path)];
        return;
      }
    }
  }

  replay(inverse: InverseOperation): void {
    switch (inverse.inverse) {
      case 'deleteCreated': {
        const container = containerOf(this.tree, inverse.path);
        if (!container?.[nameOf(inverse.path)]) throw new Error(`nothing to delete at "${inverse.path}"`);
        delete container[nameOf(inverse.path)];
        return;
      }
      case 'restoreProperty': {
        const target = resolve(this.tree, inverse.path);
        if (!target) throw new Error(`"${inverse.path}" does not exist`);
        const previous = inverse.previous as { t?: string } | undefined;
        if (previous && previous.t === 'Nil') delete target.properties[inverse.property];
        else target.properties[inverse.property] = structuredClone(inverse.previous);
        return;
      }
      case 'restoreSource': {
        const target = resolve(this.tree, inverse.path);
        if (!target) throw new Error(`"${inverse.path}" does not exist`);
        target.source = inverse.previousSource;
        return;
      }
      case 'moveBack': {
        const from = containerOf(this.tree, inverse.path);
        const moving = from?.[nameOf(inverse.path)];
        if (!from || !moving) throw new Error(`nothing to move back from "${inverse.path}"`);
        const to = containerOf(this.tree, inverse.from);
        if (!to) throw new Error(`no parent for "${inverse.from}"`);
        delete from[nameOf(inverse.path)];
        to[nameOf(inverse.from)] = moving;
        return;
      }
      case 'restoreSubtree': {
        const container = resolve(this.tree, inverse.parentPath);
        if (!container) throw new Error(`"${inverse.parentPath}" does not exist`);
        rebuildSubtree(container.children, JSON.parse(inverse.serialised) as Described);
        return;
      }
    }
  }
}

/** Apply a whole set the way the plugin does: capture, then apply, in order. */
function applyChangeSet(
  consumer: ReferenceConsumer,
  operations: readonly Operation[],
): { applied: { index: number; operation: Operation }[]; inverses: InverseOperation[] } {
  const applied: { index: number; operation: Operation }[] = [];
  const inverses: InverseOperation[] = [];
  operations.forEach((operation, index) => {
    // Capture first. A capture that fails is a hard stop for that operation:
    // applying something the plugin cannot reverse is exactly the outcome the
    // journal exists to prevent.
    const inverse = consumer.capture(operation);
    consumer.apply(operation);
    applied.push({ index, operation });
    inverses.push(inverse);
  });
  return { applied, inverses };
}

function freshTree(): Tree {
  return {
    Workspace: node('Workspace', {}, {
      Shop: node('Model', { Name: { t: 'String', v: 'Shop' } }, {
        Counter: node('Part', {
          Anchored: { t: 'Bool', v: true },
          Size: { t: 'Vector3', x: 4, y: 1, z: 4 },
        }),
        Sign: node('Part', { Transparency: { t: 'Number', v: 0.5 } }, {
          Label: node('TextLabel', { Text: { t: 'String', v: 'OPEN' } }),
        }),
      }),
      Spawn: node('SpawnLocation', { Anchored: { t: 'Bool', v: true } }),
    }),
    ServerScriptService: node('ServerScriptService', {}, {
      Purchase: { ...node('Script'), source: 'print("v1")' },
    }),
    ReplicatedStorage: node('ReplicatedStorage', {}, {}),
  };
}

/**
 * A set that uses every operation the protocol has, in an order where the
 * ordering is load-bearing: the `setProperty` at index 1 writes to the instance
 * the `createInstance` at index 0 made, so a replay in application order deletes
 * the instance before restoring its property.
 */
const ROUND_TRIP_OPERATIONS: Operation[] = [
  { op: 'createInstance', path: 'Workspace.Shop.Door', className: 'Part', properties: {} },
  { op: 'setProperty', path: 'Workspace.Shop.Door', property: 'Anchored', value: { t: 'Bool', v: true } },
  { op: 'setProperty', path: 'Workspace.Shop.Counter', property: 'Anchored', value: { t: 'Bool', v: false } },
  { op: 'writeScript', path: 'ServerScriptService.Purchase', scriptType: 'Script', source: 'print("v2")' },
  { op: 'writeScript', path: 'ServerScriptService.Refund', scriptType: 'Script', source: 'print("new")' },
  { op: 'moveInstance', path: 'Workspace.Spawn', to: 'ReplicatedStorage.Spawn' },
  // The one the whole mechanism is judged on: a subtree with properties, a
  // nested child of its own, and nothing left behind to read after it runs.
  { op: 'deleteInstance', path: 'Workspace.Shop.Sign' },
];

function makeEntry(
  overrides: Record<string, unknown> = {},
  seed: { applied?: unknown; inverses?: unknown } = {},
): JournalEntry {
  return JournalEntry.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    changeSetId: randomUUID(),
    summary: 'a set',
    applied: seed.applied ?? [{ index: 0, operation: ROUND_TRIP_OPERATIONS[0] }],
    inverses: seed.inverses ?? [{ inverse: 'deleteCreated', path: 'Workspace.Shop.Door' }],
    versionBefore: 3,
    versionAfter: 4,
    appliedAt: new Date().toISOString(),
    ...overrides,
  });
}

// ── the reference consumer itself ────────────────────────────────────────────

describe('the reference consumer', () => {
  it('actually changes the tree — a fixture nobody checks is a fixture that lies', () => {
    const consumer = new ReferenceConsumer(freshTree());
    applyChangeSet(consumer, ROUND_TRIP_OPERATIONS);

    expect(resolve(consumer.tree, 'Workspace.Shop.Door')).not.toBeNull();
    expect(resolve(consumer.tree, 'Workspace.Shop.Sign')).toBeNull();
    expect(resolve(consumer.tree, 'Workspace.Spawn')).toBeNull();
    expect(resolve(consumer.tree, 'ReplicatedStorage.Spawn')).not.toBeNull();
    expect(resolve(consumer.tree, 'ServerScriptService.Purchase')?.source).toBe('print("v2")');
    expect(resolve(consumer.tree, 'ServerScriptService.Refund')?.source).toBe('print("new")');
    expect(resolve(consumer.tree, 'Workspace.Shop.Counter')?.properties.Anchored).toEqual({ t: 'Bool', v: false });
  });
});

// ── the load-bearing test ────────────────────────────────────────────────────

describe('the journal round trip', () => {
  it('returns the tree to its exact prior state, subtree and all', () => {
    const consumer = new ReferenceConsumer(freshTree());
    const before = canonicalJson(consumer.tree);

    const { applied, inverses } = applyChangeSet(consumer, ROUND_TRIP_OPERATIONS);
    expect(canonicalJson(consumer.tree)).not.toBe(before);

    const entry = makeEntry({ versionBefore: 7, versionAfter: 8 }, { applied, inverses });
    const plan = planRollback(entry);
    for (const step of plan.steps) consumer.replay(step.inverse);

    // Not "looks about right": byte-for-byte the tree that was there before,
    // including the deleted subtree's nested child, its properties, and the
    // absence of everything the set added. A rollback that half-restores is
    // worse than none, so the assertion has to be one that a half-restore
    // cannot pass.
    expect(canonicalJson(consumer.tree)).toBe(before);
    expect(consumer.tree).toEqual(freshTree());
    expect(plan.restoresToVersion).toBe(7);
    expect(plan.reversesVersion).toBe(8);
  });

  it('restores a deleted subtree from the serialised blob alone, nested child included', () => {
    const consumer = new ReferenceConsumer(freshTree());
    const operations: Operation[] = [{ op: 'deleteInstance', path: 'Workspace.Shop.Sign' }];
    const { applied, inverses } = applyChangeSet(consumer, operations);

    const inverse = inverses[0] as Extract<InverseOperation, { inverse: 'restoreSubtree' }>;
    expect(inverse.inverse).toBe('restoreSubtree');
    expect(inverse.parentPath).toBe('Workspace.Shop');
    // The daemon never opens this. The test does, once, to state what the
    // consumer is expected to have put in it — the nested child is the part a
    // shallow capture would silently drop.
    expect(JSON.parse(inverse.serialised)).toMatchObject({
      name: 'Sign',
      className: 'Part',
      children: [{ name: 'Label', className: 'TextLabel' }],
    });

    const entry = makeEntry({}, { applied, inverses });
    for (const step of planRollback(entry).steps) consumer.replay(step.inverse);

    expect(consumer.tree).toEqual(freshTree());
  });

  it('replays in reverse: application order would delete the instance a property is restored on', () => {
    const consumer = new ReferenceConsumer(freshTree());
    const operations = ROUND_TRIP_OPERATIONS.slice(0, 2);
    const { applied, inverses } = applyChangeSet(consumer, operations);

    const plan = planRollback(makeEntry({}, { applied, inverses }));

    expect(plan.steps.map((step) => step.operationIndex)).toEqual([1, 0]);
    expect(plan.steps.map((step) => step.inverse.inverse)).toEqual(['restoreProperty', 'deleteCreated']);

    // The ordering is not a stylistic preference: run it the other way and the
    // replay fails outright, which is the good outcome. The bad outcome is the
    // one this ordering exists to prevent — an inverse that half-succeeds.
    const wrongWayRound = new ReferenceConsumer(freshTree());
    applyChangeSet(wrongWayRound, operations);
    expect(() => {
      for (const step of [...plan.steps].reverse()) wrongWayRound.replay(step.inverse);
    }).toThrow(/does not exist/);
  });

  it('restores a property the instance did not have by removing it again', () => {
    const consumer = new ReferenceConsumer(freshTree());
    const operations: Operation[] = [
      { op: 'setProperty', path: 'Workspace.Spawn', property: 'Transparency', value: { t: 'Number', v: 1 } },
    ];
    const { applied, inverses } = applyChangeSet(consumer, operations);

    expect(inverses[0]).toMatchObject({ inverse: 'restoreProperty', previous: { t: 'Nil' } });
    for (const step of planRollback(makeEntry({}, { applied, inverses })).steps) consumer.replay(step.inverse);

    // Not `Transparency: undefined`. The key is gone, because it was never there.
    expect(resolve(consumer.tree, 'Workspace.Spawn')?.properties).toEqual({ Anchored: { t: 'Bool', v: true } });
    expect(consumer.tree).toEqual(freshTree());
  });
});

// ── planRollback: the refusals ───────────────────────────────────────────────

describe('planRollback', () => {
  it('pins the reading of moveBack: path is where it is now, from is where it goes back', () => {
    const operation: Operation = { op: 'moveInstance', path: 'Workspace.Spawn', to: 'ReplicatedStorage.Spawn' };
    const applied = [{ index: 0, operation }];

    const plan = planRollback(
      makeEntry({}, { applied, inverses: [{ inverse: 'moveBack', path: 'ReplicatedStorage.Spawn', from: 'Workspace.Spawn' }] }),
    );
    expect(plan.steps).toHaveLength(1);

    // The union alone does not disambiguate this, so the swapped reading is a
    // silent misplacement rather than an error — unless something refuses it.
    expect(() =>
      planRollback(
        makeEntry({}, { applied, inverses: [{ inverse: 'moveBack', path: 'Workspace.Spawn', from: 'ReplicatedStorage.Spawn' }] }),
      ),
    ).toThrow(/after the move the instance is at "ReplicatedStorage.Spawn"/);
  });

  it('refuses an inverse that does not invert its operation', () => {
    const applied = [{ index: 0, operation: ROUND_TRIP_OPERATIONS[2] as Operation }];
    expect(() =>
      planRollback(makeEntry({}, { applied, inverses: [{ inverse: 'deleteCreated', path: 'Workspace.Shop.Counter' }] })),
    ).toThrow(/a property write is undone by restoring the previous value/);

    expect(() =>
      planRollback(
        makeEntry({}, {
          applied,
          inverses: [{ inverse: 'restoreProperty', path: 'Workspace.Shop.Counter', property: 'CanCollide', previous: null }],
        }),
      ),
    ).toThrow(/it restores "CanCollide", but the operation wrote "Anchored"/);
  });

  it('accepts either legal inverse of a writeScript, and nothing else', () => {
    const operation = ROUND_TRIP_OPERATIONS[3] as Operation;
    const applied = [{ index: 0, operation }];
    const path = 'ServerScriptService.Purchase';

    expect(planRollback(makeEntry({}, { applied, inverses: [{ inverse: 'restoreSource', path, previousSource: 'x' }] })).steps)
      .toHaveLength(1);
    // The script did not exist before, so the write created it and the inverse
    // is a delete. The daemon holds no tree and cannot tell which case applied.
    expect(planRollback(makeEntry({}, { applied, inverses: [{ inverse: 'deleteCreated', path }] })).steps).toHaveLength(1);
    expect(() =>
      planRollback(makeEntry({}, { applied, inverses: [{ inverse: 'moveBack', path, from: 'Workspace.X' }] })),
    ).toThrow(/a script write is undone by restoring its source/);
  });

  it('refuses a delete whose subtree is filed under the wrong parent', () => {
    const applied = [{ index: 0, operation: ROUND_TRIP_OPERATIONS[6] as Operation }];
    expect(() =>
      planRollback(makeEntry({}, { applied, inverses: [{ inverse: 'restoreSubtree', parentPath: 'Workspace', serialised: '{}' }] })),
    ).toThrow(/hung under "Workspace.Shop", not "Workspace"/);
  });

  it('refuses a journal whose inverses do not pair one-to-one with its operations', () => {
    const applied = [
      { index: 0, operation: ROUND_TRIP_OPERATIONS[0] as Operation },
      { index: 1, operation: ROUND_TRIP_OPERATIONS[1] as Operation },
    ];
    // Zipping the overlap would reverse half an apply, which is the one outcome
    // worse than reversing none of it.
    expect(() =>
      planRollback(makeEntry({}, { applied, inverses: [{ inverse: 'deleteCreated', path: 'Workspace.Shop.Door' }] })),
    ).toThrow(/2 applied operations but 1 inverses/);
  });

  it('refuses a journal that records operations out of the order they ran', () => {
    const applied = [
      { index: 3, operation: ROUND_TRIP_OPERATIONS[0] as Operation },
      { index: 1, operation: ROUND_TRIP_OPERATIONS[0] as Operation },
    ];
    expect(() =>
      planRollback(
        makeEntry({}, {
          applied,
          inverses: [
            { inverse: 'deleteCreated', path: 'Workspace.Shop.Door' },
            { inverse: 'deleteCreated', path: 'Workspace.Shop.Door' },
          ],
        }),
      ),
    ).toThrow(/records operation 1 after operation 3/);
  });

  it('refuses an entry that was already rolled back — its inverses are spent', () => {
    expect(() => planRollback(makeEntry({ rolledBackAt: new Date().toISOString() }))).toThrow(/already rolled back/);
  });

  it('refuses an empty journal and a version bracket that runs backwards', () => {
    expect(() => planRollback(makeEntry({}, { applied: [], inverses: [] }))).toThrow(/records no applied operations/);
    expect(() => planRollback(makeEntry({ versionBefore: 9, versionAfter: 2 }))).toThrow(/moved the tree from version 9 to 2/);
  });
});

describe('rollbackDeliveryFor', () => {
  it('sends the inverses in replay order and nothing the consumer already knows', () => {
    const consumer = new ReferenceConsumer(freshTree());
    const { applied, inverses } = applyChangeSet(consumer, ROUND_TRIP_OPERATIONS);
    const plan = planRollback(makeEntry({ versionBefore: 2, versionAfter: 3 }, { applied, inverses }));

    const delivery = rollbackDeliveryFor(plan, { expectedVersion: 3, reason: 'wrong door' });

    expect(delivery.steps.map((step) => step.index)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(delivery.restoresToVersion).toBe(2);
    expect(delivery.reason).toBe('wrong door');
    // No copy of the operations: the consumer does not need to be told what it did.
    expect(canonicalJson(delivery)).not.toContain('"op":');
  });
});

// ── the daemon side ──────────────────────────────────────────────────────────

function makeLink(projectId: string): Link {
  return Link.parse({
    id: randomUUID(),
    projectId,
    transport: 'local-daemon',
    state: 'paired',
    createdAt: new Date().toISOString(),
  });
}

async function seed(): Promise<{
  deps: RollbackDeps;
  link: Link;
  record: JournalRecord;
  entry: JournalEntry;
  consumer: ReferenceConsumer;
}> {
  const store = new InMemoryDaemonStore();
  const deps: RollbackDeps = { store, journals: new InMemoryJournalEntryStore(), now: () => Date.now() };

  const projectId = randomUUID();
  const changeSet = makeChangeSet({ projectId, operations: ROUND_TRIP_OPERATIONS });
  await store.putChangeSet(changeSet);

  const consumer = new ReferenceConsumer(freshTree());
  const { applied, inverses } = applyChangeSet(consumer, ROUND_TRIP_OPERATIONS);

  const record: JournalRecord = {
    id: randomUUID(),
    projectId,
    changeSetId: changeSet.id,
    summary: changeSet.summary,
    versionBefore: 0,
    versionAfter: 1,
    appliedAt: new Date().toISOString(),
    rollbackRequestedAt: null,
    rolledBackAt: null,
  };
  await store.putJournal(record);
  await store.setProjectVersion(projectId, 1);

  const entry = JournalEntry.parse({
    id: record.id,
    projectId,
    changeSetId: changeSet.id,
    summary: changeSet.summary,
    applied,
    inverses,
    versionBefore: 0,
    versionAfter: 1,
    appliedAt: record.appliedAt,
  });

  return { deps, link: makeLink(projectId), record, entry, consumer };
}

describe('recordJournalEntry', () => {
  it('accepts the inverses for an apply the daemon witnessed, and hands back a plan later', async () => {
    const { deps, link, entry, record } = await seed();

    const ack = await recordJournalEntry(deps, link, entry);
    expect(ack).toEqual({ journalId: record.id, changeSetId: record.changeSetId, inverses: 7 });

    const plan = await planRollbackFor(deps, record.id);
    expect(plan.steps).toHaveLength(7);
    expect(plan.restoresToVersion).toBe(0);
  });

  it('survives the session that captured it — which is the entire point', async () => {
    const { deps, link, entry } = await seed();
    await recordJournalEntry(deps, link, entry);

    // A different Studio session, with a tree in the applied state and no memory
    // of having applied anything. Before this route existed there was no way
    // back from here at all.
    const laterSession = new ReferenceConsumer(freshTree());
    applyChangeSet(laterSession, ROUND_TRIP_OPERATIONS);

    const plan = await planRollbackFor(deps, entry.id);
    for (const step of plan.steps) laterSession.replay(step.inverse);

    expect(laterSession.tree).toEqual(freshTree());
  });

  it('refuses a journal for an apply it never recorded', async () => {
    const { deps, link, entry } = await seed();
    const orphan = JournalEntry.parse({ ...entry, id: randomUUID() });
    await expect(recordJournalEntry(deps, link, orphan)).rejects.toThrow(/no such journal entry/);
  });

  it('refuses a journal from a link bound to another project', async () => {
    const { deps, entry } = await seed();
    await expect(recordJournalEntry(deps, makeLink(randomUUID()), entry)).rejects.toThrow(/not bound to that journal/);
  });

  it('refuses a version bracket that disagrees with the apply the daemon witnessed', async () => {
    const { deps, link, entry } = await seed();
    const drifted = JournalEntry.parse({ ...entry, versionAfter: 9 });
    await expect(recordJournalEntry(deps, link, drifted)).rejects.toThrow(/the recorded apply moved 0→1/);
  });

  it('refuses a journal recording an operation that was never in the approved set', async () => {
    const { deps, link, entry } = await seed();
    // The shape is legal, the pairing is legal, and the operation is one nobody
    // proposed. Without this check a rollback would faithfully write it.
    const smuggled = JournalEntry.parse({
      ...entry,
      applied: [{ index: 0, operation: { op: 'deleteInstance', path: 'Workspace.Shop' } }],
      inverses: [{ inverse: 'restoreSubtree', parentPath: 'Workspace', serialised: '{}' }],
    });
    await expect(recordJournalEntry(deps, link, smuggled)).rejects.toThrow(/records something other than operation 0/);
  });

  it('refuses an operation index beyond the changeset', async () => {
    const { deps, link, entry } = await seed();
    const past = JournalEntry.parse({
      ...entry,
      applied: [{ index: 99, operation: ROUND_TRIP_OPERATIONS[0] }],
      inverses: [{ inverse: 'deleteCreated', path: 'Workspace.Shop.Door' }],
    });
    await expect(recordJournalEntry(deps, link, past)).rejects.toThrow(/beyond the 7 in changeset/);
  });

  it('refuses a second upload under the same id — the first is the only route back', async () => {
    const { deps, link, entry } = await seed();
    await recordJournalEntry(deps, link, entry);
    await expect(recordJournalEntry(deps, link, entry)).rejects.toThrow(/already carries inverse operations/);
  });

  it('validates replayability at upload, not weeks later when it is needed', async () => {
    const { deps, link, entry } = await seed();
    const unreplayable = JournalEntry.parse({ ...entry, inverses: entry.inverses.slice(0, 3) });
    await expect(recordJournalEntry(deps, link, unreplayable)).rejects.toThrow(/7 applied operations but 3 inverses/);
  });

  it('tells a journal with no inverses apart from a journal that does not exist', async () => {
    const { deps, record } = await seed();
    await expect(planRollbackFor(deps, record.id)).rejects.toThrow(/has no inverse operations on this daemon/);
    await expect(planRollbackFor(deps, randomUUID())).rejects.toThrow(/no such journal entry/);
  });
});

describe('recordRollbackResult', () => {
  const result = (record: JournalRecord, overrides: Record<string, unknown> = {}): RollbackResult =>
    RollbackResult.parse({
      journalId: record.id,
      changeSetId: record.changeSetId,
      outcomes: Array.from({ length: 7 }, (_, index) => ({ index, ok: true })),
      newVersion: 2,
      rolledBackAt: new Date().toISOString(),
      pluginVersion: '0.1.0',
      ...overrides,
    });

  it('closes the loop the CLI, A2A and the SDK have all been saying "dispatched" about', async () => {
    const { deps, link, entry, record } = await seed();
    await recordJournalEntry(deps, link, entry);
    await deps.store.patchJournal(record.id, { rollbackRequestedAt: new Date().toISOString() });

    const done = result(record);
    const ack = await recordRollbackResult(deps, link, done);

    expect(ack.status).toBe('rolled_back');
    const stored = await deps.store.getJournal(record.id);
    expect(stored?.rolledBackAt).toBe(done.rolledBackAt);
    expect(await deps.store.getProjectVersion(record.projectId)).toBe(2);
    expect(journalStateOf(stored as JournalRecord, done)).toBe('rolled_back');
  });

  it('leaves rolledBackAt null on a partial reversal — the entry is neither reversed nor intact', async () => {
    const { deps, link, entry, record } = await seed();
    await recordJournalEntry(deps, link, entry);
    await deps.store.patchJournal(record.id, { rollbackRequestedAt: new Date().toISOString() });

    const half = result(record, {
      outcomes: [
        { index: 6, ok: true },
        { index: 5, ok: true },
        { index: 4, ok: false, error: 'ReplicatedStorage.Spawn was deleted in Studio' },
      ],
    });
    const ack = await recordRollbackResult(deps, link, half);

    expect(ack.status).toBe('partial');
    const stored = await deps.store.getJournal(record.id);
    // The timestamp would be the journal's own record lying about the one thing
    // it exists to be right about.
    expect(stored?.rolledBackAt).toBeNull();
    expect(journalStateOf(stored as JournalRecord, half)).toBe('rollback_partial');
    // The tree still moved, so the recorded version has to move with it or the
    // next set's stale_base check passes against a version nothing describes.
    expect(await deps.store.getProjectVersion(record.projectId)).toBe(2);
  });

  it('refuses a reversal nobody requested', async () => {
    const { deps, link, entry, record } = await seed();
    await recordJournalEntry(deps, link, entry);
    await expect(recordRollbackResult(deps, link, result(record))).rejects.toThrow(/no rollback was requested/);
  });

  it('refuses a second reversal of an entry already reversed', async () => {
    const { deps, link, entry, record } = await seed();
    await recordJournalEntry(deps, link, entry);
    await deps.store.patchJournal(record.id, { rollbackRequestedAt: new Date().toISOString() });
    await recordRollbackResult(deps, link, result(record));
    await expect(recordRollbackResult(deps, link, result(record))).rejects.toThrow(/already been rolled back/);
  });

  it('refuses more outcomes than there were inverses, and a link bound elsewhere', async () => {
    const { deps, link, entry, record } = await seed();
    await recordJournalEntry(deps, link, entry);
    await deps.store.patchJournal(record.id, { rollbackRequestedAt: new Date().toISOString() });

    const tooMany = result(record, { outcomes: Array.from({ length: 8 }, (_, index) => ({ index, ok: true })) });
    await expect(recordRollbackResult(deps, link, tooMany)).rejects.toThrow(/8 outcomes for 7 inverses/);
    await expect(recordRollbackResult(deps, makeLink(randomUUID()), result(record))).rejects.toThrow(
      /not bound to that journal/,
    );
  });

  it('reports a rollback that achieved nothing as failed, not as done', () => {
    const empty = { outcomes: [] } as unknown as RollbackResult;
    expect(rollbackStatusOf(empty)).toBe('failed');
    expect(rollbackStatusOf({ outcomes: [{ index: 0, ok: false }] } as unknown as RollbackResult)).toBe('failed');
  });

  it('says "requested" while a dispatch is outstanding, and "applied" before one', () => {
    const base = { rollbackRequestedAt: null, rolledBackAt: null };
    expect(journalStateOf(base, null)).toBe('applied');
    expect(journalStateOf({ ...base, rollbackRequestedAt: new Date().toISOString() }, null)).toBe('rollback_requested');
  });
});

describe('the refusals are protocol errors, not bare throws', () => {
  it('carries a branchable code and a remedy a caller can act on', () => {
    try {
      planRollback(makeEntry({}, { applied: [{ index: 0, operation: ROUND_TRIP_OPERATIONS[0] }], inverses: [] }));
      expect.unreachable('a journal with no inverses must not plan');
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeBridgeError);
      expect((error as ForgeBridgeError).code).toBe('invalid_request');
      expect((error as ForgeBridgeError).remedy).toMatch(/exactly one inverse per operation/);
    }
  });
});
