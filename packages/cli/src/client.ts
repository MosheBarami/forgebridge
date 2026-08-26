import { z } from 'zod';
import {
  PRODUCER_TOKEN_HEADER,
  ChangeSetDiff as ChangeSetDiffSchema,
  HealthResponse as HealthSchema,
  LinkStatusResponse as LinkStatusSchema,
  ModelsSnapshot as ModelsSnapshotSchema,
  RollbackResponse as RollbackResponseSchema,
  type ChangeSetDiff,
  type HealthResponse,
  type LinkStatusResponse,
  type ModelsSnapshot,
  type RollbackResponse,
} from '@forgebridge/daemon';
import { ProtocolError, PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER, type RollbackRequest } from '@forgebridge/protocol';
import { daemonUnreachable, operationFailed, usageError } from './exit.js';

/**
 * The transport, spoken over HTTP.
 *
 * This file is the whole of the CLI's knowledge of the wire, and it holds no
 * decisions: it turns a method call into a `/v1` request and a response back
 * into a parsed protocol type. Every judgement about whether something is
 * allowed — is this ChangeSet approved, is this path writable, is this
 * validation clean — belongs to `@forgebridge/core` behind the daemon, and a
 * connector that recomputed any of it would be a second, weaker opinion racing
 * the real one (ADR-009).
 *
 * ── The method that is deliberately absent ───────────────────────────────────
 *
 * There is no `approve()`. `POST /v1/changesets/:id/approve` exists on the
 * daemon and this client will not call it, because approval is the human gate
 * ADR-012 puts between a model and someone's place, and `forgebridge apply`
 * must not be able to clear its own work even by mistake. Stating that as a
 * missing method rather than as an unused branch means no future flag, no
 * `--yes`, and no refactor can reach it without someone adding the capability
 * back on purpose.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface ClientOptions {
  /** Base address of the transport, e.g. `http://127.0.0.1:7317`. */
  baseUrl: string;
  /** The daemon's producer token. Required by the producer routes only. */
  token?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * What the CLI can ask a transport for.
 *
 * An interface rather than only a class so a test can supply a stub without a
 * socket — and so the surface a command is handed is exactly the surface it may
 * use. The absence of `approve` above is only a guarantee if it is absent from
 * the type a command programs against, too.
 */
export interface Transport {
  health(): Promise<HealthResponse>;
  linkStatus(): Promise<LinkStatusResponse>;
  models(): Promise<ModelsSnapshot>;
  diff(changeSetId: string): Promise<ChangeSetDiff>;
  rollback(request: RollbackRequest): Promise<RollbackResponse>;
}

export class DaemonClient implements Transport {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  health(): Promise<HealthResponse> {
    return this.#request(HealthSchema, 'GET', '/v1/health', { producer: false });
  }

  linkStatus(): Promise<LinkStatusResponse> {
    return this.#request(LinkStatusSchema, 'GET', '/v1/link', { producer: false });
  }

  models(): Promise<ModelsSnapshot> {
    return this.#request(ModelsSnapshotSchema, 'GET', '/v1/models', { producer: false });
  }

  /**
   * The rendered diff.
   *
   * A producer route despite being a read: it serves script source and property
   * values out of the user's place, which is place content and not public
   * surface. The daemon marks it as such and so does this.
   */
  diff(changeSetId: string): Promise<ChangeSetDiff> {
    return this.#request(ChangeSetDiffSchema, 'GET', `/v1/changesets/${encodeURIComponent(changeSetId)}/diff`, {
      producer: true,
    });
  }

  rollback(request: RollbackRequest): Promise<RollbackResponse> {
    return this.#request(
      RollbackResponseSchema,
      'POST',
      `/v1/journal/${encodeURIComponent(request.journalId)}/rollback`,
      { producer: true, body: request },
    );
  }

  async #request<T extends z.ZodTypeAny>(
    schema: T,
    method: string,
    path: string,
    options: { producer: boolean; body?: unknown },
  ): Promise<z.infer<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      // Declared so the daemon can refuse a major-version mismatch outright
      // rather than half-answering a client that will misread the reply.
      [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    };

    if (options.producer) {
      if (!this.#token) {
        throw usageError(
          `this command calls a producer route and needs the daemon's producer token`,
          'Pass --token <value>, or export FORGEBRIDGE_PRODUCER_TOKEN. The daemon prints the token once, on the terminal it was started from.',
        );
      }
      headers[PRODUCER_TOKEN_HEADER] = this.#token;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      // Nothing answered. Distinct from a refusal so a pipeline can tell "start
      // the daemon" from "the daemon said no" without scraping a message.
      throw daemonUnreachable(
        `no daemon answered at ${this.#baseUrl} (${error instanceof Error ? error.message : String(error)})`,
        'Start one with `forgebridge daemon`, or point at another with --url.',
      );
    }

    if (!response.ok) throw await this.#refusal(response);

    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      // A 200 whose body does not match the contract is a protocol failure, not
      // a user error. Say which endpoint, so the report names the culprit.
      throw operationFailed(
        `${method} ${path} answered with a body this build does not recognise: ${parsed.error.issues[0]?.message ?? 'rejected'}`,
        'The transport may be running a different protocol version. Compare `forgebridge status` with the daemon build.',
      );
    }
    return parsed.data;
  }

  /**
   * Turn a non-2xx into the refusal the daemon meant.
   *
   * `ProtocolError` carries `code`, `message` and `remedy`; all three are worth
   * more than the status number, and `remedy` is written for exactly the person
   * about to read this in a terminal. A body that is not a `ProtocolError` falls
   * back to the status, because inventing a code would put a string in front of
   * a user that no `ErrorCode` in the protocol will ever match.
   */
  async #refusal(response: Response): Promise<Error> {
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = ProtocolError.safeParse(payload);
    if (!parsed.success) {
      return operationFailed(`the transport refused with HTTP ${response.status}`);
    }
    const { code, message, remedy } = parsed.data;
    return operationFailed(`${code}: ${message}`, remedy);
  }
}
