/**
 * A typed client for the ForgeBridge `/v1` surface.
 *
 * Thin is the whole design (ADR-009). Every method turns a call into an HTTP
 * request and a response back into a schema-parsed value, and does nothing else:
 * no retries that hide a `stale_base`, no queueing, no convenience that decides
 * something the daemon is supposed to decide. A connector that makes a policy
 * decision has put that decision somewhere `@forgebridge/core` cannot see it.
 *
 * ── The rule this file exists to keep visible ────────────────────────────────
 *
 * **Proposing and approving are separate calls, and there is no method that does
 * both.** `proposeChangeSet` submits; `approveChangeSet` clears the set to be
 * delivered. ADR-012 puts a human between those two steps, and a helper that
 * chained them — however convenient — would let a model approve its own work.
 * `approveChangeSet` requires the `contentDigest` off a diff that was read, so
 * even a caller that wanted to chain them would have to fetch and echo the
 * digest of the operations it is approving. If you find yourself wanting the
 * one-call version, that is the gate working.
 *
 * `startRun` is on the *propose* side of that line. It hands a prompt to the
 * model the daemon routes to and gets back a ChangeSet stored `validated`;
 * `StartRunRequest` has no field that reaches approval and none that carries a
 * validation, so a producer cannot send a verdict of its own because there is
 * nowhere to put one.
 *
 * ── Why the route table is not written here ──────────────────────────────────
 *
 * Every method names the operation it calls and the schema it expects, and both
 * are checked against `src/generated/routes.ts` before a request goes out. That
 * file is projected from `packages/protocol/schema/openapi.json`, which is in
 * turn checked against the daemon's own router on every generation. So "what
 * this method parses" and "what the daemon answers with" are not two opinions
 * that happen to agree: the first is read from the second.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@forgebridge/protocol';
import { ForgeBridgeError, ForgeBridgeResponseError, RouteContractError, TransportError } from './errors.js';
import { DEFAULT_RUN_IDLE_TIMEOUT_MS, readEventStream, type EventFrame } from './stream.js';
import { AUTH_HEADERS, OPENAPI_PROTOCOL_VERSION, ROUTES, type OperationId, type Route } from './generated/routes.js';
import {
  ApplyResultAck,
  ApproveRequest,
  ApproveResponse,
  ChangeSetDiff,
  DeliveryEnvelope,
  HealthResponse,
  JournalEntryAck,
  JournalStateResponse,
  LinkStatusResponse,
  ModelsSnapshot,
  OutputResponse,
  PairResponse,
  ProtocolError,
  RollbackResponse,
  RollbackResultAck,
  RunResponse,
  SubmitChangeSetResponse,
  WIRE_SCHEMAS,
  type ApproveRequestInput,
  type ChangeSetInput,
  type DeliveryEnvelopeInput,
  type PairRequestInput,
  type RollbackRequestInput,
  type StartRunRequestInput,
  type WireSchemaName,
} from './generated/wire.js';

/**
 * Strip trailing `/` in linear time.
 *
 * `replace(/\/+$/, '')` stood here and reads better, but `\/+$` is the textbook
 * polynomial-ReDoS shape — on a long run of slashes the engine backtracks
 * O(n^2), which is what CodeQL's `js/polynomial-redos` fires on. A base URL is a
 * caller-supplied string, so the loop is the honest answer rather than an
 * argument about who would ever pass one. Local to this file on purpose: it is
 * three lines, and a shared utility package for it would cross a boundary
 * `verify-boundaries.ts` is right to keep closed.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  // 47 is `/`. charCodeAt keeps this a scan, with no allocation per character.
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}


export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The document this client was generated from must be the protocol this client
 * declares in its headers. They come from two files, and a mismatch would mean
 * the SDK announcing one version and speaking another.
 */
if (OPENAPI_PROTOCOL_VERSION !== PROTOCOL_VERSION) {
  throw new Error(
    `@forgebridge/sdk-ts was generated from an OpenAPI document at protocol ${OPENAPI_PROTOCOL_VERSION}, but ` +
      `@forgebridge/protocol is at ${PROTOCOL_VERSION}. Re-run \`npm run generate --workspace @forgebridge/sdk-ts\`.`,
  );
}

