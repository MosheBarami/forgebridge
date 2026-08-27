import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * Form primitives for the projects and generation surfaces (M34, M35).
 *
 * There is no component library here and this is why one is not needed: the
 * whole interactive vocabulary of this app is a label, a control, a hint and an
 * error, drawn on the `raised` plane with a hairline border. A library would
 * bring its own radii, its own shadow scale and its own focus ring, and every
 * one of those would have to be overridden back to the tokens in
 * `globals.css` — which is a dependency bought in order to be argued with.
 *
 * Two things every control here gets that are easy to forget by hand:
 *
 *   - **The hint and the error are wired into `aria-describedby`.** A hint
 *     placed next to an input but not associated with it is a hint a screen
 *     reader user never hears, and an error announced only in colour is not
 *     announced (WCAG 2.2 §3.3.1, §1.4.1). The error carries `role="alert"` so
 *     it is spoken when it appears rather than when focus next lands.
 *   - **Errors are words, never a red outline alone.** The border does change,
 *     because a sighted user scanning a form benefits from it — but the border
 *     is the second signal, never the only one.
 *
 * Colour follows §1 of DESIGN.md: chroma means state, so a validation failure
 * uses `halt` and nothing else on these controls is coloured at all.
 */

interface FieldShellProps {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly children: (described: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': boolean | undefined }) => ReactNode;
  readonly className?: string;
}

/**
 * The label / control / hint / error arrangement, with the wiring done once.
 *
 * A render prop rather than `cloneElement`: the ids have to reach the control's
 * attributes, and cloning to inject them silently does nothing when a caller
 * wraps their input in anything at all.
 */
export function Field({ id, label, hint, error, children, className = '' }: FieldShellProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="fb-label">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint ? (
        <p id={hintId} className="fb-meta">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[0.8125rem] font-medium text-halt">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  'w-full min-w-0 rounded-sm border bg-raised px-2 py-1.5 text-[0.875rem] text-fg ' +
  'placeholder:text-fg-faint transition-[background-color,opacity] duration-150 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** `aria-invalid` drives the border, so the state cannot be set without the attribute. */
function borderFor(invalid: boolean | undefined): string {
  return invalid ? 'border-halt' : 'border-rule';
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`${CONTROL} ${borderFor(rest['aria-invalid'] === true)} ${className}`} />;
}

/**
 * `field-sizing: content` would be nicer than a row count, but it is not in
 * Safari yet and a prompt box that silently stops growing in one browser is
 * worse than one that never grows anywhere. Rows plus `resize-y` is the
 * behaviour every browser agrees on.
 */
export function TextArea({ className = '', rows = 6, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      rows={rows}
      className={`${CONTROL} resize-y leading-relaxed ${borderFor(rest['aria-invalid'] === true)} ${className}`}
    />
  );
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${CONTROL} ${borderFor(rest['aria-invalid'] === true)} ${className}`}>
      {children}
    </select>
  );
}

/**
 * A native `<details>`, styled.
 *
 * Used for the run log's expandable attempt list and for each operation's
 * source in the diff. Native rather than a state-driven div because it brings
 * the whole accessibility contract for free — `aria-expanded` on the summary,
 * keyboard operation, find-in-page reaching collapsed content in browsers that
 * support it — and because the marker mirrors under `dir="rtl"` without this
 * app owning a rotation.
 *
 * `open` is a *default* here (`defaultOpen`), not a controlled prop: `<details>`
 * manages its own state, and driving it from React fights the element for
 * ownership of a thing the element is already good at.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = '',
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={defaultOpen} className={`group ${className}`}>
      <summary className="cursor-pointer list-none rounded-sm py-1 text-[0.8125rem] font-medium text-fg-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          {/*
            The marker is drawn rather than inherited so it can be a logical
            rotation: `rotate-90` under `ltr` points it at the content, and the
            RTL flip comes from `dir` on the ancestor rather than from a second
            rule here. `aria-hidden` because the summary already announces its
            expanded state.
          */}
          <span
            aria-hidden="true"
            className="inline-block text-fg-faint transition-transform duration-150 group-open:rotate-90 rtl:-scale-x-100"
          >
            ▸
          </span>
          {summary}
        </span>
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}
