---
name: Agent Query Engine
description: Vocabulary-aware NL→QueryPlan translation service; maps natural language to typed filter predicates against real agent data.
---

## Architecture

`services/agentQueryEngine.js` — pure functions, no DB calls inside.
- `buildVocab(agents, reads, writes, actions)` — call at request time; returns live vocab sets.
- `translate(question, vocab)` → `{ filters[], explanation, confidence }`
- `execute(filters, { agents, agentReads, agentWrites, agentActions })` → `{ matches[] }`

API endpoint: `POST /api/v2/agent-query` — fetches all four tables, builds vocab, calls translate+execute, returns full QueryPlan.

UI screen: `id:'query'` nav item → `renderQuery()` / `_runAgentQuery()` in Catalyst.dc.html.

## Key Implementation Details

**Filter types** (all ANDed): `writes_field`, `reads_field`, `touches_field`, `evt`, `domain`, `agent_type`, `health`, `owner`, `action_contains`, `success`, `version_contains`, `name_contains`.

**matchScore** uses: exact normalized match → substring → token intersection with `tokenSimilarity()` which handles stemming variants via common-prefix ≥5 chars (e.g. "invoic-e" vs "invoic-ing" shares 6-char prefix → score 0.72).

**Why prefix fallback matters:** "Invoice & Finance" domain won't match "invoicing" via startsWith (differs at char 6: 'e' vs 'i'). Common-prefix check of ≥5 chars bridges this gap.

**OWNER_RE** must be `owned?\s+by` not `own[s]?` — the latter fails on "owned" because "own[s]?" matches "own" then `\s+` expects whitespace but "ed" follows.

**Name splitting for matchScore** must use `/[_\s\-&\/()]+/` (includes `&`) so "Invoice & Finance" splits into ["invoice","finance"] not ["invoice","&","finance"].

## Segment splitting

`splitSegments` splits on `\s+and\s+(?=write|read|fire|...)` — only splits at "and" that precedes a recognized intent keyword, so "Invoice and Finance" doesn't get wrongly split.

## Query screen state

Added to DCLogic state: `queryInput, queryLoading, queryResult, queryHistory`.
`_runAgentQuery(q)` keeps last 8 queries in `queryHistory`.
