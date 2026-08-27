/**
 * Trace and span identifiers, W3C shaped.
 *
 * Deliberately built on `crypto.getRandomValues` — the Web Crypto global, which
 * Node, Deno, Bun and browsers all provide — rather than on `node:crypto`.
 * `packages/core` imports no runtime-specific module anywhere else and this is
 * not the file to start: a core that only runs on Node is a core an edge
 * deployment cannot embed.
 */

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    // Fail closed rather than fall back to Math.random. A trace id is not a
    // secret, but a weak one collides, and two runs sharing a trace id produce
    // a trace that is confidently wrong — which is worse than no trace at all.
    throw new Error(
      'telemetry: crypto.getRandomValues is unavailable, so trace ids cannot be generated. ' +
        'Run on a runtime that provides Web Crypto, or install no telemetry adapter.',
    );
  }
  const buffer = new Uint8Array(bytes);
  source.getRandomValues(buffer);
  let out = '';
  for (const byte of buffer) {
    out += HEX[(byte >> 4) & 0x0f];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/** 16 bytes, 32 hex characters. Never all zeroes — the spec forbids it. */
export function newTraceId(): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = randomHex(16);
    if (!/^0+$/.test(id)) return id;
  }
  throw new Error('telemetry: the random source returned only zeroes; refusing to emit an invalid trace id');
}

/** 8 bytes, 16 hex characters. Never all zeroes. */
export function newSpanId(): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = randomHex(8);
    if (!/^0+$/.test(id)) return id;
  }
  throw new Error('telemetry: the random source returned only zeroes; refusing to emit an invalid span id');
}

/** The single sampled flag OTLP and the W3C header share. */
export const SAMPLED = 0x01;
