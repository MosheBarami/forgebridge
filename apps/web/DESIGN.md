# Design — apps/web

The subject is a bridge between a language model and a game engine. Not a chat app that
happens to write Luau: a **workshop**, with an instrument panel at the top of it. A link
that is either live or not. A queue of proposed changes. A diff you read before you commit
to it.

Everything below follows from taking that literally, and from one refusal: an earlier
iteration of this product was a structural clone of a competitor, and it is not being
carried over. So this is not the default AI-app look — no purple-to-blue gradient hero, no
glassmorphism, no centred chat box on a dark page with one acid accent, no Inter, no emoji
section markers, no `rounded-xl` cards with a coloured left rail.

---

## 1. The thesis: chroma is reserved for state

The single decision the rest of the system hangs off.

**Interface chrome is achromatic.** Buttons, borders, panels, labels, body text — all of it
is drawn from a neutral ramp. The only coloured things on a screen are the *states of the
bridge*: is the link up, did validation pass, is a ChangeSet waiting for a human, is this
operation destructive.

Why, specifically here:

- The one moment this product cannot afford to blur is the moment something is waiting for
  approval (ADR-012). If the "Generate" button is a saturated brand colour, an amber
  "awaiting your approval" marker is competing with it for the same attention, and the
  marker loses — it is smaller and it is not what the user came to click.
- Three of the five things that make this app different are *state legibility* claims: the
  privacy posture must always be readable, the approval gate must be unmistakable, and a
  model fallback must be visible. A palette that spends its strongest colour on a logo has
  already spent the budget those claims need.
- It is falsifiable. "Is there colour on this screen that is not telling the user a fact
  about their bridge?" is a question a reviewer can answer in one glance.

Four states, and no more:

| Token | Means | Light | Dark |
|---|---|---|---|
| `--fb-live` | link up · validation passed · apply landed | `#0f6b4a` | `#5ccf9e` |
| `--fb-attend` | **something is waiting for a human** | `#7a5100` | `#edb44e` |
| `--fb-halt` | validation failed · destructive · apply failed | `#a32217` | `#ff8a78` |
| `--fb-idle` | unpaired · unknown · not asked yet | `#5f6769` | `#7e8785` |

Each clears 4.5:1 against its own canvas in its own theme (measured, not eyeballed:
5.6, 5.8, 6.2 in light; 9.3, 9.7, 7.8 in dark). Each is paired with a wash for chips, and
each is **always** accompanied by a word — `StatusDot` is `aria-hidden` on purpose, because
a colour alone fails WCAG 2.2 §1.4.1 and fails a colour-blind reader and fails a new user
who has not learned what green means here yet.

The greens and ambers are deliberately *muted*: a spruce rather than an emerald, a bronze
rather than a highlighter. A neon green reads as "success!" in a marketing sense. This one
needs to read as "the instrument says the circuit is closed", which is a quieter claim.

**There is no accent colour.** The primary button is ink — `--fb-fg` filled, `--fb-canvas`
text — in both themes. That is the whole interactive palette.

**There is no `danger` button variant.** A red button is a button people learn to click.
Destructive acts here (a bulk delete, a rollback) go through the same deliberate consent
control, with the destruction spelled out in words beside it and, past the protocol's
bulk-delete threshold, a separate confirmation the approver has to set on purpose.

---

## 2. The neutral ramp

Very slightly cool and green-tinted — anodised aluminium, not warm paper and not pure grey.
It sits under the state colours without arguing with them; a warm neutral would make the
amber look like part of the furniture, which is the one thing it must never look like.

Three planes, no shadows anywhere:

- `--fb-canvas` the page
- `--fb-surface` a register sits on this
- `--fb-raised` where content is *read closely* — code, inputs, diff bodies
- `--fb-sunken` the current nav item, an inline code run

Separation is by **hairline rule** (`--fb-rule`), never by shadow. A shadow implies a card
floating above a page; this is a panel, and its parts are milled into it.

`--fb-fg-faint` is darkened past the obvious choice (`#5f6769`, not `#6e7679`) so it still
clears 4.5:1 on canvas. A "muted" token that only passes at 18px is a token somebody will
eventually use at 13px.

### Focus: two rings, no third hue

```css
outline: 2px solid var(--fb-focus);   /* ink in light, paper in dark */
outline-offset: 2px;
box-shadow: 0 0 0 4px var(--fb-focus-halo);   /* the canvas colour */
```

