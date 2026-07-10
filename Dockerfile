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

ARG NODE_VERSION=22-alpine
ARG BUN_VERSION=1.3.9

FROM node:${NODE_VERSION} AS base
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*
WORKDIR /usr/src/app

FROM oven/bun:${BUN_VERSION}-alpine AS bun

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

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs -s /sbin/nologin

COPY --chown=nodejs:nodejs package.json ./
COPY --from=deps --chown=nodejs:nodejs /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /usr/src/app/dist ./dist

USER nodejs

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('node:http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
