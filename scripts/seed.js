'use strict';
/**
 * scripts/seed.js
 * One-time (idempotent) seed loader for the Katalyst / SkyMFG dataset.
 * Safe to re-run: every INSERT uses ON CONFLICT DO UPDATE.
 *
 * Usage:  node scripts/seed.js
 */

const { Pool } = require('pg');
const path     = require('path');
const fs       = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false } : false,
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function run(sql, params) {
  const client = await pool.connect();
  try   { return (await client.query(sql, params)).rows; }
  finally { client.release(); }
}

/** Batch-upsert rows into `table`.
 *  colDefs  : array of { col, type? }  e.g. [{col:'agent_gid'}, {col:'is_active',type:'boolean'}]
 *  conflictKey : column(s) that form the unique/PK constraint used for ON CONFLICT
 *  updateCols  : columns to overwrite on conflict (omit PK cols)
 *  rows     : array of plain objects
 */
async function upsertBatch(table, colDefs, conflictKey, updateCols, rows) {
  if (!rows.length) return;

  const CHUNK = 200;           // keep parameter count sane
  const cols  = colDefs.map(c => c.col);

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk   = rows.slice(i, i + CHUNK);
    const values  = [];
    const placeholders = chunk.map((row, ri) => {
      const rowPlaceholders = colDefs.map((def, ci) => {
        const idx = ri * colDefs.length + ci + 1;
        let v = row[def.col];
        // coerce undefined/null explicitly
        if (v === undefined) v = null;
        // JSON-stringify arrays/objects
        if (v !== null && typeof v === 'object') v = JSON.stringify(v);
        values.push(v);
        return def.type ? `$${idx}::${def.type}` : `$${idx}`;
      });
      return `(${rowPlaceholders.join(',')})`;
    });

    const setClause = updateCols
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(', ');

    const onConflict = setClause
      ? `DO UPDATE SET ${setClause}`
      : `DO NOTHING`;

    const sql = `
      INSERT INTO ${table} (${cols.join(',')})
      VALUES ${placeholders.join(',')}
      ON CONFLICT (${conflictKey}) ${onConflict}
    `;
    await run(sql, values);
  }
}

// ── schema prep: tables + constraints not in Step 1 ──────────────────────────

