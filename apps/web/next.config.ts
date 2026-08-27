import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * The monorepo root, stated rather than inferred.
   *
   * Next walks up looking for a lockfile and stops at the first one it finds.
   * On a developer machine that can be a stray `package-lock.json` in the home
   * directory — it was, here — and output file tracing then treats the whole
   * home directory as the workspace. Pointing at our own root makes the answer
   * the same on every machine and in CI.
   */
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),

  /**
   * `@forgebridge/protocol` ships ESM with explicit `.js` specifiers, built by
   * `tsc` into `dist/`. Transpiling it here means a workspace change is picked
   * up without a stale `dist/` silently serving the old contract in dev.
   */
  transpilePackages: ['@forgebridge/protocol'],

  /**
   * TODO(M04b): the repository has no linter yet — every package's `lint`
   * script is an `echo`. `next build` would otherwise stop and offer to install
   * and configure ESLint for this app alone, which would give one package a
   * linter the other eight do not have and pre-empt the decision M04b exists to
   * make. Delete this block when a real linter lands.
   */
  eslint: { ignoreDuringBuilds: true },

  /** Nothing gained by announcing the framework on every response. */
  poweredByHeader: false,
};

export default config;
