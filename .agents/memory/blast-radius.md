---
name: Blast radius / Impact Analysis
description: How the blast radius feature is implemented — engine, UI, and wire-up points.
---

## What it does
Click any ⬡ chip (field, event, or agent) anywhere in the app and a 360px right-side drawer slides in showing every agent that would be affected by changing that object, grouped into Direct (hop 1) and Cascades (hop 2+), with domain and process counts.

## Engine: `_computeBlast(kind, value)`
Builds four in-memory inverted indexes from `this.agents`, `this.flowEdges`, `this.aiEdges`:
- `fieldReaders[field]` → Set of agent IDs that read it
- `fieldWriters[field]` → Set of agent IDs that write it
- `evtListeners[evt]` → Set of agent IDs triggered by this event
- `downstream[agentId]` → [agentIds directly downstream via flow/AI edges]

Seeds a BFS from those indexes based on `kind` (field / event / agent / domain), then walks transitively following both `downstream[]` edges and field-write→read chains. Returns `{direct, indirect, domains, processesAtRisk, critCount, total}`.

## UI: `renderBlastPanel()`
- `position:fixed, right:0, top:0, bottom:0, width:360px` — slide-in drawer, no backdrop
- Header: kind badge (color-coded) + object name + ×
- Stats row: bigNum tiles for Agents / Domains / Processes
- Scrollable body: Direct section, Cascades section, Processes at risk section
- Footer: "Export report" (Markdown download) + "View on map" (→ Workflow Map screen)
- Animation: `@keyframes slidein` (slides from right)

## State
`blastTarget: null | {kind:'field'|'event'|'agent'|'domain', value:string, label:string}`

## ⬡ chip placements
- `_renderStepList` trigger row → event blast (purple ⬡, position:absolute right)
- `_renderStepList` reads rows → field blast (teal ⬡, position:absolute right)
- `_renderStepList` writes rows → field blast (gold ⬡, position:absolute right)
- Quick View modal footer → "⬡ Blast radius" button (opens agent blast, closes modal)
- Agent View header → "⬡ Blast radius" button
- Workflow Map selected-node panel → "⬡ Blast radius" link

## Export: `_exportBlastReport(result, kind, value, label)`
Generates Markdown with summary table + Direct / Cascades / Processes tables. Downloads as `blast-radius-<value>.md`.

## Syntax gotcha
When editing `_renderStepList` reads/writes: the original code had `if(!compact){ if(reads){} if(writes){} } else if(...)`. Adding a `}}` at the end of the writes line (instead of `}`) prematurely closed the `if(!compact)` block and orphaned the `else if`. Always use one `}` to close inner ifs; outer block closed on its own line.
