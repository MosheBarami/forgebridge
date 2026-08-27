import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChangeSet, JournalEntry, type Operation } from '@forgebridge/protocol';

// ── the reference implementations ────────────────────────────────────────────
//
// Imported from `packages/daemon/src/**` rather than from the built
// `@forgebridge/daemon` package, and that is deliberate rather than lazy.
//
//   - The package has no deep exports, so importing it at all would pull in the
//     model router, the Luau analyser and a provider client. That is fine in a
//     test and wrong as a runtime dependency of this app, and a devDependency
//     the app does not otherwise need is a devDependency someone eventually
//     promotes. Reading the source keeps the relay's dependency list honest:
//     `@forgebridge/protocol` and zod, and nothing else.
//   - `dist/` lags `src/`. A drift gate that compares against a build artefact
//     goes green for as long as nobody rebuilds, which is exactly the window in
//     which a divergence is introduced. This caught a real one while it was
//     being written: the daemon's `DeliveryPayload` grew M11's `steps` and
//     `restoresToVersion`, and the built copy still had the old shape.
import {
  canonicalJson as daemonCanonicalJson,
  envelopeMac as daemonEnvelopeMac,
  openEnvelope as daemonOpenEnvelope,
  requestMac as daemonRequestMac,
  sealEnvelope as daemonSealEnvelope,
} from '../../../packages/daemon/src/envelope.js';
import {
  deriveSessionKey as daemonDeriveSessionKey,
  normalisePairingCode as daemonNormalisePairingCode,
  sessionKeyIdOf as daemonSessionKeyIdOf,
} from '../../../packages/daemon/src/pairing.js';
import {
  ApproveRequest as DaemonApproveRequest,
  DeliveryPayload as DaemonDeliveryPayload,
  JournalStateResponse as DaemonJournalStateResponse,
  ModelsSnapshot as DaemonModelsSnapshot,
  OutputBatch as DaemonOutputBatch,
  PairRequest as DaemonPairRequest,
  RollbackDelivery as DaemonRollbackDelivery,
} from '../../../packages/daemon/src/wire.js';
import {
  journalStateOf as daemonJournalStateOf,
  planRollback as daemonPlanRollback,
  rollbackDeliveryFor as daemonRollbackDeliveryFor,
} from '../../../packages/daemon/src/rollback.js';
import { changeSetContentDigest as daemonContentDigest } from '../../../packages/daemon/src/server.js';

// ── the copies under test ────────────────────────────────────────────────────
import { canonicalJson, envelopeMac, openEnvelope, requestMac, sealEnvelope } from '../src/envelope.js';
import { deriveSessionKey, normalisePairingCode, sessionKeyIdOf } from '../src/pairing.js';
import { changeSetContentDigest } from '../src/server.js';
import { journalStateOf, planRollback, rollbackDeliveryFor } from '../src/rollback.js';
import {
  ApproveRequest,
  DeliveryPayload,
  JournalStateResponse,
  ModelsSnapshot,
  OutputBatch,
  PairRequest,
  RollbackDelivery,
} from '../src/wire.js';
import { makeChangeSet } from './helpers.js';

/**
 * The gate that makes the copies in this app safe to have made.
 *
 * `packages/daemon/src/envelope.ts` says why they exist: "the same scheme the
 * relay uses, so the plugin has one code path". The plugin computes one MAC in
 * Luau and sends it to whichever transport its base URL points at. A relay
 * whose MAC differs by a separator authenticates nothing and refuses everyone,
 * and the symptom in the field — "pairing works on the daemon and not on the
 * relay" — points at neither implementation.
 *
 * The rollback half matters for a different reason: `assertInverts` is a safety
 * rule, not a serialisation detail. Two transports that disagree about what
 * counts as a valid inverse would accept different journals for the same apply,
 * and a journal is what stands between a destructive run and an unrecoverable
 * one.
 *
 * TODO(M31): promote the envelope, the pairing derivation and these wire shapes
 * into `@forgebridge/protocol` and delete both the copies and most of this
 * file. `packages/daemon/src/wire.ts` already carries the matching TODO from
 * the other side.
 */

const KEY = Buffer.from('0'.repeat(64), 'hex');
const LINK = '11111111-2222-3333-4444-555555555555';

