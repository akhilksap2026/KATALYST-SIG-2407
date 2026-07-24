---
name: Agent cross-reference (Step 8)
description: Event-based "who calls whom" cross-reference — API endpoint, shared UI method, integration in NWL workbench and agent view.
---

## Rule
`GET /api/agents/xref?gid=X` must be registered **before** `GET /api/agents/:id` in api.js, or Express matches `xref` as the `:id` param and returns "Agent not found".

**Why:** Express routes match in declaration order; `:id` greedily absorbs the literal string "xref".

**How to apply:** Any time you add a fixed-path route under `/api/agents/`, insert it above the parameterized `:id` block at line ~135.

## Data facts
- 28 SkyMFG agents both raise AND listen to events; NWL agents (AG-* prefix) have zero rows in agent_events and zero RAISE actions — xref for NWL agents always returns empty arrays.
- `RAISE INTERNAL EVENT` uses `-internalEvent {EVENT_NAME}` in action_params.
- `RAISE EVENT` / `FOR EACH` use `-customEvent DOMAIN.EVENT_GID` in action_params.

## UI pattern
- `renderXrefPanel(xref, onChipClick)` — shared method that renders ↗ Triggers + ↙ Triggered By sections, or an empty-state "no event-based cross-references" message.
- Used in `renderWorkbench` (lazy-loads into `state.wbXref/wbXrefGid`) and `renderAgentView` (into `state.viewXref/viewXrefGid`).
- SkyMFG agent detail (`renderSkymfgAgent`) has its own inline xref rendering — not refactored to avoid risk.
- Agent chips use `smOpenAgent(gid)` as the click handler — all xref targets are SkyMFG agents in practice.
