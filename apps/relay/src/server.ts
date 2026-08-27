import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
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
  JournalEntry,
  RollbackRequest,
  RollbackResult,
  deletionCount,
  isCompatible,
  isFullyApplied,
  type ChangeSetStatus,
  type Operation,
  type Validation,
} from '@forgebridge/protocol';
import {
  NO_PROXY,
  clientAddress,
  corsHeadersFor,
  headerValue,
  originIsAllowed,
  parseOrThrow,
  readJson,
  tlsEvidence,
  writeEmpty,
  writeError,
  writeJson,
  type ProxyTrust,
} from './http.js';
import { NONCE_ORIGIN, canonicalJson, openEnvelope, sealEnvelope, verifyRequestMac } from './envelope.js';
import { RelayPairingRegistry } from './pairing.js';
import {
  InMemoryRelayStore,
  type DeliveryRecord,
  type JournalRecord,
  type RelaySession,
  type RelayStore,
} from './store.js';
import {
  ApproveRequest,
  ApproveResponse,
  ChangeSetDiff,
  DeliveryPayload,
  JournalEntryAck,
  JournalStateResponse,
  LinkStatusResponse,
  ModelsSnapshot,
  OutputBatch,
  OutputResponse,
  PairRequest,
  PairResponse,
  RelayRunRequest,
  RelaySessionResponse,
  RollbackResponse,
  RollbackResultAck,
  SubmitChangeSetResponse,
  type OutputMessage,
} from './wire.js';
import { CONTROL_SESSIONS_PATH, RELAY_ROUTES, type RelayRoute } from './routes.js';
import {
  journalStateOf,
  planRollbackFor,
  recordJournalEntry,
  recordRollbackResult,
  rollbackDeliveryFor,
  type RollbackDeps,
} from './rollback.js';
import { diffCounts, operationDiffs } from './diff.js';
import { beginEventStream, endEventStream, writeEventFrame, writeKeepAlive, EVENT_STREAM_KEEP_ALIVE_MS } from './sse.js';
import { InMemoryAbuseStore, type AbuseStore } from './abuse/store.js';
import { DEFAULT_RELAY_LIMITS, assertCeilingsBelowProtocol, type RelayLimits } from './abuse/limits.js';
import { RateLimiter, RelayRateLimitError, rateLimitHeaders } from './abuse/ratelimit.js';
import { BudgetBreaker } from './abuse/budget.js';
import { SponsoredRunGate, type AsnLookupPort, type UserVerificationPort } from './abuse/sponsored.js';
import type { RunDispatchPort } from './dispatch.js';

/**
 * The ForgeBridge cloud relay — the `relay-tls` transport of ADR-004.
 *
 * ── What this process is ─────────────────────────────────────────────────────
 *
 * A pipe. It moves ChangeSets from a producer to a paired Studio session and
 * moves ApplyResults and console output back. It holds no provider API keys, it
 * calls no model, and it computes no validation. Everything it refuses, it
 * refuses on facts it can check for itself: a MAC, a nonce, a content digest, a
 * size, a counter.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 *
 * It is not private. The transport is `relay-tls`, and `PRIVACY_POSTURE`
 * renders that to the user as *"Relay — the relay operator can read your
 * changes"*, which is served verbatim from `GET /v1/link` and `GET /v1/health`.
 * Payloads are authenticated, not encrypted (ADR-014 v1). The transport that
 * keeps changes on the user's machine is the local daemon, and the README says
 * so before it says anything else.
 *
 * ── The three things a shared host must do that a loopback one need not ──────
 *
 * 1. **Say whose request this is.** The daemon's caller is the person who
 *    started it. Here, `#session` resolves a producer token to a session and
 *    every store read is scoped by it — see the header of `store.ts`.
 * 2. **Know the real client address.** Every per-address limit is worth exactly
 *    what the address is worth, so `clientAddress` refuses to read forwarded
 *    headers unless the operator declared how many proxies to believe.
 * 3. **Refuse when it cannot tell.** TLS evidence, ASN attribution, a missing
 *    validation verdict: each is a question this process can fail to answer,
 *    and each answers with a refusal rather than with a pass.
 */

export const DEFAULT_RELAY_PORT = 8080;

/** How long a poll is held open, mirroring the daemon so the plugin sees one behaviour. */
export const POLL_TIMEOUT_MS = 25_000;

/** A ceiling on how long the relay will follow a run's event stream. */
const RUN_STREAM_MAX_MS = 10 * 60_000;

const LINK_HEADER = 'X-ForgeBridge-Link';
const MAC_HEADER = 'X-ForgeBridge-Mac';
const PRODUCER_TOKEN_HEADER = 'X-ForgeBridge-Token';
const OUTPUT_READ_LIMIT = 200;

/** Sessions expire so a relay does not accumulate every link ever made. */
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;

/**
 * Domain separator for the content digest, copied from the daemon along with
 * the digest itself.
 *
 * It has to be the same string. The digest is what an approver echoes back from
 * a diff (ADR-012), and the producers that carry it — `packages/mcp`,
 * `packages/a2a`, the web app — must not have to know which transport rendered
 * the page they read. `test/drift.test.ts` compares this implementation with
 * `changeSetContentDigest` from `@forgebridge/daemon` over the same operations.
 */
const CONTENT_DIGEST_DOMAIN = 'forgebridge/v1/changeset-content';

/** A stable fingerprint of the work a ChangeSet would do. Binds an approval to content. */
export function changeSetContentDigest(operations: readonly Operation[]): string {
  const hash = createHash('sha256');
  hash.update(CONTENT_DIGEST_DOMAIN, 'utf8');
  hash.update('\n');
  hash.update(canonicalJson(operations), 'utf8');
  return hash.digest('base64');
}

const PRODUCER_TOKEN_BYTES = 32;
const PRODUCER_TOKEN_DIGEST_DOMAIN = 'forgebridge/v1/relay-producer-token';

/**
 * The digest a producer token is stored and looked up under.
 *
 * The relay never holds the token. It cannot: a shared host has to answer "which
 * of ten thousand sessions is this?", and the only ways to do that are a linear
 * scan of secrets — which is both slow and a timing channel — or a lookup keyed
 * on a one-way function of the secret, which is this. A store that is read is a
 * store that can be dumped, and a dump of digests is not a dump of tokens.
 */
export function producerTokenDigest(token: string): string {
  return createHash('sha256')
    .update(PRODUCER_TOKEN_DIGEST_DOMAIN, 'utf8')
    .update(token, 'utf8')
    .digest('base64');
}

