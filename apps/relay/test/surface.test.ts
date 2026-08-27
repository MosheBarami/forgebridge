import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELAY_ROUTES,
  compareSurfaces,
  normaliseRoutePath,
  openApiSurface,
  relaySurface,
  routeKey,
} from '../src/routes.js';
import { matchRoute } from '../src/server.js';

/**
 * ADR-004's central promise, as a merge blocker.
 *
 *   "Identical `/v1/*` surface on `packages/daemon` and `apps/relay`. The
 *    plugin is configured with a base URL and does not know which it is
 *    talking to."
 *
 * Two references, because neither alone is enough:
 *
 *  1. **`packages/protocol/schema/openapi.json`** — the committed projection of
 *     the daemon's route table. `checkRouteTable` in
 *     `scripts/generate-schemas.ts` pins that table to the literals
 *     `ForgeBridgeDaemon#route` branches on, and `npm run verify:schemas`
 *     fails on any difference between the table and the committed file. It is
 *     exact and machine-checked — but it is a build artefact, so it can lag the
 *     daemon's source between a router change and the next generation.
 *
 *  2. **`packages/daemon/src/server.ts` itself** — read for the literals the
 *     router compares against. Coarser (a set of resources, sub-paths and
 *     methods, not whole paths) but never stale.
 *
 * Used together they cover each other's gap: the projection catches a
 * path-shaped difference the literal sets cannot see, and the source catches a
 * route the projection has not been regenerated for yet.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const OPENAPI = path.join(repoRoot, 'packages/protocol/schema/openapi.json');
const DAEMON_SERVER = path.join(repoRoot, 'packages/daemon/src/server.ts');

function referenceSurface(): Set<string> {
  return openApiSurface(JSON.parse(readFileSync(OPENAPI, 'utf8')));
}

/**
 * The body of `ForgeBridgeDaemon#route`, which is where every branch lives.
 *
 * The same anchors `scripts/generate-schemas.ts` uses. If the router moves,
 * this throws rather than returning an empty string — a gate that quietly
 * compares against nothing is the failure this file exists to prevent.
 */
function daemonRouterBody(source: string): string {
  const start = source.indexOf('  async #route(');
  const end = source.indexOf('\n  // ── endpoints ──', start);
  if (start < 0 || end < 0) {
    throw new Error('could not find the daemon router; this gate must be re-pointed at it');
  }
  return source.slice(start, end);
}

export interface RouterLiterals {
  resources: Set<string>;
  subPaths: Set<string>;
  methods: Set<string>;
}

/** Exported shape so the planted-violation tests below can exercise it directly. */
export function daemonRouterLiterals(body: string): RouterLiterals {
  const literals = (variable: string): Set<string> =>
    new Set(
      [...body.matchAll(new RegExp(`${variable.replace(/[[\]]/g, '\\$&')}\\s*===\\s*'([^']+)'`, 'g'))].map(
        (match) => match[1] as string,
      ),
    );
  return {
    resources: literals('resource'),
    subPaths: new Set([...literals('rest[0]'), ...literals('rest[1]')]),
    methods: literals('method'),
  };
}

function relayLiterals(): RouterLiterals {
  return {
    resources: new Set(RELAY_ROUTES.map((route) => route.resource)),
    subPaths: new Set(
      RELAY_ROUTES.flatMap((route) => route.sub).filter((segment) => segment !== '{}'),
    ),
    methods: new Set(RELAY_ROUTES.map((route) => route.method)),
  };
}

