'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PRIVACY_POSTURE, type Link, type TransportKind } from '@forgebridge/protocol';

import { useDaemonSession } from './session';
import type { DaemonFailure } from './client';
import type { HealthResponse, LinkStatusResponse } from './wire';

/**
 * The bridge's own state, as one value.
 *
 * `absent` is not an error branch bolted onto a success type — it is one of the
 * three things this hook can honestly report, and for a signed-out first-time
 * visitor it is the one they will see. The shell renders a route forward from
 * it rather than an error toast.
 */
export type BridgeState =
  | { readonly kind: 'probing' }
  | { readonly kind: 'absent'; readonly failure: DaemonFailure }
  | {
      readonly kind: 'present';
      readonly health: HealthResponse;
      /**
       * Null when the daemon answered `/v1/health` but not `/v1/link` — which
       * happens when this page has no producer token and a future daemon build
       * gates the link register. Health alone is still worth showing.
       */
      readonly link: LinkStatusResponse | null;
    };

/**
 * How often the shell re-probes while the daemon is absent.
 *
 * Slow on purpose. The user is being asked to open a terminal and start a
 * process; a one-second poll would spend the whole time they need failing, and
 * every failure is a rejected cross-origin request the browser also logs to
 * their console. Five seconds is fast enough that the indicator flips on its
 * own shortly after the daemon comes up.
 */
export const ABSENT_POLL_MS = 5_000;

/** And how often once it is up, to notice a Studio session pairing or dropping. */
export const PRESENT_POLL_MS = 15_000;

export interface BridgeValue {
  readonly state: BridgeState;
  readonly refresh: () => void;
  /** True while a manual `refresh()` is in flight, for the retry button. */
  readonly refreshing: boolean;
}

/**
 * One probe loop for the whole tree.
 *
 * The link register is in the pinned bar, the bridge page draws the same link
 * in detail, and the surface around it asks whether the daemon is up at all —
 * three components wanting one fact. A hook that each of them called
 * independently would run three timers, and while the daemon is absent that is
 * three rejected cross-origin requests every five seconds, all of them also
 * logged to the user's console. So the loop runs once, in a provider, and the
 * hook reads it.
 */
function useBridgeProbe(): BridgeValue {
  const { client, hasToken } = useDaemonSession();
  const [state, setState] = useState<BridgeState>({ kind: 'probing' });
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Guards a `setState` after unmount, and lets a slow probe be ignored when a
  // newer one has already answered.
  const generation = useRef(0);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const probe = async (): Promise<void> => {
      const health = await client.health(controller.signal);
      if (cancelled || current !== generation.current) return;

      if (!health.ok) {
        setState({ kind: 'absent', failure: health });
        setRefreshing(false);
        timer = setTimeout(() => void probe(), ABSENT_POLL_MS);
        return;
      }

      const link = await client.linkStatus(controller.signal);
      if (cancelled || current !== generation.current) return;

      setState({ kind: 'present', health: health.data, link: link.ok ? link.data : null });
      setRefreshing(false);
      timer = setTimeout(() => void probe(), PRESENT_POLL_MS);
    };

    void probe();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // `hasToken` is a dependency because gaining a token can change what
    // `/v1/link` returns, and the register should redraw when it does.
  }, [client, nonce, hasToken]);

  return useMemo(() => ({ state, refresh, refreshing }), [state, refresh, refreshing]);
}

const BridgeContext = createContext<BridgeValue | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  const value = useBridgeProbe();
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge(): BridgeValue {
  const value = useContext(BridgeContext);
  if (!value) {
    throw new Error('useBridge must be used inside <BridgeProvider> — see app/[locale]/layout.tsx');
  }
  return value;
}

/**
 * The link a UI should show when there are several.
 *
 * A daemon can hold more than one link per project — an old Studio session that
 * has not expired, plus the one that just paired. The one worth putting in a
 * one-line indicator is the most recently seen paired link; failing that, the
 * most recently seen anything.
 */
export function primaryLink(status: LinkStatusResponse | null): Link | null {
  if (!status || status.links.length === 0) return null;
  const seenAt = (link: Link): number => (link.lastSeenAt ? Date.parse(link.lastSeenAt) : 0);
  const byRecency = [...status.links].sort((a, b) => seenAt(b) - seenAt(a));
  return byRecency.find((link) => link.state === 'paired') ?? byRecency[0] ?? null;
}

/**
 * The privacy posture string to render.
 *
 * Prefers the daemon's own `privacyPosture` field, because that is the value
 * the daemon asserted about itself. Falls back to the protocol constant keyed
 * by transport when a response predates the field. Both paths produce one of
 * the three exact strings in `PRIVACY_POSTURE`; neither produces a padlock, and
 * neither says "encrypted" about a link that is not (ADR-014).
 */
export function postureFor(
  status: LinkStatusResponse | null,
  transport: TransportKind | undefined,
): string | null {
  if (status && status.privacyPosture.length > 0) return status.privacyPosture;
  if (transport) return PRIVACY_POSTURE[transport];
  return null;
}
