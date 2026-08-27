import { createStorage, StorageUnavailableError, type StoredRecord } from '@/lib/storage';
import { ROUTING_POLICIES, type RoutingPolicyName } from '@/lib/daemon/wire';
import { DEFAULT_AUTO_APPLY, parseAutoApply, type StoredAutoApply } from './approval-policy';

/**
 * The preferences this app persists, and where they live.
 *
 * They live in **this browser**, through the Storage port (ADR-005), because
 * signed-out is the first-class mode and a preference that needed an account
 * would be a preference most users never get to set. When M33 lands the remote
 * adapter, the same record moves with the rest of the user's work under the
 * adoption rule — signing in adopts what is here, it never replaces it.
 *
 * Two things are deliberately NOT in this record:
 *
 *   - **Theme and locale.** They are resolved before React exists — the inline
 *     script in `theme-script.tsx` reads `localStorage` before first paint, and
 *     the middleware reads the locale cookie before the app renders at all.
 *     IndexedDB is asynchronous, so routing either of them through this store
 *     would guarantee a frame of the wrong theme or a redirect to the wrong
 *     language. The appearance surface therefore writes to the foundation's own
 *     switches rather than to this record; see `settings/appearance`.
 *
 *   - **Anything credential-shaped.** ADR-006 and rule K2 of
 *     `npm run verify:no-key-storage`: the Storage port never carries a key.
 *     Provider credentials live in `lib/keys/vault.ts`, in their own database,
 *     encrypted, and never pass through this file.
 */

const RECORD_ID = 'preferences';

export interface RoutingPreference {
  /**
   * The default policy for `POST /v1/runs`. `free-first` because the product's
   * claim is that it works with no bill, and a default that spends money is a
   * default that breaks that claim for whoever does not read this page.
   */
  readonly policy: RoutingPolicyName;
  /**
   * A model id the router must use, or null to let the policy order. Only
   * meaningful when `policy` is `pinned`; kept as a separate field so choosing
   * a model and then switching policies does not silently discard the choice.
   */
  readonly pinnedModelId: string | null;
}

export interface Preferences {
  readonly routing: RoutingPreference;
  /** The core's `AutoApplyPolicy`, or null for "no auto-apply" — its own default. */
  readonly autoApply: StoredAutoApply;
}

export const DEFAULT_PREFERENCES: Preferences = {
  routing: { policy: 'free-first', pinnedModelId: null },
  autoApply: DEFAULT_AUTO_APPLY,
};

interface PreferencesRecord extends StoredRecord {
  readonly id: typeof RECORD_ID;
  readonly routing: RoutingPreference;
  readonly autoApply: StoredAutoApply;
}

function parseRouting(value: unknown): RoutingPreference {
  if (typeof value !== 'object' || value === null) return DEFAULT_PREFERENCES.routing;
  const record = value as Record<string, unknown>;
  const policy = record['policy'];
  const pinned = record['pinnedModelId'];
  return {
    policy: (ROUTING_POLICIES as readonly string[]).includes(policy as string)
      ? (policy as RoutingPolicyName)
      : DEFAULT_PREFERENCES.routing.policy,
    pinnedModelId: typeof pinned === 'string' && pinned.length > 0 ? pinned : null,
  };
}

export function parsePreferences(value: unknown): Preferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_PREFERENCES;
  const record = value as Record<string, unknown>;
  return {
    routing: parseRouting(record['routing']),
    // The auto-apply policy parses all-or-nothing on purpose; see
    // `approval-policy.ts`. Routing is merged field by field because its worst
    // failure is a policy name reverting to `free-first`, which costs nothing.
    autoApply: parseAutoApply(record['autoApply']),
  };
}

/**
 * The state of the read, as one value.
 *
 * `unavailable` is a real branch rather than an error: a private window with
 * site data blocked cannot hold preferences at all, and the surfaces have to be
 * able to say "this control will not be remembered" instead of silently
 * accepting an edit that evaporates.
 */
export type PreferencesState =
  | { readonly status: 'loading'; readonly value: Preferences }
  | { readonly status: 'ready'; readonly value: Preferences }
  | { readonly status: 'unavailable'; readonly value: Preferences; readonly detail: string };

/**
 * A module-level store rather than a React provider.
 *
 * The two surfaces that read preferences — `/settings/**` and `/link` — sit in
 * different route subtrees, and the layout above both is the shell, which this
 * milestone does not own. A provider would therefore have to be mounted twice,
 * which is two independent copies of the same record and a stale one whenever
 * the user edits on one page and navigates to the other. One store, subscribed
 * to from anywhere, has neither problem.
 */
type Listener = () => void;

let state: PreferencesState = { status: 'loading', value: DEFAULT_PREFERENCES };
const listeners = new Set<Listener>();
let loading: Promise<void> | undefined;

function publish(next: PreferencesState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribePreferences(listener: Listener): () => void {
  listeners.add(listener);
  // Kick the first read on first subscription rather than at module load: a
  // module that opens IndexedDB when it is imported does so on the server too,
  // where there is none, and during a render, which is not where a side effect
  // belongs.
  void ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

export function preferencesSnapshot(): PreferencesState {
  return state;
}

/**
 * The server's answer. Always the loading state with defaults — the server
 * cannot read this browser's database, and rendering a guess would produce
 * controls whose values disagree with the page for one frame after hydration.
 */
const SERVER_STATE: PreferencesState = { status: 'loading', value: DEFAULT_PREFERENCES };
export function preferencesServerSnapshot(): PreferencesState {
  return SERVER_STATE;
}

async function ensureLoaded(): Promise<void> {
  if (state.status !== 'loading') return;
  loading ??= (async () => {
    try {
      const stored = await createStorage().get<PreferencesRecord>('settings', RECORD_ID);
      publish({ status: 'ready', value: stored ? parsePreferences(stored) : DEFAULT_PREFERENCES });
    } catch (error) {
      publish({
        status: 'unavailable',
        value: DEFAULT_PREFERENCES,
        detail:
          error instanceof StorageUnavailableError
            ? error.message
            : 'this browser refused to open local storage',
      });
    }
  })();
  return loading;
}

/**
 * Write a change and report whether it landed.
 *
 * The optimistic publish happens first so a control does not lag a click, and
 * the failure path publishes `unavailable` with the same value — the edit is
 * still true of this page, it just will not survive a reload, and the surface
 * says exactly that rather than reverting the control under the user's cursor.
 */
export async function updatePreferences(
  change: (current: Preferences) => Preferences,
): Promise<{ readonly saved: boolean; readonly detail?: string }> {
  await ensureLoaded();
  const next = change(state.value);
  publish({ status: 'ready', value: next });

  try {
    await createStorage().put<PreferencesRecord>('settings', {
      id: RECORD_ID,
      routing: next.routing,
      autoApply: next.autoApply,
    });
    return { saved: true };
  } catch (error) {
    const detail =
      error instanceof StorageUnavailableError
        ? error.message
        : 'this browser refused to write to local storage';
    publish({ status: 'unavailable', value: next, detail });
    return { saved: false, detail };
  }
}
