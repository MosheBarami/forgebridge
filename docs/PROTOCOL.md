# The ForgeBridge protocol

One contract, authored once in Zod, projected everywhere:

```
packages/protocol/src/*.ts   (Zod, the source of truth)
        │
        │   scripts/generate-schemas.ts   one generator, no third-party converter
        │
        ├─▶ TypeScript types    `z.infer` — not generated, so it cannot drift  ── today
        ├─▶ JSON Schema 2020-12  one self-contained file per top-level type    ── M08 ✅
        ├─▶ OpenAPI 3.1          the /v1 surface, paths read off the daemon    ── M08 ✅
        └─▶ pydantic v2 models   packages/sdk-python                           ── M08 ✅
```

All four arms exist. The generated artefacts are committed under
`packages/protocol/schema/`; `npm run verify:schemas` regenerates them into memory and
fails on any difference, so a schema edit that was never projected cannot merge.

Two things that projection does **not** carry, both stated in
`packages/protocol/schema/README.md` rather than left for a consumer to discover from a
`400`:

- **`ChangeSet`'s cross-operation rule.** JSON Schema cannot compare two elements of the
  same array, so a set whose `deleteInstance` targets a path an earlier operation also
  touches validates against the schema and is refused by the protocol. The Python SDK
  re-implements it in `forgebridge.checks.check_changeset_ordering`; every other consumer
  has to re-check it itself.
- **The byte bound on a script source.** `WriteScriptOp.source` is bounded in UTF-8 bytes
  by Zod and in UTF-16 code units by `maxLength`, so the schema is the looser of the two
  above the BMP.

Everything else survives, and is *checked* rather than asserted: the few constraints that
have to be restated in JSON Schema — the shape of an `InstancePath`, the reserved property
names — carry probe values that are run through the real Zod schema and through the emitted
JSON Schema on every generation, and a disagreement fails the build.

The Python package is deliberately partial: the models are generated and complete, the
producer half of the client is complete, and the three consumer routes take a MAC as a
parameter because this repository has no specification of the pairing handshake a second
implementation could be built against (TODO(M30), blocked on M18). It is not published to
PyPI — `M30` — so install it from a checkout.

If a field is not in the Zod schema it does not exist. No adapter is allowed a private
field; extensions go through `metadata: Record<string, unknown>` and are ignored by
anything that does not understand them.

Which means: **this page is a reading guide, and `packages/protocol/src/` is the
contract.** The blocks below are abridged — bounds, branding and `.superRefine()` bodies
are left in the source — but every field name, every discriminant and every refusal here
is the real one. If they ever disagree, the source wins and this page is a bug.

## Core types

Abridged from `packages/protocol/src/`. Every name below is the name on the wire.

