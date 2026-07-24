---
name: SkyMFG map wiring (Step 9)
description: Full wiring of SkyMFG agents into the Agent Dependency Graph and related subsystems
---

## What was implemented

### Backend
- `/api/agents` now returns SkyMFG-specific columns for all 162 agents:
  `is_active`, `complexity_score`, `otm_release`, `norm_action_count`,
  `err_action_count`, `event_count`, `reentrancy_level`, `run_as_type`, `functional_categories`
- `GET /api/agents/event-edges` — bulk OTM event connections via RAISE EVENT/RAISE INTERNAL EVENT joins.
  Returns 53 rows. **Must stay before `GET /api/agents/:id`** (see agent-xref.md).

### Frontend (_loadData)
- Fetches `/api/agents/event-edges` in the Promise.all, stores as `this.eventEdges`.
- Destructuring now has 15 entries (added `evtEdgesRes` at the end).

### domainColor()
- Extended to map `SKYMFG/RAIL` → #C07B0A, `SKYMFG/LW` → #1e56e0, `SKYMFG/TRAIN` → #1A8C5C,
  `SKYMFG/DEMO` → #9B59B6, `SKYMFG` (base) → #E67E22.

### _ensureAutoLayout()
- Now also builds `this._autoLayoutHeaders = [{domain, x, y, blockW, count}]` for each domain group.
  Headers are placed 32px above each domain block. `blockW = COLS*CU - 24`.

### _focusLayout() BFS
- `allEdges` now includes `(this.eventEdges||[]).map(e=>({from:e.from_id,to:e.to_id}))`.
  SkyMFG agents are reachable from NWL agents via event edges.

### renderGraph()
- Defs: added `arr-orange` (#E67E22) arrowhead marker.
- `domLabels`: colored domain header badges rendered above each SkyMFG domain group.
- `smEventEls`: dashed orange arrows for OTM event edges (bow=-28).
- `smEventLabels`: orange label pills showing the event GID suffix.
- Z-order: domLabels → swimlanes → flow → aiflow → smEvent → fieldOnly → conflicts → nodes.
- Status bar: shows "53 OTM evt edges" count in orange.
- Legend: added "OTM event" entry with dashed orange line.

### renderHoverBubble()
- SkyMFG agents detected by `a.domain?.startsWith('SKYMFG')`.
- Shows: domain path, complexity/action count/event count stats, active status, first 4 actions,
  and outbound/inbound event edges.
- Positioned using `this._autoLayoutPos?.[a.id]` instead of raw `a.gx/a.gy`.

### _renderSkyMFGMapPanel() (new method)
- Shown when a SkyMFG node is clicked on the map (replaces NWL detail panel).
- Stats strip: Complexity / NORMAL actions / ERROR actions / Events.
- Lists up to 8 actions with sequence numbers.
- Lists outbound (↗) and inbound (↙) event connections with peer-focus buttons.
- "Open Full Detail →" button calls `smOpenAgent(a.id)`.

### _renderAgentDetailPanel()
- Early return for SkyMFG agents: `if(a.domain?.startsWith('SKYMFG')) return this._renderSkyMFGMapPanel(a)`.
- Blast-radius BFS now includes `this.eventEdges` (so SkyMFG agents appear in impact analysis).

## What is still NOT done (from original audit)
1. **Data Dictionary (screen:'query')** — still NWL-only; SkyMFG properties not yet surfaced.
2. **Visio export** — still uses raw `a.gx/a.gy`; SkyMFG agents would export at (0,0).

**Why:** These were deprioritized in favor of the map interaction features above.
