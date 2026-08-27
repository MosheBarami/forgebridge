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
   * TODO(M04b): the repository still has no linter — every package's `lint`
   * script is an `echo`. Next 15 needed `eslint: { ignoreDuringBuilds: true }`
   * here to stop `next build` offering to install and configure ESLint for this
   * app alone, which would give one package a linter the other nine do not have
   * and pre-empt the decision M04b exists to make. Next 16 dropped that key from
   * NextConfig and no longer runs ESLint during a build at all, so the block is
   * gone rather than relocated. When a real linter lands it is wired for the
   * whole workspace, not here.
   */

  /** Nothing gained by announcing the framework on every response. */
  poweredByHeader: false,
};

export default config;
