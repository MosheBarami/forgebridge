import { z } from 'zod';
import {
  ForgeBridgeError,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ProtocolError,
  type ChangeSet,
} from '@forgebridge/protocol';
import type { ApplyApprovalGrant, RollbackApprovalGrant } from './approval.js';
import {
  ApproveResponse,
  DiffResponse,
  JournalStateResponse,
  LinkStatusResponse,
  ModelsResponse,
  ProposeResponse,
  RollbackResponse,
  RunResponse,
} from './daemon-wire.js';

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


/**
 * The port this connector reaches ForgeBridge through, and the HTTP adapter
 * that implements it against the daemon's `/v1` surface.
 *
 * There is no business logic below. Every method is one request to one endpoint
 * and one parse of the answer; the daemon decides everything that is decided.
 * That is the ADR-009 constraint stated as code: if a method here started
 * choosing between endpoints based on the state of a ChangeSet, or computing a
 * verdict, or retrying a policy failure differently from a transport failure,
 * that reasoning would have escaped `@forgebridge/core` into a connector, where
 * the next connector would have to reimplement it and would get it slightly
 * wrong.
 *
 * `approve` and `rollback` take a grant rather than the fields the daemon
 * wants. That is not ergonomics: it means the two write endpoints are
 * unreachable without a grant, and TypeScript refuses to compile a call that
 * has not obtained one — including one whose grant names no reviewed content,
 * because `ApplyApprovalGrant.contentDigest` is required. See `approval.ts`.
 */
/**
 * Named for the daemon's own request shape rather than for the skill that
 * invokes it: this is the port's vocabulary, and the skill's `StartRunInput` in
 * `skills.ts` is the A2A one. They agree field for field today and are allowed
 * to diverge — that is what a port is for.
 */
export interface StartRunRequest {
  prompt: string;
  projectId?: string;
  policy?: string;
  pinnedModel?: string;
  baseVersion?: number;
  maxAttempts?: number;
}

export interface ForgeBridgeBackend {
  /**
   * A prompt in, a proposed ChangeSet out — and never an applied one.
   *
   * It sits beside `propose` rather than above it: both end at a ChangeSet the
   * daemon has validated and nobody has approved, and the only difference is who
   * wrote the operations. A run is not a shortcut past the gate, and there is no
   * argument to this method that reaches one (ADR-012).
   */
  startRun(request: StartRunRequest): Promise<RunResponse>;
  propose(changeSet: ChangeSet): Promise<ProposeResponse>;
  diff(changeSetId: string): Promise<DiffResponse>;
  approve(grant: ApplyApprovalGrant): Promise<ApproveResponse>;
  rollback(
    grant: RollbackApprovalGrant,
    request: { journalId: string; expectedVersion: number; reason?: string },
  ): Promise<RollbackResponse>;
  /**
   * What happened to one apply, and to any reversal of it.
   *
   * A read, and so it takes no grant: it changes nothing and it is the only way
   * a calling agent can learn that a rollback it dispatched actually happened.
   * Dispatch answers `202 dispatched` and the plugin replays afterwards, so
   * without this the connector's last word on a reversal would be that it had
   * asked for one.
   */
  journal(journalId: string): Promise<JournalStateResponse>;
  models(): Promise<ModelsResponse>;
  linkStatus(): Promise<LinkStatusResponse>;
}

/** The header the daemon gates its producer routes on (`packages/daemon/src/auth.ts`). */
const PRODUCER_TOKEN_HEADER = 'X-ForgeBridge-Token';

export interface DaemonBackendOptions {
  /** Base URL of a running daemon, e.g. `http://127.0.0.1:7317`. No trailing slash required. */
  baseUrl: string;
  /**
   * The daemon's producer token, printed once when it starts.
   *
   * This is the secret that makes the approval boundary necessary rather than
   * optional: holding it is what lets this process propose, and it is also what
   * would let it approve. Nothing outside `approve`/`rollback` guards it, so
   * the guard lives at the gate instead.
   */
  producerToken: string;
  /** Wall-clock ceiling on a single daemon call. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The ceiling on a run, which is a different kind of request from every other
 * one on this surface: it waits on a model, and on the router's fallback
 * through however many models the policy allows.
 */
const RUN_TIMEOUT_MS = 10 * 60_000;

export class DaemonBackend implements ForgeBridgeBackend {
  readonly #baseUrl: string;
  readonly #producerToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DaemonBackendOptions) {
    this.#baseUrl = withoutTrailingSlashes(options.baseUrl);
    this.#producerToken = options.producerToken;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * `POST /v1/runs`, with a ceiling of its own.
   *
   * The daemon calls a language model here, possibly several as the router
   * falls back, so the thirty seconds every other call gets would abandon a run
   * that was working. `stream` is false and `producer` is stamped by this
   * connector: the first because an A2A task carries one artifact rather than a
   * frame sequence, and the second because a field the caller could set would
   * let a remote agent describe itself as the web app in the daemon's own run
   * log.
   */
  async startRun(request: StartRunRequest): Promise<RunResponse> {
    return await this.#call(
      'POST',
      '/v1/runs',
      RunResponse,
      { ...request, stream: false, producer: { kind: 'a2a' } },
      RUN_TIMEOUT_MS,
    );
  }

