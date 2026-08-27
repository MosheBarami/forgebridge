import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Field, TextInput } from '@/components/ui/field';
import { CheckboxRow, FieldGroup } from './field';

/**
 * M39's form obligations, as tests.
 *
 * These are the failures that pass every other check. A control with no label
 * renders fine and looks fine. A hint that is merely adjacent to an input reads
 * fine to anyone using their eyes. An error appended below a field is visible.
 * All three are invisible to a screen reader, and none of them would fail a
 * build.
 *
 * The `Field` cases below exercise `components/ui/field.tsx`, which this
 * milestone uses rather than duplicates. Testing a shared primitive from here
 * is deliberate: the settings surface has the most controls in the app, it is
 * the one whose forms these guarantees are load-bearing for, and a change to
 * that primitive that quietly dropped the association would otherwise show up
 * as nothing at all.
 */
describe('the shared Field, as this surface relies on it', () => {
  it('labels the control it wraps', () => {
    render(
      <Field id="f1" label="Pinned model">
        {(control) => <TextInput {...control} type="text" defaultValue="" />}
      </Field>,
    );
    expect(screen.getByLabelText('Pinned model')).toBeInTheDocument();
  });

  it('associates the hint with the control rather than placing it beside it', () => {
    render(
      <Field id="f2" label="Set the folder" hint="A full instance path, dotted.">
        {(control) => <TextInput {...control} type="text" defaultValue="" />}
      </Field>,
    );
    expect(screen.getByLabelText('Set the folder')).toHaveAccessibleDescription(
      /A full instance path, dotted\./,
    );
  });

  it('marks the control invalid and describes it with the error', () => {
    render(
      <Field id="f3" label="Set the folder" error="Workspace is a whole service.">
        {(control) => <TextInput {...control} type="text" defaultValue="" />}
      </Field>,
    );
    const input = screen.getByLabelText('Set the folder');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Workspace is a whole service\./);
  });

  it('announces the error rather than only drawing it', () => {
    render(
      <Field id="f4" label="Set the folder" error="Not addressable.">
        {(control) => <TextInput {...control} type="text" defaultValue="" />}
      </Field>,
    );
    // `role="alert"` is an assertive live region, so the text is spoken when it
    // appears rather than when focus next happens to land on the field.
    expect(screen.getByRole('alert')).toHaveTextContent('Not addressable.');
  });

  it('describes the control with both, in reading order', () => {
    render(
      <Field id="f5" label="Set the folder" hint="A full instance path." error="Not addressable.">
        {(control) => <TextInput {...control} type="text" defaultValue="" />}
      </Field>,
    );
    expect(screen.getByLabelText('Set the folder')).toHaveAccessibleDescription(
      'A full instance path. Not addressable.',
    );
  });
});

describe('FieldGroup', () => {
  it('gives a group of controls a real legend', () => {
    render(
      <FieldGroup legend="Filters">
        <CheckboxRow label="Free only" checked={false} onChange={() => {}} />
      </FieldGroup>,
    );
    // The accessible name comes from the legend, which is what a screen reader
    // announces before each option. Without it the group is a set of unnamed
    // choices — "checkbox, 1 of 2" and nothing else.
    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument();
  });

  it('announces a group-level error', () => {
    render(
      <FieldGroup legend="Filters" error="Pick at least one.">
        <CheckboxRow label="Free only" checked={false} onChange={() => {}} />
      </FieldGroup>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one.');
  });
});

describe('CheckboxRow', () => {
  it('is a real checkbox, labelled, with its description associated', () => {
    render(
      <CheckboxRow
        label="Apply changes inside this folder without asking"
        description="Still journaled, still validated."
        checked={false}
        onChange={() => {}}
      />,
    );
    const box = screen.getByRole('checkbox', {
      name: 'Apply changes inside this folder without asking',
    });
    expect(box).toHaveAccessibleDescription(/Still journaled, still validated\./);
  });

  it('reports its disabled state to assistive technology, not only visually', () => {
    render(
      <CheckboxRow label="Apply without asking" checked={false} disabled onChange={() => {}} />,
    );
    expect(screen.getByRole('checkbox', { name: 'Apply without asking' })).toBeDisabled();
  });
});
