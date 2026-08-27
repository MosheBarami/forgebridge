bump: minor

`packages/opencloud` is new: publish a place version, read and write standard
data store entries, and publish MessagingService messages, from Node or from the
`forgebridge-opencloud` binary. No runtime dependencies, and the API key is held
in a closure rather than on a field.

`docker-compose.yml` brings up the self-hosting stack — the relay, TLS in front
of it, and an OpenTelemetry collector — and `deploy/daemon.Dockerfile` builds the
lite image. `docs/SELF-HOSTING.md` is the whole of it, including what the stack
deliberately does not contain.

`.github/workflows/release.yml` exists and is manual-only. It has never
published anything and cannot: no credential for either registry is configured,
and its preflight refuses to start a release it cannot finish.
