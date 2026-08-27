import type { ChangeSetDiff, OperationDiff } from '@/lib/daemon/wire';

/**
 * What each operation in a diff actually does, worked out for the reviewer (M35).
 *
 * ── The defect this file is written against ───────────────────────────────
 *
 * The Studio plugin reported "0 scripts" over a ChangeSet that installed one.
 * The cause was that it looked only at `writeScript`, and the script had
 * arrived as a `createInstance` carrying `Source` in its property bag. Same
 * Luau, same effect on the user's place, invisible to the summary they read
 * before approving.
 *
 * There are **three** ways a ChangeSet installs Luau, and the daemon's own
 * `carriesLuauSource` is the authority on the list:
 *
 *   1. `writeScript`                       — the obvious one
 *   2. `createInstance` with `Source` in its properties
 *   3. `setProperty` where the property is `Source`
 *
 * All three are resolved here, and the third is the awkward one: the daemon
 * renders a `setProperty` value as `JSON.stringify(operation.value)`, so the
 * Luau arrives wrapped in a `PropertyValue` envelope — `{"t":"String","v":"…"}`
 * — rather than as raw source the way the other two do. A viewer that printed
 * `after` verbatim for all three would show a reviewer JSON-escaped code with
 * every newline as `\n`, which is not a diff of the script; it is a diff of a
 * string literal. So the envelope is unwrapped and the source shown as source.
 *
 * ── The cross-check ───────────────────────────────────────────────────────
 *
 * `resolveDiff` compares how many operations it found code for against
 * `diff.counts.scripts`, which the daemon computes with its own predicate. A
 * mismatch means this app is about to show a reviewer fewer scripts than the
 * daemon knows the set contains — the 2026-08 defect exactly — and it is
 * reported as `undisclosedScripts` so the UI can say so instead of quietly
 * being wrong. It is a check that should never fire; the value of it is that
 * if it ever does, it fires in front of the person about to approve.
 */

/** The property name the protocol uses for a script's body. Not a guess. */
const SOURCE_PROPERTY = 'Source';

export type SourceKind =
  /** Raw Luau, ready to show. */
  | { readonly kind: 'luau'; readonly source: string }
  /**
   * The operation writes `Source`, but not as a string — so there is no code to
   * display. The daemon's analyser has already failed the verdict for this with
   * `luau/source-not-readable`; the diff still says the operation is there.
   */
  | { readonly kind: 'unreadable-source'; readonly raw: string }
  /** A non-script value being written, shown as the value it is. */
  | { readonly kind: 'value'; readonly raw: string }
  /** Fully described by its paths — a move or a delete. */
  | { readonly kind: 'none' };

export interface ResolvedOperation {
  readonly diff: OperationDiff;
  /** The property this operation writes, when it is a `setProperty`. */
  readonly property: string | null;
  /** True when this operation installs Luau, by the daemon's own definition. */
  readonly carriesLuau: boolean;
  readonly content: SourceKind;
}

export interface ResolvedDiff {
  readonly operations: readonly ResolvedOperation[];
  /** Operations that install Luau this app was able to render as code. */
  readonly shownScripts: number;
  /**
   * `counts.scripts` minus what could be shown. Must be zero. Non-zero means a
   * script is in this ChangeSet that the reviewer is not being shown, and the
   * UI must refuse to present the diff as complete.
   */
  readonly undisclosedScripts: number;
  readonly destructiveCount: number;
}

/**
 * The property a `setProperty` writes.
 *
 * Recovered from the summary, because `OperationDiff` has no `property` field —
 * the daemon builds the summary as `set ${path}.${property}` in
 * `describeOperation`, and `paths[0]` is that same path. Anchoring on the known
 * path rather than splitting on the last `.` is what makes this exact: instance
 * paths are themselves dotted, so `ServerScriptService.Shop.Handler.Source`
 * split naively would be right by luck and wrong the moment a property name
 * contains no dot but a path does.
 *
 * Returns null when the summary is not in the expected shape, and a null
 * property is treated as "may be Source" by the caller rather than "is not" —
 * failing towards showing the reviewer more, never less.
 *
 * TODO(M35): `OperationDiff` should carry `property` outright. Recovering a
 * structured field from a human-readable sentence is a seam that will break
 * silently the first time the sentence is reworded, and the only thing standing
 * between that and a hidden script is `undisclosedScripts` above. Owner: the
 * protocol maintainer, as an additive field on the diff envelope (TODO(M31)
 * already moves these shapes into `@forgebridge/protocol`).
 */
