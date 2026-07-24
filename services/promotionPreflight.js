'use strict';

/**
 * promotionPreflightService — pure function, no DB calls.
 * Input: { objects[], source, target, agents[], reads[], writes[], diffs[], conflicts[] }
 * Output: { verdict:'blocked'|'caution'|'safe', counts:{blocking,warning,info,total}, findings[] }
 * Each finding: { severity:'blocking'|'warning'|'info', object, message, suggested_fix }
 *
 * The three checks run per-object:
 *   (a) Diff check     — uses agent_diffs rows: conflict_id → blocking, warning text → warning,
 *                        all-same rows → info (cosmetic), insight-only → info (functional)
 *   (b) Dependency     — checks reads[] against target-available writes; refnums that need
 *                        env-specific OTM configuration are caught by PROD_RESTRICTED_REFS
 *   (c) Event conflict — detects same-event trigger collisions that would be created in target
 */

// Refnum/field codes that require OTM environment-specific configuration and are
// not automatically available in every environment (e.g. PROD needs manual setup
// of these external-feed refnum types before agents that read them can run safely).
const PROD_RESTRICTED_REFS = new Set([
  'CARRIER_SCORE',
  'CLAIM_RATE',
  'WEATHER_INDEX',
  'LINEHAUL_AMT',
  'ACCESSORIAL_AMT',
]);

