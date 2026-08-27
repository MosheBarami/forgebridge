/**
 * The first focusable thing on the page (WCAG 2.2 §2.4.1).
 *
 * Its styling lives in `globals.css` as `.fb-skip-link` rather than in
 * utilities, because "screen-reader-only until focused" is a pair of states
 * that has to be written as one rule to stay correct — and because the visible
 * state is positioned with `inset-inline-start`, not `left`. In Hebrew the
 * shell's rail is on the right, and a skip link pinned to the physical left
 * would sit on top of the content it exists to skip past.
 *
 * It is never `display:none` and never removed from the tab order. A skip link
 * a keyboard user cannot reach is decoration.
 */
export function SkipLink({ label, targetId }: { label: string; targetId: string }) {
  return (
    <a href={`#${targetId}`} className="fb-skip-link">
      {label}
    </a>
  );
}
