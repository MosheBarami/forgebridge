# Contributing to ForgeBridge

Thanks for being here. This document is the whole process — there is no second, hidden one.

Before anything else: this project follows a [Code of Conduct](CODE_OF_CONDUCT.md), and
security problems go through [`SECURITY.md`](SECURITY.md) rather than the public tracker.

---

## The three rules that are not negotiable

1. **Every commit is signed off.** `git commit -s`. CI blocks unsigned commits.
2. **Changes to `packages/protocol` or `plugin/` need an RFC first.** Those two are the
   durable assets; everything else is replaceable.
3. **Never generate a brand asset.** Official file, official source, recorded provenance —
   or a plain text label. There is no third option.

Everything else is a pull request and a green CI.

---

## Developer Certificate of Origin — and why there is no CLA

Every commit must carry a `Signed-off-by:` line whose email matches the commit author:

```bash
git commit -s -m "daemon: bind the fixed default port"
# adds: Signed-off-by: Your Name <you@example.org>
```

Forgot on the last commit:

```bash
git commit --amend -s --no-edit
```

Forgot across a branch:

```bash
git rebase --signoff main
```

Signing off means you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution, or have the right to submit it under the project's licence.
It is an assertion about provenance. It is not a transfer of anything.

**There is no CLA, and there will never be one.** A Contributor License Agreement assigns the
project rights *beyond* the licence you contributed under — most usefully, the right to
relicense your work later without asking you. On a project whose first written promise is
"free forever", a CLA is a standing relicensing option that nobody asked for and that quietly
contradicts the promise. Contributors keep their copyright. We take nothing beyond MIT.

CI enforcement lives in [`.github/workflows/dco.yml`](.github/workflows/dco.yml). It checks the
commits in your pull request, skips merge commits, and tells you exactly which commit is
missing a sign-off.

---

## RFCs — what needs one, and what does not

An RFC is required for anything that changes:

- **`packages/protocol`** — schemas, field names, limits, error codes, endpoint shapes.
  Every producer, every transport, and the Luau plugin are all measured against this package.
  A field added carelessly is a field we support forever.
- **`plugin/`** — the Studio plugin's behaviour, its transport surface, or its permissions.
  The plugin is the hardest thing in the system to update in the field: it runs inside
  someone else's Studio session, with their account, on their months of work.

An RFC is **not** required for: bug fixes, tests, docs, new provider adapters, new connectors,
performance work, or anything under `apps/`.

**How.** Open a discussion or issue first to check the idea is wanted, then open a PR adding
`rfcs/NNNN-short-title.md` covering: the problem, the options you considered (including the
ones you rejected and why), the decision, the trade-off you are accepting, the migration path
for anything already on the old shape, and the trigger that would make us revisit it. That is
the same shape as the [existing ADRs](docs/architecture/README.md) — read two of them before
writing your first RFC.

Accepted RFCs land as ADRs with the rationale attached. Per
[`docs/GOVERNANCE.md`](docs/GOVERNANCE.md), a decision without a written rationale is not a
decision.

> **TODO(M50):** `rfcs/0000-template.md` does not exist yet. The maintainer adds the directory
> and template; until then, copy the structure of an existing ADR.

---

## The contribution ladder

| Rung | How you get there | What it means |
|---|---|---|
| **Contributor** | Open a PR | Your work ships. No gatekeeping beyond review and CI. |
| **Reviewer** | 5 merged PRs, then an invitation | Your review counts toward merging in your area. |
| **Maintainer** | BDFL invitation | You own an area: its roadmap, its reviews, its releases. |

Governance is BDFL — one maintainer holds final say on scope, architecture, and releases, and
every use of that veto is public and written down. The reasoning, the bounds on it, and the
succession rule are in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

---

## Getting set up

Node 22+ is required (`NodeNext` resolution, ESM everywhere, TypeScript strict).

```bash
git clone <this repository>
cd forgebridge
npm ci                        # never `npm install` in a PR — the lockfile is the contract
npm run check                 # typecheck · test · build, across the workspace
npm run verify:boundaries     # the four machine-checked boundary rules (B1–B4)
npm run verify:assets         # brand-asset provenance
npm run verify:no-key-storage # no credential-shaped field reaches storage (ADR-006)
npm run verify:no-secrets     # no secret-shaped or machine-local string in the tree (ADR-013)
npm run verify:schemas        # the JSON Schema, OpenAPI and Python projections are current
npx vitest run --dir scripts  # the gates' own tests — a gate that cannot fail is decoration
```

Run every one of those before you push: they are the same commands CI runs, they fail fast, and
`npm run check` does **not** invoke the gates for you. Adding a `verify:*` script without adding
it to this block is itself a caught error — `scripts/__tests__/docs-claims.test.ts` asserts that
every gate in the root manifest is listed here, and that every one of them is run by a CI job.

Two things `npm run check` does not give you, despite appearances:

- **`lint` is a no-op.** `check` is `turbo run typecheck lint test build`, and every package's
  `lint` script is an `echo` — there is no linter configured in this repository (TODO(M04),
  and configuring one is its own row, M04b). A green `check` says nothing was linted. Match the
  surrounding code by hand until that lands.
