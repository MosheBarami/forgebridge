/**
 * Where the daemon is, and why it is where it is.
 */

/**
 * The daemon's fixed default port.
 *
 * Duplicated from `DEFAULT_DAEMON_PORT` in `packages/daemon/src/server.ts`
 * rather than imported, and that is a deliberate trade rather than laziness:
 * importing it would pull a Node HTTP server package into a browser bundle for
 * one integer. The number itself cannot drift quietly — a wrong port is a
 * daemon that never answers, which this app already treats as a first-class
 * state with a visible remedy.
 *
 * The reason it is fixed at all is a Roblox constraint, not a preference:
 * Studio grants a plugin `HttpService` permission per *address*, so an
 * ephemeral port would re-prompt the user on every restart (ARCHITECTURE §3).
 *
 * TODO(M31): the connector conformance suite is the forcing function for
 * moving this constant, and the `/v1` envelope shapes in `wire.ts`, into
 * `@forgebridge/protocol` — where the daemon, the relay and this app would all
 * read one definition. Owner: the protocol maintainer, as an additive change.
 */
export const DEFAULT_DAEMON_PORT = 7317;

/**
 * `127.0.0.1`, not `localhost`.
 *
 * The daemon requires a loopback `Host` header and some browsers resolve
 * `localhost` to `::1` first, which is a different socket from the one the
 * daemon bound. The literal address removes the ambiguity.
 */
export const DEFAULT_DAEMON_BASE_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;

/**
 * The override, for a daemon on another port or another machine on the LAN.
 *
 * `NEXT_PUBLIC_` because the fetch happens in the browser — see the README
 * section "Why the daemon is called from the browser". A server-side variable
 * would configure a process that never makes this call.
 */
export const DAEMON_URL_ENV = 'NEXT_PUBLIC_FORGEBRIDGE_DAEMON_URL';

function normalise(raw: string): string {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Resolved once per module load. `process.env.NEXT_PUBLIC_*` is inlined by the
 * bundler at build time, so this cannot be read from a variable key — the
 * literal member access is what makes the substitution happen.
 */
export function daemonBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_FORGEBRIDGE_DAEMON_URL;
  return normalise(configured && configured.length > 0 ? configured : DEFAULT_DAEMON_BASE_URL);
}

/**
 * The origin this page runs on, which is the value the daemon must have been
 * started with. Quoted back to the user in the "no daemon" empty state, because
 * telling someone to pass `--allow-origin <origin>` without saying which origin
 * is telling them to guess.
 */
export function pageOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin;
}

/** The exact command the empty state prints. One place, so it cannot drift. */
export function startCommand(origin: string): string {
  return `npx forgebridge daemon --allow-origin ${origin}`;
}