export interface ForgeBridgeClientOptions {
  /** Base address of the transport, e.g. `http://127.0.0.1:7317`. */
  baseUrl: string;
  /**
   * The per-process secret the daemon prints at startup. Required by every
   * producer route — loopback is not an authentication boundary, because any
   * process on the machine can reach the port.
   */
  producerToken?: string | undefined;
  /** The paired link id. Required by the consumer routes. */
  linkId?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /**
   * Wall-clock ceiling for a single non-streaming request.
   *
   * `startRun` without a listener is the one call this is usually wrong for: a
   * run waits on a language model and on the router's fallback, so size the
   * client for it — or follow the run with a listener, where an idle ceiling
   * replaces the wall-clock one.
   */
  timeoutMs?: number;
  /** How long a run stream may be silent before it is treated as dropped. */
  runIdleTimeoutMs?: number;
}

export interface RunStreamOptions {
  /** Called for every frame that is not the run record itself. */
  onFrame?: (frame: EventFrame) => void;
  /** Replay retained events from this index. Absent means from the beginning. */
  since?: number;
}

interface CallOptions {
  path?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** The MAC over this request, for the consumer routes. */
  mac?: string;
}

export class ForgeBridgeClient {
  readonly #baseUrl: string;
  readonly #producerToken: string | undefined;
  readonly #linkId: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #runIdleTimeoutMs: number;

  constructor(options: ForgeBridgeClientOptions) {
    this.#baseUrl = withoutTrailingSlashes(options.baseUrl);
    this.#producerToken = options.producerToken;
    this.#linkId = options.linkId;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#runIdleTimeoutMs = options.runIdleTimeoutMs ?? DEFAULT_RUN_IDLE_TIMEOUT_MS;
  }

  // ── public surface, unauthenticated ────────────────────────────────────────

  health(): Promise<HealthResponse> {
    return this.#json('getHealth', HealthResponse, {});
  }

  /**
   * Link status, transport and privacy posture.
   *
   * `privacyPosture` is forwarded verbatim wherever it is shown. It is one of
   * the few strings in the protocol whose *wording* is the contract: a client
   * that paraphrased "the relay operator can read your changes" into a padlock
   * icon would have told the user something false.
   */
  linkStatus(): Promise<LinkStatusResponse> {
    return this.#json('getLinkStatus', LinkStatusResponse, {});
  }

  models(): Promise<ModelsSnapshot> {
    return this.#json('getModels', ModelsSnapshot, {});
  }

  /** Redeem a pairing code. The session key itself never crosses the wire. */
  pair(request: PairRequestInput): Promise<PairResponse> {
    return this.#json('pairLink', PairResponse, { body: request });
  }

  // ── producer surface ───────────────────────────────────────────────────────

  /**
   * Submit a ChangeSet. This does not approve it and does not apply it.
   *
   * The daemon recomputes `validation` and overwrites `status`, so whatever is
   * sent in those two fields is discarded — a set cannot arrive pre-approved or
   * carrying its own verdict.
   */
  proposeChangeSet(changeSet: ChangeSetInput): Promise<SubmitChangeSetResponse> {
    return this.#json('proposeChangeSet', SubmitChangeSetResponse, { body: changeSet });
  }

  /**
   * The rendered diff — and the `contentDigest` an approval has to echo.
   *
   * A producer route despite being a read: it serves script source and property
   * values out of the user's place, which is place content and not public
   * surface.
   */
  getDiff(changeSetId: string): Promise<ChangeSetDiff> {
    return this.#json('getChangeSetDiff', ChangeSetDiff, { path: { changeSetId } });
  }

