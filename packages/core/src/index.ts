export * from './clock.js';
export * from './ports/index.js';
export * from './policy.js';
export * from './breaker.js';
export * from './router.js';
export * from './validate.js';
export * from './prompt.js';
export * from './pipeline.js';
export * from './run.js';

/**
 * Two interfaces in this package are called `ModelClient`, and both are real.
 *
 *   - `ports/model.ts` — the port: `complete`, optionally `stream`. This is the
 *     boundary B2 in `scripts/verify-boundaries.ts` protects, and the one an
 *     adapter package implements. It is the `ModelClient` this package exports.
 *   - `pipeline.ts` — the stage adapter `RunPipeline` takes: `plan` and
 *     `generate`, each already returning a router `InvocationResult`. It is a
 *     narrower thing, one layer up, and it keeps its name inside its own module;
 *     from the package root it is `StageModelClient`.
 *
 * Both are exported explicitly because two `export *` offering one name is
 * ambiguous, and an ambiguity TypeScript resolves by dropping the symbol is a
 * worse outcome than a second name that says which is which.
 */
export type { ModelClient } from './ports/model.js';
export type { ModelClient as StageModelClient } from './pipeline.js';
