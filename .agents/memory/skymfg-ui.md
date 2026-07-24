---
name: SkyMFG UI screens
description: Step 3 UI mapping — four SkyMFG screens wired to real DB data, plus all post-migration API fixes
---

## What was built (Step 3)

Four new screens in `Katalyst.dc.html` + four new API routes in `api.js`:

| Screen | nav id | render method |
|---|---|---|
| SkyMFG Overview | `skymfg` | `renderSkymfgDashboard()` |
| Agent Map | `skymfg-map` | `renderSkymfgMap()` |
| Agent List | `skymfg-list` | `renderSkymfgList()` |
| Agent Workbench | `skymfg-agent` | `renderSkymfgAgent()` |

API routes (all new, inserted before `// ─── AUTO-SEED` block):
- `GET /api/skymfg/summary` — KPI cards + domain_dist + dqt_breakdown
- `GET /api/skymfg/domains` — 6 SkyMFG domains with theme_color
- `GET /api/skymfg/agents?domain=` — all 150 agents (filtered by domain if param provided)
- `GET /api/skymfg/agent?gid=` — single agent + events + actions (GID in query param, not path, because GIDs contain `/`)

## State added
```
skymfgDomain, skymfgAgentGid, skymfgAgentDetail, skymfgAgentLoading,
skymfgListSearch, skymfgListDomains, skymfgListDQTs, skymfgListActiveOnly,
skymfgListSort, skymfgListSortDir, skymfgMetaOpen
```
Class properties: `skymfgSummary=null; skymfgDomains=[]; skymfgAgents=[];`

## Key design decisions

- **Domain filter bar** (`renderSkymfgDomainBar()`) is shared across all four screens; sets `skymfgDomain` state; all screens call `this.smFilteredAgents()` for client-side domain filtering.
- **Agent workbench** (`smOpenAgent(gid)`) sets screen + fetches agent on demand; workbench does NOT respond to domain filter (single-agent view).
- **Action flow nesting**: ENDIF/ELSE/ELSEIF decrement indent before rendering; IF/FOR EACH/ELSE/ELSEIF increment after. This means the ELSE line shows at the parent's indent level.
- **Params display**: only specific keys shown (KEY_SHOW list); sqlStatement gets `<code>` truncated to 130 chars.

## Post-migration API fixes (critical)

The schema migration renamed columns in two tables. Every API endpoint touching these tables needed updating:

| Old column | New column | Table |
|---|---|---|
| `id` | `agent_gid` | `agents` |
| `name` | `agent_xid` | `agents` |
| `domain` | `domain_name` | `agents` |
| `type` | `data_query_type_gid` | `agents` |
| `agent_id` | `agent_gid` | `agent_actions` |
| `action_text` | `action_gid` | `agent_actions` |
| `sort_order` | `action_sequence` | `agent_actions` |

Tables NOT renamed (still use old names): `agent_conditions`, `agent_reads`, `agent_writes`, `agent_annotations` (all use `agent_id` FK to `agents.agent_gid`).

Endpoints fixed: `/api/agents` GET, `/api/agents/:id` PUT, `/api/data` GET, `/api/v2/agent-query`, `/api/annotations` GET (JOIN used `a.id`), `refreshAgentActionStyle()`, auto-seed INSERT.

**Why:** The migration (applied before Step 3) renamed columns but the old endpoint code was not updated at the same time. All existing Katalyst screens broke until these were fixed.

## agent_actions query pattern

Always filter by action_flow when querying for Katalyst demo agent actions (to exclude SkyMFG data from legacy screens):
```sql
WHERE action_flow IS NULL OR action_flow='NORMAL' ORDER BY agent_gid, action_sequence
```
SkyMFG actions always have `action_flow='NORMAL'` or `action_flow='ERROR'`. Legacy Katalyst demo actions have `action_flow='NORMAL'` after the refresh script runs.

## Step 8 — Agent Cross-Reference (xref)

**API**: `GET /api/skymfg/xref?gid=<agent_gid>` — returns `{triggers, triggered_by}`.
Uses direct SQL JOIN (no JS parsing) to match raise actions against event listeners:
- `RAISE INTERNAL EVENT` → matches `agent_events.event_gid` via `-internalEvent {EVENT_GID}` pattern
- `RAISE EVENT` / `FOR EACH` → matches via `-customEvent DOMAIN.EVENT_GID` pattern

**Why SQL JOIN not JS parse**: The JOIN approach was validated directly against the DB and produces correct deduplicated results without a second round-trip. JS parsing added fragility for no benefit.

**State**: `skymfgAgentXref` loaded in parallel with `skymfgAgentDetail` inside `smOpenAgent()` via `Promise.all`.

**Preflight counts (all SkyMFG-scoped)**:
- 150 agents, 6 domains, 1,636 actions, 171 events
- Most complex agent: SKYMFG/RAIL.TRE-RAIL-PROCESS-ALL-ELIGIBLE-EVENTS — 152 normal actions