  /**
   * Clear a ChangeSet to be delivered to the paired Studio session.
   *
   * Deliberately not reachable from `proposeChangeSet` and deliberately not
   * reachable from `startRun`. Approval is the one step ADR-012 reserves for a
   * human, and `contentDigest` — which has no default, here or on the wire — is
   * what turns "I approve set X" into "I approve the operations I was shown for
   * set X". Read the diff, show it to someone, echo the digest they read.
   *
   * The daemon refuses a set with no validation, a set whose validation failed,
   * a stale `baseVersion`, and a bulk delete without `confirmBulkDelete`. None
   * of that is second-guessed here.
   */
  approveChangeSet(changeSetId: string, request: ApproveRequestInput): Promise<ApproveResponse> {
    return this.#json('approveChangeSet', ApproveResponse, { path: { changeSetId }, body: request });
  }

  /**
   * Turn a prompt into a proposed ChangeSet. Nothing is applied.
   *
   * `response.run.attempts` is the complete list of models the router tried, in
   * order, with why it moved on from each (ADR-008). Report it whole: the code
   * in the ChangeSet was written by the model named in the last successful
   * attempt, which may not be the one that was asked for, so a caller that shows
   * only the winner is misreporting who wrote it.
   *
   * Pass `onFrame` to follow the run as it happens. The answer is the same
   * `RunResponse` either way, because the streamed form's last `run` frame *is*
   * the JSON body — a client that reconstructed the result from the events it
   * happened to catch would be a client whose answer depended on how fast it was
   * reading.
   *
   * `stream` is not a field a caller sets. The client sets it from whether it
   * was handed a listener, so the request and the way the answer is read cannot
   * disagree; a caller that asked for a stream and then did not read one would
   * hold a socket open until the daemon gave up on it.
   */
  async startRun(
    request: StartRunRequestInput,
    onFrame?: (frame: EventFrame) => void,
  ): Promise<RunResponse> {
    if ('stream' in request && request.stream !== undefined) {
      throw new TransportError(
        'startRun sets `stream` itself, from whether it was given a listener. Pass a second argument to follow the ' +
          'run as it happens, or no second argument for the single JSON answer.',
      );
    }
    const streaming = onFrame !== undefined;
    const response = await this.#send('startRun', {
      body: { ...request, stream: streaming },
      accept: streaming ? 'text/event-stream, application/json' : 'application/json',
      // An idle ceiling is a timer the reader resets as the body arrives, so it
      // cannot be expressed as one `AbortSignal.timeout`.
      unbounded: streaming,
    });

    if (!response.ok) throw await this.#refusal(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // The daemon refuses some runs before it opens the stream — no model
      // client, a stale base version, `pinned` with nothing pinned — and those
      // arrive as ordinary JSON. So the content type decides how the body is
      // read, never the flag that was sent.
      return this.#parse('startRun', RunResponse, await this.#bodyOf(response), response.status);
    }
    return await this.#followRun(response, onFrame);
  }

  /** A run and every model it tried. Answers during a run as well as after it. */
  getRun(runId: string): Promise<RunResponse> {
    return this.#json('getRun', RunResponse, { path: { runId } });
  }

  /**
   * Replay and follow a run as it happens.
   *
   * Opens with a `run` frame so a client that arrives late knows what the events
   * are about, replays the retained events from `since`, then follows until the
   * run ends. The log is in memory and capped: `output-delta` frames are never
   * retained, and a run old enough to have been evicted answers with the run
   * record and a `closed` frame rather than stopping quietly. Nothing the stream
   * can lose is missing from the record — the attempt list is on the `run` frame.
   */
  async watchRun(runId: string, options: RunStreamOptions = {}): Promise<RunResponse> {
    const response = await this.#send('watchRun', {
      path: { runId },
      query: { since: options.since },
      accept: 'text/event-stream',
      unbounded: true,
    });
    if (!response.ok) throw await this.#refusal(response);
    return await this.#followRun(response, options.onFrame);
  }

  /**
   * Dispatch a rollback of a journalled apply. Dispatched is not done.
   *
   * The delivery carries the inverse operations; the paired Studio session polls
   * for it, replays them and reports afterwards. `getJournal` is the only thing
   * that can tell a completed reversal from a partial one.
   *
   * Refused when the daemon holds no inverses for the apply. That is a fail-closed
   * refusal, not a gap: a reversal it cannot send is not one it will pretend to
   * dispatch.
   */
  requestRollback(request: RollbackRequestInput): Promise<RollbackResponse> {
    return this.#json('requestRollback', RollbackResponse, {
      path: { journalId: request.journalId },
      body: request,
    });
  }

  /**
   * What happened to one apply, and to any reversal of it.
   *
   * `state` has five values and three of them mean a rollback did not fully
   * happen. `rollback_partial` in particular is its own answer and must not be
   * read as a variety of `rolled_back`: some inverses replayed and some did not,
   * so the place is in a state neither the apply nor the rollback describes, and
   * the inverses that would have finished the job have been consumed.
   * `result.outcomes` says which ones failed.
   *
   * `inverses` is `null`, not `0`, when this daemon holds none. The two are
   * different facts and only one of them means there is no route back.
   */
  getJournal(journalId: string): Promise<JournalStateResponse> {
    return this.#json('getJournal', JournalStateResponse, { path: { journalId } });
  }

  /** Read the mirrored Studio console. Producer surface: the console is place content. */
  readOutput(link?: string): Promise<OutputResponse> {
    return this.#json('readOutput', OutputResponse, { query: { link } });
  }

  // ── consumer surface ───────────────────────────────────────────────────────
  //
  // Every call below is authenticated by a MAC over the request under the
  // session key derived at pairing, and this package does not derive that key.
  // The derivation and the MAC framing live in `packages/daemon/src/envelope.ts`
  // and are not specified anywhere a second implementation could be built
  // against without reading that file and guessing at what it leaves implicit —
  // which is the kind of guess `docs/PROTOCOL.md` forbids.
  //
  // So the MAC is a parameter, and the envelope is sealed by whoever holds the
  // key. A caller that has one (a Studio plugin, a relay, a test harness) can
  // drive these; a caller that does not is told so instead of sending something
  // that cannot verify.
  //
  // TODO(M18): a specification of the pairing handshake, at which point a
  // key-deriving consumer client can be written against it rather than against
  // one TypeScript file. Owner: whoever closes M18.

  /** Long-poll for the next delivery. `null` means the poll window closed empty. */
  poll(options: { mac: string; since?: number }): Promise<DeliveryEnvelope | null> {
    return this.#jsonOrEmpty('pollDeliveries', DeliveryEnvelope, {
      query: { since: options.since ?? 0 },
      mac: options.mac,
    });
  }

  /**
   * Report an ApplyResult, sealed in an envelope this client did not seal.
   *
   * A partial apply is a legal outcome and is reported as one. The consumer
   * never claims a clean apply it did not achieve.
   */
  reportApplyResult(envelope: DeliveryEnvelopeInput, changeSetId?: string): Promise<ApplyResultAck> {
    return changeSetId === undefined
      ? this.#json('reportApplyResult', ApplyResultAck, { body: envelope })
      : this.#json('reportApplyResultForChangeSet', ApplyResultAck, { path: { changeSetId }, body: envelope });
  }

  /**
   * Upload the inverse operations captured before an apply ran.
   *
   * This is what takes the inverses off the session that captured them; without
   * it a rollback cannot outlive that session, which makes it a session feature
   * rather than a safety net. Post it after the ApplyResult, never before: the
   * daemon attaches the entry to the apply it already witnessed and refuses one
   * for an apply it has not seen.
   */
  recordJournalEntry(journalId: string, envelope: DeliveryEnvelopeInput): Promise<JournalEntryAck> {
    return this.#json('recordJournalEntry', JournalEntryAck, { path: { journalId }, body: envelope });
  }

  /**
   * Report how far a reversal got. The payload is a `RollbackResult`.
   *
   * A partial reversal is reported as a partial reversal — one outcome per
   * inverse attempted, nothing rounded up — and the daemon leaves `rolledBackAt`
   * null for it, because the entry is then neither reversed nor intact.
   */
  reportRollbackResult(journalId: string, envelope: DeliveryEnvelopeInput): Promise<RollbackResultAck> {
    return this.#json('reportRollbackResult', RollbackResultAck, { path: { journalId }, body: envelope });
  }

  /** Mirror the Studio console up. The payload is an OutputBatch. */
  async mirrorOutput(envelope: DeliveryEnvelopeInput): Promise<void> {
    await this.#empty('mirrorOutput', { body: envelope });
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  /**
   * Follow a run stream to its end and return the run it settled on.
   *
   * The `run` frame is the answer; every other frame is handed to the listener.
   * A stream that ends without one is a failure rather than an empty success —
   * "no model was tried" and "I did not see which models were tried" are
   * different facts, and only one of them is something this client observed.
   */
  async #followRun(response: Response, onFrame?: (frame: EventFrame) => void): Promise<RunResponse> {
    let latest: unknown;
    let sawRun = false;

    for await (const frame of readEventStream(response, this.#runIdleTimeoutMs)) {
      if (frame.name === 'error') {
        // The headers went out with the first frame, so the daemon had no status
        // left to set and said what happened in the stream instead. There is no
        // observed HTTP status to report, so this is the protocol's own error
        // class — whose `status` is the canonical one for the code — rather than
        // a `ForgeBridgeResponseError` carrying a status nobody sent.
        const parsed = ProtocolError.safeParse(frame.data);
        throw parsed.success
          ? new ForgeBridgeError(parsed.data.code, parsed.data.message, parsed.data.remedy)
          : new TransportError('the run stream reported a failure that is not a ProtocolError');
      }
      if (frame.name === 'run') {
        latest = frame.data;
        sawRun = true;
        continue;
      }
      onFrame?.(frame);
    }

    if (!sawRun) {
      throw new TransportError(
        'the run stream ended without a run frame, so nothing can be said about which models were tried. ' +
          'Read the record with getRun(runId).',
      );
    }
    return this.#parse('startRun', RunResponse, latest, response.status);
  }

  /** One request whose success is a named JSON body. */
  async #json<S extends z.ZodTypeAny>(
    operationId: OperationId,
    expected: S,
    options: CallOptions,
  ): Promise<z.output<S>> {
    expectRouteAnswersWith(operationId, expected);
    const response = await this.#send(operationId, options);
    if (!response.ok) throw await this.#refusal(response);
    return this.#parse(operationId, expected, await this.#bodyOf(response), response.status);
  }

  /**
   * A request whose success is either a named JSON body or a declared empty
   * status. `GET /v1/link/poll` is the only one: 200 with an envelope, 204 when
   * the poll window closed with nothing queued.
   */
  async #jsonOrEmpty<S extends z.ZodTypeAny>(
    operationId: OperationId,
    expected: S,
    options: CallOptions,
  ): Promise<z.output<S> | null> {
    const route = expectRouteAnswersWith(operationId, expected);
    const empty = route.responses.find(
      (candidate) => candidate.status >= 200 && candidate.status < 300 && candidate.contentType === null,
    );
    if (!empty) {
      throw new RouteContractError(
        `${operationId} was called as one that may answer with no body, and the route table declares no empty 2xx for it`,
      );
    }
    const response = await this.#send(operationId, options);
    if (response.status === empty.status) return null;
    if (!response.ok) throw await this.#refusal(response);
    return this.#parse(operationId, expected, await this.#bodyOf(response), response.status);
  }

  /** A request whose success carries no body at all. */
  async #empty(operationId: OperationId, options: CallOptions): Promise<void> {
    const route = ROUTES[operationId] as Route;
    if (route.successSchema !== null) {
      throw new RouteContractError(
        `${operationId} was called as one that answers with no body, and the route table says it answers with ` +
          `${route.successSchema}`,
      );
    }
    const response = await this.#send(operationId, options);
    if (!response.ok) throw await this.#refusal(response);
  }

  async #send(
    operationId: OperationId,
    options: CallOptions & { accept?: string; unbounded?: boolean },
  ): Promise<Response> {
    const route = ROUTES[operationId] as Route;
    const url = `${this.#baseUrl}${buildPath(route, options.path, options.query)}`;

    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/json',
      // Declared so the daemon can refuse a major-version mismatch outright
      // rather than half-answering a client that will misread the reply.
      [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    };

    if (route.auth === 'producer') {
      if (!this.#producerToken) {
        throw new TransportError(
          `${route.method.toUpperCase()} ${route.path} is producer surface and needs the daemon's producer token. ` +
            'Construct the client with producerToken. The daemon prints it once, on the terminal it was started from.',
        );
      }
      headers[AUTH_HEADERS.producerToken] = this.#producerToken;
    }

    if (route.auth === 'consumer') {
      if (!this.#linkId) {
        throw new TransportError(
          `${route.method.toUpperCase()} ${route.path} is consumer surface and needs a paired link. ` +
            'Construct the client with linkId.',
        );
      }
      headers[AUTH_HEADERS.linkId] = this.#linkId;
      if (options.mac !== undefined) headers[AUTH_HEADERS.linkMac] = options.mac;
    }

    let body: string | undefined;
    if (route.requestBody !== null) {
      if (options.body === undefined) {
        throw new RouteContractError(`${operationId} takes a ${route.requestBody} body and was called without one`);
      }
      // Validated before it is sent, against the same schema the daemon parses
      // it with. A client that posts a malformed ChangeSet and reads the 400 has
      // learned the same thing one request later and one round trip poorer.
      const schema = schemaFor(route.requestBody);
      const parsed = schema.safeParse(options.body);
      if (!parsed.success) {
        throw new TransportError(
          `the ${route.requestBody} passed to ${operationId} is not one the protocol accepts: ` +
            `${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
        );
      }
      headers['content-type'] = 'application/json';
      body = JSON.stringify(parsed.data);
    } else if (options.body !== undefined) {
      throw new RouteContractError(`${operationId} takes no request body and was called with one`);
    }

    try {
      return await this.#fetch(url, {
        method: route.method.toUpperCase(),
        headers,
        ...(options.unbounded === true ? {} : { signal: AbortSignal.timeout(this.#timeoutMs) }),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw new TransportError(
        `no ForgeBridge transport answered at ${this.#baseUrl} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  async #bodyOf(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.trim() === '') {
      throw new TransportError(`the transport answered ${response.status} with an empty body`, response.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TransportError(`the transport answered ${response.status} with a body that is not JSON`, response.status);
    }
  }

  #parse<S extends z.ZodTypeAny>(
    operationId: OperationId,
    schema: S,
    payload: unknown,
    status: number,
  ): z.output<S> {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      // A 2xx whose body does not match the contract is a protocol failure, not
      // a user error, and not an `ErrorCode` this client is entitled to invent.
      throw new TransportError(
        `${operationId} answered with a body this build does not recognise: ` +
          `${parsed.error.issues[0]?.path.join('.') || '(root)'} ${parsed.error.issues[0]?.message ?? 'rejected'}. ` +
          'The transport may be running a different protocol version.',
        status,
      );
    }
    return parsed.data as z.output<S>;
  }

  /**
   * Turn a non-2xx into the refusal the daemon meant.
   *
   * `code`, `message` and `remedy` are all worth more than the status number,
   * and `remedy` is written for exactly the person about to read it. A body that
   * is not a `ProtocolError` falls back to a transport error, because inventing
   * a code would hand the caller a refusal the daemon never made.
   */
  async #refusal(response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = undefined;
    }
    const parsed = ProtocolError.safeParse(payload);
    if (!parsed.success) {
      return new TransportError(
        `the transport refused with HTTP ${response.status} and a body that is not a ProtocolError`,
        response.status,
      );
    }
    return new ForgeBridgeResponseError(parsed.data, response.status);
  }
}

