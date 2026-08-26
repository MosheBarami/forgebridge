/**
 * Secrets port — the only way the core reaches a credential (C4, ADR-006).
 *
 * The shape is built around one promise: the official instance's servers have no
 * column that could hold a user API key. That promise survives only if the core never has a
 * way to enumerate values, log them, or hand them to telemetry — so this port
 * offers exactly one value-returning method, and `listNames` returns names.
 */

export type SecretScope =
  /** A model provider credential: OpenRouter, Anthropic, a local endpoint token. */
  | 'provider'
  /** A pairing-derived session key id's material, held by the transport adapter. */
  | 'link'
  /** The deployment's own credentials — the sponsored-run key lives here, nothing else does. */
  | 'system';

export interface SecretRef {
  scope: SecretScope;
  /** Stable, non-secret identifier: a provider slug, a link id. Safe to log. */
  name: string;
}

export type SecretsBackendKind = 'os-keychain' | 'web-crypto' | 'env' | 'memory';

export interface SecretsBackendInfo {
  kind: SecretsBackendKind;
  /** Rendered verbatim in the UI: "macOS Keychain", "environment variables". */
  label: string;
  /**
   * True when any process running as this user can read the stored value — the
   * `env` adapter, and a memory adapter in a shared process. The UI says so
   * rather than showing the same padlock for every backend, for the same reason
   * `PRIVACY_POSTURE` exists on the transport side.
   */
  readableByOtherProcesses: boolean;
}

export interface SecretsPort {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  /** Names only. There is no bulk value read, because nothing legitimate needs one. */
  listNames(scope: SecretScope): Promise<string[]>;
  describe(): SecretsBackendInfo;
}
