import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Two kinds of test live here and they need different environments.
 *
 * Component tests render into a DOM, so they want jsdom and the matchMedia
 * stub in `setup.ts`. The source gates — the token comparison, the RTL scan —
 * never render anything; they read this package's own files off disk and
 * assert on the text. Under jsdom `import.meta.url` is an http URL, so
 * `fileURLToPath` on it throws and the gate dies before it can check anything.
 *
 * The split is by extension because that is already what the two kinds look
 * like: a test that renders ends in `.tsx`, a test that reads source does not.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { '@': src } },
        test: {
          name: 'components',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.tsx'],
          css: false,
        },
      },
      {
        resolve: { alias: { '@': src } },
        test: {
          name: 'gates',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
  },
});