async function ensureSchema() {
  // Catalog tables (action_catalog, event_catalog) not in Step 1
  await run(`
    CREATE TABLE IF NOT EXISTS action_catalog (
      action_gid TEXT PRIMARY KEY
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS event_catalog (
      event_gid TEXT PRIMARY KEY
    )
  `);

  // Unique constraints needed for ON CONFLICT on agent_events and agent_actions
  await run(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_agent_events_agent_event'
      ) THEN
        ALTER TABLE agent_events
          ADD CONSTRAINT uq_agent_events_agent_event
          UNIQUE (agent_gid, event_gid);
      END IF;
    END$$
  `);

  await run(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_agent_actions_flow_seq'
      ) THEN
        ALTER TABLE agent_actions
          ADD CONSTRAINT uq_agent_actions_flow_seq
          UNIQUE (agent_gid, action_flow, action_sequence);
      END IF;
    END$$
  `);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const seedPath = path.join(__dirname, '..', 'attached_assets',
    'catalyst_skymfg_seed_1784863117575.json');

  console.log('Reading seed file…');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  console.log('Ensuring schema extras (catalog tables + unique constraints)…');
  await ensureSchema();

  // 1. tenant (single record)
  console.log('Loading tenant…');
  const t = seed.tenant;
  await run(`
    INSERT INTO tenants (tenant_id, tenant_name, otm_instance_url, otm_version, description)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tenant_id) DO UPDATE SET
      tenant_name      = EXCLUDED.tenant_name,
      otm_instance_url = EXCLUDED.otm_instance_url,
      otm_version      = EXCLUDED.otm_version,
      description      = EXCLUDED.description
  `, [t.tenant_id, t.tenant_name, t.otm_instance_url, t.otm_version, t.description]);

  // 2. domains (inject tenant_id from the tenant record)
  console.log(`Loading ${seed.domains.length} domains…`);
  await upsertBatch(
    'domains',
    [
      { col: 'domain_name' },
      { col: 'tenant_id' },
      { col: 'display_label' },
      { col: 'description' },
      { col: 'environment_type' },
      { col: 'theme_color' },
      { col: 'agent_count', type: 'integer' },
    ],
    'domain_name',
    ['tenant_id','display_label','description','environment_type','theme_color','agent_count'],
    seed.domains.map(d => ({ ...d, tenant_id: t.tenant_id }))
  );

  // 3. agents
  console.log(`Loading ${seed.agents.length} agents…`);
  await upsertBatch(
    'agents',
    [
      { col: 'agent_gid' },
      { col: 'agent_xid' },
      { col: 'domain_name' },
      { col: 'data_query_type_gid' },
      { col: 'is_active',         type: 'boolean' },
      { col: 'reentrancy_level',  type: 'integer' },
      { col: 'run_as_type' },
      { col: 'is_single_thread',  type: 'boolean' },
      { col: 'is_object_lock',    type: 'boolean' },
      { col: 'is_long_running',   type: 'boolean' },
      { col: 'otm_release' },
      { col: 'saved_condition_gid' },
      { col: 'log_level' },
      { col: 'stats_level' },
      { col: 'norm_action_count', type: 'integer' },
      { col: 'err_action_count',  type: 'integer' },
      { col: 'event_count',       type: 'integer' },
      { col: 'complexity_score',  type: 'real' },
      { col: 'functional_categories' },   // array → JSON.stringify'd by upsertBatch
    ],
    'agent_gid',
    [
      'agent_xid','domain_name','data_query_type_gid','is_active','reentrancy_level',
      'run_as_type','is_single_thread','is_object_lock','is_long_running','otm_release',
      'saved_condition_gid','log_level','stats_level','norm_action_count','err_action_count',
      'event_count','complexity_score','functional_categories',
    ],
    seed.agents
  );

  // 4. agent_events
  console.log(`Loading ${seed.agent_events.length} agent_events…`);
  await upsertBatch(
    'agent_events',
    [
      { col: 'agent_gid' },
      { col: 'event_gid' },
      { col: 'event_params' },
    ],
    'agent_gid, event_gid',
    ['event_params'],
    seed.agent_events
  );

  // 5. agent_actions
  console.log(`Loading ${seed.agent_actions.length} agent_actions…`);
  await upsertBatch(
    'agent_actions',
    [
      { col: 'agent_gid' },
      { col: 'action_flow' },
      { col: 'action_sequence', type: 'integer' },
      { col: 'action_gid' },
      { col: 'action_params' },
      { col: 'data_type_assoc' },
    ],
    'agent_gid, action_flow, action_sequence',
    ['action_gid','action_params','data_type_assoc'],
    seed.agent_actions
  );

  // 6. reference tables (no FK dependencies — load in parallel)
  console.log('Loading reference tables…');
  await Promise.all([
    upsertBatch('data_query_types',
      [{ col: 'gid' }, { col: 'agent_count', type: 'integer' }],
      'gid', ['agent_count'],
      seed.data_query_types),

    upsertBatch('action_catalog',
      [{ col: 'action_gid' }],
      'action_gid', [],
      seed.action_catalog),

    upsertBatch('event_catalog',
      [{ col: 'event_gid' }],
      'event_gid', [],
      seed.event_catalog),

    upsertBatch('saved_conditions',
      [{ col: 'condition_gid' }],
      'condition_gid', [],
      seed.saved_conditions),

    upsertBatch('external_systems',
      [{ col: 'external_system_gid' }],
      'external_system_gid', [],
      seed.external_systems),

    upsertBatch('otm_users',
      [{ col: 'user_gid' }],
      'user_gid', [],
      seed.users),

    upsertBatch('notification_contacts',
      [{ col: 'contact_gid' }],
      'contact_gid', [],
      seed.contacts),
  ]);

  console.log('✓ Seed complete.');
  await pool.end();
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