// ── route-table linkage ───────────────────────────────────────────────────────

function schemaFor(name: WireSchemaName): z.ZodTypeAny {
  return WIRE_SCHEMAS[name] as z.ZodTypeAny;
}

/**
 * Check that the schema a method named is the one the document says this route
 * answers with.
 *
 * This is the join between the hand-written half of the client and the
 * generated half. Without it a method could name `getHealth` and parse the
 * answer as a `LinkStatusResponse`, and every test that only ever calls the
 * method the right way would pass. `test/client.test.ts` plants exactly that.
 */
export function expectRouteAnswersWith(operationId: OperationId, expected: z.ZodTypeAny): Route {
  const route = ROUTES[operationId] as Route;
  if (route.successSchema === null) {
    throw new RouteContractError(
      `${operationId} was called as a route that answers with a body, and the route table says it answers with none`,
    );
  }
  const declared = schemaFor(route.successSchema);
  if (declared !== expected) {
    throw new RouteContractError(
      `${operationId} answers with ${route.successSchema}, and it was called expecting a different schema`,
    );
  }
  return route;
}

/**
 * Substitute the path parameters and append the query ones.
 *
 * Fail-closed in both directions: a declared path parameter that was not
 * supplied and a query key the route does not declare are both refused. The
 * second matters as much as the first — a typo in a query name would otherwise
 * be sent, ignored by the daemon, and read as "the filter did nothing".
 */
