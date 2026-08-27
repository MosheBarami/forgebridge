# syntax=docker/dockerfile:1

# The relay, as a container.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#
#     docker build -f apps/relay/Dockerfile -t forgebridge-relay .
#
# The relay depends on @forgebridge/protocol, which is a workspace sibling, so a
# build rooted at apps/relay could not see it. `deploy/docker-compose.yml` sets
# the context accordingly.
#
# What is deliberately NOT in this image: any provider SDK, any model client,
# any Luau analyser. The relay's dependency list is @forgebridge/protocol and
# zod, and that is a property a reader can check rather than a promise they have
# to take — see the header of apps/relay/src/envelope.ts for why the daemon's
# implementation is copied instead of imported.

FROM node:22-alpine AS build
WORKDIR /repo

# The manifests first, so a dependency install is cached independently of source
# edits. Only the workspaces the relay actually needs are copied.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
RUN npm ci --workspace @forgebridge/protocol --workspace @forgebridge/relay --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay

RUN npm run build --workspace @forgebridge/protocol \
 && npm run build --workspace @forgebridge/relay

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Runs as the image's unprivileged user. A relay is a public listener; there is
# nothing in it that needs root, and root in a container is one escape away from
# root on the host.
COPY --from=build --chown=node:node /repo/node_modules node_modules
COPY --from=build --chown=node:node /repo/package.json package.json
COPY --from=build --chown=node:node /repo/packages/protocol packages/protocol
COPY --from=build --chown=node:node /repo/apps/relay apps/relay
USER node

# TLS is terminated by the proxy in front of this process, so the relay itself
# speaks plain HTTP on this port — and refuses every request until it is told
# how many proxies to believe (RELAY_PROXY_HOPS). See src/http.ts.
ENV RELAY_PORT=8080
EXPOSE 8080

# `/v1/health` is unauthenticated and answers before any link exists, which is
# what makes it usable as a container healthcheck. It reports the transport, the
# privacy posture and today's sponsored budget.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8080)+'/v1/health',{headers:{'x-forwarded-proto':'https'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/relay/dist/bin.js"]
