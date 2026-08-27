import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCER_TOKEN_ENV } from '@forgebridge/daemon';
import {
  ConfigError,
  HTTP_TOKEN_ENV,
  MIN_HTTP_TOKEN_CHARS,
  resolveConfig,
  resolveHttpToken,
  type ServerConfig,
} from '../src/config.js';
import { authorizationMatches, HTTP_ENDPOINT, startHttp } from '../src/server.js';

/**
 * The HTTP binding's authentication.
 *
 * Round 3 found this binding checking the `Host` header, refusing an `Origin`,
 * and then handing the request to a fully registered tool server backed by the
 * daemon's producer token — with no credential of any kind in between. Any
 * process that found the port held that token by proxy, which is the boundary
 * `packages/daemon/src/envelope.ts` says the MAC exists to draw.
 *
 * These are the assertions that fail without the fix, plus the two shapes the
 * fix is most confusable with: a request that *does* carry the token has to
 * still work, and a wrong-length token has to be a clean 401 rather than the 500
 * an unguarded `timingSafeEqual` produces — a 500 that only wrong-length tokens
 * cause is a length oracle, which is worse than the timing leak it replaces.
 */

// The real implementation is kept; only the call is observed, so "is the
// comparison constant time" is asserted rather than eyeballed in the source.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const { timingSafeEqual } = await import('node:crypto');
const timingSafeEqualSpy = vi.mocked(timingSafeEqual);

const TOKEN = 'a-token-long-enough-to-be-accepted';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  timingSafeEqualSpy.mockClear();
});

function configWith(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    transport: 'http',
    daemonUrl: 'http://127.0.0.1:7317',
    producerToken: 'producer-token',
    defaultProjectId: null,
    httpHost: '127.0.0.1',
    // Port 0 so the tests can run in parallel and on a busy machine.
    httpPort: 0,
    httpToken: TOKEN,
    toolSeparator: '.',
    ...overrides,
  };
}

