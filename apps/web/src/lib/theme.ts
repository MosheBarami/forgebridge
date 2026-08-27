/**
 * Theme preference.
 *
 * Three values, not two. "System" is a real choice — a user whose OS switches
 * at sunset wants the app to switch with it — and collapsing it into "whatever
 * we last resolved" is how an app ends up stuck in light mode at midnight.
 *
 * The *resolved* value is written to `<html data-theme>` so the CSS has an
 * explicit answer before first paint; the *preference* is what is stored, so
 * "system" survives a reload as "system".
 */

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEMES)[number];
export type ResolvedTheme = 'light' | 'dark';

/**
 * Read before React exists, by the inline script in `theme-script.tsx`. The
 * literal is duplicated there because that script is serialised into the
 * document head and cannot import.
 */
export const THEME_STORAGE_KEY = 'fb-theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    // Storage can throw outright, not merely return null: Safari in a private
    // window, or any browser with site data blocked. "System" is the right
    // answer there, and a theme switch is not worth an error boundary.
    return 'system';
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Apply a preference: stamp the resolved value on `<html>` and remember the
 * preference. The attribute is always present after this runs, which is what
 * lets `globals.css` treat `[data-theme]` as authoritative and lets the
 * `dark:` variant match without a second media query.
 */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['theme'] = resolved;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The theme still applies for this page; it just will not be remembered.
  }
  return resolved;
}
