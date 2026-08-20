# syntax=docker/dockerfile:1
#
# The admin console. Adapted from the template's own Dockerfile, which had
# already worked out the awkward part -- see the bun/node note below.
#
# LIVES HERE, BUILDS FROM THE REPO ROOT, like apps/api/Dockerfile: paths
# below are relative to the root, because @ecom/schema is a workspace
# sibling and bun install has to see bun.lock and packages/ to resolve it.
#
#   docker build -f apps/admin/Dockerfile --target dev .
#   docker build -f apps/admin/Dockerfile .

# ---------------------------------------------------------------------
# NODE base, bun borrowed only for install. Kept from the template, and
# the reason is worth not rediscovering: the bun image ships a `node`
# shim rather than Node, and it SEGFAULTS loading Next's precompiled
# Turbopack runtime. bun is the installer and script runner in this repo,
# never the runtime for Next -- which is also what admin-plan's decision
# table says.
FROM node:22-alpine AS deps

WORKDIR /repo
COPY --from=oven/bun:1.3.11-alpine /usr/local/bin/bun /usr/local/bin/bun

# Manifests before source, so a route edit does not reinstall. Every
# workspace manifest is needed: bun resolves the whole graph or none of it.
COPY package.json bun.lock ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY packages/client/package.json packages/client/
COPY packages/schema/package.json packages/schema/
# --linker=hoisted, and this is the line that makes `output: standalone`
# work at all. Bun's default `isolated` linker installs into a .bun store
# and symlinks into node_modules; Next's standalone file tracing resolves
# THROUGH those links but copies only what it traced, so the bundle ships
# a require() of @swc/helpers at a .bun path that was never copied. The
# image builds, and dies on first request with a module not found deep
# inside next/dist. `hoisted` lays out node_modules the npm way, which is
# what the tracer expects.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --linker=hoisted


# ---------------------------------------------------------------------
# Development: `next dev`, with the working tree bind-mounted over /repo
# by compose. No COPY of source -- the mount would only hide it.
FROM deps AS dev

ENV NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /repo/apps/admin
EXPOSE 3000
# Through node directly, never `bun run`, for the segfault above.
#
# NOTE ON THIS PATH. Where `next` lives depends on the linker chosen
# above: `isolated` (bun's default) keeps a workspace's deps under that
# workspace, `hoisted` puts them at the root npm-style. This image uses
# hoisted, so the root it is. Change the linker and this path moves --
# and the failure is a MODULE_NOT_FOUND with an empty requireStack, which
# names nothing useful.
CMD ["node", "../../node_modules/next/dist/bin/next", "dev"]


# ---------------------------------------------------------------------
FROM deps AS build

ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
WORKDIR /repo/apps/admin
RUN --mount=type=cache,target=/repo/apps/admin/.next/cache \
    node ../../node_modules/next/dist/bin/next build


# ---------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1

# `output: "standalone"` in a WORKSPACE nests by package path: the server
# lands at apps/admin/server.js with node_modules hoisted to the root of
# the bundle. Copying .next/standalone/* flat would put server.js
# somewhere it cannot find its own chunks.
COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/admin/.next/static ./apps/admin/.next/static

USER node
EXPOSE 3000

# No app config baked in: APP_URL and API_URL are read at runtime, so one
# image digest is promotable across qa, uat and prod unchanged.
CMD ["node", "apps/admin/server.js"]
