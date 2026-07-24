---
name: Compare screen design
description: Architecture decisions for the Compare screen (screen id 'agents', nav label 'Compare') that replaced Agents & Diff.
---

## Rule
The Compare screen (screen id `'agents'`, nav label `'Compare'`) is the single entry point for all agent diff/comparison work. All `screen:'agents'` navigation calls in the codebase still work — only the label changed.

**Why:** Renaming the id would require updating every `chooseAgent(..., {screen:'agents'})` call across the codebase (renderAgentView, renderDecisionTree, Conflicts, Audit Log, etc.). Keeping the id preserves all wiring.

## How to apply
- To add a new "Compare →" entry point from any screen, use: `this.chooseAgent(agentId, {screen:'agents', cmpAxis:'env'})`
- To open domain view directly: `this.setState({screen:'agents', cmpAxis:'domain'})`

## State fields
- `cmpAxis`: `'env' | 'version' | 'domain'` — which comparison axis is active
- `diffEnvLeft` / `diffEnvRight`: the two environments selected (reused from the old screen)
- All `agentDiffs` class data and `computeDiff()` helper unchanged

## Key helpers added
- `_parseStepGroups(rows)` — groups diff rows by semantic category (TRIGGER, META, CONDITIONS, READS, ACTIONS, WRITES) using prefix matching; returns `[{cat, rows:[{row, i}]}]`
- `_depWarnings(rows, envLeft, envRight)` — returns a Map of rowIndex → warning string for rows that reference fields known to exist only in TEST/DEV (e.g. TENDER_HINT, DWELL_FORECAST, CLAIM_RATE, EXCEPTION_LOG, SLA_CLOCK_START)

## Orphan handling
Domain view renders a ⊘ "not present in ENV" placeholder for any agent whose `agentDiffs[id].testVer` is falsy/`'—'`. Never errors.
