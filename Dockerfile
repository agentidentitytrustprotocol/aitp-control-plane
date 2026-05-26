# syntax=docker/dockerfile:1.7
# Multi-stage build for AITP Control Plane.
# Assumes `../aitp-rs/bindings/aitp-node` is on the build context.

FROM node:20-slim AS deps
WORKDIR /workspace/aitp-control-plane
COPY aitp-control-plane/package.json aitp-control-plane/package-lock.json* ./
COPY aitp-rs/bindings/aitp-node /workspace/aitp-rs/bindings/aitp-node
RUN npm ci --omit=dev=false

FROM node:20-slim AS builder
WORKDIR /workspace/aitp-control-plane
COPY --from=deps /workspace/aitp-rs/bindings/aitp-node /workspace/aitp-rs/bindings/aitp-node
COPY --from=deps /workspace/aitp-control-plane/node_modules ./node_modules
COPY aitp-control-plane/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000

RUN groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /workspace/aitp-control-plane/.next/standalone ./
COPY --from=builder --chown=app:app /workspace/aitp-control-plane/.next/static ./.next/static
COPY --from=builder --chown=app:app /workspace/aitp-rs/bindings/aitp-node /workspace/aitp-rs/bindings/aitp-node
USER app

EXPOSE 4000
CMD ["node", "aitp-control-plane/server.js"]
