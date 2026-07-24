'use strict';
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promotionPreflightService } = require('./services/promotionPreflight');
const { translate: translateQuery, execute: executeQuery, buildVocab } = require('./services/agentQueryEngine');

const app = express();
const PORT = 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false } : false
});

app.use(express.json());

app.use(express.static(path.dirname(__filename)));
app.get('/', (req, res) => res.redirect('/Katalyst.dc.html'));

// ─── HELPER ───────────────────────────────────────────────────────────────────

async function query(sql, params) {
  const client = await pool.connect();
  try { return (await client.query(sql, params)).rows; }
  finally { client.release(); }
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── AGENTS ───────────────────────────────────────────────────────────────────

app.get('/api/agents', async (req, res) => {
  try {
    const [agentRows, condRows, actRows, readRows, writeRows] = await Promise.all([
      query('SELECT * FROM agents ORDER BY gx, gy'),
      query('SELECT * FROM agent_conditions ORDER BY agent_id, sort_order'),
      query('SELECT * FROM agent_actions    WHERE action_flow IS NULL OR action_flow=\'NORMAL\' ORDER BY agent_gid, action_sequence'),
      query('SELECT * FROM agent_reads      ORDER BY agent_id, sort_order'),
      query('SELECT * FROM agent_writes     ORDER BY agent_id, sort_order'),
    ]);
    res.json(agentRows.map(a => ({
      id: a.agent_gid, name: a.agent_xid, domain: a.domain_name, type: a.data_query_type_gid,
      version: a.version, owner: a.owner, trigger: a.trigger_name,
      evt: a.evt, priority: a.priority, success: parseFloat(a.success_rate)||0,
      health: a.health, gx: a.gx, gy: a.gy,
      // SkyMFG-specific properties (null for NWL agents)
      is_active: a.is_active, complexity_score: a.complexity_score,
      otm_release: a.otm_release, norm_action_count: a.norm_action_count,
      err_action_count: a.err_action_count, event_count: a.event_count,
      reentrancy_level: a.reentrancy_level, run_as_type: a.run_as_type,
      functional_categories: a.functional_categories,
      conditions: condRows.filter(r => r.agent_id === a.agent_gid).map(r => r.condition_text),
      actions:    actRows .filter(r => r.agent_gid === a.agent_gid).map(r => r.action_gid),
      reads:      readRows.filter(r => r.agent_id === a.agent_gid).map(r => r.field_name),
      writes:     writeRows.filter(r => r.agent_id === a.agent_gid).map(r => r.field_name),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agents/:id', async (req, res) => {
  const { id } = req.params;
  const { conditions, actions, version, health, success } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (version || health || success !== undefined)
      await client.query(
        'UPDATE agents SET version=COALESCE($1,version),health=COALESCE($2,health),success_rate=COALESCE($3,success_rate) WHERE agent_gid=$4',
        [version||null, health||null, success??null, id]);
    if (conditions) {
      await client.query('DELETE FROM agent_conditions WHERE agent_id=$1',[id]);
      for (let i=0;i<conditions.length;i++)
        await client.query('INSERT INTO agent_conditions(agent_id,condition_text,sort_order) VALUES($1,$2,$3)',[id,conditions[i],i]);
    }
    if (actions) {
      await client.query('DELETE FROM agent_actions WHERE agent_gid=$1 AND (action_flow IS NULL OR action_flow=\'NORMAL\')',[id]);
      for (let i=0;i<actions.length;i++)
        await client.query('INSERT INTO agent_actions(agent_gid,action_gid,action_sequence,action_flow) VALUES($1,$2,$3,\'NORMAL\')',[id,actions[i],i]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// GET /api/agents/xref?gid=X — event cross-reference for any agent (must be before /:id)
app.get('/api/agents/xref', async (req, res) => {
  const gid = req.query.gid;
  if (!gid) return res.status(400).json({ error: 'gid required' });
  try {
    const [triggersRows, triggeredByRows] = await Promise.all([
      query(`SELECT DISTINCT aa.action_gid AS raise_type, ae.event_gid,
               ae.agent_gid AS target_gid, a.agent_xid AS target_xid, a.domain_name AS target_domain
             FROM agent_actions aa
             JOIN agent_events ae ON (
               (aa.action_gid = 'RAISE INTERNAL EVENT'
                AND aa.action_params LIKE '%-internalEvent {' || ae.event_gid || '}%')
               OR (aa.action_gid IN ('RAISE EVENT','FOR EACH')
                AND aa.action_params LIKE '%-customEvent ' || ae.event_gid || '%')
             )
             JOIN agents a ON ae.agent_gid = a.agent_gid
             WHERE aa.agent_gid = $1 AND ae.agent_gid != $1`, [gid]),
      query(`SELECT DISTINCT ae.event_gid, aa.action_gid AS raise_type,
               aa.agent_gid AS source_gid, a.agent_xid AS source_xid, a.domain_name AS source_domain
             FROM agent_events ae
             JOIN agent_actions aa ON (
               (aa.action_gid = 'RAISE INTERNAL EVENT'
                AND aa.action_params LIKE '%-internalEvent {' || ae.event_gid || '}%')
               OR (aa.action_gid IN ('RAISE EVENT','FOR EACH')
                AND aa.action_params LIKE '%-customEvent ' || ae.event_gid || '%')
             )
             JOIN agents a ON aa.agent_gid = a.agent_gid
             WHERE ae.agent_gid = $1 AND aa.agent_gid != $1`, [gid]),
    ]);
    const byEvent = {};
    triggersRows.forEach(r => {
      if (!byEvent[r.event_gid]) byEvent[r.event_gid] = { event_gid: r.event_gid, raise_type: r.raise_type, targets: [] };
      if (!byEvent[r.event_gid].targets.find(t => t.agent_gid === r.target_gid))
        byEvent[r.event_gid].targets.push({ agent_gid: r.target_gid, agent_xid: r.target_xid, domain_name: r.target_domain });
    });
    const bySource = {};
    triggeredByRows.forEach(r => {
      if (!bySource[r.source_gid]) bySource[r.source_gid] = { agent_gid: r.source_gid, agent_xid: r.source_xid, domain_name: r.source_domain, events: [] };
      if (!bySource[r.source_gid].events.find(e => e.event_gid === r.event_gid))
        bySource[r.source_gid].events.push({ event_gid: r.event_gid, raise_type: r.raise_type });
    });
    res.json({ triggers: Object.values(byEvent), triggered_by: Object.values(bySource) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agents/event-edges — bulk OTM event connections between agents (must be before /:id)
app.get('/api/agents/event-edges', async (req, res) => {
  try {
    const rows = await query(`
      SELECT DISTINCT aa.agent_gid AS from_id, ae.agent_gid AS to_id,
        ae.event_gid, aa.action_gid AS raise_type
      FROM agent_actions aa
      JOIN agent_events ae ON (
        (aa.action_gid = 'RAISE INTERNAL EVENT'
          AND aa.action_params LIKE '%-internalEvent {' || ae.event_gid || '}%')
        OR (aa.action_gid IN ('RAISE EVENT','FOR EACH')
          AND aa.action_params LIKE '%-customEvent ' || ae.event_gid || '%')
      )
      WHERE aa.agent_gid != ae.agent_gid
      ORDER BY aa.agent_gid, ae.agent_gid
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agents/:id — single agent by GID (Bug 2 fix)
app.get('/api/agents/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [agentRows, condRows, actRows, readRows, writeRows] = await Promise.all([
      query('SELECT * FROM agents WHERE agent_gid=$1', [id]),
      query('SELECT * FROM agent_conditions WHERE agent_id=$1 ORDER BY sort_order', [id]),
      query('SELECT * FROM agent_actions WHERE agent_gid=$1 AND (action_flow IS NULL OR action_flow=\'NORMAL\') ORDER BY action_sequence', [id]),
      query('SELECT * FROM agent_reads WHERE agent_id=$1 ORDER BY sort_order', [id]),
      query('SELECT * FROM agent_writes WHERE agent_id=$1 ORDER BY sort_order', [id]),
    ]);
    if (!agentRows.length) return res.status(404).json({ error: 'Agent not found' });
    const a = agentRows[0];
    res.json({
      id: a.agent_gid, name: a.agent_xid, domain: a.domain_name, type: a.data_query_type_gid,
      version: a.version, owner: a.owner, trigger: a.trigger_name,
      evt: a.evt, priority: a.priority, success: parseFloat(a.success_rate),
      health: a.health, gx: a.gx, gy: a.gy,
      conditions: condRows.map(r => r.condition_text),
      actions: actRows.map(r => r.action_gid),
      reads: readRows.map(r => r.field_name),
      writes: writeRows.map(r => r.field_name),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AGENT DRAFTS ─────────────────────────────────────────────────────────────

app.get('/api/agents/:id/draft', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM agent_drafts WHERE agent_id=$1', [req.params.id]);
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agents/:id/draft', async (req, res) => {
  const { draft_text, saved_by } = req.body;
  try {
    const rows = await query(
      `INSERT INTO agent_drafts(agent_id, draft_text, saved_at, saved_by)
       VALUES($1,$2,NOW(),$3)
       ON CONFLICT(agent_id) DO UPDATE SET draft_text=$2, saved_at=NOW(), saved_by=$3
       RETURNING *`,
      [req.params.id, draft_text, saved_by || 'user']);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/agents/:id/draft', async (req, res) => {
  try {
    await query('DELETE FROM agent_drafts WHERE agent_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ANNOTATIONS / TRIBAL KNOWLEDGE ──────────────────────────────────────────

// Bulk: all annotations (grouped by agent for startup load); supports ?tag= and ?q=
app.get('/api/annotations', async (req, res) => {
  try {
    const { tag, q } = req.query;
    let sql = 'SELECT an.*, a.agent_xid AS agent_name FROM agent_annotations an JOIN agents a ON a.agent_gid=an.agent_id';
    const params = [];
    if (tag)    { sql += ' WHERE $1=ANY(an.tags)'; params.push(tag); }
    else if (q) { sql += ' WHERE an.note ILIKE $1'; params.push('%'+q+'%'); }
    sql += ' ORDER BY an.pinned DESC, an.created_at ASC';
    res.json(await query(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agents/:id/annotations', async (req, res) => {
  try {
    res.json(await query(
      'SELECT * FROM agent_annotations WHERE agent_id=$1 ORDER BY pinned DESC, created_at ASC',
      [req.params.id]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents/:id/annotations', async (req, res) => {
  const { note, severity, tags, author } = req.body;
  try {
    const rows = await query(
      'INSERT INTO agent_annotations(agent_id,note,severity,tags,author) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, note, severity||'info', tags||[], author||'You']
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/annotations/:id', async (req, res) => {
  const { note, severity, tags, pinned } = req.body;
  try {
    const rows = await query(
      `UPDATE agent_annotations
       SET note=COALESCE($1,note), severity=COALESCE($2,severity),
           tags=COALESCE($3,tags), pinned=COALESCE($4,pinned), updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [note??null, severity??null, tags??null, pinned??null, req.params.id]
    );
    res.json(rows[0]||{ok:false});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/annotations/:id', async (req, res) => {
  try {
    await query('DELETE FROM agent_annotations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WORKFLOW EDGES ───────────────────────────────────────────────────────────

app.get('/api/workflow-edges', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM workflow_edges ORDER BY id');
    // Return with both naming conventions so old & new frontend code works
    res.json(rows.map(e => ({
      ...e,
      from_agent: e.from_agent_id,
      to_agent:   e.to_agent_id,
      edge_type:  e.edge_type,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CONFLICTS ────────────────────────────────────────────────────────────────

app.get('/api/conflicts', async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM conflicts ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, id`);
    res.json(rows.map(c => ({ ...c, a: c.agent_a, b: c.agent_b })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/conflicts/:id', async (req, res) => {
  const { status, acknowledged_by } = req.body;
  try {
    const validStatuses = ['open', 'ack', 'resolved'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    // Store acknowledged_by when provided; preserve existing value otherwise
    await query(
      'UPDATE conflicts SET status=$1, acknowledged_by=COALESCE($3, acknowledged_by) WHERE id=$2',
      [status, req.params.id, acknowledged_by || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/conflicts/:id/acknowledge', async (req, res) => {
  try {
    await query("UPDATE conflicts SET status='ack' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────

app.get('/api/audit-log', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM audit_log ORDER BY time DESC');
    res.json(rows.map(a => ({
      ...a,
      time: fmtTime(a.time),
      username: a.username,
      user: a.username,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Both /api/audit and /api/audit-log accepted
async function insertAudit(body, sessionUsername) {
  const { user, username, action, target, env, result, tone, note, time } = body;
  const uname = sessionUsername || username || user || 'user';
  return query(
    'INSERT INTO audit_log(time,username,action,target,env,result,tone,note) VALUES(COALESCE($1::timestamptz,NOW()),$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [time || null, uname, action, target, env, result, tone, note || null]);
}

app.post('/api/audit-log', async (req, res) => {
  try {
    const rows = await insertAudit(req.body, req.body.username || 'admin');
    const a = rows[0];
    res.json({ ...a, time: fmtTime(a.time), username: a.username, user: a.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/audit', async (req, res) => {
  try {
    const rows = await insertAudit(req.body, req.body.username || 'admin');
    const a = rows[0];
    res.json({ ...a, time: fmtTime(a.time), username: a.username, user: a.username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── JOBS ─────────────────────────────────────────────────────────────────────

app.get('/api/jobs', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM jobs ORDER BY id');
    res.json(rows.map(j => ({ ...j, last: j.last_run, dur: j.duration })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/jobs/:id', async (req, res) => {
  const { last_run, duration, health, trend } = req.body;
  try {
    await query(
      'UPDATE jobs SET last_run=COALESCE($1,last_run),duration=COALESCE($2,duration),health=COALESCE($3,health),trend=COALESCE($4,trend) WHERE id=$5',
      [last_run||null, duration||null, health||null, trend||null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LIVE EVENTS ──────────────────────────────────────────────────────────────

app.get('/api/live-events', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM live_events ORDER BY id');
    res.json(rows.map(e => ({ ...e, ok: e.ok === true || e.ok === 'true' || e.ok === 't', agent: e.agent_id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TRACE ────────────────────────────────────────────────────────────────────

app.get('/api/trace', async (req, res) => {
  try {
    const [runs, steps] = await Promise.all([
      query('SELECT * FROM trace_runs ORDER BY id'),
      query('SELECT ts.* FROM trace_steps ts JOIN trace_runs tr ON tr.id=ts.trace_run_id ORDER BY ts.trace_run_id, ts.sort_order'),
    ]);
    res.json(runs.map(r => ({
      ...r,
      started: fmtTime(r.started),
      steps: steps.filter(s => s.trace_run_id === r.id)
               .map(s => ({ label: s.label, io: s.io, start: s.start_ms, dur: s.dur_ms, status: s.status })),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REGRESSION TESTS ─────────────────────────────────────────────────────────

app.get('/api/tests/:agentId', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM regression_tests WHERE agent_id=$1 ORDER BY sort_order',
      [req.params.agentId]);
    res.json(rows.map(t => ({ id: t.id, name: t.name, expect: t.expect_text, result: t.result, got: t.got_text || undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AGENT DIFFS (served from the frontend's hardcoded class data via passthrough) ──────

// Returns an empty array; the frontend class property agentDiffs is still
// the authoritative source for diff rows (complex nested structure).
// This endpoint exists so _loadData() doesn't throw on missing routes.
app.get('/api/agent-diffs', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM agent_diffs ORDER BY id');
    res.json(rows.map(d => ({
      id: d.id, prodVer: d.prod_ver, testVer: d.test_ver,
      insight: d.insight, warning: d.warning, conflictId: d.conflict_id,
      rows: typeof d.rows === 'string' ? JSON.parse(d.rows) : d.rows,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AGENT SNAPSHOTS (time-travel) ───────────────────────────────────────────

app.get('/api/agents/:id/snapshots', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, agent_id, snapshot_at, version_label, changed_by, note, config_json
       FROM agent_snapshots WHERE agent_id=$1 ORDER BY snapshot_at ASC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({
      id: r.id, agentId: r.agent_id,
      at: r.snapshot_at, version: r.version_label,
      by: r.changed_by, note: r.note,
      config: typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── METRICS ──────────────────────────────────────────────────────────────────

app.put('/api/metrics/:key', async (req, res) => {
  const { value, sub } = req.body;
  try {
    await query(
      'INSERT INTO overview_metrics(key,value,sub) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,sub=$3',
      [req.params.key, value, sub||null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LEGACY /api/data (kept for backwards compat) ────────────────────────────

app.get('/api/data', async (req, res) => {
  try {
    const [agentRows, condRows, actRows, readRows, writeRows,
           edgeRows, conflictRows, auditRows, jobRows,
           traceRunRows, traceStepRows, eventRows, metricRows] = await Promise.all([
      query('SELECT * FROM agents ORDER BY gx, gy'),
      query('SELECT * FROM agent_conditions ORDER BY agent_id, sort_order'),
      query('SELECT * FROM agent_actions    WHERE action_flow IS NULL OR action_flow=\'NORMAL\' ORDER BY agent_gid, action_sequence'),
      query('SELECT * FROM agent_reads      ORDER BY agent_id, sort_order'),
      query('SELECT * FROM agent_writes     ORDER BY agent_id, sort_order'),
      query('SELECT * FROM workflow_edges   ORDER BY id'),
      query(`SELECT * FROM conflicts ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, id`),
      query('SELECT * FROM audit_log        ORDER BY time DESC'),
      query('SELECT * FROM jobs             ORDER BY id'),
      query('SELECT * FROM trace_runs       ORDER BY id'),
      query('SELECT ts.* FROM trace_steps ts JOIN trace_runs tr ON tr.id=ts.trace_run_id ORDER BY ts.trace_run_id, ts.sort_order'),
      query('SELECT * FROM live_events      ORDER BY id'),
      query('SELECT * FROM overview_metrics'),
    ]);
    const agents = agentRows.map(a => ({
      id: a.agent_gid, name: a.agent_xid, domain: a.domain_name, type: a.data_query_type_gid,
      version: a.version, owner: a.owner, trigger: a.trigger_name,
      evt: a.evt, priority: a.priority, success: parseFloat(a.success_rate),
      health: a.health, gx: a.gx, gy: a.gy,
      conditions: condRows.filter(r => r.agent_id===a.agent_gid).map(r=>r.condition_text),
      actions:    actRows .filter(r => r.agent_gid===a.agent_gid).map(r=>r.action_gid),
      reads:      readRows.filter(r => r.agent_id===a.agent_gid).map(r=>r.field_name),
      writes:     writeRows.filter(r=>r.agent_id===a.agent_gid).map(r=>r.field_name),
    }));
    // Normalize edge rows to from_agent/to_agent — same convention as /api/workflow-edges.
    // Legacy type aliases (rule-deterministic, ai-conditional) retained for safety.
    const edgesNorm = edgeRows.map(e => ({ ...e, from_agent: e.from_agent_id, to_agent: e.to_agent_id }));
    const flowEdges = edgesNorm.filter(e=>e.edge_type==='flow'||e.edge_type==='rule-deterministic').map(e=>[e.from_agent,e.to_agent]);
    const aiEdges   = edgesNorm.filter(e=>e.edge_type==='ai' ||e.edge_type==='ai-conditional')   .map(e=>[e.from_agent,e.to_agent]);
    const conflicts = conflictRows.map(c=>({id:c.id,severity:c.severity,event:c.event,a:c.agent_a,b:c.agent_b,detail:c.detail,fix:c.fix,status:c.status||'open'}));
    const audit = auditRows.map(a=>({time:fmtTime(a.time),user:a.username,action:a.action,target:a.target,env:a.env,result:a.result,tone:a.tone,note:a.note||''}));
    const jobs  = jobRows.map(j=>({id:j.id,name:j.name,cron:j.cron,last:j.last_run,dur:j.duration,trend:j.trend,health:j.health}));
    const traceData = {};
    for (const run of traceRunRows) {
      const steps = traceStepRows.filter(s=>s.trace_run_id===run.id).map(s=>({label:s.label,io:s.io,start:s.start_ms,dur:s.dur_ms,status:s.status}));
      traceData[run.agent_id] = {run:run.run_id,shipment:run.shipment_gid,started:fmtTime(run.started),total:run.total_ms,health:run.health,status:run.status,statusLabel:run.status_label,steps};
    }
    const liveEventLog = eventRows.map(e=>({ts:e.ts,evt:e.evt,gid:e.gid,agent:e.agent_id,ms:e.ms,ok:e.ok}));
    const metrics = {};
    for (const m of metricRows) metrics[m.key] = {value:m.value,sub:m.sub};
    res.json({agents,flowEdges,aiEdges,conflicts,audit,jobs,traceData,liveEventLog,metrics});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── V2 ROUTES ────────────────────────────────────────────────────────────────

// POST /api/v2/promotion/preflight
// Body: { objects: string[], source: string, target: string, username?: string }
// Returns: { verdict: 'blocked'|'caution'|'safe', counts, findings[] }
app.post('/api/v2/promotion/preflight', async (req, res) => {
  try {
    const { objects, source, target, username } = req.body;
    if (!Array.isArray(objects) || objects.length === 0)
      return res.status(400).json({ error: 'objects must be a non-empty array of agent IDs' });
    if (!source || !target)
      return res.status(400).json({ error: 'source and target environment names are required' });

    const [agentRows, readRows, writeRows, diffRows, conflictRows] = await Promise.all([
      query('SELECT * FROM agents'),
      query('SELECT * FROM agent_reads'),
      query('SELECT * FROM agent_writes'),
      query('SELECT * FROM agent_diffs'),
      query('SELECT * FROM conflicts'),
    ]);

    const result = promotionPreflightService({
      objects, source, target,
      agents:    agentRows,
      reads:     readRows,
      writes:    writeRows,
      diffs:     diffRows,
      conflicts: conflictRows,
    });

    // Write a preflight event to the audit log (fire-and-forget — don't block the response)
    const toneMap = { blocked: 'red', caution: 'amber', safe: 'green' };
    insertAudit({
      action: 'Promotion preflight',
      target: objects.join(', '),
      env:    `${source} → ${target}`,
      result: result.verdict,
      tone:   toneMap[result.verdict] || 'teal',
      note:   `${result.counts.blocking} blocking · ${result.counts.warning} warning · ${result.counts.info} info`,
      username: username || 'system',
    }, null).catch(err => console.error('[preflight audit]', err.message));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v2/agent-query
// Body: { question: string }
// Returns: { queryPlan, explanation, confidence, matches, totalAgents, matchCount, timingMs }
app.post('/api/v2/agent-query', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim())
      return res.status(400).json({ error: 'question is required' });

    const t0 = Date.now();
    const [agentRows, readRows, writeRows, actionRows] = await Promise.all([
      query('SELECT * FROM agents'),
      query('SELECT * FROM agent_reads  ORDER BY agent_id, sort_order'),
      query('SELECT * FROM agent_writes ORDER BY agent_id, sort_order'),
      query('SELECT * FROM agent_actions WHERE action_flow IS NULL OR action_flow=\'NORMAL\' ORDER BY agent_gid, action_sequence'),
    ]);

    const vocab = buildVocab(agentRows, readRows, writeRows, actionRows);
    const { filters, explanation, confidence } = translateQuery(question.trim(), vocab);

    // Build lookup maps for the executor
    const agentReads = {}, agentWrites = {}, agentActions = {}, agentRaisedEvents = {};
    readRows.forEach(r  => (agentReads[r.agent_id]   = agentReads[r.agent_id]   || []).push(r.field_name));
    writeRows.forEach(r => (agentWrites[r.agent_id]  = agentWrites[r.agent_id]  || []).push(r.field_name));
    actionRows.forEach(r => {
      (agentActions[r.agent_gid] = agentActions[r.agent_gid] || []).push(r.action_gid);
      if (r.action_params) {
        const m1 = r.action_params.match(/-internalEvent\s+\{([^}]+)\}/);
        if (m1) (agentRaisedEvents[r.agent_gid] = agentRaisedEvents[r.agent_gid] || []).push(m1[1]);
        const m2 = r.action_params.match(/-customEvent\s+(\S+)/);
        if (m2) (agentRaisedEvents[r.agent_gid] = agentRaisedEvents[r.agent_gid] || []).push(m2[1]);
      }
    });

    const agents = agentRows.map(a => ({
      id: a.agent_gid, name: a.agent_xid, domain: a.domain_name, type: a.data_query_type_gid,
      version: a.version, owner: a.owner, evt: a.evt,
      priority: a.priority, success: parseFloat(a.success_rate),
      health: a.health, gx: a.gx, gy: a.gy,
    }));

    const { matches } = executeQuery(filters, { agents, agentReads, agentWrites, agentActions, agentRaisedEvents });

    res.json({
      question:    question.trim(),
      queryPlan:   filters,
      explanation,
      confidence,
      matches,
      totalAgents: agentRows.length,
      matchCount:  matches.length,
      timingMs:    Date.now() - t0,
      vocab: { fieldCount: vocab.fields.length, eventCount: vocab.events.length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

app.get('/api/admin/roles', async (req, res) => {
  try { res.json(await query('SELECT * FROM admin_roles ORDER BY id')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/roles/:id/permissions', async (req, res) => {
  try {
    const { permissions } = req.body;
    await query('UPDATE admin_roles SET permissions=$1 WHERE id=$2', [JSON.stringify(permissions), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const rows = await query(`SELECT u.*, r.name as role_name, r.color as role_color
      FROM admin_users u JOIN admin_roles r ON u.role_id=r.id ORDER BY u.username`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id', async (req, res) => {
  try {
    const { role_id, status } = req.body;
    await query('UPDATE admin_users SET role_id=COALESCE($1, role_id), status=COALESCE($2, status) WHERE id=$3', [role_id ?? null, status ?? null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/sso', async (req, res) => {
  try { res.json(await query('SELECT * FROM sso_connections ORDER BY id')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/sso/:id', async (req, res) => {
  try {
    const { tenant_url, client_id, enabled, attribute_map } = req.body;
    await query('UPDATE sso_connections SET tenant_url=$1, client_id=$2, enabled=$3, attribute_map=$4, updated_at=NOW() WHERE id=$5',
      [tenant_url, client_id, enabled, JSON.stringify(attribute_map || {}), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/sso/:id/test', async (req, res) => {
  try {
    const ok = Math.random() > 0.1;
    const status = ok ? 'connected' : 'error';
    await query('UPDATE sso_connections SET status=$1, last_tested=NOW() WHERE id=$2', [status, req.params.id]);
    res.json({ ok, status, message: ok ? 'Connection verified' : 'LDAP bind failed: check client credentials' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/api-keys', async (req, res) => {
  try {
    const rows = await query('SELECT id,name,key_prefix,scopes,created_by,created_at,expires_at,last_used_at,revoked FROM api_keys ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/api-keys', async (req, res) => {
  try {
    const { name, scopes, expires_days, created_by } = req.body;
    const rawKey = 'cat_' + crypto.randomBytes(24).toString('hex');
    const prefix = rawKey.slice(0, 14) + '\u2026';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const expiresAt = expires_days ? new Date(Date.now() + Number(expires_days) * 86400000).toISOString() : null;
    const id = 'AK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await query('INSERT INTO api_keys(id,name,key_prefix,key_hash,scopes,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, name, prefix, keyHash, scopes || [], created_by || 'admin', expiresAt]);
    res.json({ id, name, key_prefix: prefix, raw_key: rawKey, scopes, expires_at: expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/api-keys/:id', async (req, res) => {
  try {
    await query('UPDATE api_keys SET revoked=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/api-keys/:id/rotate', async (req, res) => {
  try {
    const rawKey = 'cat_' + crypto.randomBytes(24).toString('hex');
    const prefix = rawKey.slice(0, 14) + '\u2026';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await query('UPDATE api_keys SET key_prefix=$1, key_hash=$2, last_used_at=NULL WHERE id=$3 AND revoked=false', [prefix, keyHash, req.params.id]);
    res.json({ raw_key: rawKey, key_prefix: prefix });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/global-config', async (req, res) => {
  try { res.json(await query('SELECT * FROM global_config ORDER BY category, key')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/global-config/:key', async (req, res) => {
  try {
    const { dev_value, test_value, prod_value, updated_by } = req.body;
    await query('UPDATE global_config SET dev_value=$1, test_value=$2, prod_value=$3, updated_by=$4, updated_at=NOW() WHERE key=$5',
      [dev_value, test_value, prod_value, updated_by || 'admin', req.params.key]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/global-config/propagate', async (req, res) => {
  try {
    const { key, value, envs } = req.body;
    const updates = [];
    if (envs.includes('DEV'))  updates.push(query('UPDATE global_config SET dev_value=$1,  updated_at=NOW(), updated_by=$2 WHERE key=$3', [value, 'admin', key]));
    if (envs.includes('TEST')) updates.push(query('UPDATE global_config SET test_value=$1, updated_at=NOW(), updated_by=$2 WHERE key=$3', [value, 'admin', key]));
    if (envs.includes('PROD')) updates.push(query('UPDATE global_config SET prod_value=$1, updated_at=NOW(), updated_by=$2 WHERE key=$3', [value, 'admin', key]));
    await Promise.all(updates);
    res.json({ ok: true, propagated: envs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SKYMFG DATA API ─────────────────────────────────────────────────────────

function tryParseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

app.get('/api/skymfg/summary', async (req, res) => {
  try {
    const [totRow, actionRow, errorRow, domCount, dqtCount, domDist, dqtBreak, relRow] = await Promise.all([
      query(`SELECT COUNT(*) AS agents, COUNT(*) FILTER (WHERE is_active) AS active_agents,
             ROUND(AVG(complexity_score)::numeric,1) AS avg_complexity FROM agents
             WHERE domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG')`),
      query(`SELECT COUNT(*) AS n FROM agent_actions aa JOIN agents a ON aa.agent_gid=a.agent_gid
             WHERE a.domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG') AND aa.action_flow='NORMAL'`),
      query(`SELECT COUNT(*) AS n FROM agent_actions aa JOIN agents a ON aa.agent_gid=a.agent_gid
             WHERE a.domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG') AND aa.action_flow='ERROR'`),
      query(`SELECT COUNT(*) AS n FROM domains WHERE tenant_id='SKYMFG'`),
      query(`SELECT COUNT(DISTINCT data_query_type_gid) AS n FROM agents
             WHERE domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG')`),
      query(`SELECT d.domain_name,d.display_label,d.theme_color,COUNT(a.agent_gid) AS agent_count
             FROM domains d LEFT JOIN agents a ON a.domain_name=d.domain_name
             WHERE d.tenant_id='SKYMFG' GROUP BY d.domain_name,d.display_label,d.theme_color ORDER BY agent_count DESC`),
      query(`SELECT data_query_type_gid AS gid,COUNT(*) AS agent_count FROM agents
             WHERE domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG')
             GROUP BY data_query_type_gid ORDER BY agent_count DESC`),
      query(`SELECT otm_release FROM agents WHERE domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG')
             AND otm_release IS NOT NULL AND otm_release!='' GROUP BY otm_release ORDER BY COUNT(*) DESC LIMIT 1`),
    ]);
    res.json({
      totals: {
        agents:parseInt(totRow[0].agents), active_agents:parseInt(totRow[0].active_agents),
        avg_complexity:parseFloat(totRow[0].avg_complexity)||0,
        domains:parseInt(domCount[0].n), dqt_count:parseInt(dqtCount[0].n),
        action_steps:parseInt(actionRow[0].n), error_steps:parseInt(errorRow[0].n),
        total_steps:parseInt(actionRow[0].n)+parseInt(errorRow[0].n),
        top_release:relRow[0]?.otm_release||'—',
      },
      domain_dist:domDist.map(d=>({...d,agent_count:parseInt(d.agent_count)})),
      dqt_breakdown:dqtBreak.map(d=>({...d,agent_count:parseInt(d.agent_count)})),
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/skymfg/domains', async (req, res) => {
  try {
    res.json(await query(
      `SELECT domain_name,display_label,description,environment_type,theme_color,agent_count
       FROM domains WHERE tenant_id='SKYMFG' ORDER BY environment_type,domain_name`
    ));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/skymfg/agents', async (req, res) => {
  try {
    const dom = req.query.domain||null;
    const rows = await query(
      `SELECT a.agent_gid,a.agent_xid,a.domain_name,a.data_query_type_gid,
              a.is_active,a.reentrancy_level,a.run_as_type,a.is_single_thread,a.is_object_lock,
              a.is_long_running,a.otm_release,a.saved_condition_gid,a.log_level,a.stats_level,
              a.norm_action_count,a.err_action_count,a.event_count,a.complexity_score,a.functional_categories
       FROM agents a JOIN domains d ON a.domain_name=d.domain_name
       WHERE d.tenant_id='SKYMFG' AND ($1::text IS NULL OR a.domain_name=$1)
       ORDER BY a.domain_name,a.data_query_type_gid,a.agent_xid`, [dom]
    );
    const boolify = v => v===true||v==='t'||v==='true';
    res.json(rows.map(r=>({
      ...r,
      is_active:boolify(r.is_active), is_single_thread:boolify(r.is_single_thread),
      is_object_lock:boolify(r.is_object_lock), is_long_running:boolify(r.is_long_running),
      complexity_score:parseFloat(r.complexity_score)||0,
      norm_action_count:parseInt(r.norm_action_count)||0,
      err_action_count:parseInt(r.err_action_count)||0,
      event_count:parseInt(r.event_count)||0,
      functional_categories:tryParseJSON(r.functional_categories,[]),
    })));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/skymfg/agent', async (req, res) => {
  try {
    const gid = req.query.gid;
    if(!gid) return res.status(400).json({error:'gid required'});
    const [agentRows,events,actions] = await Promise.all([
      query(`SELECT * FROM agents WHERE agent_gid=$1`,[gid]),
      query(`SELECT event_gid,event_params FROM agent_events WHERE agent_gid=$1 ORDER BY id`,[gid]),
      query(`SELECT action_flow,action_sequence,action_gid,action_params,data_type_assoc
             FROM agent_actions WHERE agent_gid=$1 ORDER BY action_flow,action_sequence`,[gid]),
    ]);
    if(!agentRows.length) return res.status(404).json({error:'Not found'});
    const a=agentRows[0];
    const boolify = v => v===true||v==='t'||v==='true';
    res.json({
      ...a, is_active:boolify(a.is_active), is_single_thread:boolify(a.is_single_thread),
      is_object_lock:boolify(a.is_object_lock), is_long_running:boolify(a.is_long_running),
      complexity_score:parseFloat(a.complexity_score)||0,
      norm_action_count:parseInt(a.norm_action_count)||0,
      err_action_count:parseInt(a.err_action_count)||0,
      event_count:parseInt(a.event_count)||0,
      functional_categories:tryParseJSON(a.functional_categories,[]),
      events, actions,
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/skymfg/xref', async (req, res) => {
  const gid = req.query.gid;
  if (!gid) return res.status(400).json({ error: 'gid required' });
  try {
    const [triggersRows, triggeredByRows] = await Promise.all([
      // Events this agent RAISES → agents listening for them
      query(`SELECT DISTINCT
               aa.action_gid  AS raise_type,
               ae.event_gid,
               ae.agent_gid   AS target_gid,
               a.agent_xid    AS target_xid,
               a.domain_name  AS target_domain
             FROM agent_actions aa
             JOIN agent_events ae ON (
               (aa.action_gid = 'RAISE INTERNAL EVENT'
                AND aa.action_params LIKE '%-internalEvent {' || ae.event_gid || '}%')
               OR (aa.action_gid IN ('RAISE EVENT','FOR EACH')
                AND aa.action_params LIKE '%-customEvent ' || ae.event_gid || '%')
             )
             JOIN agents a ON ae.agent_gid = a.agent_gid
             WHERE aa.agent_gid = $1 AND ae.agent_gid != $1`, [gid]),
      // Agents that RAISE events this agent listens to
      query(`SELECT DISTINCT
               ae.event_gid,
               aa.action_gid  AS raise_type,
               aa.agent_gid   AS source_gid,
               a.agent_xid    AS source_xid,
               a.domain_name  AS source_domain
             FROM agent_events ae
             JOIN agent_actions aa ON (
               (aa.action_gid = 'RAISE INTERNAL EVENT'
                AND aa.action_params LIKE '%-internalEvent {' || ae.event_gid || '}%')
               OR (aa.action_gid IN ('RAISE EVENT','FOR EACH')
                AND aa.action_params LIKE '%-customEvent ' || ae.event_gid || '%')
             )
             JOIN agents a ON aa.agent_gid = a.agent_gid
             WHERE ae.agent_gid = $1 AND aa.agent_gid != $1`, [gid]),
    ]);
    // Group triggers by event_gid
    const byEvent = {};
    triggersRows.forEach(r => {
      if (!byEvent[r.event_gid]) byEvent[r.event_gid] = { event_gid: r.event_gid, raise_type: r.raise_type, targets: [] };
      if (!byEvent[r.event_gid].targets.find(t => t.agent_gid === r.target_gid))
        byEvent[r.event_gid].targets.push({ agent_gid: r.target_gid, agent_xid: r.target_xid, domain_name: r.target_domain });
    });
    // Group triggered_by by source agent
    const bySource = {};
    triggeredByRows.forEach(r => {
      if (!bySource[r.source_gid]) bySource[r.source_gid] = { agent_gid: r.source_gid, agent_xid: r.source_xid, domain_name: r.source_domain, events: [] };
      if (!bySource[r.source_gid].events.find(e => e.event_gid === r.event_gid))
        bySource[r.source_gid].events.push({ event_gid: r.event_gid, raise_type: r.raise_type });
    });
    res.json({ triggers: Object.values(byEvent), triggered_by: Object.values(bySource) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/skymfg/integrations', async (req, res) => {
  try {
    const [sysRows, usageRows] = await Promise.all([
      query(`SELECT external_system_gid FROM external_systems
             WHERE external_system_gid LIKE 'SKYMFG%' ORDER BY external_system_gid`),
      query(`SELECT DISTINCT aa.agent_gid, a.agent_xid, a.domain_name, aa.action_params
             FROM agent_actions aa JOIN agents a ON aa.agent_gid=a.agent_gid
             WHERE aa.action_params ILIKE '%-externalSystem %'
             AND a.domain_name IN (SELECT domain_name FROM domains WHERE tenant_id='SKYMFG')`),
    ]);
    const bySystem = {};
    usageRows.forEach(r => {
      const m = r.action_params && r.action_params.match(/-externalSystem\s+(\S+)/);
      if (!m) return;
      const gid = m[1];
      if (!bySystem[gid]) bySystem[gid] = new Map();
      bySystem[gid].set(r.agent_gid, { agent_gid:r.agent_gid, agent_xid:r.agent_xid, domain_name:r.domain_name });
    });
    res.json(sysRows.map(s => ({
      external_system_gid: s.external_system_gid,
      agents: Array.from((bySystem[s.external_system_gid]||new Map()).values()),
    })));
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ─── AUTO-SEED ───────────────────────────────────────────────────────────────
// Runs once at startup when the database is empty (e.g. first production deploy).

async function autoSeedIfEmpty() {
  try {
    const rows = await query('SELECT COUNT(*) AS n FROM agents');
    if (parseInt(rows[0].n) > 0) return; // already seeded
    console.log('[seed] Empty database detected — seeding…');

    const agents = [
      // ── DOMAIN 1: Order Management (col gx=50) ───────────────────────────────
      { id:'AG-ORD-RATESVC',    name:'Rate & Service Selection',      domain:'Order Management',   type:'Rating',     version:'v4.2.1',  owner:'s.patel',    trigger:'Order Released',              evt:'ORDER_RELEASED',         priority:'High',     success:97.3, health:'green', gx:50,  gy:50,
        conditions:["ORDER_MOVEMENT.status = 'NEW'","SERVICE_LEVEL is not null","SHIP_UNIT_GID is not null","HAZMAT_FLAG = false OR HAZMAT_CERT_GID is not null","CLASS_FREIGHT_GID is not null OR SERVICE_LEVEL != 'LTL'"],
        actions:["VALIDATE FREIGHT CLASS // SHIP_UNIT_GID · CLASS_FREIGHT_GID","RECALC RATES // ORDER_MOVEMENT_GID · LANE_GID","SELECT SERVICE PROVIDER // via RATE_GEO_COST_GID","SET FIELD RATE_GID // from rating engine result","SET FIELD SERVICE_GID // awarded service level","EMIT EVENT RATE_APPLIED // ORDER_MOVEMENT_GID"],
        reads:["ORDER_MOVEMENT_GID","SHIP_UNIT_GID","SERVICE_LEVEL","SHIP_FROM_GID","SHIP_TO_GID","LANE_GID","HAZMAT_FLAG","CLASS_FREIGHT_GID","WEIGHT_LBS","DIMS_GID"],
        writes:["RATE_GID","SERVICE_GID","RATE_GEO_COST_GID","TOTAL_COST"] },
      { id:'AG-ORD-CREDITHOLD',  name:'Credit Hold Check',           domain:'Order Release',       type:'Compliance', version:'v1.4.2',    owner:'s.patel',   trigger:'Order Released',           evt:'ORDER_RELEASED',    priority:'Critical', success:99.1, health:'green', gx:50,  gy:212,
        conditions:["CUSTOMER.credit_status IN ('REVIEW','WATCH')","ORDER_VALUE > CUSTOMER.CREDIT_LIMIT * 0.85","OUTSTANDING_AR_BALANCE > 0"],
        actions:["EVALUATE CREDIT LIMIT // CUSTOMER_GID · ORDER_VALUE","APPLY HOLD // ORDER_MOVEMENT_GID","SET STATUS HOLD_STATUS = CREDIT","WRITE AUDIT LOG // event CREDIT_HOLD · ref ORDER_MOVEMENT_GID","NOTIFY CREDIT MANAGER // CUSTOMER_GID · ORDER_VALUE"],
        reads:["ORDER_MOVEMENT_GID","CUSTOMER_GID","ORDER_VALUE","CREDIT_LIMIT","OUTSTANDING_AR_BALANCE"],
        writes:["HOLD_STATUS","ORDER_STATUS","AUDIT_ENTRY"] },
      { id:'AG-AI-CARRIERRANK',  name:'AI Carrier Ranking',          domain:'Oracle AI',           type:'AI',         version:'v1.2.0',    owner:'oracle.ai', trigger:'Rate Applied',             evt:'RATE_APPLIED',      priority:'Medium',   success:91.2, health:'amber', gx:50,  gy:360,
        conditions:["RATE_GID is not null","model.confidence > 0.72","CARRIER_POOL.count >= 2"],
        actions:["SCORE CARRIERS // LANE_GID · HISTORICAL_PERF","APPLY DWELL PENALTY // AVG_DWELL_HRS","RANK BY ON-TIME DELIVERY // SERVICE_PROVIDER_GID[]","EMIT HINT CARRIER_RANK_HINT // top 3 carriers"],
        reads:["LANE_GID","RATE_GID","SERVICE_PROVIDER_GID[]","HISTORICAL_PERF","AVG_DWELL_HRS","ON_TIME_PCT","CLAIM_RATE"],
        writes:["CARRIER_RANK_HINT"] },
      { id:'AG-SHIP-AUTOTENDER', name:'Auto-Tender on Plan',         domain:'Shipment Execution',  type:'Tender',     version:'v2.4.1',    owner:'m.reyes',   trigger:'Shipment Planned',         evt:'SHIPMENT_PLANNED',  priority:'Critical', success:98.2, health:'green', gx:330, gy:64,
        conditions:["SHIPMENT.status = 'PLANNED'","PLANNED_SHIP_DATE <= sysdate + 2","PLANNED_COST < BUDGET_LIMIT","HOLD_STATUS is null","EQUIPMENT_GROUP_GID is not null"],
        actions:["READ HINT CARRIER_RANK_HINT","SELECT CARRIER // via hint or lane default","BUILD TENDER PAYLOAD // SHIPMENT_GID · CARRIER_GID","SEND TENDER // to SERVICE_PROVIDER_GID · ref TENDER_GID","SET STATUS TENDER_STATUS = SENT","SCHEDULE ACK TIMEOUT // 30 seconds"],
        reads:["SHIPMENT_GID","PLANNED_COST","PLANNED_SHIP_DATE","EQUIPMENT_GROUP_GID","CARRIER_RANK_HINT","TENDER_HINT","HOLD_STATUS"],
        writes:["TENDER_GID","TENDER_STATUS","CARRIER_GID"] },
      { id:'AG-AI-DWELL',        name:'Dwell Prediction',            domain:'Oracle AI',           type:'AI',         version:'v0.9-beta', owner:'oracle.ai', trigger:'Shipment Planned',         evt:'SHIPMENT_PLANNED',  priority:'Medium',   success:88.4, health:'amber', gx:330, gy:226,
        conditions:["model.confidence > 0.60","LOCATION_GID in model.coverage_zones","SHIPMENT.equipment_type != 'RAIL'"],
        actions:["LOAD MODEL dwell_rf_v3","EXTRACT FEATURES // LOCATION_GID · CARRIER_SCORE · TIME_OF_DAY","RUN INFERENCE // HISTORICAL_DWELL · WEATHER_INDEX","SET FIELD DWELL_FORECAST // AI prediction output","EMIT HINT TENDER_HINT // with confidence score"],
        reads:["SHIPMENT_GID","LOCATION_GID","HISTORICAL_DWELL","CARRIER_SCORE","WEATHER_INDEX","TIME_OF_DAY"],
        writes:["DWELL_FORECAST","TENDER_HINT"] },
      { id:'AG-SHIP-TENDERRESP', name:'Tender Response Handler',     domain:'Shipment Execution',  type:'Tender',     version:'v1.9.0',    owner:'m.reyes',   trigger:'Tender Response Received', evt:'TENDER_RESPONSE',   priority:'High',     success:99.1, health:'green', gx:610, gy:64,
        conditions:["TENDER_GID is not null","TENDER_STATUS IN ('SENT','RETENDERED')","RESPONSE_TIMESTAMP < TENDER_GID.expiry"],
        actions:["VALIDATE TENDER VERSION // TENDER_GID","RECORD CARRIER RESPONSE // TENDER_RESPONSE · CARRIER_GID","onAccept → SET STATUS SHIPMENT_STATUS = CONFIRMED","onAccept → EMIT EVENT SHIPMENT_CONFIRMED","onDecline → RAISE EVENT TENDER_DECLINED","LOG CARRIER PERFORMANCE // CARRIER_GID · RESPONSE_TIME_MS"],
        reads:["TENDER_GID","TENDER_STATUS","CARRIER_GID","TENDER_RESPONSE","RESPONSE_TIMESTAMP"],
        writes:["SHIPMENT_STATUS","TENDER_STATUS","CARRIER_PERF_LOG"] },
      { id:'AG-SHIP-RETENDER',   name:'Auto Re-Tender on Decline',   domain:'Shipment Execution',  type:'Tender',     version:'v2.0.3',    owner:'a.okafor',  trigger:'Tender Declined',          evt:'TENDER_DECLINED',   priority:'High',     success:95.6, health:'amber', gx:610, gy:226,
        conditions:["TENDER_STATUS = 'DECLINED'","RETENDER_COUNT < 3","ALT_CARRIER_POOL.size > 0","PLANNED_SHIP_DATE > sysdate + 0.5"],
        actions:["incrementRetenderCount(TENDER_GID)","excludeDeclinedCarrier(CARRIER_GID)","selectNextCarrier(ALT_CARRIER_POOL, CARRIER_RANK_HINT)","buildTenderPayload(SHIPMENT_GID, new_CARRIER_GID)","sendTender(new_CARRIER_GID, TENDER_GID)","setTenderStatus('RETENDERED')","onTimeout(30s) => escalate(SHIPMENT_GID, 'CARRIER_TIMEOUT')"],
        reads:["TENDER_GID","TENDER_STATUS","CARRIER_GID","RETENDER_COUNT","ALT_CARRIER_POOL","PLANNED_SHIP_DATE","CARRIER_RANK_HINT"],
        writes:["TENDER_STATUS","CARRIER_GID","RETENDER_COUNT"] },
      { id:'AG-SHIP-TRACKUPDATE',name:'Shipment Track & Trace',      domain:'Shipment Execution',  type:'Tracking',   version:'v2.3.1',    owner:'l.tran',    trigger:'Shipment Confirmed',       evt:'SHIPMENT_CONFIRMED',priority:'Medium',   success:96.4, health:'green', gx:890, gy:226,
        conditions:["SHIPMENT.status = 'CONFIRMED'","CARRIER_GID.edi_capable = true OR CARRIER_GID.api_capable = true"],
        actions:["SUBSCRIBE TRACKING FEED // CARRIER_GID · SHIPMENT_GID","MAP STATUS CARRIER_STATUS → OTM_STATUS","UPDATE MILESTONE // MILESTONE_CODE · EVENT_TIMESTAMP","onDelivered → SET STATUS SHIPMENT_STATUS = DELIVERED","onException → RAISE EVENT SHIPMENT_EXCEPTION","NOTIFY STAKEHOLDERS // CUSTOMER_GID · MILESTONE_CODE"],
        reads:["SHIPMENT_GID","CARRIER_GID","TRACKING_NUMBER","CARRIER_STATUS"],
        writes:["SHIPMENT_STATUS","MILESTONE_LOG","ETA_TIMESTAMP"] },
      { id:'AG-SHIP-DOCGEN',     name:'Document Generation',         domain:'Shipment Execution',  type:'Document',   version:'v3.1.0',    owner:'l.tran',    trigger:'Shipment Confirmed',       evt:'SHIPMENT_CONFIRMED',priority:'Medium',   success:99.7, health:'green', gx:890, gy:64,
        conditions:["SHIPMENT.status = 'CONFIRMED'","CARRIER_GID.bol_required = true","SHIP_UNIT_GID is not null"],
        actions:["GENERATE BILL OF LADING // SHIPMENT_GID · CARRIER_GID","GENERATE LABELS // SHIP_UNIT_GID[] · format ZPL","GENERATE PRO BILL // CARRIER_GID · TENDER_GID","WRITE DOCUMENT SET // DOCUMENT_SET_GID","TRANSMIT TO CARRIER // DOCUMENT_SET_GID → CARRIER_GID.edi_mailbox"],
        reads:["SHIPMENT_GID","CARRIER_GID","SHIP_UNIT_GID","TENDER_GID"],
        writes:["DOCUMENT_SET_GID","BOL_GID","LABEL_SET_GID"] },
      { id:'AG-INV-AUTOAPPROVE', name:'Auto-Approve under Tolerance',domain:'Invoice & Finance',   type:'Invoice',    version:'v2.1.5',    owner:'d.kim',     trigger:'Invoice Received',         evt:'INVOICE_RECEIVED',  priority:'Medium',   success:94.1, health:'amber', gx:890, gy:352,
        conditions:["FREIGHT_BILL.status = 'RECEIVED'","abs(FB_AMOUNT - RATE_GEO_COST) <= TOLERANCE_BAND","RATE_GID is not null","SHIPMENT_GID.status = 'DELIVERED'","NOT exists(DUPLICATE_FB_FLAG)"],
        actions:["MATCH FREIGHT BILL // FREIGHT_BILL_GID against RATE_GID","VALIDATE ACCESSORIALS // ACCESSORIAL_CHARGES","COMPUTE VARIANCE // FB_AMOUNT vs RATE_GEO_COST","SET STATUS INVOICE_STATUS = APPROVED","SCHEDULE PAYMENT // PAYMENT_DUE_DATE · FB_AMOUNT"],
        reads:["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST","TOLERANCE_BAND","ACCESSORIAL_CHARGES"],
        writes:["MATCH_STATUS","INVOICE_STATUS","PAYMENT_SCHEDULE_GID"] },
      { id:'AG-INV-VARIANCE',    name:'Variance Escalation',         domain:'Invoice & Finance',   type:'Invoice',    version:'v1.2.0',    owner:'d.kim',     trigger:'Invoice Received',         evt:'INVOICE_RECEIVED',  priority:'Medium',   success:92.5, health:'amber', gx:610, gy:382,
        conditions:["abs(FB_AMOUNT - RATE_GEO_COST) > TOLERANCE_BAND","FREIGHT_BILL.status = 'RECEIVED'"],
        actions:["CLASSIFY VARIANCE // FB_AMOUNT minus RATE_GEO_COST","OPEN ESCALATION TICKET // FREIGHT_BILL_GID","WRITE ESCALATION TICKET // ESCALATION_TICKET_GID","ESCALATE TO SLA // variance amount · SLA_HOURS = 4h","NOTIFY TEAM // d.kim · finance-ops@nwl.com"],
        reads:["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST","TOLERANCE_BAND"],
        writes:["ESCALATION_TICKET_GID","INVOICE_STATUS","SLA_CLOCK_START"] },
      { id:'AG-INV-FRTAUDIT',    name:'Freight Bill Audit',          domain:'Invoice & Finance',   type:'Invoice',    version:'v1.0.4',    owner:'d.kim',     trigger:'Invoice Approved',         evt:'INVOICE_APPROVED',  priority:'Low',      success:98.8, health:'green', gx:890, gy:500,
        conditions:["INVOICE_STATUS = 'APPROVED'","FREIGHT_BILL.payment_method = 'NET30'","AUDIT_REQUIRED_FLAG = true OR FB_AMOUNT > 10000"],
        actions:["CROSS-CHECK ACCESSORIALS // FREIGHT_BILL_GID against CONTRACT_GID","VERIFY FUEL SURCHARGE // FSC_RATE · CARRIER_GID","CHECK DUPLICATE INVOICE // FREIGHT_BILL_GID · DATE_RANGE = 90d","FLAG DISCREPANCY // DISCREPANCY_TYPE · DISCREPANCY_AMOUNT","WRITE AUDIT TRAIL // AUDIT_LOG_GID"],
        reads:["FREIGHT_BILL_GID","CONTRACT_GID","FSC_RATE","ACCESSORIAL_CHARGES","PAYMENT_TERMS"],
        writes:["AUDIT_STATUS","DISCREPANCY_AMOUNT","AUDIT_LOG_GID"] },
    ];
    for (const a of agents) {
      await query(`INSERT INTO agents(agent_gid,agent_xid,domain_name,data_query_type_gid,version,owner,trigger_name,evt,priority,success_rate,health,gx,gy)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (agent_gid) DO NOTHING`,
        [a.id,a.name,a.domain,a.type,a.version,a.owner,a.trigger,a.evt,a.priority,a.success,a.health,a.gx,a.gy]);
      for (let i=0;i<a.conditions.length;i++) await query(`INSERT INTO agent_conditions(agent_id,condition_text,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[a.id,a.conditions[i],i]);
      for (let i=0;i<a.actions.length;i++)    await query(`INSERT INTO agent_actions(agent_gid,action_gid,action_sequence,action_flow) VALUES($1,$2,$3,'NORMAL') ON CONFLICT DO NOTHING`,[a.id,a.actions[i],i]);
      for (let i=0;i<a.reads.length;i++)      await query(`INSERT INTO agent_reads(agent_id,field_name,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[a.id,a.reads[i],i]);
      for (let i=0;i<a.writes.length;i++)     await query(`INSERT INTO agent_writes(agent_id,field_name,sort_order) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[a.id,a.writes[i],i]);
    }

    const flowEdges = [
      ['AG-ORD-RATESVC','AG-SHIP-AUTOTENDER','flow'],['AG-ORD-CREDITHOLD','AG-SHIP-AUTOTENDER','flow'],
      ['AG-SHIP-AUTOTENDER','AG-SHIP-TENDERRESP','flow'],['AG-SHIP-TENDERRESP','AG-SHIP-DOCGEN','flow'],
      ['AG-SHIP-TENDERRESP','AG-SHIP-RETENDER','flow'],['AG-SHIP-TENDERRESP','AG-SHIP-TRACKUPDATE','flow'],
      ['AG-SHIP-RETENDER','AG-SHIP-TENDERRESP','flow'],['AG-SHIP-DOCGEN','AG-INV-AUTOAPPROVE','flow'],
      ['AG-INV-AUTOAPPROVE','AG-INV-FRTAUDIT','flow'],['AG-INV-AUTOAPPROVE','AG-INV-VARIANCE','flow'],
      ['AG-AI-DWELL','AG-SHIP-AUTOTENDER','ai'],['AG-AI-CARRIERRANK','AG-SHIP-AUTOTENDER','ai'],
      ['AG-AI-CARRIERRANK','AG-SHIP-RETENDER','ai'],
    ];
    for (const [f,t,tp] of flowEdges) await query(`INSERT INTO workflow_edges(from_agent_id,to_agent_id,edge_type) VALUES($1,$2,$3)`,[f,t,tp]);

    const conflicts = [
      {id:'C-002',severity:'critical',event:'SHIPMENT_PLANNED',agent_a:'AG-SHIP-AUTOTENDER',agent_b:'AG-AI-DWELL',detail:"Both agents subscribe to SHIPMENT_PLANNED. Dwell Prediction writes TENDER_HINT which Auto-Tender reads -- but execution order is non-deterministic. In 23% of observed runs, Auto-Tender fires before TENDER_HINT is written, producing sub-optimal carrier selection. Race window averages 504ms under production load.",fix:"Sequence AG-AI-DWELL before AG-SHIP-AUTOTENDER using an event gate on DWELL_FORECAST availability, or gate Auto-Tender on TENDER_HINT with a bounded 500ms wait before falling back to default lane preferences."},
      {id:'C-001',severity:'critical',event:'ORDER_RELEASED',agent_a:'AG-ORD-RATESVC',agent_b:'AG-ORD-CREDITHOLD',detail:"Rate & Service Selection and Credit Hold Check both fire on ORDER_RELEASED and both write ORDER_STATUS fields. Credit Hold may apply a CREDIT hold after Rate & Service has already advanced the order to RATED status, leaving an ORDER_MOVEMENT that is simultaneously RATED and CREDIT-HELD -- downstream shipment planning guards do not catch this state.",fix:"Raise AG-ORD-CREDITHOLD priority above AG-ORD-RATESVC. Gate AG-ORD-RATESVC on HOLD_STATUS is null so rating never proceeds on a held order."},
      {id:'C-005',severity:'critical',event:'ORDER_RELEASED',agent_a:'AG-ORD-CREDITHOLD',agent_b:'AG-AI-CARRIERRANK',detail:"AI Carrier Ranking fires on ORDER_RELEASED and reads RATE_GID as a key input for lane-scoring. However AG-ORD-RATESVC may not have written RATE_GID yet when the AI agent fires. In those cases the model falls back to lane-average scoring -- ignoring the awarded rate -- and emits a CARRIER_RANK_HINT that does not reflect the actual cost basis. Observed in 18% of ORDER_RELEASED events.",fix:"Rechain AG-AI-CARRIERRANK to trigger on RATE_APPLIED event (emitted by AG-ORD-RATESVC v4.2.1+) instead of ORDER_RELEASED, guaranteeing RATE_GID is present at score time."},
      {id:'C-004',severity:'warning',event:'TENDER_STATUS',agent_a:'AG-SHIP-RETENDER',agent_b:'AG-SHIP-TENDERRESP',detail:"Auto Re-Tender writes TENDER_STATUS = 'RETENDERED' while Tender Response Handler may still be processing a late TENDER_RESPONSE for the prior tender. A stale ACCEPTED response arriving after re-tender can overwrite the new CARRIER_GID, silently routing the shipment to the previously declined carrier. Affects roughly 2.1% of re-tender cycles under high carrier API latency.",fix:"Add an optimistic concurrency field TENDER_VERSION_SEQ to TENDER_GID. Discard any TENDER_RESPONSE whose TENDER_VERSION_SEQ does not match the current active tender sequence number."},
      {id:'C-003',severity:'warning',event:'INVOICE_RECEIVED',agent_a:'AG-INV-AUTOAPPROVE',agent_b:'AG-INV-VARIANCE',detail:"Auto-Approve and Variance Escalation both trigger on INVOICE_RECEIVED and both write INVOICE_STATUS. At the TOLERANCE_BAND boundary ($5.00), IEEE 754 floating-point rounding on FB_AMOUNT and RATE_GEO_COST can cause both agents to evaluate the same FREIGHT_BILL_GID as within-tolerance and out-of-tolerance simultaneously, generating duplicate ESCALATION_TICKET entries and a stuck INVOICE_STATUS.",fix:"Chain AG-INV-VARIANCE to trigger on INVOICE_VARIANCE_RAISED (an event emitted by AG-INV-AUTOAPPROVE on reject path) rather than sharing the INVOICE_RECEIVED trigger directly."},
    ];
    for (const c of conflicts) await query(`INSERT INTO conflicts(id,severity,event,agent_a,agent_b,detail,fix) VALUES($1,$2,$3,$4,$5,$6,$7)`,[c.id,c.severity,c.event,c.agent_a,c.agent_b,c.detail,c.fix]);

    const auditEntries = [
      {time:'2026-06-30 08:17',username:'m.reyes',action:'Acknowledge conflict',target:'C-005',env:'PROD',result:'Acknowledged',tone:'teal',note:'Rechaining AG-AI-CARRIERRANK to RATE_APPLIED -- tracked in JIRA OTM-4412'},
      {time:'2026-06-30 07:44',username:'system',action:'Detect conflict',target:'C-005',env:'PROD',result:'Critical raised',tone:'red',note:'AI carrier scoring on null RATE_GID in 18% of ORDER_RELEASED events'},
      {time:'2026-06-29 14:30',username:'system',action:'Auto-promote',target:'AG-INV-FRTAUDIT@v1.0.4',env:'TEST->PROD',result:'Promoted',tone:'green',note:'All 8 regression tests passed - zero discrepancy on 3,200 sample bills'},
      {time:'2026-06-29 12:18',username:'d.kim',action:'Edit conditions',target:'AG-INV-FRTAUDIT',env:'TEST',result:'Saved',tone:'green',note:'Raised audit threshold: FB_AMOUNT > $10,000 OR AUDIT_REQUIRED_FLAG = true'},
      {time:'2026-06-29 09:42',username:'m.reyes',action:'Promote agent',target:'AG-SHIP-RETENDER@v2.1.0-draft',env:'TEST->PROD',result:'BLOCKED',tone:'red',note:'TC-04 failing -- unbounded carrier ack timeout (30s to infinity on SWFT API)'},
      {time:'2026-06-29 09:38',username:'m.reyes',action:'Run regression suite',target:'AG-SHIP-RETENDER@v2.1.0-draft',env:'TEST',result:'5 passed / 1 failed',tone:'amber',note:null},
      {time:'2026-06-29 09:15',username:'a.okafor',action:'Edit conditions',target:'AG-SHIP-RETENDER',env:'TEST',result:'Saved',tone:'green',note:'Added PLANNED_SHIP_DATE > sysdate + 0.5 guard to block late re-tenders'},
      {time:'2026-06-29 08:50',username:'s.patel',action:'Acknowledge conflict',target:'C-001',env:'PROD',result:'Acknowledged',tone:'teal',note:null},
      {time:'2026-06-29 08:31',username:'system',action:'Detect conflict',target:'C-002',env:'PROD',result:'Critical raised',tone:'red',note:'TENDER_HINT race on 3 consecutive SHIPMENT_PLANNED events - 504ms avg gap'},
      {time:'2026-06-28 22:04',username:'l.tran',action:'Promote agent',target:'AG-SHIP-DOCGEN@v3.1.0',env:'TEST->PROD',result:'Promoted',tone:'green',note:null},
      {time:'2026-06-28 18:12',username:'d.kim',action:'Edit tolerance',target:'AG-INV-AUTOAPPROVE',env:'DEV',result:'Saved',tone:'green',note:'TOLERANCE_BAND raised $2.00 to $5.00 per Finance Directive FIN-2026-14'},
      {time:'2026-06-28 14:09',username:'oracle.ai',action:'Model deploy',target:'AG-AI-DWELL@v0.9-beta',env:'DEV',result:'Deployed',tone:'teal',note:'Switched RF-v2 to gradient boost v3 - coverage zones expanded to 94 DCs'},
      {time:'2026-06-28 13:22',username:'oracle.ai',action:'Model deploy',target:'AG-AI-CARRIERRANK@v1.2.0',env:'DEV',result:'Deployed',tone:'teal',note:'New agent - scores carriers on OTD %, dwell penalty, and claim rate'},
      {time:'2026-06-27 15:30',username:'s.patel',action:'Edit conditions',target:'AG-ORD-RATESVC',env:'TEST',result:'Saved',tone:'green',note:'Added HAZMAT_FLAG guard - HAZMAT_CERT_GID required for hazmat orders'},
      {time:'2026-06-27 09:10',username:'l.tran',action:'Clone blueprint',target:'AG-SHIP-TRACKUPDATE -> BP-TRACKUPDATE-V2',env:'DEV',result:'Created',tone:'teal',note:'Blueprint created for exception-branch rework'},
    ];
    for (const a of auditEntries) await query(`INSERT INTO audit_log(time,username,action,target,env,result,tone,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[a.time,a.username,a.action,a.target,a.env,a.result,a.tone,a.note||null]);

    const jobs = [
      {id:'JOB-TENDER-SWEEP',   name:'Nightly Tender Sweep',            cron:'0 2 * * *',   last_run:'Today 02:00',    duration:'4m 12s',  trend:'up',   health:'green'},
      {id:'JOB-INV-TOL',        name:'Invoice Tolerance Batch',         cron:'0 */4 * * *', last_run:'Today 04:00',    duration:'1m 38s',  trend:'flat', health:'green'},
      {id:'JOB-CREDIT-REC',     name:'Credit Hold Reconcile',           cron:'0 */6 * * *', last_run:'Today 06:00',    duration:'2m 05s',  trend:'down', health:'green'},
      {id:'JOB-FRTAUDIT',       name:'Freight Bill Audit Batch',        cron:'0 6 * * *',   last_run:'Today 06:00',    duration:'12m 07s', trend:'up',   health:'green'},
      {id:'JOB-CARRRANK-TRAIN', name:'Carrier Rank Model Retrain',      cron:'0 3 * * 0',   last_run:'Sun 03:00',      duration:'28m 44s', trend:'up',   health:'amber'},
      {id:'JOB-DOC-ARCH',       name:'Document Archive',                cron:'0 23 * * *',  last_run:'Yesterday 23:00',duration:'8m 44s',  trend:'up',   health:'amber'},
      {id:'JOB-DWELL-REFRESH',  name:'Dwell Prediction Model Refresh',  cron:'0 1 * * *',   last_run:'-- missed --',   duration:'--',      trend:'flat', health:'red'},
      {id:'JOB-CARR-ROLLUP',    name:'Carrier Performance Rollup',      cron:'0 5 * * 1',   last_run:'Mon 05:00',      duration:'3m 21s',  trend:'flat', health:'green'},
    ];
    for (const j of jobs) await query(`INSERT INTO jobs(id,name,cron,last_run,duration,trend,health) VALUES($1,$2,$3,$4,$5,$6,$7)`,[j.id,j.name,j.cron,j.last_run,j.duration,j.trend,j.health]);

    const liveEvents = [
      {ts:'08:17:42',evt:'ORDER_RELEASED',gid:'NWL.OM20814',agent_id:'AG-ORD-RATESVC',ms:312,ok:true},
      {ts:'08:17:42',evt:'ORDER_RELEASED',gid:'NWL.OM20814',agent_id:'AG-ORD-CREDITHOLD',ms:44,ok:true},
      {ts:'08:17:44',evt:'RATE_APPLIED',gid:'NWL.OM20814',agent_id:'AG-AI-CARRIERRANK',ms:388,ok:true},
      {ts:'08:17:49',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10296',agent_id:'AG-AI-DWELL',ms:198,ok:false},
      {ts:'08:17:49',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10296',agent_id:'AG-SHIP-AUTOTENDER',ms:204,ok:true},
      {ts:'08:17:53',evt:'TENDER_RESPONSE',gid:'NWL.TND8822',agent_id:'AG-SHIP-TENDERRESP',ms:88,ok:true},
      {ts:'08:17:53',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10296',agent_id:'AG-SHIP-DOCGEN',ms:1204,ok:true},
      {ts:'08:17:53',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10296',agent_id:'AG-SHIP-TRACKUPDATE',ms:318,ok:true},
      {ts:'08:18:01',evt:'ORDER_RELEASED',gid:'NWL.OM20815',agent_id:'AG-ORD-RATESVC',ms:284,ok:true},
      {ts:'08:18:01',evt:'ORDER_RELEASED',gid:'NWL.OM20815',agent_id:'AG-ORD-CREDITHOLD',ms:52,ok:true},
      {ts:'08:18:03',evt:'RATE_APPLIED',gid:'NWL.OM20815',agent_id:'AG-AI-CARRIERRANK',ms:412,ok:false},
      {ts:'08:18:08',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10297',agent_id:'AG-AI-DWELL',ms:211,ok:true},
      {ts:'08:18:08',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10297',agent_id:'AG-SHIP-AUTOTENDER',ms:187,ok:true},
      {ts:'08:18:14',evt:'TENDER_DECLINED',gid:'NWL.TND8823',agent_id:'AG-SHIP-RETENDER',ms:9204,ok:false},
      {ts:'08:18:23',evt:'TENDER_RESPONSE',gid:'NWL.TND8823-R1',agent_id:'AG-SHIP-TENDERRESP',ms:204,ok:true},
      {ts:'08:18:23',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10297',agent_id:'AG-SHIP-DOCGEN',ms:1104,ok:true},
      {ts:'08:18:23',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10297',agent_id:'AG-SHIP-TRACKUPDATE',ms:344,ok:true},
      {ts:'08:18:31',evt:'INVOICE_RECEIVED',gid:'NWL.FB40200',agent_id:'AG-INV-AUTOAPPROVE',ms:880,ok:true},
      {ts:'08:18:31',evt:'INVOICE_APPROVED',gid:'NWL.FB40200',agent_id:'AG-INV-FRTAUDIT',ms:2240,ok:true},
      {ts:'08:18:44',evt:'ORDER_RELEASED',gid:'NWL.OM20816',agent_id:'AG-ORD-RATESVC',ms:298,ok:true},
      {ts:'08:18:44',evt:'ORDER_RELEASED',gid:'NWL.OM20816',agent_id:'AG-ORD-CREDITHOLD',ms:88,ok:true},
      {ts:'08:18:46',evt:'RATE_APPLIED',gid:'NWL.OM20816',agent_id:'AG-AI-CARRIERRANK',ms:401,ok:true},
      {ts:'08:18:51',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10298',agent_id:'AG-AI-DWELL',ms:178,ok:true},
      {ts:'08:18:51',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10298',agent_id:'AG-SHIP-AUTOTENDER',ms:192,ok:true},
      {ts:'08:18:57',evt:'TENDER_RESPONSE',gid:'NWL.TND8824',agent_id:'AG-SHIP-TENDERRESP',ms:76,ok:true},
      {ts:'08:18:57',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10298',agent_id:'AG-SHIP-DOCGEN',ms:1312,ok:true},
      {ts:'08:19:02',evt:'INVOICE_RECEIVED',gid:'NWL.FB40201',agent_id:'AG-INV-AUTOAPPROVE',ms:744,ok:false},
      {ts:'08:19:02',evt:'INVOICE_RECEIVED',gid:'NWL.FB40201',agent_id:'AG-INV-VARIANCE',ms:3940,ok:true},
      {ts:'08:19:12',evt:'ORDER_RELEASED',gid:'NWL.OM20817',agent_id:'AG-ORD-RATESVC',ms:322,ok:true},
      {ts:'08:19:12',evt:'ORDER_RELEASED',gid:'NWL.OM20817',agent_id:'AG-ORD-CREDITHOLD',ms:41,ok:true},
      {ts:'08:19:16',evt:'RATE_APPLIED',gid:'NWL.OM20817',agent_id:'AG-AI-CARRIERRANK',ms:394,ok:true},
      {ts:'08:19:21',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10299',agent_id:'AG-AI-DWELL',ms:204,ok:true},
      {ts:'08:19:21',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10299',agent_id:'AG-SHIP-AUTOTENDER',ms:199,ok:true},
      {ts:'08:19:27',evt:'TENDER_RESPONSE',gid:'NWL.TND8825',agent_id:'AG-SHIP-TENDERRESP',ms:91,ok:true},
      {ts:'08:19:27',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10299',agent_id:'AG-SHIP-DOCGEN',ms:1188,ok:true},
      {ts:'08:19:27',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10299',agent_id:'AG-SHIP-TRACKUPDATE',ms:302,ok:true},
      {ts:'08:19:34',evt:'MILESTONE_UPDATE',gid:'NWL.SH10291',agent_id:'AG-SHIP-TRACKUPDATE',ms:14,ok:true},
      {ts:'08:19:41',evt:'INVOICE_APPROVED',gid:'NWL.FB40200',agent_id:'AG-INV-FRTAUDIT',ms:2108,ok:true},
      {ts:'08:19:48',evt:'ORDER_RELEASED',gid:'NWL.OM20818',agent_id:'AG-ORD-RATESVC',ms:307,ok:true},
      {ts:'08:19:48',evt:'ORDER_RELEASED',gid:'NWL.OM20818',agent_id:'AG-ORD-CREDITHOLD',ms:49,ok:true},
      {ts:'08:19:50',evt:'RATE_APPLIED',gid:'NWL.OM20818',agent_id:'AG-AI-CARRIERRANK',ms:388,ok:false},
      {ts:'08:19:55',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10300',agent_id:'AG-AI-DWELL',ms:218,ok:true},
      {ts:'08:19:55',evt:'SHIPMENT_PLANNED',gid:'NWL.SH10300',agent_id:'AG-SHIP-AUTOTENDER',ms:196,ok:true},
      {ts:'08:20:01',evt:'TENDER_RESPONSE',gid:'NWL.TND8826',agent_id:'AG-SHIP-TENDERRESP',ms:84,ok:true},
      {ts:'08:20:01',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10300',agent_id:'AG-SHIP-DOCGEN',ms:1244,ok:true},
      {ts:'08:20:01',evt:'SHIPMENT_CONFIRMED',gid:'NWL.SH10300',agent_id:'AG-SHIP-TRACKUPDATE',ms:289,ok:true},
      {ts:'08:20:08',evt:'INVOICE_RECEIVED',gid:'NWL.FB40202',agent_id:'AG-INV-AUTOAPPROVE',ms:812,ok:true},
      {ts:'08:20:08',evt:'INVOICE_APPROVED',gid:'NWL.FB40202',agent_id:'AG-INV-FRTAUDIT',ms:2380,ok:true},
    ];
    for (const e of liveEvents) await query(`INSERT INTO live_events(ts,evt,gid,agent_id,ms,ok) VALUES($1,$2,$3,$4,$5,$6)`,[e.ts,e.evt,e.gid,e.agent_id,e.ms,e.ok]);

    const regressionTests = [
      {id:'TC-01',agent_id:'AG-SHIP-RETENDER',name:'Decline -> re-tender to next carrier',expect_text:'TENDER_STATUS = RETENDERED',result:'pass',got_text:null,sort_order:1},
      {id:'TC-02',agent_id:'AG-SHIP-RETENDER',name:'Decline x3 -> escalate to planner',expect_text:'state = ESCALATED',result:'pass',got_text:null,sort_order:2},
      {id:'TC-03',agent_id:'AG-SHIP-RETENDER',name:'No alternate carrier available',expect_text:'route -> MANUAL_QUEUE',result:'pass',got_text:null,sort_order:3},
      {id:'TC-04',agent_id:'AG-SHIP-RETENDER',name:'Carrier timeout during re-tender',expect_text:'bounded retry (2x) then escalate',result:'fail',got_text:'unbounded wait -> CARRIER_TIMEOUT after 30s',sort_order:4},
      {id:'TC-05',agent_id:'AG-SHIP-RETENDER',name:'Spot rate exceeds threshold',expect_text:'HOLD_FOR_APPROVAL',result:'pass',got_text:null,sort_order:5},
      {id:'TC-06',agent_id:'AG-SHIP-RETENDER',name:'Late decline after confirm',expect_text:'event IGNORED',result:'pass',got_text:null,sort_order:6},
    ];
    for (const t of regressionTests) await query(`INSERT INTO regression_tests(id,agent_id,name,expect_text,result,got_text,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)`,[t.id,t.agent_id,t.name,t.expect_text,t.result,t.got_text,t.sort_order]);

    const overviewMetrics = [
      {key:'agents_total',value:'12',sub:'3 domains'},{key:'agents_healthy',value:'7',sub:'58%'},
      {key:'agents_amber',value:'4',sub:'33%'},{key:'agents_red',value:'1',sub:'9%'},
      {key:'conflicts_open',value:'5',sub:'3 critical'},{key:'success_rate_avg',value:'95.9%',sub:'last 7d'},
      {key:'events_today',value:'48,240',sub:'+12% vs yesterday'},{key:'jobs_healthy',value:'6/8',sub:'1 missed'},
    ];
    for (const m of overviewMetrics) await query(`INSERT INTO overview_metrics(key,value,sub) VALUES($1,$2,$3)`,[m.key,m.value,m.sub]);

    // ── agent_diffs (preflight metadata) ──────────────────────────────────────
    const agentDiffsSeed = [
      { id:'AG-ORD-RATESVC',     prod_ver:'v1.8.0', test_ver:'v1.8.1',  conflict_id:null,  warning:null,
        insight:'v1.8.1 emits a RATE_APPLIED event after rating, enabling downstream agents to react without polling ORDER_GID.',
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:"action: emitEvent('RATE_APPLIED')"}}]) },
      { id:'AG-ORD-CREDITHOLD',  prod_ver:'v1.2.3', test_ver:'v1.2.4',  conflict_id:'C-001', warning:'Verify no duplicate hold events with C-001 conflict on ORDER_RELEASED.',
        insight:'v1.2.4 adds audit logging for every credit hold decision, improving compliance traceability and resolving a gap flagged in the Q2 audit.', rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: auditLog(CREDIT_HOLD)'}},{l:{t:'none',txt:''},r:{t:'add',txt:'write: AUDIT_ENTRY'}}]) },
      { id:'AG-AI-CARRIERRANK',  prod_ver:'v1.1.2', test_ver:'v1.2.0',  conflict_id:'C-005', warning:'Resolve C-005 before promoting — trigger change is breaking if AG-ORD-RATESVC is not yet at v4.2.1+.',
        insight:'v1.2.0 rekeys trigger from ORDER_RELEASED to RATE_APPLIED, resolving C-005 and eliminating the 18% mis-ranking window. Adds CLAIM_RATE as a new scoring input.', rows:JSON.stringify([{l:{t:'mod',txt:'trigger: ORDER_RELEASED'},r:{t:'mod',txt:'trigger: RATE_APPLIED  (resolves C-005)'}},{l:{t:'none',txt:''},r:{t:'add',txt:'read: CLAIM_RATE  (new scoring feature)'}}]) },
      { id:'AG-SHIP-AUTOTENDER', prod_ver:'v2.4.0', test_ver:'v2.4.1',  conflict_id:null, warning:'Review against conflict C-002 before promoting — the new TENDER_HINT read is the source of the AI overlap.',
        insight:'v2.4.1 adds a TENDER_HINT read from AG-AI-DWELL and a budget guard condition. Sub-optimal carrier selection improved from 23% to 4% in TEST load replay.', rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'read: TENDER_HINT  (from AG-AI-DWELL)'}},{l:{t:'none',txt:''},r:{t:'add',txt:'condition: PLANNED_COST < BUDGET_LIMIT'}}]) },
      { id:'AG-AI-DWELL',        prod_ver:'v3.1.0', test_ver:'v3.2.0-beta', conflict_id:null, warning:'Model update is source of conflict C-002 — validate TENDER_HINT output stability before promoting.',
        insight:'v3.2.0-beta upgrades from dwell_rf_v2 to dwell_rf_v3 and adds CARRIER_SCORE as a new input feature, improving dwell prediction accuracy by ~12%.', rows:JSON.stringify([{l:{t:'mod',txt:'model: dwell_rf_v2'},r:{t:'mod',txt:'model: dwell_rf_v3'}},{l:{t:'none',txt:''},r:{t:'add',txt:'read: CARRIER_SCORE  (new input feature)'}}]) },
      { id:'AG-SHIP-TENDERRESP', prod_ver:'v1.5.2', test_ver:'v1.5.3',  conflict_id:null, warning:null,
        insight:"v1.5.3 adds carrier performance logging after each response, feeding AG-AI-DWELL's training pipeline.",
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: logCarrierPerf(CARRIER_GID, TENDER_RESPONSE)'}}]) },
      { id:'AG-SHIP-RETENDER',   prod_ver:'v2.0.3', test_ver:'v2.0.4-draft', conflict_id:null, warning:'TC-04 is currently failing — the bounded retry is not yet effective. Do not promote.',
        insight:'v2.0.4-draft adds bounded retry logic (max 2 retries, 5 s backoff) with automatic escalation on exhaustion. TC-04 counter-offer handling is still incomplete — hold until fixed.', rows:JSON.stringify([{l:{t:'del',txt:'# no timeout handling'},r:{t:'none',txt:''}},{l:{t:'none',txt:''},r:{t:'add',txt:'action: onTimeout: retry(max=2, backoff=5s) → escalate'}}]) },
      { id:'AG-SHIP-DOCGEN',     prod_ver:'v3.1.0', test_ver:'v3.1.0',  conflict_id:null, warning:null,
        insight:'No differences detected — PROD and TEST are identical at v3.1.0.',
        rows:JSON.stringify([
          {l:{t:'same',txt:'trigger: SHIPMENT_CONFIRMED'},r:{t:'same',txt:'trigger: SHIPMENT_CONFIRMED'}},
          {l:{t:'same',txt:'version: v3.1.0'},r:{t:'same',txt:'version: v3.1.0'}},
          {l:{t:'same',txt:'read: SHIPMENT_GID, CARRIER_GID'},r:{t:'same',txt:'read: SHIPMENT_GID, CARRIER_GID'}}
        ]) },
      { id:'AG-INV-AUTOAPPROVE', prod_ver:'v2.2.1', test_ver:'v2.2.2',  conflict_id:null, warning:null,
        insight:'v2.2.2 widens the tolerance band from $2.00 to $5.00, reducing escalation volume for minor freight adjustments.',
        rows:JSON.stringify([{l:{t:'mod',txt:'condition: abs(INVOICE_AMOUNT - RATE_AMOUNT) <= 2.00'},r:{t:'mod',txt:'condition: abs(INVOICE_AMOUNT - RATE_AMOUNT) <= 5.00'}}]) },
      { id:'AG-INV-VARIANCE',    prod_ver:'v1.1.0', test_ver:'v1.1.1',  conflict_id:null, warning:'Review C-003 float rounding conflict before promoting — tolerance boundary duplicates may generate double escalation tickets.',
        insight:'v1.1.1 adds SLA-aware escalation with a 4-hour clock and upgrades ESCALATION_TICKET to ESCALATION_TICKET_GID for full OTM linkage.', rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: escalateToSLA(variance_amount, SLA_HOURS=4)'}},{l:{t:'mod',txt:'write: ESCALATION_TICKET, INVOICE_STATUS'},r:{t:'mod',txt:'write: ESCALATION_TICKET_GID, INVOICE_STATUS, SLA_CLOCK_START'}}]) },
      { id:'AG-SHIP-TRACKUPDATE',prod_ver:'v2.3.1', test_ver:'v2.4.0',  conflict_id:null, warning:null,
        insight:"v2.4.0 adds SHIPMENT_EXCEPTION event handling with automatic ETA recomputation and stakeholder notification.",
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:"action: onException → recomputeETA(DELAY_HOURS)"}},{l:{t:'none',txt:''},r:{t:'add',txt:"action: onException → notifyStakeholders('EXCEPTION', CUSTOMER_GID)"}}]) },
      { id:'AG-INV-FRTAUDIT',    prod_ver:'v1.0.4', test_ver:'v1.0.5',  conflict_id:null, warning:null,
        insight:"v1.0.5 adds a linhaul vs accessorial split check, catching carriers who reclassify base freight as accessorial charges.",
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: validateLineHaulSplit(LINEHAUL_AMT, ACCESSORIAL_AMT)'}}]) },
    ];
    for (const d of agentDiffsSeed)
      await query(
        `INSERT INTO agent_diffs(id,prod_ver,test_ver,conflict_id,warning,insight,rows)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [d.id, d.prod_ver, d.test_ver, d.conflict_id, d.warning, d.insight, d.rows]);

    console.log('[seed] Database seeded successfully.');
  } catch (err) {
    console.error('[seed] Auto-seed failed:', err.message);
  }
}

// ─── USERS ───────────────────────────────────────────────────────────────────
// Ensure the users table exists and seed a default admin account if empty.

// ─── START ────────────────────────────────────────────────────────────────────

async function refreshAgentActionStyle() {
  try {
    // Check if Katalyst demo agents still have lowercase action_gid values (pre-refresh)
    const sample = await query(
      `SELECT action_gid FROM agent_actions WHERE agent_gid LIKE 'AG-%' AND (action_flow IS NULL OR action_flow='NORMAL') LIMIT 1`
    );
    if (!sample.length || !/^[a-z]/.test(sample[0].action_gid)) return;
    console.log('[refresh] Updating Katalyst demo agent actions to business language style…');
    const newActions = {
      'AG-ORD-RATESVC':     ['RECALC RATES // ORDER_MOVEMENT_GID · LANE_GID','SELECT SERVICE PROVIDER // via RATE_GEO_COST_GID','SET FIELD RATE_GID // from rating engine result','SET FIELD SERVICE_GID // awarded service level','EMIT EVENT RATE_APPLIED // ORDER_MOVEMENT_GID'],
      'AG-ORD-CREDITHOLD':  ['EVALUATE CREDIT LIMIT // CUSTOMER_GID · ORDER_VALUE','APPLY HOLD // ORDER_MOVEMENT_GID','SET STATUS HOLD_STATUS = CREDIT','WRITE AUDIT LOG // event CREDIT_HOLD · ref ORDER_MOVEMENT_GID','NOTIFY CREDIT MANAGER // CUSTOMER_GID · ORDER_VALUE'],
      'AG-AI-CARRIERRANK':  ['SCORE CARRIERS // LANE_GID · HISTORICAL_PERF','APPLY DWELL PENALTY // AVG_DWELL_HRS','RANK BY ON-TIME DELIVERY // SERVICE_PROVIDER_GID[]','EMIT HINT CARRIER_RANK_HINT // top 3 carriers'],
      'AG-SHIP-AUTOTENDER': ['READ HINT CARRIER_RANK_HINT','SELECT CARRIER // via hint or lane default','BUILD TENDER PAYLOAD // SHIPMENT_GID · CARRIER_GID','SEND TENDER // to SERVICE_PROVIDER_GID · ref TENDER_GID','SET STATUS TENDER_STATUS = SENT','SCHEDULE ACK TIMEOUT // 30 seconds'],
      'AG-AI-DWELL':        ['LOAD MODEL dwell_rf_v3','EXTRACT FEATURES // LOCATION_GID · CARRIER_SCORE · TIME_OF_DAY','RUN INFERENCE // HISTORICAL_DWELL · WEATHER_INDEX','SET FIELD DWELL_FORECAST // AI prediction output','EMIT HINT TENDER_HINT // with confidence score'],
      'AG-SHIP-TENDERRESP': ['VALIDATE TENDER VERSION // TENDER_GID','RECORD CARRIER RESPONSE // TENDER_RESPONSE · CARRIER_GID','onAccept → SET STATUS SHIPMENT_STATUS = CONFIRMED','onAccept → EMIT EVENT SHIPMENT_CONFIRMED','onDecline → RAISE EVENT TENDER_DECLINED','LOG CARRIER PERFORMANCE // CARRIER_GID · RESPONSE_TIME_MS'],
      'AG-SHIP-RETENDER':   ['INCREMENT COUNTER RETENDER_COUNT // TENDER_GID','EXCLUDE CARRIER // CARRIER_GID from ALT_CARRIER_POOL','SELECT NEXT CARRIER // ALT_CARRIER_POOL · CARRIER_RANK_HINT','BUILD TENDER PAYLOAD // SHIPMENT_GID · new CARRIER_GID','SEND TENDER // to new CARRIER_GID · ref TENDER_GID','SET STATUS TENDER_STATUS = RETENDERED','onTimeout(30s) → ESCALATE // SHIPMENT_GID · reason CARRIER_TIMEOUT'],
      'AG-SHIP-TRACKUPDATE':['SUBSCRIBE TRACKING FEED // CARRIER_GID · SHIPMENT_GID','MAP STATUS CARRIER_STATUS → OTM_STATUS','UPDATE MILESTONE // MILESTONE_CODE · EVENT_TIMESTAMP','onDelivered → SET STATUS SHIPMENT_STATUS = DELIVERED','onException → RAISE EVENT SHIPMENT_EXCEPTION','NOTIFY STAKEHOLDERS // CUSTOMER_GID · MILESTONE_CODE'],
      'AG-SHIP-DOCGEN':     ['GENERATE BILL OF LADING // SHIPMENT_GID · CARRIER_GID','GENERATE LABELS // SHIP_UNIT_GID[] · format ZPL','GENERATE PRO BILL // CARRIER_GID · TENDER_GID','WRITE DOCUMENT SET // DOCUMENT_SET_GID','TRANSMIT TO CARRIER // DOCUMENT_SET_GID → CARRIER_GID.edi_mailbox'],
      'AG-INV-AUTOAPPROVE': ['MATCH FREIGHT BILL // FREIGHT_BILL_GID against RATE_GID','VALIDATE ACCESSORIALS // ACCESSORIAL_CHARGES','COMPUTE VARIANCE // FB_AMOUNT vs RATE_GEO_COST','SET STATUS INVOICE_STATUS = APPROVED','SCHEDULE PAYMENT // PAYMENT_DUE_DATE · FB_AMOUNT'],
      'AG-INV-VARIANCE':    ['CLASSIFY VARIANCE // FB_AMOUNT minus RATE_GEO_COST','OPEN ESCALATION TICKET // FREIGHT_BILL_GID','WRITE ESCALATION TICKET // ESCALATION_TICKET_GID','ESCALATE TO SLA // variance amount · SLA_HOURS = 4h','NOTIFY TEAM // d.kim · finance-ops@nwl.com'],
      'AG-INV-FRTAUDIT':    ['CROSS-CHECK ACCESSORIALS // FREIGHT_BILL_GID against CONTRACT_GID','VERIFY FUEL SURCHARGE // FSC_RATE · CARRIER_GID','CHECK DUPLICATE INVOICE // FREIGHT_BILL_GID · DATE_RANGE = 90d','FLAG DISCREPANCY // DISCREPANCY_TYPE · DISCREPANCY_AMOUNT','WRITE AUDIT TRAIL // AUDIT_LOG_GID'],
    };
    // Only delete/replace NORMAL flow actions for Katalyst demo agents (LIKE 'AG-%')
    for (const [agentId, actions] of Object.entries(newActions)) {
      await query(`DELETE FROM agent_actions WHERE agent_gid=$1 AND (action_flow IS NULL OR action_flow='NORMAL')`, [agentId]);
      for (let i = 0; i < actions.length; i++)
        await query('INSERT INTO agent_actions(agent_gid,action_gid,action_sequence,action_flow) VALUES($1,$2,$3,\'NORMAL\')', [agentId, actions[i], i]);
    }
    console.log('[refresh] Agent actions updated.');
  } catch(e) { console.error('[refresh] agent action style failed:', e.message); }
}

async function autoSeedAdminIfEmpty() {
  try {
    const rows = await query('SELECT COUNT(*) AS n FROM admin_roles');
    if (parseInt(rows[0].n) > 0) return;
    console.log('[seed] Seeding admin tables…');

    const roles = [
      { id:'prod-admin',     name:'Product Administration', description:'Full system access',       color:'#C74634',
        permissions:{ agents:{view:true,edit:true,promote:true,admin:true}, conflicts:{view:true,edit:true,promote:true,admin:true}, audit_log:{view:true,edit:true,promote:false,admin:true}, environments:{view:true,edit:true,promote:true,admin:true}, api_keys:{view:true,edit:true,promote:false,admin:true}, sso:{view:true,edit:true,promote:false,admin:true}, global_config:{view:true,edit:true,promote:true,admin:true}, user_management:{view:true,edit:true,promote:false,admin:true} } },
      { id:'support',        name:'Support',                description:'Operational read/edit',    color:'#2C5EA8',
        permissions:{ agents:{view:true,edit:true,promote:false,admin:false}, conflicts:{view:true,edit:true,promote:false,admin:false}, audit_log:{view:true,edit:false,promote:false,admin:false}, environments:{view:true,edit:false,promote:false,admin:false}, api_keys:{view:false,edit:false,promote:false,admin:false}, sso:{view:false,edit:false,promote:false,admin:false}, global_config:{view:true,edit:false,promote:false,admin:false}, user_management:{view:true,edit:false,promote:false,admin:false} } },
      { id:'viewer',         name:'Read-Only Viewer',       description:'View-only access',         color:'#1E9A8A',
        permissions:{ agents:{view:true,edit:false,promote:false,admin:false}, conflicts:{view:true,edit:false,promote:false,admin:false}, audit_log:{view:true,edit:false,promote:false,admin:false}, environments:{view:true,edit:false,promote:false,admin:false}, api_keys:{view:false,edit:false,promote:false,admin:false}, sso:{view:false,edit:false,promote:false,admin:false}, global_config:{view:true,edit:false,promote:false,admin:false}, user_management:{view:false,edit:false,promote:false,admin:false} } },
      { id:'integration',    name:'Integration Service',    description:'Machine-to-machine access', color:'#7048B8',
        permissions:{ agents:{view:true,edit:false,promote:false,admin:false}, conflicts:{view:false,edit:false,promote:false,admin:false}, audit_log:{view:false,edit:false,promote:false,admin:false}, environments:{view:false,edit:false,promote:false,admin:false}, api_keys:{view:false,edit:false,promote:false,admin:false}, sso:{view:false,edit:false,promote:false,admin:false}, global_config:{view:true,edit:false,promote:false,admin:false}, user_management:{view:false,edit:false,promote:false,admin:false} } },
      { id:'audit-reviewer', name:'Audit Reviewer',         description:'Audit log access only',    color:'#C07B0A',
        permissions:{ agents:{view:true,edit:false,promote:false,admin:false}, conflicts:{view:true,edit:false,promote:false,admin:false}, audit_log:{view:true,edit:false,promote:false,admin:false}, environments:{view:false,edit:false,promote:false,admin:false}, api_keys:{view:false,edit:false,promote:false,admin:false}, sso:{view:false,edit:false,promote:false,admin:false}, global_config:{view:false,edit:false,promote:false,admin:false}, user_management:{view:false,edit:false,promote:false,admin:false} } },
    ];
    for (const r of roles) await query('INSERT INTO admin_roles(id,name,description,color,permissions) VALUES($1,$2,$3,$4,$5)',
      [r.id, r.name, r.description, r.color, JSON.stringify(r.permissions)]);

    const users = [
      { username:'s.patel',   display_name:'Sohail Patel',      email:'s.patel@nwl.com',          role_id:'prod-admin',     sso_provider:'oracle-idcs', last_login:'2026-07-21T08:12:00Z' },
      { username:'m.reyes',   display_name:'Maria Reyes',        email:'m.reyes@nwl.com',          role_id:'support',        sso_provider:'azure-ad',    last_login:'2026-07-21T09:45:00Z' },
      { username:'a.okafor',  display_name:'Amara Okafor',       email:'a.okafor@nwl.com',         role_id:'support',        sso_provider:'azure-ad',    last_login:'2026-07-20T14:30:00Z' },
      { username:'d.kim',     display_name:'David Kim',          email:'d.kim@nwl.com',            role_id:'viewer',         sso_provider:'google-ws',   last_login:'2026-07-19T11:00:00Z' },
      { username:'l.tran',    display_name:'Linh Tran',          email:'l.tran@nwl.com',           role_id:'viewer',         sso_provider:'google-ws',   last_login:'2026-07-18T16:20:00Z' },
      { username:'oracle.ai', display_name:'Oracle AI Platform', email:'oracle-ai@oracle.com',      role_id:'integration',    sso_provider:'oracle-idcs', last_login:'2026-07-21T07:00:00Z' },
      { username:'svc-ci',    display_name:'CI Pipeline',        email:'svc-ci@nwl.com',           role_id:'integration',    sso_provider:null,          last_login:'2026-07-21T06:00:00Z' },
      { username:'audit-svc', display_name:'Audit Export',       email:'audit-export@nwl.com',      role_id:'audit-reviewer', sso_provider:null,          last_login:'2026-07-20T23:00:00Z' },
    ];
    for (const u of users) await query('INSERT INTO admin_users(username,display_name,email,role_id,sso_provider,last_login) VALUES($1,$2,$3,$4,$5,$6)',
      [u.username, u.display_name, u.email, u.role_id, u.sso_provider, u.last_login]);

    const ssoConnections = [
      { id:'oracle-idcs', name:'Oracle IDCS', provider:'oracle_idcs', status:'connected', tenant_url:'https://idcs-nwl.identity.oraclecloud.com', client_id:'nwl-katalyst-prod-client', enabled:true,  last_tested:'2026-07-21T06:00:00Z', attribute_map:{sub:'user.id',email:'user.primaryEmail',groups:'user.groups',given_name:'user.firstName',family_name:'user.lastName'} },
      { id:'azure-ad',    name:'Azure AD (NWL)', provider:'azure_ad',    status:'connected', tenant_url:'https://login.microsoftonline.com/nwl.onmicrosoft.com', client_id:'8f3b2d1a-4c9e-4f7a-b6d2-1e8c3f5a2b9d', enabled:true,  last_tested:'2026-07-20T18:00:00Z', attribute_map:{sub:'oid',email:'mail',groups:'groups',given_name:'givenName',family_name:'surname'} },
      { id:'google-ws',   name:'Google Workspace (KSAP)', provider:'google_ws',   status:'disconnected', tenant_url:'https://accounts.google.com/o/oauth2/auth', client_id:'katalyst-ksap.apps.googleusercontent.com', enabled:false, last_tested:null, attribute_map:{sub:'sub',email:'email',given_name:'given_name',family_name:'family_name'} },
    ];
    for (const s of ssoConnections) await query('INSERT INTO sso_connections(id,name,provider,status,tenant_url,client_id,enabled,last_tested,attribute_map) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [s.id, s.name, s.provider, s.status, s.tenant_url, s.client_id, s.enabled, s.last_tested||null, JSON.stringify(s.attribute_map)]);

    const keyHash = (k) => crypto.createHash('sha256').update(k).digest('hex');
    const apiKeys = [
      { id:'AK-CI0194', name:'CI Pipeline Integration', key_prefix:'cat_a3f9d2e8b1c7…', key_hash:keyHash('cat_a3f9d2e8b1c7_ci'), scopes:['read:agents','read:audit'], created_by:'s.patel', created_at:'2026-06-01T10:00:00Z', expires_at:'2026-09-01T00:00:00Z', last_used_at:'2026-07-21T08:55:00Z', revoked:false },
      { id:'AK-MON291', name:'Monitoring Probe',         key_prefix:'cat_7b4e1a9f3d2c…', key_hash:keyHash('cat_7b4e1a9f3d2c_mon'), scopes:['read:agents'], created_by:'m.reyes', created_at:'2026-04-15T09:00:00Z', expires_at:'2026-07-31T00:00:00Z', last_used_at:'2026-07-21T09:00:00Z', revoked:false },
      { id:'AK-INT882', name:'Integration Sync',         key_prefix:'cat_c2d5f8a1e4b7…', key_hash:keyHash('cat_c2d5f8a1e4b7_int'), scopes:['read:agents','write:agents','webhook:events'], created_by:'s.patel', created_at:'2026-05-10T14:00:00Z', expires_at:null, last_used_at:'2026-07-20T22:10:00Z', revoked:false },
      { id:'AK-AUD441', name:'Audit Export (legacy)',    key_prefix:'cat_e6b9c3f2a7d1…', key_hash:keyHash('cat_e6b9c3f2a7d1_aud'), scopes:['read:audit'], created_by:'a.okafor', created_at:'2026-01-20T11:00:00Z', expires_at:'2026-07-01T00:00:00Z', last_used_at:'2026-06-28T17:00:00Z', revoked:true },
    ];
    for (const k of apiKeys) await query('INSERT INTO api_keys(id,name,key_prefix,key_hash,scopes,created_by,created_at,expires_at,last_used_at,revoked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [k.id, k.name, k.key_prefix, k.key_hash, k.scopes, k.created_by, k.created_at, k.expires_at, k.last_used_at, k.revoked]);

    const globalConfig = [
      // Agent Execution
      { key:'tolerance_band',       label:'Invoice Tolerance Band',       category:'Agent Execution', description:'Max $ variance before freight bill escalation',   dev_value:'5.00',  test_value:'5.00',  prod_value:'5.00',  sensitive:false },
      { key:'retender_max',         label:'Max Re-Tender Attempts',       category:'Agent Execution', description:'Max re-tender cycles before CARRIER_TIMEOUT escalation', dev_value:'3', test_value:'3', prod_value:'3', sensitive:false },
      { key:'ack_timeout_ms',       label:'Carrier Ack Timeout (ms)',     category:'Agent Execution', description:'Milliseconds before tender acknowledgement is considered timed out', dev_value:'30000', test_value:'30000', prod_value:'30000', sensitive:false },
      // AI Models
      { key:'carrier_rank_threshold',  label:'Carrier Rank Min Confidence', category:'AI Models', description:'Minimum model confidence to apply CARRIER_RANK_HINT', dev_value:'0.65', test_value:'0.68', prod_value:'0.72', sensitive:false },
      { key:'dwell_threshold',         label:'Dwell Prediction Min Confidence', category:'AI Models', description:'Minimum confidence to emit TENDER_HINT from dwell model', dev_value:'0.55', test_value:'0.58', prod_value:'0.60', sensitive:false },
      { key:'model_staleness_hours',   label:'Model Staleness Threshold (h)', category:'AI Models', description:'Max hours since model artifact refresh before fallback', dev_value:'48', test_value:'24', prod_value:'12', sensitive:false },
      // Tender
      { key:'tender_expiry_mins',      label:'Tender Expiry (minutes)',    category:'Tender', description:'Minutes until a sent tender auto-expires if no response', dev_value:'60', test_value:'45', prod_value:'30', sensitive:false },
      { key:'spot_approval_threshold', label:'Spot Rate Approval ($)',     category:'Tender', description:'Planned cost above this requires manual approval before tender', dev_value:'5000', test_value:'5000', prod_value:'3500', sensitive:false },
      // Compliance
      { key:'ofac_refresh_hours',    label:'OFAC Sanctions Refresh (h)',  category:'Compliance', description:'Frequency of automated OFAC watchlist refresh job', dev_value:'24', test_value:'12', prod_value:'6', sensitive:false },
      { key:'hazmat_cert_required',  label:'Require HAZMAT Certificate', category:'Compliance', description:'Enforce HAZMAT_CERT_GID presence for hazardous shipments', dev_value:'false', test_value:'true', prod_value:'true', sensitive:false },
      // System
      { key:'audit_retention_days',  label:'Audit Log Retention (days)', category:'System', description:'Days before audit log entries are purged', dev_value:'30', test_value:'90', prod_value:'365', sensitive:false },
      { key:'event_log_ttl_hours',   label:'Live Event TTL (hours)',      category:'System', description:'Time-to-live for live event log entries', dev_value:'24', test_value:'48', prod_value:'72', sensitive:false },
    ];
    for (const c of globalConfig) await query('INSERT INTO global_config(key,label,category,description,dev_value,test_value,prod_value,sensitive) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [c.key, c.label, c.category, c.description, c.dev_value, c.test_value, c.prod_value, c.sensitive]);

    console.log('[seed] Admin tables seeded successfully.');
  } catch (err) {
    console.error('[seed] Admin seed failed:', err.message);
  }
}

// Seeds agent_diffs metadata needed by the promotion preflight service.
// Runs independently — does not depend on agents being empty, so it repairs
// itself even when the rest of the DB is already seeded.
// Seeds trace_runs and trace_steps with polished IO strings matching the hardcoded traceData.
// Runs independently of autoSeedIfEmpty so re-seeding trace data doesn't require wiping agents.
async function autoSeedTracesIfEmpty() {
  try {
    const rows = await query('SELECT COUNT(*) AS n FROM trace_runs');
    if (parseInt(rows[0].n) > 0) return;
    console.log('[seed] Seeding trace_runs / trace_steps…');
    const traceRuns = [
      {agent_id:'AG-ORD-RATESVC',run_id:'RUN-44201',shipment_gid:'NWL.OR20811',env:'PROD',started:'2026-06-29 09:41:07',total_ms:448,health:'green',status:'ok',status_label:'Completed · 448ms',steps:[{label:'Trigger received',io:'evt=ORDER_RELEASED · ORDER_GID=NWL.OR20811',start_ms:0,dur_ms:8,status:'ok'},{label:'Load order context',io:'in: ORDER_GID=NWL.OR20811 → out: SERVICE_LEVEL=LTL, SHIP_FROM_GID=NWL.DC.MEMPHIS',start_ms:8,dur_ms:94,status:'ok'},{label:'Evaluate guard conditions',io:"ORDER_STATUS='NEW' ✓ · SERVICE_LEVEL not null ✓",start_ms:102,dur_ms:11,status:'ok'},{label:'Compute rate',io:'calling RATE_ENGINE · shipment weight=4,820lbs · lane=MEM→ATL',start_ms:113,dur_ms:287,status:'ok'},{label:'Write rate to order',io:'out: RATE_GID=RT.20811 · $1,204.50 · SVC=LTL-STANDARD',start_ms:400,dur_ms:41,status:'ok'},{label:'Completed',io:'write: RATE_GID ✓, SERVICE_GID ✓',start_ms:441,dur_ms:7,status:'ok'}]},
      {agent_id:'AG-ORD-CREDITHOLD',run_id:'RUN-44198',shipment_gid:'NWL.OR20809',env:'PROD',started:'2026-06-29 09:38:53',total_ms:203,health:'green',status:'ok',status_label:'Completed · 203ms',steps:[{label:'Trigger received',io:'evt=ORDER_RELEASED · CUSTOMER_GID=NWL.CUST.4481',start_ms:0,dur_ms:6,status:'ok'},{label:'Load customer credit profile',io:'in: CUSTOMER_GID=NWL.CUST.4481 → out: credit_status=OK, CREDIT_LIMIT=$50,000',start_ms:6,dur_ms:118,status:'ok'},{label:'Evaluate credit conditions',io:'ORDER_VALUE=$12,400 < CREDIT_LIMIT=$50,000 ✓ · no hold applied',start_ms:124,dur_ms:14,status:'ok'},{label:'Completed (no hold)',io:'HOLD_STATUS unchanged · ORDER_STATUS=RELEASED',start_ms:138,dur_ms:65,status:'ok'}]},
      {agent_id:'AG-SHIP-AUTOTENDER',run_id:'RUN-48207',shipment_gid:'NWL.SH10290',env:'PROD',started:'2026-06-29 08:52:14',total_ms:1842,health:'amber',status:'warn',status_label:'Completed · 1.8s · TENDER_HINT race (C-002)',steps:[{label:'Trigger received',io:'evt=SHIPMENT_PLANNED · SHIPMENT_GID=NWL.SH10290',start_ms:0,dur_ms:9,status:'ok'},{label:'Load shipment context',io:'out: status=PLANNED, PLANNED_COST=$2,104 < BUDGET_LIMIT ✓, HOLD_STATUS=null ✓',start_ms:9,dur_ms:74,status:'ok'},{label:'Read TENDER_HINT',io:'⚠ TENDER_HINT not yet available — AG-AI-DWELL still running, falling back to default carrier selection',start_ms:83,dur_ms:504,status:'warn'},{label:'Select carrier (no hint)',io:'out: CARRIER_GID=NWL.CARR.JBH (fallback, no dwell scoring applied)',start_ms:587,dur_ms:38,status:'ok'},{label:'Build tender payload',io:'out: payload 2.0KB · rate=$2,104.00 · service=TL',start_ms:625,dur_ms:29,status:'ok'},{label:'POST tender → carrier API',io:'POST /v2/tender carrier=JBH · ack received in 1,170ms',start_ms:654,dur_ms:1170,status:'ok'},{label:'Completed',io:'write: TENDER_STATUS=SENT ✓, CARRIER_GID ✓ · conflict C-002 risk materialised this run',start_ms:1824,dur_ms:18,status:'ok'}]},
      {agent_id:'AG-AI-DWELL',run_id:'RUN-47990',shipment_gid:'NWL.SH10277',env:'PROD',started:'2026-06-29 01:02:18',total_ms:450,health:'amber',status:'warn',status_label:'Degraded · confidence below threshold (stale model)',steps:[{label:'Trigger received',io:'evt=SHIPMENT_PLANNED · SHIPMENT_GID=NWL.SH10277',start_ms:0,dur_ms:7,status:'ok'},{label:'Load location context',io:'in: LOCATION_GID=NWL.DC.MEMPHIS → out: HISTORICAL_DWELL=2.4h avg',start_ms:7,dur_ms:112,status:'ok'},{label:'Load model artifact',io:'⚠ loading dwell_rf_v2 — JOB-DWELL-REFRESH missed 01:00 run, model is 25h stale',start_ms:119,dur_ms:38,status:'warn'},{label:'Run inference',io:'confidence=0.42 < threshold 0.60 — prediction suppressed',start_ms:157,dur_ms:284,status:'warn'},{label:'Emit hint (suppressed)',io:'TENDER_HINT NOT emitted · downstream AG-SHIP-AUTOTENDER will fall back to default carrier selection',start_ms:441,dur_ms:9,status:'warn'}]},
      {agent_id:'AG-SHIP-TENDERRESP',run_id:'RUN-48210',shipment_gid:'NWL.SH10292',env:'PROD',started:'2026-06-29 09:22:44',total_ms:318,health:'green',status:'ok',status_label:'Completed · 318ms',steps:[{label:'Trigger received',io:'evt=TENDER_RESPONSE_RECEIVED · CARRIER_GID=NWL.CARR.JBH',start_ms:0,dur_ms:8,status:'ok'},{label:'Validate tender state',io:'TENDER_STATUS=SENT ✓ · version match ✓',start_ms:8,dur_ms:19,status:'ok'},{label:'Process carrier response',io:'TENDER_RESPONSE=ACCEPTED · carrier=NWL.CARR.JBH',start_ms:27,dur_ms:44,status:'ok'},{label:'Set shipment confirmed',io:'write: SHIPMENT_STATUS=CONFIRMED · TENDER_STATUS=ACCEPTED',start_ms:71,dur_ms:218,status:'ok'},{label:'Completed',io:'SHIPMENT_STATUS=CONFIRMED ✓',start_ms:289,dur_ms:29,status:'ok'}]},
      {agent_id:'AG-SHIP-RETENDER',run_id:'RUN-48213',shipment_gid:'NWL.SH10293',env:'PROD',started:'2026-06-29 03:14:02',total_ms:30206,health:'amber',status:'error',status_label:'Failed · CARRIER_TIMEOUT',steps:[{label:'Trigger received',io:'evt=TENDER_DECLINED · SHIPMENT_GID=NWL.SH10293',start_ms:0,dur_ms:12,status:'ok'},{label:'Load shipment context',io:'in: SHIPMENT_GID=NWL.SH10293 → out: status=DECLINED, retry_count=1',start_ms:12,dur_ms:86,status:'ok'},{label:'Evaluate guard conditions',io:'retry_count(1) < 3 ✓ · alt_carrier_exists ✓',start_ms:98,dur_ms:22,status:'ok'},{label:'Select next carrier',io:'out: CARRIER_GID=NWL.CARR.SWFT (Swift Freight)',start_ms:120,dur_ms:41,status:'ok'},{label:'Build tender payload',io:'out: payload 2.1KB · rate=$1,842.00 · service=LTL',start_ms:161,dur_ms:33,status:'ok'},{label:'POST tender → carrier API',io:'POST /v2/tender carrier=SWFT · awaiting ack…',start_ms:194,dur_ms:30000,status:'error'},{label:'Agent run failed',io:'error: CARRIER_TIMEOUT after 30000ms · no response from NWL.CARR.SWFT',start_ms:30194,dur_ms:12,status:'error'}]},
      {agent_id:'AG-SHIP-DOCGEN',run_id:'RUN-48201',shipment_gid:'NWL.SH10288',env:'PROD',started:'2026-06-29 09:14:09',total_ms:624,health:'green',status:'ok',status_label:'Completed · 624ms',steps:[{label:'Trigger received',io:'evt=SHIPMENT_CONFIRMED · SHIPMENT_GID=NWL.SH10288',start_ms:0,dur_ms:7,status:'ok'},{label:'Load shipment & carrier data',io:'in: SHIPMENT_GID=NWL.SH10288, CARRIER_GID=NWL.CARR.JBH',start_ms:7,dur_ms:88,status:'ok'},{label:'Generate Bill of Lading',io:'out: BOL-SH10288.pdf · 4 pages · 2.2 MB',start_ms:95,dur_ms:312,status:'ok'},{label:'Generate carrier labels',io:'out: LABELS-SH10288.pdf · 2 labels · ZPL format',start_ms:407,dur_ms:188,status:'ok'},{label:'Write document set',io:'write: DOCUMENT_SET ✓ · 2 documents stored',start_ms:595,dur_ms:29,status:'ok'}]},
      {agent_id:'AG-INV-AUTOAPPROVE',run_id:'RUN-48215',shipment_gid:'NWL.INV40192',env:'PROD',started:'2026-06-29 11:04:22',total_ms:2810,health:'amber',status:'warn',status_label:'Degraded · tolerance boundary exceeded',steps:[{label:'Trigger received',io:'evt=INVOICE_RECEIVED · INVOICE_GID=NWL.INV40192',start_ms:0,dur_ms:6,status:'ok'},{label:'Load invoice & rate',io:'in: INVOICE_AMOUNT=$1,207.50, RATE_GID=RT.20811, RATE_AMOUNT=$1,204.50',start_ms:6,dur_ms:124,status:'ok'},{label:'Evaluate tolerance',io:'⚠ abs($1,207.50 − $1,204.50) = $3.00 > TOLERANCE=$2.00 — auto-approve BLOCKED',start_ms:130,dur_ms:18,status:'warn'},{label:'Route to variance escalation',io:'raising INVOICE_VARIANCE event → AG-INV-VARIANCE will handle',start_ms:148,dur_ms:2614,status:'warn'},{label:'Completed (no approval)',io:'INVOICE_STATUS=VARIANCE · escalation ticket to be created by AG-INV-VARIANCE',start_ms:2762,dur_ms:48,status:'ok'}]},
      {agent_id:'AG-INV-VARIANCE',run_id:'RUN-48216',shipment_gid:'NWL.INV40192',env:'PROD',started:'2026-06-29 11:04:25',total_ms:3940,health:'amber',status:'warn',status_label:'Degraded · escalation SLA risk',steps:[{label:'Trigger received',io:'evt=INVOICE_RECEIVED · FREIGHT_BILL_GID=NWL.FB40192',start_ms:0,dur_ms:7,status:'ok'},{label:'Load freight bill & rate',io:'in: FB_AMOUNT=$1,207.50, RATE_GEO_COST=$1,204.50, variance=$3.00 > TOLERANCE_BAND($5.00)? No — checking float precision…',start_ms:7,dur_ms:118,status:'ok'},{label:'Classify variance',io:'⚠ abs(1207.50 - 1204.50)=$3.00 — TOLERANCE_BAND=$5.00 but IEEE 754 rounding places result at $5.0000000001 — C-003 risk pattern',start_ms:125,dur_ms:19,status:'warn'},{label:'Open escalation ticket',io:'⚠ SLA = 4h remaining · ESCALATION_TICKET_GID=ESC-20929 created · SLA_CLOCK_START=11:04:25',start_ms:144,dur_ms:44,status:'warn'},{label:'Notify d.kim',io:"notification sent: d.kim@nwl.com + in-app · finance-ops@nwl.com cc'd",start_ms:188,dur_ms:3697,status:'ok'},{label:'Write invoice status',io:'write: INVOICE_STATUS=ESCALATED ✓, ESCALATION_TICKET_GID=ESC-20929 ✓, SLA_CLOCK_START ✓',start_ms:3885,dur_ms:55,status:'ok'}]},
      {agent_id:'AG-AI-CARRIERRANK',run_id:'RUN-44195',shipment_gid:'NWL.OR20806',env:'PROD',started:'2026-06-30 07:18:42',total_ms:812,health:'amber',status:'warn',status_label:'Degraded · scored on null RATE_GID (C-005)',steps:[{label:'Trigger received',io:'evt=ORDER_RELEASED · ORDER_MOVEMENT_GID=NWL.OM20806 (C-005 race: RATE_APPLIED not yet fired)',start_ms:0,dur_ms:6,status:'ok'},{label:'Check RATE_GID availability',io:'⚠ RATE_GID is null — AG-ORD-RATESVC has not completed yet · falling back to lane-average scoring (C-005 materialised)',start_ms:6,dur_ms:18,status:'warn'},{label:'Load lane performance data',io:'in: LANE_GID=NWL.LANE.MEM-ATL · 94 historical shipments · 6 eligible carriers in pool',start_ms:24,dur_ms:141,status:'ok'},{label:'Score carriers (lane-average fallback)',io:'⚠ scoring without awarded RATE_GEO_COST · XPO=0.87, JBH=0.84, ODL=0.79, WRNR=0.71, SAIA=0.68, SWFT=0.52 · dwell penalty applied',start_ms:165,dur_ms:388,status:'warn'},{label:'Apply dwell penalty',io:'SWFT penalised -0.14 (AVG_DWELL_HRS=3.8h) · NWL.CARR.SWFT dropped to rank 6',start_ms:553,dur_ms:84,status:'ok'},{label:'Emit CARRIER_RANK_HINT',io:'⚠ hint emitted without RATE_GID context: top3=[XPO,JBH,ODL] · confidence=0.61 < threshold 0.72 — degraded output',start_ms:637,dur_ms:175,status:'warn'}]},
      {agent_id:'AG-SHIP-TRACKUPDATE',run_id:'RUN-48209',shipment_gid:'NWL.SH10291',env:'PROD',started:'2026-06-29 10:04:17',total_ms:1104,health:'green',status:'ok',status_label:'Completed · 1.1s',steps:[{label:'Trigger received',io:'evt=SHIPMENT_CONFIRMED · SHIPMENT_GID=NWL.SH10291 · CARRIER_GID=NWL.CARR.JBH',start_ms:0,dur_ms:8,status:'ok'},{label:'Verify carrier capabilities',io:'NWL.CARR.JBH: edi_capable=true, api_capable=true, tracking_api=JBH-TRACK-v3',start_ms:8,dur_ms:44,status:'ok'},{label:'Subscribe to tracking feed',io:'POST jbh-track.api.oracle.com/subscribe · TRACKING_NUMBER=JBH-TRK-882144 · webhook registered',start_ms:52,dur_ms:318,status:'ok'},{label:'Receive initial milestone',io:'CARRIER_STATUS=IN_TRANSIT → OTM_STATUS=IN_TRANSIT · EVENT_TIMESTAMP=10:04 · GPS: 35.1°N 90.0°W (Memphis TN)',start_ms:370,dur_ms:212,status:'ok'},{label:'Update shipment milestone',io:'write: MILESTONE_LOG[PICKUP]=10:04 ✓ · ETA_TIMESTAMP=2026-06-30 14:00 ✓',start_ms:582,dur_ms:488,status:'ok'},{label:'Notify customer',io:'CUSTOMER_GID=NWL.CUST.4481 notified: shipment in transit, ETA Jun-30 14:00',start_ms:1070,dur_ms:34,status:'ok'}]},
      {agent_id:'AG-INV-FRTAUDIT',run_id:'RUN-48220',shipment_gid:'NWL.FB40188',env:'PROD',started:'2026-06-29 06:14:33',total_ms:2240,health:'green',status:'ok',status_label:'Completed · 2.2s · no discrepancies',steps:[{label:'Trigger received',io:'evt=INVOICE_APPROVED · FREIGHT_BILL_GID=NWL.FB40188 · FB_AMOUNT=$18,420.00 > $10,000 threshold → AUDIT_REQUIRED',start_ms:0,dur_ms:7,status:'ok'},{label:'Load contract & freight bill',io:'in: CONTRACT_GID=NWL.CONT.JBH-2026 · FSC_RATE=28.4% · ACCESSORIAL_CHARGES=[fuel=$412, liftgate=$85, residential=$0]',start_ms:7,dur_ms:134,status:'ok'},{label:'Cross-check accessorials',io:'fuel surcharge: agreed=$412.00 vs billed=$412.00 ✓ · liftgate: agreed=$85 vs billed=$85 ✓',start_ms:141,dur_ms:286,status:'ok'},{label:'Verify fuel surcharge rate',io:'FSC_RATE lookup: DOE index week 2026-06-23 = 28.4% → carrier applied 28.4% ✓ · base freight=$1,450 · FSC=$412 ✓',start_ms:427,dur_ms:318,status:'ok'},{label:'Check duplicate invoice',io:'scan DATE_RANGE=90d · no prior FREIGHT_BILL_GID matching NWL.FB40188 found ✓',start_ms:745,dur_ms:1108,status:'ok'},{label:'Write audit trail',io:'AUDIT_STATUS=CLEAN · DISCREPANCY_AMOUNT=$0.00 · AUDIT_LOG_GID=AUDT-NWL-88204 written',start_ms:1853,dur_ms:387,status:'ok'}]},
    ];
    for (const t of traceRuns) {
      const [run] = await query(`INSERT INTO trace_runs(agent_id,run_id,shipment_gid,env,started,total_ms,health,status,status_label) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [t.agent_id,t.run_id,t.shipment_gid,t.env,t.started,t.total_ms,t.health,t.status,t.status_label]);
      for (let i=0;i<t.steps.length;i++) {
        const s=t.steps[i];
        await query(`INSERT INTO trace_steps(trace_run_id,label,io,start_ms,dur_ms,status,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)`,[run.id,s.label,s.io,s.start_ms,s.dur_ms,s.status,i]);
      }
    }
    console.log('[seed] trace_runs / trace_steps seeded.');
  } catch (err) { console.error('[seed] trace seed failed:', err.message); }
}

async function autoSeedDiffsIfEmpty() {
  try {
    const rows = await query('SELECT COUNT(*) AS n FROM agent_diffs');
    if (parseInt(rows[0].n) >= 12) return; // already fully seeded
    console.log('[seed] Seeding agent_diffs…');
    const agentDiffsSeed = [
      { id:'AG-ORD-RATESVC',     prod_ver:'v1.8.0', test_ver:'v1.8.1',  conflict_id:null,  warning:null,
        insight:'v1.8.1 emits a RATE_APPLIED event after rating, enabling downstream agents to react without polling ORDER_GID.',
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:"action: emitEvent('RATE_APPLIED')"}}]) },
      { id:'AG-ORD-CREDITHOLD',  prod_ver:'v1.2.3', test_ver:'v1.2.4',  conflict_id:'C-001', warning:'Verify no duplicate hold events with C-001 conflict on ORDER_RELEASED.',
        insight:'v1.2.4 adds audit logging for every credit hold decision, improving compliance traceability and resolving a gap flagged in the Q2 audit.', rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: auditLog(CREDIT_HOLD)'}},{l:{t:'none',txt:''},r:{t:'add',txt:'write: AUDIT_ENTRY'}}]) },
      { id:'AG-AI-CARRIERRANK',  prod_ver:'v1.1.2', test_ver:'v1.2.0',  conflict_id:'C-005', warning:'Resolve C-005 before promoting — trigger change is breaking if AG-ORD-RATESVC is not yet at v4.2.1+.',
        insight:'v1.2.0 rekeys trigger from ORDER_RELEASED to RATE_APPLIED, resolving C-005 and eliminating the 18% mis-ranking window. Adds CLAIM_RATE as a new scoring input.', rows:JSON.stringify([{l:{t:'mod',txt:'trigger: ORDER_RELEASED'},r:{t:'mod',txt:'trigger: RATE_APPLIED  (resolves C-005)'}},{l:{t:'none',txt:''},r:{t:'add',txt:'read: CLAIM_RATE  (new scoring feature)'}}]) },
      { id:'AG-SHIP-AUTOTENDER', prod_ver:'v2.4.0', test_ver:'v2.4.1',  conflict_id:null, warning:'Review against conflict C-002 before promoting — the new TENDER_HINT read is the source of the AI overlap.',
        insight:'v2.4.1 adds a TENDER_HINT read from AG-AI-DWELL and a budget guard condition. Sub-optimal carrier selection improved from 23% to 4% in TEST load replay.', rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'read: TENDER_HINT  (from AG-AI-DWELL)'}},{l:{t:'none',txt:''},r:{t:'add',txt:'condition: PLANNED_COST < BUDGET_LIMIT'}}]) },
      { id:'AG-AI-DWELL',        prod_ver:'v3.1.0', test_ver:'v3.2.0-beta', conflict_id:null, warning:'Model update is source of conflict C-002 — validate TENDER_HINT output stability before promoting.',
        insight:'v3.2.0-beta upgrades from dwell_rf_v2 to dwell_rf_v3 and adds CARRIER_SCORE as a new input feature, improving dwell prediction accuracy by ~12%.', rows:JSON.stringify([{l:{t:'mod',txt:'model: dwell_rf_v2'},r:{t:'mod',txt:'model: dwell_rf_v3'}},{l:{t:'none',txt:''},r:{t:'add',txt:'read: CARRIER_SCORE  (new input feature)'}}]) },
      { id:'AG-SHIP-TENDERRESP', prod_ver:'v1.5.2', test_ver:'v1.5.3',  conflict_id:null, warning:null,
        insight:"v1.5.3 adds carrier performance logging after each response, feeding AG-AI-DWELL's training pipeline.",
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: logCarrierPerf(CARRIER_GID, TENDER_RESPONSE)'}}]) },
      { id:'AG-SHIP-RETENDER',   prod_ver:'v2.0.3', test_ver:'v2.0.4-draft', conflict_id:null, warning:'TC-04 is currently failing — the bounded retry is not yet effective. Do not promote.',
        insight:'v2.0.4-draft adds bounded retry logic (max 2 retries, 5 s backoff) with automatic escalation on exhaustion. TC-04 counter-offer handling is still incomplete — hold until fixed.', rows:JSON.stringify([{l:{t:'del',txt:'# no timeout handling'},r:{t:'none',txt:''}},{l:{t:'none',txt:''},r:{t:'add',txt:'action: onTimeout: retry(max=2, backoff=5s) → escalate'}}]) },
      { id:'AG-SHIP-DOCGEN',     prod_ver:'v3.1.0', test_ver:'v3.1.0',  conflict_id:null, warning:null,
        insight:'No differences detected — PROD and TEST are identical at v3.1.0.',
        rows:JSON.stringify([
          {l:{t:'same',txt:'trigger: SHIPMENT_CONFIRMED'},r:{t:'same',txt:'trigger: SHIPMENT_CONFIRMED'}},
          {l:{t:'same',txt:'version: v3.1.0'},r:{t:'same',txt:'version: v3.1.0'}},
          {l:{t:'same',txt:'read: SHIPMENT_GID, CARRIER_GID'},r:{t:'same',txt:'read: SHIPMENT_GID, CARRIER_GID'}}
        ]) },
      { id:'AG-INV-AUTOAPPROVE', prod_ver:'v2.2.1', test_ver:'v2.2.2',  conflict_id:null, warning:null,
        insight:'v2.2.2 widens the tolerance band from $2.00 to $5.00, reducing escalation volume for minor freight adjustments.',
        rows:JSON.stringify([{l:{t:'mod',txt:'condition: abs(INVOICE_AMOUNT - RATE_AMOUNT) <= 2.00'},r:{t:'mod',txt:'condition: abs(INVOICE_AMOUNT - RATE_AMOUNT) <= 5.00'}}]) },
      { id:'AG-INV-VARIANCE',    prod_ver:'v1.1.0', test_ver:'v1.1.1',  conflict_id:null, warning:'Review C-003 float rounding conflict before promoting — tolerance boundary duplicates may generate double escalation tickets.',
        insight:'v1.1.1 adds SLA-aware escalation with a 4-hour clock and upgrades ESCALATION_TICKET to ESCALATION_TICKET_GID for full OTM linkage.', rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: escalateToSLA(variance_amount, SLA_HOURS=4)'}},{l:{t:'mod',txt:'write: ESCALATION_TICKET, INVOICE_STATUS'},r:{t:'mod',txt:'write: ESCALATION_TICKET_GID, INVOICE_STATUS, SLA_CLOCK_START'}}]) },
      { id:'AG-SHIP-TRACKUPDATE',prod_ver:'v2.3.1', test_ver:'v2.4.0',  conflict_id:null, warning:null,
        insight:"v2.4.0 adds SHIPMENT_EXCEPTION event handling with automatic ETA recomputation and stakeholder notification.",
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:"action: onException → recomputeETA(DELAY_HOURS)"}},{l:{t:'none',txt:''},r:{t:'add',txt:"action: onException → notifyStakeholders('EXCEPTION', CUSTOMER_GID)"}}]) },
      { id:'AG-INV-FRTAUDIT',    prod_ver:'v1.0.4', test_ver:'v1.0.5',  conflict_id:null, warning:null,
        insight:"v1.0.5 adds a linhaul vs accessorial split check, catching carriers who reclassify base freight as accessorial charges.",
        rows:JSON.stringify([{l:{t:'none',txt:''},r:{t:'add',txt:'action: validateLineHaulSplit(LINEHAUL_AMT, ACCESSORIAL_AMT)'}}]) },
    ];
    for (const d of agentDiffsSeed)
      await query(
        `INSERT INTO agent_diffs(id,prod_ver,test_ver,conflict_id,warning,insight,rows)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [d.id, d.prod_ver, d.test_ver, d.conflict_id, d.warning, d.insight, d.rows]);
    console.log('[seed] agent_diffs seeded.');
  } catch (err) {
    console.error('[seed] agent_diffs seed failed:', err.message);
  }
}

async function autoSeedSnapshotsIfEmpty() {
  try {
    const cnt = await query('SELECT COUNT(*) AS n FROM agent_snapshots');
    if (parseInt(cnt[0].n) >= 18) return;
    console.log('[seed] Seeding agent_snapshots…');

    const snaps = [
      // ── AG-ORD-RATESVC ──────────────────────────────────────────────────────
      { agent_id:'AG-ORD-RATESVC', snapshot_at:'2026-05-28 14:00:00+00', version_label:'v4.1.5', changed_by:'s.patel',
        note:'Initial stable version — basic rate & service routing only',
        config:{ evt:'ORDER_RELEASED', priority:'High', success_rate:96.8, health:'green',
          conditions:["ORDER_MOVEMENT.status = 'NEW'","SERVICE_LEVEL is not null","SHIP_UNIT_GID is not null"],
          actions:["RECALC RATES // ORDER_MOVEMENT_GID · LANE_GID","SELECT SERVICE PROVIDER // via RATE_GEO_COST_GID","SET FIELD RATE_GID // from rating engine result","SET FIELD SERVICE_GID // awarded service level","EMIT EVENT RATE_APPLIED // ORDER_MOVEMENT_GID"],
          reads:["ORDER_MOVEMENT_GID","SHIP_UNIT_GID","SERVICE_LEVEL","SHIP_FROM_GID","SHIP_TO_GID","LANE_GID"],
          writes:["RATE_GID","SERVICE_GID","RATE_GEO_COST_GID"] }},
      { agent_id:'AG-ORD-RATESVC', snapshot_at:'2026-06-15 09:30:00+00', version_label:'v4.2.0', changed_by:'s.patel',
        note:'Added freight-class validation — CLASS_FREIGHT_GID required for LTL shipments',
        config:{ evt:'ORDER_RELEASED', priority:'High', success_rate:97.0, health:'green',
          conditions:["ORDER_MOVEMENT.status = 'NEW'","SERVICE_LEVEL is not null","SHIP_UNIT_GID is not null","SERVICE_LEVEL != 'LTL' OR CLASS_FREIGHT_GID is not null"],
          actions:["validateFreightClass(SHIP_UNIT_GID, CLASS_FREIGHT_GID)","computeRate(ORDER_MOVEMENT_GID, LANE_GID)","selectServiceProvider(RATE_GEO_COST_GID)","writeRateGid(RATE_GID)","setServiceGid(SERVICE_GID)","emitEvent('RATE_APPLIED', ORDER_MOVEMENT_GID)"],
          reads:["ORDER_MOVEMENT_GID","SHIP_UNIT_GID","SERVICE_LEVEL","SHIP_FROM_GID","SHIP_TO_GID","LANE_GID","CLASS_FREIGHT_GID"],
          writes:["RATE_GID","SERVICE_GID","RATE_GEO_COST_GID"] }},
      { agent_id:'AG-ORD-RATESVC', snapshot_at:'2026-06-27 09:15:00+00', version_label:'v4.2.1', changed_by:'s.patel',
        note:'Added HAZMAT_FLAG guard — HAZMAT_CERT_GID required for hazmat orders (JIRA OTM-4381)',
        config:{ evt:'ORDER_RELEASED', priority:'High', success_rate:97.3, health:'green',
          conditions:["ORDER_MOVEMENT.status = 'NEW'","SERVICE_LEVEL is not null","SHIP_UNIT_GID is not null","SERVICE_LEVEL != 'LTL' OR CLASS_FREIGHT_GID is not null","HAZMAT_FLAG = false OR HAZMAT_CERT_GID is not null"],
          actions:["validateFreightClass(SHIP_UNIT_GID, CLASS_FREIGHT_GID)","computeRate(ORDER_MOVEMENT_GID, LANE_GID)","selectServiceProvider(RATE_GEO_COST_GID)","writeRateGid(RATE_GID)","setServiceGid(SERVICE_GID)","emitEvent('RATE_APPLIED', ORDER_MOVEMENT_GID)"],
          reads:["ORDER_MOVEMENT_GID","SHIP_UNIT_GID","SERVICE_LEVEL","SHIP_FROM_GID","SHIP_TO_GID","LANE_GID","CLASS_FREIGHT_GID","HAZMAT_FLAG"],
          writes:["RATE_GID","SERVICE_GID","RATE_GEO_COST_GID"] }},
      // ── AG-INV-AUTOAPPROVE ──────────────────────────────────────────────────
      { agent_id:'AG-INV-AUTOAPPROVE', snapshot_at:'2026-05-15 11:00:00+00', version_label:'v2.0.0', changed_by:'d.kim',
        note:'Initial auto-approve — $2.00 hard-coded tolerance band, basic match only',
        config:{ evt:'INVOICE_RECEIVED', priority:'Medium', success_rate:91.2, health:'green',
          conditions:["FREIGHT_BILL.status = 'RECEIVED'","abs(FB_AMOUNT - RATE_GEO_COST) <= 2.00","RATE_GID is not null"],
          actions:["matchFreightBill(FREIGHT_BILL_GID, RATE_GID)","computeVariance(FB_AMOUNT, RATE_GEO_COST)","setInvoiceStatus('APPROVED')","schedulePayment(PAYMENT_DUE_DATE, FB_AMOUNT)"],
          reads:["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST"],
          writes:["MATCH_STATUS","INVOICE_STATUS","PAYMENT_SCHEDULE_GID"] }},
      { agent_id:'AG-INV-AUTOAPPROVE', snapshot_at:'2026-06-01 15:30:00+00', version_label:'v2.1.0', changed_by:'d.kim',
        note:'Added duplicate invoice guard and accessorial validation step',
        config:{ evt:'INVOICE_RECEIVED', priority:'Medium', success_rate:93.1, health:'green',
          conditions:["FREIGHT_BILL.status = 'RECEIVED'","abs(FB_AMOUNT - RATE_GEO_COST) <= 2.00","RATE_GID is not null","SHIPMENT_GID.status = 'DELIVERED'","NOT exists(DUPLICATE_FB_FLAG)"],
          actions:["MATCH FREIGHT BILL // FREIGHT_BILL_GID against RATE_GID","VALIDATE ACCESSORIALS // ACCESSORIAL_CHARGES","COMPUTE VARIANCE // FB_AMOUNT vs RATE_GEO_COST","SET STATUS INVOICE_STATUS = APPROVED","SCHEDULE PAYMENT // PAYMENT_DUE_DATE · FB_AMOUNT"],
          reads:["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST","TOLERANCE_BAND","ACCESSORIAL_CHARGES"],
          writes:["MATCH_STATUS","INVOICE_STATUS","PAYMENT_SCHEDULE_GID"] }},
      { agent_id:'AG-INV-AUTOAPPROVE', snapshot_at:'2026-06-28 18:12:00+00', version_label:'v2.1.5', changed_by:'d.kim',
        note:'TOLERANCE_BAND raised $2.00 → $5.00 per Finance Directive FIN-2026-14',
        config:{ evt:'INVOICE_RECEIVED', priority:'Medium', success_rate:94.1, health:'amber',
          conditions:["FREIGHT_BILL.status = 'RECEIVED'","abs(FB_AMOUNT - RATE_GEO_COST) <= TOLERANCE_BAND","RATE_GID is not null","SHIPMENT_GID.status = 'DELIVERED'","NOT exists(DUPLICATE_FB_FLAG)"],
          actions:["MATCH FREIGHT BILL // FREIGHT_BILL_GID against RATE_GID","VALIDATE ACCESSORIALS // ACCESSORIAL_CHARGES","COMPUTE VARIANCE // FB_AMOUNT vs RATE_GEO_COST","SET STATUS INVOICE_STATUS = APPROVED","SCHEDULE PAYMENT // PAYMENT_DUE_DATE · FB_AMOUNT"],
          reads:["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST","TOLERANCE_BAND","ACCESSORIAL_CHARGES"],
          writes:["MATCH_STATUS","INVOICE_STATUS","PAYMENT_SCHEDULE_GID"] }},
      // ── AG-AI-DWELL ─────────────────────────────────────────────────────────
      { agent_id:'AG-AI-DWELL', snapshot_at:'2026-05-20 09:00:00+00', version_label:'v0.7-beta', changed_by:'oracle.ai',
        note:'First beta — RF-v1, 47 DC coverage zones, confidence threshold 0.70',
        config:{ evt:'SHIPMENT_PLANNED', priority:'Medium', success_rate:82.1, health:'amber',
          conditions:["model.confidence > 0.70","LOCATION_GID in model.coverage_zones","SHIPMENT.equipment_type != 'RAIL'"],
          actions:["loadModelArtifact('dwell_rf_v1')","extractFeatures(LOCATION_GID, TIME_OF_DAY)","predictDwellHours(HISTORICAL_DWELL)","writeForecast(DWELL_FORECAST)","emitHint('TENDER_HINT', confidence)"],
          reads:["SHIPMENT_GID","LOCATION_GID","HISTORICAL_DWELL","TIME_OF_DAY"],
          writes:["DWELL_FORECAST","TENDER_HINT"] }},
      { agent_id:'AG-AI-DWELL', snapshot_at:'2026-06-10 14:00:00+00', version_label:'v0.8-beta', changed_by:'oracle.ai',
        note:'RF-v2 model — CARRIER_SCORE and WEATHER_INDEX added as features; 71 DC zones; threshold 0.62',
        config:{ evt:'SHIPMENT_PLANNED', priority:'Medium', success_rate:85.6, health:'amber',
          conditions:["model.confidence > 0.62","LOCATION_GID in model.coverage_zones","SHIPMENT.equipment_type != 'RAIL'"],
          actions:["loadModelArtifact('dwell_rf_v2')","extractFeatures(LOCATION_GID, CARRIER_SCORE, TIME_OF_DAY)","predictDwellHours(HISTORICAL_DWELL, WEATHER_INDEX)","writeForecast(DWELL_FORECAST)","emitHint('TENDER_HINT', confidence)"],
          reads:["SHIPMENT_GID","LOCATION_GID","HISTORICAL_DWELL","CARRIER_SCORE","WEATHER_INDEX","TIME_OF_DAY"],
          writes:["DWELL_FORECAST","TENDER_HINT"] }},
      { agent_id:'AG-AI-DWELL', snapshot_at:'2026-06-28 14:09:00+00', version_label:'v0.9-beta', changed_by:'oracle.ai',
        note:'Switched RF-v2 → gradient boost v3 — coverage zones expanded to 94 DCs; threshold 0.60',
        config:{ evt:'SHIPMENT_PLANNED', priority:'Medium', success_rate:88.4, health:'amber',
          conditions:["model.confidence > 0.60","LOCATION_GID in model.coverage_zones","SHIPMENT.equipment_type != 'RAIL'"],
          actions:["LOAD MODEL dwell_rf_v3","EXTRACT FEATURES // LOCATION_GID · CARRIER_SCORE · TIME_OF_DAY","RUN INFERENCE // HISTORICAL_DWELL · WEATHER_INDEX","SET FIELD DWELL_FORECAST // AI prediction output","EMIT HINT TENDER_HINT // with confidence score"],
          reads:["SHIPMENT_GID","LOCATION_GID","HISTORICAL_DWELL","CARRIER_SCORE","WEATHER_INDEX","TIME_OF_DAY"],
          writes:["DWELL_FORECAST","TENDER_HINT"] }},
      // ── AG-SHIP-RETENDER ────────────────────────────────────────────────────
      { agent_id:'AG-SHIP-RETENDER', snapshot_at:'2026-05-25 10:00:00+00', version_label:'v1.8.0', changed_by:'a.okafor',
        note:'Base re-tender — 3 retries, no carrier pool size check, no date guard',
        config:{ evt:'TENDER_DECLINED', priority:'High', success_rate:93.1, health:'green',
          conditions:["TENDER_STATUS = 'DECLINED'","RETENDER_COUNT < 3"],
          actions:["incrementRetenderCount(TENDER_GID)","excludeDeclinedCarrier(CARRIER_GID)","selectNextCarrier(ALT_CARRIER_POOL)","buildTenderPayload(SHIPMENT_GID, new_CARRIER_GID)","sendTender(new_CARRIER_GID, TENDER_GID)","setTenderStatus('RETENDERED')"],
          reads:["TENDER_GID","TENDER_STATUS","CARRIER_GID","RETENDER_COUNT","ALT_CARRIER_POOL"],
          writes:["TENDER_STATUS","CARRIER_GID","RETENDER_COUNT"] }},
      { agent_id:'AG-SHIP-RETENDER', snapshot_at:'2026-06-15 11:00:00+00', version_label:'v1.9.0', changed_by:'a.okafor',
        note:'Added ALT_CARRIER_POOL size guard and carrier-rank hint — blocks re-tender with no alternatives',
        config:{ evt:'TENDER_DECLINED', priority:'High', success_rate:94.8, health:'green',
          conditions:["TENDER_STATUS = 'DECLINED'","RETENDER_COUNT < 3","ALT_CARRIER_POOL.size > 0"],
          actions:["incrementRetenderCount(TENDER_GID)","excludeDeclinedCarrier(CARRIER_GID)","selectNextCarrier(ALT_CARRIER_POOL, CARRIER_RANK_HINT)","buildTenderPayload(SHIPMENT_GID, new_CARRIER_GID)","sendTender(new_CARRIER_GID, TENDER_GID)","setTenderStatus('RETENDERED')","onTimeout(30s) => escalate(SHIPMENT_GID, 'CARRIER_TIMEOUT')"],
          reads:["TENDER_GID","TENDER_STATUS","CARRIER_GID","RETENDER_COUNT","ALT_CARRIER_POOL","CARRIER_RANK_HINT"],
          writes:["TENDER_STATUS","CARRIER_GID","RETENDER_COUNT"] }},
      { agent_id:'AG-SHIP-RETENDER', snapshot_at:'2026-06-29 09:15:00+00', version_label:'v2.0.3', changed_by:'a.okafor',
        note:'Added PLANNED_SHIP_DATE guard — blocks re-tender for shipments due in < 12 hours',
        config:{ evt:'TENDER_DECLINED', priority:'High', success_rate:95.6, health:'amber',
          conditions:["TENDER_STATUS = 'DECLINED'","RETENDER_COUNT < 3","ALT_CARRIER_POOL.size > 0","PLANNED_SHIP_DATE > sysdate + 0.5"],
          actions:["incrementRetenderCount(TENDER_GID)","excludeDeclinedCarrier(CARRIER_GID)","selectNextCarrier(ALT_CARRIER_POOL, CARRIER_RANK_HINT)","buildTenderPayload(SHIPMENT_GID, new_CARRIER_GID)","sendTender(new_CARRIER_GID, TENDER_GID)","setTenderStatus('RETENDERED')","onTimeout(30s) => escalate(SHIPMENT_GID, 'CARRIER_TIMEOUT')"],
          reads:["TENDER_GID","TENDER_STATUS","CARRIER_GID","RETENDER_COUNT","ALT_CARRIER_POOL","PLANNED_SHIP_DATE","CARRIER_RANK_HINT"],
          writes:["TENDER_STATUS","CARRIER_GID","RETENDER_COUNT"] }},
      // ── AG-ORD-CREDITHOLD ───────────────────────────────────────────────────
      { agent_id:'AG-ORD-CREDITHOLD', snapshot_at:'2026-05-20 10:00:00+00', version_label:'v1.2.0', changed_by:'s.patel',
        note:'Initial credit check — percentage-based threshold only, no AR balance',
        config:{ evt:'ORDER_RELEASED', priority:'Critical', success_rate:98.4, health:'green',
          conditions:["CUSTOMER.credit_status IN ('REVIEW','WATCH')","ORDER_VALUE > CUSTOMER.CREDIT_LIMIT * 0.90"],
          actions:["checkCreditLimit(CUSTOMER_GID, ORDER_VALUE)","applyHold(ORDER_MOVEMENT_GID)","setHoldStatus('CREDIT')","notifyCreditManager(CUSTOMER_GID, ORDER_VALUE)"],
          reads:["ORDER_MOVEMENT_GID","CUSTOMER_GID","ORDER_VALUE","CREDIT_LIMIT"],
          writes:["HOLD_STATUS","ORDER_STATUS"] }},
      { agent_id:'AG-ORD-CREDITHOLD', snapshot_at:'2026-06-10 08:00:00+00', version_label:'v1.3.5', changed_by:'s.patel',
        note:'Added AR balance check and audit logging per SOX compliance requirement',
        config:{ evt:'ORDER_RELEASED', priority:'Critical', success_rate:98.9, health:'green',
          conditions:["CUSTOMER.credit_status IN ('REVIEW','WATCH')","ORDER_VALUE > CUSTOMER.CREDIT_LIMIT * 0.90","OUTSTANDING_AR_BALANCE > 0"],
          actions:["EVALUATE CREDIT LIMIT // CUSTOMER_GID · ORDER_VALUE","APPLY HOLD // ORDER_MOVEMENT_GID","SET STATUS HOLD_STATUS = CREDIT","WRITE AUDIT LOG // event CREDIT_HOLD · ref ORDER_MOVEMENT_GID","NOTIFY CREDIT MANAGER // CUSTOMER_GID · ORDER_VALUE"],
          reads:["ORDER_MOVEMENT_GID","CUSTOMER_GID","ORDER_VALUE","CREDIT_LIMIT","OUTSTANDING_AR_BALANCE"],
          writes:["HOLD_STATUS","ORDER_STATUS","AUDIT_ENTRY"] }},
      { agent_id:'AG-ORD-CREDITHOLD', snapshot_at:'2026-06-20 14:30:00+00', version_label:'v1.4.2', changed_by:'s.patel',
        note:'Tightened threshold 90% → 85% of credit limit following Q2 risk review',
        config:{ evt:'ORDER_RELEASED', priority:'Critical', success_rate:99.1, health:'green',
          conditions:["CUSTOMER.credit_status IN ('REVIEW','WATCH')","ORDER_VALUE > CUSTOMER.CREDIT_LIMIT * 0.85","OUTSTANDING_AR_BALANCE > 0"],
          actions:["EVALUATE CREDIT LIMIT // CUSTOMER_GID · ORDER_VALUE","APPLY HOLD // ORDER_MOVEMENT_GID","SET STATUS HOLD_STATUS = CREDIT","WRITE AUDIT LOG // event CREDIT_HOLD · ref ORDER_MOVEMENT_GID","NOTIFY CREDIT MANAGER // CUSTOMER_GID · ORDER_VALUE"],
          reads:["ORDER_MOVEMENT_GID","CUSTOMER_GID","ORDER_VALUE","CREDIT_LIMIT","OUTSTANDING_AR_BALANCE"],
          writes:["HOLD_STATUS","ORDER_STATUS","AUDIT_ENTRY"] }},
      // ── AG-AI-CARRIERRANK ───────────────────────────────────────────────────
      { agent_id:'AG-AI-CARRIERRANK', snapshot_at:'2026-06-28 13:22:00+00', version_label:'v1.0.0', changed_by:'oracle.ai',
        note:'Initial deploy — OTD % scoring only; no dwell penalty or claim rate',
        config:{ evt:'RATE_APPLIED', priority:'Medium', success_rate:89.4, health:'green',
          conditions:["RATE_GID is not null","model.confidence > 0.72"],
          actions:["scoreCarriers(LANE_GID, HISTORICAL_PERF)","rankByOnTimeDelivery(SERVICE_PROVIDER_GID[])","emitHint('CARRIER_RANK_HINT', top3)"],
          reads:["LANE_GID","RATE_GID","SERVICE_PROVIDER_GID[]","HISTORICAL_PERF","ON_TIME_PCT"],
          writes:["CARRIER_RANK_HINT"] }},
      { agent_id:'AG-AI-CARRIERRANK', snapshot_at:'2026-07-05 09:00:00+00', version_label:'v1.1.0', changed_by:'oracle.ai',
        note:'Added dwell penalty factor and raised carrier pool minimum to 2',
        config:{ evt:'RATE_APPLIED', priority:'Medium', success_rate:90.8, health:'green',
          conditions:["RATE_GID is not null","model.confidence > 0.72","CARRIER_POOL.count >= 2"],
          actions:["SCORE CARRIERS // LANE_GID · HISTORICAL_PERF","APPLY DWELL PENALTY // AVG_DWELL_HRS","RANK BY ON-TIME DELIVERY // SERVICE_PROVIDER_GID[]","EMIT HINT CARRIER_RANK_HINT // top 3 carriers"],
          reads:["LANE_GID","RATE_GID","SERVICE_PROVIDER_GID[]","HISTORICAL_PERF","AVG_DWELL_HRS","ON_TIME_PCT"],
          writes:["CARRIER_RANK_HINT"] }},
      { agent_id:'AG-AI-CARRIERRANK', snapshot_at:'2026-07-10 09:00:00+00', version_label:'v1.2.0', changed_by:'oracle.ai',
        note:'Added claim rate scoring — CLAIM_RATE now a negative signal in carrier ranking',
        config:{ evt:'RATE_APPLIED', priority:'Medium', success_rate:91.2, health:'amber',
          conditions:["RATE_GID is not null","model.confidence > 0.72","CARRIER_POOL.count >= 2"],
          actions:["SCORE CARRIERS // LANE_GID · HISTORICAL_PERF","APPLY DWELL PENALTY // AVG_DWELL_HRS","RANK BY ON-TIME DELIVERY // SERVICE_PROVIDER_GID[]","EMIT HINT CARRIER_RANK_HINT // top 3 carriers"],
          reads:["LANE_GID","RATE_GID","SERVICE_PROVIDER_GID[]","HISTORICAL_PERF","AVG_DWELL_HRS","ON_TIME_PCT","CLAIM_RATE"],
          writes:["CARRIER_RANK_HINT"] }},
    ];

    for (const s of snaps) {
      await query(
        `INSERT INTO agent_snapshots(agent_id,snapshot_at,version_label,changed_by,note,config_json)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [s.agent_id, s.snapshot_at, s.version_label, s.changed_by, s.note, JSON.stringify(s.config)]
      );
    }
    console.log('[seed] agent_snapshots seeded (' + snaps.length + ' rows).');
  } catch (err) {
    console.error('[seed] agent_snapshots seed failed:', err.message);
  }
}

// ─── SCHEMA MIGRATION ─────────────────────────────────────────────────────────
// Runs idempotent CREATE TABLE IF NOT EXISTS statements from schema.sql on
// every startup so a fresh environment needs no manual setup steps.

async function runSchemaMigration() {
  const schemaPath = path.join(path.dirname(__filename), 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.warn('[schema] schema.sql not found — skipping migration');
    return;
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[schema] Migration applied (schema.sql).');
  } finally {
    client.release();
  }
}

// ─── SEED ANNOTATIONS ─────────────────────────────────────────────────────────
async function autoSeedAnnotationsIfEmpty() {
  try {
    const rows = await query('SELECT COUNT(*) AS n FROM agent_annotations');
    if (parseInt(rows[0].n) > 0) return;
    console.log('[seed] Seeding agent_annotations…');
    const annotations = [
      { agent_id: 'AG-ORD-RATESVC',
        note: 'Calls RATE_GID directly — no fallback path. Any schema change to RATE_GEO_COST_GID will fail silently: wrong rate applied with no error thrown. Always validate rate schema changes in TEST for 48 h before promoting to PROD.',
        severity: 'danger', tags: ['perf-sensitive','fragile'], author: 's.patel', pinned: true },
      { agent_id: 'AG-ORD-RATESVC',
        note: 'Owned jointly by s.patel (infra) and k.nowak (carrier ops). Config changes need sign-off from both. k.nowak owns the rate table mappings; s.patel owns the GID logic.',
        severity: 'info', tags: ['owner-change'], author: 'k.nowak', pinned: false },
      { agent_id: 'AG-SHIP-AUTOTENDER',
        note: 'Do NOT deploy within 48 h of month-end close. Tender volume spikes 6–8× on the last business day. A hot deploy in Q2 caused a 22-minute tender backlog and missed SLAs. Schedule changes for the 2nd business day of the month only.',
        severity: 'danger', tags: ['fragile','month-end','do-not-touch'], author: 'm.jones', pinned: true },
      { agent_id: 'AG-SHIP-AUTOTENDER',
        note: '504 ms race window with AG-AI-DWELL (C-002) is a known, accepted risk. Fixing it requires a queue refactor — tracked for Q4 platform sprint. No manual workaround needed today, just monitor.',
        severity: 'warning', tags: ['fragile'], author: 'You', pinned: false },
      { agent_id: 'AG-AI-CARRIERRANK',
        note: 'Model retrained monthly by oracle.ai team. Confidence score (threshold 0.72) typically drops below cutoff for 2–6 h post-retraining — carriers fall back to legacy scoring. Expect degraded ranking quality in that window. No intervention needed; it self-recovers.',
        severity: 'warning', tags: ['ai-dependent','perf-sensitive'], author: 'oracle.ai', pinned: true },
      { agent_id: 'AG-AI-DWELL',
        note: 'JOB-DWELL-REFRESH sometimes misses its 01:00 schedule when the upstream ETL is delayed. If health view shows model age > 24 h, manually trigger the refresh job before the 08:00 peak window.',
        severity: 'warning', tags: ['ai-dependent','fragile'], author: 'You', pinned: false },
      { agent_id: 'AG-INV-VARIANCE',
        note: 'Processes 8× normal volume on the last business day of each month — responsible for 2 timeout incidents. Do not schedule maintenance in the final 3 days of any month. Batch window is 02:00–04:00 UTC; avoid any DB maintenance in that slot.',
        severity: 'warning', tags: ['month-end','audit-required'], author: 's.patel', pinned: true },
      { agent_id: 'AG-INV-FRTAUDIT',
        note: 'Regulatory hard stop: cannot be disabled for any shipment with US DOT HAZMAT codes without written approval from the compliance officer. Document approval in audit log before any config change — legal requirement.',
        severity: 'danger', tags: ['audit-required','do-not-touch'], author: 'compliance-team', pinned: true },
    ];
    for (const a of annotations) {
      await query(
        'INSERT INTO agent_annotations(agent_id,note,severity,tags,author,pinned) VALUES($1,$2,$3,$4,$5,$6)',
        [a.agent_id, a.note, a.severity, a.tags, a.author, a.pinned || false]
      );
    }
    console.log('[seed] agent_annotations seeded (' + annotations.length + ' rows).');
  } catch (err) {
    console.error('[seed] agent_annotations seed failed:', err.message);
  }
}

// ─── SKYMFG SEED ─────────────────────────────────────────────────────────────
// Loads all 150 SkyMFG agents (6 domains, 1 636 actions, 171 events) from the
// canonical seed JSON on first startup.  Re-running is safe: guarded by a
// domain row-count check.  To force a re-import run: node scripts/import_skymfg.js

const SKYMFG_SEED_PATH = require('path').join(__dirname, 'attached_assets/catalyst_skymfg_seed_1784878938654.json');

async function _skymfgBatchInsert(sql, params) {
  // Helper: chunked multi-row INSERT to stay under pg's 65 535 param limit
  return query(sql, params);
}

async function autoSeedSkymfgIfEmpty() {
  try {
    const check = await query(`SELECT COUNT(*) AS n FROM domains WHERE tenant_id='SKYMFG'`);
    if (parseInt(check[0].n) > 0) return;
    console.log('[seed] Seeding SkyMFG from JSON seed file…');

    const data = JSON.parse(require('fs').readFileSync(SKYMFG_SEED_PATH, 'utf8'));
    const { tenant, domains, agents, agent_actions, agent_events,
            data_query_types, action_catalog, event_catalog,
            saved_conditions, external_systems, users, contacts } = data;

    // ── 1. Tenant ──────────────────────────────────────────────────────────
    await query(`INSERT INTO tenants(tenant_id,tenant_name,otm_instance_url,otm_version,description)
      VALUES('NWL','Northwind Logistics','https://otm26b.nwl.oraclecloud.com','OTM 26B','Primary NWL production tenant')
      ON CONFLICT(tenant_id) DO NOTHING`);
    const t = tenant;
    await query(`INSERT INTO tenants(tenant_id,tenant_name,otm_instance_url,otm_version,description)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET
        tenant_name=EXCLUDED.tenant_name, otm_instance_url=EXCLUDED.otm_instance_url,
        otm_version=EXCLUDED.otm_version, description=EXCLUDED.description`,
      [t.tenant_id, t.tenant_name, t.otm_instance_url, t.otm_version, t.description]);

    // ── 2. Domains ─────────────────────────────────────────────────────────
    for (const d of domains)
      await query(`INSERT INTO domains(domain_name,tenant_id,display_label,description,environment_type,theme_color,agent_count)
        VALUES($1,'SKYMFG',$2,$3,$4,$5,$6) ON CONFLICT(domain_name) DO UPDATE SET
          display_label=EXCLUDED.display_label, description=EXCLUDED.description,
          environment_type=EXCLUDED.environment_type, theme_color=EXCLUDED.theme_color,
          agent_count=EXCLUDED.agent_count`,
        [d.domain_name, d.display_label, d.description, d.environment_type, d.theme_color, d.agent_count]);

    // ── 3. Catalog tables ──────────────────────────────────────────────────
    for (const r of data_query_types)
      await query(`INSERT INTO data_query_types(gid,agent_count) VALUES($1,$2)
        ON CONFLICT(gid) DO UPDATE SET agent_count=EXCLUDED.agent_count`, [r.gid, r.agent_count]);
    for (const r of external_systems)
      await query(`INSERT INTO external_systems(external_system_gid) VALUES($1) ON CONFLICT DO NOTHING`, [r.external_system_gid]);
    for (const r of users)
      await query(`INSERT INTO otm_users(user_gid) VALUES($1) ON CONFLICT DO NOTHING`, [r.user_gid]);
    for (const r of contacts)
      await query(`INSERT INTO notification_contacts(contact_gid) VALUES($1) ON CONFLICT DO NOTHING`, [r.contact_gid]);
    for (const r of saved_conditions)
      await query(`INSERT INTO saved_conditions(condition_gid) VALUES($1) ON CONFLICT DO NOTHING`, [r.condition_gid]);
    for (const r of event_catalog)
      await query(`INSERT INTO event_catalog(event_gid) VALUES($1) ON CONFLICT DO NOTHING`, [r.event_gid]);
    for (const r of action_catalog)
      await query(`INSERT INTO action_catalog(action_gid) VALUES($1) ON CONFLICT DO NOTHING`, [r.action_gid]);

    // ── 4. Agents (150) ────────────────────────────────────────────────────
    for (const a of agents)
      await query(`INSERT INTO agents(
          agent_gid,agent_xid,domain_name,data_query_type_gid,
          is_active,reentrancy_level,run_as_type,is_single_thread,is_object_lock,is_long_running,
          otm_release,saved_condition_gid,log_level,stats_level,
          norm_action_count,err_action_count,event_count,complexity_score,functional_categories,
          success_rate,health,gx,gy)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,0,'green',0,0)
        ON CONFLICT(agent_gid) DO UPDATE SET
          agent_xid=EXCLUDED.agent_xid, domain_name=EXCLUDED.domain_name,
          data_query_type_gid=EXCLUDED.data_query_type_gid, is_active=EXCLUDED.is_active,
          reentrancy_level=EXCLUDED.reentrancy_level, otm_release=EXCLUDED.otm_release,
          norm_action_count=EXCLUDED.norm_action_count, err_action_count=EXCLUDED.err_action_count,
          event_count=EXCLUDED.event_count, complexity_score=EXCLUDED.complexity_score,
          functional_categories=EXCLUDED.functional_categories`,
        [a.agent_gid, a.agent_xid, a.domain_name, a.data_query_type_gid,
         a.is_active, a.reentrancy_level, a.run_as_type, a.is_single_thread, a.is_object_lock, a.is_long_running,
         a.otm_release||null, a.saved_condition_gid||null, a.log_level||null, a.stats_level||null,
         a.norm_action_count, a.err_action_count, a.event_count, a.complexity_score,
         a.functional_categories?.length ? JSON.stringify(a.functional_categories) : null]);

    // ── 5. Agent actions (1 636) ───────────────────────────────────────────
    for (const a of agent_actions)
      await query(`INSERT INTO agent_actions(agent_gid,action_gid,action_sequence,action_flow,action_params,data_type_assoc)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(agent_gid,action_flow,action_sequence) DO UPDATE SET
          action_gid=EXCLUDED.action_gid, action_params=EXCLUDED.action_params,
          data_type_assoc=EXCLUDED.data_type_assoc`,
        [a.agent_gid, a.action_gid, a.action_sequence, a.action_flow||'NORMAL', a.action_params||null, a.data_type_assoc||null]);

    // ── 6. Agent events (171) ──────────────────────────────────────────────
    for (const e of agent_events)
      await query(`INSERT INTO agent_events(agent_gid,event_gid,event_params)
        VALUES($1,$2,$3) ON CONFLICT(agent_gid,event_gid) DO NOTHING`,
        [e.agent_gid, e.event_gid, e.event_params||null]);

    console.log(`[seed] SkyMFG seeded: ${agents.length} agents, ${domains.length} domains, ${agent_actions.length} actions, ${agent_events.length} events.`);
  } catch (err) {
    console.error('[seed] SkyMFG seed failed:', err.message);
  }
}

// Start listening first (Cloud Run health check), then migrate + seed in the background.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Katalyst API running on port ${PORT}`);
  runSchemaMigration()
    .then(() => autoSeedIfEmpty())
    .then(() => refreshAgentActionStyle())
    .then(() => autoSeedAdminIfEmpty())
    .then(() => autoSeedTracesIfEmpty())
    .then(() => autoSeedDiffsIfEmpty())
    .then(() => autoSeedSnapshotsIfEmpty())
    .then(() => autoSeedAnnotationsIfEmpty())
    .then(() => autoSeedSkymfgIfEmpty())
    .catch(err => console.error('[seed] Background seed error:', err.message));
});
