/**
 * The provider adapters (M22–M24), and the one thing they all obey.
 *
 * Each file here owns the HTTP of one vendor — the URL, the header, the request
 * body, the response mapping, and the classification of a failure — because
 * ADR-005/011 puts a vendor behind an adapter so that self-hosting against a
 * different one is a new file rather than a fork of the pipeline. Nothing in
 * `packages/core` names any of them.
 *
 * What is shared is deliberately small and is shared rather than copied:
 * `outcomeForStatus` decides an outcome from an HTTP status and from nothing
 * else, once, for every adapter in this directory. ADR-008 is why, and
 * `../openrouter.ts` carries the argument.
 *
 * - `openai-compatible.ts` — OpenAI, Google, Mistral, Groq, Together, DeepSeek.
 * - `anthropic.ts`         — the Messages API, which is not OpenAI-compatible
 *                            and is not treated as though it were.
 * - `local.ts`             — Ollama, LM Studio, llama.cpp, vLLM, discovered by
 *                            probing loopback ports. Finding nothing is normal
 *                            and silent.
 * - `openrouter-oauth.ts`  — OpenRouter's PKCE flow, so no key is pasted.
 * - `multi.ts`             — one client over all of them, dispatching by the
 *                            candidate's provider.
 *
 * TODO(M22): `../index.ts` does not re-export this barrel, and the package's
 * `exports` map has only `"."` — so everything here is reachable from inside
 * `@forgebridge/daemon` (which is where the wiring belongs: `../bin.ts` is the
 * composition root) and from nowhere outside it. Adding
 * `export * from './providers/index.js';` to `../index.ts` is the whole change,
 * and it belongs to whoever owns that file.
 */
export * from './openai-compatible.js';
export * from './anthropic.js';
export * from './local.js';
export * from './openrouter-oauth.js';
export * from './multi.js';