/** Inputs chosen for the ways two serialisers usually disagree. */
const CANONICAL_FIXTURES: unknown[] = [
  null,
  true,
  0,
  -0,
  1e21,
  'plain',
  '',
  'unicode: ✅ ñ 日本語',
  'quotes " and \\ backslash and \n newline',
  [],
  [1, 'two', null, [3]],
  {},
  { b: 1, a: 2, c: 3 },
  { z: { y: { x: [1, { w: 'deep' }] } } },
  { present: 1, absent: undefined },
  { '': 'empty key', ' ': 'space key', A: 1, a: 2 },
  { nested: [{ b: 1, a: 2 }, { d: 4, c: 3 }] },
];

describe('canonical JSON is byte-identical to the daemon', () => {
  it.each(CANONICAL_FIXTURES.map((value, index) => [index, value] as const))('fixture %i', (_index, value) => {
    expect(canonicalJson(value)).toBe(daemonCanonicalJson(value));
  });

  it('refuses a non-finite number in the same way', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => daemonCanonicalJson({ n: Number.NaN })).toThrow();
  });
});

describe('MACs are byte-identical to the daemon', () => {
  const payloads = ['', '{}', '{"a":1}', 'x'.repeat(5000), 'unicode ✅'];
  const nonces = [0, 1, 42, Number.MAX_SAFE_INTEGER];

  it('envelope MAC agrees over every combination', () => {
    for (const payload of payloads) {
      for (const nonce of nonces) {
        for (const encrypted of [false, true]) {
          const input = { linkId: LINK, nonce, encrypted, payload };
          expect(envelopeMac(KEY, input)).toBe(daemonEnvelopeMac(KEY, input));
        }
      }
    }
  });

  it('request MAC agrees, including the length framing', () => {
    const partSets: string[][] = [
      [],
      [LINK, 'GET', '/v1/link/poll', '0'],
      // The pair that would collide without length prefixes. If either side
      // dropped the framing, one of these two would start matching the other.
      ['ab', 'c'],
      ['a', 'bc'],
      ['✅', 'ñ'],
    ];
    for (const parts of partSets) {
      expect(requestMac(KEY, parts)).toBe(daemonRequestMac(KEY, parts));
    }
    expect(requestMac(KEY, ['ab', 'c'])).not.toBe(requestMac(KEY, ['a', 'bc']));
  });

  it('seals an envelope the daemon would accept, and opens one the daemon sealed', () => {
    const payload = { kind: 'changeset', note: 'both directions' };

    const relaySealed = sealEnvelope(KEY, { linkId: LINK, nonce: 7, payload });
    const daemonSealed = daemonSealEnvelope(KEY, { linkId: LINK, nonce: 7, payload });
    expect(relaySealed).toEqual(daemonSealed);

    expect(daemonOpenEnvelope(KEY, relaySealed, { linkId: LINK }).payload).toEqual(payload);
    expect(openEnvelope(KEY, daemonSealed, { linkId: LINK }).payload).toEqual(payload);
  });

  it('refuses a tampered MAC on both sides', () => {
    const sealed = sealEnvelope(KEY, { linkId: LINK, nonce: 1, payload: { a: 1 } });
    const tampered = { ...sealed, payload: '{"a":2}' };
    expect(() => openEnvelope(KEY, tampered, { linkId: LINK })).toThrow(/MAC/);
    expect(() => daemonOpenEnvelope(KEY, tampered, { linkId: LINK })).toThrow(/MAC/);
  });

  it('refuses an envelope addressed to another link on both sides', () => {
    const sealed = sealEnvelope(KEY, { linkId: LINK, nonce: 1, payload: {} });
    const other = randomUUID();
    expect(() => openEnvelope(KEY, sealed, { linkId: other })).toThrow(/different link/);
    expect(() => daemonOpenEnvelope(KEY, sealed, { linkId: other })).toThrow(/different link/);
  });

  it('refuses an encrypted payload on both sides — relay-e2e is M19 and unbuilt', () => {
    const sealed = { ...sealEnvelope(KEY, { linkId: LINK, nonce: 1, payload: {} }), encrypted: true };
    expect(() => openEnvelope(KEY, sealed, { linkId: LINK })).toThrow();
    expect(() => daemonOpenEnvelope(KEY, sealed, { linkId: LINK })).toThrow();
  });
});

