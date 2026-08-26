# Security policy

ForgeBridge runs code on other people's machines. The daemon holds API keys and is the egress
for every model call; the Studio plugin executes inside a Roblox Studio session, with that
user's account, against months of their work. We take reports about those two seriously and
we would rather hear about a problem early and awkwardly than late and publicly.

> **TODO(M03) — the maintainer must fill this in before the repository goes public.**
> Replace `<SECURITY-CONTACT>` below with a real, monitored address. It must be different from
> the public issue tracker and it must be one somebody actually reads. Also enable **private
> vulnerability reporting** on the repository (Settings → Code security → Private vulnerability
> reporting) so reporters have a channel that does not depend on email at all. And confirm the
> response times in "What happens next" are ones a solo maintainer can genuinely hold — a
> missed security SLA damages trust more than a modest one.
> This file deliberately contains no invented address.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use either:

1. **GitHub private vulnerability reporting** — on this repository, *Security → Report a
   vulnerability*. This is preferred: it is private, it threads, and it produces a CVE-ready
   advisory at the end.
2. **Email `<SECURITY-CONTACT>`.**

Useful things to include, none of them required: what you did, what happened, what you expected,
the affected component and version or commit, and whether you think it is remotely reachable. A
short report you send today beats a polished one you send next month.

If you want to encrypt the report and the contact address has no published key, say so in a
first message with no details and we will arrange a channel.

## What happens next

| When | What |
|---|---|
| Within 3 business days | We acknowledge the report and say who is handling it. |
| Within 10 business days | We confirm or dispute the finding and give you our severity assessment. |
| Ongoing | We keep you updated at least every 10 business days until it closes. |
| At the fix | We publish an advisory, credit you by whatever name you choose, or stay silent about you if you prefer. |

We follow **coordinated disclosure**. We ask you to give us 90 days from acknowledgement before
publishing, and we will usually be much faster than that. If a fix is going to take longer, we
will tell you why rather than going quiet. If a vulnerability is being actively exploited, that
clock is void — tell us and we will publish an advisory and a mitigation immediately, fixed or
not.

We will not threaten you, and we will not ask you to sign anything, for a report made in good
faith under this policy.

## There is no bug bounty

There is no money in this project — no credits, no store, no paid tier, by design — so there is
no bounty budget and it would be dishonest to imply one. What we offer instead: a fast reply, a
public advisory with credit exactly as you want it, and a listing in the release notes. Saying
this plainly beats letting you find out after you have spent a weekend on it.

## Scope

**In scope, and the two we care about most:**

- **`plugin/`** — the Roblox Studio plugin. It runs with the user's Studio session. Anything
  that lets a ChangeSet apply without approval, escape its path policy, bypass the
  `baseVersion` check, defeat the journal so a rollback cannot restore prior state, or take an
  action the user did not approve.
- **`packages/daemon`** — the localhost transport and BYOK egress. Anything that reads a key
  out of it, gets a key into a log or a crash report, lets another local process or a web page
  drive it, or turns it into an open proxy.

Also in scope:

- `packages/protocol` — validation that can be bypassed, a schema that accepts something the
  consumer will mis-apply.
- `packages/core` — policy or validation bypass, prompt-injection paths that widen a
  ChangeSet's write scope, unsafe handling of secrets at a port.
- Continuous-integration integrity — a way to get unreviewed code into what
  `.github/workflows/` executes, or into the `assets/brands/` provenance manifest.

**In scope the moment each of these exists.** None of them do today: the directories below are
either empty or absent from the tree entirely, so there is nothing yet to report against them.
They are listed so the boundary is not quietly redrawn when they land.

- `packages/mcp` (M26), `packages/cli` (M28), and the other connectors — anything that lets a
  producer approve its own ChangeSet, or reach a project it was not linked to.
- `apps/relay` (M17) — pairing weaknesses, replay, cross-link injection, authentication
  bypass, reading or altering another link's traffic.
- `apps/web` (M32–M39) — the usual web classes: authn/authz, XSS, CSRF, SSRF, RLS bypass,
  secret exposure.
