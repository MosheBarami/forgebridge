'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  VaultUnavailableError,
  forget,
  forgetEverything,
  listEntries,
  seal,
  vaultAvailability,
  type VaultEntry,
  type VaultProvider,
  type VaultSource,
  type VaultUnavailable,
} from './vault';

/**
 * The vault, as a component sees it.
 *
 * `unavailable` is first-class rather than an error to catch. A page served
 * over plain HTTP on a non-loopback host has no `crypto.subtle` at all, and the
 * correct response there is a panel that explains why it is refusing to accept
 * a credential — not an input that looks like it works.
 */
export interface VaultHandle {
  readonly entries: VaultEntry[];
  readonly loading: boolean;
  readonly unavailable: VaultUnavailable | null;
  readonly store: (providerId: VaultProvider, entered: string, source: VaultSource) => Promise<void>;
  readonly remove: (providerId: VaultProvider) => Promise<void>;
  readonly removeAll: () => Promise<void>;
  readonly error: string | null;
}

export function useVault(): VaultHandle {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Null until the effect runs: `vaultAvailability()` reads `window`, and
  // calling it during render would disagree with the server's HTML for a frame.
  const [unavailable, setUnavailable] = useState<VaultUnavailable | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const blocked = vaultAvailability();
    setUnavailable(blocked);
    if (blocked) {
      setEntries([]);
      setLoading(false);
      return;
    }
    try {
      setEntries(await listEntries());
      setError(null);
    } catch (cause) {
      if (cause instanceof VaultUnavailableError) setUnavailable(cause.cause);
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const store = useCallback(
    async (providerId: VaultProvider, entered: string, source: VaultSource) => {
      try {
        await seal(providerId, entered, source);
        setError(null);
      } catch (cause) {
        if (cause instanceof VaultUnavailableError) setUnavailable(cause.cause);
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (providerId: VaultProvider) => {
      try {
        await forget(providerId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await refresh();
    },
    [refresh],
  );

  const removeAll = useCallback(async () => {
    try {
      await forgetEverything();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    await refresh();
  }, [refresh]);

  return { entries, loading, unavailable, store, remove, removeAll, error };
}