export function buildPath(
  route: Route,
  pathParams: Record<string, string> | undefined,
  queryParams: Record<string, string | number | undefined> | undefined,
): string {
  const supplied = pathParams ?? {};
  let path = route.path;

  for (const parameter of route.parameters) {
    if (parameter.in !== 'path') continue;
    const value = supplied[parameter.name];
    if (value === undefined || value === '') {
      throw new RouteContractError(`${route.operationId} needs the path parameter "${parameter.name}"`);
    }
    // Encoded, because an id reaches this client from wherever the caller got
    // it and interpolating one raw would let a `../` walk into another route.
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
  }

  // Two `indexOf` calls rather than `/\{([^}]+)\}/`. The regex is the textbook
  // polynomial-ReDoS shape CodeQL's `js/polynomial-redos` fires on, and the path
  // it reads is built here from caller-supplied ids — so this is a scan, and the
  // reported name is the same one the regex would have captured.
  const open = path.indexOf('{');
  if (open !== -1) {
    const close = path.indexOf('}', open + 1);
    throw new RouteContractError(
      `${route.operationId} has an unresolved path parameter "${close === -1 ? path.slice(open + 1) : path.slice(open + 1, close)}" that the route table does not declare`,
    );
  }
  for (const name of Object.keys(supplied)) {
    if (!route.parameters.some((parameter) => parameter.in === 'path' && parameter.name === name)) {
      throw new RouteContractError(`${route.operationId} declares no path parameter "${name}"`);
    }
  }

  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(queryParams ?? {})) {
    if (value === undefined) continue;
    if (!route.parameters.some((parameter) => parameter.in === 'query' && parameter.name === name)) {
      throw new RouteContractError(`${route.operationId} declares no query parameter "${name}"`);
    }
    query.set(name, String(value));
  }

  const suffix = query.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

