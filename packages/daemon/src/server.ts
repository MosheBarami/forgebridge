import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  ApplyResult,
  ChangeSet,
  ForgeBridgeError,
  LIMITS,
  Link,
  PLUGIN_VERSION_HEADER,
  PRIVACY_POSTURE,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  RollbackRequest,
  deletionCount,
  isCompatible,
  isDestructive,
  isFullyApplied,
  pathsOf,
  withinSizeLimit,
  type ChangeSetStatus,
  type Operation,
} from '@forgebridge/protocol';
import { DENY_ALL_POLICY, checkPolicy, type ProjectPolicy } from '@forgebridge/core';
import { analyse, normaliseHost } from '@forgebridge/luau-analysis';
import type { Finding, Validation } from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER, assertProducerToken, mintProducerToken } from './auth.js';
import { NONCE_ORIGIN, openEnvelope, sealEnvelope, verifyRequestMac } from './envelope.js';
import {
  LOOPBACK_HOST,
  corsHeadersFor,
  headerValue,
  hostIsLoopback,
  originIsAllowed,
  parseOrThrow,
  readJson,
  writeEmpty,
  writeError,
  writeJson,
} from './http.js';
import { PairingService, type IssuedPairingCode } from './pairing.js';
import { InMemoryDaemonStore, type DaemonStore, type DeliveryRecord, type JournalRecord } from './store.js';
import {
  ApproveRequest,
  ChangeSetDiff,
  DeliveryPayload,
  ModelsSnapshot,
  OutputBatch,
  PairRequest,
  type ModelsPort,
  type OperationDiff,
  type OutputMessage,
} from './wire.js';

/**
 * The daemon's default port.
 *
 * Roblox scopes a plugin's HttpService permission to a specific address, so an
 * ephemeral or auto-incrementing port would re-prompt the user on every restart
 * (ARCHITECTURE §3). The number therefore has to be picked once and then left
 * alone; it only needs to be stable and unlikely to collide with a dev server.
 *
 * TODO(M15): the Studio plugin's default base URL must be built from this
 * constant. Owner: the plugin author — a mismatch here reads to a user as
 * "the bridge is broken".
 */
export const DEFAULT_DAEMON_PORT = 7317;

/**
 * Read from package.json rather than duplicated as a literal: a hand-copied
 * version is a version that goes stale, and `/v1/health` is what a support
 * request quotes when a user says the bridge is misbehaving.
 */
export const DAEMON_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/**
 * How long a poll is held open. Kept comfortably below a consumer's own request
 * timeout so a quiet period ends in a clean 204 rather than a client-side error
 * the plugin would have to distinguish from a dead daemon.
 */
export const POLL_TIMEOUT_MS = 25_000;

const LINK_HEADER = 'X-ForgeBridge-Link';
const MAC_HEADER = 'X-ForgeBridge-Mac';
const OUTPUT_READ_LIMIT = 200;

export interface DaemonLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: DaemonLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface DaemonOptions {
  port?: number;
  /** Project every link and ChangeSet belongs to unless one says otherwise. */
  projectId?: string;
  store?: DaemonStore;
  models?: ModelsPort;
  /**
   * The path policy used for any project the store has no policy for.
   *
   * Defaults to `DENY_ALL_POLICY`: an unconfigured project refuses every
   * ChangeSet and says so. A daemon that defaulted to "anything goes" would be
   * running the policy layer of THREAT-MODEL T2 with the check disabled, and
   * nobody would notice until a set wrote somewhere nobody expected.
   */
  policy?: ProjectPolicy;
  /**
   * The secret producer requests must present. Minted per process when absent,
   * which is the normal case; supplied when a launcher needs both ends to know
   * it up front (see `PRODUCER_TOKEN_ENV`).
   */
  producerToken?: string;
  /**
   * Browser origins permitted to call the daemon. Empty by default: this
   * process can reach the user's provider keys, so widening it is the
   * operator's explicit decision, never a convenience default.
   */
  allowedOrigins?: readonly string[];
  /**
   * Hosts a generated script may reach through `HttpService`. Empty by default,
   * and empty means none: every outbound call is then a finding. Fail-closed,
   * for the same reason `policy` defaults to `DENY_ALL_POLICY`. Entries are
   * normalised on the way in, so `https://API.Example.com/v1` and
   * `api.example.com` are one entry; `*.example.com` matches subdomains.
   *
   * TODO(M38): this belongs on the project's own policy, beside
   * `allowedPathPrefixes`, so two projects on one daemon can differ. It is a
   * process-wide option here because `ProjectPolicy` has no field for it yet,
   * and inventing one in the daemon would put a policy decision outside
   * `@forgebridge/core`.
   */
  allowedHttpHosts?: readonly string[];
  logger?: DaemonLogger;
  pollTimeoutMs?: number;
  now?: () => number;
}

interface Waiter {
  linkId: string;
  since: number;
  settle: (delivery: DeliveryRecord | null) => void;
}

const unconfiguredModels: ModelsPort = {
  async snapshot() {
    return {
      configured: false,
      source: 'no registry wired into this daemon',
      verifiedAt: null,
      models: [],
    };
  },
};

export class ForgeBridgeDaemon {
  readonly store: DaemonStore;
  readonly defaultProjectId: string;

  /**
   * The producer secret, readable so the process that started the daemon can
   * print it or hand it to a client it spawned. It is a secret in the same
   * sense the pairing code is: surfaced once to the human who started this, and
   * never served over HTTP.
   */
  readonly producerToken: string;