```ts
// ── identity ── path.ts ──────────────────────────────────────────────────
// Not a loose string. A path is dot-separated, every segment must be a safe
// identifier (/^[A-Za-z_][A-Za-z0-9_]*$/), the first segment must be one of the
// thirteen addressable SERVICE_ROOTS, depth ≤ 32, segment ≤ 100 chars. The
// segment rule is load-bearing: Roblox allows dots in Instance.Name, and a name
// carrying a dot would let a ChangeSet smuggle a separator past a policy prefix.
const InstancePath = z.string().min(1).superRefine(/* … */).brand<'InstancePath'>();
// e.g. "ServerScriptService.Shop.PurchaseHandler"

// ── property values ── value.ts ──────────────────────────────────────────
// A closed discriminated union on `t`. There is no escape hatch: a datatype not
// listed is refused at the boundary, by name.
const PropertyValue = z.discriminatedUnion('t', [
  { t: 'String', v }, { t: 'Number', v }, { t: 'Int', v }, { t: 'Bool', v }, { t: 'Nil' },
  { t: 'Vector3', x, y, z }, { t: 'Vector2', x, y }, { t: 'Color3', r, g, b },
  { t: 'UDim', scale, offset }, { t: 'UDim2', xScale, xOffset, yScale, yOffset },
  { t: 'Rect', minX, minY, maxX, maxY },
  { t: 'CFrame', position: [3], rotation: [9] },   // row-major matrix, never Euler
  { t: 'BrickColor', name }, { t: 'Enum', enum, value },
  { t: 'InstanceRef', path: InstancePath },        // ← a validated path, not a string
  { t: 'ColorSequence', keypoints }, { t: 'NumberSequence', keypoints },
  { t: 'NumberRange', min, max }, { t: 'Font', family, weight, style },
]);

// Property names are identifiers too, and __index / __newindex / __metatable /
// constructor / prototype are refused — a property bag is indexed by the plugin.
const PropertyName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(100).refine(/* … */);

// ── operations ── operation.ts ───────────────────────────────────────────
const Operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createInstance'), path: InstancePath,
             className: ClassName, properties: PropertyBag.default({}) }),
  z.object({ op: z.literal('setProperty'),   path: InstancePath,
             property: PropertyName.refine(notStructural), value: PropertyValue }),
  z.object({ op: z.literal('writeScript'),   path: InstancePath,
             scriptType: z.enum(['Script','LocalScript','ModuleScript']),
             source: ScriptSource }),
  z.object({ op: z.literal('moveInstance'),  path: InstancePath, to: InstancePath }),
  z.object({ op: z.literal('deleteInstance'),path: InstancePath }),
]);

// `setProperty` REFUSES these two. Use `moveInstance`.
const STRUCTURAL_PROPERTIES = ['Parent', 'Name'];

// Every path an operation touches — including paths that appear only inside
// property *values*, which is what the policy allowlist iterates.
function pathsOf(operation: Operation): string[];

// deleteInstance and moveInstance. Both can destroy work nobody asked to lose.
function isDestructive(operation: Operation): boolean;

// ── the unit of work ── changeset.ts ─────────────────────────────────────
const ChangeSet = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  baseVersion: z.number().int().min(0),   // tree_snapshot version this was built against
  summary: z.string().min(1).max(300),    // one line, human-facing
  operations: z.array(Operation).min(1).max(500),
  validation: Validation.optional(),      // absent until the core computes it
  status: ChangeSetStatus.default('proposed'),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine(/* flags a deleteInstance on a path an earlier op also touches */);

const ChangeSetStatus = z.enum([
  'draft', 'proposed', 'validated', 'approved', 'applying',
  'applied', 'partial', 'failed', 'rejected', 'stale',
]);

const Validation = z.object({
  luau:   z.object({ status: z.enum(['ok','warn','fail']), findings: z.array(Finding) }),
  policy: z.object({ status: z.enum(['ok','fail']), violations: z.array(z.string()) }),
  computedAt: z.string().datetime(),      // when the core computed this verdict
  computedBy: z.string().max(120),        // and what computed it
});
// There is no `schema: 'ok'` field. Schema validity is not reportable state —
// a ChangeSet that failed Zod never became a ChangeSet.

// ── application & reversal ── apply.ts ───────────────────────────────────
const ApplyResult = z.object({
  changeSetId: z.string().uuid(),
  outcomes: z.array(z.object({ index: z.number().int().min(0), ok: z.boolean(),
                               error: z.string().max(1000).optional() })),
  newVersion: z.number().int().min(0),    // becomes the next set's baseVersion
  journalId: z.string().uuid(),           // rollback handle
  appliedAt: z.string().datetime(),
  pluginVersion: z.string().max(40),      // which plugin build did it
});

const InverseOperation = z.discriminatedUnion('inverse', [
  { inverse: 'deleteCreated',   path },
  { inverse: 'restoreProperty', path, property, previous },
  { inverse: 'restoreSource',   path, previousSource },
  { inverse: 'moveBack',        path, from },
  { inverse: 'restoreSubtree',  parentPath, serialised },   // opaque to the server
]);

const JournalEntry = z.object({
  id, projectId, changeSetId, summary,
  applied:  z.array(z.object({ index, operation: Operation })),   // only what ran
  inverses: z.array(InverseOperation),
  versionBefore, versionAfter, appliedAt,
  rolledBackAt: z.string().datetime().nullable().default(null),
});

// ── errors ── errors.ts ──────────────────────────────────────────────────
// Closed set, so a consumer can branch on the code.
const ErrorCode = z.enum([
  'invalid_request',       // 400   'stale_base',            // 409
  'not_approved',          // 403   'policy_violation',      // 403
  'link_unpaired',         // 409   'link_unauthenticated',  // 401
  'replay_detected',       // 409   'too_large',             // 413
  'rate_limited',          // 429   'budget_exhausted',      // 429
  'provider_unconfigured', // 503   'unsupported_version',   // 426
  'not_found',             // 404   'internal',              // 500
]);
```

