# syntax=docker/dockerfile:1.7
# Multi-stage build for AITP Control Plane.
#
# Self-contained: the `aitp` SDK is the published
# `@agentidentitytrustprotocol/aitp` package (npm alias in package.json),
# so the build context is just this repo — no sibling aitp-rs checkout.
# `npm ci` pulls the prebuilt native binary for the image's platform.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Opt the build into Next.js standalone output. Gated by env so local
# `next start` workflows aren't affected (see next.config.ts).
ENV NEXT_OUTPUT=standalone
# Throwaway placeholders so `next build` (which evaluates route modules
# under NODE_ENV=production) passes its boot-time config validation.
# These are NOT real secrets and are overridden by the runtime
# environment — never baked into the final runner image.
ENV NODE_ENV=production \
    CP_AID_SEED_HEX=0000000000000000000000000000000000000000000000000000000000000001 \
    ENROLLMENT_SECRET=docker-build-placeholder-min-thirty-two-chars \
    API_KEYS=docker-build-placeholder-key \
    CORS_ORIGIN=http://localhost:3000 \
    DATABASE_URL=postgres://postgres:postgres@localhost:5432/aitp_control_plane
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000

RUN groupadd -r app && useradd -r -g app app
# The standalone server bundles its own minimal node_modules (including
# the traced `aitp` loader + native binary).
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
USER app

EXPOSE 4000
CMD ["node", "server.js"]
