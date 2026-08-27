# apps/web

The ForgeBridge web surface — `apple.gg` when it is deployed, and a perfectly ordinary
self-hosted Next app when it is not.

This package is the **foundation** for M32–M39. Three other agents build the surfaces on
top of it. This document says what is real, what is a placeholder, and what has not been
run — hold it to that.

---

## Run it

```bash
npm install                        # from the repo root; workspaces are already wired
npm run build --workspace @forgebridge/protocol
npm run dev  --workspace @forgebridge/web        # http://localhost:3000
```

Then, in another terminal, the daemon — **with this page's origin allowed**:

```bash
npx forgebridge daemon --allow-origin http://localhost:3000
```

The `--allow-origin` is not optional for a browser client. `packages/daemon`'s
`originIsAllowed` refuses any `Origin` it was not started with, and to JavaScript that
refusal is indistinguishable from nothing listening at all. The app's empty state says so.

The daemon prints a **producer token** on startup. Paste it into the field on the bridge
page; producer routes (propose, diff, approve, rollback, run) require it.

---

## What is real

| Thing | Where | Notes |
|---|---|---|
| Next 15 App Router app, TS strict, React 19 | `src/app` | `tsconfig.json` extends `../../tsconfig.base.json` and overrides only what a bundler-resolved JSX app must |
| Tailwind v4, CSS-first | `src/app/globals.css`, `postcss.config.mjs` | No `tailwind.config.js` — the design system is declared in CSS |
| The token system | `src/app/globals.css` | Complete light set on `:root`; dark under a *guarded* `prefers-color-scheme` query; the same tokens again under `[data-theme="dark"]`. Rationale in `DESIGN.md` |
| Theme switch, no flash | `lib/theme.ts`, `components/shell/theme-script.tsx` | Three-valued preference (system / light / dark); inline script stamps `data-theme` before first paint |
| Locale routing, en + he | `src/middleware.ts`, `src/app/[locale]` | Locale in the path always; cookie beats `Accept-Language` beats default |
| Dictionaries + loader | `src/i18n` | 84 keys, en/he at parity. A missing key renders **as the key** — see below |
| Real RTL | everywhere | Logical properties only, enforced by a test; `dir="ltr"` islands for mono content |
| Typed `/v1` client | `lib/daemon/client.ts` | health · link · models · submit · diff · approve · rollback · output · runs · SSE run events |
| "No daemon" as a normal state | `lib/daemon/use-daemon.ts`, `components/daemon-empty-state.tsx` | A return value, never a throw |
| Storage port + IndexedDB adapter | `lib/storage` | Works with no account |
| App shell | `components/shell` | Pinned link register, nav, theme + locale switches, landmarks, skip link |
| Accessibility foundation | `globals.css`, shell | Skip link, two-ring focus, named landmarks, `prefers-reduced-motion`, colour never used alone |
| Tests | `src/test` | RTL/posture rendering, token-block parity, logical-property gate |

### The five product invariants, and where each is honoured

1. **It works signed out.** There is no auth anywhere in this package and no surface asks
   for one. The shell states it (`"No account"`, and a footer saying where work lives).
2. **Nothing applies without a human.** `Button` has a `consent` weight that is
   deliberately not the heaviest on screen; `client.approve()` requires the diff's
   `contentDigest`, so a caller that never loaded a diff cannot approve. The layout rule
   for M35 is written down in `DESIGN.md` §6.
3. **The privacy posture is always on screen.** `LinkIndicator` renders one of
   `PRIVACY_POSTURE`'s three exact strings, verbatim, in the pinned utility bar. Never a
   padlock. Never the word "encrypted" about a link that is not. Pinned by a test.
4. **The model fallback is visible.** `RunResponse.run.attempts` is parsed and typed;
   `attemptSummary()` in the protocol renders the collapsed line. The surface that draws it
   is M35's.
5. **Keys never reach our server.** This package ships **zero route handlers** — there is
   no `route.ts` anywhere under `src/app`. The only network egress is a browser `fetch` to
   the daemon on loopback. `npm run verify:no-key-storage` passes with `apps/` scanned.

### Why the daemon is called from the browser

The daemon listens on the *user's* loopback interface. A Next server rendering this app —
on apple.gg, or on a self-hoster's box — cannot reach it. So every `/v1` call is a
client-side `fetch`, pages are Server Components that hand off to one Client Component for
anything daemon-dependent, and there is no server-side proxy.

That is also what makes ADR-006 structural rather than a policy: there is no app route for
a key to be POSTed to.

### Where the producer token lives

In memory, in a `useRef` inside `lib/daemon/session.tsx`, for the life of the tab. Not in
the Storage port, not in `localStorage`, not in a cookie.

The daemon mints a **new token on every process start**, so a persisted copy is stale the
moment the user restarts it — persistence would buy a stored bearer credential in exchange
for a value that is usually wrong. Routing it through `StoragePort` would also put a
credential in a port's signature, which is rule K2 of `verify:no-key-storage`.

Cost: a reload asks for it again. The daemon prints it on the terminal the user is already
looking at.

### Missing translation keys render as the key

`t('generate.approve.confirm')` with no such key renders that string, in place, and nothing
throws. Deliberate: a surface under construction should look under construction. An empty
string is a layout that looks finished and is not.

