---
name: Environments screen design
description: Architecture decisions for the Environments screen (screen id 'env', nav label 'Environments', T1 tier).
---

## Rule
Environments (screen id `'env'`) is the unified ops backbone — promotion, versioning, and "what changed" in one surface. It replaces the concept of separate Workflow Promotion / Version Control / Migration features.

**Why:** To the user, DEV→TEST→PROD is one job. A unified surface avoids context-switching between three separate tools for what is fundamentally one workflow.

## Tab structure
- `'strip'` — Environment columns (DEV/TEST/PROD) showing health, version, git status, agent count, last promotion. Cross-env banner for quick promote.
- `'changed'` — "What Changed" filtered by env + time window, sourced from `this.audit`. In PROD = troubleshooting; in DEV = "what did I change"; in TEST = "what's pending."
- `'promote'` — 3-step wizard: (1) select agents + source/target env, (2) pre-flight using `computeDiff()` + `_depWarnings()`, (3) confirm with optional 3PL/DataNow target. On confirm: calls `_addAuditEntry()` and sets `envPromoteDone:true`.
- `'history'` — Promotion history from `this.audit` (filtered for promote/release actions) + static history records, plus git bar with "Open in Git" and "Shared drive backup" actions.

## State fields added
- `envTab`: `'strip'|'changed'|'promote'|'history'`
- `envPromoteStep`: `1|2|3`
- `envPromoteSelected`: array of agent IDs checked for promotion
- `envChangeWindow`: `'24h'|'7d'|'30d'`
- `envChangeEnv`: `'PROD'|'TEST'|'DEV'|'ALL'`
- `envPromoteFrom`: `'DEV'|'TEST'`
- `envPromoteTo`: `'TEST'|'PROD'|'3PL via DataNow'`
- `envPromoteRunning`: boolean (spinner during fake 1.8s delay)
- `envPromoteDone`: boolean (success screen)

## 3PL/DataNow integration
Surfaced as a target type option (`envPromoteTo = '3PL via DataNow'`) in the step-3 confirm panel. Shows DataNow org picker and bundle type selector. Not a separate screen — it's a target type in the promote flow.

## Version auto-tagging
`newVer` is computed as `parseFloat(testVer) + 0.1` formatted to 1 decimal. This is cosmetic/demo; real version tagging would come from the git integration.

## How to navigate here
- From strip cards: "Promote →" button passes `{envTab:'promote', envPromoteFrom:env, ...}`
- From Compare screen promote banner: "Promote TEST → PROD" sets same state
- From Agent Workbench: "Promote to PROD" continues to link to Workbench's own promoteBar (not this screen) for the Retender agent specifically
