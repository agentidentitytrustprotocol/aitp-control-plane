# syntax=docker/dockerfile:1.7
# Multi-stage build for AITP Control Plane.
#
# Self-contained: the `aitp` SDK is the published
# `@agentidentitytrustprotocol/aitp` package (npm alias in package.json),
# so the build context is just this repo — no sibling aitp-rs checkout.
# `npm ci` pulls the prebuilt native binary for the image's platform.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Opt the build into Next.js standalone output. Gated by env so local
# `next start` workflows aren't affected (see next.config.ts).
ENV NEXT_OUTPUT=standalone
# Throwaway placeholders giving `next build` (which evaluates route modules
# under NODE_ENV=production) concrete values for anything read at module scope.
#
# They are NOT satisfying a boot-time config validation, as this comment used to
# claim — there isn't one: src/lib/config.ts only `console.warn`s, and
# EnrollmentService is constructed lazily on first use. Measured: `next build`
# with NEXT_OUTPUT=standalone, NODE_ENV=production and ALL of these unset exits 0
# and builds every route, so none of them is load-bearing for the build.
# (CP_AID_SEED_HEX's production throw lives inside initCpIdentity(), reached from
# a handler, not at module scope.) They are kept as belt-and-braces so the build
# never depends on that staying true.
#
# These are NOT real secrets and are overridden by the runtime
# environment — never baked into the final runner image.
ENV NODE_ENV=production \
    CP_AID_SEED_HEX=0000000000000000000000000000000000000000000000000000000000000001 \
    ENROLLMENT_SECRET=docker-build-placeholder-min-thirty-two-chars \
    API_KEYS=docker-build-placeholder-key \
    CORS_ORIGIN=http://localhost:3000 \
    DATABASE_URL=postgres://postgres:postgres@localhost:5432/aitp_control_plane
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000
# The Next.js standalone server binds to process.env.HOSTNAME. In a
# container Docker sets HOSTNAME to the container ID, which makes the
# server listen on http://<container-id>:PORT instead of all interfaces —
# so an external proxy (Railway, etc.) can't reach it and returns 502.
# Pin it to 0.0.0.0 so it listens on every interface.
ENV HOSTNAME=0.0.0.0

RUN groupadd -r app && useradd -r -g app app
# The standalone server bundles its own minimal node_modules (including
# the traced `aitp` loader + native binary).
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
USER app

EXPOSE 4000
CMD ["node", "server.js"]