---

## What is **not** built

- **Five of the six surfaces.** `generate` (M35), `projects` (M34), `inventory` (M36),
  `map` (M37) and `settings` (M38) are one-line placeholders naming their milestone. They
  exist so the nav never links into a 404 — a dead nav link teaches a reviewer the shell is
  broken when the truth is that the surface is somebody's next job.
- **The Supabase storage adapter.** `lib/storage/index.ts` carries `TODO(M33)`. The
  interface is there so it can be added without a rewrite. The rule that migration must
  honour: signing in **adopts** what the local adapter holds, never replaces it.
- **Sign-in.** Not started. Not this agent's job; making it possible without a rewrite was.
- **The ChangeSet queue.** The bridge page's queue register is empty and says so. The
  daemon has no "list changesets" route — only `GET /v1/changesets/:id/diff` — so there is
  nothing to enumerate yet. `TODO(M35)` in `app/[locale]/bridge-surface.tsx`.
- **A linter.** `npm run lint` in this package is an `echo`, like every other package's,
  and `next.config.ts` sets `eslint.ignoreDuringBuilds` so `next build` does not offer to
  give this one package a linter the other eight do not have. That decision belongs to
  M04b.
- **An E2E test.** `M41` owns it. What exists here is unit and component level.

### Envelope shapes are restated, not imported

`lib/daemon/wire.ts` declares `HealthResponse`, `LinkStatusResponse`, `ChangeSetDiff` and
the rest, built out of `@forgebridge/protocol` primitives. They are *duplicates* of
`packages/daemon/src/wire.ts`.

That is a deliberate trade with a real cost. Importing `@forgebridge/daemon` would couple a
browser bundle to a Node HTTP server package. Restating costs a second definition that can
go stale — paid down two ways: every shape is assembled from protocol primitives rather
than loose strings, and every response is **parsed**, so a daemon on a different build
produces `invalid-response` at the seam instead of `undefined` three renders later.

`packages/daemon/src/wire.ts` already carries `TODO(M31)` asking for these to be promoted
into `@forgebridge/protocol`. When that lands, delete `lib/daemon/wire.ts`.

One shape is transcribed from a handler rather than a schema: `SubmitChangeSetResponse`.
`POST /v1/changesets` has no schema of its own — the daemon's own TODO(M31) says so, and
notes that the hand transcription in `scripts/generate-schemas.ts` currently omits
`contentDigest`. This app parses the field the handler actually sends.

---

## What has **not** been run

Said plainly, because this repository does not accept "it works" without evidence.

**`next build` has not been executed.** The task forbids `npm install`, and `next`, `react`
and `tailwindcss` are not present in this tree — so there was no build to run. What *was*
verified:

- all 43 `.ts`/`.tsx` files parse clean under the repo's own TypeScript (`ts.createSourceFile`,
  0 syntax diagnostics);
- `npm run verify:boundaries` — clean, with `apps/` scanned;
- `npm run verify:no-key-storage` — clean, and it now sees this package's `StoragePort` and
  `StoredRecord` among the 45 shapes that reach storage;
- `npm run verify:no-secrets` — clean;
- the two source-scanning tests were simulated against the real files: the logical-property
  gate reports 0 violations, and the token-block gate reports 22 colour tokens in `:root`
  with both dark blocks answering all 22.

Type-checking, `next build` and `vitest run` need the install step. Two things to watch on
that first run:

1. **`next/font/google` fetches at build time.** `IBM_Plex_Sans`, `IBM_Plex_Sans_Hebrew` and
   `IBM_Plex_Mono` are downloaded and self-hosted during `next build`. A build machine with
   no network to `fonts.googleapis.com` will fail there. The fallback stacks in
   `--fb-font-sans` / `--fb-font-mono` cover the *runtime* case, not the build one.
2. **`@forgebridge/protocol` must be built first.** It resolves to `dist/`; turbo's
   `build`/`test`/`typecheck` tasks already `dependsOn: ["^build"]`.

---

## The one edit outside this directory

None was needed. The root `package.json` already lists `"apps/*"` in `workspaces`, so this
package is picked up as-is. Nothing else in the repository was touched.

---

## For the agents building on this

- **Replace a page, not the app around it.** Each placeholder page is a single component
  call. The shell, tokens, i18n, daemon client and storage port are underneath it.
- **Add strings to both dictionaries.** `src/i18n/dictionaries/{en,he}.json`. Missing keys
  render as keys; they do not throw. If you cannot write the Hebrew, add the English key and
  leave the Hebrew as the key — visible and findable beats absent.
- **Never write a physical inline-axis edge.** `logical-properties.test.ts` will fail you.
  Use `ms-`/`me-`/`ps-`/`pe-`/`border-s`/`border-e`/`start-`/`end-`/`text-start`.
- **Never write a colour literal.** Use a token. `tokens.test.ts` will catch a token added
  to one dark block and not the other.
- **Wrap every path, digest, model id and line of Luau in `<Code>`.** It is an LTR island;
  without it, Hebrew readers see reordered paths.
- **Render `PRIVACY_POSTURE` verbatim** anywhere a link is shown. Not translated, not
  shortened, not an icon.
- **Read `DESIGN.md` §6 before building the approve control.**
