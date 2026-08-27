import type { ServerResponse } from 'node:http';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@forgebridge/protocol';
import type { RunEvent } from '@forgebridge/core';

/**
 * Watching a run happen.
 *
 * ADR-008's requirement is not that the daemon record which models it tried —
 * `Run.attempts` does that, and it is on every response — but that the caller
 * can *see* the fallback. A run that spends ninety seconds on a rate-limited
 * free model before falling through to the next one is indistinguishable, from
 * the outside, from a hung daemon; and a fallback nobody watched is a silent
 * substitution that happens to be written down afterwards.
 *
 * So each run gets a log here: an in-memory record of its events, plus the set
 * of responses currently following it. Both halves are deliberately in memory
 * and deliberately capped:
 *
 *   - **In memory**, next to `#keyring` and for the same reason. A run's event
 *     stream is live state about a process that is running now; a persistent
 *     adapter that wrote it to disk would be writing the model's partial output
 *     — the prompt's answer, before anyone approved anything — into a file
 *     nobody asked for. The durable half of a run is its `RunRecord`, which the
 *     store holds and which carries the attempt list.
 *   - **Capped**, because `output-delta` arrives once per token. See
 *     `isRetained`: deltas are broadcast to whoever is watching and are never
 *     kept, which is the honest reading of what they are — a live view, not a
 *     record. Everything a reader needs after the fact is in the `RunRecord`.
 */

export interface RecordedRunEvent {
  /** Monotonic from zero, per run. It is the SSE `id:` and the `?since=` cursor. */
  index: number;
  event: RunEvent;
}

/** How many retained events one run may accumulate before the oldest are dropped. */
export const MAX_RETAINED_EVENTS = 500;

/** How many runs' logs are kept resident. Older logs are evicted whole. */
export const MAX_RESIDENT_RUN_LOGS = 32;

/**
 * True when an event is worth keeping after the run ends.
 *
 * Everything except `output-delta`. A delta is one fragment of a model's answer
 * and there are thousands of them; keeping them would turn a bounded log into a
 * second copy of the generated source, held for the life of the process, for a
 * replay nobody wants.
 */
export function isRetained(event: RunEvent): boolean {
  return event.type !== 'output-delta';
}

export type RunEventListener = (recorded: RecordedRunEvent) => void;
export type RunEventCloseListener = () => void;

export class RunEventLog {
  readonly #retained: RecordedRunEvent[] = [];
  readonly #listeners = new Map<RunEventListener, RunEventCloseListener | undefined>();
  #next = 0;
  #closed = false;
  /** True once the cap has dropped an event, so a follower is told rather than misled. */
  #truncated = false;

  get closed(): boolean {
    return this.#closed;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  /** Broadcast, then keep — in that order, so a follower sees a delta before it is dropped. */
  publish(event: RunEvent): RecordedRunEvent {
    const recorded: RecordedRunEvent = { index: this.#next, event };
    this.#next += 1;

    for (const listener of [...this.#listeners.keys()]) {
      try {
        listener(recorded);
      } catch {
        // A follower that throws is one broken response. It must not take the
        // run with it, and there is nowhere here to report it to — the run's
        // own outcome is what the caller is waiting on.
      }
    }

    if (isRetained(event)) {
      this.#retained.push(recorded);
      if (this.#retained.length > MAX_RETAINED_EVENTS) {
        this.#retained.splice(0, this.#retained.length - MAX_RETAINED_EVENTS);
        this.#truncated = true;
      }
    }
    return recorded;
  }

  /** Retained events with an index at or above the cursor, oldest first. */
  since(index: number): RecordedRunEvent[] {
    return this.#retained.filter((recorded) => recorded.index >= index);
  }

  /**
   * Follow.
   *
   * `onClose` fires when the run ends, because a follower has no other way to
   * learn that: the absence of further events is indistinguishable from a model
   * that is still thinking, and a streamed response that never ends is a
   * connection held open forever on both sides.
   *
   * The returned function unsubscribes and must be called on every path — a
   * listener left behind by a client that hung up is a response object held for
   * the life of the process.
   */
  subscribe(listener: RunEventListener, onClose?: RunEventCloseListener): () => void {
    this.#listeners.set(listener, onClose);
    return () => this.#listeners.delete(listener);
  }

  /** The run is over. Followers are told and released; the retained events stay readable. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const onClose of [...this.#listeners.values()]) {
      try {
        onClose?.();
      } catch {
        // As above: one broken follower is not the run's problem.
      }
    }
    this.#listeners.clear();
  }
}

/** The resident logs, oldest evicted first. */
export class RunEventLogs {
  readonly #logs = new Map<string, RunEventLog>();
  readonly #limit: number;

  constructor(limit: number = MAX_RESIDENT_RUN_LOGS) {
    this.#limit = limit;
  }

  open(runId: string): RunEventLog {
    const log = new RunEventLog();
    this.#logs.set(runId, log);
    // Map iteration is insertion-ordered, so the first key is the oldest log.
    while (this.#logs.size > this.#limit) {
      const oldest = this.#logs.keys().next();
      if (oldest.done) break;
      this.#logs.get(oldest.value)?.close();
      this.#logs.delete(oldest.value);
    }
    return log;
  }

  get(runId: string): RunEventLog | undefined {
    return this.#logs.get(runId);
  }

  /** Release every follower. Called when the daemon closes. */
  closeAll(): void {
    for (const log of this.#logs.values()) log.close();
    this.#logs.clear();
  }
}

// ── server-sent events ───────────────────────────────────────────────────────

/**
 * How often a comment frame is written on an otherwise silent stream.
 *
 * A model can think for a minute without emitting a token. Nothing on loopback
 * will time that out, but a caller behind its own read timeout — or a proxy an
 * operator put in front of a self-hosted daemon — cannot tell a thinking model
 * from a dead socket, and a keep-alive costs two bytes.
 */
export const EVENT_STREAM_KEEP_ALIVE_MS = 15_000;

/**
 * Open a `text/event-stream`.
 *
 * `no-store` and `X-Accel-Buffering: no` because a buffering intermediary turns
 * a live run log into one large response delivered at the end, which is the one
 * thing this endpoint exists not to be.
 */
export function beginEventStream(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
    [PROTOCOL_VERSION_HEADER.toLowerCase()]: PROTOCOL_VERSION,
    ...extraHeaders,
  });
  res.flushHeaders();
}

/**
 * One frame. `name` is the SSE event type a client filters on; `id` is the
 * cursor it would resume from.
 *
 * The payload is serialised on one line — `JSON.stringify` never emits a raw
 * newline, and a `data:` field that contained one would be read as two fields
 * by any conforming client.
 */
export function writeEventFrame(
  res: ServerResponse,
  name: string,
  data: unknown,
  id?: number,
): void {
  if (res.writableEnded || res.destroyed) return;
  const lines = id === undefined ? [] : [`id: ${id}`];
  lines.push(`event: ${name}`, `data: ${JSON.stringify(data)}`, '', '');
  res.write(lines.join('\n'));
}

/** A comment frame. Ignored by clients; keeps the connection observably alive. */
export function writeKeepAlive(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(': keep-alive\n\n');
}

export function endEventStream(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.end();
}
