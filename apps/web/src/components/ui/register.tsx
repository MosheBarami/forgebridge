import type { ReactNode } from 'react';

/**
 * A register: this system's panel primitive.
 *
 * A hairline box with a ruled header, flat on the surface plane. Not a rounded
 * card, not a shadow, and specifically not a card with a coloured left rail —
 * a rail spends chroma on a *container*, and in this palette chroma means
 * *state*. A register that is merely a register stays grey; the coloured thing
 * inside it is the one that is telling you something.
 *
 * `aside` is offered because a register is often complementary content and a
 * page full of `<section>`s with no accessible name is a landmark tree that
 * helps nobody.
 */
export function Register({
  title,
  meta,
  children,
  as: Tag = 'section',
  className = '',
  labelId,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  as?: 'section' | 'aside' | 'div';
  className?: string;
  labelId: string;
}) {
  return (
    <Tag aria-labelledby={labelId} className={`fb-register ${className}`}>
      <div className="fb-register-head">
        <h2 id={labelId} className="fb-label">
          {title}
        </h2>
        {meta ? <div className="fb-meta">{meta}</div> : null}
      </div>
      <div className="fb-register-body">{children}</div>
    </Tag>
  );
}