async function listen(config: ServerConfig = configWith()): Promise<string> {
  // The start-up banner writes the bearer token straight to stderr, on purpose
  // (see `startHttp`). Swallowed here so a fixture does not print a secret once
  // per test; the two tests that care about the banner assert on it directly.
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  let server: Server;
  try {
    server = await startHttp({ config, log: () => {} });
  } finally {
    stderr.mockRestore();
  }
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}${HTTP_ENDPOINT}`;
}

/** A real `initialize`, which is the first thing any MCP client sends. */
function initialize(authorization?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  };
}

describe('the HTTP binding requires a bearer token', () => {
  it('refuses a request that carries none', async () => {
    const url = await listen();
    const response = await fetch(url, initialize());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('bearer token') as unknown as string },
    });
  });

  it('refuses the wrong token, and one of the wrong length, with the same 401', async () => {
    const url = await listen();

    const sameLength = `${'x'.repeat(TOKEN.length - 1)}y`;
    expect(sameLength).toHaveLength(TOKEN.length);
    expect((await fetch(url, initialize(`Bearer ${sameLength}`))).status).toBe(401);

    // `timingSafeEqual` throws on a length mismatch. Unguarded, this is a 500,
    // and the difference between 401 and 500 tells an attacker the length.
    expect((await fetch(url, initialize('Bearer short'))).status).toBe(401);
    expect((await fetch(url, initialize(`Bearer ${TOKEN}${TOKEN}`))).status).toBe(401);
  });

  it('refuses a token presented under some other scheme, or as a bare value', async () => {
    const url = await listen();
    expect((await fetch(url, initialize(TOKEN))).status).toBe(401);
    expect((await fetch(url, initialize(`Basic ${TOKEN}`))).status).toBe(401);
  });

  it('refuses before it routes, so an unauthenticated caller learns nothing else', async () => {
    const url = await listen();
    const base = url.slice(0, -HTTP_ENDPOINT.length);

    // Both of these answer 404 and 405 once authenticated. Unauthenticated they
    // must not: a route map is not something to serve to a stranger, and no
    // path may reach a registered tool without the token.
    expect((await fetch(`${base}/not-the-endpoint`, initialize())).status).toBe(401);
    expect((await fetch(url, { method: 'GET' })).status).toBe(401);
  });

  it('refuses before it checks Host or Origin, for the same reason', async () => {
    const url = await listen();

    // These answer 400 and 403 once authenticated, and they used to answer them
    // unauthenticated too, because both checks ran ahead of the token. That let
    // a stranger tell a rejected Host from a rejected Origin from a served
    // endpoint — three different answers to "is something listening here, and
    // what will it take?" — which is the thing the test above exists to stop.
    //
    // The control is the line after each: with the token, the same request
    // still gets the specific refusal. Moving the checks behind the token did
    // not delete them.
    const withOrigin = { ...initialize(), headers: { ...initialize().headers, origin: 'https://evil.example' } };
    expect((await fetch(url, withOrigin)).status).toBe(401);
    expect(
      (await fetch(url, { ...withOrigin, headers: { ...withOrigin.headers, authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(403);

    // `Host` gets only the unauthenticated half here: `fetch` will not let a
    // caller set that header — undici writes the one it derived from the URL —
    // so there is no way from this side to present a bad Host with a good
    // token. `hostIsAllowed` is covered directly in `transport.test.ts`; what
    // this line pins is the ordering, which is the part that changed.
    expect((await fetch(url, initialize())).status).toBe(401);
  });

  it('accepts the token and answers a real initialize', async () => {
    const url = await listen();
    const response = await fetch(url, initialize(`Bearer ${TOKEN}`));

    expect(response.status).toBe(200);
    // The stateless transport answers over SSE, so the JSON-RPC result is in the
    // body text rather than in a JSON envelope. Asserting on the server's own
    // name is what makes this "the tool server answered", not "a 200 happened".
    expect(await response.text()).toContain('forgebridge');
  });

  it('compares with timingSafeEqual, not with ===', async () => {
    const url = await listen();
    await fetch(url, initialize(`Bearer ${'z'.repeat(TOKEN.length)}`));

    // A wrong token of the right length is the only case where the comparison
    // itself decides, which is exactly the case that has to be constant time.
    expect(timingSafeEqualSpy).toHaveBeenCalled();
  });
});

describe('the check cannot be assembled away', () => {
  it('has no configuration that turns it off', () => {
    // An empty value is the shape someone reaches for when they mean "no token".
    // It mints one instead — the only way to fail here is closed.
    expect(resolveHttpToken('')).not.toBe('');
    expect(resolveHttpToken('   ')).toHaveLength(43);
    expect(resolveConfig(['--http'], { [PRODUCER_TOKEN_ENV]: 't', [HTTP_TOKEN_ENV]: '' }).httpToken).not.toBe('');
  });

  it('mints a fresh token per process when the operator names none', () => {
    const env = { [PRODUCER_TOKEN_ENV]: 't' } as NodeJS.ProcessEnv;
    const first = resolveConfig(['--http'], env).httpToken;
    const second = resolveConfig(['--http'], env).httpToken;

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(MIN_HTTP_TOKEN_CHARS);
  });

  it('takes an operator token, and refuses one too short to be worth checking', () => {
    const env = { [PRODUCER_TOKEN_ENV]: 't' } as NodeJS.ProcessEnv;
    expect(resolveConfig(['--http', '--http-token', TOKEN], env).httpToken).toBe(TOKEN);
    expect(() => resolveConfig(['--http', '--http-token', 'short'], env)).toThrow(ConfigError);
    expect(() => resolveConfig(['--http'], { ...env, [HTTP_TOKEN_ENV]: 'short' })).toThrow(ConfigError);
  });

  it('refuses to open a binding whose config was hand-built without a token', async () => {
    // TypeScript makes `httpToken` non-optional, but a JavaScript embedder can
    // still pass an empty string. There is no binding without a token.
    await expect(startHttp({ config: configWith({ httpToken: '' }), log: () => {} })).rejects.toThrow(ConfigError);
    await expect(startHttp({ config: configWith({ httpToken: '  ' }), log: () => {} })).rejects.toThrow(ConfigError);
  });

  it('prints the token once, on stderr, where the daemon prints its own', async () => {
    const lines: string[] = [];
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    });
    try {
      const server = await startHttp({ config: configWith(), log: (message) => void lines.push(message) });
      servers.push(server);
    } finally {
      stderr.mockRestore();
    }

    // The operator has to be able to copy it out of the terminal; it is never
    // served over HTTP, so this line is the only place it appears.
    expect(written.filter((line) => line.includes(TOKEN))).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/Authorization: Bearer/);
  });

  it('never hands the token to the injectable log sink', async () => {
    // `log` is a public option. An embedder passing their own logger would be
    // shipping the bearer token wherever that logger writes, and a key that has
    // reached a log has left the user's custody (THREAT-MODEL T1) — which is
    // what `scripts/verify-no-key-storage.ts` rule K3 refuses. The control is
    // the assertion above: the token is still printed, just not through here,
    // so this is "not in the log", not "not printed".
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
    try {
      const server = await startHttp({ config: configWith(), log: (message) => void lines.push(message) });
      servers.push(server);
    } finally {
      stderr.mockRestore();
    }

    expect(lines.some((line) => line.includes(TOKEN))).toBe(false);
    // …and the operator is still told what to do with it.
    expect(lines.join('\n')).toMatch(/Authorization: Bearer/);
  });
});

describe('the comparison itself', () => {
  it('rejects every shape that is not the exact token', () => {
    expect(authorizationMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorizationMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorizationMatches([`Bearer ${TOKEN}`], TOKEN)).toBe(true);

    expect(authorizationMatches(undefined, TOKEN)).toBe(false);
    expect(authorizationMatches('', TOKEN)).toBe(false);
    expect(authorizationMatches('Bearer', TOKEN)).toBe(false);
    expect(authorizationMatches(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
    expect(authorizationMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
  });

  it('never accepts an empty expected token, whatever is presented', () => {
    // The degenerate case a hand-built config could produce: without this guard
    // `Bearer ` would match an empty expectation and the endpoint would be open
    // to anyone who sent the header at all.
    expect(authorizationMatches('Bearer ', '')).toBe(false);
    expect(authorizationMatches('Bearer', '')).toBe(false);
    expect(authorizationMatches('Bearer x', '')).toBe(false);
  });
});
