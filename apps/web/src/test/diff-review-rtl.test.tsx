import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { LocaleProvider } from '@/i18n/dictionary-context';
import type { ChangeSetDiff } from '@/lib/daemon/wire';
import { DiffReview } from '@/app/[locale]/generate/diff-review';
import he from '@/i18n/dictionaries/he.json';
import en from '@/i18n/dictionaries/en.json';

/**
 * The diff, rendered — in Hebrew, and in English.
 *
 * Three claims are pinned here, and each of them is a thing the product would
 * be lying about if it broke:
 *
 *   1. **The Luau is on screen, in full.** ADR-012 makes approval the safety
 *      mechanism; a diff that hides the code turns it into a formality. The
 *      test asserts the *whole* source is present, including a line near the
 *      end, so a truncating renderer fails rather than passing on a prefix.
 *
 *   2. **Under `dir="rtl"` the code and the paths stay LTR islands.** This is
 *      the one in DESIGN.md §4 that could cause real damage: the bidirectional
 *      algorithm reorders runs of neutral characters — the dots in an instance
 *      path, the operators in a line of Luau — around the paragraph direction.
 *      A Hebrew-reading reviewer would be shown a path pointing somewhere the
 *      ChangeSet does not.
 *
 *   3. **Approve is not the primary control, and it sits after the
 *      operations.** DESIGN.md §6. Both are structural facts a test can hold.
 */

const LUAU = [
  'local Players = game:GetService("Players")',
  'local shop = script.Parent',
  '',
  'shop.ProximityPrompt.Triggered:Connect(function(player)',
  '\tlocal coins = player.leaderstats.Coins',
  '\tif coins.Value >= 50 then',
  '\t\tcoins.Value -= 50',
  '\tend',
  'end)',
  'print("shop ready")',
].join('\n');

const PATH = 'ServerScriptService.Shop.PurchaseHandler';

function diffFixture(overrides: Partial<ChangeSetDiff> = {}): ChangeSetDiff {
  return {
    changeSetId: '5f2b9c11-3a4d-4e6f-8a1b-2c3d4e5f6a7b',
    projectId: '2c9f5d1e-6a3b-4f8c-9d21-7b6e4a0f1c33',
    summary: 'Add a shop stand that sells a speed coil',
    status: 'validated',
    baseVersion: 4,
    currentVersion: 4,
    stale: false,
    counts: { total: 1, creates: 0, setProperties: 0, scripts: 1, moves: 0, deletes: 0 },
    contentDigest: 'sha256:1f3c7a90b2e4d6f8',
    operations: [
      {
        index: 0,
        op: 'writeScript',
        paths: [PATH],
        summary: `write Script ${PATH} (${String(LUAU.length)} bytes)`,
        destructive: false,
        after: LUAU,
      },
    ],
    validation: {
      luau: { status: 'ok', findings: [] },
      policy: { status: 'ok', violations: [] },
      computedAt: '2026-08-27T10:00:00.000Z',
      computedBy: 'forgebridge-daemon@0.1.0',
    },
    treeAware: false,
    ...overrides,
  };
}

function mount(locale: 'en' | 'he', diff: ChangeSetDiff, onApprove = vi.fn()) {
  const dir = locale === 'he' ? 'rtl' : 'ltr';
  // `dir` on a real ancestor element, because that is what the bidi algorithm
  // and the `[dir="rtl"]` CSS selectors actually key off.
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <div dir={dir}>
      <LocaleProvider locale={locale} dir={dir} dictionary={locale === 'he' ? he : en}>
        {children}
      </LocaleProvider>
    </div>
  );

  const utils = render(
    <DiffReview diff={diff} onApprove={onApprove} onReject={vi.fn()} outcome={null} approving={false} />,
    { wrapper: Wrapper },
  );
  return { ...utils, onApprove };
}

describe('the diff shows the Luau that will run', () => {
  it('renders the whole source, not a truncated preview', () => {
    mount('en', diffFixture());

    const code = screen.getByText((_, element) => element?.tagName === 'CODE' && element.textContent === LUAU);
    expect(code).toBeTruthy();

    // Explicitly: a line from the end of the file. A renderer that showed the
    // first few lines and an ellipsis would pass a naive "contains" check.
    expect(code.textContent).toContain('print("shop ready")');
    expect(code.textContent).toContain('coins.Value -= 50');
  });

  it('names the operation as one that installs Luau', () => {
    mount('en', diffFixture());
    expect(screen.getByText(en.generate.diff.carriesLuau)).toBeTruthy();
  });

  it('labels the validation verdict with who computed it', () => {
    // "Computed by whom" is the difference between a verdict and a model
    // marking its own homework.
    mount('en', diffFixture());
    expect(screen.getByText(/forgebridge-daemon@0\.1\.0/)).toBeTruthy();
  });

  it('shows the content digest the approval will carry', () => {
    mount('en', diffFixture());
    expect(screen.getByText('sha256:1f3c7a90b2e4d6f8')).toBeTruthy();
  });
});

