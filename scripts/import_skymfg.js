#!/usr/bin/env node
/**
 * scripts/import_skymfg.js
 *
 * Full SkyMFG data import from the seed JSON file.
 * Wipes any existing SkyMFG placeholder data and loads the real 150-agent dataset.
 *
 * Usage:  node scripts/import_skymfg.js
 */

'use strict';

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

const SEED_FILE = path.join(__dirname, '../attached_assets/catalyst_skymfg_seed_1784878938654.json');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// Batch single-value inserts into one multi-row VALUES clause for speed.
// Returns { sql, params }.
function buildMultiInsert(table, columns, rows, onConflict = 'DO NOTHING') {
  if (!rows.length) return null;
  const valClauses = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    const holders = columns.map(() => `$${idx++}`);
    valClauses.push(`(${holders.join(',')})`);
    for (const col of columns) params.push(row[col] ?? null);
  }
  return {
    sql: `INSERT INTO ${table}(${columns.join(',')}) VALUES ${valClauses.join(',')} ON CONFLICT ${onConflict}`,
    params,
  };
}

async function batchInsert(table, columns, rows, onConflict = 'DO NOTHING', chunkSize = 500) {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const q = buildMultiInsert(table, columns, chunk, onConflict);
    if (q) { await query(q.sql, q.params); total += chunk.length; }
  }
  return total;
}