export interface RelayLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: RelayLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface RelayOptions {
  port?: number;
  /**
   * The interface to bind. `0.0.0.0` by default, unlike the daemon, which binds
   * loopback and has no option to widen it — a relay nobody can reach is not a
   * relay. Everything the daemon gets for free from being unreachable is paid
   * for explicitly here.
   */
  host?: string;
  store?: RelayStore;
  abuseStore?: AbuseStore;
  limits?: RelayLimits;
  /** How many proxies sit in front. `0` means forwarded headers are ignored. */
  proxy?: ProxyTrust;
  /**
   * Whether the relay refuses a request it cannot prove arrived over TLS.
   *
   * `true` by default. `relay-tls` is the transport's name and the string the
   * UI renders, so serving without TLS while calling it that is the class of
   * claim ADR-014 exists to forbid. Set `false` only for local development, and
   * `GET /v1/health` reports it when you do.
   */
  requireTls?: boolean;
  allowedOrigins?: readonly string[];
  /**
   * The secret `POST /control/sessions` requires, when the operator wants
   * provisioning closed.
   *
   * Absent means open, and open is defensible: minting a session costs the
   * relay a UUID and a pairing code, it is rate limited per address, and the
   * things that cost money are gated further down. An operator who would rather
   * only their own web app mint sessions sets this.
   */
  controlToken?: string;
  verification?: UserVerificationPort;
  asn?: AsnLookupPort;
  runDispatch?: RunDispatchPort;
  logger?: RelayLogger;
  pollTimeoutMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
}

interface Waiter {
  linkId: string;
  since: number;
  settle: (delivery: DeliveryRecord | null) => void;
}

/** What `#authorise` resolved a request to, before a handler runs. */
interface RequestContext {
  route: RelayRoute;
  params: string[];
  url: URL;
  address: string;
  cors: Record<string, string>;
  session: RelaySession | null;
  link: Link | null;
  sessionKey: Buffer | null;
}

export class ForgeBridgeRelay {
  readonly store: RelayStore;
  readonly limits: RelayLimits;

  readonly #server: Server;
  readonly #abuse: AbuseStore;
  readonly #rate: RateLimiter;
  readonly #budget: BudgetBreaker;
  readonly #sponsored: SponsoredRunGate;
  readonly #pairing: RelayPairingRegistry;
  readonly #dispatch: RunDispatchPort | undefined;
  readonly #controlToken: string | undefined;
  readonly #allowedOrigins: readonly string[];
  readonly #proxy: ProxyTrust;
  readonly #requireTls: boolean;
  readonly #logger: RelayLogger;
  readonly #pollTimeoutMs: number;
  readonly #sessionTtlMs: number;
  readonly #now: () => number;
  readonly #port: number;
  readonly #host: string;
  readonly #startedAtMs: number;
  readonly #waiters = new Set<Waiter>();

  /**
   * Session keys, in memory and nowhere else — not in the store, not on disk,
   * not in a log.
   *
   * The daemon makes this trade to keep a key out of a file a persistent
   * adapter wrote. The relay makes it for a sharper reason: a session key is
   * what authenticates one user's Studio session, and a relay that persisted
   * every user's key would be holding, in one place, the material to forge a
   * delivery to any of them. The cost is that a relay restart forces every link
   * to re-pair, which is ten seconds per user and is said out loud in the
   * refusal they get.
   */
  readonly #keyring = new Map<string, Buffer>();