`Run`, `ModelAttempt`, `Link`, `PairingCode` and `DeliveryEnvelope` follow the same
pattern in `run.ts` and `link.ts`. `link.ts` also exports `PRIVACY_POSTURE`, the string the
UI renders verbatim per transport — including `relay-tls`: *"Relay — the relay operator can
read your changes"*.

### Three refusals worth knowing before you implement against this

**`setProperty` may not write `Parent` or `Name`.** Both are structural changes wearing a
property's clothes. Assigning `Parent` relocates an entire subtree while the operation
reports only its source path — which slipped the policy allowlist, the bulk-delete counter
and the scoped-auto-apply exclusion at the same time, because each of those inspects
something a `setProperty` does not carry. The names are exported as `STRUCTURAL_PROPERTIES`
so a producer can check before it builds one. Reparent and rename go through
`moveInstance`, which reports both endpoints and journals a resolvable `moveBack`.

**`InstanceRef.path` is an `InstancePath`, not a string.** A reference *is* a path, and the
segment rules exist precisely so a name cannot smuggle a separator past a prefix check.
Typing it loosely left exactly one hole in that guard.

**`pathsOf()` returns reference targets too** — those inside `setProperty` values and inside
`createInstance` property bags, not just `operation.path` and `moveInstance.to`. A
ChangeSet confined to an allowed prefix can still *wire a reference* at something outside
it, and until `pathsOf` reported those, the policy layer iterated a list missing exactly the
paths a model could pick freely.

## Invariants

1. **`baseVersion` is checked on apply.** If the place moved underneath a ChangeSet, the
   apply is refused with `409 stale_base` and the producer must rebase. No last-write-wins.
2. **Operations are ordered and applied in order**, each individually reported. A partial
   apply is a legal outcome and is journaled as such — the plugin never lies about how far
   it got.
3. **Every apply writes an inverse.** `deleteInstance` journals the full subtree it removed;
   `setProperty` journals the prior value; `writeScript` journals the prior source. Rollback
   is replaying the inverse, not a heuristic.
4. **Validation is produced by the core, never by the model.** A model-authored
   `validation: { luau: { status: "ok" } }` is discarded and recomputed, and the recomputed
   verdict carries `computedAt`/`computedBy` so a consumer can see whose verdict it holds.
5. **Size is bounded.** 500 operations, 1 MiB per script source, 8 MiB per ChangeSet.
   Beyond that, the run must split into staged ChangeSets.
6. **Structure moves through structural operations only.** `setProperty` refuses `Parent`
   and `Name`; reparenting and renaming are `moveInstance`, which reports both endpoints to
   `pathsOf` and journals a `moveBack`. An operation is gated on the paths it reports, so an
   operation that under-reports its reach is a gate bypass by construction.
7. **Every path is a path, wherever it appears.** `InstanceRef` values are validated as
   `InstancePath`, and `pathsOf` reports them — a reference buried in a property bag is
   subject to the same allowlist as the operation's own target.

