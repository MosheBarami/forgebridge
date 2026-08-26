import { z } from 'zod';
import {
  ForgeBridgeError,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ProtocolError,
  type ChangeSet,
} from '@forgebridge/protocol';
import type { ApprovalGrant } from './approval.js';
import {
  ApproveResponse,
  DiffResponse,
  LinkStatusResponse,
  ModelsResponse,
  ProposeResponse,
  RollbackResponse,
} from './daemon-wire.js';

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
 * `approve` and `rollback` take an `ApprovalGrant` rather than the fields the
 * daemon wants. That is not ergonomics: it means the two write endpoints are
 * unreachable without a grant, and TypeScript refuses to compile a call that
 * has not obtained one. See `approval.ts`.
 */
export interface ForgeBridgeBackend {
  propose(changeSet: ChangeSet): Promise<ProposeResponse>;
  diff(changeSetId: string): Promise<DiffResponse>;
  approve(grant: ApprovalGrant): Promise<ApproveResponse>;
  rollback(
    grant: ApprovalGrant,
    request: { journalId: string; expectedVersion: number; reason?: string },
  ): Promise<RollbackResponse>;
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

export class DaemonBackend implements ForgeBridgeBackend {
  readonly #baseUrl: string;
  readonly #producerToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DaemonBackendOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#producerToken = options.producerToken;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async propose(changeSet: ChangeSet): Promise<ProposeResponse> {
    return await this.#call('POST', '/v1/changesets', ProposeResponse, changeSet);
  }

  async diff(changeSetId: string): Promise<DiffResponse> {
    return await this.#call('GET', `/v1/changesets/${encodeURIComponent(changeSetId)}/diff`, DiffResponse);
  }

  async approve(grant: ApprovalGrant): Promise<ApproveResponse> {
    // Every field of this body comes from the grant. None of it can come from
    // the A2A request, because the A2A request never reaches this function.
    return await this.#call('POST', `/v1/changesets/${encodeURIComponent(grant.subject)}/approve`, ApproveResponse, {
      approvedBy: grant.approvedBy,
      confirmBulkDelete: grant.confirmBulkDelete ?? false,
      ...(grant.note ? { note: grant.note } : {}),
    });
  }

  async rollback(
    grant: ApprovalGrant,
    request: { journalId: string; expectedVersion: number; reason?: string },
  ): Promise<RollbackResponse> {
    return await this.#call('POST', `/v1/journal/${encodeURIComponent(request.journalId)}/rollback`, RollbackResponse, {
      journalId: request.journalId,
      expectedVersion: request.expectedVersion,
      ...(request.reason ? { reason: request.reason } : {}),
    });
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
  ): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
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
          ? `the ForgeBridge daemon did not answer within ${this.#timeoutMs}ms`
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
