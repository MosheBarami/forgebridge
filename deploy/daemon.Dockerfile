# syntax=docker/dockerfile:1

# The lite image: the daemon, alone.
#
#     docker build -f deploy/daemon.Dockerfile -t forgebridge-daemon .
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, like the relay's, and for the same
# reason: the daemon depends on four workspace siblings.
#
# ── Read this before you run it ──────────────────────────────────────────────
#
# **This image is useful on Linux with `--network host`, and is not useful on
# Docker Desktop for macOS or Windows.** That is a property of the daemon, not
# of this file, and it is stated here because the failure it produces otherwise
# is a connection refused with no explanation.
#
# The daemon binds loopback and only loopback — `LOOPBACK_HOST` in
# `packages/daemon/src/server.ts`, with no flag to widen it — and it *also*
# refuses any request whose `Host` header is not loopback. Both are deliberate:
# a daemon holding a provider key and a writable-path allowlist is not something
# you want reachable from the network by accident.
#
# Inside a container, "loopback" is the container's own loopback. Publishing a
# port with `-p 8080:8080` forwards to the container's `0.0.0.0:8080`, where
# nothing is listening, so the daemon is unreachable and the port mapping looks
# correct. With `--network host` on Linux the container shares the host's
# network namespace, the daemon binds the host's own 127.0.0.1, and Studio on
# that same machine reaches it exactly as it would a daemon started with npm.
# On macOS and Windows, Docker Desktop runs containers inside a VM, so host
# networking gives you the VM's loopback and Studio is outside it.
#
#     # Linux
#     docker run --rm --network host \
#       -e OPENROUTER_API_KEY \
#       forgebridge-daemon --allow-path ServerScriptService.Shop
#
#     # macOS / Windows: run the daemon directly instead.
#     npm run build && npx forgebridge-daemon --allow-path ServerScriptService.Shop
#
# ── What this image does not have ────────────────────────────────────────────
#
# No volume, because there is nothing to persist: the daemon constructs
# `InMemoryDaemonStore` and `packages/storage-sqlite` — which implements the
# same `DaemonStore` port and passes the same parity suite — is not wired into
# `packages/daemon/src/bin.ts` by anything. That is stated in
# `packages/storage-sqlite/README.md` from the other side. Mounting a volume
# here would produce an empty directory and the impression of durability.

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first, so a dependency install is cached independently of source
# edits. Only the workspaces the daemon actually needs are copied.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/luau-analysis/package.json packages/luau-analysis/
COPY packages/model-registry/package.json packages/model-registry/
COPY packages/daemon/package.json packages/daemon/
RUN npm ci \
      --workspace @forgebridge/protocol \
      --workspace @forgebridge/core \
      --workspace @forgebridge/luau-analysis \
      --workspace @forgebridge/model-registry \
      --workspace @forgebridge/daemon \
      --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY packages/luau-analysis packages/luau-analysis
COPY packages/model-registry packages/model-registry
COPY packages/daemon packages/daemon

RUN npm run build --workspace @forgebridge/protocol \
 && npm run build --workspace @forgebridge/core \
 && npm run build --workspace @forgebridge/luau-analysis \
 && npm run build --workspace @forgebridge/model-registry \
 && npm run build --workspace @forgebridge/daemon

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build --chown=node:node /repo/node_modules node_modules
COPY --from=build --chown=node:node /repo/package.json package.json
COPY --from=build --chown=node:node /repo/packages/protocol packages/protocol
COPY --from=build --chown=node:node /repo/packages/core packages/core
COPY --from=build --chown=node:node /repo/packages/luau-analysis packages/luau-analysis
COPY --from=build --chown=node:node /repo/packages/model-registry packages/model-registry
COPY --from=build --chown=node:node /repo/packages/daemon packages/daemon
USER node

# No EXPOSE, and no HEALTHCHECK. Both would be theatre on a process that binds
# the container's loopback: an exposed port nothing can reach, and a healthcheck
# that passes from inside while the daemon is unreachable from outside.
#
# The daemon prints its pairing code and producer token to stderr, once. Run it
# without `-d` the first time, or read them back with `docker logs`.
ENTRYPOINT ["node", "packages/daemon/dist/bin.js"]
