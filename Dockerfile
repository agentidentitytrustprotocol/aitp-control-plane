# syntax=docker/dockerfile:1.7
# Multi-stage build for AITP Control Plane.
# Assumes `../aitp-rs/bindings/aitp-node` is on the build context.

FROM node:20-slim AS deps
WORKDIR /workspace/aitp-cp
COPY aitp-cp/package.json aitp-cp/package-lock.json* ./
COPY aitp-rs/bindings/aitp-node /workspace/aitp-rs/bindings/aitp-node
RUN npm ci --omit=dev=false

FROM node:20-slim AS builder
WORKDIR /workspace/aitp-cp
COPY --from=deps /workspace/aitp-rs/bindings/aitp-node /workspace/aitp-rs/bindings/aitp-node
COPY --from=deps /workspace/aitp-cp/node_modules ./node_modules
COPY aitp-cp/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000

RUN groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /workspace/aitp-cp/.next/standalone ./
COPY --from=builder --chown=app:app /workspace/aitp-cp/.next/static ./.next/static
COPY --from=builder --chown=app:app /workspace/aitp-rs/bindings/aitp-node /workspace/aitp-rs/bindings/aitp-node
USER app

EXPOSE 4000
CMD ["node", "aitp-cp/server.js"]