function promotionPreflightService({ objects, source, target, agents, reads, writes, diffs, conflicts }) {
  // ── Build lookup maps ────────────────────────────────────────────────────────

  const agentMap = {};
  for (const a of agents) agentMap[a.id] = a;

  const agentReads  = {};  // agent_id → string[]
  const agentWrites = {};  // agent_id → string[]
  for (const r of reads)  (agentReads [r.agent_id] = agentReads [r.agent_id] || []).push(r.field_name);
  for (const w of writes) (agentWrites[w.agent_id] = agentWrites[w.agent_id] || []).push(w.field_name);

  const diffMap = {};
  for (const d of diffs) diffMap[d.id] = d;

  const promotingSet = new Set(objects);

  // Fields written by the NON-promoted agents — already available in target
  const targetAvailableFields = new Set();
  for (const a of agents) {
    if (!promotingSet.has(a.id)) {
      for (const f of (agentWrites[a.id] || [])) targetAvailableFields.add(f);
    }
  }

  // Fields written by promoted agents — will be available after this promotion batch
  const promotedWriteFields = new Set();
  for (const id of objects) {
    for (const f of (agentWrites[id] || [])) promotedWriteFields.add(f);
  }

  // All fields written by ANY agent in the system (used to detect inter-agent deps)
  const allAgentWrittenFields = new Set();
  for (const w of writes) allAgentWrittenFields.add(w.field_name);

  // Events held by non-promoted agents in target (for collision detection)
  const targetEvtMap = {}; // evt → agent_id[]
  for (const a of agents) {
    if (!promotingSet.has(a.id) && a.evt) {
      (targetEvtMap[a.evt] = targetEvtMap[a.evt] || []).push(a.id);
    }
  }

  // Active (unacknowledged) conflicts indexed by agent_id.
  // Only include conflicts where BOTH parties exist in the known agent set
  // (orphaned conflict entries referencing removed/future agents are skipped).
  const conflictsByAgent = {};
  for (const c of conflicts) {
    if (!c.acknowledged && agentMap[c.agent_a] && (!c.agent_b || agentMap[c.agent_b])) {
      (conflictsByAgent[c.agent_a] = conflictsByAgent[c.agent_a] || []).push(c);
      if (c.agent_b && c.agent_b !== c.agent_a)
        (conflictsByAgent[c.agent_b] = conflictsByAgent[c.agent_b] || []).push(c);
    }
  }

  const findings = [];

  for (const objId of objects) {
    const agent = agentMap[objId];
    if (!agent) {
      findings.push({
        severity: 'blocking', object: objId,
        message: `Agent "${objId}" was not found in the ${source} environment.`,
        suggested_fix: `Verify the agent ID is correct and exists in ${source}.`,
      });
      continue;
    }

    const agName   = agent.name;
    const objReads = agentReads[objId] || [];
    const diff     = diffMap[objId];

    // ── (a) Diff check ─────────────────────────────────────────────────────
    if (diff) {
      const rawRows = (() => {
        try { return typeof diff.rows === 'string' ? JSON.parse(diff.rows || '[]') : (diff.rows || []); }
        catch { return []; }
      })();

      const hasAnyChange = rawRows.some(r =>
        (r.l && r.l.t !== 'same' && r.l.t !== 'none') ||
        (r.r && r.r.t !== 'same' && r.r.t !== 'none'));

      if (diff.conflict_id) {
        const linked = conflicts.find(c => c.id === diff.conflict_id);
        findings.push({
          severity: 'blocking', object: objId,
          message: `${agName} carries unresolved conflict ${diff.conflict_id}: ${
            linked ? linked.detail.slice(0, 140) + '…' : 'see the Conflicts screen for details.'}`,
          suggested_fix: linked
            ? linked.fix
            : `Resolve conflict ${diff.conflict_id} before promoting ${objId}.`,
        });
      } else if (!hasAnyChange) {
        // All rows are same/none → cosmetic-only diff
        findings.push({
          severity: 'info', object: objId,
          message: `${agName} (${source} → ${target}): no functional differences detected — change is cosmetic or formatting-only.`,
          suggested_fix: null,
        });
      } else if (diff.warning) {
        findings.push({
          severity: 'warning', object: objId,
          message: `${agName}: ${diff.warning}`,
          suggested_fix: `Review the diff carefully; consider promoting dependent agents in the same batch.`,
        });
      } else if (diff.insight) {
        findings.push({
          severity: 'info', object: objId,
          message: `${agName}: ${diff.insight}`,
          suggested_fix: null,
        });
      }
    }

    // ── (b) Dependency check — missing refs in target ──────────────────────
    for (const field of objReads) {
      // Env-specific refnums: require explicit OTM configuration in target
      if (PROD_RESTRICTED_REFS.has(field) && target === 'PROD') {
        findings.push({
          severity: 'blocking', object: objId,
          message: `Refnum "${field}" read by ${agName} requires OTM environment configuration not verified in ${target}. This reference may be absent.`,
          suggested_fix: `Configure the "${field}" refnum type in ${target} before promoting, or confirm it is backfilled from an external feed.`,
        });
        continue;
      }

      // Inter-agent dependency: only check fields that are written by some agent
      if (!allAgentWrittenFields.has(field)) continue; // OTM system field, always present

      // Available from a non-promoted (already present) target agent?
      if (targetAvailableFields.has(field)) continue;

      // Will be available because another promoted agent in this batch writes it?
      if (promotedWriteFields.has(field)) continue;

      // Field is an inter-agent dep but not resolvable in target
      findings.push({
        severity: 'blocking', object: objId,
        message: `Field "${field}" required by ${agName} is not writable in ${target}: the agent that produces it has not been promoted yet.`,
        suggested_fix: `Include the agent that writes "${field}" in this promotion batch, or promote it first.`,
      });
    }

    // ── (c) Event conflict — trigger collision in target ───────────────────
    if (agent.evt && targetEvtMap[agent.evt] && targetEvtMap[agent.evt].length > 0) {
      const collidingIds   = targetEvtMap[agent.evt];
      const collidingNames = collidingIds.map(id => agentMap[id]?.name || id).join(', ');
      findings.push({
        severity: 'warning', object: objId,
        message: `Promoting ${agName} creates a trigger collision on ${agent.evt} — ${collidingNames} already fires on this event in ${target}.`,
        suggested_fix: `Review shared reads/writes on ${agent.evt}. Sequence execution with an event gate or merge overlapping logic to avoid race conditions.`,
      });
    }

    // ── Active conflict check (separate from diff.conflict_id) ────────────
    const ownConflicts = (conflictsByAgent[objId] || []).filter(
      c => !diff || c.id !== diff.conflict_id  // skip if already surfaced by diff check
    );
    for (const c of ownConflicts) {
      const sev = c.severity === 'critical' ? 'blocking' : 'warning';
      findings.push({
        severity: sev, object: objId,
        message: `${agName} is party to ${c.severity} conflict ${c.id} (${c.event}): ${c.detail.slice(0, 110)}…`,
        suggested_fix: c.fix,
      });
    }
  }

  // ── De-duplicate (object × severity × message prefix) ──────────────────
  const seen    = new Set();
  const deduped = findings.filter(f => {
    const key = `${f.object}|${f.severity}|${f.message.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Sort: blocking → warning → info ────────────────────────────────────
  const SEV_ORDER = { blocking: 0, warning: 1, info: 2 };
  deduped.sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));

  const blocking = deduped.filter(f => f.severity === 'blocking').length;
  const warning  = deduped.filter(f => f.severity === 'warning').length;
  const info     = deduped.filter(f => f.severity === 'info').length;

  const verdict = blocking > 0 ? 'blocked' : warning > 0 ? 'caution' : 'safe';

  return {
    verdict,
    counts: { blocking, warning, info, total: deduped.length },
    findings: deduped,
  };
}

module.exports = { promotionPreflightService, PROD_RESTRICTED_REFS };