An ink ring wrapped in a canvas-coloured halo is legible on a rule, on a wash, on a filled
button and on a code block — every surface this system has — without a per-component
override, and without introducing a fourth chroma that would collide with the four states.
A blue focus ring in a palette where blue means nothing would be a colour that carries no
information, which is precisely what §1 forbids.

---

## 3. Type: IBM Plex

**IBM Plex Sans** for interface and prose, **IBM Plex Sans Hebrew** for Hebrew,
**IBM Plex Mono** for code, paths, digests, model ids and pairing codes.

Not Inter. Three reasons, in order of how much they matter:

1. **Plex has a real Hebrew companion cut from the same skeleton.** The maintainer reads
   Hebrew and `dir="rtl"` is a first-class mode, not a checkbox. With Plex, switching to
   Hebrew changes the direction of the page without changing its typographic voice — the
   stroke weight, the x-height and the counters carry across. Pairing a Latin face with an
   unrelated Hebrew fallback is how an RTL locale ends up looking like a translation of the
   product rather than the product.
2. **Plex was drawn for technical documentation and instrumentation.** It has the slightly
   engineered, slightly impersonal quality this subject wants. Inter was drawn for screen
   UI in general and now reads as *the* default — the visual equivalent of not choosing.
3. **Plex Mono's disambiguation is load-bearing here.** The pairing code alphabet
   deliberately excludes `I`, `L`, `O`, `U`, `0` and `1` because a user reads those eight
   characters off a terminal and types them into Studio. A mono face where the surviving
   glyphs are still distinguishable is not a nicety.

Self-hosted via `next/font/google` — downloaded at build, served from this origin. A
product whose default posture is "nothing leaves this machine" should not make every
visitor's browser announce itself to a font CDN to render a heading.

### Scale

15px body, 14px controls, 13px meta, 12px labels. Denser than a marketing site, looser than
a terminal. Headings are 600 weight with `-0.011em` tracking and stop at 28px: this app has
no hero, so nothing needs to be 48px.

### The register label

12px, uppercase, `0.08em` tracking, muted. It is the instrument-panel voice and it is what
names every register on the page.

Under `[dir="rtl"]` it becomes a plain 13px semibold label with no transform and no
tracking. Hebrew is unicameral — `text-transform: uppercase` does nothing to it — and the
letter-spacing actively *harms* it by breaking the letterform relationships a reader uses
to find word shapes. Same class, different correct answer. This is the small, concrete
version of the next section.

---

## 4. RTL is a layout, not a transform

Mirroring a stylesheet gets you a page where the boxes moved and the details did not. The
details are where the damage is.

**Every inline-axis edge is logical.** `margin-inline-start`, `border-inline-end`,
`inset-inline-start`, and the Tailwind logical utilities `ms-*` `me-*` `ps-*` `pe-*`
`border-s` `border-e` `start-*` `end-*` `text-start`. Block-axis properties (`top`,
`mt-`, `pb-`) are unchanged, because they mean the same thing in both directions.

This is enforced, not promised: `src/test/logical-properties.test.ts` scans every `.ts`,
`.tsx` and `.css` file in `src/` and fails on `ml-`, `pl-`, `border-l`, `text-right`,
`left:`, `margin-right` and the rest. It found one violation on its first run — in a
comment in `app-shell.tsx` — which is roughly the point.

**Mono content is an explicit LTR island, in both locales.** `<Code dir="ltr">` with
`unicode-bidi: isolate`. This is the detail that matters most and it is not cosmetic: under
`dir="rtl"` the bidirectional algorithm reorders runs of neutral characters — the slashes
in `game/Workspace/Enemies/Spawner`, the colons and dots in `openrouter:z-ai/glm-5.2`, the
operators in a line of Luau — around the paragraph direction. A Hebrew-reading user
reviewing a diff would be shown a path that points somewhere the ChangeSet does not. Of
everything in this document, that is the one that could cause real damage to someone's
place.

**The skip link is `inset-inline-start`.** Pinned to the physical left, it would land on top
of the content it exists to skip past.

**The Hebrew test renders the shell, not a string.** `src/test/shell-rtl.test.tsx` mounts
the whole shell under `dir="rtl"` with the Hebrew dictionary, and asserts the Hebrew nav
labels, the LTR mono island, and that no physical-direction class reached the markup.

