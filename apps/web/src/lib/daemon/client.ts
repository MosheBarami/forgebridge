import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  type ChangeSet,
  type ErrorCode,
  type ProtocolError,
} from '@forgebridge/protocol';

import { daemonBaseUrl } from './config';
import {
  ApproveResponse,
  ChangeSetDiff,
  HealthResponse,
  LinkStatusResponse,
  ModelsSnapshot,
  OutputResponse,
  RollbackResponse,
  RunResponse,
  SubmitChangeSetResponse,
  type ApproveRequest,
  type StartRunRequest,
} from './wire';

/**
 * The typed client for the daemon's `/v1` surface.
 *
 * Three things about it that are not incidental:
 *
 * 1. **It runs in the browser.** The daemon listens on the *user's* loopback
 *    interface; a Next server rendering this app — on apple.gg or on a
 *    self-hoster's box — cannot reach it. So every call here is a client-side
 *    `fetch`, and this app ships no route handler that proxies one. That is
 *    also what makes ADR-006 structural rather than a policy: there is no app
 *    route for a key to be POSTed to.
 *
 * 2. **"No daemon" is a return value, not an exception.** For a signed-out
 *    first-time visitor it is the *starting* state. A client that throws on it
 *    pushes every caller into a try/catch that will eventually swallow a real
 *    error too.
 *
 * 3. **Every response is parsed.** A daemon on a different build answers with a
 *    shape this app may not know; that becomes `invalid-response` at the seam
 *    rather than `undefined` in a component.
 */

/** The producer token header. Mirrors `PRODUCER_TOKEN_HEADER` in the daemon. */
export const PRODUCER_TOKEN_HEADER = 'X-ForgeBridge-Token';

export type DaemonFailure =
  /**
   * Nothing answered — or something answered and the browser refused to let us
   * see it. These are genuinely indistinguishable from JavaScript: a daemon
   * that has not been given `--allow-origin` for this page fails the CORS
   * preflight, and `fetch` rejects with the same opaque `TypeError` it throws
   * when no socket is listening. The empty state therefore names both causes
   * instead of guessing at one.
   */
  | { readonly ok: false; readonly reason: 'unreachable'; readonly detail: string }
  /** The daemon answered and said this origin is not permitted. Reachable only
   *  when the request was simple enough to skip preflight; kept distinct
   *  because when it *does* arrive it is the precise diagnosis. */
  | { readonly ok: false; readonly reason: 'origin-rejected'; readonly detail: string }
  /** A producer route without a valid `X-ForgeBridge-Token`. */
  | { readonly ok: false; readonly reason: 'unauthenticated'; readonly detail: string }
  /** The daemon refused, in the protocol's own closed error set. */
  | { readonly ok: false; readonly reason: 'protocol'; readonly error: ProtocolError }
  /** We reached it, it answered 2xx, and the body was not what this build parses. */
  | { readonly ok: false; readonly reason: 'invalid-response'; readonly detail: string };

export type DaemonResult<T> = { readonly ok: true; readonly data: T } | DaemonFailure;

export interface DaemonClientOptions {
  /** Defaults to `daemonBaseUrl()`. */
  readonly baseUrl?: string;
  /**
   * The producer token, when the caller has one.
   *
   * A function rather than a value so a long-lived client picks up a token the
   * user pastes later without being reconstructed. It is held in memory by
   * `session.tsx` and never written to storage — the daemon mints a new one per
   * process, so a persisted copy would be a secret at rest that is also wrong.
   */
  readonly producerToken?: () => string | undefined;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds before a request is abandoned. Long polls opt out. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Producer routes carry the token; the daemon refuses them without it. */
  readonly producer?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function isProtocolError(value: unknown): value is ProtocolError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

const UNAUTHENTICATED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['link_unauthenticated']);

/**
 * One parsed JSON payload per Server-Sent Event frame.
 *
 * Shared by the two routes that stream — `POST /v1/runs` with `stream: true`
 * and `GET /v1/runs/:id/events` — because a second copy of a wire-format reader
 * is a second thing that can be subtly wrong about frame boundaries, and the
 * failure mode of getting that wrong is a run log that silently drops the
 * attempt nobody would notice was missing.
 *
 * Not `EventSource`, which cannot set a request header and so cannot carry the
 * producer token. Reading the body as a stream also means a caller can `break`
 * out of the loop and its `AbortSignal` tears the socket down.
 */
