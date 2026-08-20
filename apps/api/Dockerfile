# syntax=docker/dockerfile:1
#
# The API, built from the monorepo root because @ecom/schema is a
# workspace sibling and bun install has to see both.
#
# LIVES HERE, BUILDS FROM THERE. The file sits beside the app it builds,
# but its build context is the repo root -- every path below is relative
# to the root, not to this directory:
#
#   docker build -f apps/api/Dockerfile .          production image
#   docker build -f apps/api/Dockerfile --target dev .
#
# The root docker-compose.yml does this for you. .dockerignore stays at
# the root because that is what the context is.
#
# No `turbo prune`. api-plan.md flags prune-on-Bun as an unverified risk,
# and the whole reason to reach for it -- shipping a smaller install --
# does not apply here: `bun build` emits one self-contained file, so the
# runtime stage copies that and nothing else. No node_modules ships at
# all, pruned or otherwise.

# Pinned to the version in package.json's packageManager field. A build
# that silently follows a newer Bun is a build that can start failing
# without anything in this repo changing.
FROM oven/bun:1.3.11-slim AS build

WORKDIR /repo

# Manifests before source: this layer is rebuilt only when a dependency
# changes, so editing a route does not re-run the install.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/client/package.json packages/client/
COPY packages/schema/package.json packages/schema/
RUN bun install --frozen-lockfile

COPY . .

WORKDIR /repo/apps/api
RUN bun run build


# ---------------------------------------------------------------------
# Development: hot reload, running the SOURCE.
#
# No `COPY . .`. Compose bind-mounts the repo over /repo, so an edit on
# the host is an edit in the container and `bun --hot` reloads it. Copying
# source in would only be shadowed by that mount.
#
# Dependencies ARE baked in, which is why compose also mounts an anonymous
# volume at /repo/node_modules: without it the bind mount hides the
# install done here, and the container starts with whatever the host
# happens to have -- or nothing at all on a fresh clone.
FROM oven/bun:1.3.11-slim AS dev

WORKDIR /repo

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/client/package.json packages/client/
COPY packages/schema/package.json packages/schema/
RUN bun install --frozen-lockfile

ENV PORT=3001
EXPOSE 3001

# `bun`, not `bun run` -- same reason as the CMD at the bottom of this
# file: with a wrapper as PID 1 the SIGTERM never reaches the server and
# the drain never runs.
CMD ["bun", "--hot", "apps/api/src/server.ts"]


# ---------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS runtime

# NODE_ENV=production is load-bearing, not decoration. In development
# logger.ts sends pino through a pino-pretty worker thread, and a worker
# cannot resolve its target out of a single bundled file -- the process
# dies at boot with `DataCloneError: The object can not be cloned`, which
# names nothing useful. Production logging is plain JSON with no worker,
# which is also what a log shipper wants.
ENV NODE_ENV=production \
    PORT=3001

WORKDIR /app

# One file. Verified to run with no node_modules present.
COPY --from=build /repo/apps/api/dist/server.js ./server.js

# The base image ships this unprivileged user.
USER bun

EXPOSE 3001

# Liveness, deliberately -- NOT /health/ready.
#
# Docker Swarm, which Dokploy uses, restarts a task whose HEALTHCHECK
# fails. Pointed at readiness, a thirty-second database blip would
# restart every container in the service instead of taking them out of
# rotation until it passed. Readiness belongs in the load balancer's own
# check, configured where the proxy is configured.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `bun`, not `bun run`. With `bun run` the wrapper is PID 1 and the SIGTERM
# from `docker stop` never reaches the server -- measured: the container
# died in 1.1s with exit code 137, SIGKILLed, drain sequence never entered.
# Exec form (no shell) for the same reason: a shell PID 1 would swallow it too.
# Whatever runs this MUST allow the drain to finish. Measured here:
# `docker stop` on the platform default SIGKILLed it at 1.1s, exit 137,
# mid-drain -- while an explicit `-t 10` let it finish in 5.2s, exit 0.
# So set it explicitly wherever this is deployed:
#   compose  stop_grace_period: 45s
#   swarm    --stop-grace-period 45s
#   k8s      terminationGracePeriodSeconds: 45
# 45 covers the 5s readiness grace plus REQUEST_TIMEOUT_MS worth of
# in-flight work, which is what server.ts waits for.
CMD ["bun", "server.js"]
