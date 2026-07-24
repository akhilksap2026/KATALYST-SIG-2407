---
name: Event Ordering screen (1.8)
description: What changed when "Conflicts" was renamed and the three resolution features were added.
---

## Rename
- Nav label: `label:'Conflicts'` → `label:'Event Ordering'`
- Titles map key: `conflicts:'Conflicts'` → `conflicts:'Event Ordering'`
- Screen header: "Conflicts" → "Event Ordering Violations"

## Conflict data shape (extended in 1.8)
Each conflict object now carries:
- `seq[]` — ordered agent firing list: `{agent, priority, pnum, role, field, isReader?, collision?, isProvider?}`
- `raceWindow`, `raceRate`, `raceResult` — narrative race statistics
- `priorityFix[]` — `{label, text, isFix?}` rows for the Priority Resequencing Analysis panel
- `gate{}` — `{waiter, provider, type, field, timeout, fallback}` for the Event Gate modal

## New state keys (line ~87)
- `conflictPriorityOpen: {}` — which conflict ids have the priority panel open
- `conflictGateModal: null` — conflict id currently showing the gate modal
- `gateApplyState: {}` — per-id step: 'idle' | 'applying' | 'done'

## New methods (inserted before `conflictActions`)
- `_renderSeqDiagram(c, col)` — monospace tree diagram: event fired → agents with priority/pnum, role badges (write collision / reads stale), race window + result
- `_renderPriorityFix(c)` — navy-tinted panel; Current / Problem / Fix rows; isFix row gets teal highlight
- `_renderGateModal()` — fixed overlay modal; reads from `this.state.conflictGateModal`; rows table; 1.4s simulated apply; logs audit entry

## Modified: `conflictActions(c)`
Two buttons added before `applyFixBtn`:
- `⚡ Suggest priority fix` — toggles `conflictPriorityOpen[c.id]`; only if `c.priorityFix` exists
- `⛩ Configure gate` — sets `conflictGateModal` to `c.id`; only if `c.gate` exists

## Modified: `renderConflicts()` expanded detail block
Order: description → `_renderSeqDiagram` → `_renderPriorityFix` (if open) → suggested fix box → `conflictActions`

## Return wrapping
`renderConflicts()` now returns `React.Fragment` containing `_renderGateModal()` + the main content div, so the fixed-position modal renders correctly.

## Paren-depth lesson
All three new methods verified balanced with Python paren counter after writing. The gate modal is the most complex (50/50). Run the counter before declaring syntax-clean on any deeply nested React.createElement tree.
