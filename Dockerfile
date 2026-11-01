# syntax=docker/dockerfile:1

# ---- dependencies (production only)
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime
# Bun runs TypeScript directly (reading tsconfig.json for decorator metadata),
# so there is no separate build step.
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1

# exec form: bun is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["bun", "src/main.ts"]
