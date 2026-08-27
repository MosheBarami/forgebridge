import {
  ForgeBridgeError,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ProtocolError,
  type ChangeSet,
  type RollbackRequest,
} from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER } from '@forgebridge/daemon';
import { DaemonRequestError } from './errors.js';

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
 * A client for the daemon's `/v1` surface, and nothing more.
 *
 * This is the whole of the connector's contact with ForgeBridge. Every decision
 * that matters — whether a ChangeSet is valid, whether its paths are permitted,
 * whether it may be applied — is taken on the other side of these calls, in the
 * daemon and in `@forgebridge/core` (ADR-009: connectors are thin). Nothing here
 * interprets a ChangeSet.
 *
 * ── The absence that matters ──────────────────────────────────────────────────
 *
 * There is no `approve()` method, and there must never be one.
 *
 * `POST /v1/changesets/:id/approve` is the gate ADR-012 puts between a model and
 * a creator's place. This server exists to let a model *propose* through that
 * gate, so it must not hold the handle on both sides of it. The boundary is
 * structural rather than conditional: not "the connector decides when it is
 * allowed to approve" — which would be a policy decision living in a connector,
 * and one an argument could talk its way past — but "the call is not written
 * here at all". `test/approval-boundary.test.ts` asserts that no request this
 * package can make reaches an approve path.
 */

/** Injectable for tests; Node 22 supplies the global. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DaemonClientOptions {
  baseUrl: string;
  producerToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long `POST /v1/runs` is given.
 *
 * A separate number because a run is a different kind of request from every
 * other one here: the daemon calls a language model, possibly several in
 * sequence as the router falls back, and thirty seconds would abandon a run
 * that was working. The ceiling still exists — a request with no ceiling is a
 * socket held for the life of the process — but it is sized for the work rather
 * than for a REST read.
 *
 * This connector asks for the JSON form of a run rather than the streamed one:
 * an MCP tool call is a single result, and a tool that streamed would have
 * nowhere to put the frames. The attempt list is on the JSON answer in full, so
 * nothing about ADR-008 is lost by waiting — only the ability to *watch*, which
 * belongs to a terminal (`forgebridge run`) and not to a tool result.
 */
const RUN_TIMEOUT_MS = 10 * 60_000;

/** Paths this client refuses to build, whatever it is asked for. */
const FORBIDDEN_PATH_FRAGMENT = '/approve';

export class DaemonClient {
  readonly baseUrl: string;
  readonly #producerToken: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: DaemonClientOptions) {
    this.baseUrl = withoutTrailingSlashes(options.baseUrl);
    this.#producerToken = options.producerToken;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  health(): Promise<unknown> {
    return this.#request('GET', '/v1/health');
  }

  /** Link status, which also carries the daemon's default project id. */
  linkStatus(): Promise<unknown> {
    return this.#request('GET', '/v1/link');
  }

  submitChangeSet(changeSet: ChangeSet): Promise<unknown> {
    return this.#request('POST', '/v1/changesets', changeSet);
  }

  diff(changeSetId: string): Promise<unknown> {
    return this.#request('GET', `/v1/changesets/${encodeURIComponent(changeSetId)}/diff`);
  }

  rollback(request: RollbackRequest): Promise<unknown> {
    return this.#request('POST', `/v1/journal/${encodeURIComponent(request.journalId)}/rollback`, request);
  }

  output(linkId?: string): Promise<unknown> {
    const query = linkId ? `?link=${encodeURIComponent(linkId)}` : '';
    return this.#request('GET', `/v1/output${query}`);
  }

  models(): Promise<unknown> {
    return this.#request('GET', '/v1/models');
  }

  /**
   * `POST /v1/runs` — a prompt in, a proposed ChangeSet out.
   *
   * Nothing here approves and nothing here applies. The run leaves a ChangeSet
   * in `validated`; approval is `POST /v1/changesets/:id/approve`, which this
   * client does not implement and must not (see the note at the top of this
   * file). A run request has no field that reaches approval either — the shape
   * is `StartRunRequest`, and `forge.start_run` validates against it before
   * anything is sent.
   */
  startRun(request: unknown): Promise<unknown> {
    return this.#request('POST', '/v1/runs', request, RUN_TIMEOUT_MS);
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs: number = this.#timeoutMs,
  ): Promise<unknown> {
    // Belt to the structural braces: an id interpolated into a path cannot turn
    // a read into an approval, but the check costs nothing and it fails loudly
    // if someone ever adds a route here without reading the comment above.
    if (path.includes(FORBIDDEN_PATH_FRAGMENT)) {
      throw new ForgeBridgeError(
        'not_approved',
        'this connector does not make approval requests',
        'Approval is a human action taken in Roblox Studio or in a ForgeBridge client (ADR-012).',
      );
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      [PRODUCER_TOKEN_HEADER]: this.#producerToken,
      [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    };
    // The daemon insists on this content type as a CSRF control, so a body
    // without it is refused before it is read.
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // TODO(M31): the protocol's ErrorCode has no "the transport is not
      // reachable" member, so this lands on `internal` and carries the truth in
      // its remedy. A distinct code is the same additive protocol change
      // `packages/daemon/src/auth.ts` already asks for. Owner: the protocol
      // maintainer. Confirm the code name there before adding one here.
      throw new ForgeBridgeError(
        'internal',
        `the ForgeBridge daemon at ${this.baseUrl} did not answer (${describeCause(cause)})`,
        'Start the daemon with the forgebridge-daemon binary, and check the URL in this MCP server’s configuration.',
      );
    }

    if (response.status === 204) return null;

    const text = await response.text();
    if (!response.ok) throw errorFor(response.status, text);

    if (text === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ForgeBridgeError('internal', 'the daemon returned a body that is not JSON');
    }
  }
}

/**
 * The daemon answers every failure with a `ProtocolError`, so the code it chose
 * is passed through untouched — re-deriving one from the HTTP status would
 * throw away the distinction between the four codes that share a status.
 */
function errorFor(status: number, text: string): DaemonRequestError {
  const parsed = ProtocolError.safeParse(safeJson(text));
  if (parsed.success) return new DaemonRequestError(parsed.data, status);
  return new DaemonRequestError(
    { code: status === 404 ? 'not_found' : 'internal', message: `the daemon answered ${status}` },
    status,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A cause reduced to its name. The message could carry anything. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return 'unknown error';
}
