import type { ApplyResult, ChangeSet, Link, TransportKind } from '@forgebridge/protocol';

/**
 * Transport port — how a ChangeSet reaches a consumer and how the result comes
 * back (ADR-004).
 *
 * Both shipped transports are HTTP long-poll, because Studio has no WebSocket
 * API. That is an adapter's problem: this port says *deliver and wait*, not
 * *poll*. Nonces, MACs, and payload encryption are also the adapter's problem
 * (ADR-014) — the core must not invent crypto, and must not assume any, which is
 * why `describe()` returns the posture as text the UI shows verbatim instead of
 * a boolean the UI would render as a padlock.
 */

export interface TransportInfo {
  kind: TransportKind;
  /** Use `PRIVACY_POSTURE[kind]` from the protocol. Shown to the user as written. */
  posture: string;
  /** Present for a daemon or a self-hosted relay; absent when there is no server. */
  baseUrl?: string;
}

export interface DeliveryReceipt {
  linkId: string;
  /** The monotonic per-link counter the adapter assigned. Recorded, never chosen by the core. */
  nonce: number;
  deliveredAt: string;
}

export interface AwaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type OutputStream = 'output' | 'info' | 'warning' | 'error';

export interface OutputChunk {
  at: string;
  stream: OutputStream;
  text: string;
}

export interface TransportPort {
  describe(): TransportInfo;
  /** Null when no consumer has paired with this project. */
  status(projectId: string): Promise<Link | null>;
  /**
   * Hand the set to the consumer. Resolving means *queued for delivery*, not
   * *applied* — the consumer polls, and a Studio session that is closed will
   * pick it up when it reopens.
   */
  deliver(link: Link, set: ChangeSet): Promise<DeliveryReceipt>;
  /**
   * Resolve when the consumer reports back. Rejects on timeout or abort; the
   * caller then knows only that it has no result, never that nothing was
   * applied — which is why the changeset's status is not moved on a timeout.
   */
  awaitApplyResult(changeSetId: string, options: AwaitOptions): Promise<ApplyResult>;
  /** Studio console output mirrored back for producers to read. */
  readOutput(projectId: string, since: string | null, options: AwaitOptions): Promise<OutputChunk[]>;
}
