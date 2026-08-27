import { z } from 'zod';
import {
  PRODUCER_TOKEN_HEADER,
  ChangeSetDiff as ChangeSetDiffSchema,
  HealthResponse as HealthSchema,
  LinkStatusResponse as LinkStatusSchema,
  ModelsSnapshot as ModelsSnapshotSchema,
  RollbackResponse as RollbackResponseSchema,
  RunResponse as RunResponseSchema,
  type ChangeSetDiff,
  type HealthResponse,
  type LinkStatusResponse,
  type ModelsSnapshot,
  type RollbackResponse,
  type RunResponse,
  type StartRunRequest,
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

/**
 * How long a run may go quiet before this client gives up on it.
 *
 * Not a ceiling on the run: a model that thinks for four minutes and then
 * answers is a run that worked, and a total timeout would kill it. The daemon
 * writes a keep-alive comment frame every 15 seconds on an otherwise silent
 * stream (`EVENT_STREAM_KEEP_ALIVE_MS`), so silence for two minutes is a dead
 * socket rather than a slow model — and this is the only reading that tells the
 * two apart without guessing at how long a prompt should take.
 */
export const RUN_IDLE_TIMEOUT_MS = 120_000;

/**
 * One frame off `POST /v1/runs` in its streamed form.
 *
 * `name` is the SSE event type — a `RunEvent.type` from `@forgebridge/core`,
 * or one of the daemon's own frames (`run`, `error`, `closed`, `truncated`).
 * `data` is left `unknown` on purpose: this package does not depend on the
 * core, so the event union is not importable here, and a hand-written copy of
 * it would be a copy that goes stale the first time the core adds an event. The
 * two frames that decide the *outcome* of the call — `run` and `error` — are
 * parsed against the schemas the daemon publishes, and everything else is
 * handed to the caller as it arrived, to render or to ignore.
 */
export interface RunStreamFrame {
  name: string;
  data: unknown;
  /** The SSE `id:`, which is the `?since=` cursor for `GET /v1/runs/:id/events`. */
  id?: number;
}

export type RunFrameListener = (frame: RunStreamFrame) => void;

/**
 * What a caller may say about a run.
 *
 * `stream` is deliberately not on it. The client sets that field from whether
 * it was handed a listener, so the request and the way the answer is read
 * cannot disagree — a caller that asked for a stream and then did not read one
 * would hold a socket open until the daemon gave up on it. `policy` is optional
 * here where the wire schema defaults it, so omitting it means "whatever this
 * transport defaults to" rather than this package writing down a default of its
 * own that would go stale the day the daemon changed its mind.
 */
export type StartRunInput = Omit<StartRunRequest, 'stream' | 'policy'> & {
  policy?: StartRunRequest['policy'];
};

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
  /**
   * Start a run and, when a listener is given, follow it while it happens.
   *
   * The listener is what makes fallback visible rather than merely recorded
   * (ADR-008): a run that spends ninety seconds on a rate-limited free model
   * before falling through is, without it, indistinguishable from a hung
   * daemon. Passing none asks for the JSON form, which answers once at the end
   * and carries the same attempt list.
   *
   * Returns the run the daemon settled on. It never applies anything: the
   * ChangeSet a run produces is stored `validated`, and approval is a separate
   * act on a route this client does not implement (ADR-012).
   */
  startRun(request: StartRunInput, onFrame?: RunFrameListener): Promise<RunResponse>;
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

  /**
   * `POST /v1/runs`.
   *
   * Two shapes, one route. With a listener the request asks for
   * `text/event-stream` and this reads the frames as they arrive; without one it
   * asks for JSON and waits. Either way the answer is the same `RunResponse`,
   * because the streamed form's last `run` frame *is* the JSON body — a client
   * that had to reconstruct the result from the events it happened to catch
   * would be a client whose answer depended on how fast it was reading.
   *
   * The daemon refuses some runs before it opens the stream — no model client,
   * a stale base version, `pinned` with nothing pinned — and those arrive as an
   * ordinary JSON `ProtocolError` with a status on it. So the content type
   * decides how the body is read, not the flag that was sent.
   */
  async startRun(request: StartRunInput, onFrame?: RunFrameListener): Promise<RunResponse> {
    const streaming = onFrame !== undefined;
    const response = await this.#send('POST', '/v1/runs', {
      producer: true,
      body: { ...request, stream: streaming },
      accept: streaming ? 'text/event-stream, application/json' : 'application/json',
      // A run is not a request that finishes in fifteen seconds. The idle
      // ceiling below replaces the wall-clock one: it measures silence, which
      // is the thing that actually distinguishes a dead socket from a model
      // that is still writing.
      idleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
    });

    if (!response.ok) throw await this.#refusal(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const payload: unknown = await response.json().catch(() => undefined);
      return this.#parseRun(payload);
    }

    let latest: unknown;
    let sawRun = false;
    for await (const frame of readEventStream(response)) {
      if (frame.name === 'error') {
        // The headers went out with the first frame, so the daemon had no
        // status left to set and said what happened in the stream instead.
        // Reported here in the same words a JSON caller would have read.
        const parsed = ProtocolError.safeParse(frame.data);
        throw parsed.success
          ? operationFailed(`${parsed.data.code}: ${parsed.data.message}`, parsed.data.remedy, parsed.data.code)
          : operationFailed('the run stream reported a failure this build does not recognise');
      }
      if (frame.name === 'run') {
        latest = frame.data;
        sawRun = true;
        continue;
      }
      onFrame?.(frame);
    }

    if (!sawRun) {
      throw operationFailed(
        'the run stream ended without reporting the run — nothing can be said about which models were tried',
        'Read GET /v1/runs/<id>/events, or re-run without following the stream.',
      );
    }
    return this.#parseRun(latest);
  }

  #parseRun(payload: unknown): RunResponse {
    const parsed = RunResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw operationFailed(
        `POST /v1/runs answered with a body this build does not recognise: ${parsed.error.issues[0]?.message ?? 'rejected'}`,
        'The transport may be running a different protocol version. Compare `forgebridge status` with the daemon build.',
      );
    }
    return parsed.data;
  }

  async #request<T extends z.ZodTypeAny>(
    schema: T,
    method: string,
    path: string,
    options: { producer: boolean; body?: unknown },
  ): Promise<z.infer<T>> {
    const response = await this.#send(method, path, options);
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

  /** One request, with the headers every route on this surface expects. */
  async #send(
    method: string,
    path: string,
    options: { producer: boolean; body?: unknown; accept?: string; idleTimeoutMs?: number },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/json',
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

    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        // An idle ceiling is a timer this client resets as the body arrives, so
        // it cannot be expressed as one `AbortSignal.timeout`. `readEventStream`
        // owns it; the request itself is left unbounded in that case, which is
        // safe because a stream that goes quiet is aborted by the reader.
        ...(options.idleTimeoutMs === undefined ? { signal: AbortSignal.timeout(this.#timeoutMs) } : {}),
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
    // The code is carried on the error as well as in the sentence. A caller
    // embedding this package branches on the field; the person at the terminal
    // reads the sentence, and the two cannot drift apart because both come from
    // the payload the daemon sent.
    return operationFailed(`${code}: ${message}`, remedy, code);
  }
}

/**
 * Read a `text/event-stream` body, one frame at a time.
 *
 * Written here rather than pulled in, for the reason `args.ts` gives about
 * `parseArgs`: this is thirty lines against a format that is four field names,
 * on a binary whose other job is holding a producer token. The parts of the
 * format that matter are all present — `event:`, `data:`, `id:`, the blank line
 * that ends a frame, and the `:` comment the daemon uses as a keep-alive — and
 * the parts that do not (`retry:`, multi-line `data:` reassembly beyond a join)
 * are handled by the same rules rather than ignored.
 *
 * The idle ceiling lives here because it is the reader that knows when the last
 * byte arrived. Each read races a timer, and a read that loses cancels the body
 * — which is what closes the socket, and is also what tells the daemon that the
 * caller has gone, so it stops spending the user's credit on a run nobody will
 * see.
 *
 * It measures silence *after* the response begins. Whatever bounds the wait for
 * the response itself belongs to the `fetch` this client was given, which is
 * why `ClientOptions.fetch` exists — a caller that needs a hard ceiling on the
 * whole exchange supplies one that imposes it.
 */
export async function* readEventStream(
  response: Response,
  idleTimeoutMs: number = RUN_IDLE_TIMEOUT_MS,
): AsyncGenerator<RunStreamFrame> {
  const body = response.body;
  if (!body) {
    throw operationFailed('the transport answered with an event stream that has no body');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let timedOut = false;

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<'idle'>((resolve) => {
        timer = setTimeout(() => resolve('idle'), idleTimeoutMs);
        timer.unref?.();
      });

      // Derived from the reader rather than named: `ReadableStreamReadResult`
      // is not in this project's lib set, and writing the shape out by hand would
      // be a second, weaker copy of what `read()` already promises.
      const read = reader.read();
      // The idle path abandons this promise, and an abandoned rejection with no
      // handler takes the process down. Attached before the race, not after.
      read.catch(() => {});

      let result: Awaited<typeof read> | 'idle';
      try {
        result = await Promise.race([read, idle]);
      } finally {
        clearTimeout(timer);
      }

      if (result === 'idle') {
        timedOut = true;
        break;
      }
      if (result.done) break;

      buffered += decoder.decode(result.value, { stream: true });

      // A frame ends at a blank line. `\r\n` is legal in the format and the
      // daemon does not emit it, so it is normalised rather than trusted.
      buffered = buffered.replace(/\r\n/g, '\n');
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = parseEventFrame(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 2);
        if (frame) yield frame;
        boundary = buffered.indexOf('\n\n');
      }
    }
  } finally {
    // Cancelling releases the socket on every path — a thrown listener, a
    // caller that stopped iterating, the idle ceiling above.
    await reader.cancel().catch(() => {});
  }

  if (timedOut) {
    throw operationFailed(
      `the run stream went quiet for ${idleTimeoutMs / 1000}s — the daemon keeps a live stream alive every ${EVENT_STREAM_KEEP_ALIVE_SECONDS}s, so this is a dropped connection rather than a slow model`,
      'The run itself may still be recorded: read it with GET /v1/runs/<id>, or follow it again from GET /v1/runs/<id>/events.',
    );
  }
}

/** What the daemon's keep-alive interval is, in seconds, for the message above. */
const EVENT_STREAM_KEEP_ALIVE_SECONDS = 15;

/**
 * One frame's fields.
 *
 * A frame with no `data:` is a comment or a keep-alive and is dropped — it
 * carries nothing to render, and passing it on as an event with an undefined
 * payload would make every listener check for it. A `data:` that is not JSON is
 * kept as its own text rather than discarded: the daemon only ever writes JSON
 * there, so a non-JSON payload is a fact about the transport worth surfacing,
 * not a parse error worth swallowing.
 */
function parseEventFrame(raw: string): RunStreamFrame | null {
  let name = 'message';
  let id: number | undefined;
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon is part of the field value's encoding.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) id = parsed;
    }
  }

  if (data.length === 0) return null;
  const text = data.join('\n');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { name, data: payload, ...(id === undefined ? {} : { id }) };
}
