'use client';

import { useEffect, useId, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { applyThemePreference, readThemePreference, THEMES, type ThemePreference } from '@/lib/theme';

/**
 * The theme switch.
 *
 * A `<select>`, not a two-state toggle, because the preference has three values
 * and "system" is one of them (see `lib/theme.ts`). A toggle would force the
 * user to pick a side and lose the OS following.
 *
 * It starts as `null` and fills in after mount. The server has no way to know
 * what `localStorage` holds, so rendering a guess would produce a control whose
 * value disagrees with the page it is sitting on for one frame. The inline
 * script has already painted the correct theme by then; this is only the
 * control catching up to it.
 */
export function ThemeSwitch() {
  const { t } = useLocale();
  const id = useId();
  const [preference, setPreference] = useState<ThemePreference | null>(null);

  useEffect(() => {
    setPreference(readThemePreference());
  }, []);

  useEffect(() => {
    if (preference !== 'system') return;
    // Follow the OS while "system" is selected. Without this the app resolves
    // once at load and then ignores a sunset switch until the next reload.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemePreference('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="fb-label">
        {t('shell.theme.label')}
      </label>
      <select
        id={id}
        value={preference ?? 'system'}
        // Disabled until the real preference is known, so the control can never
        // be operated while showing a value that is not the current one.
        disabled={preference === null}
        onChange={(event) => {
          const next = event.target.value as ThemePreference;
          setPreference(next);
          applyThemePreference(next);
        }}
        className="rounded-sm border border-rule bg-raised px-2 py-1 text-[0.8125rem] text-fg"
      >
        {THEMES.map((theme) => (
          <option key={theme} value={theme}>
            {t(`shell.theme.${theme}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
