/**
 * Read a `text/event-stream` body, one frame at a time.
 *
 * The writer on the other end is `writeEventFrame` in
 * `packages/daemon/src/runs.ts`: `id:` when the frame has an index, then
 * `event:`, then a single `data:` line of JSON, then a blank line — plus a `:`
 * comment frame as a keep-alive on an otherwise silent stream. This reader
 * handles the general form of all four fields rather than only that shape,
 * because a reader written to exactly one writer breaks the first time the
 * writer is legal and different.
 *
 * Written here rather than shared with `packages/cli`, which reads the same
 * stream: this package must be droppable into somebody else's project, and a
 * client that pulled a command-line tool in behind it would not be. The cost is
 * a second implementation of a four-field format; the alternative was a
 * dependency edge from an SDK to a CLI.
 *
 * ── The idle ceiling ─────────────────────────────────────────────────────────
 *
 * A run waits on a language model, and on the router's fallback through however
 * many models the policy allows, so no wall-clock ceiling can tell a slow run
 * from a dead socket — a model that thinks for four minutes and then answers is
 * a run that worked. What separates them is *silence*: the daemon writes a
 * keep-alive comment frame on an idle stream, so a stream that says nothing at
 * all for long enough is a dropped connection. That is the only reading of the
 * two that does not require guessing how long a prompt should take.
 */
import { TransportError } from './errors.js';

/** One frame off a `/v1` event stream. */
export interface EventFrame {
  /**
   * The SSE event type. For a run stream that is a core `RunEvent.type`, or one
   * of the daemon's own frames — `run`, `error`, `closed`, `truncated`.
   *
   * `data` is left `unknown` on purpose. This package does not depend on
   * `@forgebridge/core`, so the event union is not importable here, and a
   * hand-written copy of it would be a copy that goes stale the first time the
   * core adds an event. The two frames that decide the outcome of a run — `run`
   * and `error` — are parsed against the generated schemas by the caller;
   * everything else is handed over as it arrived, to render or to ignore.
   */
  name: string;
  data: unknown;
  /** The SSE `id:`, which is the `?since=` cursor for `GET /v1/runs/{id}/events`. */
  id?: number;
}

export const DEFAULT_RUN_IDLE_TIMEOUT_MS = 120_000;

/**
 * One frame's fields.
 *
 * A frame with no `data:` is a comment or a keep-alive and is dropped — it
 * carries nothing to hand a listener, and passing it on as an event with an
 * undefined payload would make every listener check for it. A `data:` that is
 * not JSON is kept as its own text rather than discarded: the daemon only ever
 * writes JSON there, so a non-JSON payload is a fact about the transport worth
 * surfacing, not a parse error worth swallowing.
 */
export function parseEventFrame(raw: string): EventFrame | null {
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
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = text;
  }
  return { name, data: payload, ...(id === undefined ? {} : { id }) };
}

/**
 * Yield frames until the body ends, or until the stream has been silent for
 * `idleTimeoutMs`.
 *
 * The ceiling lives here because the reader is what knows when the last byte
 * arrived. Each read races a timer, and a read that loses cancels the body —
 * which closes the socket, and also tells the daemon that the caller has gone,
 * so it stops spending the user's credit on a run nobody will see.
 */
export async function* readEventStream(
  response: Response,
  idleTimeoutMs: number = DEFAULT_RUN_IDLE_TIMEOUT_MS,
): AsyncGenerator<EventFrame> {
  const body = response.body;
  if (!body) {
    throw new TransportError('the transport answered with an event stream that has no body', response.status);
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
    // Cancelling releases the socket on every path — a thrown listener, a caller
    // that stopped iterating, the idle ceiling above.
    await reader.cancel().catch(() => {});
  }

  if (timedOut) {
    throw new TransportError(
      `the event stream was silent for ${Math.round(idleTimeoutMs / 1000)}s. The daemon writes a keep-alive frame on ` +
        'an idle stream, so this is a dropped connection rather than a slow model. The run itself may still be ' +
        'recorded: read it with getRun(runId), or follow it again with watchRun(runId).',
    );
  }
}