/**
 * Which method covers which `/v1` operation.
 *
 * A `Record<OperationId, …>` rather than a list, so `tsc` fails when the
 * document grows a route nothing here calls. That is the whole point: a
 * generated route table is only worth having if something forces the client to
 * keep up with it, and "somebody will notice" is not that something.
 * `test/client.test.ts` checks the other direction — that every name below is a
 * real method on the class.
 */
export const OPERATION_COVERAGE: Readonly<Record<OperationId, keyof ForgeBridgeClient>> = {
  getHealth: 'health',
  getLinkStatus: 'linkStatus',
  getModels: 'models',
  pairLink: 'pair',
  proposeChangeSet: 'proposeChangeSet',
  getChangeSetDiff: 'getDiff',
  approveChangeSet: 'approveChangeSet',
  startRun: 'startRun',
  getRun: 'getRun',
  watchRun: 'watchRun',
  requestRollback: 'requestRollback',
  getJournal: 'getJournal',
  readOutput: 'readOutput',
  pollDeliveries: 'poll',
  reportApplyResult: 'reportApplyResult',
  reportApplyResultForChangeSet: 'reportApplyResult',
  recordJournalEntry: 'recordJournalEntry',
  reportRollbackResult: 'reportRollbackResult',
  mirrorOutput: 'mirrorOutput',
};
