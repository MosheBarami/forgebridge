'use client';

import { useId, useState } from 'react';

import { useLocale } from '@/i18n/dictionary-context';
import { PATH_ROOTS, validatePathPrefix } from '@/lib/projects/store';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Field, TextInput } from '@/components/ui/field';

/**
 * The allowed-path list, edited (M34).
 *
 * Every entry is validated with the protocol's own `InstancePath` before it can
 * be added — see `lib/projects/store.ts` for why a second, looser validator
 * here would be worse than none. The rejection message is the protocol's own
 * text, so a user who typed `Workspace.My Model` is told that the segment is
 * not a safe identifier rather than "invalid path".
 *
 * The addressable roots are listed because they are a closed set the user
 * cannot be expected to have memorised, and because `SERVICE_ROOTS` is where
 * they come from — a hand-typed list here would be a fifth place that could
 * disagree with `packages/protocol/src/path.ts`.
 */
export function PathPrefixEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly string[];
  onChange: (next: readonly string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (): void => {
    const parsed = validatePathPrefix(draft);
    if (!parsed.ok) {
      setError(parsed.reason === 'empty' ? null : t('projects.create.prefixInvalid', { reason: parsed.reason }));
      return;
    }
    if (value.includes(parsed.value)) {
      setError(t('projects.create.prefixDuplicate'));
      return;
    }
    onChange([...value, parsed.value]);
    setDraft('');
    setError(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <Field
        id={inputId}
        label={t('projects.create.prefixes')}
        hint={t('projects.create.prefixesHelp')}
        error={error}
      >
        {(described) => (
          <div className="flex flex-wrap items-start gap-2">
            <TextInput
              {...described}
              // An instance path is LTR content: under `dir="rtl"` the bidi
              // algorithm would reorder the dots around the paragraph direction
              // and show the user a path that points somewhere else. Same
              // reasoning as `<Code dir="ltr">` — see DESIGN.md §4.
              dir="ltr"
              className="flex-1 font-mono text-[0.8125rem]"
              value={draft}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('projects.create.prefixPlaceholder')}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                // Enter adds a path rather than submitting the form around it.
                // A user halfway through listing three prefixes should not have
                // created the project by pressing Enter after the first.
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add();
              }}
            />
            <Button onClick={add} disabled={disabled || draft.trim().length === 0}>
              {t('projects.create.prefixAdd')}
            </Button>
          </div>
        )}
      </Field>

      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((path) => (
            <li key={path}>
              <span className="inline-flex items-center gap-2 rounded-sm border border-rule bg-sunken px-2 py-1">
                <Code className="bg-transparent px-0">{path}</Code>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((entry) => entry !== path))}
                  // The accessible name names the path. A row of six identical
                  // "Remove" buttons is a list a screen-reader user cannot use.
                  aria-label={t('projects.create.prefixRemove', { path })}
                  className="rounded-sm text-fg-faint transition-colors duration-150 hover:text-halt disabled:opacity-40"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="fb-meta">
        {t('projects.create.roots')}:{' '}
        {PATH_ROOTS.map((root, index) => (
          <span key={root}>
            {index > 0 ? ', ' : ''}
            <Code>{root}</Code>
          </span>
        ))}
      </p>
    </div>
  );
}
