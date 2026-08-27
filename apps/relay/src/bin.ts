#!/usr/bin/env node
import { DEFAULT_RELAY_LIMITS, type RelayLimits } from './abuse/limits.js';
import { CONTROL_SESSIONS_PATH } from './routes.js';
import { ForgeBridgeRelay, DEFAULT_RELAY_PORT, type RelayLogger } from './server.js';
import { PRIVACY_POSTURE } from '@forgebridge/protocol';

/**
 * `forgebridge-relay` — start the cloud transport.
 *
 * Everything this reads is an environment variable, because the deployment
 * targets a container. Every one of them fails closed: an unparseable number is
 * a startup error rather than a silent fallback to a default the operator did
 * not choose, since the numbers here are the ones that decide what the relay
 * spends and who it lets in.
 */

const ENV = {
  port: 'RELAY_PORT',
  host: 'RELAY_HOST',
  proxyHops: 'RELAY_PROXY_HOPS',
  insecureHttp: 'RELAY_INSECURE_HTTP',
  origins: 'RELAY_ALLOWED_ORIGINS',
  controlToken: 'RELAY_CONTROL_TOKEN',
  dailyBudget: 'RELAY_SPONSORED_DAILY_BUDGET',
  maxChangeSetBytes: 'RELAY_MAX_CHANGESET_BYTES',
  maxOperations: 'RELAY_MAX_OPERATIONS',
} as const;

const consoleLogger: RelayLogger = {
  info: (message, fields) => console.log(line('info', message, fields)),
  warn: (message, fields) => console.warn(line('warn', message, fields)),
  error: (message, fields) => console.error(line('error', message, fields)),
};

function line(level: string, message: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({ level, message, ...fields, at: new Date().toISOString() });
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name}=${raw} is not a non-negative integer`);
  }
  return value;
}

function boolFromEnv(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`${name}=${raw} is not a boolean; use 1/0 or true/false`);
}

export function limitsFromEnv(base: RelayLimits = DEFAULT_RELAY_LIMITS): RelayLimits {
  return {
    ...base,
    changeSet: {
      maxBytes: intFromEnv(ENV.maxChangeSetBytes, base.changeSet.maxBytes),
      maxOperations: intFromEnv(ENV.maxOperations, base.changeSet.maxOperations),
    },
    sponsored: {
      ...base.sponsored,
      dailyBudget: intFromEnv(ENV.dailyBudget, base.sponsored.dailyBudget),
    },
  };
}

export async function main(): Promise<number> {
  const insecure = boolFromEnv(ENV.insecureHttp);
  const proxyHops = intFromEnv(ENV.proxyHops, 0);
  const origins = (process.env[ENV.origins] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const controlToken = process.env[ENV.controlToken];

  const relay = new ForgeBridgeRelay({
    port: intFromEnv(ENV.port, DEFAULT_RELAY_PORT),
    host: process.env[ENV.host] ?? '0.0.0.0',
    proxy: { hops: proxyHops },
    requireTls: !insecure,
    allowedOrigins: origins,
    ...(controlToken ? { controlToken } : {}),
    limits: limitsFromEnv(),
    logger: consoleLogger,
    // No verification port, no ASN port and no run service are wired here.
    // Their absence is the honest default: this binary does not know which
    // identity provider, which ASN database or which run service a deployment
    // has, and inventing one would be a relay guessing about the two things
    // that decide who gets a sponsored run (M23, M45).
  });

  const { host, port } = await relay.listen();

  console.log(line('info', 'forgebridge-relay listening', { host, port }));
  // Printed on every start, because the one thing a relay operator must never
  // let a user misunderstand is who can read their changes (ADR-014).
  console.log(line('info', PRIVACY_POSTURE['relay-tls'], { transport: 'relay-tls' }));
  if (insecure) {
    console.warn(
      line('warn', 'TLS enforcement is OFF — this process is not serving the relay-tls transport honestly', {
        env: ENV.insecureHttp,
        use: 'local development only',
      }),
    );
  }
  if (proxyHops === 0 && !insecure) {
    console.warn(
      line('warn', 'no trusted proxy hops configured; forwarded headers are ignored and every request will be ' +
        'rate limited under the proxy address', { env: ENV.proxyHops }),
    );
  }
  console.log(line('info', `mint a session with POST ${CONTROL_SESSIONS_PATH}`, {
    gated: controlToken !== undefined,
  }));

  const shutdown = (signal: string): void => {
    console.log(line('info', 'shutting down', { signal }));
    void relay.close().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('bin.js');

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(line('error', 'relay failed to start', { error: String(error) }));
    process.exit(1);
  });
}
