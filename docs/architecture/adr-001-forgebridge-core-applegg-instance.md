# ADR-001: Split the identity — ForgeBridge (core) and apple.gg (instance)

## Status
Accepted

## Context
The brief asks for a *universal* bridge, and simultaneously for an official service.
Those two goals fight each other: nobody adopts a "universal" standard branded as one
company's product, and nothing gets built if the neutral core has no flagship user.

Constraints: solo/small team, long-term product, must be self-hostable, must be adoptable
by competing tools (Cursor, Copilot, Cline …) who will not ship an `apple.gg` dependency.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. One product, one name (`apple.gg`) | Simplest; one brand to market | Competitors will not depend on it; "universal" is not credible | Low | Single-vendor tools |
| B. Two repos, two orgs | Maximum neutrality | Double the CI, docs, releases; solo team drowns | High | Foundation-scale projects |
| C. **One monorepo, two names** — neutral `packages/*` + `apps/web` | Neutral core is importable and forkable; one CI; flagship proves the core | Requires enforced boundaries or the core rots into an app helper | Medium | Exactly this shape |

## Decision
**Option C.** One public monorepo named `forgebridge`. Everything under `packages/` is
neutral and may not contain the string `apple.gg`. `apps/web` is the official instance.

## Rationale
1. The adoption risk is bigger than the branding risk. An MCP server called
   `@forgebridge/mcp` gets installed by a Cursor user; `@applegg/mcp` does not.
2. A solo maintainer cannot run two release trains. One repo, one CI, one version line.
3. It makes the promise checkable: `grep -r "apple.gg" packages/` returning nothing is a
   CI assertion, not a marketing claim.

## Trade-offs
Two names to explain, and a boundary that has to be policed or it dissolves. The apple.gg
brand gets less surface area than it would as the only name.

## Consequences
- **Positive**: forkable core; competitors can adopt it; self-hosting is natural.
- **Negative**: naming confusion in docs and search; more explaining.
- **Mitigation**: one sentence at the top of every README — *"ForgeBridge is the engine,
  apple.gg is the official instance"* — plus the lint rule.

## Revisit trigger
If after 12 months no third party has adopted a `packages/*` artefact, the neutrality tax
is not buying anything and the split should collapse back to one name.
