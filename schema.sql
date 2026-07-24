-- Katalyst — PostgreSQL schema
-- Authoritative definition: matches live DB column names exactly.
-- All CREATE TABLE statements use IF NOT EXISTS (idempotent).
-- ALTER TABLE … ADD COLUMN IF NOT EXISTS handles fresh installs that
-- may be missing columns added in later migrations.

-- ─── TENANTS ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,
  tenant_name      TEXT NOT NULL,
  otm_instance_url TEXT,
  otm_version      TEXT,
  description      TEXT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── DOMAINS ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS domains (
  domain_name      TEXT PRIMARY KEY,
  tenant_id        TEXT REFERENCES tenants(tenant_id),
  display_label    TEXT NOT NULL,
  description      TEXT,
  environment_type TEXT NOT NULL,
  theme_color      TEXT,
  agent_count      INTEGER DEFAULT 0,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── REFERENCE / CATALOG TABLES ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS data_query_types (
  gid         TEXT PRIMARY KEY,
  agent_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS external_systems (
  external_system_gid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS otm_users (
  user_gid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS saved_conditions (
  condition_gid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS event_catalog (
  event_gid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS action_catalog (
  action_gid TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS notification_contacts (
  contact_gid TEXT PRIMARY KEY
);

-- ─── AGENTS ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  agent_gid             TEXT PRIMARY KEY,
  agent_xid             TEXT NOT NULL,
  domain_name           TEXT NOT NULL,
  data_query_type_gid   TEXT NOT NULL,
  version               TEXT,
  owner                 TEXT,
  trigger_name          TEXT,
  evt                   TEXT,
  priority              TEXT,
  success_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  health                TEXT NOT NULL DEFAULT 'green',
  gx                    INTEGER NOT NULL DEFAULT 0,
  gy                    INTEGER NOT NULL DEFAULT 0,
  is_active             BOOLEAN DEFAULT true,
  reentrancy_level      INTEGER DEFAULT 0,
  run_as_type           TEXT DEFAULT 'USER ROLE',
  is_single_thread      BOOLEAN DEFAULT false,
  is_object_lock        BOOLEAN DEFAULT false,
  is_long_running       BOOLEAN DEFAULT false,
  otm_release           TEXT,
  saved_condition_gid   TEXT,
  log_level             TEXT,
  stats_level           TEXT,
  norm_action_count     INTEGER DEFAULT 0,
  err_action_count      INTEGER DEFAULT 0,
  event_count           INTEGER DEFAULT 0,
  complexity_score      REAL DEFAULT 0,
  functional_categories TEXT,
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);

-- ─── AGENT CHILD TABLES ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_actions (
  id              SERIAL PRIMARY KEY,
  agent_gid       TEXT NOT NULL REFERENCES agents(agent_gid) ON DELETE CASCADE,
  action_gid      TEXT NOT NULL,
  action_sequence INTEGER NOT NULL DEFAULT 0,
  action_flow     TEXT DEFAULT 'NORMAL',
  action_params   TEXT,
  data_type_assoc TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_gid ON agent_actions(agent_gid, action_flow, action_sequence);
DO $$ BEGIN
  ALTER TABLE agent_actions
    ADD CONSTRAINT uq_agent_actions_flow_seq UNIQUE (agent_gid, action_flow, action_sequence);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agent_events (
  id           SERIAL PRIMARY KEY,
  agent_gid    TEXT NOT NULL REFERENCES agents(agent_gid),
  event_gid    TEXT NOT NULL,
  event_params TEXT
);
DO $$ BEGIN
  ALTER TABLE agent_events
    ADD CONSTRAINT uq_agent_events_agent_event UNIQUE (agent_gid, event_gid);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agent_conditions (
  id             SERIAL PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(agent_gid) ON DELETE CASCADE,
  condition_text TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_reads (
  id         SERIAL PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(agent_gid) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_writes (
  id         SERIAL PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(agent_gid) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_drafts (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(agent_gid) ON DELETE CASCADE,
  draft_text TEXT NOT NULL,
  saved_at   TIMESTAMP DEFAULT NOW(),
  saved_by   TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS agent_snapshots (
  id            SERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(agent_gid) ON DELETE CASCADE,
  snapshot_at   TIMESTAMPTZ NOT NULL,
  version_label TEXT NOT NULL,
  changed_by    TEXT NOT NULL,
  note          TEXT,
  config_json   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_snapshots_agent_id ON agent_snapshots(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_snapshots_at       ON agent_snapshots(agent_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS agent_annotations (
  id         SERIAL PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(agent_gid) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','danger')),
  tags       TEXT[] NOT NULL DEFAULT '{}',
  author     TEXT NOT NULL DEFAULT 'You',
  pinned     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_annotations_agent_id ON agent_annotations(agent_id);

-- ─── WORKFLOW / GRAPH ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_edges (
  id            SERIAL PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id   TEXT NOT NULL,
  edge_type     TEXT NOT NULL DEFAULT 'flow'
);

-- ─── EVENT ORDERING / CONFLICTS ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conflicts (
  id              TEXT PRIMARY KEY,
  severity        TEXT NOT NULL,
  event           TEXT NOT NULL,
  agent_a         TEXT NOT NULL,
  agent_b         TEXT NOT NULL,
  detail          TEXT NOT NULL,
  fix             TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  acknowledged_by TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);
ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
DO $$ BEGIN
  ALTER TABLE conflicts
    ADD CONSTRAINT conflicts_status_check CHECK (status IN ('open','ack','resolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── AUDIT / OPERATIONS ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  username   TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  env        TEXT NOT NULL,
  result     TEXT NOT NULL,
  tone       TEXT NOT NULL,
  note       TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  cron       TEXT NOT NULL,
  last_run   TEXT,
  duration   TEXT,
  trend      TEXT NOT NULL DEFAULT 'flat',
  health     TEXT NOT NULL DEFAULT 'green',
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_events (
  id         SERIAL PRIMARY KEY,
  ts         TEXT NOT NULL,
  evt        TEXT NOT NULL,
  gid        TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  ms         INTEGER NOT NULL DEFAULT 0,
  ok         BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS overview_metrics (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  sub   TEXT
);

-- ─── DIFF / PROMOTION ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_diffs (
  id          TEXT PRIMARY KEY,
  prod_ver    TEXT NOT NULL,
  test_ver    TEXT NOT NULL,
  insight     TEXT NOT NULL,
  warning     TEXT,
  conflict_id TEXT,
  rows        JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ─── TESTING ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS regression_tests (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  expect_text TEXT NOT NULL,
  result      TEXT NOT NULL DEFAULT 'pass',
  got_text    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ─── EXECUTION REPLAY ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trace_runs (
  id           SERIAL PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  shipment_gid TEXT NOT NULL,
  env          TEXT NOT NULL DEFAULT 'PROD',
  started      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_ms     INTEGER NOT NULL DEFAULT 0,
  health       TEXT NOT NULL DEFAULT 'green',
  status       TEXT NOT NULL DEFAULT 'ok',
  status_label TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trace_steps (
  id           SERIAL PRIMARY KEY,
  trace_run_id INTEGER NOT NULL REFERENCES trace_runs(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  io           TEXT NOT NULL DEFAULT '',
  start_ms     INTEGER NOT NULL DEFAULT 0,
  dur_ms       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ok',
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ─── ADMIN ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#2C5EA8',
  permissions JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS admin_users (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email        TEXT NOT NULL,
  role_id      TEXT NOT NULL,
  sso_provider TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sso_connections (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'disconnected',
  tenant_url    TEXT,
  client_id     TEXT,
  attribute_map JSONB NOT NULL DEFAULT '{}',
  last_tested   TIMESTAMPTZ,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked      BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS global_config (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL,
  dev_value   TEXT NOT NULL,
  test_value  TEXT NOT NULL,
  prod_value  TEXT NOT NULL,
  sensitive   BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  TEXT
);

-- ─── SESSION / AUTH (retained for compatibility) ──────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);