## Transport endpoints

Served by `packages/daemon` (M14) and, since M17, by `apps/relay` as well. Both serve this
surface identically, and that is checked rather than intended — a transport that answered a
different set of paths would be a second protocol, and the plugin only knows one, so
`apps/relay/test/surface.test.ts` compares the relay's routes against
`packages/protocol/schema/openapi.json` in both directions and fails on an extra or a gap.

```
GET    /v1/health
GET    /v1/link                       → link status, transport, plugin version
POST   /v1/link/pair                  → { pairingCode } → { linkId, sessionKeyId }
GET    /v1/link/poll?since=<cursor>   → long-poll: next ChangeSet for the plugin
POST   /v1/runs                       → producer submits a prompt; the run proposes a
                                        ChangeSet and stops at the approval gate
GET    /v1/runs/:id                   → the run, with every model it tried
GET    /v1/runs/:id/events?since=<n>  → text/event-stream: stages, plan, each attempt
POST   /v1/changesets                 → producer submits a ChangeSet
GET    /v1/changesets/:id/diff        → rendered diff for review
POST   /v1/changesets/:id/approve
POST   /v1/changesets/:id/apply-result → plugin reports ApplyResult
POST   /v1/apply-result               → the same, unparameterised: an ApplyResult
                                        already names its own changeSetId
POST   /v1/journal/:id/rollback       → producer dispatches a reversal; the inverses
                                        travel with the delivery
GET    /v1/journal/:id                → what happened to one apply, and to any reversal
POST   /v1/journal/:id/entry          → plugin uploads the inverses it captured
POST   /v1/journal/:id/rollback-result → plugin reports how far a reversal got
POST   /v1/output                     → plugin mirrors Studio console back
GET    /v1/output?link=<linkId>       → producer reads that console back
GET    /v1/models                     → registry snapshot + live health
```

This table is not decorative: `scripts/generate-schemas.ts` parses it, compares it with the
router in `packages/daemon/src/server.ts`, and fails if the two disagree — the code being
the winner of any such disagreement, and this page the bug. `POST /v1/apply-result` and
`GET /v1/output` are here because of exactly that: the daemon has served both since M14 and
this table listed neither until the comparison existed to notice.

`POST /v1/runs` is the only route that calls a language model, and it is still not a route
that applies anything: it proposes a ChangeSet in `validated` and stops. Approving one is
`POST /v1/changesets/:id/approve`, which is a separate call requiring the content digest of
a diff a human read (ADR-012). The run's response and its event stream both carry the full
`ModelAttempt` list — every model the router tried and why it moved on — because a fallback
the caller cannot see is a silent substitution (ADR-008).

The three journal routes are M11's. `POST /v1/journal/:id/entry` is what takes the inverse
operations off the Studio session that captured them — without it a closed Studio was the end
of the road back from an apply — and `POST /v1/journal/:id/rollback-result` is how a reversal
is reported, which is what lets `GET /v1/journal/:id` answer anything other than "requested".
`rollback_partial` is one of the five states it answers with and is never rounded to either
neighbour: some inverses replayed and some did not, so the tree is in a state neither the user
nor the journal describes, and the inverses that would have finished the job are spent.

The plugin only ever calls `poll`, `apply-result`, `journal/:id/entry`,
`journal/:id/rollback-result` and `output` — and it calls them against a
**single stable base address**, because Roblox grants plugin HTTP permission per web address and
every new address costs the user another prompt. Everything else is for producers and UIs. Keeping the plugin's surface this small is deliberate: it is the piece
that is hardest to update in the field.

## Versioning

`/v1` is frozen once the public repo is tagged `v1.0.0`. Additive fields only; a breaking
change ships as `/v2` with `/v1` maintained for two minor releases. The plugin sends
`X-ForgeBridge-Plugin: <semver>` and the server refuses to send it operations from a
protocol version it cannot understand — the plugin shows "update available", it does not
half-apply.