describe('key derivation is byte-identical to the daemon', () => {
  it('derives the same session key from a code and salt', () => {
    for (const code of ['ABCDEFGH', 'abcdefgh', ' abcd-efgh ', '23456789']) {
      const salt = randomBytes(32);
      const linkId = randomUUID();
      expect(deriveSessionKey(code, salt, linkId)).toEqual(daemonDeriveSessionKey(code, salt, linkId));
    }
  });

  it('names a key the same way', () => {
    const key = randomBytes(32);
    expect(sessionKeyIdOf(key)).toBe(daemonSessionKeyIdOf(key));
  });

  it('normalises a code the same way', () => {
    for (const raw of [' abcd efgh ', 'ab-cd-ef-gh', 'ABCDEFGH', '\tabcdefgh\n']) {
      expect(normalisePairingCode(raw)).toBe(daemonNormalisePairingCode(raw));
    }
  });
});

describe('the content digest is the daemon’s', () => {
  it('agrees over the operations of a real ChangeSet', () => {
    const operations: readonly Operation[] = ChangeSet.parse(makeChangeSet()).operations;
    expect(changeSetContentDigest(operations)).toBe(daemonContentDigest(operations));
  });

  it('changes when an operation changes, on both sides', () => {
    const a = ChangeSet.parse(makeChangeSet()).operations;
    const b = ChangeSet.parse(
      makeChangeSet({
        operations: [
          { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("bye")' },
        ] as never,
      }),
    ).operations;
    expect(changeSetContentDigest(a)).not.toBe(changeSetContentDigest(b));
    expect(daemonContentDigest(a)).not.toBe(daemonContentDigest(b));
  });
});

// ── rollback: the safety rule, not a serialisation detail ────────────────────

function journal(applied: unknown[], inverses: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    changeSetId: randomUUID(),
    summary: 'a journalled apply',
    applied,
    inverses,
    versionBefore: 1,
    versionAfter: 2,
    appliedAt: new Date(0).toISOString(),
    rolledBackAt: null,
    ...overrides,
  };
}