export function propertyOf(operation: OperationDiff): string | null {
  if (operation.op !== 'setProperty') return null;
  const path = operation.paths[0];
  if (path === undefined) return null;
  const prefix = `set ${path}.`;
  if (!operation.summary.startsWith(prefix)) return null;
  const property = operation.summary.slice(prefix.length);
  return property.length > 0 ? property : null;
}

/**
 * Unwrap a `PropertyValue` envelope to its Luau, when it holds one.
 *
 * `t === 'String'` with a capital S — the protocol's `StringValue` tag, matched
 * exactly the way the daemon's own `sourceTextOf` matches it. A lowercase
 * `'string'` here would silently never match and every `setProperty` script
 * would render as JSON.
 */
function unwrapSource(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as { t?: unknown; v?: unknown };
  return value.t === 'String' && typeof value.v === 'string' ? value.v : null;
}

function contentOf(operation: OperationDiff, property: string | null): { content: SourceKind; carriesLuau: boolean } {
  const after = operation.after;

  switch (operation.op) {
    case 'writeScript':
      // The daemon puts the source in `after` verbatim, untruncated. Anything
      // else would be a diff that hides the code.
      return after === undefined
        ? { content: { kind: 'unreadable-source', raw: '' }, carriesLuau: true }
        : { content: { kind: 'luau', source: after }, carriesLuau: true };

    case 'createInstance': {
      // `after` is present only when the property bag carried a readable
      // `Source`; a bag with an unreadable one leaves it in `properties`.
      if (after !== undefined) return { content: { kind: 'luau', source: after }, carriesLuau: true };
      const unreadable = operation.properties?.[SOURCE_PROPERTY];
      if (unreadable !== undefined) {
        return { content: { kind: 'unreadable-source', raw: unreadable }, carriesLuau: true };
      }
      return { content: { kind: 'none' }, carriesLuau: false };
    }

    case 'setProperty': {
      // A null property means the summary did not parse. Treat it as possibly
      // Source and try to unwrap: showing a reviewer a script that turned out
      // to be a string property costs them a glance, while the reverse costs
      // them a script they never saw.
      const mightBeSource = property === null || property === SOURCE_PROPERTY;
      if (!mightBeSource) {
        return { content: { kind: 'value', raw: after ?? '' }, carriesLuau: false };
      }
      if (after === undefined) {
        return { content: { kind: 'unreadable-source', raw: '' }, carriesLuau: property === SOURCE_PROPERTY };
      }
      const source = unwrapSource(after);
      if (source !== null) return { content: { kind: 'luau', source }, carriesLuau: true };
      return {
        content:
          property === SOURCE_PROPERTY
            ? { kind: 'unreadable-source', raw: after }
            : { kind: 'value', raw: after },
        carriesLuau: property === SOURCE_PROPERTY,
      };
    }

    default:
      // `moveInstance` and `deleteInstance`, and anything a newer daemon adds.
      // An unknown op with an `after` still shows its value rather than nothing.
      return after === undefined
        ? { content: { kind: 'none' }, carriesLuau: false }
        : { content: { kind: 'value', raw: after }, carriesLuau: false };
  }
}

export function resolveDiff(diff: ChangeSetDiff): ResolvedDiff {
  const operations = diff.operations.map<ResolvedOperation>((operation) => {
    const property = propertyOf(operation);
    const { content, carriesLuau } = contentOf(operation, property);
    return { diff: operation, property, carriesLuau, content };
  });

  const shownScripts = operations.filter((operation) => operation.content.kind === 'luau').length;

  return {
    operations,
    shownScripts,
    // Clamped at zero: this app rendering *more* scripts than the daemon counted
    // is not a safety problem and is not worth a negative number on a screen.
    undisclosedScripts: Math.max(0, diff.counts.scripts - shownScripts),
    destructiveCount: operations.filter((operation) => operation.diff.destructive).length,
  };
}

/** Rough size of a source, for the operation header. Bytes, not characters. */
export function sourceBytes(source: string): number {
  return new TextEncoder().encode(source).length;
}
