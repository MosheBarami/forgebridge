'use client';

import { useCallback, useSyncExternalStore } from 'react';

import {
  preferencesServerSnapshot,
  preferencesSnapshot,
  subscribePreferences,
  updatePreferences,
  type Preferences,
  type PreferencesState,
} from './preferences';

export interface PreferencesHandle {
  readonly state: PreferencesState;
  readonly update: (change: (current: Preferences) => Preferences) => Promise<void>;
}

/**
 * Read the preference store, and write to it.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, because the store
 * is genuinely external: two route subtrees read it, and a user who edits the
 * approval policy and then opens the link page must see the same record, not a
 * second copy that was loaded before the edit. The server snapshot is the
 * loading state with defaults — see `preferences.ts` for why a guess would be
 * worse than a frame of "loading".
 */
export function usePreferences(): PreferencesHandle {
  const state = useSyncExternalStore(
    subscribePreferences,
    preferencesSnapshot,
    preferencesServerSnapshot,
  );

  const update = useCallback(async (change: (current: Preferences) => Preferences) => {
    await updatePreferences(change);
  }, []);

  return { state, update };
}