---

## 5. Space and shape

4px base, named `--fb-space-1` … `--fb-space-8`. Prose is capped at `72ch` (`--fb-measure`);
diffs, tables and code are full-bleed with their own `overflow-x`, because wrapping a Luau
line to a text measure is worse than a horizontal scrollbar.

**Radius stops at 3px.** `--fb-radius-sm: 2px`, `--fb-radius-md: 3px`, and nothing larger.
Rounded-xl is the house style of the thing this product is not.

**The register is the only container primitive.** A hairline box with a ruled header, flat
on the surface plane. Explicitly *not* a card with a coloured left rail: a rail spends
chroma on a container, and in this palette chroma means state (§1). A register that is
merely a register stays grey, so the coloured thing inside it is the one talking.

**Layout:** a pinned utility bar carrying the link register, a nav rail on the inline start,
and the working surface. The link state is in the bar rather than on a settings page
because ADR-014's mitigation says the posture is named "in the UI at all times", and a
promise kept somewhere nobody looks is not kept.

---

## 6. Where the approval control sits

A component rule and a layout rule, both from ADR-012.

`Button` has three weights: `primary` (ink fill), `secondary` (ruled outline), `consent`
(ruled outline with an amber border). **`consent` is deliberately not the heaviest weight on
the screen.** An approval that looks like the primary action is an approval people click
through on the way somewhere else.

The layout rule the component cannot enforce, stated here for whoever builds M35:

- The approve control lives in the **footer of the register that contains the diff**, after
  the operations, never in a toolbar above them and never adjacent to the run button.
- The diff shows the Luau. A diff that collapses source behind "12 changes" is not a diff,
  and a user who approved one did not approve what they think they did.
- The daemon requires the diff's `contentDigest` back on approve. A UI that lets a user
  approve without having loaded a diff has no digest to send. That is the gate working.

And from ADR-008: the run log names every model attempted and why the router moved on —
`glm-5.2:free → rate-limited → minimax-m3:free`. Collapsed by default, expandable, never
absent. The one-line form is `attemptSummary()` in `@forgebridge/protocol`.

---

## 7. Theming mechanics

Three blocks, in this order:

```css
:root { /* the complete LIGHT set */ }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark, unless the user chose light */ }
}

:root[data-theme="dark"] { /* dark, because the user chose dark */ }
```

The media query is **guarded** so an explicit light choice beats the OS. The third block is
not a repeat: without it a user on a light OS who picks dark gets nothing.

An inline blocking script (`theme-script.tsx`) resolves the preference and stamps
`data-theme` before first paint. That is not a polish item here — the first thing this app
shows is a status indicator whose colour carries meaning, and a colour that changes under
the reader is a colour they stop trusting.

Components read Tailwind utilities (`bg-surface`, `text-fg-muted`, `border-rule`) that
`@theme inline` maps to `var(--fb-*)`, so a utility follows a runtime theme change instead
of freezing whatever `:root` said at build time. **No component contains a colour literal,
and `dark:` is not used for colour** — colour goes through the tokens, which already answer
per theme.

`src/test/tokens.test.ts` checks the three blocks against each other: every literal colour
in `:root` must be answered in *both* dark blocks, and the two dark blocks must define
exactly the same set. That catches the one failure mode this pattern has and hides well —
a colour added to `[data-theme="dark"]` and forgotten in the media query, which breaks only
for a dark-OS user who never touched the switch.

---

## 8. Motion

Almost none. 150ms on background and opacity, and nothing else. Everything that moves here
is a state change — a link going live, a run stage advancing — which is informative, never
decorative.

`prefers-reduced-motion: reduce` therefore cuts durations to nothing rather than slowing
them down: the state still changes, it just stops being animated. Slowing an animation for
someone who asked for less motion gives them more of it.

---

## 9. What the shell states out loud

Because ADR-005 makes signed-out a first-class mode rather than a degraded one, the shell
says so rather than implying it by the absence of an avatar:

- a **"No account"** marker in the utility bar, and a footer line saying where the user's
  work lives ("in this browser until you choose otherwise");
- an empty state for "no daemon" written as a route forward, not an error — because for a
  signed-out first-time visitor that *is* the starting state, and because a browser cannot
  distinguish "nothing is listening" from "the daemon refused this origin", so both causes
  are named and the `--allow-origin` flag is printed with the origin already filled in.