  readonly #server: Server;
  readonly #pairing: PairingService;
  readonly #models: ModelsPort;
  readonly #allowedOrigins: readonly string[];
  readonly #allowedHttpHosts: readonly string[];
  readonly #logger: DaemonLogger;
  readonly #pollTimeoutMs: number;
  readonly #now: () => number;
  readonly #port: number;
  readonly #startedAtMs: number;
  readonly #waiters = new Set<Waiter>();
  readonly #defaultPolicy: ProjectPolicy;

  /**
   * Session keys live here and nowhere else — not in the store, not on disk,
   * not in a log. The cost is that links do not survive a restart and have to
   * re-pair; that is a ten-second inconvenience traded for a key that cannot
   * leak from a file a persistent adapter wrote (C4, ADR-006).
   */
  readonly #keyring = new Map<string, Buffer>();

  constructor(options: DaemonOptions = {}) {
    this.store = options.store ?? new InMemoryDaemonStore({ now: options.now ?? Date.now });
    this.defaultProjectId = options.projectId ?? randomUUID();
    this.#models = options.models ?? unconfiguredModels;
    this.#allowedOrigins = options.allowedOrigins ?? [];
    // Normalised on the way in, so a caller that passed a URL, a port or an
    // uppercase name gets the allowlist it meant rather than one matching
    // nothing — which from the outside is indistinguishable from a working
    // allowlist. The analyser's own function, so the two cannot drift.
    this.#allowedHttpHosts = (options.allowedHttpHosts ?? []).map(normaliseHost).filter((host) => host.length > 0);
    this.#logger = options.logger ?? silentLogger;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#port = options.port ?? DEFAULT_DAEMON_PORT;
    this.#defaultPolicy = options.policy ?? DENY_ALL_POLICY;
    this.producerToken = options.producerToken ?? mintProducerToken();
    this.#startedAtMs = this.#now();
    this.#pairing = new PairingService({ now: this.#now });
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  /**
   * Bind loopback, explicitly, with no option to widen it.
   *
   * Omitting the host makes Node listen on every interface, which would put a
   * process holding the user's API keys and a write channel into their Roblox
   * place on the local network. There is no configuration path to that.
   */
  async listen(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once('error', onError);
      this.#server.listen({ host: LOOPBACK_HOST, port: this.#port }, () => {
        this.#server.removeListener('error', onError);
        resolve();
      });
    });
    const address = this.address;
    const port = address?.port ?? this.#port;
    return { host: LOOPBACK_HOST, port, url: `http://${LOOPBACK_HOST}:${port}` };
  }

  async close(): Promise<void> {
    // Release every held poll first, or close() waits out the full poll window
    // on connections that are healthy and idle by design.
    for (const waiter of [...this.#waiters]) waiter.settle(null);
    this.#waiters.clear();
    this.#keyring.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  get address(): AddressInfo | null {
    const address = this.#server.address();
    return address && typeof address === 'object' ? address : null;
  }

  get url(): string {
    const port = this.address?.port ?? this.#port;
    return `http://${LOOPBACK_HOST}:${port}`;
  }

  /**
   * How many long-polls are currently being held. An operational metric first
   * — a number that only ever climbs is the signature of leaked poll handles,
   * which is how a daemon dies quietly after an hour.
   */
  get heldPolls(): number {
    return this.#waiters.size;
  }

  /** Mint a pairing code. The code is returned, never logged, never served. */
  issuePairingCode(): IssuedPairingCode {
    return this.#pairing.issue();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = headerValue(req, 'origin');
    const cors = corsHeadersFor(origin, this.#allowedOrigins);
    try {
      this.#assertProtocolCompatible(req);

      if (!hostIsLoopback(req.headers.host)) {
        throw new ForgeBridgeError(
          'invalid_request',
          'Host must be a loopback address',
          'Reach the daemon as 127.0.0.1 or localhost.',
        );
      }
      if (!originIsAllowed(origin, this.#allowedOrigins)) {
        throw new ForgeBridgeError(
          'invalid_request',
          'this origin is not permitted to call the daemon',
          'Start the daemon with --allow-origin <origin> if this is your own app.',
        );
      }

      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'OPTIONS') {
        writeEmpty(res, 204, cors);
        return;
      }

      await this.#route(req, res, url, segments, cors);
    } catch (error) {
      if (!(error instanceof ForgeBridgeError)) {
        this.#logger.error('unhandled daemon error', { error: String(error) });
      }
      writeError(res, error, cors);
    }
  }

  #assertProtocolCompatible(req: IncomingMessage): void {
    const declared = headerValue(req, PROTOCOL_VERSION_HEADER);
    if (!declared) return;
    const major = Number.parseInt(declared.split('.')[0] ?? '', 10);
    if (!Number.isInteger(major) || !isCompatible(PROTOCOL_MAJOR, major)) {
      throw new ForgeBridgeError(
        'unsupported_version',
        `this daemon speaks protocol ${PROTOCOL_VERSION}; the caller declared ${declared}`,
        'Update the plugin or the daemon so both are on the same protocol major.',
      );
    }
  }

  async #route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    segments: readonly string[],
    cors: Record<string, string>,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const [version, resource, ...rest] = segments;

    if (version !== 'v1') throw new ForgeBridgeError('not_found', 'unknown path');

    if (resource === 'health' && rest.length === 0 && method === 'GET') {
      return this.#health(res, cors);
    }

    if (resource === 'link') {
      if (rest.length === 0 && method === 'GET') return this.#linkStatus(res, cors);
      if (rest[0] === 'pair' && rest.length === 1 && method === 'POST') return this.#pair(req, res, cors);
      if (rest[0] === 'poll' && rest.length === 1 && method === 'GET') return this.#poll(req, res, url, cors);
    }

    // Producer routes carry the token; consumer routes carry a MAC. The two
    // are marked here, at the routing table, so that adding a route makes the
    // question "which side of the boundary is this on?" unavoidable.
    if (resource === 'changesets') {
      if (rest.length === 0 && method === 'POST') {
        this.#assertProducer(req);
        return this.#submitChangeSet(req, res, cors);
      }
      const id = rest[0];
      if (id && rest[1] === 'diff' && rest.length === 2 && method === 'GET') {
        // A read, but it serves script source and property values out of the
        // user's place; it is producer surface, not public surface.
        this.#assertProducer(req);
        return this.#diff(res, id, cors);
      }
      if (id && rest[1] === 'approve' && rest.length === 2 && method === 'POST') {
        this.#assertProducer(req);
        return this.#approve(req, res, id, cors);
      }
      if (id && rest[1] === 'apply-result' && rest.length === 2 && method === 'POST') {
        return this.#applyResult(req, res, cors, id);
      }
    }

    // `PROTOCOL.md` documents the apply-result endpoint under the ChangeSet it
    // reports on. The unparameterised form is accepted too because the
    // ApplyResult already names its own `changeSetId`, and a consumer that has
    // the result but not the path is otherwise stuck.
    if (resource === 'apply-result' && rest.length === 0 && method === 'POST') {
      return this.#applyResult(req, res, cors, null);
    }

    if (resource === 'journal' && rest[1] === 'rollback' && rest.length === 2 && method === 'POST') {
      this.#assertProducer(req);
      return this.#rollback(req, res, rest[0] as string, cors);
    }

    if (resource === 'output' && rest.length === 0) {
      // POST is the consumer mirroring its console up (enveloped, MAC'd); GET
      // is a producer reading that console back, which is place content.
      if (method === 'POST') return this.#output(req, res, cors);
      if (method === 'GET') {
        this.#assertProducer(req);
        return this.#readOutput(res, url, cors);
      }
    }

    if (resource === 'models' && rest.length === 0 && method === 'GET') {
      return this.#models_(res, cors);
    }

    throw new ForgeBridgeError('not_found', 'unknown path');
  }

  // ── endpoints ──────────────────────────────────────────────────────────────

  #health(res: ServerResponse, cors: Record<string, string>): void {
    writeJson(
      res,
      200,
      {
        ok: true,
        service: 'forgebridge-daemon',
        version: DAEMON_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        transport: 'local-daemon',
        boundTo: `${LOOPBACK_HOST}:${this.address?.port ?? this.#port}`,
        uptimeSeconds: Math.max(0, (this.#now() - this.#startedAtMs) / 1000),
      },
      cors,
    );
  }

  async #linkStatus(res: ServerResponse, cors: Record<string, string>): Promise<void> {
    writeJson(
      res,
      200,
      {
        transport: 'local-daemon',
        privacyPosture: PRIVACY_POSTURE['local-daemon'],
        protocolVersion: PROTOCOL_VERSION,
        defaultProjectId: this.defaultProjectId,
        links: await this.store.listLinks(),
        // Deliberately reports only that a code is outstanding. Serving the
        // code itself would hand it to anything that can reach the port and
        // defeat the whole point of carrying it by hand.
        pairing: this.#pairing.status(),
      },
      cors,
    );
  }

  async #pair(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const body = parseOrThrow(PairRequest, await readJson(req, 8 * 1024), 'pair request');
    const linkId = randomUUID();
    const redeemed = this.#pairing.redeem(body.pairingCode, linkId);

    const link = Link.parse({
      id: linkId,
      projectId: body.projectId ?? this.defaultProjectId,
      transport: 'local-daemon',
      state: 'paired',
      sessionKeyId: redeemed.sessionKeyId,
      pluginVersion: body.pluginVersion ?? headerValue(req, PLUGIN_VERSION_HEADER) ?? null,
      studioVersion: body.studioVersion ?? null,
      placeId: body.placeId ?? null,
      lastSeenAt: new Date(this.#now()).toISOString(),
      createdAt: new Date(this.#now()).toISOString(),
    });

    await this.store.putLink(link);
    this.#keyring.set(linkId, redeemed.sessionKey);
    this.#logger.info('link paired', { linkId, projectId: link.projectId, sessionKeyId: redeemed.sessionKeyId });

    writeJson(
      res,
      200,
      {
        linkId,
        sessionKeyId: redeemed.sessionKeyId,
        projectId: link.projectId,
        transport: 'local-daemon',
        privacyPosture: PRIVACY_POSTURE['local-daemon'],
        sessionSalt: redeemed.salt.toString('base64'),
        since: NONCE_ORIGIN,
        protocolVersion: PROTOCOL_VERSION,
      },
      cors,
    );
  }

  async #poll(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cors: Record<string, string>,
  ): Promise<void> {
    const since = parseCursor(url.searchParams.get('since'));
    const { link, sessionKey } = await this.#authenticate(req, ['GET', '/v1/link/poll', String(since)]);
    await this.store.patchLink(link.id, { lastSeenAt: new Date(this.#now()).toISOString() });

    const immediate = await this.store.nextDelivery(link.id, since);
    if (immediate) {
      await this.#deliver(res, sessionKey, immediate, cors);
      return;
    }

    const delivery = await this.#wait(req, res, link.id, since);
    // The client may have hung up while we held the request; writing to a
    // closed response is how a leaked handle per poll becomes a dead daemon.
    if (res.writableEnded || res.destroyed) return;
    if (!delivery) {
      writeEmpty(res, 204, cors);
      return;
    }
    await this.#deliver(res, sessionKey, delivery, cors);
  }

  #wait(
    req: IncomingMessage,
    res: ServerResponse,
    linkId: string,
    since: number,
  ): Promise<DeliveryRecord | null> {
    return new Promise<DeliveryRecord | null>((resolve) => {
      let done = false;
      const waiter: Waiter = {
        linkId,
        since,
        settle: (delivery) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          res.removeListener('close', onClose);
          req.removeListener('close', onClose);
          resolve(delivery);
        },
      };
      const timer = setTimeout(() => waiter.settle(null), this.#pollTimeoutMs);
      // Node keeps the process alive for a pending timer; a daemon should not
      // linger on shutdown because one plugin happened to be mid-poll.
      timer.unref?.();
      const onClose = (): void => waiter.settle(null);
      this.#waiters.add(waiter);
      res.once('close', onClose);
      req.once('close', onClose);
    });
  }

  async #deliver(
    res: ServerResponse,
    sessionKey: Buffer,
    delivery: DeliveryRecord,
    cors: Record<string, string>,
  ): Promise<void> {
    if (delivery.payload.kind === 'changeset') {
      await this.store.setChangeSetStatus(delivery.payload.changeSet.id, 'applying');
    }
    const envelope = sealEnvelope(sessionKey, {
      linkId: delivery.linkId,
      nonce: delivery.nonce,
      payload: delivery.payload,
    });
    writeJson(res, 200, envelope, cors);
  }

  async #submitChangeSet(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const raw = await readJson(req, LIMITS.MAX_CHANGESET_BYTES);
    const changeSet = parseOrThrow(ChangeSet, raw, 'changeset');

    if (!withinSizeLimit(changeSet)) {
      throw new ForgeBridgeError(
        'too_large',
        `changeset exceeds ${LIMITS.MAX_CHANGESET_BYTES} bytes`,
        'Split the work into staged ChangeSets.',
      );
    }

    const current = await this.store.getProjectVersion(changeSet.projectId);
    if (changeSet.baseVersion !== current) {
      // No merge, no last-write-wins: the producer rebases (PROTOCOL invariant 1).
      throw new ForgeBridgeError(
        'stale_base',
        `changeset was built against version ${changeSet.baseVersion}; the project is at ${current}`,
        `Rebuild against version ${current} and resubmit.`,
      );
    }

    // Neither a producer-supplied `status` nor a producer-supplied `validation`
    // is authoritative, and for the same reason: a ChangeSet arriving
    // pre-marked `approved`, or carrying `validation: { policy: ok }`, is a
    // model clearing its own work (ADR-012, PROTOCOL invariant 4). `status` was
    // already dropped here; `validation` was not, and `#approve` gates on it —
    // so layers 2 and 3 of the THREAT-MODEL T2 defence were being supplied by
    // the caller they defend against. Both fields are overwritten below with
    // what this process computed, never merged with what arrived.
    const validation = await this.#validate(changeSet);
    const status: ChangeSetStatus = 'validated';
    const stored: ChangeSet = { ...changeSet, validation, status };
    await this.store.putChangeSet(stored);

    if (validation.policy.status === 'fail') {
      this.#logger.warn('changeset failed the project path policy', {
        changeSetId: stored.id,
        projectId: stored.projectId,
        violations: validation.policy.violations.length,
      });
    }

    // The verdict rides on the response so a producer does not have to fetch
    // the diff to learn that its set is already dead.
    writeJson(
      res,
      201,
      { changeSetId: stored.id, status, baseVersion: stored.baseVersion, validation },
      cors,
    );
  }

  /**
   * Compute the verdict this daemon is willing to stand behind.
   *
   * Both halves are real and both run here, inside the trust boundary:
   * `checkPolicy` from `@forgebridge/core` against the project's stored
   * allowlist, and `analyse` from `@forgebridge/luau-analysis` over every source
   * the set carries. Neither inherits anything from the `validation` the
   * producer sent, which is overwritten by what this computed.
   */
  async #validate(changeSet: ChangeSet): Promise<Validation> {
    const policy = (await this.store.getProjectPolicy(changeSet.projectId)) ?? this.#defaultPolicy;
    const decision = checkPolicy(changeSet, policy);
    return {
      luau: luauVerdict(changeSet, this.#allowedHttpHosts),
      policy: decision.policy,
      computedAt: new Date(this.#now()).toISOString(),
      computedBy: `forgebridge-daemon@${DAEMON_VERSION}`,
    };
  }

  async #diff(res: ServerResponse, id: string, cors: Record<string, string>): Promise<void> {
    const changeSet = await this.#requireChangeSet(id);
    const currentVersion = await this.store.getProjectVersion(changeSet.projectId);

    const operations: OperationDiff[] = changeSet.operations.map((operation, index) => ({
      index,
      op: operation.op,
      paths: pathsOf(operation),
      summary: describeOperation(operation),
      destructive: isDestructive(operation),
      ...afterValueOf(operation),
    }));

    const diff: ChangeSetDiff = {
      changeSetId: changeSet.id,
      projectId: changeSet.projectId,
      summary: changeSet.summary,
      status: changeSet.status,
      baseVersion: changeSet.baseVersion,
      currentVersion,
      stale: changeSet.baseVersion !== currentVersion,
      counts: {
        total: changeSet.operations.length,
        creates: countOps(changeSet.operations, 'createInstance'),
        setProperties: countOps(changeSet.operations, 'setProperty'),
        scripts: countOps(changeSet.operations, 'writeScript'),
        moves: countOps(changeSet.operations, 'moveInstance'),
        deletes: countOps(changeSet.operations, 'deleteInstance'),
      },
      operations,
      ...(changeSet.validation ? { validation: changeSet.validation } : {}),
      treeAware: false,
    };

    writeJson(res, 200, diff, cors);
  }

  async #approve(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    cors: Record<string, string>,
  ): Promise<void> {
    const body = parseOrThrow(ApproveRequest, await readJson(req, 16 * 1024), 'approve request');
    const changeSet = await this.#requireChangeSet(id);

    if (changeSet.status !== 'proposed' && changeSet.status !== 'validated') {
      throw new ForgeBridgeError(
        'invalid_request',
        `a changeset in status "${changeSet.status}" cannot be approved`,
        'Submit a fresh ChangeSet.',
      );
    }

    // Every set that came in through `POST /v1/changesets` has a verdict this
    // daemon computed, so this is unreachable from the wire. It stays because
    // the store is a seam: an adapter, a fixture or a future ingress that hands
    // over an unvalidated set must fail closed here rather than be approved on
    // the strength of a missing field.
    if (!changeSet.validation) {
      throw new ForgeBridgeError(
        'invalid_request',
        'this changeset carries no validation and cannot be approved',
        'Resubmit it through POST /v1/changesets so the daemon validates it.',
      );
    }
    if (changeSet.validation.luau.status === 'fail' || changeSet.validation.policy.status === 'fail') {
      throw new ForgeBridgeError(
        'policy_violation',
        'validation failed for this changeset',
        'Read the findings on GET /v1/changesets/:id/diff and fix them.',
      );
    }

    const deletes = deletionCount(changeSet);
    if (deletes > LIMITS.BULK_DELETE_CONFIRM_THRESHOLD && !body.confirmBulkDelete) {
      throw new ForgeBridgeError(
        'invalid_request',
        `this changeset deletes ${deletes} instances, above the confirmation threshold of ${LIMITS.BULK_DELETE_CONFIRM_THRESHOLD}`,
        'Resend with confirmBulkDelete: true if that is intended.',
      );
    }

    const current = await this.store.getProjectVersion(changeSet.projectId);
    if (changeSet.baseVersion !== current) {
      // Re-checked here because the tree can move between submit and approve.
      throw new ForgeBridgeError(
        'stale_base',
        `changeset was built against version ${changeSet.baseVersion}; the project is at ${current}`,
        `Rebuild against version ${current} and resubmit.`,
      );
    }

    const link = await this.#requirePairedLink(changeSet.projectId);
    await this.store.setChangeSetStatus(changeSet.id, 'approved');
    const delivery = await this.#enqueue(link.id, { kind: 'changeset', changeSet });

    this.#logger.info('changeset approved', {
      changeSetId: changeSet.id,
      approvedBy: body.approvedBy,
      operations: changeSet.operations.length,
      deletes,
    });

    writeJson(res, 202, { changeSetId: changeSet.id, status: 'approved', nonce: delivery.nonce }, cors);
  }

  async #applyResult(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
    pathChangeSetId: string | null,
  ): Promise<void> {
    const { link, payload } = await this.#openFromConsumer(req, LIMITS.MAX_CHANGESET_BYTES);
    const result = parseOrThrow(ApplyResult, payload, 'apply result');

    if (pathChangeSetId && pathChangeSetId !== result.changeSetId) {
      throw new ForgeBridgeError('invalid_request', 'apply result does not match the changeset in the path');
    }

    const changeSet = await this.#requireChangeSet(result.changeSetId);
    if (changeSet.projectId !== link.projectId) {
      throw new ForgeBridgeError('link_unauthenticated', 'this link is not bound to that changeset');
    }
    if (changeSet.status !== 'approved' && changeSet.status !== 'applying') {
      throw new ForgeBridgeError(
        'not_approved',
        `a changeset in status "${changeSet.status}" was never cleared to apply`,
        'Approve the changeset before reporting a result for it.',
      );
    }

    // Before anything is written: a journal id that already exists names an
    // apply whose inverses are the only way back from it, and `putJournal`
    // would otherwise overwrite that record with this one (THREAT-MODEL T2
    // layer 5). Checked here rather than only in the store so the refusal
    // happens before the project version and the changeset status have moved.
    if (await this.store.getJournal(result.journalId)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${result.journalId} is already recorded for an earlier apply`,
        'Mint a fresh journal id for each apply; reusing one would discard the rollback handle for the first.',
      );
    }

    const versionBefore = await this.store.getProjectVersion(changeSet.projectId);
    if (result.newVersion < versionBefore) {
      throw new ForgeBridgeError(
        'invalid_request',
        `newVersion ${result.newVersion} is behind the recorded version ${versionBefore}`,
      );
    }

    const anyApplied = result.outcomes.some((outcome) => outcome.ok);
    const status: ChangeSetStatus = isFullyApplied(result) ? 'applied' : anyApplied ? 'partial' : 'failed';

    await this.store.putApplyResult(result);
    await this.store.setChangeSetStatus(changeSet.id, status);
    await this.store.setProjectVersion(changeSet.projectId, result.newVersion);
    await this.store.patchLink(link.id, {
      lastSeenAt: result.appliedAt,
      pluginVersion: result.pluginVersion,
    });

    const journal: JournalRecord = {
      id: result.journalId,
      projectId: changeSet.projectId,
      changeSetId: changeSet.id,
      summary: changeSet.summary,
      versionBefore,
      versionAfter: result.newVersion,
      appliedAt: result.appliedAt,
      rollbackRequestedAt: null,
      rolledBackAt: null,
    };
    await this.store.putJournal(journal);

    this.#logger.info('apply result recorded', {
      changeSetId: changeSet.id,
      status,
      applied: result.outcomes.filter((outcome) => outcome.ok).length,
      of: result.outcomes.length,
      newVersion: result.newVersion,
    });

    writeJson(res, 200, { changeSetId: changeSet.id, status, version: result.newVersion, journalId: journal.id }, cors);
  }

  async #rollback(
    req: IncomingMessage,
    res: ServerResponse,
    journalId: string,
    cors: Record<string, string>,
  ): Promise<void> {
    const body = parseOrThrow(RollbackRequest, await readJson(req, 16 * 1024), 'rollback request');
    if (body.journalId !== journalId) {
      throw new ForgeBridgeError('invalid_request', 'rollback request does not match the journal in the path');
    }

    const journal = await this.store.getJournal(journalId);
    if (!journal) throw new ForgeBridgeError('not_found', 'no such journal entry');
    if (journal.rolledBackAt) {
      throw new ForgeBridgeError('invalid_request', 'this journal entry has already been rolled back');
    }

    const current = await this.store.getProjectVersion(journal.projectId);
    if (body.expectedVersion !== current) {
      throw new ForgeBridgeError(
        'stale_base',
        `rollback expected version ${body.expectedVersion}; the project is at ${current}`,
        `Re-read the project version and resubmit with ${current}.`,
      );
    }

    const link = await this.#requirePairedLink(journal.projectId);
    const delivery = await this.#enqueue(link.id, {
      kind: 'rollback',
      journalId: journal.id,
      changeSetId: journal.changeSetId,
      expectedVersion: current,
      ...(body.reason ? { reason: body.reason } : {}),
    });

    // Dispatched, not done. The inverse operations live on the consumer that
    // captured them, so only the consumer can say a rollback completed.
    //
    // TODO(M11): the protocol has no way for a consumer to report a completed
    // rollback — `ApplyResult` cannot say "this was the inverse of journal X",
    // so `rolledBackAt` stays null and the UI must show "requested". Owner: the
    // protocol maintainer, as an additive field on ApplyResult or a sibling
    // RollbackResult. Inferring completion from the next ApplyResult would be a
    // heuristic on the one mechanism that must never guess.
    await this.store.patchJournal(journal.id, {
      rollbackRequestedAt: new Date(this.#now()).toISOString(),
    });

    writeJson(
      res,
      202,
      { journalId: journal.id, changeSetId: journal.changeSetId, status: 'dispatched', nonce: delivery.nonce },
      cors,
    );
  }

  async #output(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const { link, payload } = await this.#openFromConsumer(req, 2 * 1024 * 1024);
    const batch = parseOrThrow(OutputBatch, payload, 'output batch');
    await this.store.appendOutput(link.id, batch.messages);
    await this.store.patchLink(link.id, { lastSeenAt: new Date(this.#now()).toISOString() });
    writeEmpty(res, 204, cors);
  }

  async #readOutput(res: ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
    const requested = url.searchParams.get('link');
    const link = requested
      ? await this.store.getLink(requested)
      : await this.store.findPairedLink(this.defaultProjectId);
    if (!link) throw new ForgeBridgeError('link_unpaired', 'no link to read console output from');
    const messages: OutputMessage[] = await this.store.recentOutput(link.id, OUTPUT_READ_LIMIT);
    writeJson(res, 200, { messages }, cors);
  }

  async #models_(res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const snapshot = ModelsSnapshot.parse(await this.#models.snapshot());
    writeJson(res, 200, snapshot, cors);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  async #requireChangeSet(id: string): Promise<ChangeSet> {
    const changeSet = await this.store.getChangeSet(id);
    if (!changeSet) throw new ForgeBridgeError('not_found', 'no such changeset');
    return changeSet;
  }

  /**
   * Gate a producer route on the process-wide token.
   *
   * Loopback is not an authentication boundary: any process on the box, and any
   * page the user has open that can be made to POST here, reaches these routes.
   * `approve` and `rollback` are the two that must never be reachable without
   * this — one clears a ChangeSet to write into the place, the other dispatches
   * a reversal of work the user may not want reversed.
   */
  #assertProducer(req: IncomingMessage): void {
    assertProducerToken(this.producerToken, headerValue(req, PRODUCER_TOKEN_HEADER));
  }

  async #requirePairedLink(projectId: string): Promise<Link> {
    const link = await this.store.findPairedLink(projectId);
    if (!link || !this.#keyring.has(link.id)) {
      throw new ForgeBridgeError(
        'link_unpaired',
        'no paired Studio session for this project',
        'Open the place in Studio and pair the plugin with a fresh pairing code.',
      );
    }
    return link;
  }

  /** Authenticate a bodyless consumer request by MAC over its own parameters. */
  async #authenticate(
    req: IncomingMessage,
    macParts: readonly string[],
  ): Promise<{ link: Link; sessionKey: Buffer }> {
    const linkId = headerValue(req, LINK_HEADER);
    if (!linkId) {
      throw new ForgeBridgeError('link_unauthenticated', `${LINK_HEADER} is required`);
    }
    const link = await this.store.getLink(linkId);
    if (!link || link.state !== 'paired') {
      throw new ForgeBridgeError('link_unauthenticated', 'unknown or revoked link');
    }
    const sessionKey = this.#keyring.get(linkId);
    if (!sessionKey) {
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'this link has no session key on this daemon',
        'Re-pair: session keys are held in memory only and do not survive a daemon restart.',
      );
    }
    const mac = headerValue(req, MAC_HEADER);
    if (!mac || !verifyRequestMac(sessionKey, [linkId, ...macParts], mac)) {
      throw new ForgeBridgeError('link_unauthenticated', 'request MAC did not verify');
    }
    return { link, sessionKey };
  }

  /** Open an enveloped write from a paired consumer, replay check included. */
  async #openFromConsumer(
    req: IncomingMessage,
    limitBytes: number,
  ): Promise<{ link: Link; payload: unknown }> {
    const linkId = headerValue(req, LINK_HEADER);
    if (!linkId) {
      throw new ForgeBridgeError('link_unauthenticated', `${LINK_HEADER} is required`);
    }
    const link = await this.store.getLink(linkId);
    if (!link || link.state !== 'paired') {
      throw new ForgeBridgeError('link_unauthenticated', 'unknown or revoked link');
    }
    const sessionKey = this.#keyring.get(linkId);
    if (!sessionKey) {
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'this link has no session key on this daemon',
        'Re-pair: session keys are held in memory only and do not survive a daemon restart.',
      );
    }

    const raw = await readJson(req, limitBytes);
    const opened = openEnvelope(sessionKey, raw, { linkId });

    // Claim the nonce before doing any work, so a duplicate that arrives while
    // this one is still in flight is rejected rather than applied twice — and
    // claim it in one atomic step, because the guarantee in that sentence is a
    // compare-and-swap. Reading the watermark and then writing it is two store
    // calls with an await between them: both copies of a duplicated request can
    // read the old value before either writes, and both then apply.
    //
    // After the MAC has verified, never before: an unauthenticated caller who
    // could advance this watermark would lock the real consumer out.
    const claimed = await this.store.tryAdvanceInboundNonce(linkId, opened.envelope.nonce);
    if (!claimed) {
      const lastAccepted = await this.store.lastInboundNonce(linkId);
      throw new ForgeBridgeError(
        'replay_detected',
        `nonce ${opened.envelope.nonce} is at or below the last accepted nonce ${lastAccepted}`,
        'Read the link state and send the next nonce.',
      );
    }
    return { link, payload: opened.payload };
  }

  async #enqueue(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord> {
    const parsed = DeliveryPayload.parse(payload);
    const delivery = await this.store.enqueueDelivery(linkId, parsed);
    this.#wake(linkId);
    return delivery;
  }

  /** Release every poll held open for this link that the delivery is newer than. */
  #wake(linkId: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.linkId !== linkId) continue;
      void this.store.nextDelivery(linkId, waiter.since).then((delivery) => {
        if (delivery) waiter.settle(delivery);
      });
    }
  }
}

export function createDaemon(options: DaemonOptions = {}): ForgeBridgeDaemon {
  return new ForgeBridgeDaemon(options);
}

function parseCursor(raw: string | null): number {
  if (raw === null || raw === '') return NONCE_ORIGIN;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ForgeBridgeError('invalid_request', 'since must be a non-negative integer');
  }
  return value;
}

/**
 * True when an operation carries Luau source into the place.
 *
 * `writeScript` is the obvious one. `Source` set as an ordinary property is the
 * same act by another route — the protocol allows it, and an analyser gate that
 * only looked at `writeScript` would be a gate with a door beside it.
 */
function carriesLuauSource(operation: Operation): boolean {
  if (operation.op === 'writeScript') return true;
  if (operation.op === 'setProperty') return operation.property === 'Source';
  if (operation.op === 'createInstance') return 'Source' in operation.properties;
  return false;
}

/**
 * One Luau source a ChangeSet carries, and the operation that carries it.
 *
 * `writeScript` is the obvious route. `Source` set as an ordinary property is
 * the same act by another name, so both are read here — see `carriesLuauSource`.
 */
interface LuauSource {
  operationIndex: number;
  path: string;
  source: string;
}

/** The string a `PropertyValue` holds, or null when it does not hold one. */
function sourceTextOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const property = value as { t?: unknown; v?: unknown };
  return property.t === 'String' && typeof property.v === 'string' ? property.v : null;
}

function luauSourcesOf(set: ChangeSet): { sources: LuauSource[]; unreadable: number[] } {
  const sources: LuauSource[] = [];
  // An operation that writes `Source` with something other than a string is
  // still an operation that writes `Source`. There is no text to analyse, so it
  // is counted here rather than dropped: reporting `ok` for source this daemon
  // could not read is the one thing the analyser layer must never do.
  const unreadable: number[] = [];

  set.operations.forEach((operation, operationIndex) => {
    if (!carriesLuauSource(operation)) return;
    const path = operation.path as string;
    if (operation.op === 'writeScript') {
      sources.push({ operationIndex, path, source: operation.source });
      return;
    }
    const raw =
      operation.op === 'setProperty'
        ? sourceTextOf(operation.value)
        : operation.op === 'createInstance'
          ? sourceTextOf(operation.properties.Source)
          : null;
    if (raw === null) unreadable.push(operationIndex);
    else sources.push({ operationIndex, path, source: raw });
  });

  return { sources, unreadable };
}

/**
 * The Luau verdict, computed here, inside the trust boundary.
 *
 * `@forgebridge/luau-analysis` reads every source the set carries — layer 2 of
 * THREAT-MODEL T2. The producer's own opinion of its source never reaches this
 * function: `#validate` overwrites whatever `validation` arrived with what this
 * returns, because a model that can mark its own Luau clean has defeated the
 * layer (ADR-012, PROTOCOL invariant 4).
 *
 * The analyser's own invariant carries through unchanged: a source it could not
 * read comes back `fail`, never `ok`. `#approve` refuses a `fail`, so a
 * ChangeSet whose Luau does not parse — or which reaches for `loadstring` —
 * cannot be approved at all.
 */
/**
 * The protocol's own bounds on `Validation.luau`, restated because they are
 * literals in `packages/protocol/src/changeset.ts` rather than entries in
 * `LIMITS`, and this file may not edit that package. A verdict that broke either
 * one would be refused by `ChangeSet` on the next parse — which is to say the
 * ChangeSet would become unreadable *because* the analyser found too much wrong
 * with it. `packages/daemon/test/server.test.ts` pins both against the real
 * schema so a change to the contract fails here rather than in production.
 */
const MAX_FINDING_MESSAGE = 2000;
const MAX_FINDINGS = 1000;

function clipMessage(message: string): string {
  return message.length <= MAX_FINDING_MESSAGE ? message : `${message.slice(0, MAX_FINDING_MESSAGE - 1)}…`;
}

function luauVerdict(set: ChangeSet, allowedHttpHosts: readonly string[]): Validation['luau'] {
  const { sources, unreadable } = luauSourcesOf(set);

  // Nothing to analyse is not the same as unanalysed: a set of property writes
  // and moves passes every Luau rule there could be, vacuously.
  if (sources.length === 0 && unreadable.length === 0) return { status: 'ok', findings: [] };

  const findings: Finding[] = [];
  let status: Validation['luau']['status'] = 'ok';
  const worsen = (next: Validation['luau']['status']): void => {
    if (next === 'fail' || (next === 'warn' && status === 'ok')) status = next;
  };

  for (const { operationIndex, path, source } of sources) {
    const result = analyse(source, { allowedHttpHosts, operationIndex });
    // The analyser attributes a finding to an operation index; the instance path
    // is what a human reads in the diff, so it is prefixed onto the message here
    // rather than pushed into the protocol's `Finding` as a field it does not have.
    findings.push(
      ...result.findings.map((finding) => ({ ...finding, message: clipMessage(`${path}: ${finding.message}`) })),
    );
    worsen(result.status);
  }

  for (const operationIndex of unreadable) {
    findings.push({
      severity: 'error',
      rule: 'luau/source-not-readable',
      message:
        'This operation writes the Source property with a value that is not a string, so there was no Luau ' +
        'to analyse and this ChangeSet has not been statically checked. Write scripts with a writeScript ' +
        'operation, or set Source to a String value.',
      operationIndex,
    });
    worsen('fail');
  }

  if (findings.length > MAX_FINDINGS) {
    // Dropping the overflow silently would make a very bad ChangeSet look like
    // a slightly bad one. The status is already `fail` or `warn` and does not
    // move; what is lost is detail, and the last slot says so.
    const kept = findings.slice(0, MAX_FINDINGS - 1);
    kept.push({
      severity: 'warning',
      rule: 'luau/findings-truncated',
      message:
        `This ChangeSet produced ${findings.length} findings, past the ${MAX_FINDINGS} the protocol carries. ` +
        `The first ${MAX_FINDINGS - 1} are above; the rest were dropped. The verdict is unchanged — propose ` +
        'something smaller and read the whole list.',
    });
    return { status, findings: kept };
  }

  return { status, findings };
}

function countOps(operations: readonly Operation[], kind: Operation['op']): number {
  return operations.filter((operation) => operation.op === kind).length;
}

function describeOperation(operation: Operation): string {
  switch (operation.op) {
    case 'createInstance':
      return `create ${operation.className} at ${operation.path}`;
    case 'setProperty':
      return `set ${operation.path}.${operation.property}`;
    case 'writeScript':
      return `write ${operation.scriptType} ${operation.path} (${Buffer.byteLength(operation.source, 'utf8')} bytes)`;
    case 'moveInstance':
      return `move ${operation.path} to ${operation.to}`;
    case 'deleteInstance':
      return `delete ${operation.path}`;
  }
}

function afterValueOf(operation: Operation): { after?: string } {
  if (operation.op === 'writeScript') return { after: operation.source };
  if (operation.op === 'setProperty') return { after: JSON.stringify(operation.value) };
  return {};
}
