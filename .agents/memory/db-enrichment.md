---
name: Database enrichment
description: OTM agent catalog size, enrichment script location, and rules for keeping overview_metrics in sync.
---

## Rule
`scripts/enrich.js` is the additive enrichment runner — it inserts new agents and back-fills sparse tables without truncating. Safe to re-run due to ON CONFLICT DO NOTHING guards.

## Current catalog (as of 2026-07-22)
- **44 agents** across 6 domains: Order Release (10), Shipment Execution (10), Invoice & Finance (7), Oracle AI (7), Compliance & Customs (5), Capacity & Yard (5)
- **134 regression tests** — every agent has at least 2; failing tests reflect known open issues (C-011 guard, lane-opt confidence threshold)
- **106 snapshots** — every agent has ≥1 historical snapshot; new agents get 2
- **44 trace runs** with trace steps — full coverage
- **57 workflow edges**, **11 conflicts** (5 critical / 6 warning), **10 agent_diffs**, **20 jobs**

## overview_metrics sync
`overview_metrics` is NOT auto-updated on agent INSERT/DELETE. Must call `refreshMetrics()` in enrich.js or run:
```sql
UPDATE overview_metrics SET value=(SELECT COUNT(*) FROM agents)::text WHERE key='agents_total';
```
(and equivalent for healthy/amber/red counts)

**Why:** The table is a denormalised cache read by the Overview dashboard KPI tiles. Stale values show wrong agent counts on the dashboard.

## Agent ID naming convention
`AG-{DOMAIN_ABBR}-{FUNCTION}` — e.g. `AG-ORD-ORDERVAL`, `AG-AI-CARRCHURN`. New agents in the Rate Management space were placed under `AG-RATE-*` (still shows in domain = 'Order Release' in DB — keep consistent with existing pattern if adding more).

## Grid positions (gx/gy)
- Order Release: gx=50, gy multiples of 148 starting at 64
- Shipment Execution: gx=330
- Invoice & Finance: gx=610
- Capacity & Yard: gx=890
- Oracle AI: gx=1170
- Compliance & Customs: gx=1450
- Pre-release / entry agents: gx=-230
- Extend a column by adding gy = last_in_column + 148
