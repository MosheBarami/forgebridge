# ADR-013: Publish from a fresh repository; quarantine the existing history

## Status
Accepted

## Context
A private predecessor repository holds a working web app, and flipping it public is the
obvious move. Its history is not publishable: it contains live credentials, and third-party
material gathered for research that was never cleared for redistribution.

Deliberately, this ADR does not enumerate what that material is. An ADR arguing that certain
contents must never be published is a poor place to publish a description of them — the
description is itself an irreversible disclosure, and it would sit in the public history
forever alongside a pointer to where the originals live. The maintainer knows what is in
there; a reader does not need to, and the argument below does not depend on it.

Git history is permanent and public the moment it is pushed. Rewriting it afterwards does not
un-publish it.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Flip existing repo public | Keeps full history and attribution | Publishes credentials and unclearable third-party material, irreversibly | Low | Never here |
| B. `filter-repo` scrub, then publish | Keeps some history | One missed blob is permanent, and the material is spread across many commits | High | Clean-ish histories |
| C. **Fresh repo, port code deliberately, keep the old one private** | Nothing leaks; a clean first commit; forced review of every file carried over | History and authorship attribution are lost | Low | This situation |

## Decision
**Option C.** New public repo `forgebridge`, initial commit authored deliberately. The
predecessor stays private and is not named here. No research material is carried over. Every
ported file is read in full before it moves.

## Rationale
1. The cost of being wrong is asymmetric and irreversible. A leaked key can be rotated; a
   scraped competitor corpus in a public git history cannot be recalled.
2. Porting file-by-file is a free architecture review — it is exactly when to notice that
   a component still imports the credits module (M06).
3. Losing history costs a solo project almost nothing. Nobody is bisecting a repo whose
   first public commit is the one that matters.

## Trade-offs
Contribution history and the record of how the design evolved are lost from the public
record. Ported code arrives without its commit rationale, so ADRs and docs have to carry it
— which is part of why this directory exists.

## Consequences
- **Positive**: no secret leak, no third-party corpus, clean start, forced review.
- **Negative**: no public history; some rationale must be rewritten by hand.
- **Mitigation**: this `docs/` tree ships in the first commit so the reasoning is public
  from day one; `scripts/verify-no-secrets.ts` runs in CI on every commit, including the
  first. It scans the **working tree** for credential-shaped literals, credential-named
  assignments, machine-local absolute paths, and committed `.env` files, and fails the
  build on any of them.

  This paragraph previously said `gitleaks` ran here. Nothing ran: no action, no config,
  no step. That is the same defect as a promise defended by a test nobody wrote, and on
  the one decision with no revisit trigger it is the worst place to have it — so the
  sentence now names the check that exists, and the check is asserted to be in the
  workflow by `scripts/__tests__/docs-claims.test.ts`.

  **TODO(M42):** the working-tree scan is not a history scan. Adding `gitleaks` proper
  needs a pinned action version and a decision about where it is pinned from — a human
  has to choose and verify that, and guessing an action reference in a security control
  is worse than not having it. Until then the gap is real and stated: a secret that
  reaches a commit and is removed in the next one would be caught by this gate only
  while it is still in the tree. Owner: whoever performs the first push.

## Revisit trigger
None. This decision is one-way — once anything is pushed publicly it cannot be revisited.