  constructor(options: RelayOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.store = options.store ?? new InMemoryRelayStore({ now: this.#now });
    this.limits = options.limits ?? DEFAULT_RELAY_LIMITS;
    assertCeilingsBelowProtocol(this.limits);
    this.#abuse = options.abuseStore ?? new InMemoryAbuseStore();
    this.#rate = new RateLimiter({ store: this.#abuse, limits: this.limits, now: this.#now });
    this.#budget = new BudgetBreaker({
      store: this.#abuse,
      dailyBudget: this.limits.sponsored.dailyBudget,
      now: this.#now,
    });
    this.#sponsored = new SponsoredRunGate({
      store: this.#abuse,
      limits: this.limits,
      budget: this.#budget,
      verification: options.verification,
      asn: options.asn,
      now: this.#now,
    });
    this.#pairing = new RelayPairingRegistry({ now: this.#now });
    this.#dispatch = options.runDispatch;
    this.#controlToken = options.controlToken;
    this.#allowedOrigins = options.allowedOrigins ?? [];
    this.#proxy = options.proxy ?? NO_PROXY;
    this.#requireTls = options.requireTls ?? true;
    this.#logger = options.logger ?? silentLogger;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#port = options.port ?? DEFAULT_RELAY_PORT;
    this.#host = options.host ?? '0.0.0.0';
    this.#startedAtMs = this.#now();
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once('error', onError);
      this.#server.listen({ host: this.#host, port: this.#port }, () => {
        this.#server.removeListener('error', onError);
        resolve();
      });
    });
    const port = this.address?.port ?? this.#port;
    return { host: this.#host, port, url: `http://${this.#host}:${port}` };
  }

  async close(): Promise<void> {
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
    return `http://127.0.0.1:${this.address?.port ?? this.#port}`;
  }

  get heldPolls(): number {
    return this.#waiters.size;
  }

  /**
   * Mint a session directly, for a caller that already holds this process.
   *
   * The HTTP route does the same thing behind a rate limit and an optional
   * control token; this is what `bin.ts` and the tests use, and what an
   * embedding host would call instead of talking to itself over a socket.
   */
  async createSession(): Promise<{
    session: RelaySession;
    producerToken: string;
    pairingCode: string;
    pairingExpiresAt: string;
  }> {
    const token = randomBytes(PRODUCER_TOKEN_BYTES).toString('base64url');
    const at = this.#now();
    const session: RelaySession = {
      id: randomUUID(),
      projectId: randomUUID(),
      producerTokenDigest: producerTokenDigest(token),
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.#sessionTtlMs).toISOString(),
      lastSeenAt: new Date(at).toISOString(),
    };
    await this.store.putSession(session);
    const issued = this.#pairing.issue(session.id);
    return {
      session,
      producerToken: token,
      pairingCode: issued.code,
      pairingExpiresAt: issued.expiresAt,
    };
  }

  // ── request pipeline ───────────────────────────────────────────────────────

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = headerValue(req, 'origin');
    const cors = corsHeadersFor(origin, this.#allowedOrigins);
    try {
      this.#assertProtocolCompatible(req);

      if (!originIsAllowed(origin, this.#allowedOrigins)) {
        throw new ForgeBridgeError(
          'invalid_request',
          'this origin is not permitted to call the relay',
          'Ask the relay operator to allow your origin. A relay never answers `*` for a route that ' +
            'carries a bearer token.',
        );
      }

      if (req.method === 'OPTIONS') {
        writeEmpty(res, 204, cors);
        return;
      }

      this.#assertTls(req);

      const url = new URL(req.url ?? '/', 'http://relay.invalid');
      const address = clientAddress(req, this.#proxy);

      if (url.pathname === CONTROL_SESSIONS_PATH) {
        if (req.method !== 'POST') throw new ForgeBridgeError('not_found', 'unknown path');
        await this.#rate.enforce('ip', address, 'session');
        return await this.#createSessionRoute(req, res, cors);
      }

      const matched = matchRoute(url.pathname, req.method ?? 'GET');
      if (!matched) throw new ForgeBridgeError('not_found', 'unknown path');

      // Per-address first, before any work and before any credential is read: a
      // caller who has spent their budget must not be able to make the relay
      // hash a token or read a body in order to be told so.
      await this.#rate.enforce('ip', address, matched.route.limitClass);

      const context = await this.#authorise(req, matched.route, matched.params, url, address, cors);
      await this.#dispatchRoute(req, res, context);
    } catch (error) {
      if (error instanceof RelayRateLimitError) {
        writeError(res, error, { ...cors, ...rateLimitHeaders(error.resetAtMs, this.#now()) });
        return;
      }
      if (!(error instanceof ForgeBridgeError)) {
        this.#logger.error('unhandled relay error', { error: String(error) });
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
        `this relay speaks protocol ${PROTOCOL_VERSION}; the caller declared ${declared}`,
        'Update the plugin or the relay so both are on the same protocol major.',
      );
    }
  }

  /**
   * Refuse a request the relay cannot prove arrived over TLS.
   *
   * `unknown` is refused, not waved through. That is the whole rule this
   * repository keeps re-learning: a check that answers "I could not tell" the
   * same way it answers "this is fine" is a check that is not running. Here the
   * unknown case is concrete — an operator who put the relay behind a proxy but
   * left `--proxy-hops` at zero — and the failure is a relay serving plaintext
   * under a transport name that promises otherwise.
   */
  #assertTls(req: IncomingMessage): void {
    if (!this.#requireTls) return;
    const evidence = tlsEvidence(req, this.#proxy);
    if (evidence === 'tls') return;
    throw new ForgeBridgeError(
      'invalid_request',
      evidence === 'plaintext'
        ? 'this relay serves the relay-tls transport and this request did not arrive over TLS'
        : 'this relay cannot confirm this request arrived over TLS, so it will not serve it',
      'Terminate TLS in front of the relay and start it with --proxy-hops <n> so X-Forwarded-Proto is ' +
        'believed. --insecure-http disables this check for local development only.',
    );
  }

  /**
   * Resolve the credential a route requires, and refuse when it is absent.
   *
   * The route table says which credential each route takes, and this is the
   * only place that reads it. The daemon marks the same distinction with a
   * comment at its routing table — "adding a route makes the question 'which
   * side of the boundary is this on?' unavoidable" — and on a shared host the
   * question has to be unavoidable in the type system rather than in a comment,
   * so a route with no `auth` value does not compile.
   */
  async #authorise(
    req: IncomingMessage,
    route: RelayRoute,
    params: string[],
    url: URL,
    address: string,
    cors: Record<string, string>,
  ): Promise<RequestContext> {
    const base: RequestContext = {
      route,
      params,
      url,
      address,
      cors,
      session: null,
      link: null,
      sessionKey: null,
    };

    if (route.auth === 'public') return base;

    if (route.auth === 'producer') {
      const session = await this.#session(req);
      await this.#rate.enforce('link', session.id, route.limitClass);
      await this.store.touchSession(session.id, new Date(this.#now()).toISOString());
      return { ...base, session };
    }

    // Consumer. The link header names which session key to check; the MAC or
    // the envelope is what proves the caller holds it. Reading the link first
    // and the proof second is the only order that works, and it means an
    // unauthenticated caller can learn that a link id exists — which is why the
    // per-address limit above ran before we got here.
    const linkId = headerValue(req, LINK_HEADER);
    if (!linkId) throw new ForgeBridgeError('link_unauthenticated', `${LINK_HEADER} is required`);
    const found = await this.store.getLink(linkId);
    if (!found || found.link.state !== 'paired') {
      throw new ForgeBridgeError('link_unauthenticated', 'unknown or revoked link');
    }
    const sessionKey = this.#keyring.get(linkId);
    if (!sessionKey) {
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'this link has no session key on this relay',
        'Re-pair: session keys are held in memory only and do not survive a relay restart or a move to ' +
          'another relay process.',
      );
    }
    await this.#rate.enforce('link', linkId, route.limitClass);
    return { ...base, session: found.session, link: found.link, sessionKey };
  }

  /** Resolve a producer token to its session. */
  async #session(req: IncomingMessage): Promise<RelaySession> {
    const token = headerValue(req, PRODUCER_TOKEN_HEADER);
    const session = token ? await this.store.findSessionByTokenDigest(producerTokenDigest(token)) : null;
    if (!session) {
      // One refusal for "no token", "wrong token" and "expired session". A
      // relay that distinguished them would tell a caller holding a guess
      // whether it had found a real session.
      throw new ForgeBridgeError(
        'link_unauthenticated',
        `${PRODUCER_TOKEN_HEADER} is missing, unknown, or belongs to a session that has expired`,
        `Mint a session at POST ${CONTROL_SESSIONS_PATH} and send its producer token on this header.`,
      );
    }
    return session;
  }

  async #dispatchRoute(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    switch (context.route.handler) {
      case 'health':
        return await this.#health(res, context);
      case 'linkStatus':
        return await this.#linkStatus(res, context);
      case 'pair':
        return await this.#pair(req, res, context);
      case 'poll':
        return await this.#poll(req, res, context);
      case 'submitChangeSet':
        return await this.#submitChangeSet(req, res, context);
      case 'diff':
        return await this.#diff(res, context);
      case 'approve':
        return await this.#approve(req, res, context);
      case 'applyResult':
        return await this.#applyResult(req, res, context);
      case 'rollback':
        return await this.#rollback(req, res, context);
      case 'journalState':
        return await this.#journalState(res, context);
      case 'journalEntry':
        return await this.#journalEntry(req, res, context);
      case 'rollbackResult':
        return await this.#rollbackResult(req, res, context);
      case 'output':
        return await this.#output(req, res, context);
      case 'readOutput':
        return await this.#readOutput(res, context);
      case 'models':
        return await this.#models(res, context);
      case 'startRun':
        return await this.#startRun(req, res, context);
      case 'runStatus':
        return await this.#runStatus(res, context);
      case 'runEvents':
        return await this.#runEvents(req, res, context);
      default:
        // Unreachable while `RELAY_ROUTES` and this switch agree, and a
        // refusal rather than a fallthrough if they ever do not.
        throw new ForgeBridgeError('not_found', 'unknown path');
    }
  }

  // ── endpoints ──────────────────────────────────────────────────────────────

  async #health(res: ServerResponse, context: RequestContext): Promise<void> {
    const budget = await this.#budget.state();
    writeJson(
      res,
      200,
      {
        ok: true,
        service: 'forgebridge-relay',
        version: RELAY_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        transport: 'relay-tls',
        // Served here as well as on `/v1/link` because a health check is what a
        // status page renders, and a status page for this transport that does
        // not say who can read the traffic is a status page that misleads.
        privacyPosture: PRIVACY_POSTURE['relay-tls'],
        boundTo: `${this.#host}:${this.address?.port ?? this.#port}`,
        uptimeSeconds: Math.max(0, (this.#now() - this.#startedAtMs) / 1000),
        tls: {
          required: this.#requireTls,
          proxyHops: this.#proxy.hops,
        },
        // The published number, published (ADR-010). It is here before anyone
        // hits it, not only in the refusal after they do.
        sponsored: {
          available: this.#sponsored.available && this.#dispatch !== undefined,
          dailyBudget: budget.dailyBudget,
          spentToday: budget.spentToday,
          day: budget.day,
          perUserPerDay: this.limits.sponsored.perUserPerDay,
          perIpPerDay: this.limits.sponsored.perIpPerDay,
          perAsnPerDay: this.limits.sponsored.perAsnPerDay,
        },
        ceilings: {
          changeSetBytes: this.limits.changeSet.maxBytes,
          operations: this.limits.changeSet.maxOperations,
          protocolChangeSetBytes: LIMITS.MAX_CHANGESET_BYTES,
          protocolOperations: LIMITS.MAX_OPERATIONS,
        },
        // The relay computes no verdicts, and a caller should be able to learn
        // that from the transport rather than from a document.
        validation: {
          computedHere: false,
          note: 'The relay carries the verdict a producer attached and refuses a ChangeSet that has none.',
        },
      },
      context.cors,
    );
  }

  async #linkStatus(res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    writeJson(
      res,
      200,
      LinkStatusResponse.parse({
        transport: 'relay-tls',
        // Verbatim from the protocol. Not a padlock, not a paraphrase, and not
        // a claim this app is allowed to soften (ADR-014).
        privacyPosture: PRIVACY_POSTURE['relay-tls'],
        protocolVersion: PROTOCOL_VERSION,
        defaultProjectId: session.projectId,
        links: await this.store.listLinks(session.id),
        pairing: this.#pairing.statusFor(session.id),
      }),
      context.cors,
    );
  }

  async #createSessionRoute(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    if (this.#controlToken !== undefined) {
      const provided = headerValue(req, PRODUCER_TOKEN_HEADER);
      if (provided !== this.#controlToken) {
        throw new ForgeBridgeError(
          'link_unauthenticated',
          'this relay only mints sessions for callers holding its control token',
          `Send the control token on ${PRODUCER_TOKEN_HEADER}.`,
        );
      }
    }
    const minted = await this.createSession();
    this.#logger.info('session minted', { sessionId: minted.session.id });
    writeJson(
      res,
      201,
      RelaySessionResponse.parse({
        sessionId: minted.session.id,
        projectId: minted.session.projectId,
        // Returned once, here, and never served again — the relay holds only a
        // digest of it. This is the moment that corresponds to the daemon
        // printing its producer token at startup.
        producerToken: minted.producerToken,
        pairingCode: minted.pairingCode,
        pairingExpiresAt: minted.pairingExpiresAt,
        expiresAt: minted.session.expiresAt,
        transport: 'relay-tls',
        privacyPosture: PRIVACY_POSTURE['relay-tls'],
      }),
      cors,
    );
  }

  async #pair(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const body = parseOrThrow(PairRequest, await readJson(req, this.limits.maxRequestBytes.pair), 'pair request');
    const linkId = randomUUID();
    const redeemed = this.#pairing.redeem(body.pairingCode, linkId);

    const session = await this.store.getSession(redeemed.sessionId);
    if (!session) {
      // The code was live and its session is not. Answered with the same
      // refusal a bad code gets, for the same reason.
      throw new ForgeBridgeError(
        'link_unauthenticated',
        'that pairing code is not redeemable',
        'Ask the web app for a fresh one.',
      );
    }

    // A project a caller names is only theirs to name if it is the session's.
    // Accepting an arbitrary `projectId` here would let a plugin bind a link to
    // another tenant's project id — which the store would then happily scope by.
    if (body.projectId !== undefined && body.projectId !== session.projectId) {
      throw new ForgeBridgeError(
        'invalid_request',
        'this pairing code belongs to a different project',
        'Omit projectId, or send the one the session was minted with.',
      );
    }

    const link = Link.parse({
      id: linkId,
      projectId: session.projectId,
      transport: 'relay-tls',
      state: 'paired',
      sessionKeyId: redeemed.sessionKeyId,
      pluginVersion: body.pluginVersion ?? headerValue(req, PLUGIN_VERSION_HEADER) ?? null,
      studioVersion: body.studioVersion ?? null,
      placeId: body.placeId ?? null,
      lastSeenAt: new Date(this.#now()).toISOString(),
      createdAt: new Date(this.#now()).toISOString(),
    });

    await this.store.putLink(session.id, link);
    this.#keyring.set(linkId, redeemed.sessionKey);
    this.#logger.info('link paired', { linkId, sessionId: session.id, sessionKeyId: redeemed.sessionKeyId });

    writeJson(
      res,
      200,
      PairResponse.parse({
        linkId,
        sessionKeyId: redeemed.sessionKeyId,
        projectId: link.projectId,
        transport: 'relay-tls',
        privacyPosture: PRIVACY_POSTURE['relay-tls'],
        sessionSalt: redeemed.salt.toString('base64'),
        since: NONCE_ORIGIN,
        protocolVersion: PROTOCOL_VERSION,
      }),
      context.cors,
    );
  }

  async #poll(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const link = this.#requireLink(context);
    const sessionKey = context.sessionKey as Buffer;
    const since = parseCursor(context.url.searchParams.get('since'));

    const mac = headerValue(req, MAC_HEADER);
    if (!mac || !verifyRequestMac(sessionKey, [link.id, 'GET', '/v1/link/poll', String(since)], mac)) {
      throw new ForgeBridgeError('link_unauthenticated', 'request MAC did not verify');
    }

    await this.store.patchLink(link.id, { lastSeenAt: new Date(this.#now()).toISOString() });

    const immediate = await this.store.nextDelivery(link.id, since);
    if (immediate) return await this.#deliver(res, sessionKey, immediate, context.cors);

    const delivery = await this.#wait(req, res, link.id, since);
    if (res.writableEnded || res.destroyed) return;
    if (!delivery) {
      writeEmpty(res, 204, context.cors);
      return;
    }
    await this.#deliver(res, sessionKey, delivery, context.cors);
  }

  #wait(req: IncomingMessage, res: ServerResponse, linkId: string, since: number): Promise<DeliveryRecord | null> {
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
      const owner = await this.store.getLink(delivery.linkId);
      if (owner) {
        await this.store.setChangeSetStatus(owner.session.id, delivery.payload.changeSet.id, 'applying');
      }
    }
    const envelope = sealEnvelope(sessionKey, {
      linkId: delivery.linkId,
      nonce: delivery.nonce,
      payload: delivery.payload,
    });
    writeJson(res, 200, envelope, cors);
  }

  async #submitChangeSet(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);

    // The relay ceiling, not the protocol's. It is applied to the *body*, before
    // the JSON is parsed, so an oversized set is refused on its bytes rather
    // than after this process has allocated a parse tree for it.
    const raw = await readJson(req, this.limits.changeSet.maxBytes);
    const changeSet = parseOrThrow(ChangeSet, raw, 'changeset');

    if (changeSet.operations.length > this.limits.changeSet.maxOperations) {
      throw new ForgeBridgeError(
        'too_large',
        `this relay accepts ${this.limits.changeSet.maxOperations} operations per ChangeSet; this one has ` +
          `${changeSet.operations.length}`,
        `The protocol's own bound is ${LIMITS.MAX_OPERATIONS} and the local daemon enforces only that. ` +
          'Split the work into staged ChangeSets, or run the daemon.',
      );
    }

    // Ids are write-once, and write-once RELAY-WIDE rather than per session.
    // Per-session would let one tenant mint a set under an id another tenant is
    // already using, and every later step names the work by that id.
    if (await this.store.changeSetIdTaken(changeSet.id)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `changeset ${changeSet.id} already exists and cannot be replaced`,
        'Mint a fresh ChangeSet id; an id that has been proposed once names that proposal for good.',
      );
    }

    if (changeSet.projectId !== session.projectId) {
      throw new ForgeBridgeError(
        'invalid_request',
        'this changeset names a project that does not belong to this session',
        'Submit against the projectId the session was minted with.',
      );
    }

    const current = await this.store.getProjectVersion(session.id, changeSet.projectId);
    if (changeSet.baseVersion !== current) {
      throw new ForgeBridgeError(
        'stale_base',
        `changeset was built against version ${changeSet.baseVersion}; the project is at ${current}`,
        `Rebuild against version ${current} and resubmit.`,
      );
    }

    // ── the one place the relay's honesty about validation is enforced ───────
    //
    // The daemon overwrites whatever verdict arrived with one it computed
    // itself, because a producer-supplied `validation: { policy: ok }` is a
    // model clearing its own work (PROTOCOL invariant 4). The relay cannot
    // compute one: `@forgebridge/core` and the Luau analyser are exactly the
    // "brain" this transport does not carry.
    //
    // That leaves two options and only one of them is defensible. Accepting a
    // set with no verdict and letting it be approved would make the relay a way
    // to route around validation entirely — pick the transport, skip the
    // analyser — which is a bypass, not a limitation. So the relay refuses.
    // A ChangeSet arrives here already validated by whoever ran the core, or it
    // does not arrive.
    //
    // What the relay adds is provenance, not endorsement: `computedBy` is
    // carried through untouched and `validationWitnessedHere: false` rides on
    // the diff, so a reviewer is told the verdict on their page is one the
    // relay is relaying. Note what this is NOT: it is not a claim that the
    // verdict is genuine. The relay cannot check that, says so, and the private
    // transport is the one where the verdict is computed by the same process
    // that serves it.
    if (!changeSet.validation) {
      throw new ForgeBridgeError(
        'invalid_request',
        'this relay computes no validation, and will not carry a ChangeSet that has none',
        'Validate with @forgebridge/core before submitting, or use the local daemon, which computes the ' +
          'verdict itself inside its own trust boundary.',
      );
    }

    const validation: Validation = changeSet.validation;
    const failed = validation.luau.status === 'fail' || validation.policy.status === 'fail';
    // A producer-supplied `status` is not authoritative here any more than on
    // the daemon: a set arriving pre-marked `approved` is a model clearing its
    // own work. It is discarded and replaced.
    //
    // `validated` even when the verdict says fail, matching the daemon exactly,
    // and it is the protocol's own reading rather than a convenience: the status
    // enum defines `validated` as "validation computed, awaiting approval" and
    // `rejected` as "a human or a policy refused it". At submit nothing has
    // refused anything yet. The refusal happens at `#approve`, which answers
    // `policy_violation` — and a set that came out of the same input with a
    // different status on this transport than on the daemon would be exactly
    // the divergence ADR-004 forbids.
    const status: ChangeSetStatus = 'validated';
    const stored: ChangeSet = { ...changeSet, validation, status };
    await this.store.putChangeSet(session.id, stored);

    if (failed) {
      this.#logger.warn('changeset arrived carrying a failed verdict', {
        changeSetId: stored.id,
        sessionId: session.id,
      });
    }

    writeJson(
      res,
      201,
      SubmitChangeSetResponse.parse({
        changeSetId: stored.id,
        status,
        baseVersion: stored.baseVersion,
        contentDigest: changeSetContentDigest(stored.operations),
        validation,
        validationWitnessedHere: false,
      }),
      context.cors,
    );
  }

  async #diff(res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const changeSet = await this.#requireChangeSet(session, context.params[0] ?? '');
    const currentVersion = await this.store.getProjectVersion(session.id, changeSet.projectId);

    const diff = ChangeSetDiff.parse({
      changeSetId: changeSet.id,
      projectId: changeSet.projectId,
      summary: changeSet.summary,
      status: changeSet.status,
      baseVersion: changeSet.baseVersion,
      currentVersion,
      stale: changeSet.baseVersion !== currentVersion,
      counts: diffCounts(changeSet),
      contentDigest: changeSetContentDigest(changeSet.operations),
      operations: operationDiffs(changeSet),
      ...(changeSet.validation ? { validation: changeSet.validation } : {}),
      treeAware: false,
      validationWitnessedHere: false,
    });

    writeJson(res, 200, diff, context.cors);
  }

  async #approve(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const body = parseOrThrow(
      ApproveRequest,
      await readJson(req, this.limits.maxRequestBytes.approve),
      'approve request',
    );
    const changeSet = await this.#requireChangeSet(session, context.params[0] ?? '');

    // First, before any other question: is this the set that was reviewed? A
    // plain comparison rather than a constant-time one, because the digest is
    // derived from content the caller already holds and authorises nothing —
    // the producer token did that.
    const digest = changeSetContentDigest(changeSet.operations);
    if (body.contentDigest !== digest) {
      throw new ForgeBridgeError(
        'invalid_request',
        'contentDigest does not match the operations stored for this changeset',
        'Re-read GET /v1/changesets/:id/diff and approve the digest it reports. The set you reviewed is ' +
          'not the set on this id.',
      );
    }

    if (changeSet.status !== 'proposed' && changeSet.status !== 'validated') {
      throw new ForgeBridgeError(
        'invalid_request',
        `a changeset in status "${changeSet.status}" cannot be approved`,
        'Submit a fresh ChangeSet.',
      );
    }

    // Unreachable from the wire — `#submitChangeSet` refuses a set with no
    // verdict — and kept because the store is a seam.
    if (!changeSet.validation) {
      throw new ForgeBridgeError(
        'invalid_request',
        'this changeset carries no validation and cannot be approved',
        'Resubmit it through POST /v1/changesets.',
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
        `this changeset deletes ${deletes} instances, above the confirmation threshold of ` +
          `${LIMITS.BULK_DELETE_CONFIRM_THRESHOLD}`,
        'Resend with confirmBulkDelete: true if that is intended.',
      );
    }

    const current = await this.store.getProjectVersion(session.id, changeSet.projectId);
    if (changeSet.baseVersion !== current) {
      throw new ForgeBridgeError(
        'stale_base',
        `changeset was built against version ${changeSet.baseVersion}; the project is at ${current}`,
        `Rebuild against version ${current} and resubmit.`,
      );
    }

    const link = await this.#requirePairedLink(session, changeSet.projectId);
    await this.store.setChangeSetStatus(session.id, changeSet.id, 'approved');
    const delivery = await this.#enqueue(link.id, { kind: 'changeset', changeSet });

    this.#logger.info('changeset approved', {
      changeSetId: changeSet.id,
      sessionId: session.id,
      approvedBy: body.approvedBy,
      operations: changeSet.operations.length,
      deletes,
    });

    writeJson(
      res,
      202,
      ApproveResponse.parse({ changeSetId: changeSet.id, status: 'approved', nonce: delivery.nonce }),
      context.cors,
    );
  }

  async #applyResult(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const link = this.#requireLink(context);
    const session = context.session as RelaySession;
    const payload = await this.#openFromConsumer(req, context, this.limits.changeSet.maxBytes);
    const result = parseOrThrow(ApplyResult, payload, 'apply result');

    // The parameterised form of this route carries the id in the path; the bare
    // form does not, because an ApplyResult already names its own.
    const pathChangeSetId = context.route.resource === 'changesets' ? context.params[0] : undefined;
    if (pathChangeSetId && pathChangeSetId !== result.changeSetId) {
      throw new ForgeBridgeError('invalid_request', 'apply result does not match the changeset in the path');
    }

    const changeSet = await this.#requireChangeSet(session, result.changeSetId);
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

    // A journal id that already exists names an apply whose inverses are the
    // only way back from it. Checked relay-wide, and before anything is written.
    if (await this.store.journalIdTaken(result.journalId)) {
      throw new ForgeBridgeError(
        'invalid_request',
        `journal ${result.journalId} is already recorded for an earlier apply`,
        'Mint a fresh journal id for each apply; reusing one would discard the rollback handle for the first.',
      );
    }

    const versionBefore = await this.store.getProjectVersion(session.id, changeSet.projectId);
    if (result.newVersion < versionBefore) {
      throw new ForgeBridgeError(
        'invalid_request',
        `newVersion ${result.newVersion} is behind the recorded version ${versionBefore}`,
      );
    }

    const anyApplied = result.outcomes.some((outcome) => outcome.ok);
    const status: ChangeSetStatus = isFullyApplied(result) ? 'applied' : anyApplied ? 'partial' : 'failed';

    await this.store.putApplyResult(session.id, result);
    await this.store.setChangeSetStatus(session.id, changeSet.id, status);
    await this.store.setProjectVersion(session.id, changeSet.projectId, result.newVersion);
    await this.store.patchLink(link.id, { lastSeenAt: result.appliedAt, pluginVersion: result.pluginVersion });

    const journal: JournalRecord = {
      id: result.journalId,
      sessionId: session.id,
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
      sessionId: session.id,
      status,
      newVersion: result.newVersion,
    });

    writeJson(
      res,
      200,
      { changeSetId: changeSet.id, status, version: result.newVersion, journalId: journal.id },
      context.cors,
    );
  }

  async #rollback(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const journalId = context.params[0] ?? '';
    const body = parseOrThrow(
      RollbackRequest,
      await readJson(req, this.limits.maxRequestBytes.rollback),
      'rollback request',
    );
    if (body.journalId !== journalId) {
      throw new ForgeBridgeError('invalid_request', 'rollback request does not match the journal in the path');
    }

    const journal = await this.store.getJournal(session.id, journalId);
    if (!journal) throw new ForgeBridgeError('not_found', 'no such journal entry');
    if (journal.rolledBackAt) {
      throw new ForgeBridgeError('invalid_request', 'this journal entry has already been rolled back');
    }

    const current = await this.store.getProjectVersion(session.id, journal.projectId);
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
    // to help with. `planRollbackFor` also refuses when this relay holds no
    // inverses for the apply, in the words that send a user to the right place.
    const plan = await planRollbackFor(this.#rollbackDeps(session), journalId);

    const link = await this.#requirePairedLink(session, journal.projectId);
    const delivery = await this.#enqueue(
      link.id,
      rollbackDeliveryFor(plan, {
        expectedVersion: current,
        ...(body.reason ? { reason: body.reason } : {}),
      }),
    );

    // Dispatched, not done — a statement about timing rather than about the
    // protocol. The inverses travel with the delivery, the consumer replays
    // them, and it reports back to `POST /v1/journal/:id/rollback-result`.
    // Until that report arrives the honest word is "requested", which is what
    // `GET /v1/journal/:id` answers.
    await this.store.patchJournal(journal.id, { rollbackRequestedAt: new Date(this.#now()).toISOString() });

    this.#logger.info('rollback dispatched', {
      journalId: journal.id,
      sessionId: session.id,
      steps: plan.steps.length,
      restoresToVersion: plan.restoresToVersion,
    });

    writeJson(
      res,
      202,
      RollbackResponse.parse({
        journalId: journal.id,
        changeSetId: journal.changeSetId,
        status: 'dispatched',
        nonce: delivery.nonce,
        steps: plan.steps.length,
      }),
      context.cors,
    );
  }

  /**
   * `POST /v1/journal/:id/entry` — the consumer uploading the inverses it
   * captured before it applied anything.
   *
   * Consumer surface, enveloped and MAC'd like an `ApplyResult`, and for the
   * same reason: this is the record that decides whether a destructive apply is
   * survivable, so nothing that merely found the relay may write one.
   */
  async #journalEntry(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const link = this.#requireLink(context);
    const session = context.session as RelaySession;
    const journalId = context.params[0] ?? '';
    const payload = await this.#openFromConsumer(req, context, this.limits.changeSet.maxBytes);
    const entry = parseOrThrow(JournalEntry, payload, 'journal entry');
    if (entry.id !== journalId) {
      throw new ForgeBridgeError('invalid_request', 'journal entry does not match the journal in the path');
    }

    const ack = await recordJournalEntry(this.#rollbackDeps(session), link, entry);
    this.#logger.info('journal inverses recorded', { ...ack, sessionId: session.id });
    writeJson(res, 200, JournalEntryAck.parse(ack), context.cors);
  }

  /**
   * `POST /v1/journal/:id/rollback-result` — the consumer reporting a reversal.
   *
   * A partial reversal is reported as `rollback_partial` and leaves
   * `rolledBackAt` null, because the entry is then neither reversed nor intact
   * and a timestamp saying otherwise would be the journal's own record lying
   * about the one thing it exists to be right about.
   */
  async #rollbackResult(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const link = this.#requireLink(context);
    const session = context.session as RelaySession;
    const journalId = context.params[0] ?? '';
    const payload = await this.#openFromConsumer(req, context, this.limits.changeSet.maxBytes);
    const result = parseOrThrow(RollbackResult, payload, 'rollback result');
    if (result.journalId !== journalId) {
      throw new ForgeBridgeError('invalid_request', 'rollback result does not match the journal in the path');
    }

    const ack = await recordRollbackResult(this.#rollbackDeps(session), link, result);
    await this.store.patchLink(link.id, {
      lastSeenAt: result.rolledBackAt,
      pluginVersion: result.pluginVersion,
    });

    this.#logger.info('rollback result recorded', {
      journalId: ack.journalId,
      sessionId: session.id,
      status: ack.status,
      newVersion: ack.version,
    });

    // `state` rather than `status`: the same vocabulary `GET /v1/journal/:id`
    // answers in, because two words for one fact is how three surfaces came to
    // describe a rollback three different ways.
    const record = await this.store.getJournal(session.id, result.journalId);
    writeJson(
      res,
      200,
      RollbackResultAck.parse({
        journalId: ack.journalId,
        changeSetId: ack.changeSetId,
        state: record ? journalStateOf(record, result) : ack.status,
        version: ack.version,
      }),
      context.cors,
    );
  }

  /** `GET /v1/journal/:id` — what happened to one apply, and to any reversal. */
  async #journalState(res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const journalId = context.params[0] ?? '';
    const record = await this.store.getJournal(session.id, journalId);
    if (!record) throw new ForgeBridgeError('not_found', 'no such journal entry');

    const entry = await this.store.getJournalEntry(session.id, journalId);
    const result = await this.store.getRollbackResult(session.id, journalId);

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
        // Null, not 0, when the inverses never reached this relay. The two are
        // different facts: 0 is an apply with nothing to undo, null is an apply
        // whose only route back stayed inside a Studio session.
        inverses: entry ? entry.inverses.length : null,
        result,
      }),
      context.cors,
    );
  }

  async #output(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const link = this.#requireLink(context);
    const payload = await this.#openFromConsumer(req, context, this.limits.maxRequestBytes.output);
    const batch = parseOrThrow(OutputBatch, payload, 'output batch');
    await this.store.appendOutput(link.id, batch.messages);
    await this.store.patchLink(link.id, { lastSeenAt: new Date(this.#now()).toISOString() });
    writeEmpty(res, 204, context.cors);
  }

  async #readOutput(res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const requested = context.url.searchParams.get('link');
    let link: Link | null;
    if (requested) {
      const found = await this.store.getLink(requested);
      // A link id from another session is answered as "no link", not as
      // "forbidden": the difference between the two is a way to test whether an
      // id exists on this relay.
      link = found && found.session.id === session.id ? found.link : null;
    } else {
      link = await this.store.findPairedLink(session.id, session.projectId);
    }
    if (!link) throw new ForgeBridgeError('link_unpaired', 'no link to read console output from');
    const messages: OutputMessage[] = await this.store.recentOutput(link.id, OUTPUT_READ_LIMIT);
    writeJson(res, 200, OutputResponse.parse({ messages }), context.cors);
  }

  /**
   * `GET /v1/models` — the route exists, the registry does not.
   *
   * `ModelsSnapshot.configured` is the field that makes this honest: an empty
   * list from a configured registry and an empty list because nothing is
   * configured are different facts, and a model selector that cannot tell them
   * apart shows the wrong message. The relay has no registry by construction —
   * choosing a model is a decision made where the credential is, which is not
   * here — so it answers `configured: false` and says why.
   */
  async #models(res: ServerResponse, context: RequestContext): Promise<void> {
    const snapshot = ModelsSnapshot.parse({
      configured: false,
      source: 'the relay holds no model registry; models are chosen where the credential is',
      verifiedAt: null,
      models: [],
    });
    writeJson(res, 200, snapshot, context.cors);
  }

  async #startRun(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const body = parseOrThrow(RelayRunRequest, await readJson(req, this.limits.maxRequestBytes.run), 'run request');

    if (body.projectId !== undefined && body.projectId !== session.projectId) {
      throw new ForgeBridgeError('invalid_request', 'this run names a project that does not belong to this session');
    }

    // Asked before a single counter moves. A relay with nothing wired behind
    // the port cannot start a run at all, and charging a caller's daily
    // allowance on the way to telling them so would cost them tomorrow's run
    // for a run that was never going to happen.
    const dispatch = this.#requireDispatch();

    const reservation = await this.#sponsored.reserve({
      address: context.address,
      proof: headerValue(req, 'x-forgebridge-verification'),
    });

    const controller = new AbortController();
    const onHangUp = (): void => controller.abort();
    res.once('close', onHangUp);

    try {
      const answer = await dispatch.startRun({
        sessionId: session.id,
        projectId: session.projectId,
        body,
        sponsoredFor: { userId: reservation.user.userId },
        signal: controller.signal,
      });
      if (res.writableEnded || res.destroyed) return;
      // Forwarded, not interpreted. See `dispatch.ts`.
      writeJson(res, answer.status, answer.body, context.cors);
    } catch (error) {
      // The run did not happen, so the capacity was not spent. Releasing is the
      // half of reserve-then-release that makes the reservation a limit rather
      // than a tax on failure.
      await reservation.release();
      throw error;
    } finally {
      res.removeListener('close', onHangUp);
    }
  }

  async #runStatus(res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const dispatch = this.#requireDispatch();
    const controller = new AbortController();
    const answer = await dispatch.runStatus({
      sessionId: session.id,
      runId: context.params[0] ?? '',
      signal: controller.signal,
    });
    writeJson(res, answer.status, answer.body, context.cors);
  }

  async #runEvents(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<void> {
    const session = this.#requireSession(context);
    const dispatch = this.#requireDispatch();
    const runId = context.params[0] ?? '';
    const since = parseCursor(context.url.searchParams.get('since'));

    beginEventStream(res, context.cors);

    if (!dispatch.runEvents) {
      // A stream that stops without a word is indistinguishable from a stream
      // with more to say, so the relay says which one this is.
      writeEventFrame(res, 'closed', {
        reason:
          `the run service behind this relay (${dispatch.name}) does not stream events. The run itself is ` +
          'readable by polling GET /v1/runs/:id.',
      });
      endEventStream(res);
      return;
    }

    const controller = new AbortController();
    const finish = (): void => controller.abort();
    res.once('close', finish);
    req.once('close', finish);
    const keepAlive = setInterval(() => writeKeepAlive(res), EVENT_STREAM_KEEP_ALIVE_MS);
    keepAlive.unref?.();
    const ceiling = setTimeout(() => {
      writeEventFrame(res, 'closed', {
        reason: `this stream reached its ${RUN_STREAM_MAX_MS / 60_000} minute ceiling; reconnect with ?since= to continue.`,
      });
      controller.abort();
    }, RUN_STREAM_MAX_MS);
    ceiling.unref?.();

    try {
      for await (const frame of dispatch.runEvents({ sessionId: session.id, runId, since, signal: controller.signal })) {
        if (res.writableEnded || res.destroyed) break;
        writeEventFrame(res, frame.event, frame.data, frame.id);
      }
    } catch (error) {
      // The headers went out with the first frame, so there is no status left
      // to set. The stream says what happened in the vocabulary a JSON caller
      // would have received, and then closes.
      writeEventFrame(res, 'error', {
        code: error instanceof ForgeBridgeError ? error.code : 'internal',
        message:
          error instanceof ForgeBridgeError ? error.message : 'the relay failed while following this run',
      });
    } finally {
      clearInterval(keepAlive);
      clearTimeout(ceiling);
      res.removeListener('close', finish);
      req.removeListener('close', finish);
      endEventStream(res);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  #rollbackDeps(session: RelaySession): RollbackDeps {
    return { store: this.store, session, now: this.#now };
  }

  #requireDispatch(): RunDispatchPort {
    if (!this.#dispatch) {
      throw new ForgeBridgeError(
        'provider_unconfigured',
        'this relay runs no models and has no run service wired in, so it cannot turn a prompt into a ChangeSet',
        'Every other route works without one. Use your own API key (BYOK) through the web app, or run ' +
          'the local daemon, which calls the model from your machine and keeps the key there (ADR-006).',
      );
    }
    return this.#dispatch;
  }

  #requireSession(context: RequestContext): RelaySession {
    if (!context.session) {
      // Unreachable: `#authorise` refuses a producer route without one. A
      // refusal rather than a non-null assertion, because the alternative is a
      // handler reading `undefined.id` and scoping a store query by it.
      throw new ForgeBridgeError('link_unauthenticated', 'this route requires a session');
    }
    return context.session;
  }

  #requireLink(context: RequestContext): Link {
    if (!context.link || !context.sessionKey) {
      throw new ForgeBridgeError('link_unauthenticated', 'this route requires a paired link');
    }
    return context.link;
  }

  async #requireChangeSet(session: RelaySession, id: string): Promise<ChangeSet> {
    const changeSet = await this.store.getChangeSet(session.id, id);
    // `getChangeSet` returns null both for an id that does not exist and for one
    // belonging to another session, and this refusal cannot tell them apart —
    // which is the point. A relay that answered 403 for the second would be
    // confirming that the id is real and someone else's.
    if (!changeSet) throw new ForgeBridgeError('not_found', 'no such changeset');
    return changeSet;
  }

  async #requirePairedLink(session: RelaySession, projectId: string): Promise<Link> {
    const link = await this.store.findPairedLink(session.id, projectId);
    if (!link || !this.#keyring.has(link.id)) {
      throw new ForgeBridgeError(
        'link_unpaired',
        'no paired Studio session for this project',
        'Open the place in Studio and pair the plugin with a fresh pairing code.',
      );
    }
    return link;
  }

  /** Open an enveloped write from a paired consumer, replay check included. */
  async #openFromConsumer(req: IncomingMessage, context: RequestContext, limitBytes: number): Promise<unknown> {
    const link = this.#requireLink(context);
    const sessionKey = context.sessionKey as Buffer;
    const raw = await readJson(req, limitBytes);
    const opened = openEnvelope(sessionKey, raw, { linkId: link.id });

    // Claim the nonce before doing any work, in one atomic step, and only after
    // the MAC has verified. Read-then-write lets two copies of a duplicated
    // request both read the old watermark and both apply; claiming before the
    // MAC would let an unauthenticated caller push the watermark forward and
    // lock the real consumer out.
    const claimed = await this.store.tryAdvanceInboundNonce(link.id, opened.envelope.nonce);
    if (!claimed) {
      const lastAccepted = await this.store.lastInboundNonce(link.id);
      throw new ForgeBridgeError(
        'replay_detected',
        `nonce ${opened.envelope.nonce} is at or below the last accepted nonce ${lastAccepted}`,
        'Read the link state and send the next nonce.',
      );
    }
    return opened.payload;
  }

  async #enqueue(linkId: string, payload: DeliveryPayload): Promise<DeliveryRecord> {
    const parsed = DeliveryPayload.parse(payload);
    const delivery = await this.store.enqueueDelivery(linkId, parsed);
    this.#wake(linkId);
    return delivery;
  }

  #wake(linkId: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.linkId !== linkId) continue;
      void this.store.nextDelivery(linkId, waiter.since).then((delivery) => {
        if (delivery) waiter.settle(delivery);
      });
    }
  }
}

export function createRelay(options: RelayOptions = {}): ForgeBridgeRelay {
  return new ForgeBridgeRelay(options);
}

/**
 * Match a path against the route table.
 *
 * Exported so `test/surface.test.ts` can assert that every route in
 * `RELAY_ROUTES` is reachable through the same matcher the server uses — a
 * table with an entry the matcher cannot reach is a table that documents a
 * route nobody serves.
 */
export function matchRoute(pathname: string, method: string): { route: RelayRoute; params: string[] } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'v1') return null;
  const resource = segments[1];
  if (resource === undefined) return null;
  const rest = segments.slice(2);

  for (const route of RELAY_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    if (route.resource !== resource) continue;
    if (route.sub.length !== rest.length) continue;
    const params: string[] = [];
    let ok = true;
    for (const [index, expected] of route.sub.entries()) {
      const actual = rest[index] as string;
      if (expected === '{}') params.push(actual);
      else if (expected !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
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
 * Read from the manifest rather than duplicated as a literal: a hand-copied
 * version is a version that goes stale, and `/v1/health` is what a support
 * request quotes when someone says the bridge is misbehaving.
 */
export const RELAY_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
