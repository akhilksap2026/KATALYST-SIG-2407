---
name: Timeline / Time-Travel feature
description: Snapshot-based time-travel diff for the Agent View Compare screen — architecture, data shape, and implementation notes.
---

## Overview
The Timeline axis ("Time Travel") lets users scrub through historical snapshots of any agent and see a step-aligned diff from any past version to the current PROD config.

## Backend
- Table: `agent_snapshots` (agentId, version, by, note, config JSONB, snapshot_at)
- Seeded via `autoSeedSnapshotsIfEmpty()` — 18 rows across 6 agents (3 snapshots each)
- Endpoint: `GET /api/agents/:id/snapshots` — returns rows ASC by snapshot_at, each with `{ id, agentId, at, version, by, note, config }`
- `config` shape: `{ evt, priority, success_rate, health, conditions[], actions[], reads[], writes[] }`

## Frontend state
Added to the state block:
- `tlSnapshots` — `{ agentId, snapshots: [...] }` or `null`
- `tlLoadingId` — agentId currently being fetched, or `null`
- `tlIdx` — integer index into `snapshots[]`, defaults to `snaps.length - 2` (second-to-last, so diff vs NOW is visible)

## Methods
- `_loadTimeline(agentId)` — async; fetches endpoint; sets tlSnapshots and tlIdx
- `buildSnapshotRows(a, b)` — builds raw diff rows from two snapshot config objects; header fields as label+value pairs, array sections (conditions/actions/reads/writes) matched by exact text
- `computeSnapshotDiff(rawRows)` — annotates rows with `same/mod/add/del/none` and returns `{ rows, summary: { add, del, mod } }`
- `_fmtSnapDate(isoStr)` — formats UTC ISO date as "Jan 14 2026"
- `renderTimeline(selAg, topRow)` — full render: scrubber rail, info bar, summary banner, step-aligned diff columns

## Axis wiring
- `'Timeline'` button is the 4th axis button in `renderAgents()`; onClick resets state and calls `_loadTimeline(selId)`
- At the top of the axis dispatch block: `if(axis==='timeline') return this.renderTimeline(selAg, topRow);`

## Key bug fixed during implementation
- `scrubberEl` is an `h('div', ...)` that wraps mode-badge, labels-row, visual-rail, and info-bar divs
- Info-bar contains action-buttons div → `this.btn()` calls
- Closing sequence after the last `this.toast()` is: `}` (fn body) + `}` (props obj) + `)` (this.btn) + `)` (action-buttons h div) + `)` (info-bar h div) + `)` (scrubberEl h div) = `}}))))` not `}})))`
- The missing `)` produced "missing ) after argument list" in the dc-runtime's `new Function` eval

**Why:** The scrubberEl outer `h('div', ...)` is a long multi-child call; it's easy to lose count of depth when the last child itself contains nested `h()` + `this.btn()` calls.

**How to apply:** When closing deeply nested `h()` chains, count: one `)` per open `h(` or `this.btn(` or `this.pill(` etc. that hasn't yet been closed. Use the Node ESM check (`node --input-type=module`) to verify before restarting.
