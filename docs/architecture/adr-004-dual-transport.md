# ADR-004: Two transports — local daemon by default, cloud relay opt-in

## Status
Accepted

## Context
Two irreconcilable user needs. A privacy-minded developer with local models wants nothing
to touch a server. A 14-year-old on a school Chromebook cannot install a daemon. The brief
demands both, plus "keys never leave the machine".

Roblox Studio constrains the answer. Plugins can call `HttpService`, including to
`127.0.0.1` — that path is not governed by the experience's "Allow HTTP Requests" setting,
which applies to game scripts. It is, however, gated by a **per-web-address plugin permission
prompt**: the first time a plugin contacts an address, the user is asked to allow or deny it.
Studio also has no WebSocket API. So every option is HTTP polling; the question is *what it
polls*, and how many distinct addresses the user is asked to trust.

## Options considered
| Option | Pros | Cons | Complexity | When valid |
|---|---|---|---|---|
| A. Cloud only | Zero install; easiest onboarding | Relay sees everything; BYOK impossible without proxying keys; offline dead | Low | Pure SaaS |
| B. Daemon only | Maximum privacy; no server cost | Excludes Chromebooks/managed devices; no sharing or community | Medium | Dev tools |
| C. **Both, one protocol** | Covers both users; daemon is the private default | Two deployments to test; protocol must be transport-neutral | Medium-high | This product |
| D. Both, different protocols | Each optimised | Two plugin implementations — the worst possible outcome | High | Never |

## Decision
**Option C.** Identical `/v1/*` surface on `packages/daemon` and `apps/relay`. The plugin
is configured with a base URL and does not know which it is talking to. Daemon is the
documented default.

### Consequences of the per-address permission

Because the grant is scoped to an address, not to the plugin:

- **The daemon binds a stable, fixed default port** (configurable, but not ephemeral). An
  auto-selected port would re-prompt on every restart and read as a broken product.
- **The relay is a single hostname.** No per-tenant or per-region subdomains, or the user is
  asked again for each.
- **The plugin explains the prompt before it appears.** A permission dialog the user does not
  understand gets denied, and a denied grant is a support ticket that looks like a bug.

## Rationale
1. The plugin is the hardest artefact to update in the field; it must have exactly one
   implementation. That forces one protocol, which forces transport neutrality.
2. Making the daemon the *default* rather than the *advanced option* is what makes "keys
   never leave your machine" true for most users rather than technically available.
3. The relay stays small — a pipe, not a brain — so self-hosting it is realistic.

## Trade-offs
Every protocol change ships twice and is tested twice. Onboarding docs fork at step one
("install the daemon" vs "paste a code"), which is a real conversion cost.

## Consequences
- **Positive**: privacy by default; no-install path still exists; self-hosting is trivial.
- **Negative**: double the transport test matrix; two support paths.
- **Mitigation**: one shared conformance suite both transports must pass (M31); the daemon
  ships as a signed single binary so "install" is one command; the fixed-port and
  single-hostname rules above keep the permission prompt to exactly one, once.

## Revisit trigger
If daemon adoption stays under 20% of active links after launch, the install friction is
too high and the daemon should be bundled into the plugin's first-run flow.