describe('under dir="rtl"', () => {
  it('renders Hebrew chrome', () => {
    mount('he', diffFixture());
    expect(screen.getByText(he.generate.diff.operations)).toBeTruthy();
    expect(screen.getByText(he.generate.approve.button)).toBeTruthy();
  });

  it('keeps the Luau an explicit LTR island', () => {
    // Without this, the bidi algorithm reorders the operators and punctuation
    // in every line of the script around the RTL paragraph direction.
    mount('he', diffFixture());

    const pre = screen
      .getByText((_, element) => element?.tagName === 'CODE' && element.textContent === LUAU)
      .closest('pre');

    expect(pre).not.toBeNull();
    expect(pre?.getAttribute('dir')).toBe('ltr');
  });

  it('keeps the instance path an explicit LTR island', () => {
    // The one that could cause real damage: a reviewer shown a path that points
    // somewhere the ChangeSet does not.
    mount('he', diffFixture());

    const path = screen.getAllByText(PATH).find((element) => element.tagName === 'CODE');
    expect(path).toBeTruthy();
    expect(path?.getAttribute('dir')).toBe('ltr');
  });

  it('uses no physical-direction classes in the rendered markup', () => {
    // The static scan in `logical-properties.test.ts` reads source; this reads
    // what actually reached the DOM, including anything composed at runtime.
    const { container } = mount('he', diffFixture());

    const classes = [...container.querySelectorAll<HTMLElement>('[class]')]
      .flatMap((element) => element.className.split(/\s+/))
      .filter(Boolean);

    const physical = classes.filter((name) =>
      /^-?(ml|mr|pl|pr)-|^border-[lr]$|^rounded-[lr]$|^text-(left|right)$|^(left|right)-/.test(name),
    );

    expect(physical, `physical-direction classes reached the DOM: ${physical.join(' ')}`).toEqual([]);
  });
});

describe('the approval control', () => {
  it('is not the primary weight on the screen', () => {
    // DESIGN.md §6: an approval that looks like the primary action is an
    // approval people click through on the way somewhere else. `consent` is a
    // ruled outline with an amber border; `primary` is an ink fill.
    mount('en', diffFixture());

    const approve = screen.getByRole('button', { name: en.generate.approve.button });
    expect(approve.className).toContain('border-attend');
    expect(approve.className).not.toContain('bg-fg');
  });

  it('sits after the operations in document order', () => {
    const { container } = mount('en', diffFixture());

    const operations = container.querySelector('#diff-operations');
    const approve = screen.getByRole('button', { name: en.generate.approve.button });
    expect(operations).not.toBeNull();

    // `DOCUMENT_POSITION_FOLLOWING` — the button comes after the operations
    // heading, so a reader reaches the code before the control.
    // eslint-disable-next-line no-bitwise
    const following = (operations as Element).compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(following).toBeTruthy();
  });

  it('sends the digest from the diff that was read', () => {
    const { onApprove } = mount('en', diffFixture());

    screen.getByRole('button', { name: en.generate.approve.button }).click();

    // The component reports the decision; the surface attaches the digest from
    // the diff it is holding. What is pinned here is that approving is possible
    // only from a loaded diff — the callback fires with the reviewer's inputs,
    // and `generate-surface.tsx` pairs them with `diff.contentDigest`.
    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ approvedBy: 'local', confirmBulkDelete: false }),
    );
  });
});

describe('approval is withheld when the page cannot vouch for the diff', () => {
  it('refuses to offer approval when validation failed', () => {
    mount(
      'en',
      diffFixture({
        validation: {
          luau: {
            status: 'fail',
            findings: [
              {
                severity: 'error',
                rule: 'luau/no-loadstring',
                message: 'loadstring is not permitted',
                operationIndex: 0,
              },
            ],
          },
          policy: { status: 'ok', violations: [] },
          computedAt: '2026-08-27T10:00:00.000Z',
          computedBy: 'forgebridge-daemon@0.1.0',
        },
      }),
    );

    expect(screen.getByText(en.generate.approve.blockedValidation)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.generate.approve.button })).toHaveProperty('disabled', true);
    // The finding itself is on screen, not just the refusal.
    expect(screen.getByText('loadstring is not permitted')).toBeTruthy();
  });

  it('refuses when the daemon counted a script this page could not resolve', () => {
    // The 2026-08 plugin defect, caught at the approval gate: the daemon says
    // the set installs a script, the operation list renders no code.
    mount(
      'en',
      diffFixture({
        counts: { total: 1, creates: 1, setProperties: 0, scripts: 1, moves: 0, deletes: 0 },
        operations: [
          {
            index: 0,
            op: 'createInstance',
            paths: ['ServerScriptService.Sneaky'],
            summary: 'create Script at ServerScriptService.Sneaky',
            destructive: false,
          },
        ],
      }),
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(within(screen.getByRole('alert')).getByText(en.generate.diff.undisclosed.title)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.generate.approve.button })).toHaveProperty('disabled', true);
  });

  it('refuses when the ChangeSet is stale', () => {
    mount('en', diffFixture({ stale: true, baseVersion: 4, currentVersion: 9 }));

    expect(screen.getByText(en.generate.approve.blockedStale)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.generate.approve.button })).toHaveProperty('disabled', true);
  });

  it('requires the bulk-delete confirmation the protocol asks for', () => {
    // Past the threshold the daemon refuses an approval that does not carry
    // `confirmBulkDelete`. A UI that set it silently would be answering a
    // question the protocol asked the human.
    mount(
      'en',
      diffFixture({
        counts: { total: 20, creates: 0, setProperties: 0, scripts: 0, moves: 0, deletes: 20 },
      }),
    );

    const approve = screen.getByRole('button', { name: en.generate.approve.button });
    expect(approve).toHaveProperty('disabled', true);

    const confirm = screen.getByRole('checkbox');
    confirm.click();

    expect(screen.getByRole('button', { name: en.generate.approve.button })).toHaveProperty('disabled', false);
  });
});
