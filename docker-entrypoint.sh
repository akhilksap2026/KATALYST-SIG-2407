#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Katalyst — Docker entrypoint
#
# Responsibilities:
#   1. Validate required environment variables
#   2. Wait for the PostgreSQL host to accept connections
#   3. Exec the application process (replaces this shell — proper PID 1)
#
# Usage (set automatically by Dockerfile):
#   ENTRYPOINT ["docker-entrypoint.sh"]
#   CMD ["node", "api.js"]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colour helpers (only when attached to a TTY) ──────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; RESET="\033[0m"; GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"
else
  BOLD=""; RESET=""; GREEN=""; RED=""; YELLOW=""
fi

log()  { echo -e "${BOLD}[entrypoint]${RESET} $*"; }
ok()   { echo -e "${GREEN}[entrypoint] ✓${RESET} $*"; }
warn() { echo -e "${YELLOW}[entrypoint] ⚠${RESET} $*"; }
err()  { echo -e "${RED}[entrypoint] ✗${RESET} $*" >&2; }

# ── 1. Validate required environment variables ────────────────────────────────
log "Validating environment…"

if [ -z "${DATABASE_URL:-}" ]; then
  err "DATABASE_URL is not set."
  err "Set it to a valid PostgreSQL connection string, e.g.:"
  err "  postgresql://user:password@host:5432/katalyst"
  exit 1
fi
ok "DATABASE_URL is set."

# ── 2. Parse host and port from DATABASE_URL ──────────────────────────────────
# Handles both:
#   postgresql://user:pass@hostname:5432/dbname
#   postgresql://user:pass@hostname/dbname  (defaults port 5432)
strip_proto="${DATABASE_URL#*://}"       # user:pass@hostname:5432/dbname
strip_creds="${strip_proto#*@}"          # hostname:5432/dbname
PG_HOST="${strip_creds%%[:\/]*}"         # hostname
PG_PORT_RAW="${strip_creds#*:}"
PG_PORT_RAW="${PG_PORT_RAW%%\/*}"
# If no port separator was found PG_PORT_RAW equals PG_HOST — default to 5432
if [ "$PG_PORT_RAW" = "$PG_HOST" ] || [ -z "$PG_PORT_RAW" ]; then
  PG_PORT=5432
else
  PG_PORT="$PG_PORT_RAW"
fi

# ── 3. Wait for PostgreSQL to accept TCP connections ──────────────────────────
MAX_WAIT="${PGWAIT_SECONDS:-60}"
WAITED=0
INTERVAL=2

log "Waiting for PostgreSQL at ${PG_HOST}:${PG_PORT} (timeout ${MAX_WAIT}s)…"

until nc -z "$PG_HOST" "$PG_PORT" 2>/dev/null; do
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    err "PostgreSQL at ${PG_HOST}:${PG_PORT} did not become reachable within ${MAX_WAIT}s."
    err "Check that your database is running and DATABASE_URL is correct."
    exit 1
  fi
  sleep "$INTERVAL"
  WAITED=$(( WAITED + INTERVAL ))
  warn "  still waiting… ${WAITED}s elapsed"
done

ok "PostgreSQL is reachable at ${PG_HOST}:${PG_PORT}."

# ── 4. Optional startup delay (gives DB time to finish init if needed) ─────────
if [ -n "${PGWAIT_EXTRA:-}" ]; then
  log "Sleeping extra ${PGWAIT_EXTRA}s (PGWAIT_EXTRA)…"
  sleep "$PGWAIT_EXTRA"
fi

# ── 5. Exec the application ───────────────────────────────────────────────────
# NOTE: Schema migration and data seeding are handled inside api.js on first
# boot via runSchemaMigration() + autoSeed*() — no manual step needed here.
log "Starting Katalyst on port ${PORT:-5000}…"
exec "$@"