async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE frames are separated by a blank line. Anything after the last
      // separator is a partial frame and stays in the buffer.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (payload.length > 0) {
          try {
            yield JSON.parse(payload) as unknown;
          } catch {
            // A keep-alive or a comment line. Not an error; skip it.
          }
        }
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly #producerToken: () => string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? daemonBaseUrl();
    this.#producerToken = options.producerToken ?? (() => undefined);
    // Bound to `globalThis`: an unbound `fetch` reference throws "Illegal
    // invocation" in some browsers when called as a bare function.
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  hasProducerToken(): boolean {
    const token = this.#producerToken();
    return typeof token === 'string' && token.length > 0;
  }

  // ── endpoints ────────────────────────────────────────────────────────────

  /** `GET /v1/health` — the liveness probe. Public; no token needed. */
  health(signal?: AbortSignal): Promise<DaemonResult<HealthResponse>> {
    return this.#json('/v1/health', HealthResponse, { ...(signal ? { signal } : {}) });
  }

  /**
   * `GET /v1/link` — the link register.
   *
   * `privacyPosture` on the response is one of the three exact strings
   * `PRIVACY_POSTURE` exports. It is rendered verbatim wherever a link is
   * shown; see `components/shell/link-indicator.tsx` and ADR-014.
   */
  linkStatus(signal?: AbortSignal): Promise<DaemonResult<LinkStatusResponse>> {
    return this.#json('/v1/link', LinkStatusResponse, { ...(signal ? { signal } : {}) });
  }

  /** `GET /v1/models` — the catalog snapshot, or the fact that none is wired in. */
  models(signal?: AbortSignal): Promise<DaemonResult<ModelsSnapshot>> {
    return this.#json('/v1/models', ModelsSnapshot, { ...(signal ? { signal } : {}) });
  }

  /** `POST /v1/changesets` — propose. Never applies; the daemon stores it validated. */
  submitChangeSet(changeSet: ChangeSet): Promise<DaemonResult<SubmitChangeSetResponse>> {
    return this.#json('/v1/changesets', SubmitChangeSetResponse, {
      method: 'POST',
      body: changeSet,
      producer: true,
    });
  }

  /** `GET /v1/changesets/:id/diff` — what a human reads before approving. */
  diff(changeSetId: string, signal?: AbortSignal): Promise<DaemonResult<ChangeSetDiff>> {
    return this.#json(`/v1/changesets/${encodeURIComponent(changeSetId)}/diff`, ChangeSetDiff, {
      producer: true,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * `POST /v1/changesets/:id/approve` — the human gate (ADR-012).
   *
   * `contentDigest` is required and comes from the diff the approver read. It
   * is what makes the call mean "I approve the operations I was shown" rather
   * than "I approve some set with this id". A caller that has not loaded a diff
   * has no digest to send, which is the gate working, not an obstacle to route
   * around.
   */
  approve(changeSetId: string, request: ApproveRequest): Promise<DaemonResult<ApproveResponse>> {
    return this.#json(`/v1/changesets/${encodeURIComponent(changeSetId)}/approve`, ApproveResponse, {
      method: 'POST',
      body: request,
      producer: true,
    });
  }

  /** `POST /v1/journal/:id/rollback` — replay the journalled inverse. */
  rollback(
    journalId: string,
    request: { expectedVersion: number; reason?: string },
  ): Promise<DaemonResult<RollbackResponse>> {
    return this.#json(`/v1/journal/${encodeURIComponent(journalId)}/rollback`, RollbackResponse, {
      method: 'POST',
      body: { journalId, ...request },
      producer: true,
    });
  }

  /** `GET /v1/output` — what Studio printed, mirrored back. */
  output(limit?: number, signal?: AbortSignal): Promise<DaemonResult<OutputResponse>> {
    const query = limit === undefined ? '' : `?limit=${String(limit)}`;
    return this.#json(`/v1/output${query}`, OutputResponse, {
      producer: true,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * `POST /v1/runs` — start a run, non-streaming.
   *
   * The response carries `run.attempts`: every model the router tried and why
   * it moved on. Rendering that list is not optional (ADR-008) — a silent
   * substitution is a lie about what wrote the user's code.
   *
   * Runs take longer than the default timeout, so this one waits indefinitely
   * unless the caller passes a signal.
   */
  startRun(request: StartRunRequest, signal?: AbortSignal): Promise<DaemonResult<RunResponse>> {
    return this.#json('/v1/runs', RunResponse, {
      method: 'POST',
      body: { ...request, stream: false },
      producer: true,
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * `POST /v1/runs` with `stream: true` — start a run and watch it happen.
   *
   * This exists because `startRun` above cannot be watched, and the reason is
   * structural rather than a missing feature. The daemon assigns the run id;
   * `StartRunRequest` has no field for one. So a caller that wants the live log
   * has to learn the id *from* the stream — `GET /v1/runs/:id/events` needs an
   * id the caller does not have until the non-streaming POST has already
   * returned, by which time the run is over and there is nothing left to watch.
   *
   * ADR-008 is what makes that gap worth closing rather than living with: the
   * run log must name every model the router tried and why it moved on, and a
   * fallback the user only learns about after the fact is a fallback they could
   * not have interrupted. The frames are the same ones `streamRunEvents` yields
   * — `packages/daemon/src/server.ts#streamRun` writes an initial `run` frame
   * carrying the queued `RunResponse` (which is where the id arrives), then one
   * frame per `RunEvent`, then a final `run` frame with the settled response.
   *
   * Yielded as `unknown` for the same reason `streamRunEvents` does: the
   * channel carries two different shapes and inventing a union at this seam
   * would be inventing a contract. `app/[locale]/generate/run-frames.ts` parses
   * them, because that is where it is known which frames are needed.
   *
   * TODO(M31): when the `/v1` envelopes move into `@forgebridge/protocol`, this
   * and `streamRunEvents` should yield a parsed `RunFrame` from there instead.
   */
  async *startRunStreaming(
    request: StartRunRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown, void, void> {
    if (!this.hasProducerToken()) {
      // Yielded rather than thrown so a caller draining this generator handles
      // one failure shape, not two. The frame is the protocol's own error
      // vocabulary, so the run view renders it the same way it renders a
      // refusal that came from the daemon.
      yield {
        code: 'link_unauthenticated',
        message:
          'Starting a run needs the daemon’s producer token. The daemon prints it once, on the terminal it was started from.',
      };
      return;
    }

    const response = await this.#fetch(`${this.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { ...this.#headers({ producer: true, body: request }), accept: 'text/event-stream' },
      body: JSON.stringify({ ...request, stream: true }),
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      // No timeout: a run is as long as the models take. The caller's signal is
      // the only thing that ends it early.
      ...(signal ? { signal } : {}),
    });

    // The daemon refuses a run it cannot start — no model client, no candidate,
    // a stale base — *before* opening the stream, so those arrive as an
    // ordinary JSON error with a status. Once the stream is open the status is
    // already 200 and failures arrive as frames instead.
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      yield isProtocolError(payload)
        ? payload
        : {
            code: 'internal',
            message: `the daemon answered ${String(response.status)} with an unrecognised body`,
          };
      return;
    }

    if (!response.body) return;
    yield* parseEventStream(response.body);
  }

  /** `GET /v1/runs/:id` — poll a run this client did not start. */
  runStatus(runId: string, signal?: AbortSignal): Promise<DaemonResult<RunResponse>> {
    return this.#json(`/v1/runs/${encodeURIComponent(runId)}`, RunResponse, {
      producer: true,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * `GET /v1/runs/:id/events` — the live run log, as Server-Sent Events.
   *
   * Not `EventSource`, which cannot set a request header and so cannot carry
   * the producer token. This reads the body as a stream and yields one parsed
   * frame per `data:` line, which also means a caller can `break` out of the
   * loop and the `AbortSignal` tears the socket down.
   *
   * Frames are yielded as `unknown`: the daemon emits stage changes, model
   * attempts and a final `RunResponse` on the same channel, and inventing a
   * union here would be inventing a contract. The generation surface (M35)
   * owns that shape once it knows which frames it needs.
   */
  async *streamRunEvents(
    runId: string,
    options: { since?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<unknown, void, void> {
    const query = options.since === undefined ? '' : `?since=${String(options.since)}`;
    const response = await this.#fetch(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events${query}`,
      {
        method: 'GET',
        headers: this.#headers({ producer: true }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    const body = response.body;
    if (!response.ok || !body) return;
    yield* parseEventStream(body);
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  #headers(options: { producer?: boolean; body?: unknown }): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      // Declared so a version mismatch comes back as a clean `unsupported_version`
      // rather than as a body neither side can parse.
      [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.producer) {
      const token = this.#producerToken();
      if (token) headers[PRODUCER_TOKEN_HEADER] = token;
    }
    return headers;
  }

  async #json<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<DaemonResult<z.infer<S>>> {
    const producer = options.producer === true;
    if (producer && !this.hasProducerToken()) {
      return {
        ok: false,
        reason: 'unauthenticated',
        detail:
          'This route needs the daemon’s producer token. The daemon prints it once, on the terminal it was started from.',
      };
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : undefined;
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: this.#headers({ producer, body: options.body }),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        // The daemon is a different origin from this page and answers with an
        // explicit allow-list; it never wants our cookies.
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      if (isProtocolError(payload)) {
        if (UNAUTHENTICATED_CODES.has(payload.code) && producer) {
          return { ok: false, reason: 'unauthenticated', detail: payload.message };
        }
        // The daemon reports a rejected browser origin as `invalid_request`
        // with this remedy attached; matching on the remedy lets the UI give
        // the precise fix instead of the generic one.
        if (payload.remedy?.includes('--allow-origin')) {
          return { ok: false, reason: 'origin-rejected', detail: payload.message };
        }
        return { ok: false, reason: 'protocol', error: payload };
      }
      return {
        ok: false,
        reason: 'protocol',
        error: {
          code: 'internal',
          message: `the daemon answered ${String(response.status)} with an unrecognised body`,
        },
      };
    }

    const raw = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-response',
        detail: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      };
    }
    return { ok: true, data: parsed.data as z.infer<S> };
  }
}

/** A client bound to the configured base URL, for callers with no token needs. */
export function createDaemonClient(options: DaemonClientOptions = {}): DaemonClient {
  return new DaemonClient(options);
}