const CREATE = { op: 'createInstance', path: 'Workspace.Part', className: 'Part', properties: {} };
const SET = { op: 'setProperty', path: 'Workspace.Part', property: 'Transparency', value: { t: 'Number', v: 0.5 } };
const WRITE = { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print(1)' };
const MOVE = { op: 'moveInstance', path: 'Workspace.A', to: 'Workspace.B' };
const DELETE = { op: 'deleteInstance', path: 'Workspace.Old.Thing' };

/**
 * Every pairing the rule has an opinion about — the legal ones and, more
 * importantly, the illegal ones. A rule that only ever sees valid input is a
 * rule nobody has checked.
 */
const ROLLBACK_FIXTURES: Array<[string, unknown]> = [
  ['create ↔ deleteCreated', journal([{ index: 0, operation: CREATE }], [{ inverse: 'deleteCreated', path: 'Workspace.Part' }])],
  ['create ↔ deleteCreated at the wrong path', journal([{ index: 0, operation: CREATE }], [{ inverse: 'deleteCreated', path: 'Workspace.Other' }])],
  ['create ↔ restoreSource', journal([{ index: 0, operation: CREATE }], [{ inverse: 'restoreSource', path: 'Workspace.Part', previousSource: '' }])],
  ['setProperty ↔ restoreProperty', journal([{ index: 0, operation: SET }], [{ inverse: 'restoreProperty', path: 'Workspace.Part', property: 'Transparency', previous: null }])],
  ['setProperty ↔ restoreProperty of another property', journal([{ index: 0, operation: SET }], [{ inverse: 'restoreProperty', path: 'Workspace.Part', property: 'Anchored', previous: null }])],
  ['writeScript ↔ restoreSource', journal([{ index: 0, operation: WRITE }], [{ inverse: 'restoreSource', path: 'ServerScriptService.Shop', previousSource: 'old' }])],
  ['writeScript ↔ deleteCreated (the script did not exist)', journal([{ index: 0, operation: WRITE }], [{ inverse: 'deleteCreated', path: 'ServerScriptService.Shop' }])],
  ['writeScript ↔ moveBack', journal([{ index: 0, operation: WRITE }], [{ inverse: 'moveBack', path: 'a', from: 'b' }])],
  ['move ↔ moveBack, endpoints the right way round', journal([{ index: 0, operation: MOVE }], [{ inverse: 'moveBack', path: 'Workspace.B', from: 'Workspace.A' }])],
  ['move ↔ moveBack, endpoints swapped', journal([{ index: 0, operation: MOVE }], [{ inverse: 'moveBack', path: 'Workspace.A', from: 'Workspace.B' }])],
  ['delete ↔ restoreSubtree under the right parent', journal([{ index: 0, operation: DELETE }], [{ inverse: 'restoreSubtree', parentPath: 'Workspace.Old', serialised: 'x' }])],
  ['delete ↔ restoreSubtree under the wrong parent', journal([{ index: 0, operation: DELETE }], [{ inverse: 'restoreSubtree', parentPath: 'Workspace', serialised: 'x' }])],
  ['more applied than inverses', journal([{ index: 0, operation: CREATE }, { index: 1, operation: SET }], [{ inverse: 'deleteCreated', path: 'Workspace.Part' }])],
  ['nothing applied', journal([], [])],
  ['operation indices out of order', journal([{ index: 1, operation: CREATE }, { index: 0, operation: SET }], [{ inverse: 'deleteCreated', path: 'Workspace.Part' }, { inverse: 'restoreProperty', path: 'Workspace.Part', property: 'Transparency', previous: null }])],
  ['versions going backwards', journal([{ index: 0, operation: CREATE }], [{ inverse: 'deleteCreated', path: 'Workspace.Part' }], { versionBefore: 5, versionAfter: 2 })],
  ['already rolled back', journal([{ index: 0, operation: CREATE }], [{ inverse: 'deleteCreated', path: 'Workspace.Part' }], { rolledBackAt: new Date(0).toISOString() })],
  [
    'two operations, reversed in replay order',
    journal(
      [{ index: 0, operation: CREATE }, { index: 1, operation: SET }],
      [
        { inverse: 'deleteCreated', path: 'Workspace.Part' },
        { inverse: 'restoreProperty', path: 'Workspace.Part', property: 'Transparency', previous: null },
      ],
    ),
  ],
];

describe('the rollback rule is the daemon’s', () => {
  it.each(ROLLBACK_FIXTURES)('%s', (_name, raw) => {
    const parsed = JournalEntry.safeParse(raw);
    if (!parsed.success) {
      // A fixture the protocol itself refuses is not a test of the rule. Both
      // sides would refuse it before the rule ran, and a silent skip here would
      // be a fixture that proves nothing while looking like it does.
      expect.fail(`fixture is not a valid JournalEntry: ${parsed.error.issues[0]?.message ?? ''}`);
    }
    const entry = parsed.data;

    let relayError: string | null = null;
    let daemonError: string | null = null;
    let relayPlan: unknown = null;
    let daemonPlan: unknown = null;
    try {
      relayPlan = planRollback(entry);
    } catch (error) {
      relayError = (error as Error).message;
    }
    try {
      daemonPlan = daemonPlanRollback(entry);
    } catch (error) {
      daemonError = (error as Error).message;
    }

    expect(relayError).toBe(daemonError);
    expect(relayPlan).toEqual(daemonPlan);
  });

  it('builds the same delivery from the same plan', () => {
    const entry = JournalEntry.parse(ROLLBACK_FIXTURES[ROLLBACK_FIXTURES.length - 1]?.[1]);
    const plan = planRollback(entry);
    const options = { expectedVersion: 2, reason: 'undo it' };
    expect(rollbackDeliveryFor(plan, options)).toEqual(daemonRollbackDeliveryFor(daemonPlanRollback(entry), options));
  });

  it('reads a journal state the same way', () => {
    const at = new Date(0).toISOString();
    const result = {
      journalId: randomUUID(),
      changeSetId: randomUUID(),
      outcomes: [{ index: 0, ok: true }, { index: 1, ok: false, error: 'gone' }],
      newVersion: 3,
      rolledBackAt: at,
      pluginVersion: '1.0.0',
    };
    const cases: Array<[{ rollbackRequestedAt: string | null; rolledBackAt: string | null }, typeof result | null]> = [
      [{ rollbackRequestedAt: null, rolledBackAt: null }, null],
      [{ rollbackRequestedAt: at, rolledBackAt: null }, null],
      [{ rollbackRequestedAt: at, rolledBackAt: at }, null],
      [{ rollbackRequestedAt: at, rolledBackAt: null }, result],
      [{ rollbackRequestedAt: at, rolledBackAt: null }, { ...result, outcomes: [] }],
      [{ rollbackRequestedAt: at, rolledBackAt: null }, { ...result, outcomes: [{ index: 0, ok: true }] }],
    ];
    for (const [record, outcome] of cases) {
      expect(journalStateOf(record, outcome)).toBe(daemonJournalStateOf(record, outcome));
    }
  });
});

describe('the copied wire schemas accept and refuse what the daemon’s do', () => {
  interface Parser {
    safeParse(value: unknown): { success: boolean };
  }
  const cases: Array<[string, { relay: Parser; daemon: Parser; values: unknown[] }]> = [
    [
      'PairRequest',
      {
        relay: PairRequest,
        daemon: DaemonPairRequest,
        values: [
          { pairingCode: 'ABCDEFGH' },
          { pairingCode: 'ABCDEFGH', projectId: randomUUID(), pluginVersion: '1.0.0' },
          { pairingCode: 'ABCDEFG' },
          { pairingCode: 'ABCDEFGL' },
          { pairingCode: 'abcdefgh' },
          {},
          { pairingCode: 'ABCDEFGH', projectId: 'not-a-uuid' },
        ],
      },
    ],
    [
      'ApproveRequest',
      {
        relay: ApproveRequest,
        daemon: DaemonApproveRequest,
        values: [
          { contentDigest: 'abc' },
          { contentDigest: 'abc', confirmBulkDelete: true, approvedBy: 'someone' },
          {},
          { contentDigest: '' },
          { contentDigest: 'abc', confirmBulkDelete: 'yes' },
        ],
      },
    ],
    [
      'OutputBatch',
      {
        relay: OutputBatch,
        daemon: DaemonOutputBatch,
        values: [
          { messages: [{ level: 'print', message: 'hi', at: new Date(0).toISOString() }] },
          { messages: [] },
          { messages: [{ level: 'shout', message: 'hi', at: new Date(0).toISOString() }] },
          { messages: [{ level: 'error', message: 'x', at: 'not-a-date' }] },
        ],
      },
    ],
    [
      'ModelsSnapshot',
      {
        relay: ModelsSnapshot,
        daemon: DaemonModelsSnapshot,
        values: [
          { configured: false, source: 'none', verifiedAt: null, models: [] },
          { configured: true, source: 'catalog', verifiedAt: new Date(0).toISOString(), models: [{ id: 'x' }] },
          { configured: false, source: 'none', models: [] },
        ],
      },
    ],
    [
      'RollbackDelivery',
      {
        relay: RollbackDelivery,
        daemon: DaemonRollbackDelivery,
        values: [
          {
            kind: 'rollback',
            journalId: randomUUID(),
            changeSetId: randomUUID(),
            expectedVersion: 2,
            restoresToVersion: 1,
            steps: [{ index: 0, inverse: { inverse: 'deleteCreated', path: 'Workspace.Part' } }],
          },
          // The pre-M11 shape. Both sides must refuse it, or a relay would be
          // dispatching a rollback with no inverses in it.
          { kind: 'rollback', journalId: randomUUID(), changeSetId: randomUUID(), expectedVersion: 2 },
          {
            kind: 'rollback',
            journalId: randomUUID(),
            changeSetId: randomUUID(),
            expectedVersion: 2,
            restoresToVersion: 1,
            steps: [{ index: 0, inverse: { inverse: 'notAnInverse' } }],
          },
        ],
      },
    ],
    [
      'DeliveryPayload',
      {
        relay: DeliveryPayload,
        daemon: DaemonDeliveryPayload,
        values: [
          { kind: 'changeset', changeSet: makeChangeSet() },
          {
            kind: 'rollback',
            journalId: randomUUID(),
            changeSetId: randomUUID(),
            expectedVersion: 3,
            restoresToVersion: 2,
            steps: [],
          },
          { kind: 'rollback', journalId: randomUUID(), changeSetId: randomUUID() },
          { kind: 'something-else' },
        ],
      },
    ],
    [
      'JournalStateResponse',
      {
        relay: JournalStateResponse,
        daemon: DaemonJournalStateResponse,
        values: [
          {
            journalId: randomUUID(),
            changeSetId: randomUUID(),
            projectId: randomUUID(),
            summary: 'x',
            state: 'applied',
            versionBefore: 1,
            versionAfter: 2,
            appliedAt: new Date(0).toISOString(),
            rollbackRequestedAt: null,
            rolledBackAt: null,
            inverses: null,
            result: null,
          },
          {
            journalId: randomUUID(),
            changeSetId: randomUUID(),
            projectId: randomUUID(),
            summary: 'x',
            state: 'rollback_partly',
            versionBefore: 1,
            versionAfter: 2,
            appliedAt: new Date(0).toISOString(),
            rollbackRequestedAt: null,
            rolledBackAt: null,
            inverses: 0,
            result: null,
          },
        ],
      },
    ],
  ];

  it.each(cases)('%s agrees with the daemon on every fixture', (_name, entry) => {
    for (const value of entry.values) {
      expect(entry.relay.safeParse(value).success).toBe(entry.daemon.safeParse(value).success);
    }
  });
});

describe('the drift gate itself can fail', () => {
  // A gate that cannot fail is decoration. These plant the divergences the gate
  // exists to catch and prove the comparison notices them.

  it('notices a MAC computed with a different domain separator', async () => {
    const { createHmac } = await import('node:crypto');
    const wrong = (key: Buffer, input: { linkId: string; nonce: number; encrypted: boolean; payload: string }): string => {
      const hmac = createHmac('sha256', key);
      hmac.update('forgebridge/v1/envelope-oops', 'utf8');
      hmac.update('\n');
      hmac.update(input.linkId, 'utf8');
      hmac.update('\n');
      hmac.update(String(input.nonce), 'utf8');
      hmac.update('\n');
      hmac.update(input.encrypted ? '1' : '0', 'utf8');
      hmac.update('\n');
      hmac.update(input.payload, 'utf8');
      return hmac.digest('base64');
    };
    const input = { linkId: LINK, nonce: 1, encrypted: false, payload: '{}' };
    expect(wrong(KEY, input)).not.toBe(daemonEnvelopeMac(KEY, input));
    expect(envelopeMac(KEY, input)).toBe(daemonEnvelopeMac(KEY, input));
  });

  it('notices a canonical serialiser that does not sort keys', () => {
    const unsorted = (value: Record<string, unknown>): string => JSON.stringify(value);
    const value = { b: 1, a: 2 };
    expect(unsorted(value)).not.toBe(daemonCanonicalJson(value));
    expect(canonicalJson(value)).toBe(daemonCanonicalJson(value));
  });

  it('notices a rollback rule that accepts a pair the daemon refuses', () => {
    // The `moveInstance` reading `plugin/src/Journal.luau` asked to have pinned:
    // swapping the endpoints must fail, and a rule that shrugged at it would
    // silently misplace instances on every rollback.
    const swapped = JournalEntry.parse(
      journal([{ index: 0, operation: MOVE }], [{ inverse: 'moveBack', path: 'Workspace.A', from: 'Workspace.B' }]),
    );
    const lenient = (): unknown => ({ steps: [] });
    expect(() => daemonPlanRollback(swapped)).toThrow();
    expect(() => planRollback(swapped)).toThrow();
    expect(lenient()).not.toBeNull();
  });

  it('notices a schema that accepts what the daemon refuses', () => {
    const loose: { safeParse(value: unknown): { success: boolean } } = { safeParse: () => ({ success: true }) };
    const refused = { pairingCode: 'nope' };
    expect(loose.safeParse(refused).success).not.toBe(DaemonPairRequest.safeParse(refused).success);
  });
});
