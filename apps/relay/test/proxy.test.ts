import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { afterEach } from 'vitest';
import { NO_PROXY, clientAddress, tlsEvidence } from '../src/http.js';
import { json, startRelay } from './helpers.js';

/**
 * The two questions a public deployment has to answer that a loopback one never
 * does.
 *
 * The daemon binds `127.0.0.1` with no option to widen it, and every network
 * assumption it makes follows from that. The relay is meant to be reachable
 * from the internet, so each of those assumptions has to be replaced by
 * something explicit — and each replacement fails closed, because the
 * permissive failure here is silent and total.
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function request(headers: Record<string, string>, remoteAddress = '10.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('whose address is this really', () => {
  it('ignores X-Forwarded-For entirely when no proxy is declared', async () => {
    // The cheapest way to disable every per-IP limit in this app: a header any
    // client can set, believed by a relay that has no proxy. One line of
    // configuration is the difference, and the default is not to believe it.
    const spoofed = request({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientAddress(spoofed, NO_PROXY)).toBe('10.0.0.1');
    expect(clientAddress(spoofed)).toBe('10.0.0.1');
  });

  it('reads the n-th entry from the RIGHT with n trusted hops', () => {
    // The common shortcut is the left-most entry, which is the value the client
    // supplied. Everything left of the trusted tail was written by someone we
    // do not trust.
    const chain = request({ 'x-forwarded-for': 'attacker-claim, 198.51.100.4, 203.0.113.7' });
    expect(clientAddress(chain, { hops: 1 })).toBe('203.0.113.7');
    expect(clientAddress(chain, { hops: 2 })).toBe('198.51.100.4');
  });

  it('falls back to the socket when the header is shorter than the declared hops', () => {
    // A stripped header or a misconfiguration. The honest answer is the socket
    // address, not the best available guess.
    const short = request({ 'x-forwarded-for': '203.0.113.7' });
    expect(clientAddress(short, { hops: 3 })).toBe('10.0.0.1');
    expect(clientAddress(request({}), { hops: 1 })).toBe('10.0.0.1');
  });
});

describe('was this hop actually TLS', () => {
  it('answers "unknown" with no proxy declared, and unknown is refused', () => {
    expect(tlsEvidence(request({ 'x-forwarded-proto': 'https' }), NO_PROXY)).toBe('unknown');
    expect(tlsEvidence(request({}), { hops: 1 })).toBe('unknown');
  });

  it('believes X-Forwarded-Proto only from a declared proxy', () => {
    expect(tlsEvidence(request({ 'x-forwarded-proto': 'https' }), { hops: 1 })).toBe('tls');
    expect(tlsEvidence(request({ 'x-forwarded-proto': 'http' }), { hops: 1 })).toBe('plaintext');
    expect(tlsEvidence(request({ 'x-forwarded-proto': 'http, https' }), { hops: 1 })).toBe('tls');
  });

  it('refuses a request it cannot prove arrived over TLS', async () => {
    // `relay-tls` is the transport's name and the string the UI renders. A
    // relay serving without TLS while calling itself that is the class of claim
    // ADR-014 exists to forbid, so it refuses rather than serving.
    const started = await startRelay({ requireTls: true });
    open.push(started.close);
    const refused = await fetch(`${started.base}/v1/health`);
    expect(refused.status).toBe(400);
    const body = await json(refused);
    expect(String(body.message)).toContain('TLS');
    expect(String(body.remedy)).toContain('--proxy-hops');
  });

  it('serves when a declared proxy says the hop was https — CONTROL', async () => {
    const started = await startRelay({ requireTls: true, proxy: { hops: 1 } });
    open.push(started.close);
    const served = await fetch(`${started.base}/v1/health`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(served.status).toBe(200);
    expect((await json(served)).transport).toBe('relay-tls');
  });

  it('refuses a client that claims https with no proxy declared', async () => {
    const started = await startRelay({ requireTls: true });
    open.push(started.close);
    const refused = await fetch(`${started.base}/v1/health`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(refused.status).toBe(400);
  });

  it('reports the waiver on /v1/health when TLS enforcement is off', async () => {
    const started = await startRelay({ requireTls: false });
    open.push(started.close);
    const health = await json(await fetch(`${started.base}/v1/health`));
    expect((health.tls as { required: boolean }).required).toBe(false);
  });
});

describe('cross-origin callers', () => {
  it('refuses an Origin the operator did not name', async () => {
    const started = await startRelay({ allowedOrigins: ['https://producer.example.org'] });
    open.push(started.close);
    const refused = await fetch(`${started.base}/v1/health`, { headers: { origin: 'https://evil.example' } });
    expect(refused.status).toBe(400);
  });

  it('allows one the operator did name, and never answers `*` — CONTROL', async () => {
    const started = await startRelay({ allowedOrigins: ['https://producer.example.org'] });
    open.push(started.close);
    const allowed = await fetch(`${started.base}/v1/health`, { headers: { origin: 'https://producer.example.org' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://producer.example.org');

    const preflight = await fetch(`${started.base}/v1/changesets`, {
      method: 'OPTIONS',
      headers: { origin: 'https://producer.example.org' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('lets Studio through, which sends no Origin at all — CONTROL', async () => {
    const started = await startRelay({ allowedOrigins: ['https://producer.example.org'] });
    open.push(started.close);
    // Roblox `HttpService` sends no Origin, so the consumer is unaffected by
    // the allowlist. A relay that refused a missing Origin would refuse the
    // plugin.
    expect((await fetch(`${started.base}/v1/health`)).status).toBe(200);
  });
});

describe('the control surface', () => {
  it('mints a session, once, and never serves the token again', async () => {
    const started = await startRelay();
    open.push(started.close);
    const minted = await json(
      await fetch(`${started.base}/control/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' } }),
    );
    expect(typeof minted.producerToken).toBe('string');
    expect(minted.transport).toBe('relay-tls');
    expect(minted.privacyPosture).toBe('Relay — the relay operator can read your changes');

    // The token is held as a digest, so nothing on the surface can hand it back.
    const status = await json(
      await fetch(`${started.base}/v1/link`, {
        headers: { 'x-forgebridge-token': minted.producerToken as string },
      }),
    );
    expect(JSON.stringify(status)).not.toContain(minted.producerToken as string);
  });

  it('can be closed to callers without the operator’s control token', async () => {
    const started = await startRelay({ controlToken: 'operator-only' });
    open.push(started.close);
    const refused = await fetch(`${started.base}/control/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(refused.status).toBe(401);

    const allowed = await fetch(`${started.base}/control/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgebridge-token': 'operator-only' },
    });
    expect(allowed.status).toBe(201);
  });

  it('is not under /v1, because /v1 is frozen to what the daemon serves', async () => {
    const started = await startRelay();
    open.push(started.close);
    expect((await fetch(`${started.base}/v1/control/sessions`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${started.base}/v1/sessions`, { method: 'POST' })).status).toBe(404);
  });
});