async function main() {
  console.log('[import] Reading seed file…');
  const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  const { tenant, domains, agents, agent_actions, agent_events,
          data_query_types, action_catalog, event_catalog,
          saved_conditions, external_systems, users, contacts } = data;

  // ── 1. Determine all domain names that need cleaning ──────────────────────
  const realDomainNames  = domains.map(d => d.domain_name);
  const fakeDomainNames  = ['SKYMFG/ORDER','SKYMFG/SHIP','SKYMFG/INV','SKYMFG/FIN','SKYMFG/COMP'];
  const allDomainsToWipe = [...new Set([...realDomainNames, ...fakeDomainNames])];

  console.log('[import] Cleaning old SkyMFG data…');

  // agent_events has no CASCADE → delete before agents
  await query(`DELETE FROM agent_events WHERE agent_gid IN
    (SELECT agent_gid FROM agents WHERE domain_name = ANY($1))`, [allDomainsToWipe]);

  // agent_actions has ON DELETE CASCADE, but explicit delete is safer
  await query(`DELETE FROM agent_actions WHERE agent_gid IN
    (SELECT agent_gid FROM agents WHERE domain_name = ANY($1))`, [allDomainsToWipe]);

  // Delete agents (also cascades agent_drafts, agent_reads, agent_writes, agent_conditions)
  await query(`DELETE FROM agents WHERE domain_name = ANY($1)`, [allDomainsToWipe]);

  // Delete domains
  await query(`DELETE FROM domains WHERE domain_name = ANY($1)`, [allDomainsToWipe]);

  // ── 2. Upsert tenant ───────────────────────────────────────────────────────
  console.log('[import] Upserting tenant…');
  await query(
    `INSERT INTO tenants(tenant_id,tenant_name,otm_instance_url,otm_version,description)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(tenant_id) DO UPDATE SET
       tenant_name=EXCLUDED.tenant_name,
       otm_instance_url=EXCLUDED.otm_instance_url,
       otm_version=EXCLUDED.otm_version,
       description=EXCLUDED.description`,
    [tenant.tenant_id, tenant.tenant_name, tenant.otm_instance_url, tenant.otm_version, tenant.description]
  );

  // ── 3. Insert domains (all belong to SKYMFG tenant) ───────────────────────
  console.log('[import] Inserting domains…');
  for (const d of domains) {
    await query(
      `INSERT INTO domains(domain_name,tenant_id,display_label,description,environment_type,theme_color,agent_count)
       VALUES($1,'SKYMFG',$2,$3,$4,$5,$6)
       ON CONFLICT(domain_name) DO UPDATE SET
         tenant_id='SKYMFG',
         display_label=EXCLUDED.display_label,
         description=EXCLUDED.description,
         environment_type=EXCLUDED.environment_type,
         theme_color=EXCLUDED.theme_color,
         agent_count=EXCLUDED.agent_count`,
      [d.domain_name, d.display_label, d.description, d.environment_type, d.theme_color, d.agent_count]
    );
  }
  console.log(`[import] ${domains.length} domains inserted.`);

  // ── 4. Catalog tables (upsert, non-destructive) ───────────────────────────
  console.log('[import] Updating catalog tables…');

  await batchInsert('data_query_types', ['gid','agent_count'],
    data_query_types.map(r => ({ gid: r.gid, agent_count: r.agent_count })),
    '(gid) DO UPDATE SET agent_count=EXCLUDED.agent_count');

  await batchInsert('external_systems', ['external_system_gid'],
    external_systems.map(r => ({ external_system_gid: r.external_system_gid })));

  await batchInsert('otm_users', ['user_gid'],
    users.map(r => ({ user_gid: r.user_gid })));

  await batchInsert('notification_contacts', ['contact_gid'],
    contacts.map(r => ({ contact_gid: r.contact_gid })));

  await batchInsert('saved_conditions', ['condition_gid'],
    saved_conditions.map(r => ({ condition_gid: r.condition_gid })));

  await batchInsert('event_catalog', ['event_gid'],
    event_catalog.map(r => ({ event_gid: r.event_gid })));

  await batchInsert('action_catalog', ['action_gid'],
    action_catalog.map(r => ({ action_gid: r.action_gid })));

  console.log('[import] Catalog tables updated.');

  // ── 5. Insert agents ───────────────────────────────────────────────────────
  console.log('[import] Inserting 150 agents…');
  const AGENT_COLS = [
    'agent_gid','agent_xid','domain_name','data_query_type_gid',
    'is_active','reentrancy_level','run_as_type','is_single_thread','is_object_lock','is_long_running',
    'otm_release','saved_condition_gid','log_level','stats_level',
    'norm_action_count','err_action_count','event_count','complexity_score','functional_categories',
    'success_rate','health','gx','gy',
  ];

  const agentRows = agents.map(a => ({
    agent_gid:             a.agent_gid,
    agent_xid:             a.agent_xid,
    domain_name:           a.domain_name,
    data_query_type_gid:   a.data_query_type_gid,
    is_active:             a.is_active,
    reentrancy_level:      a.reentrancy_level,
    run_as_type:           a.run_as_type,
    is_single_thread:      a.is_single_thread,
    is_object_lock:        a.is_object_lock,
    is_long_running:       a.is_long_running,
    otm_release:           a.otm_release   || null,
    saved_condition_gid:   a.saved_condition_gid || null,
    log_level:             a.log_level     || null,
    stats_level:           a.stats_level   || null,
    norm_action_count:     a.norm_action_count,
    err_action_count:      a.err_action_count,
    event_count:           a.event_count,
    complexity_score:      a.complexity_score,
    functional_categories: a.functional_categories?.length
                             ? JSON.stringify(a.functional_categories) : null,
    success_rate:          0,
    health:                'green',
    gx:                    0,
    gy:                    0,
  }));

  // Agents must be inserted one-at-a-time to avoid param-count limits on 150*23 cols
  // but we can batch in chunks of 50
  await batchInsert('agents', AGENT_COLS, agentRows,
    '(agent_gid) DO UPDATE SET ' +
    'agent_xid=EXCLUDED.agent_xid, domain_name=EXCLUDED.domain_name, ' +
    'data_query_type_gid=EXCLUDED.data_query_type_gid, is_active=EXCLUDED.is_active, ' +
    'reentrancy_level=EXCLUDED.reentrancy_level, run_as_type=EXCLUDED.run_as_type, ' +
    'is_single_thread=EXCLUDED.is_single_thread, is_object_lock=EXCLUDED.is_object_lock, ' +
    'is_long_running=EXCLUDED.is_long_running, otm_release=EXCLUDED.otm_release, ' +
    'saved_condition_gid=EXCLUDED.saved_condition_gid, log_level=EXCLUDED.log_level, ' +
    'stats_level=EXCLUDED.stats_level, norm_action_count=EXCLUDED.norm_action_count, ' +
    'err_action_count=EXCLUDED.err_action_count, event_count=EXCLUDED.event_count, ' +
    'complexity_score=EXCLUDED.complexity_score, functional_categories=EXCLUDED.functional_categories',
    50  // chunk size: 50 agents × 23 cols = 1150 params, well under PG limit of 65535
  );
  console.log(`[import] ${agents.length} agents inserted.`);

  // ── 6. Insert agent_actions ────────────────────────────────────────────────
  console.log('[import] Inserting 1 636 agent_actions…');
  const ACTION_COLS = ['agent_gid','action_gid','action_sequence','action_flow','action_params','data_type_assoc'];
  const actionRows = agent_actions.map(a => ({
    agent_gid:       a.agent_gid,
    action_gid:      a.action_gid,
    action_sequence: a.action_sequence,
    action_flow:     a.action_flow || 'NORMAL',
    action_params:   a.action_params || null,
    data_type_assoc: a.data_type_assoc || null,
  }));

  // chunk 100 rows × 6 cols = 600 params per chunk
  await batchInsert('agent_actions', ACTION_COLS, actionRows,
    '(agent_gid,action_flow,action_sequence) DO UPDATE SET ' +
    'action_gid=EXCLUDED.action_gid, action_params=EXCLUDED.action_params, ' +
    'data_type_assoc=EXCLUDED.data_type_assoc',
    100
  );
  console.log(`[import] ${agent_actions.length} agent_actions inserted.`);

  // ── 7. Insert agent_events ─────────────────────────────────────────────────
  console.log('[import] Inserting 171 agent_events…');
  const EVENT_COLS = ['agent_gid','event_gid','event_params'];
  const eventRows = agent_events.map(e => ({
    agent_gid:    e.agent_gid,
    event_gid:    e.event_gid,
    event_params: e.event_params || null,
  }));

  await batchInsert('agent_events', EVENT_COLS, eventRows,
    '(agent_gid,event_gid) DO NOTHING',
    200
  );
  console.log(`[import] ${agent_events.length} agent_events inserted.`);

  // ── 8. Verify ──────────────────────────────────────────────────────────────
  const [agentCount]   = await query('SELECT COUNT(*) n FROM agents WHERE domain_name = ANY($1)', [realDomainNames]);
  const [actionCount]  = await query('SELECT COUNT(*) n FROM agent_actions WHERE agent_gid IN (SELECT agent_gid FROM agents WHERE domain_name = ANY($1))', [realDomainNames]);
  const [eventCount]   = await query('SELECT COUNT(*) n FROM agent_events WHERE agent_gid IN (SELECT agent_gid FROM agents WHERE domain_name = ANY($1))', [realDomainNames]);
  const [domainCount]  = await query('SELECT COUNT(*) n FROM domains WHERE tenant_id=\'SKYMFG\'');

  console.log('\n[import] ✓ Import complete');
  console.log(`  Domains  : ${domainCount.n}`);
  console.log(`  Agents   : ${agentCount.n}`);
  console.log(`  Actions  : ${actionCount.n}`);
  console.log(`  Events   : ${eventCount.n}`);

  await pool.end();
}

main().catch(err => {
  console.error('[import] FAILED:', err.message);
  console.error(err.stack);
  pool.end();
  process.exit(1);
});
