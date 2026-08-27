'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { DaemonClient } from './client';
import { daemonBaseUrl } from './config';

/**
 * The producer token, held in memory for the life of the tab. Nowhere else.
 *
 * Why not the Storage port, or `localStorage`, or a cookie:
 *
 *   - The daemon **mints a new token on every process start**
 *     (`packages/daemon/src/auth.ts`). A persisted copy is stale the moment the
 *     user restarts the daemon, so persistence would buy a stored secret in
 *     exchange for a value that is usually wrong.
 *   - It is a bearer credential. `docs/THREAT-MODEL.md` T1 and ADR-006 are
 *     about keeping credentials off disk and out of any store, and
 *     `npm run verify:no-key-storage` enforces the structural half of that
 *     claim. Routing this through `StoragePort` would put a credential in a
 *     port's signature, which is exactly rule K2.
 *
 * So it lives in a ref, the ref is read through a closure the client calls per
 * request, and it dies with the tab. The cost is that a reload asks for it
 * again; the daemon prints it on the terminal, which is where the user already
 * is when they start the daemon.
 */

export interface DaemonSessionValue {
  /** A client bound to the configured base URL and this session's token. */
  readonly client: DaemonClient;
  readonly baseUrl: string;
  /** Whether a token has been supplied. Never the token itself. */
  readonly hasToken: boolean;
  readonly setToken: (value: string) => void;
  readonly clearToken: () => void;
}

const DaemonSessionContext = createContext<DaemonSessionValue | null>(null);

export function DaemonSessionProvider({ children }: { children: ReactNode }) {
  // A ref, not state: the client reads it per request through the closure
  // below, so changing it must not force a new client identity and tear down
  // every in-flight poll.
  const tokenRef = useRef<string | undefined>(undefined);
  const [hasToken, setHasToken] = useState(false);

  const baseUrl = daemonBaseUrl();

  const client = useMemo(
    () => new DaemonClient({ baseUrl, producerToken: () => tokenRef.current }),
    [baseUrl],
  );

  const setToken = useCallback((value: string) => {
    const trimmed = value.trim();
    tokenRef.current = trimmed.length > 0 ? trimmed : undefined;
    setHasToken(trimmed.length > 0);
  }, []);

  const clearToken = useCallback(() => {
    tokenRef.current = undefined;
    setHasToken(false);
  }, []);

  const value = useMemo<DaemonSessionValue>(
    () => ({ client, baseUrl, hasToken, setToken, clearToken }),
    [client, baseUrl, hasToken, setToken, clearToken],
  );

  return <DaemonSessionContext.Provider value={value}>{children}</DaemonSessionContext.Provider>;
}

export function useDaemonSession(): DaemonSessionValue {
  const value = useContext(DaemonSessionContext);
  if (!value) {
    throw new Error('useDaemonSession must be used inside <DaemonSessionProvider>');
  }
  return value;
}
