---
name: UI consolidation (redundancy pass)
description: Changes made to reduce nav clutter, merge duplicate screens, and share diff rendering code.
---

## Changes applied

**Nav items removed:** `audit` (was T1) and `import` (was T2) — both consolidated into Admin.

**Audit Log:** Standalone screen kept as a render fallback (case 'audit' redirects to Admin with adminTab:'audit' via setTimeout); nav entry removed. All `go('audit')` calls replaced with `setState({screen:'admin',adminTab:'audit'})`.

**Agent Import:** Nav entry removed. Accessed via Admin → "Agent Import" tab (`_renderAdminImport()` shows a launch card). Full-screen wizard still rendered via `case 'import'` in renderView(). Cancel button in step 1 goes to `{screen:'admin',adminTab:'import'}`.

**Export dropdown:** Workflow Map toolbar now has a single "Export ▾" button (uses `state.wfExportOpen`) instead of 4 separate buttons (Draw.io, Visio, Export docs, Doc Pack). Uses onMouseDown + onBlur+setTimeout(160) to keep the menu open on item click.

**Agent Query shortcut:** "⌕ Agent Query" button added to the second row of the Workflow Map toolbar (between conflict toggle and zoom controls). Navigates to `screen:'query'`.

**Workbench promote:** "Promote to PROD →" button now navigates to `{screen:'env', navPrev:'workbench', envTab:'promote', envPromoteFrom:'DEV', envPromoteTo:'PROD', envPromoteStep:1, envPromoteSelected:[ag.id]}` instead of doing a silent toast. Preflight text updated accordingly.

**Shared diff renderer:** Three new methods on the class:
- `_diffColHdr(label, ver, color)` — renders the two-column header strip
- `_diffCellEl(cell)` — renders one diff cell (symbol + text)
- `_diffGroupEls(groups, depW)` — renders all step groups with optional dep-warning rows

Both `renderAgents()` (env/version diff) and `renderTimeline()` (snapshot diff) now call these instead of inlining identical logic. renderTimeline passes `null` for depW (no dep warnings in timeline view).

**Why:**
- Nav was 13 items; now 11. Audit and Import were infrequently used and logically belong under Admin.
- 4 export buttons wrapped on narrow viewports and consumed ~200px of toolbar space.
- Workbench promote bypassed the Environments preflight wizard — a safety gap.
- ~60 lines of duplicated diff rendering existed across renderAgents and renderTimeline.
