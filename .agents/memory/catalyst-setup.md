---
name: Catalyst project setup
description: Architecture and DB details for the Catalyst Oracle TMS dashboard
---

## Stack
- Frontend: `Catalyst.dc.html` — single-file React app via dc-runtime (class extends DCLogic)
- API: `api.js` — Express on port 5000, serves static files + REST endpoints
- DB: Replit PostgreSQL, 15 tables total

## How data flows
- On `componentDidMount`, `_loadData()` fires 9 parallel fetches (one per resource)
- Endpoints: `/api/agents`, `/api/workflow-edges`, `/api/conflicts`, `/api/audit-log`, `/api/jobs`, `/api/live-events`, `/api/agent-diffs` (returns [] — hardcoded class property still used), `/api/trace`, `/api/tests/:agentId`
- All in one try/catch — if ANY endpoint is missing, ALL data falls back to hardcoded class properties silently
- Legacy `GET /api/data` kept for backwards compatibility

## Mutation endpoints
- `PUT /api/agents/:id` — update agent version/health/conditions/actions
- `GET/PUT/DELETE /api/agents/:id/draft` — workbench draft persistence (agent_drafts table)
- `PATCH /api/conflicts/:id` — update conflict status (body: {status, acknowledged_by})
- `PUT /api/conflicts/:id/acknowledge` — legacy, sets acknowledged=true
- `POST /api/audit-log` — appends audit entry (body: {username, action, target, env, result, tone, note})
- `POST /api/audit` — alias for above
- `PUT /api/jobs/:id` — update job health/last_run/duration/trend
- `PUT /api/metrics/:key` — upsert overview KPI

## DB tables (15 total)
agents, agent_conditions, agent_actions, agent_reads, agent_writes,
workflow_edges, conflicts, audit_log, jobs, trace_runs (keyed by agent_id),
trace_steps, live_events, overview_metrics, agent_drafts, regression_tests

## agent_drafts table
- PRIMARY KEY: agent_id (one draft per agent)
- Columns: agent_id, draft_text, saved_at, saved_by
- Upsert on save; DELETE on reset
- Frontend: chooseAgent() fetches saved draft; _saveDraft() persists + audits; _resetDraft() deletes

## regression_tests table
- PRIMARY KEY: (agent_id, id)
- Columns: id, agent_id, name, expect_text, result, got_text, sort_order
- Seeded with 6 tests for AG-SHIP-RETENDER (TC-01..TC-06, TC-04 fails)

## Workbench save flow
1. User edits textarea → draftText state updated, draftSaved=false, textarea border turns normal
2. "Save draft" button → _saveDraft(agentId, text) → PUT /api/agents/:id/draft → audit log entry
3. On success: draftSaved=true, draftSavedAt set, textarea border turns teal, "✓ saved HH:MM" shown
4. "Reset draft" → _resetDraft() → DELETE /api/agents/:id/draft → clears state
5. Agent switch (chooseAgent) → auto-loads saved draft via GET /api/agents/:id/draft

**Why:** App was originally a pure static single-file HTML app with all data hardcoded.
DB was added to persist state across refreshes and enable real CRUD.

**How to apply:** Any new module added to the app needs a corresponding table + API endpoint + seed data.
New GET endpoints must be added to _loadData()'s Promise.all array; a missing endpoint breaks ALL data loading.
