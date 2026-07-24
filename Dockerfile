# ─────────────────────────────────────────────────────────────────────────────
# Katalyst — OTM Agent Intelligence Platform
# Multi-stage build: deps → production image
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: install production dependencies ─────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first so Docker cache is reused when only source changes
COPY package.json package-lock.json ./

# Install only production deps; omit devDependencies
RUN npm ci --omit=dev --ignore-scripts


# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production

# Install 'wait-for-it' dependencies (nc/netcat for the entrypoint health check)
RUN apk add --no-cache bash netcat-openbsd

WORKDIR /app

# Non-root user for security
RUN addgroup -S katalyst && adduser -S katalyst -G katalyst

# Pull in pruned node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Application source
COPY api.js        ./
COPY support.js    ./
COPY seed.js       ./
COPY schema.sql    ./
COPY Katalyst.dc.html ./

# Supporting directories
COPY services/     ./services/
COPY scripts/      ./scripts/
COPY attached_assets/ ./attached_assets/

# Copy and permission the entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Drop to non-root
RUN chown -R katalyst:katalyst /app
USER katalyst

# ── Runtime configuration ─────────────────────────────────────────────────────
# DATABASE_URL   — required: postgres connection string
#                  e.g. postgresql://user:pass@host:5432/katalyst
# PORT           — optional: defaults to 5000
# NODE_ENV       — optional: defaults to production
ENV NODE_ENV=production \
    PORT=5000

EXPOSE 5000

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD nc -z localhost 5000 || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "api.js"]
