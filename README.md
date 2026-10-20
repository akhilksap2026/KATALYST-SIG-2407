# Katalyst Health Dashboard

Full-stack OTM automation dashboard: agent health, conflicts, workflow maps, promotion flows and a natural-language query engine over agent data. See `replit.md` for detailed notes.

## Stack
Node.js / Express API (`api.js`, port 5000) · PostgreSQL (`schema.sql`) · single-page frontend `Katalyst.dc.html` with `support.js` runtime · services in `services/` · Python helpers (`server.py`, `seed.py`) · Docker.

## Setup & run
```bash
npm install
export DATABASE_URL=postgresql://user:pass@localhost:5432/katalyst
node api.js            # creates schema + seeds an empty DB on first start; open http://localhost:5000
node seed.js           # optional re-seed (no-op if data exists; --force truncates!)
```

Docker: `docker compose up --build` (optionally set `POSTGRES_PASSWORD`).

## Tests
```bash
node tests/promotionPreflight.test.js
node tests/agentQueryEngine.test.js
```
