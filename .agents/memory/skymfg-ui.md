---
name: SkyMFG UI screens
description: SkyMFG tenant screens, API routes, seed pipeline, and column-rename fixes.
---

## Screens (all working)
- SkyMFG Overview (`?screen=skymfg`) — KPI cards, domain distribution bar chart, data-query-type breakdown
- Agent Map (`?screen=skymfg-map`) — Domain → Data Query Type → Agent card hierarchy
- Agent List (`?screen=skymfg-list`) — sortable/filterable table of all 150 agents
- Integrations (`?screen=skymfg-integrations`) — external systems with wired-agent chips

## API routes (all in api.js)
- `GET /api/skymfg/summary` — totals + domain_dist + data_query_type breakdown
- `GET /api/skymfg/domains` — 6 domains with theme colors
- `GET /api/skymfg/agents?domain=` — 150 agents, filterable by domain_name
- `GET /api/skymfg/agent?gid=` — single agent with actions + events
- `GET /api/skymfg/xref?gid=` — agents triggered by / triggering the given agent (uses RAISE INTERNAL EVENT pattern match on action_params)
- `GET /api/skymfg/integrations` — external_systems with wired agent count

## Canonical seed source
**File**: `attached_assets/catalyst_skymfg_seed_1784878938654.json`
**Contents**: 150 agents · 6 domains · 1 636 actions · 171 events · 18 data query types · 7 external systems · 33 users · 12 contacts · 152 saved_conditions · 97 event_catalog · 98 action_catalog

**One-time import script**: `node scripts/import_skymfg.js`
- Wipes all SkyMFG domains + agents (cascading), then reloads from JSON
- Handles both old fake domains (SKYMFG/ORDER etc.) and real domains (PUBLIC, SKYMFG, SKYMFG/DEMO, SKYMFG/LW, SKYMFG/RAIL, SKYMFG/TRAINING)
- Uses chunked multi-row INSERT for speed (500/100/200 row chunks)

**Startup seed function**: `autoSeedSkymfgIfEmpty()` in api.js
- Guard: `SELECT COUNT(*) FROM domains WHERE tenant_id='SKYMFG'`
- On empty: reads SKYMFG_SEED_PATH (same JSON file) and inserts all tables row-by-row
- Called last in the `.then()` chain in `app.listen`

## Column name map (agents → DB schema)
| Seed field | DB column |
|---|---|
| `agent_gid` | `agent_gid` (PK) |
| `agent_xid` | `agent_xid` |
| `domain_name` | `domain_name` |
| `data_query_type_gid` | `data_query_type_gid` |
| `functional_categories` (array) | `functional_categories` (TEXT, JSON.stringify'd) |
| domains have no `tenant_id` | supply `'SKYMFG'` on insert |

## Tables populated by seed
`tenants`, `domains`, `data_query_types`, `external_systems`, `otm_users`, `notification_contacts`, `saved_conditions`, `event_catalog`, `action_catalog`, `agents`, `agent_actions`, `agent_events`

## Known: xref returns 0 for agents without OTM-format action_params
The xref SQL JOIN matches `RAISE INTERNAL EVENT` / `RAISE EVENT` action_gid + specific `-internalEvent {…}` param syntax. Only agents with real OTM XML-style params get xref results. With the full 1 636-action dataset (which does include these), most agents in SKYMFG/TRAINING and SKYMFG/RAIL domain do return triggers.