- Release integrity (M49) — a way to get unreviewed bytes into a published artefact or into
  the plugin `.rbxm`. There is no release pipeline here yet, nothing is published to npm or
  PyPI, and no `.rbxm` is built by anything in this repository.

**Out of scope:**

- Reports from automated scanners with no demonstrated impact.
- Missing hardening headers or a TLS configuration grade with no exploitable consequence.
- Denial of service by simply sending a lot of traffic.
- Social engineering of maintainers or users, and physical attacks.
- Vulnerabilities in third-party services we merely connect to. Report those to that vendor;
  tell us too if our integration makes it worse.
- Anything in the list below, which is not a gap we failed to notice but a boundary we chose.

## What we do not defend against

Stated so nobody is surprised, and repeated verbatim from
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md):

- **A compromised user machine.** If malware owns the OS, it owns the keychain and the daemon.
- **A malicious model provider returning subtly wrong Luau.** Static analysis catches classes of
  error, not intent. Review your diffs.
- **Roblox platform-side moderation decisions about generated content.** That is the user's
  responsibility and the ToS is theirs to keep.

Two more that follow from decisions already written down:

- **The relay operator, in relay v1.** Pairing is authenticated and payloads are
  integrity-protected, and the transport is TLS — but the relay *can* read ChangeSet contents,
  and the UI says so in those words. End-to-end encryption arrives in v2 (M19). If this matters
  to you, use the local daemon, where no relay exists at all
  ([ADR-014](docs/architecture/adr-014-staged-pairing-crypto.md)).
- **A model you chose to trust.** The pipeline treats every model as an untrusted caller —
  schema, static analysis, policy, then human approval — but "the model wrote something clever
  and wrong that passed review" is a code review problem, not a vulnerability.

## What we do defend against, and how

The full analysis is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), and that document is the
authority. What follows is a summary, and a summary is where an over-claim hides most easily,
so it is split in two.

**In force today.** No shape that reaches storage declares a credential-shaped field, so there
is no column a key could land in — `npm run verify:no-key-storage` fails the build otherwise.
Every ChangeSet is schema-checked against the protocol's Zod schemas and policy-checked against
the project's stored path allowlist before a human sees it, and is applied only after approval;
a producer cannot approve its own work. Every apply captures the inverse of each operation
before it runs, so rollback is a real operation rather than a git suggestion. A ChangeSet's
write scope is fixed before generation, from the request and the project policy, so no retrieved
text can widen it — that is the layer prompt-injection defence actually rests on. Pairing
resists brute force, replay, and cross-link injection.

**Not in force, named here so the paragraph above cannot be read as covering it.** Static
analysis of generated Luau does not exist (M10): `packages/core` and `packages/daemon` return an
explicit "not analysed" verdict rather than `ok`, and the plugin sends every ChangeSet carrying
Luau source to a human regardless of the verdict that arrived with it. Rollback is scoped to the
Studio session that applied the change, because `ApplyResult` has nowhere on the wire to carry
the inverses (M11). Delimiting retrieved content as data inside the prompt is unbuilt (M22).

Claims in that document are meant to be backed by tests rather than by prose (M43). **A claim
there that no test defends is itself worth reporting** — quietly, through this policy.

## Supply chain

The plugin is code running inside Studio with someone's account, so its distribution is treated
as security-relevant. What follows separates what runs today from what is planned, because a
supply-chain list is exactly the kind of paragraph a reader takes as a set of guarantees.

**In force today.** A committed `package-lock.json` with `npm ci` in every job, so a build
resolves to pinned versions rather than to whatever the registry served that morning. A
working-tree secret scan — `npm run verify:no-secrets` — runs in CI on every push and every
pull request. Dependency additions to `packages/protocol` (zero-dependency by rule) and to
`plugin/` require maintainer review.

**Not in force — planned, and named here rather than implied.** Static analysis and SBOM
publishing land with M42, as does a scan of git *history* rather than the working tree; the
history scan is blocked on a human choosing and pinning a tool version. Provenance-attested
publishes, and a checksum for the plugin `.rbxm` in every release note, land with M49. There is
no release pipeline in this repository at present, so there is no release note to carry one.

If you find a way to get unreviewed bytes into what CI executes — or into a release artefact,
once one exists — that is a top-severity report and we want it immediately.