- **The `verify:*` gates are not in it.** They are the list above. Four of them —
  `verify:boundaries`, `verify:assets`, `verify:no-key-storage`, `verify:no-secrets` — run in
  their own CI job (**Repository gates**), which needs no build output and so fails in seconds.
  `verify:schemas` is the exception: it reads the daemon's wire module, which resolves
  `@forgebridge/protocol` through the workspace symlink, so it runs after the build in the
  **typecheck · test · build** job. Run `npm run check` first if you are running it by hand.
  A contributor who runs only `check` passes locally and fails in CI.

If you change a Zod schema in `packages/protocol/src`, run `npm run generate:schemas` and commit
what it writes. The generated files under `packages/protocol/schema/` and the generated
`models.py` under `packages/sdk-python` are part of the same change as the schema edit (M08);
landing one without the other is the drift `verify:schemas` exists to refuse.

### Where code goes

`docs/REPO-LAYOUT.md` is the map. The four rules it declares are machine-checked by
`scripts/verify-boundaries.ts`:

| Rule | Why it exists |
|---|---|
| **B1** `packages/protocol` imports nothing but `zod` | The contract must stay importable from any runtime, forever. One dependency is the entire budget. |
| **B2** `packages/core` imports no vendor SDK | Vendors live behind ports. A direct `@supabase/*` or `next` import makes self-hosting a fiction. |
| **B3** Nothing under `packages/`, `plugin/` or `examples/` names the official instance | The core is neutral or it is not adoptable by rival tools (ADR-001). |
| **B4** No package imports an app | Apps depend on packages. Never the reverse. |

If you need a vendor, write an adapter package behind the relevant port. If you need something
in the protocol, write an RFC.

### What needs a test

Not coverage theatre — the things that would be a security or data-loss bug if they were
wrong. Concretely: anything that touches a user's key, anything that decides whether a
ChangeSet may be applied, anything that computes an inverse operation, anything that enforces
a limit, and every CI gate (a gate that cannot fail is decoration). Vitest for TypeScript;
plugin tests live in `plugin/tests/`.

### Commit messages

`area: imperative summary` — for example `router: record why each candidate was skipped`. Body
explains *why*, not *what*; the diff already says what. Comments follow the same rule: look at
`packages/protocol/src/` for the density and voice to match.

---

## Adding a provider — the five-minute checklist

Adding a model provider means adding its logo, and that is where projects like this
accidentally ship an AI-drawn approximation of somebody's trademark. An approximation is worse
than no logo: it is wrong, it is unlicensed, and it looks like an endorsement. So this checklist
is deliberately mechanical. The full policy is [`docs/BRAND-ASSETS.md`](docs/BRAND-ASSETS.md).

1. **Find the vendor's own brand page.** Their press kit, media kit, or brand-guidelines page —
   on their domain. Not a logo aggregator, not an image search, not a CDN hotlink. If they do
   not publish one, stop at step 7.
2. **Read their terms.** Some vendors forbid use of their mark outside a partnership. If theirs
   do, stop at step 7 — that is a valid, finished outcome.
3. **Download the official file** into `assets/brands/<vendor-slug>/`. Do not recolour it, do
   not reproportion it, do not trace it, do not regenerate it, do not "clean it up".
4. **Hash it.**
   ```bash
   shasum -a 256 assets/brands/<vendor-slug>/logo.svg
   ```
5. **Add the manifest entry** in `assets/brands/manifest.json`. Copy the shape from the
   `$example` key already in the file. Every field is required and none may be blank:
   `files`, `sourceUrl` (the page from step 1, `https://`, on the vendor's domain),
   `retrievedAt` (today, `YYYY-MM-DD`), `licence` (the terms from step 2, in their words where
   they state them), `constraints` (what they forbid), `usage` (which surfaces show it),
   `sha256` (step 4), and `generated: false`.
6. **Prove it.**
   ```bash
   npm run verify:assets
   ```
   It fails on: a file with no entry, a blank `sourceUrl`/`licence`/`retrievedAt`, a placeholder
   URL, a checksum that no longer matches, a manifest entry pointing at a file that is not
   there, two entries claiming the same file, and any object anywhere in the manifest with
   `generated: true`.
7. **No usable official asset?** Use a plain text label in the UI and add no file. This is the
   correct outcome, not a failure — and it is the only alternative to an official asset.

Then wire the adapter itself. Provider adapters live in their own package behind the provider
port (never in `packages/core`, see rule B2), and the model catalog is **synced, never
hand-written**: `scripts/sync-catalog.ts` reads live provider catalogs, and `free` is derived
from an observed price of zero at a recorded timestamp. Do not hand-add a model, and never
hand-add a "free models" list — a stale one is how tools like this lose trust
([ADR-007](docs/architecture/adr-007-registry-as-synced-data.md)).

---

## Opening a pull request

- Branch from `main`, keep it focused, and say in the description *why* rather than restating
  the diff.
- Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) — it is short and every line of it
  is something a reviewer would otherwise have to ask you.
- Green CI. That is two jobs: **Repository gates** — `verify:boundaries`, `verify:assets`,
  `verify:no-key-storage`, `verify:no-secrets`, and the gates' own tests — and
  **typecheck · test · build**, which also runs the placeholder `lint` (TODO(M04)) and fails if
  the build wrote into the working tree. Plus DCO on every commit.
- Do not add a dependency to `packages/protocol` or `plugin/` without maintainer review; both
  are supply-chain-sensitive and one of them runs inside people's Studio sessions.
- Do not commit generated output, `.env` files, or anything you would not want in a public
  repository forever. Git history is not editable in practice once it is public.

Review aims to be quick and specific. If something is taking a while, a nudge on the PR is
welcome and not rude.
