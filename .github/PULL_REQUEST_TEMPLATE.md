<!--
Thanks for contributing. Everything below is something a reviewer would otherwise have to ask
you for, one round trip at a time. Delete any section that genuinely does not apply.

Security fix? Do not describe the vulnerability here. Follow SECURITY.md first.
-->

## What and why

<!-- The diff already says what changed. Say why it should. -->

Closes #

## How it was verified

<!-- Not "tests pass" — what did you actually do to believe this works? -->

- [ ] `npm run check` (typecheck · lint · test · build)
- [ ] `npm run verify:boundaries`
- [ ] `npm run verify:assets`
- [ ] Exercised by hand:

## Checklist

- [ ] **Every commit is signed off** (`git commit -s`). CI blocks unsigned commits, and there
      is no CLA — see `CONTRIBUTING.md`.
- [ ] Tests cover the load-bearing behaviour — anything that touches a key, decides whether a
      ChangeSet may be applied, computes an inverse operation, or enforces a limit.
- [ ] Comments explain *why*, not *what*.
- [ ] No new dependency in `packages/protocol` (zod only) or `plugin/` without maintainer review.
- [ ] No secrets, `.env` files, or generated output committed.

## Scope

<!-- Tick anything this PR touches. The first two change the review path. -->

- [ ] **`packages/protocol`** — linked RFC: <!-- required -->
- [ ] **`plugin/`** (Roblox Studio) — linked RFC: <!-- required -->
- [ ] `packages/core`, a transport, or a connector
- [ ] `packages/model-registry` or a provider adapter
- [ ] `apps/`
- [ ] Docs, examples, CI, or scripts

<!--
Why those two need an RFC: every producer, every transport and the Luau plugin are measured
against the protocol, so a field added carelessly is a field we support forever; and the plugin
is the hardest thing in the system to update in the field — it runs inside someone else's Studio
session, with their account, against months of their work.
-->

## Constraints

<!-- Untick and explain rather than leaving a conflict to be found in review. An honest
     conflict is discussable; an unmentioned one is expensive. -->

- [ ] Costs nothing to run — no credits, metering, paywall, or paid tier.
- [ ] No user API key leaves the user's machine.
- [ ] Works signed-out, or degrades honestly without an account.
- [ ] No vendor SDK imported into `packages/core`; vendors stay behind ports.
- [ ] Nothing outside `apps/web` names the official instance.
- [ ] A producer still cannot approve its own ChangeSet.

## Brand assets

<!-- Only if this PR adds or changes anything under assets/brands/. -->

- [ ] The file is the vendor's official asset, downloaded from their own brand or press page.
- [ ] It was not redrawn, recoloured, reproportioned, traced, or generated.
- [ ] `manifest.json` records `sourceUrl`, `retrievedAt`, `licence`, `constraints`, `usage`, and
      the SHA-256, with `generated: false`.
- [ ] `npm run verify:assets` passes.

## Anything a reviewer should look at hardest

<!-- The part you are least sure about. Naming it makes review faster, not weaker. -->
