# Katalyst Health Dashboard

## Overview
Full-stack OTM automation dashboard for Northwind Logistics. Displays agent health, conflicts, workflow maps, promotion flows, and an NL query engine over agent data.

## Stack
- **Backend**: Node.js / Express (`api.js`, port 5000), Replit PostgreSQL
- **Frontend**: Single-page app (`Katalyst.dc.html`) using a lightweight component runtime (`support.js`)
- **Services**: `services/promotionPreflight.js`, `services/agentQueryEngine.js`
- **Tests**: `tests/promotionPreflight.test.js`

The workflow **"Start application"** runs `node api.js`. The app is served at the root URL and redirects to `/Katalyst.dc.html`.

## Setup & data management

### Starting from scratch (fresh environment)
No manual steps are required. On startup, `api.js` automatically:
1. Runs `schema.sql` via idempotent `CREATE TABLE IF NOT EXISTS` statements — safe to run on every boot.
2. Detects an empty database and seeds all reference data (agents, conflicts, jobs, audit log, etc.).

Just start the **"Start application"** workflow and the app is ready.

### Re-seeding data
`seed.js` is the full-data seeder used for local development. It is safe by default — it will **not** overwrite existing data:

```
node seed.js           # no-op if data already exists; prints a message and exits
node seed.js --force   # truncates all tables and re-seeds from scratch
```

> ⚠️  `--force` is destructive. All user edits, audit log entries, and draft changes will be lost. Only use it to reset a development environment to a known state.

## User preferences
- Rename: the product is called **Katalyst** (with a K), not Catalyst.
