# Community

The [contribution ladder](../CONTRIBUTING.md#the-contribution-ladder) says what
the rungs are. This page is the practical layer under it: how to find work that
is actually ready for you, what each label means, and what happens to an issue
after you open one.

## Finding something to work on

Start at the [roadmap](ROADMAP.md). It is generated from
[`MILESTONES.md`](MILESTONES.md), which is the source of truth and which says,
for every row, exactly what that area still owes — usually with the file and the
`TODO(Mxx)` marker in it. Several of those are the whole of a good first patch.

Then the labels.

| Label | What it means here |
|---|---|
| **`good first issue`** | Small, self-contained, and finishable without reading the whole tree. Someone has confirmed the change is wanted and named the file. |
| **`help wanted`** | Wanted, specified, and nobody is working on it. Bigger than a first issue. |
| **`needs-triage`** | Applied automatically by the issue templates. It has not been read yet; nothing about it is agreed. |
| **`needs-rfc`** | The change is plausible and touches something [`CONTRIBUTING.md`](../CONTRIBUTING.md#rfcs--what-needs-one-and-what-does-not) requires an RFC for. Write the RFC first; a PR will be closed in favour of it. |
| **`bug`**, **`enhancement`**, **`provider`** | Applied by the three issue templates. |
| **`blocked`** | Waiting on another milestone. The comment says which. |

A `good first issue` here has to earn the label, and the bar is a maintainer's
work rather than yours: **the issue names the file, states what "done" looks
like, and does not require a decision you have no way to make.** An issue that
says "improve error handling in the daemon" is not one, however small the diff
turns out to be — deciding what the error should say *is* the work, and handing
that to a first-time contributor is handing them an argument.

> Labels are applied by hand, except the three the issue templates set. Nothing
> in `.github/` syncs a label list, and there is no automation that promotes an
> issue from `needs-triage`. Said plainly because a documented label that no
> process maintains is exactly the kind of claim the rest of this repository
> spends its gates catching.

## What happens to your issue

Blank issues are disabled — [`.github/ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml)
— so a report arrives with the context a maintainer would otherwise have to ask
for one round trip at a time. There are three templates: bug, feature, and
provider request.

Everything opens as `needs-triage`. Triage decides one of four things: it is a
bug and gets a milestone, it is wanted and gets `help wanted` or `good first
issue`, it needs an RFC, or it is out of scope and is closed **with the reason
written down**. A closed issue with no reason is a decision nobody can appeal,
and [`docs/GOVERNANCE.md`](GOVERNANCE.md) is explicit that the veto is public
and written every time it is used.

## What happens to your pull request

CI runs five gates and the test suites. Most of them are not style checks — they
are written policy turned into merge blockers, and their names say what they
protect: boundaries, brand assets, key custody, publication secrets, and the
gate self-tests. [`CONTRIBUTING.md`](../CONTRIBUTING.md#getting-set-up) lists the
commands so you can run each one before pushing.

Two things about them are worth knowing before your first PR.

**Every gate has self-tests that plant a violation and prove rejection.** If you
add a rule, it needs one. A gate that cannot fail is decoration, and this
repository has been through five rounds of adversarial review largely on that
point.

**A gate must also not fire on correct work.** Every rule here ships beside the
legitimate shape it is most confusable with, as an explicit control test. A rule
that fires on ordinary work trains people to ignore it, which is the same
outcome as no rule reached more expensively.

You will also need `Signed-off-by:` on every commit — `git commit -s`. That is
the DCO, checked by `.github/workflows/dco.yml`. There is no CLA and there will
not be one.

## Where the examples are

[`examples/`](../examples/) has one runnable walk-through per connector:
`typescript`, `python`, `cli`, `mcp`, `a2a` and `opencloud`. Each has a README
saying what to start first and what it deliberately does not do — most of them
stop at a diff, because ADR-012 puts a person between a proposal and an apply
and an example with a `--yes` flag would teach the opposite of what the system
does.

If you add a connector, it needs an example. That is not a convention:
`scripts/__tests__/deployment.test.ts` fails when a connector in
`CONNECTOR_EXAMPLES` exists without one, or has one with no README.

## Self-hosting and running your own instance

[`SELF-HOSTING.md`](SELF-HOSTING.md). You do not need anyone's permission and you
do not need to tell anyone. The five promises in
[`GOVERNANCE.md`](GOVERNANCE.md) include the core staying neutral, and a fork
that renames the official instance out of it is a supported outcome rather than
a tolerated one — `npm run verify:boundaries` enforces rule B3 so that the code a
fork adopts never names the instance it is forking away from.
