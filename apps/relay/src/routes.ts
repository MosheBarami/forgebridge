import type { LimitClass } from './abuse/limits.js';

/**
 * The `/v1` surface, as data.
 *
 * ── Why this table exists, and why it is not the daemon's ────────────────────
 *
 * ADR-004 is unambiguous: "Identical `/v1/*` surface on `packages/daemon` and
 * `apps/relay`. The plugin is configured with a base URL and does not know
 * which it is talking to." A transport answering a different set of paths is a
 * second protocol, and the plugin — the artefact ADR-004 calls the hardest to
 * update in the field — only knows one.
 *
 * The instruction was to reuse the daemon's routing rather than write a second
 * one. **It could not be imported, and this is the accounting.** The daemon's
 * router is `ForgeBridgeDaemon#route`: a private method on a class whose
 * constructor builds a pairing service, a model router with a circuit breaker,
 * a Luau analyser and a keyring, and whose every branch calls a private handler
 * bound to a store shaped for one tenant. `@forgebridge/daemon` exports the
 * class, not the routing; there is no deep import path in its `exports` map;
 * and the method is `#private`, so it is unreachable even from a subclass.
 * Reusing it would have meant instantiating a daemon inside the relay — a
 * process that holds a model router, reads provider credentials and computes
 * validation, which is three of the four things the relay is defined by not
 * doing.
 *
 * So the routing is extracted here, as a table, and the *identity* of the two
 * surfaces is enforced by a gate rather than by care:
 * `test/surface.test.ts` compares this table against
 * `packages/protocol/schema/openapi.json` — the committed projection of the
 * daemon's own route table, which `npm run verify:schemas` regenerates and
 * fails on any difference, and which `checkRouteTable` in
 * `scripts/generate-schemas.ts` pins to the literals `#route` branches on. The
 * chain is: daemon router → generator's ROUTES → committed OpenAPI → this
 * table. A route added to the daemon and not to the relay fails here; a route
 * added here and not to the daemon fails here too, in the same test, because
 * the comparison is bidirectional.
 *
 * That second direction matters more than it looks. A relay that serves a route
 * the daemon does not is a relay that has taught a producer a call that will
 * fail the moment the user switches to the private transport — which is the
 * transport this project tells them to prefer.
 */

export type RouteAuth =
  /** No credential. `/v1/health` only. */
  | 'public'
  /** `X-ForgeBridge-Token`, resolved to a session. */
  | 'producer'
  /** `X-ForgeBridge-Link` plus a MAC or an envelope under the session key. */
  | 'consumer';

export interface RelayRoute {
  /** The segment after `/v1`. */
  readonly resource: string;
  /**
   * Segments after the resource. `{}` marks a captured parameter, matching the
   * shape `normaliseRoutePath` reduces an OpenAPI template to.
   */
  readonly sub: readonly string[];
  readonly method: 'GET' | 'POST';
  readonly auth: RouteAuth;
  readonly limitClass: LimitClass;
  /** Handler name, for the dispatch table in `server.ts`. */
  readonly handler: string;
}