describe('the relay serves the daemon /v1 surface, exactly', () => {
  it('matches the committed projection of the daemon router in both directions', () => {
    // Both directions, and the second is the one a one-sided check misses: a
    // relay serving a route the daemon does not has taught a producer a call
    // that breaks the moment the user switches to the private transport this
    // project tells them to prefer.
    expect(compareSurfaces(relaySurface(), referenceSurface())).toEqual({ extra: [], missing: [] });
  });

  it('serves the M11 journal routes, which need the consumer to hold the inverses', () => {
    // Named rather than left implicit, because these three arrived after the
    // rest of this table was written and are the ones a rebase is most likely
    // to drop. `GET /v1/journal/{id}` branches on a length and a method in the
    // daemon rather than on a sub-path literal, so it is matched on the branch.
    const body = daemonRouterBody(readFileSync(DAEMON_SERVER, 'utf8'));
    expect(daemonRouterLiterals(body).subPaths).toContain('entry');
    expect(daemonRouterLiterals(body).subPaths).toContain('rollback-result');
    expect(body).toMatch(/resource === 'journal'[\s\S]*?rest\.length === 1 && method === 'GET'/);
    const served = relaySurface();
    expect(served).toContain('GET /v1/journal/{}');
    expect(served).toContain('POST /v1/journal/{}/entry');
    expect(served).toContain('POST /v1/journal/{}/rollback-result');
  });

  it('reads a non-empty reference surface', () => {
    // A comparison against an empty set passes for the wrong reason.
    expect(referenceSurface().size).toBeGreaterThanOrEqual(15);
  });

  it('branches on exactly the resources, sub-paths and methods the daemon router does', () => {
    const daemon = daemonRouterLiterals(daemonRouterBody(readFileSync(DAEMON_SERVER, 'utf8')));
    const relay = relayLiterals();

    expect([...relay.resources].sort()).toEqual([...daemon.resources].sort());
    expect([...relay.subPaths].sort()).toEqual([...daemon.subPaths].sort());
    expect([...relay.methods].sort()).toEqual([...daemon.methods].sort());
  });

  it('routes every table entry to a handler the server dispatches', () => {
    for (const route of RELAY_ROUTES) {
      const concrete = ['v1', route.resource, ...route.sub.map((s) => (s === '{}' ? 'abc' : s))].join('/');
      const matched = matchRoute(`/${concrete}`, route.method);
      expect(matched, `${routeKey(route)} is in the table and unreachable through matchRoute`).not.toBeNull();
      expect(matched?.route.handler).toBe(route.handler);
    }
  });

  it('declares an auth mode for every route, and only three are public', () => {
    const publicRoutes = RELAY_ROUTES.filter((route) => route.auth === 'public').map(routeKey);
    expect(publicRoutes.sort()).toEqual(['GET /v1/health', 'GET /v1/models', 'POST /v1/link/pair'].sort());

    const consumer = RELAY_ROUTES.filter((route) => route.auth === 'consumer').map(routeKey);
    expect(consumer).toContain('GET /v1/link/poll');
    expect(consumer).toContain('POST /v1/apply-result');
    expect(consumer).toContain('POST /v1/output');
    // M11: the inverses and the reversal report come from the consumer, which
    // is the only thing that holds them.
    expect(consumer).toContain('POST /v1/journal/{}/entry');
    expect(consumer).toContain('POST /v1/journal/{}/rollback-result');

    const producer = RELAY_ROUTES.filter((route) => route.auth === 'producer').map(routeKey);
    // ADR-012: approval and rollback are the two that must never be reachable
    // without a producer credential — one clears a ChangeSet to write into the
    // place, the other dispatches a reversal of work the user may not want
    // reversed.
    expect(producer).toContain('POST /v1/changesets/{}/approve');
    expect(producer).toContain('POST /v1/journal/{}/rollback');
  });
});

describe('the surface gate itself can fail', () => {
  // A gate that cannot fail is decoration. Each of these plants a violation of
  // exactly the shape the gate exists to catch and proves it is caught.

  it('catches a route the relay serves and the daemon does not', () => {
    const withExtra = relaySurface([
      ...RELAY_ROUTES,
      { resource: 'admin', sub: [], method: 'GET', auth: 'producer', limitClass: 'read', handler: 'nope' },
    ]);
    const difference = compareSurfaces(withExtra, referenceSurface());
    expect(difference.extra).toContain('GET /v1/admin');
  });

  it('catches a route the daemon serves and the relay does not', () => {
    const withoutApprove = RELAY_ROUTES.filter((route) => route.sub[route.sub.length - 1] !== 'approve');
    const difference = compareSurfaces(relaySurface(withoutApprove), referenceSurface());
    expect(difference.missing).toEqual(['POST /v1/changesets/{}/approve']);
  });

  it('catches a route served under a different method', () => {
    const swapped = RELAY_ROUTES.map((route) =>
      route.handler === 'diff' ? { ...route, method: 'POST' as const } : route,
    );
    const difference = compareSurfaces(relaySurface(swapped), referenceSurface());
    expect(difference.extra).toContain('POST /v1/changesets/{}/diff');
    expect(difference.missing).toContain('GET /v1/changesets/{}/diff');
  });

  it('catches a sub-path the daemon router branches on and the relay does not', () => {
    const daemon = daemonRouterLiterals("resource === 'journal'\nrest[1] === 'entry'\nrest[1] === 'attach'");
    const relay = relayLiterals();
    expect([...relay.subPaths].sort()).not.toEqual([...daemon.subPaths].sort());
    expect(daemon.subPaths).toContain('attach');
  });

  it('refuses a router body it cannot find rather than comparing against nothing', () => {
    expect(() => daemonRouterBody('function somethingElse() {}')).toThrow(/re-pointed/);
  });

  it('refuses an OpenAPI document with no paths rather than comparing against nothing', () => {
    expect(() => openApiSurface({})).toThrow(/no `paths`/);
    expect(() => openApiSurface(null)).toThrow(/no `paths`/);
  });

  it('normalises path parameters so a rename is not a surface change', () => {
    expect(normaliseRoutePath('get', '/v1/changesets/{changeSetId}/diff')).toBe('GET /v1/changesets/{}/diff');
    expect(normaliseRoutePath('GET', '/v1/changesets/:id/diff')).toBe('GET /v1/changesets/{}/diff');
  });
});
