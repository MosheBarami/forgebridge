import type { ReactNode } from 'react';

/**
 * Monospaced content: a Luau source line, an instance path, a content digest, a
 * shell command, a model id.
 *
 * `dir="ltr"` is not decoration and it is not optional. Under `dir="rtl"` the
 * bidirectional algorithm reorders a run of neutral characters — the slashes in
 * `game/Workspace/Spawn`, the dots in `openrouter:z-ai/glm-5.2`, the operators
 * in a line of Luau — around any strong RTL character near it, and around the
 * paragraph direction itself. The path is then displayed in an order it does
 * not have. A Hebrew-reading user reviewing a diff would be shown a path that
 * points somewhere else, which is the single worst thing this app could do.
 *
 * So every mono run is an explicit LTR island, in both locales. `unicode-bidi:
 * isolate` keeps it from disturbing the Hebrew text around it in return.
 */
export function Code({
  children,
  className = '',
  block = false,
}: {
  children: ReactNode;
  className?: string;
  block?: boolean;
}) {
  const shared = 'font-mono text-[0.8125rem] [unicode-bidi:isolate]';

  if (block) {
    return (
      <pre
        dir="ltr"
        className={`${shared} overflow-x-auto rounded-sm border border-rule bg-raised p-3 leading-relaxed text-fg ${className}`}
      >
        <code>{children}</code>
      </pre>
    );
  }

  return (
    <code
      dir="ltr"
      className={`${shared} rounded-sm bg-sunken px-1 py-px text-fg ${className}`}
    >
      {children}
    </code>
  );
}