export const RELAY_ROUTES: readonly RelayRoute[] = [
  { resource: 'health', sub: [], method: 'GET', auth: 'public', limitClass: 'read', handler: 'health' },

  // `/v1/link` is producer surface on this transport where it is public on the
  // daemon's. Same path, same method, same shape — a different credential,
  // because the daemon's link list is one user's and this one would otherwise
  // enumerate every paired Studio session on a shared host.
  { resource: 'link', sub: [], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'linkStatus' },
  { resource: 'link', sub: ['pair'], method: 'POST', auth: 'public', limitClass: 'pair', handler: 'pair' },
  { resource: 'link', sub: ['poll'], method: 'GET', auth: 'consumer', limitClass: 'poll', handler: 'poll' },

  { resource: 'changesets', sub: [], method: 'POST', auth: 'producer', limitClass: 'write', handler: 'submitChangeSet' },
  { resource: 'changesets', sub: ['{}', 'diff'], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'diff' },
  { resource: 'changesets', sub: ['{}', 'approve'], method: 'POST', auth: 'producer', limitClass: 'write', handler: 'approve' },
  { resource: 'changesets', sub: ['{}', 'apply-result'], method: 'POST', auth: 'consumer', limitClass: 'write', handler: 'applyResult' },

  { resource: 'apply-result', sub: [], method: 'POST', auth: 'consumer', limitClass: 'write', handler: 'applyResult' },

  // `GET /v1/journal/{}` is producer surface and the other two are consumer
  // surface, and the split is M11's whole point: a producer asks for a reversal
  // and reads what happened to it; the consumer is the only thing that holds
  // the inverses and the only thing that can say a replay finished.
  { resource: 'journal', sub: ['{}'], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'journalState' },
  { resource: 'journal', sub: ['{}', 'rollback'], method: 'POST', auth: 'producer', limitClass: 'write', handler: 'rollback' },
  { resource: 'journal', sub: ['{}', 'entry'], method: 'POST', auth: 'consumer', limitClass: 'write', handler: 'journalEntry' },
  { resource: 'journal', sub: ['{}', 'rollback-result'], method: 'POST', auth: 'consumer', limitClass: 'write', handler: 'rollbackResult' },

  { resource: 'output', sub: [], method: 'POST', auth: 'consumer', limitClass: 'write', handler: 'output' },
  { resource: 'output', sub: [], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'readOutput' },

  { resource: 'runs', sub: [], method: 'POST', auth: 'producer', limitClass: 'run', handler: 'startRun' },
  { resource: 'runs', sub: ['{}'], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'runStatus' },
  { resource: 'runs', sub: ['{}', 'events'], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'runEvents' },

  { resource: 'models', sub: [], method: 'GET', auth: 'public', limitClass: 'read', handler: 'models' },
];

/**
 * The relay's own provisioning route, deliberately outside `/v1`.
 *
 * See `RelaySessionResponse` in `wire.ts`: the daemon hands its producer token
 * and pairing code to the human at its terminal, and a relay has no terminal
 * and no such human. Adding a route to `/v1` to cover the difference would put
 * a path in a frozen protocol that the daemon does not serve — which is the one
 * thing ADR-004 forbids — so it lives here instead, and the surface gate is
 * written to notice if it ever drifts under `/v1`.
 */
export const CONTROL_SESSIONS_PATH = '/control/sessions';

/** `GET /v1/changesets/{changeSetId}/diff` → `GET /v1/changesets/{}/diff`. */
export function normaliseRoutePath(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith('{') || segment.startsWith(':') ? '{}' : segment));
  return `${method.toUpperCase()} /${segments.join('/')}`;
}

export function routeKey(route: RelayRoute): string {
  return normaliseRoutePath(route.method, ['v1', route.resource, ...route.sub].join('/'));
}

/** Every `METHOD /path` this relay serves under `/v1`. */
export function relaySurface(routes: readonly RelayRoute[] = RELAY_ROUTES): Set<string> {
  return new Set(routes.map(routeKey));
}

/**
 * Every `METHOD /path` an OpenAPI document describes.
 *
 * Reads the committed projection rather than the daemon's TypeScript, because
 * the projection is the artefact CI already refuses to let drift — and because
 * a relay test that parsed another package's source with a regular expression
 * would be a gate whose failures are as often about the parser as about the
 * surface.
 */
export function openApiSurface(document: unknown): Set<string> {
  const paths = (document as { paths?: Record<string, Record<string, unknown>> } | null)?.paths;
  if (!paths || typeof paths !== 'object') {
    throw new Error('the OpenAPI document has no `paths` object; the surface comparison cannot run');
  }
  const out = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/v1')) continue;
    for (const method of Object.keys(item)) {
      // `options` is the CORS preflight, which every route answers and no route
      // is; comparing it would compare a fact about the server, not the surface.
      if (method.toLowerCase() === 'options') continue;
      out.add(normaliseRoutePath(method, path));
    }
  }
  return out;
}

export interface SurfaceDifference {
  /** Served by the relay, absent from the reference surface. */
  extra: string[];
  /** In the reference surface, not served by the relay. */
  missing: string[];
}

/**
 * Compare two surfaces in both directions.
 *
 * Bidirectional on purpose. The generator's own cross-check is one-directional
 * on sub-paths — it asserts every literal the router branches on is declared,
 * but not that every declared segment is branched on — and a one-directional
 * comparison is exactly how a surface grows a route on one transport that the
 * other has never heard of.
 */
export function compareSurfaces(relay: ReadonlySet<string>, reference: ReadonlySet<string>): SurfaceDifference {
  return {
    extra: [...relay].filter((route) => !reference.has(route)).sort(),
    missing: [...reference].filter((route) => !relay.has(route)).sort(),
  };
}
