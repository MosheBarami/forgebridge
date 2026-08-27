import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom implements no `matchMedia`, and the theme switch asks it whether the OS
 * prefers dark while the preference is "system" — which is the default, and so
 * the path every test takes. A stub that always answers "light" is the right
 * one: these tests assert structure and direction, and a test whose result
 * depended on the CI machine's colour scheme would be a flake waiting to
 * happen.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
