import type { ReactNode } from 'react';

/**
 * The four states this system has chroma for, and nothing else.
 *
 *   live    the link is up, validation passed, an apply landed
 *   attend  something is waiting for a human — the ADR-012 moment
 *   halt    validation failed, an operation is destructive, an apply failed
 *   idle    unpaired, unknown, not asked yet
 *
 * The dot never carries the meaning alone. Every use pairs it with a word,
 * because a coloured dot is invisible to a screen reader, ambiguous to a
 * colour-blind reader and meaningless to a new user (WCAG 2.2 §1.4.1). It is
 * `aria-hidden` for exactly that reason: the adjacent text is the label.
 */
export type Status = 'live' | 'attend' | 'halt' | 'idle';

const FILL: Record<Status, string> = {
  live: 'bg-live',
  attend: 'bg-attend',
  halt: 'bg-halt',
  idle: 'bg-idle',
};

export function StatusDot({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${FILL[status]} ${className}`}
    />
  );
}

/**
 * The chip's border stays neutral in all four states. The wash and the text
 * already carry the colour; a matching border would be a third use of the same
 * signal and would make an idle chip and a live chip differ by outline weight
 * as well as by hue, which is a difference nobody reads.
 */
const WASH: Record<Status, string> = {
  live: 'bg-live-wash text-live',
  attend: 'bg-attend-wash text-attend',
  halt: 'bg-halt-wash text-halt',
  idle: 'bg-idle-wash text-idle',
};

/** A state, spelled out. The dot plus the word, as one unit. */
export function StatusChip({
  status,
  children,
  className = '',
}: {
  status: Status;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-sm border border-rule px-2 py-0.5 text-[0.8125rem] font-medium ${WASH[status]} ${className}`}
    >
      <StatusDot status={status} />
      {children}
    </span>
  );
}
