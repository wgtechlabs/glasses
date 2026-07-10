# syntax=docker/dockerfile:1
# =============================================================================
# GLASSES GATEWAY - DOCKERFILE
# =============================================================================
# Multi-stage Docker build for the Glasses gateway.
#
# Build stages:
# 1. base         - Minimal Node.js + dumb-init runtime base (no Bun)
# 2. builder-base - base + Bun (used only for dependency install & build)
# 3. deps         - Install production dependencies only
# 4. build        - Install dev dependencies and build the application
# 5. final        - Create minimal runtime image with built app (no Bun)
# =============================================================================

ARG NODE_VERSION=22-bookworm-slim
ARG BUN_VERSION=1.3.9

FROM node:${NODE_VERSION} AS base
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init ca-certificates gh && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app

FROM oven/bun:${BUN_VERSION} AS bun

# Bun is installed here for dependency management and building only — the
# final runtime launches the gateway with Node.js and does NOT include Bun.
FROM base AS builder-base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version

FROM builder-base AS deps
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=bun.lock,target=bun.lock \
    --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile --ignore-scripts

FROM builder-base AS build
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=bun.lock,target=bun.lock \
    --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

# The runtime only needs Node.js; npm and npx pull unused package trees into
# the image, including packages that have had advisories.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /usr/sbin/nologin --create-home nodejs

COPY --chown=nodejs:nodejs package.json ./
COPY --from=deps --chown=nodejs:nodejs /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /usr/src/app/dist ./dist

USER nodejs

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('node:http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
