'use client';

import { useId, type ReactNode } from 'react';

/**
 * The three form pieces M38 needs that `components/ui/field.tsx` does not have.
 *
 * `Field`, `TextInput`, `Select` and `TextArea` live there and are used here as
 * they are. Two `Field` components in one app would be two answers to "how is a
 * label associated with a control", and the one that drifted would drift on the
 * surface with the most controls — which is this one. So this file adds and
 * does not restate:
 *
 *   - **`FieldGroup`** — a `fieldset` with a real `legend`, for a set of
 *     related checkboxes. A group whose only heading is a `<p>` above it is a
 *     set of *unnamed* options: a screen reader announces "checkbox, 1 of 2"
 *     with no indication of what is being chosen. There is no ARIA substitute
 *     worth preferring over the native element here.
 *
 *   - **`CheckboxRow`** — a native checkbox with its explanation associated
 *     rather than merely adjacent. Native rather than a styled
 *     `role="switch"` div, because a switch built from divs has to reimplement
 *     the space key, the focus ring, the disabled semantics and the
 *     forced-colours rendering, and is reimplemented slightly wrong in most
 *     codebases. In this palette it is achromatic anyway — chroma belongs to
 *     the states of the bridge, not to the furniture (DESIGN.md §1).
 *
 *   - **`ACTION_LINK_CLASS`** — a navigation that should look like a control.
 *
 * TODO(M39): all three belong in `components/ui/field.tsx` beside the controls
 * they extend. They are here because that file is shared with the projects and
 * generation surfaces and is not this milestone's to edit; promoting them is a
 * move, not a rewrite. Owner: whoever consolidates the form primitives.
 */

export function FieldGroup({
  legend,
  description,
  error,
  children,
  className = '',
}: {
  legend: ReactNode;
  description?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  return (
    <fieldset
      className={`flex min-w-0 flex-col gap-2 border-0 p-0 ${className}`}
      aria-describedby={[description ? descriptionId : null, error ? errorId : null]
        .filter(Boolean)
        .join(' ') || undefined}
    >
      <legend className="fb-label">{legend}</legend>
      {description ? (
        <p id={descriptionId} className="fb-meta max-w-[var(--fb-measure)]">
          {description}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={errorId} role="alert" className="text-[0.8125rem] font-medium text-halt">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function CheckboxRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  name,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  name?: string;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;

  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        {...(name === undefined ? {} : { name })}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 shrink-0 accent-[var(--fb-fg)] disabled:opacity-50"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={id}
          className={`text-[0.875rem] font-medium ${disabled ? 'text-fg-faint' : 'text-fg'}`}
        >
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="fb-meta max-w-[var(--fb-measure)]">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Deliberately a class rather than a wrapper around `Button`: an `<a>` inside a
 * `<button>` is invalid HTML, and a `<button>` that navigates loses
 * middle-click, "open in new tab", the status-bar preview and the screen-reader
 * announcement of "link". Where the action is a navigation the element is an
 * anchor and only the paint is borrowed. Matches `Button`'s `secondary` weight.
 */
export const ACTION_LINK_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-sm border border-rule-strong px-3 py-1.5 ' +
  'text-[0.875rem] font-medium text-fg transition-colors duration-150 hover:bg-sunken';
