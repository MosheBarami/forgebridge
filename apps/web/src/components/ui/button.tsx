import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Three weights, and the reason there are three is ADR-012.
 *
 *   primary    ink fill. One per view, at most. The thing the user came to do.
 *   secondary  ruled outline. Everything else.
 *   consent    ruled outline with an amber marker. The approval control.
 *
 * `consent` is deliberately *not* the heaviest weight on the screen. An
 * approval that looks like the primary action is an approval people click
 * through on the way to somewhere else, and this product's whole claim is that
 * nothing reaches a user's place without a human having read the diff. The
 * amber marker is there so the control is findable, not so it is tempting; the
 * layout rule that goes with it — approval sits in its own register footer,
 * never adjacent to the run button — is stated in DESIGN.md because it is a
 * placement rule, not a component one.
 *
 * There is no `danger` variant. A destructive act in this app is a rollback or
 * a bulk delete, and both go through the same deliberate consent control with
 * the destruction spelled out in words beside it. A red button is a button
 * people learn to click.
 */
export type ButtonWeight = 'primary' | 'secondary' | 'consent';

const WEIGHT: Record<ButtonWeight, string> = {
  primary:
    'bg-fg text-fg-inverse border border-fg hover:opacity-90 disabled:opacity-40',
  secondary:
    'bg-transparent text-fg border border-rule-strong hover:bg-sunken disabled:opacity-40',
  consent:
    'bg-transparent text-fg border border-attend hover:bg-attend-wash disabled:opacity-40',
};

export function Button({
  weight = 'secondary',
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { weight?: ButtonWeight; children: ReactNode }) {
  return (
    <button
      // `type` defaults to "submit" in HTML, which submits any ancestor form —
      // a footgun in a component used mostly outside forms. Callers that want a
      // submit button pass one; `rest` spreads after, so they can.
      type="button"
      className={
        'inline-flex items-center justify-center gap-2 rounded-sm px-3 py-1.5 ' +
        'text-[0.875rem] font-medium transition-[background-color,opacity] duration-150 ' +
        'disabled:cursor-not-allowed ' +
        `${WEIGHT[weight]} ${className}`
      }
      {...rest}
    >
      {children}
    </button>
  );
}
