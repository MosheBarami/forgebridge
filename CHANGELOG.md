# Changelog

Every user-visible change, newest first. Entries are accumulated one file at a
time under [`.changes/`](.changes/) and folded into a section here when a
version is cut — see that directory's README for the format and for why it is
not called `.changeset/`.

Nothing in this file has been published. `packages/sdk-python` is unreleased
(M30), no npm package has been pushed, and `.github/workflows/release.yml` has
never run with `publish` set: no credential for either registry exists in this
repository, and its preflight refuses a release it cannot finish.

## 0.1.0 — unreleased

The first version, and the one the whole tree currently declares. It is listed
here so that `npm run release:check -- --version 0.1.0` has a section to find
and so the release job can be rehearsed end to end against a real one.

- The frozen protocol (`packages/protocol`), the pipeline and ports
  (`packages/core`), the local transport (`packages/daemon`) and the Studio
  plugin (`plugin/`).
- Five connectors — MCP, A2A, the CLI and both SDKs — held to one conformance
  matrix in `packages/conformance`.
- The cloud transport (`apps/relay`), with the M45 abuse protection and the
  privacy posture it is required to state.
- Roblox Open Cloud (`packages/opencloud`): place publishing, standard data
  stores and MessagingService.
- Self-hosting: `docker-compose.yml`, `deploy/daemon.Dockerfile` and
  `docs/SELF-HOSTING.md`.

Each row of [`docs/MILESTONES.md`](docs/MILESTONES.md) says what its area still
owes; this file does not repeat that and will not, because two places to look
for the same fact is how one of them goes stale.
