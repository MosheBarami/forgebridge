import type { ServerResponse } from 'node:http';
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@forgebridge/protocol';

/**
 * `text/event-stream` plumbing for `GET /v1/runs/:id/events`.
 *
 * `X-Accel-Buffering: no` is not decoration: an event stream behind a buffering
 * proxy arrives all at once when the run ends, which is the same user
 * experience as no stream at all and much harder to diagnose. A relay is by
 * definition behind a proxy, so the header that turns buffering off is part of
 * the response rather than something the operator is expected to know.
 */
export function beginEventStream(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    [PROTOCOL_VERSION_HEADER.toLowerCase()]: PROTOCOL_VERSION,
    ...extraHeaders,
  });
}

export function writeEventFrame(res: ServerResponse, event: string, data: unknown, id?: number): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(data);
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  res.write(`${idLine}event: ${event}\ndata: ${payload}\n\n`);
}

export function writeKeepAlive(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(': keep-alive\n\n');
}

export function endEventStream(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.end();
}

export const EVENT_STREAM_KEEP_ALIVE_MS = 15_000;