  async propose(changeSet: ChangeSet): Promise<ProposeResponse> {
    return await this.#call('POST', '/v1/changesets', ProposeResponse, changeSet);
  }

  async diff(changeSetId: string): Promise<DiffResponse> {
    return await this.#call('GET', `/v1/changesets/${encodeURIComponent(changeSetId)}/diff`, DiffResponse);
  }

  async approve(grant: ApplyApprovalGrant): Promise<ApproveResponse> {
    // Every field of this body comes from the grant. None of it can come from
    // the A2A request, because the A2A request never reaches this function.
    // `contentDigest` included: the daemon refuses an approve whose digest does
    // not match the operations it holds, so what this sends is the human's
    // reading of the set, not this connector's.
    return await this.#call('POST', `/v1/changesets/${encodeURIComponent(grant.subject)}/approve`, ApproveResponse, {
      contentDigest: grant.contentDigest,
      approvedBy: grant.approvedBy,
      confirmBulkDelete: grant.confirmBulkDelete ?? false,
      ...(grant.note ? { note: grant.note } : {}),
    });
  }

  async rollback(
    grant: RollbackApprovalGrant,
    request: { journalId: string; expectedVersion: number; reason?: string },
  ): Promise<RollbackResponse> {
    return await this.#call('POST', `/v1/journal/${encodeURIComponent(request.journalId)}/rollback`, RollbackResponse, {
      journalId: request.journalId,
      expectedVersion: request.expectedVersion,
      ...(request.reason ? { reason: request.reason } : {}),
    });
  }

  async journal(journalId: string): Promise<JournalStateResponse> {
    return await this.#call('GET', `/v1/journal/${encodeURIComponent(journalId)}`, JournalStateResponse);
  }

  async models(): Promise<ModelsResponse> {
    return await this.#call('GET', '/v1/models', ModelsResponse);
  }

  async linkStatus(): Promise<LinkStatusResponse> {
    return await this.#call('GET', '/v1/link', LinkStatusResponse);
  }

  async #call<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST',
    path: string,
    schema: T,
    body?: unknown,
    timeoutMs: number = this.#timeoutMs,
  ): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          [PRODUCER_TOKEN_HEADER]: this.#producerToken,
          [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // A daemon that is not running, or one that did not answer in time, is
      // reported as a transport failure and not as an internal one: the caller
      // can act on "start the daemon", and cannot act on "internal error".
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ForgeBridgeError(
        'provider_unconfigured',
        aborted
          ? `the ForgeBridge daemon did not answer within ${timeoutMs}ms`
          : 'the ForgeBridge daemon could not be reached',
        'Check that the daemon is running and that this connector points at the right base URL.',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (!response.ok) throw this.#toForgeBridgeError(response.status, text);

    // 204 has no body. No endpoint this connector reads answers 204 today, but
    // treating an empty body as `{}` here rather than crashing on JSON.parse
    // keeps a future one from arriving as an unexplained internal error.
    let parsedJson: unknown;
    try {
      parsedJson = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new ForgeBridgeError('internal', 'the ForgeBridge daemon returned a body that is not JSON');
    }

    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
      // The daemon answered with a shape this connector does not recognise.
      // Named as a version problem rather than an internal one because that is
      // almost always what it is: a daemon newer or older than this package.
      throw new ForgeBridgeError(
        'unsupported_version',
        `the ForgeBridge daemon answered ${method} ${path} with a shape this connector does not recognise`,
        'Update the daemon and this connector to matching versions.',
      );
    }
    return parsed.data;
  }

  /**
   * Rebuild the daemon's own error rather than inventing one.
   *
   * The daemon's every failure leaves as a `ProtocolError` with a code, a
   * message and usually a remedy, and those are the words that should reach the
   * calling agent. Replacing them with "HTTP 409" here would throw away the
   * remedy, which is the only part a caller can act on.
   */
  #toForgeBridgeError(status: number, text: string): ForgeBridgeError {
    try {
      const payload = ProtocolError.parse(JSON.parse(text));
      return new ForgeBridgeError(payload.code, payload.message, payload.remedy);
    } catch {
      return new ForgeBridgeError(
        'internal',
        `the ForgeBridge daemon returned HTTP ${status} with no protocol error payload`,
      );
    }
  }
}
