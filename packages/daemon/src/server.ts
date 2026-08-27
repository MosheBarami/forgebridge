import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import {
  ApplyResult,
  ChangeSet,
  ForgeBridgeError,
  JournalEntry,
  LIMITS,
  Link,
  PLUGIN_VERSION_HEADER,
  PRIVACY_POSTURE,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  RollbackRequest,
  RollbackResult,
  deletionCount,
  isCompatible,
  isDestructive,
  isFullyApplied,
  pathsOf,
  withinSizeLimit,
  type ChangeSetStatus,
  type Operation,
  carriesLuauSource,
} from '@forgebridge/protocol';
import {
  CircuitBreaker,
  DEFAULT_PIPELINE_REQUIREMENTS,
  DENY_ALL_POLICY,
  ModelRouter,
  assertTransition,
  checkPolicy,
  executeRun,
  isTerminal,
  type AnalysisReport,
  type AnalysisRequest,
  type LuauAnalysisPort,
  type ModelCandidate,
  type ProjectPolicy,
  type RunEvent,
} from '@forgebridge/core';
import { analyse, normaliseHost } from '@forgebridge/luau-analysis';
import type { Finding, ProtocolError, Run, Validation } from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER, assertProducerToken, mintProducerToken } from './auth.js';
import { NONCE_ORIGIN, canonicalJson, openEnvelope, sealEnvelope, verifyRequestMac } from './envelope.js';
import {
  LOOPBACK_HOST,
  corsHeadersFor,
  errorPayload,
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
import {
  InMemoryDaemonStore,
  type DaemonStore,
  type DeliveryRecord,
  type JournalRecord,
  type RunRecord,
} from './store.js';
import {
  journalStateOf,
  planRollbackFor,
  recordJournalEntry,
  recordRollbackResult,
  rollbackDeliveryFor,
  type JournalEntryStore,
  type RollbackDeps,
} from './rollback.js';
import {
  EVENT_STREAM_KEEP_ALIVE_MS,
  RunEventLogs,
  beginEventStream,
  endEventStream,
  writeEventFrame,
  writeKeepAlive,
  type RunEventLog,
} from './runs.js';
import {
  ApproveRequest,
  ChangeSetDiff,
  DeliveryPayload,
  JournalStateResponse,
  ModelsSnapshot,
  OutputBatch,
  PairRequest,
  RunResponse,
  StartRunRequest,
  type ModelOrdering,
  type ModelsPort,
  type OperationDiff,
  type OutputMessage,
  type RunModelClient,
  type SkippedModel,
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

/**
 * A run request is a prompt and a handful of scalars. The prompt is capped by
 * `Run.prompt` at 50,000 characters, so this is that with room for the rest and
 * for multi-byte text — not a number anyone should have to tune.
 */
const RUN_REQUEST_BYTES = 256 * 1024;

/**
 * How long `GET /v1/runs/:id/events` will follow a run before closing.
 *
 * A ceiling rather than a timeout: a run that has genuinely been generating for
 * ten minutes is a run whose watcher should reconnect with `?since=` rather
 * than hold a socket indefinitely, and a run that leaked without closing its
 * log would otherwise hold one forever.
 */
const RUN_STREAM_MAX_MS = 10 * 60_000;

/**
 * Domain separator for the content digest, in the style of the envelope MACs.
 * A digest is not a MAC, but it is compared against a value that arrived from
 * outside, so it gets the same treatment: a hash of one kind of thing must
 * never be a valid hash of another.
 */
const CONTENT_DIGEST_DOMAIN = 'forgebridge/v1/changeset-content';

/**
 * A stable fingerprint of the work a ChangeSet would do.
 *
 * This is what binds an approval to what was reviewed. `#approve` requires the
 * approver to echo the digest the diff showed them, and refuses when it does
 * not match what is stored now — so an approval is a statement about *this
 * content*, not about an identifier that content might later be swapped under
 * (ADR-012: approval is the safety mechanism, and approving a diff you were not
 * shown is approving nothing).
 *
 * Two decisions worth stating:
 *
 * - It hashes `operations` and nothing else, because operations are the whole
 *   of what reaches the place. The other fields either cannot change what is
 *   written (`summary`) or are computed by this daemon rather than supplied
 *   (`validation`, `status`), and folding a daemon-computed timestamp in would
 *   make the digest churn between the diff and the approval for no gain.
 * - It canonicalises with `canonicalJson`, the same function the envelope MAC
 *   uses, rather than `JSON.stringify`. A second canonicalisation is a second
 *   thing that can disagree with the first, and key order out of `JSON.stringify`
 *   follows insertion order — so a re-parsed ChangeSet could digest differently
 *   from the one that was parsed a moment earlier.
 *
 * It is a fingerprint, not a capability: anyone holding the operations can
 * compute it, and it grants nothing. Its job is to bind, not to authorise —
 * `#assertProducer` is what authorises.
 */
export function changeSetContentDigest(operations: readonly Operation[]): string {
  const hash = createHash('sha256');
  hash.update(CONTENT_DIGEST_DOMAIN, 'utf8');
  hash.update('\n');
  hash.update(canonicalJson(operations), 'utf8');
  return hash.digest('base64');
}

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
   * What `POST /v1/runs` calls to reach a language model.
   *
   * Absent by default, and absent means the run route answers
   * `provider_unconfigured` rather than half-working: a daemon with no adapter
   * wired in cannot produce a ChangeSet from a prompt, and every other route on
   * this surface goes on working without one. `bin.ts` wires the OpenRouter
   * adapter when the process starts; a self-hoster pointing at a different
   * provider supplies their own implementation here and changes nothing else
   * (ADR-005).
   */
  modelClient?: RunModelClient;
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
  readonly #modelClient: RunModelClient | undefined;
  /**
   * One router, and therefore one circuit breaker, for the life of the process.
   *
   * A breaker per run would learn nothing: the whole point of suppressing a
   * provider that has failed three times is that the *next* run does not pay to
   * rediscover it (ADR-008). Sharing it is also what makes `skipped` on a run
   * response mean something — a candidate suppressed here was suppressed
   * because of what happened on an earlier run, which the caller can see.
   */
  readonly #router: ModelRouter;
  readonly #runLogs = new RunEventLogs();
  readonly #analyser: LuauAnalysisPort;
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

  /**
   * The inverse operations, on the same store as everything else (M40).
   *
   * A getter rather than a field: `this.store` is assigned in the constructor
   * body, and a field initialiser would run before that and capture undefined.
   *
   * They used to live in a separate in-memory store, which meant a daemon
   * handed a persistent `DaemonStore` still lost its inverses on restart — a
   * durable daemon whose one non-durable record was the only route back from a
   * destructive apply. `DaemonStore` carries them now, so a caller that passes
   * `@forgebridge/storage-sqlite` gets a rollback that outlives the process.
   */
  get #journals(): JournalEntryStore {
    return this.store;
  }

  constructor(options: DaemonOptions = {}) {
    this.store = options.store ?? new InMemoryDaemonStore({ now: options.now ?? Date.now });
    this.defaultProjectId = options.projectId ?? randomUUID();
    this.#models = options.models ?? unconfiguredModels;
    this.#modelClient = options.modelClient;
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
    this.#router = new ModelRouter({ breaker: new CircuitBreaker({}, this.#now), clock: this.#now });
    this.#analyser = luauAnalyserFor(this.#allowedHttpHosts);
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
    // Followers of a run are held open exactly like a poll is, and for the same
    // reason a poll is released here: a close() that waited them out would take
    // as long as the longest run anybody is watching.
    this.#runLogs.closeAll();
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

    if (resource === 'journal') {
      const id = rest[0];
      // A read of one apply and any reversal of it. Producer surface: it names
      // what was changed in the user's place and carries the consumer's own
      // report of what a rollback did or did not undo.
      if (id && rest.length === 1 && method === 'GET') {
        this.#assertProducer(req);
        return this.#journalState(res, id, cors);
      }
      if (id && rest[1] === 'rollback' && rest.length === 2 && method === 'POST') {
        this.#assertProducer(req);
        return this.#rollback(req, res, id, cors);
      }
      // The two below are consumer surface, enveloped and MAC'd like
      // `apply-result`, and for a stronger reason than symmetry. The first
      // writes the record that decides whether a destructive apply is
      // survivable; the second is the only thing that can stamp a journal
      // reversed. A process that can reach loopback must be able to write
      // neither.
      if (id && rest[1] === 'entry' && rest.length === 2 && method === 'POST') {
        return this.#journalEntry(req, res, id, cors);
      }
      if (id && rest[1] === 'rollback-result' && rest.length === 2 && method === 'POST') {
        return this.#rollbackResult(req, res, id, cors);
      }
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

    // Producer surface, all three. A run reads the project's policy, spends the
    // operator's model credit, and serves back the script source a model wrote
    // into their place — there is nothing public about any of it.
    if (resource === 'runs') {
      if (rest.length === 0 && method === 'POST') {
        this.#assertProducer(req);
        return this.#startRun(req, res, cors);
      }
      const id = rest[0];
      if (id && rest.length === 1 && method === 'GET') {
        this.#assertProducer(req);
        return this.#runStatus(res, id, cors);
      }
      if (id && rest[1] === 'events' && rest.length === 2 && method === 'GET') {
        this.#assertProducer(req);
        return this.#runEvents(req, res, url, id, cors);
      }
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

    // A ChangeSet id is write-once, for the same reason `#applyResult` refuses a
    // reused `journalId`: the id is what every later step names the work by, so
    // a second set arriving under an existing id is not an update, it is a
    // different proposal wearing the reviewed one's name. Overwriting let a
    // producer swap the contents of a proposal *after* a human read its diff and
    // *before* the approval landed — and reset an already-approved, applying or
    // applied set back to `validated` while it was at it.
    //
    // Refused rather than minted here: the daemon could assign the id itself and
    // sidestep the collision, but then a producer that retried a lost response
    // would silently create a second proposal, the id it recorded would name
    // nothing, and the swap would become quiet instead of loud. The cost of
    // refusing is that a producer retrying a request whose response it never saw
    // must mint a fresh id — a retry that reads as a duplicate proposal, which is
    // what it is.
    if (await this.store.getChangeSet(changeSet.id)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `changeset ${changeSet.id} already exists and cannot be replaced`,
        'Mint a fresh ChangeSet id; an id that has been proposed once names that proposal for good.',
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
    // the diff to learn that its set is already dead. The content digest rides
    // along too — not as a shortcut past the diff, since approval requires the
    // digest of what was *reviewed* and the reviewer reads it there, but so a
    // producer can tell at a glance that the daemon stored the operations it
    // sent and not something else.
    //
    // TODO(M31): this response has no schema, so `scripts/generate-schemas.ts`
    // transcribes it by hand into `HANDLER_SHAPED_SCHEMAS` — and that
    // transcription does not list `contentDigest`, because a hand copy is a copy
    // that goes stale. The generator's own TODO(M31) asks for the same thing
    // from the other side: give this handler a `SubmitChangeSetResponse` in
    // `wire.ts` and delete the transcription. Both halves have to land together
    // — the transcription currently *wins* over a wire schema of the same name,
    // so adding one here alone would change nothing.
    writeJson(
      res,
      201,
      {
        changeSetId: stored.id,
        status,
        baseVersion: stored.baseVersion,
        contentDigest: changeSetContentDigest(stored.operations),
        validation,
      },
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
        // Every operation that installs Luau, counted with the same predicate
        // the analyser gate uses to decide what it must read. Counting only
        // `writeScript` reported `scripts: 0` for a ChangeSet whose Script
        // arrived as a `createInstance` carrying `Source` — a set the analyser
        // was checking and the summary said contained no code at all. The two
        // numbers cannot drift now because there is only one definition of
        // "carries Luau".
        scripts: changeSet.operations.filter(carriesLuauSource).length,
        moves: countOps(changeSet.operations, 'moveInstance'),
        deletes: countOps(changeSet.operations, 'deleteInstance'),
      },
      // What an approver must echo back on approve. Rendering it here is what
      // makes the approval a statement about the content on this page.
      contentDigest: changeSetContentDigest(changeSet.operations),
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

    // First, before any other question about this set: is it the set that was
    // approved? Everything below decides whether *this content* may be applied,
    // and none of it means anything if the content is not what the approver
    // read. The approver echoes the digest `GET /v1/changesets/:id/diff` showed
    // them; a mismatch means the operations moved between the reading and the
    // yes, and the yes does not cover them.
    //
    // This is the property that survives: ids are write-once now, so nothing on
    // the wire can move the content today — but "no code path currently does
    // this" is not a guarantee, and an approval bound to an identifier alone
    // would be re-broken by the first code path that learned to update a set in
    // place. Bound to content, such a path is a refusal rather than a bypass.
    //
    // A plain comparison, not `timingSafeEqual`: the digest is derived from
    // content the caller already holds, so there is no secret here to leak
    // through timing. It authorises nothing — `#assertProducer` above did that.
    const digest = changeSetContentDigest(changeSet.operations);
    if (body.contentDigest !== digest) {
      throw new ForgeBridgeError(
        'invalid_request',
        'contentDigest does not match the operations stored for this changeset',
        'Re-read GET /v1/changesets/:id/diff and approve the digest it reports. The set you reviewed is not the set on this id.',
      );
    }

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

  /**
   * `POST /v1/runs` — a prompt in, a proposed ChangeSet out, nothing applied.
   *
   * The whole of the work is `executeRun` in `@forgebridge/core`; this handler
   * is the transport around it. What it adds is the four things the core cannot
   * know: which project, which tree version, which models this daemon can
   * actually reach, and what verdict this daemon is willing to stand behind.
   *
   * It never approves and it cannot. The set it stores lands in `validated`,
   * approval is `POST /v1/changesets/:id/approve` and requires the content
   * digest of a diff someone read, and there is no argument to this route that
   * reaches either (ADR-012). The separation is the same one that makes an
   * external agent safe to permit at all, and a run route that "just applied
   * it" would remove the reason the rest of this file is careful.
   *
   * **A failed run is a successful request.** A run that tried five models and
   * got five rate limits answers 201 with `failure` set and every attempt
   * listed, not 429 — because a `ProtocolError` body has nowhere to put the
   * attempt list, and the attempt list is the entire point (ADR-008). Only the
   * things that stopped a run from *starting* — no model client, no candidate,
   * a stale base version — are HTTP errors, and each is refused before a token
   * is spent.
   */
  async #startRun(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const body = parseOrThrow(StartRunRequest, await readJson(req, RUN_REQUEST_BYTES), 'run request');
    const projectId = body.projectId ?? this.defaultProjectId;

    if (body.policy === 'pinned' && !body.pinnedModel) {
      // The router refuses this too, but it refuses it as a failed run with an
      // empty attempt list. Refusing here costs the caller nothing and reads as
      // what it is: a request that does not say what it wants.
      throw new ForgeBridgeError(
        'invalid_request',
        "routing policy 'pinned' requires pinnedModel",
        'Name the model to pin, or choose another policy — pinned disables fallback entirely.',
      );
    }

    const client = await this.#requireModelClient();
    const candidates = await this.#candidatesFor(client);

    const baseVersion = await this.store.getProjectVersion(projectId);
    if (body.baseVersion !== undefined && body.baseVersion !== baseVersion) {
      // Checked before the model is called rather than after. A run built on a
      // version the producer no longer holds is a run whose output will be
      // refused at submit, and paying for the tokens first helps nobody.
      throw new ForgeBridgeError(
        'stale_base',
        `this run was requested against version ${body.baseVersion}; the project is at ${baseVersion}`,
        `Re-read the project version and resubmit with ${baseVersion}, or omit baseVersion to build against it.`,
      );
    }

    const policy = (await this.store.getProjectPolicy(projectId)) ?? this.#defaultPolicy;
    const runId = randomUUID();
    const startedAt = new Date(this.#now()).toISOString();

    const queued: RunRecord = {
      run: {
        id: runId,
        projectId,
        prompt: body.prompt,
        stage: 'queued',
        status: 'running',
        attempts: [],
        changeSetIds: [],
        ...(body.producer ? { producer: body.producer } : {}),
        startedAt,
        finishedAt: null,
      },
      plan: { steps: [] },
      changeSetId: null,
      contentDigest: null,
      validation: null,
      skipped: [],
      ordering: null,
      failure: null,
      updatedAt: startedAt,
    };
    // Written before the first model is called so `GET /v1/runs/:id` answers
    // *during* the run, not only after it. A run only addressable once it is
    // over is a run nobody can watch.
    await this.store.putRun(queued);

    const log = this.#runLogs.open(runId);
    const controller = new AbortController();
    // A caller that hung up is a caller who is not reading the answer. Carrying
    // on would spend their credit on output nobody will see; the run is
    // recorded as `cancelled`, which is a different fact from `failed`.
    const onHangUp = (): void => controller.abort();
    res.once('close', onHangUp);

    const streaming = body.stream;
    const stopStreaming = streaming
      ? this.#streamRun(res, cors, log, await this.#runResponse(queued))
      : (): void => {};

    try {
      const result = await executeRun(
        {
          runId,
          projectId,
          prompt: body.prompt,
          baseVersion,
          policy,
          routingPolicy: body.policy,
          ...(body.pinnedModel ? { pinnedModelId: body.pinnedModel } : {}),
          // The core's own answer to what this pipeline needs of a model: tool
          // calling and structured output. Restating it looser here would be
          // this file overruling the engine about the engine.
          requirements: DEFAULT_PIPELINE_REQUIREMENTS,
          candidates,
          allowedHttpHosts: this.#allowedHttpHosts,
          ...(body.producer ? { producer: body.producer } : {}),
          ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
          signal: controller.signal,
          // No `treeSummary`. This daemon holds a version number, not a tree —
          // the same gap `ChangeSetDiff.treeAware: false` records — so the model
          // is told the paths it may write to and nothing about what is already
          // there. TODO(M09): when a consumer reports a tree snapshot, render it
          // here rather than letting a model guess at a place it cannot see.
        },
        {
          models: client,
          router: this.#router,
          analyser: this.#analyser,
          clock: this.#now,
          newId: () => randomUUID(),
          onEvent: (event) => {
            log.publish(event);
          },
        },
      );

      const settled = await this.#settleRun(result, projectId, log);
      const response = await this.#runResponse(settled);

      // A caller that hung up mid-run has already had the run recorded for it;
      // writing to a socket it closed is how one abandoned request becomes an
      // unhandled error event on a daemon that was otherwise fine.
      if (res.writableEnded || res.destroyed) return;

      if (streaming) {
        writeEventFrame(res, 'run', response);
        endEventStream(res);
      } else {
        writeJson(res, 201, response, cors);
      }
    } catch (error) {
      if (!streaming) throw error;
      // The headers went out with the first frame, so there is no status left
      // to set. The stream says what happened in the same vocabulary a JSON
      // caller would have received and then closes.
      if (!(error instanceof ForgeBridgeError)) {
        this.#logger.error('run failed after the stream opened', { runId, error: String(error) });
      }
      writeEventFrame(res, 'error', errorPayload(error));
      endEventStream(res);
    } finally {
      res.removeListener('close', onHangUp);
      stopStreaming();
      log.close();
    }
  }

  /**
   * Open the streamed form of a run and follow it.
   *
   * The first frame is the whole run record, so a client that reconnects or
   * arrives late is never reading events without knowing what they are about.
   * Every subsequent frame is one `RunEvent` from the core, under its own event
   * name and carrying its index as the SSE id — which is the cursor
   * `GET /v1/runs/:id/events?since=` takes.
   */
  #streamRun(
    res: ServerResponse,
    cors: Record<string, string>,
    log: RunEventLog,
    initial: RunResponse,
  ): () => void {
    beginEventStream(res, cors);
    writeEventFrame(res, 'run', initial);

    const unsubscribe = log.subscribe((recorded) => {
      writeEventFrame(res, recorded.event.type, recorded.event, recorded.index);
    });
    const keepAlive = setInterval(() => writeKeepAlive(res), EVENT_STREAM_KEEP_ALIVE_MS);
    keepAlive.unref?.();

    return () => {
      unsubscribe();
      clearInterval(keepAlive);
    };
  }

  /**
   * Store what the run produced, and compute the verdict this daemon stands
   * behind.
   *
   * The core has already computed one, through the analyser port, and this
   * recomputes it. Not out of distrust: the port hands the analyser one source
   * per `writeScript` operation, and a `createInstance` carrying a `Source`
   * property installs Luau by another route — `luauVerdict` reads both, and a
   * set whose only script arrived that way would otherwise reach an approver
   * marked `validated` with nothing having read it (THREAT-MODEL T2 layer 2).
   *
   * The two verdicts cannot contradict each other, only differ in reach: they
   * run the same analyser over the same allowlist, and this one sees a superset
   * of the sources. So this is never weaker than the core's, and a watcher that
   * saw both sees the same verdict twice whenever a set carries no `Source`
   * property — told apart by `computedBy`, which names which of the two
   * computed it.
   */
  async #settleRun(
    result: Awaited<ReturnType<typeof executeRun>>,
    projectId: string,
    log: RunEventLog,
  ): Promise<RunRecord> {
    const at = new Date(this.#now()).toISOString();
    let run: Run = result.run;
    let failure: ProtocolError | null = result.failure ?? null;
    let changeSetId: string | null = null;
    let contentDigest: string | null = null;
    let validation: Validation | null = null;

    const set = result.changeSet;
    if (set) {
      const verdict = await this.#validate(set);
      const current = await this.store.getProjectVersion(projectId);
      const stale = current !== set.baseVersion;
      const rejected = verdict.luau.status === 'fail' || verdict.policy.status === 'fail';

      // `validated` only when the run actually reached `awaiting-approval`.
      // The core hands back the offending set on some of its own failures too —
      // a set past the protocol's size limit is the clearest — and storing one
      // of those as `validated` would leave a ChangeSet that failed its run
      // sitting in the one status an approver is allowed to act on.
      //
      // `stale` and `rejected` are both statuses `#approve` refuses, so the set
      // is stored either way: a producer that wants to know what was generated
      // and why it will not be applied reads the diff, which is the only place
      // the findings are legible.
      const stored: ChangeSet = {
        ...set,
        validation: verdict,
        status: stale ? 'stale' : rejected || failure ? 'rejected' : 'validated',
      };
      await this.store.putChangeSet(stored);

      // The core appends the id once it has a verdict of its own; on the paths
      // where it failed before that, the run would otherwise name no set while
      // this record names one.
      if (!run.changeSetIds.includes(stored.id)) {
        run = { ...run, changeSetIds: [...run.changeSetIds, stored.id] };
      }

      changeSetId = stored.id;
      contentDigest = changeSetContentDigest(stored.operations);
      validation = verdict;
      log.publish({ type: 'validation', at, changeSetId: stored.id, validation: verdict });

      if (stale) {
        failure = {
          code: 'stale_base',
          message: `the project moved to version ${current} while this run was generating against ${set.baseVersion}`,
          remedy: 'Start a fresh run; a ChangeSet is never rebased for the producer.',
        };
      } else if (rejected) {
        failure = {
          code: verdict.policy.status === 'fail' ? 'policy_violation' : 'invalid_request',
          message:
            verdict.policy.status === 'fail'
              ? `this ChangeSet is outside the project's allowed paths: ${verdict.policy.violations[0] ?? ''}`.slice(0, 500)
              : 'static analysis rejected the generated Luau',
          remedy: `Read the findings on GET /v1/changesets/${stored.id}/diff.`,
        };
      }

      if (failure && !isTerminal(run.stage)) {
        // `awaiting-approval → failed` is a legal edge, and taking it through
        // the state machine rather than around it is what keeps the stage on a
        // stored run something a reader can trust.
        assertTransition(run.stage, 'failed');
        run = { ...run, stage: 'failed', status: 'failed', finishedAt: at };
        log.publish({ type: 'failed', at, failure });
      }
    }

    const record: RunRecord = {
      run,
      plan: { steps: [...result.plan.steps] },
      changeSetId,
      contentDigest,
      validation,
      skipped: result.skipped.map((entry) => ({ ...entry })) as SkippedModel[],
      ordering: (result.ordering ?? null) as ModelOrdering | null,
      failure,
      updatedAt: at,
    };
    await this.store.putRun(record);

    this.#logger.info('run finished', {
      runId: run.id,
      stage: run.stage,
      status: run.status,
      attempts: run.attempts.length,
      skipped: record.skipped.length,
      changeSetId,
    });

    return record;
  }

  async #runStatus(res: ServerResponse, runId: string, cors: Record<string, string>): Promise<void> {
    writeJson(res, 200, await this.#runResponse(await this.#requireRun(runId)), cors);
  }

  /**
   * `GET /v1/runs/:id/events` — replay, then follow.
   *
   * A run's event log is in memory and capped, so this can only ever serve what
   * is still resident. It says so with a `closed` frame rather than ending
   * quietly, because a stream that stops without a word is indistinguishable
   * from a stream that has more to say. Whatever the log has lost, the `run`
   * frame it opens with carries the attempt list in full — that part is the
   * record, and it is never the stream's to lose.
   */
  async #runEvents(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    runId: string,
    cors: Record<string, string>,
  ): Promise<void> {
    const record = await this.#requireRun(runId);
    const since = parseCursor(url.searchParams.get('since'));
    const response = await this.#runResponse(record);
    const log = this.#runLogs.get(runId);

    beginEventStream(res, cors);
    writeEventFrame(res, 'run', response);

    if (!log) {
      writeEventFrame(res, 'closed', {
        reason:
          'this run has no resident event log — it finished long enough ago to be evicted, or the daemon ' +
          'restarted. The run record above is complete; the event stream is not replayable.',
      });
      endEventStream(res);
      return;
    }

    for (const recorded of log.since(since)) {
      writeEventFrame(res, recorded.event.type, recorded.event, recorded.index);
    }
    if (log.truncated) {
      writeEventFrame(res, 'truncated', {
        reason: `this run produced more than the log retains; the oldest events were dropped. Nothing in the run record was lost.`,
      });
    }

    if (log.closed) {
      writeEventFrame(res, 'run', await this.#runResponse(await this.#requireRun(runId)));
      endEventStream(res);
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearInterval(keepAlive);
        clearTimeout(ceiling);
        unsubscribe();
        res.removeListener('close', finish);
        req.removeListener('close', finish);
        resolve();
      };

      const unsubscribe = log.subscribe(
        (recorded) => writeEventFrame(res, recorded.event.type, recorded.event, recorded.index),
        finish,
      );
      const keepAlive = setInterval(() => writeKeepAlive(res), EVENT_STREAM_KEEP_ALIVE_MS);
      keepAlive.unref?.();
      const ceiling = setTimeout(() => {
        writeEventFrame(res, 'closed', {
          reason: `this stream reached its ${RUN_STREAM_MAX_MS / 60_000} minute ceiling; reconnect with ?since= to continue.`,
        });
        finish();
      }, RUN_STREAM_MAX_MS);
      ceiling.unref?.();

      res.once('close', finish);
      req.once('close', finish);
      // The run may have ended between the replay above and this subscription;
      // `close()` only tells the followers it had at the time.
      if (log.closed) finish();
    });

    if (!res.writableEnded && !res.destroyed) {
      writeEventFrame(res, 'run', await this.#runResponse(await this.#requireRun(runId)));
      endEventStream(res);
    }
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

    // The plan is built — and can refuse — before anything is dispatched or any
    // timestamp is moved. Every way a journal can be unreplayable is a reason to
    // send nothing at all: a reversal that discovers one halfway through has
    // already half-restored the tree, which is the state ADR-012 is least able
    // to help with. `planRollbackFor` also refuses when this daemon holds no
    // inverses for the apply, and says so in the words that send a user to the
    // right place — that Studio session may still be able to undo in-session,
    // and nothing else can.
    const plan = await planRollbackFor(this.#rollbackDeps(), journalId);

    const link = await this.#requirePairedLink(journal.projectId);

    // Stamped before the delivery is enqueued, not after, and the ordering is
    // load-bearing rather than tidy. `recordRollbackResult` refuses a reversal
    // nobody asked for — that is what stops a consumer undoing approved work on
    // its own initiative — and it decides that by reading this timestamp. A
    // consumer that polled, replayed and reported between the enqueue and this
    // write would have its legitimate result refused, and the inverses it just
    // spent would be recorded nowhere. The opposite failure is survivable: a
    // journal marked requested whose enqueue then threw is one the user can
    // simply ask to roll back again.
    await this.store.patchJournal(journal.id, {
      rollbackRequestedAt: new Date(this.#now()).toISOString(),
    });

    // Dispatched, not done — and now that is a statement about timing rather
    // than about the protocol. The inverses travel with the delivery, the
    // consumer replays them, and it reports back to
    // `POST /v1/journal/:id/rollback-result`. Until that report arrives the
    // honest word is still "requested", which is what `GET /v1/journal/:id`
    // answers and what the CLI waits on.
    const delivery = await this.#enqueue(
      link.id,
      rollbackDeliveryFor(plan, {
        expectedVersion: current,
        ...(body.reason ? { reason: body.reason } : {}),
      }),
    );

    this.#logger.info('rollback dispatched', {
      journalId: journal.id,
      changeSetId: journal.changeSetId,
      steps: plan.steps.length,
      restoresToVersion: plan.restoresToVersion,
    });

    writeJson(
      res,
      202,
      {
        journalId: journal.id,
        changeSetId: journal.changeSetId,
        status: 'dispatched',
        nonce: delivery.nonce,
        steps: plan.steps.length,
      },
      cors,
    );
  }

  /**
   * `POST /v1/journal/:id/entry` — the consumer uploading the inverses it
   * captured before it applied anything.
   *
   * This is the half of M11 that needed no protocol addition: `JournalEntry` was
   * always in the frozen contract and simply had no route, so the inverses stayed
   * in the Studio session that captured them and a closed Studio was the end of
   * the road back from an apply.
   *
   * Every check lives in `recordJournalEntry`, which compares the entry against
   * the apply this daemon actually witnessed rather than believing it.
   */
  async #journalEntry(
    req: IncomingMessage,
    res: ServerResponse,
    journalId: string,
    cors: Record<string, string>,
  ): Promise<void> {
    const { link, payload } = await this.#openFromConsumer(req, LIMITS.MAX_CHANGESET_BYTES);
    const entry = parseOrThrow(JournalEntry, payload, 'journal entry');
    if (entry.id !== journalId) {
      throw new ForgeBridgeError('invalid_request', 'journal entry does not match the journal in the path');
    }

    const ack = await recordJournalEntry(this.#rollbackDeps(), link, entry);
    this.#logger.info('journal inverses recorded', ack);
    writeJson(res, 200, ack, cors);
  }

  /**
   * `POST /v1/journal/:id/rollback-result` — the consumer reporting a reversal.
   *
   * The report the CLI, the A2A connector and the Python SDK were all saying
   * "dispatched" for want of. A partial reversal is reported as `partial` and
   * leaves `rolledBackAt` null, because the entry is then neither reversed nor
   * intact and a timestamp saying otherwise would be the journal's own record
   * lying about the one thing it exists to be right about.
   */
  async #rollbackResult(
    req: IncomingMessage,
    res: ServerResponse,
    journalId: string,
    cors: Record<string, string>,
  ): Promise<void> {
    const { link, payload } = await this.#openFromConsumer(req, LIMITS.MAX_CHANGESET_BYTES);
    const result = parseOrThrow(RollbackResult, payload, 'rollback result');
    if (result.journalId !== journalId) {
      throw new ForgeBridgeError('invalid_request', 'rollback result does not match the journal in the path');
    }

    const ack = await recordRollbackResult(this.#rollbackDeps(), link, result);
    await this.store.patchLink(link.id, {
      lastSeenAt: result.rolledBackAt,
      pluginVersion: result.pluginVersion,
    });

    this.#logger.info('rollback result recorded', {
      journalId: ack.journalId,
      status: ack.status,
      reversed: result.outcomes.filter((outcome) => outcome.ok).length,
      of: result.outcomes.length,
      newVersion: ack.version,
    });

    // `state` rather than `status`: it is the same vocabulary `GET
    // /v1/journal/:id` answers in, and two words for one fact is how three
    // surfaces came to describe a rollback three different ways.
    const record = await this.store.getJournal(result.journalId);
    writeJson(
      res,
      200,
      {
        journalId: ack.journalId,
        changeSetId: ack.changeSetId,
        state: record ? journalStateOf(record, result) : ack.status,
        version: ack.version,
      },
      cors,
    );
  }

  /** `GET /v1/journal/:id` — what happened to one apply, and to any reversal. */
  async #journalState(res: ServerResponse, journalId: string, cors: Record<string, string>): Promise<void> {
    const record = await this.store.getJournal(journalId);
    if (!record) throw new ForgeBridgeError('not_found', 'no such journal entry');

    const entry = await this.#journals.getJournalEntry(journalId);
    const result = await this.#journals.getRollbackResult(journalId);

    writeJson(
      res,
      200,
      JournalStateResponse.parse({
        journalId: record.id,
        changeSetId: record.changeSetId,
        projectId: record.projectId,
        summary: record.summary,
        state: journalStateOf(record, result),
        versionBefore: record.versionBefore,
        versionAfter: record.versionAfter,
        appliedAt: record.appliedAt,
        rollbackRequestedAt: record.rollbackRequestedAt,
        rolledBackAt: record.rolledBackAt,
        // Null, not 0, when the inverses never reached this daemon. The two are
        // different facts: 0 is an apply with nothing to undo, null is an apply
        // whose only route back stayed inside a Studio session.
        inverses: entry ? entry.inverses.length : null,
        result,
      }),
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

  async #requireRun(runId: string): Promise<RunRecord> {
    const record = await this.store.getRun(runId);
    if (!record) {
      throw new ForgeBridgeError(
        'not_found',
        'no such run',
        'Run records are held in memory: they do not survive a daemon restart, and the oldest are evicted.',
      );
    }
    return record;
  }

  /**
   * One shape for a run, wherever it is read from.
   *
   * `changeSetStatus` is looked up rather than stored on the record, so a run
   * whose set has since been approved and applied reports that instead of the
   * `validated` it was left in. The alternative — copying the status onto the
   * run when the run ended — is two records of one fact, and the stale one
   * would be the one saying nothing has been applied.
   */
  async #runResponse(record: RunRecord): Promise<RunResponse> {
    const set = record.changeSetId ? await this.store.getChangeSet(record.changeSetId) : null;
    // Parsed on the way out, like the models snapshot is: a response this
    // daemon cannot validate against its own wire schema is one a strict client
    // is entitled to reject, and finding that out here beats finding it out
    // there.
    return RunResponse.parse({
      run: record.run,
      plan: record.plan,
      changeSetId: record.changeSetId,
      changeSetStatus: set?.status ?? null,
      contentDigest: record.contentDigest,
      validation: record.validation,
      skipped: record.skipped,
      ordering: record.ordering,
      failure: record.failure,
    });
  }

  /**
   * The client a run will call, or a refusal that says what is missing.
   *
   * Both questions are asked before the run starts. A daemon with no adapter
   * and a daemon with an adapter and no credential are different problems with
   * different fixes, and neither is a thing to discover one candidate at a time
   * — attempting six models with no credential would write six identical
   * `provider-error` attempts into the log and open the circuit breaker on a
   * provider that was never down.
   */
  async #requireModelClient(): Promise<RunModelClient> {
    const client = this.#modelClient;
    if (!client) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        'this daemon has no model client wired in, so it cannot turn a prompt into a ChangeSet',
        'Every other route works without one. Start the daemon through its own bin, which wires the ' +
          'OpenRouter adapter, or pass modelClient to createDaemon().',
      );
    }
    if (!(await client.configured())) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        `no credential is configured for ${client.providers.join(', ') || 'any provider'}`,
        'Export OPENROUTER_API_KEY before starting the daemon, or add the item to your OS keychain. ' +
          'The daemon reads it once per request and never stores, logs or returns it.',
      );
    }
    return client;
  }

  /**
   * The candidates this run may actually try.
   *
   * Filtered by what the wired client can reach, because a candidate served by
   * a provider this daemon has no adapter for would be attempted, fail, and be
   * recorded as that provider failing — a `ModelAttempt` describing something
   * that never happened, in the one list ADR-008 requires to be true.
   */
  async #candidatesFor(client: RunModelClient): Promise<ModelCandidate[]> {
    if (!this.#models.candidates) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        'this daemon has no model registry wired in, so it has no candidates to route between',
        'Pass a models port whose candidates() returns the models this daemon may try (ADR-007).',
      );
    }
    const offered = await this.#models.candidates();
    const reachable = offered.filter((candidate) => client.providers.includes(candidate.provider));
    if (reachable.length === 0) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        `the registry offers ${offered.length} model(s), none of them served by ${client.providers.join(', ')}`,
        'Sync the catalog, or wire an adapter for a provider the registry knows about.',
      );
    }
    return reachable;
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

  /** The three things `rollback.ts` needs, assembled in one place. */
  #rollbackDeps(): RollbackDeps {
    return { store: this.store, journals: this.#journals, now: this.#now };
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

/**
 * The analyser the core reaches through its port while a run is generating.
 *
 * The same `@forgebridge/luau-analysis` this file already runs at submit, and
 * in this process rather than out of one: `SandboxPort` exists so that an
 * out-of-process analyser can be installed (M13), and until one is, the daemon
 * runs the parser over model-authored text inside its own trust boundary
 * exactly as `#validate` does. The port's `budget` is therefore not enforced
 * here — there is no process to kill — and the analyser's own token ceiling is
 * what bounds a hostile input instead.
 *
 * Findings carry the instance path and not an operation index. The port hands
 * over one source per script with no index attached, and stamping a source's
 * position in the list onto `operationIndex` would attribute a finding to
 * whichever operation happened to be at that position — a number pointing at
 * the wrong line of a diff is worse than no number. `luauVerdict`, which is
 * what the stored verdict is computed from, reads the real indices.
 */
function luauAnalyserFor(allowedHttpHosts: readonly string[]): LuauAnalysisPort {
  return {
    async analyse(request: AnalysisRequest): Promise<AnalysisReport> {
      const findings: Finding[] = [];
      let status: AnalysisReport['status'] = 'ok';
      for (const source of request.sources) {
        const result = analyse(source.source, { allowedHttpHosts });
        findings.push(
          ...result.findings.map((finding) => ({
            ...finding,
            message: clipMessage(`${source.path}: ${finding.message}`),
          })),
        );
        if (result.status === 'fail' || (result.status === 'warn' && status === 'ok')) status = result.status;
      }
      return { status, findings, truncated: false };
    },
  };
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
    case 'createInstance': {
      // Not a bare "create Script at <path>". A `createInstance` carrying a
      // `Source` property installs Luau exactly as `writeScript` does, and a
      // one-line summary that does not say so is the line a reviewer skims
      // before approving code they never saw.
      const source = sourceTextOf(operation.properties.Source);
      // A readable Source is reported as source, so it is not also counted as
      // one of the properties; an unreadable one is, because that is where the
      // diff shows it.
      const others = Object.keys(operation.properties).length - (source !== null ? 1 : 0);
      const parts: string[] = [];
      if (source !== null) parts.push(`${Buffer.byteLength(source, 'utf8')} bytes of Source`);
      if (others > 0) parts.push(`${others} propert${others === 1 ? 'y' : 'ies'}`);
      const head = `create ${operation.className} at ${operation.path}`;
      return parts.length > 0 ? `${head} with ${parts.join(' and ')}` : head;
    }
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

/**
 * The value an operation writes, rendered for a human.
 *
 * `createInstance` used to render as nothing at all: its property bag was
 * dropped, so a Script created with `Source: print("pwned")` in that bag showed
 * in the diff as one line naming a class and a path, with no code and no
 * property on the page. ADR-012 makes approval the safety mechanism; a diff
 * that omits the Luau being installed turns that mechanism into a formality.
 *
 * So `Source` comes back in `after`, as raw Luau, exactly the way `writeScript`
 * renders it — a reviewer should not have to know which of two operations
 * installed a script to read it — and everything else in the bag comes back in
 * `properties`. A `Source` that is not a string has no source text to show, so
 * it stays in `properties` as its JSON, where it is at least visible;
 * `luau/source-not-readable` has already failed the verdict for it.
 */
function afterValueOf(operation: Operation): { after?: string; properties?: Record<string, string> } {
  switch (operation.op) {
    case 'writeScript':
      return { after: operation.source };
    case 'setProperty':
      return { after: JSON.stringify(operation.value) };
    case 'createInstance': {
      const properties: Record<string, string> = {};
      let after: string | undefined;
      for (const [name, value] of Object.entries(operation.properties)) {
        const source = name === 'Source' ? sourceTextOf(value) : null;
        if (source !== null) after = source;
        else properties[name] = JSON.stringify(value);
      }
      return {
        ...(after !== undefined ? { after } : {}),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      };
    }
    case 'moveInstance':
    case 'deleteInstance':
      // Both are fully described by their paths, which the diff already carries.
      return {};
  }
}
