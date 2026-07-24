---
name: E2E test findings & fixes
description: Bugs found and fixed during end-to-end testing of all API endpoints and UI screens.
---

## Bugs fixed

### 1. `scripts/enrich.js` — wrong column names (would crash on run)
`insertAgent` used old column names (`id`, `name`, `domain`, `type`) instead of schema names (`agent_gid`, `agent_xid`, `domain_name`, `data_query_type_gid`).
`insertActions` used `agent_id`, `action_text`, `sort_order` instead of `agent_gid`, `action_gid`, `action_sequence`.

**Fix:** Updated both helpers to use correct schema column names. Also corrected the ON CONFLICT clause to use `agent_gid`.

### 2. SkyMFG data missing — all SkyMFG screens showed empty/zero state
`tenants`, `domains`, `agent_events`, and `external_systems` tables were all empty. The `autoSeedIfEmpty()` function only seeded NWL agents; there was no SkyMFG seed at all. The four SkyMFG screens (Overview, Map, List, Agent Workbench) depended on `domains WHERE tenant_id='SKYMFG'`.

**Fix:** Added `autoSeedSkymfgIfEmpty()` to `api.js` (called last in the startup chain). Seeds:
- 2 tenants: NWL + SKYMFG
- 6 SKYMFG domains (ORDER, SHIP, RAIL, INV, FIN, COMP) with theme colors
- 17 SKYMFG agents across those domains with reads/writes/actions/events
- 5 external_systems (SAP-ERP, EDI-X12, RAIL-API, CUSTOMS-ACE, WMS-CORE)

## Verified working (all 200 OK)
All 15 read endpoints, all write endpoints (PUT draft, POST annotation, PATCH conflict, POST audit-log, POST api-keys, PUT sso, PUT global-config, POST preflight, POST agent-query), and all 12 UI screens.

## Known non-issue: `/api/skymfg/xref` returns empty triggers
The xref SQL JOIN matches `RAISE INTERNAL EVENT` / `RAISE EVENT` action_params against specific OTM format strings. Seeded SkyMFG agents use plain English action text, not OTM XML param syntax. Empty result is expected for this seed; a full OTM-format dataset would populate it.

## Column name map (from memory skymfg-ui.md)
| Old | New | Table |
|-----|-----|-------|
| `id` | `agent_gid` | `agents` |
| `name` | `agent_xid` | `agents` |
| `domain` | `domain_name` | `agents` |
| `type` | `data_query_type_gid` | `agents` |
| `agent_id` | `agent_gid` | `agent_actions` |
| `action_text` | `action_gid` | `agent_actions` |
| `sort_order` | `action_sequence` | `agent_actions` |

Tables NOT renamed (still use `agent_id` FK): `agent_conditions`, `agent_reads`, `agent_writes`, `agent_annotations`.
