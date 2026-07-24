'use strict';
/**
 * scripts/enrich.js
 * -----------------
 * Additive enrichment — does NOT truncate existing data.
 * Safe to re-run: all inserts use ON CONFLICT DO NOTHING or guard checks.
 *
 * What this does:
 *  1. Adds 12 new production-grade OTM agents
 *  2. Adds reads / writes / conditions / actions for every new agent
 *  3. Adds workflow edges connecting new agents to the existing graph
 *  4. Adds 3 new real conflicts (C-009..C-011)
 *  5. Adds 6 new agent_diffs (Compare screen)
 *  6. Back-fills agent_snapshots for every agent that has none (26 agents)
 *  7. Back-fills trace_runs + trace_steps for every agent missing them
 *  8. Back-fills regression_tests for every agent missing them
 *  9. Refreshes overview_metrics to match actual row counts
 * 10. Adds audit log entries for new agent promotions
 */

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false } : false
});

async function q(sql, params) {
  const c = await pool.connect();
  try { return (await c.query(sql, params)).rows; }
  finally { c.release(); }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function insertAgent(a) {
  await q(`INSERT INTO agents(id,name,domain,type,version,owner,trigger_name,evt,priority,success_rate,health,gx,gy)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
    [a.id,a.name,a.domain,a.type,a.version,a.owner,a.trigger_name,a.evt,
     a.priority,a.success_rate,a.health,a.gx,a.gy]);
}

async function insertReads(agentId, fields) {
  const existing = await q('SELECT field_name FROM agent_reads WHERE agent_id=$1',[agentId]);
  const have = new Set(existing.map(r=>r.field_name));
  for (let i=0;i<fields.length;i++)
    if (!have.has(fields[i]))
      await q('INSERT INTO agent_reads(agent_id,field_name,sort_order) VALUES($1,$2,$3)',[agentId,fields[i],i]);
}

async function insertWrites(agentId, fields) {
  const existing = await q('SELECT field_name FROM agent_writes WHERE agent_id=$1',[agentId]);
  const have = new Set(existing.map(r=>r.field_name));
  for (let i=0;i<fields.length;i++)
    if (!have.has(fields[i]))
      await q('INSERT INTO agent_writes(agent_id,field_name,sort_order) VALUES($1,$2,$3)',[agentId,fields[i],i]);
}

async function insertConditions(agentId, texts) {
  const existing = await q('SELECT condition_text FROM agent_conditions WHERE agent_id=$1',[agentId]);
  const have = new Set(existing.map(r=>r.condition_text));
  for (let i=0;i<texts.length;i++)
    if (!have.has(texts[i]))
      await q('INSERT INTO agent_conditions(agent_id,condition_text,sort_order) VALUES($1,$2,$3)',[agentId,texts[i],i]);
}

async function insertActions(agentId, texts) {
  const existing = await q('SELECT action_text FROM agent_actions WHERE agent_id=$1',[agentId]);
  const have = new Set(existing.map(r=>r.action_text));
  for (let i=0;i<texts.length;i++)
    if (!have.has(texts[i]))
      await q('INSERT INTO agent_actions(agent_id,action_text,sort_order) VALUES($1,$2,$3)',[agentId,texts[i],i]);
}

async function insertEdge(from, to, type) {
  const ex = await q('SELECT 1 FROM workflow_edges WHERE from_agent_id=$1 AND to_agent_id=$2',[from,to]);
  if (!ex.length) await q('INSERT INTO workflow_edges(from_agent_id,to_agent_id,edge_type) VALUES($1,$2,$3)',[from,to,type]);
}

// ─── 1. New agents ─────────────────────────────────────────────────────────────
async function seedNewAgents() {
  console.log('\n[enrich] Inserting new agents…');
  const agents = [
    // Pre-release validation column (gx = -230)
    { id:'AG-ORD-ORDERVAL',   name:'Order Entry Validator',
      domain:'Order Release',         type:'Compliance',  version:'v1.2.0',
      owner:'s.patel',   trigger_name:'Order Entered',              evt:'ORDER_ENTERED',
      priority:'Critical', success_rate:99.4, health:'green', gx:-230, gy:64 },
    { id:'AG-COMP-EXPORTLIC', name:'Export License Validator',
      domain:'Compliance & Customs',  type:'Compliance',  version:'v2.0.1',
      owner:'c.morales', trigger_name:'Order Released',             evt:'ORDER_RELEASED',
      priority:'Critical', success_rate:99.8, health:'green', gx:-230, gy:212 },

    // Extending Order Release column (gx = 50)
    { id:'AG-ORD-CONSOL',     name:'LTL Consolidation Engine',
      domain:'Order Release',         type:'Planning',    version:'v2.3.0',
      owner:'r.nguyen',  trigger_name:'Order Released',             evt:'ORDER_RELEASED',
      priority:'High',   success_rate:94.6, health:'amber', gx:50,   gy:952 },
    { id:'AG-RATE-SPOTBID',   name:'Spot Rate Bid Manager',
      domain:'Order Release',         type:'Rating',      version:'v1.0.4',
      owner:'s.patel',   trigger_name:'Spot Rate Requested',        evt:'SPOT_RATE_REQUEST',
      priority:'High',   success_rate:88.3, health:'amber', gx:50,   gy:1100 },
    { id:'AG-RATE-ACCESSORIAL','name':'Accessorial Charge Calculator',
      domain:'Order Release',         type:'Rating',      version:'v3.1.2',
      owner:'s.patel',   trigger_name:'Rate Applied',               evt:'RATE_APPLIED',
      priority:'Medium', success_rate:97.1, health:'green', gx:50,   gy:1248 },

    // Extending Shipment Execution column (gx = 330)
    { id:'AG-SHIP-COSTALLOC', name:'Cost Allocation Engine',
      domain:'Shipment Execution',    type:'Finance',     version:'v1.4.0',
      owner:'d.kim',     trigger_name:'Shipment Confirmed',         evt:'SHIPMENT_CONFIRMED',
      priority:'Medium', success_rate:96.2, health:'green', gx:330,  gy:1248 },
    { id:'AG-SHIP-CARRPERF',  name:'Carrier Scorecard Updater',
      domain:'Shipment Execution',    type:'Analytics',   version:'v2.0.0',
      owner:'a.okafor',  trigger_name:'Shipment Delivered',         evt:'SHIPMENT_DELIVERED',
      priority:'Low',    success_rate:98.5, health:'green', gx:330,  gy:1396 },

    // Extending Invoice & Finance column (gx = 610)
    { id:'AG-INV-ACCRUAL',    name:'Freight Cost Accrual Agent',
      domain:'Invoice & Finance',     type:'Finance',     version:'v1.1.0',
      owner:'d.kim',     trigger_name:'Shipment Confirmed',         evt:'SHIPMENT_CONFIRMED',
      priority:'Medium', success_rate:99.2, health:'green', gx:610,  gy:804 },
    { id:'AG-INV-DISPUTE',    name:'Invoice Dispute Manager',
      domain:'Invoice & Finance',     type:'Invoice',     version:'v1.3.1',
      owner:'d.kim',     trigger_name:'Invoice Disputed',           evt:'INVOICE_DISPUTED',
      priority:'High',   success_rate:91.7, health:'amber', gx:610,  gy:952 },

    // Extending Capacity & Yard column (gx = 890)
    { id:'AG-CAP-LOADPLAN',   name:'Load Planning Optimizer',
      domain:'Capacity & Yard',       type:'Planning',    version:'v2.1.3',
      owner:'l.tran',    trigger_name:'Shipment Planned',           evt:'SHIPMENT_PLANNED',
      priority:'High',   success_rate:95.8, health:'green', gx:890,  gy:656 },

    // Extending Oracle AI column (gx = 1170)
    { id:'AG-AI-LANEOPT',     name:'Lane Optimization Model',
      domain:'Oracle AI',             type:'AI',          version:'v0.9-beta',
      owner:'r.nguyen',  trigger_name:'Lane Review Triggered',      evt:'LANE_REVIEW_TRIGGERED',
      priority:'Low',    success_rate:82.1, health:'amber', gx:1170, gy:804 },
    { id:'AG-AI-CARRCHURN',   name:'Carrier Churn Risk Predictor',
      domain:'Oracle AI',             type:'AI',          version:'v1.0.2',
      owner:'r.nguyen',  trigger_name:'Carrier Scorecard Updated',  evt:'CARRIER_SCORECARD_UPDATED',
      priority:'Low',    success_rate:79.4, health:'red',   gx:1170, gy:952 },
  ];
  for (const a of agents) await insertAgent(a);
  console.log('[enrich] New agents: ' + agents.length);
}

// ─── 2. Reads / Writes / Conditions / Actions for new agents ──────────────────
async function seedNewAgentData() {
  console.log('\n[enrich] Inserting reads/writes/conditions/actions…');

  const data = {
    'AG-ORD-ORDERVAL': {
      reads: ['ORDER_RELEASE_GID','SHIP_FROM_LOCATION_GID','SHIP_TO_LOCATION_GID',
              'ORDER_MOVEMENT_GID','EARLIEST_SHIP_DATE','LATEST_DELIVERY_DATE',
              'TOTAL_WEIGHT_KG','SERVICE_LEVEL_GID','SHIPPER_PARTY_GID'],
      writes:['ORDER_VALIDATION_STATUS','VALIDATION_ERROR_CODE','VALIDATED_AT_TS'],
      conds: ["ORDER_RELEASE.status = 'ENTERED'",
              'SHIP_FROM_LOCATION_GID is not null',
              'SHIP_TO_LOCATION_GID is not null',
              'TOTAL_WEIGHT_KG > 0',
              'EARLIEST_SHIP_DATE <= LATEST_DELIVERY_DATE'],
      acts:  ['validateShipperAddress(SHIP_FROM_LOCATION_GID)',
              'validateConsigneeAddress(SHIP_TO_LOCATION_GID)',
              'checkDateFeasibility(EARLIEST_SHIP_DATE, LATEST_DELIVERY_DATE)',
              'verifyServiceLevelAvailability(SERVICE_LEVEL_GID, LANE_GID)',
              "writeValidationStatus(ORDER_RELEASE_GID, STATUS='VALID')",
              "emitEvent('ORDER_VALIDATED', ORDER_RELEASE_GID)"],
    },
    'AG-COMP-EXPORTLIC': {
      reads: ['ORDER_RELEASE_GID','COMMODITY_GID','ECCN_CODE',
              'DEST_COUNTRY_CODE3','CONSIGNEE_PARTY_GID',
              'EXPORT_LICENSE_GID','COMMODITY_CONTROLLED_FLG'],
      writes:['EXPORT_LICENSE_STATUS','LICENSE_NUMBER','LICENSE_CLEARED_FLG',
              'LICENSE_EXPIRY_DATE'],
      conds: ["COMMODITY_CONTROLLED_FLG = 'Y'",
              'ECCN_CODE is not null',
              'DEST_COUNTRY_CODE3 is not null',
              "DEST_COUNTRY_CODE3 != 'USA'",
              "ORDER_RELEASE.transport_mode IN ('Ocean','Air','Rail')"],
      acts:  ['validateExportLicense(ORDER_RELEASE_GID, ECCN_CODE)',
              'checkCountryRestrictions(DEST_COUNTRY_CODE3, ECCN_CODE)',
              'verifyLicenseExpiry(EXPORT_LICENSE_GID)',
              "writeLicenseStatus(ORDER_RELEASE_GID, STATUS='CLEARED')",
              "emitEvent('EXPORT_LICENSE_CLEARED', ORDER_RELEASE_GID)"],
    },
    'AG-ORD-CONSOL': {
      reads: ['ORDER_MOVEMENT_GID','DEST_ZONE_GID','SHIP_DATE',
              'TOTAL_WEIGHT_KG','SERVICE_LEVEL_GID','CONSOLIDATION_POOL_GID',
              'TRANSPORT_MODE_GID'],
      writes:['CONSOLIDATED_ORDER_SET_GID','CONSOLIDATION_SAVINGS_USD',
              'CONSOLIDATION_STATUS','STOP_SEQUENCE'],
      conds: ["ORDER_MOVEMENT.transport_mode = 'LTL'",
              'DEST_ZONE_GID is not null',
              'TOTAL_WEIGHT_KG < 10000',
              'CONSOLIDATION_POOL_GID is not null',
              'SHIP_DATE within 48h consolidation window'],
      acts:  ['findConsolidationPartners(ORDER_MOVEMENT_GID, DEST_ZONE_GID)',
              'computeConsolidationSavings(ORDER_MOVEMENT_GIDs[])',
              'optimizeStopSequence(CONSOLIDATED_ORDER_SET_GID)',
              'writeConsolidationGroup(CONSOLIDATED_ORDER_SET_GID)',
              "emitEvent('ORDERS_CONSOLIDATED', CONSOLIDATED_ORDER_SET_GID)"],
    },
    'AG-RATE-SPOTBID': {
      reads: ['ORDER_MOVEMENT_GID','ORIGIN_LOCATION_GID','DEST_LOCATION_GID',
              'EQUIPMENT_TYPE_GID','PICKUP_DATE','DELIVERY_DATE',
              'SPOT_RATE_CARRIER_LIST[]','CONTRACT_RATE_AVAILABLE_FLG'],
      writes:['SPOT_BID_GID','WINNING_BID_AMOUNT_USD','SPOT_CARRIER_GID',
              'SPOT_BID_EXPIRY_TS','SPOT_BID_STATUS'],
      conds: ["SPOT_RATE_REQUIRED_FLG = 'Y'",
              "CONTRACT_RATE_AVAILABLE_FLG = 'N'",
              'SPOT_RATE_CARRIER_LIST is not null',
              'PICKUP_DATE >= NOW() + INTERVAL 4 HOURS'],
      acts:  ['broadcastBidRequest(ORDER_MOVEMENT_GID, SPOT_RATE_CARRIER_LIST[])',
              'collectCarrierBids(BID_WINDOW_MINS=60)',
              'selectWinningBid(MIN_COST, MAX_TRANSIT_DAYS)',
              'writeSpotBid(SPOT_BID_GID, WINNING_BID_AMOUNT_USD)',
              "emitEvent('SPOT_BID_ACCEPTED', ORDER_MOVEMENT_GID)"],
    },
    'AG-RATE-ACCESSORIAL': {
      reads: ['SHIPMENT_GID','RATE_GID','ACCESSORIAL_CODE[]',
              'FUEL_SURCHARGE_RATE','RESIDENTIAL_DELIVERY_FLG',
              'LIFTGATE_REQUIRED_FLG','INSIDE_DELIVERY_FLG'],
      writes:['ACCESSORIAL_CHARGE_GID','ACCESSORIAL_TOTAL_USD',
              'ADJUSTED_FREIGHT_COST_USD','FUEL_SURCHARGE_AMOUNT_USD'],
      conds: ['RATE_GID is not null',
              'ACCESSORIAL_CODE is not null',
              "SHIPMENT.transport_mode IN ('LTL','FTL','Parcel')",
              'FUEL_SURCHARGE_RATE > 0'],
      acts:  ['computeFuelSurcharge(RATE_GID, FUEL_SURCHARGE_RATE)',
              'applyResidentialCharge(SHIPMENT_GID, RESIDENTIAL_DELIVERY_FLG)',
              'applyLiftgateCharge(SHIPMENT_GID, LIFTGATE_REQUIRED_FLG)',
              'applyInsideDeliveryCharge(SHIPMENT_GID, INSIDE_DELIVERY_FLG)',
              'writeAccessorialCharges(ACCESSORIAL_CHARGE_GID, ACCESSORIAL_TOTAL_USD)',
              "emitEvent('ACCESSORIALS_APPLIED', SHIPMENT_GID)"],
    },
    'AG-SHIP-COSTALLOC': {
      reads: ['SHIPMENT_GID','FREIGHT_COST_USD','COST_CENTER_GID[]',
              'SHIP_UNIT_GID[]','ALLOCATION_BASIS_CODE','GL_PERIOD_GID'],
      writes:['COST_ALLOCATION_GID','ALLOCATED_AMOUNT_USD',
              'COST_CENTER_POSTING_GID','ALLOCATION_STATUS'],
      conds: ["SHIPMENT.status = 'CONFIRMED'",
              'COST_CENTER_GID is not null',
              'FREIGHT_COST_USD > 0',
              "ALLOCATION_BASIS_CODE IN ('WEIGHT','VOLUME','VALUE','EQUAL')"],
      acts:  ['computeAllocationSplit(FREIGHT_COST_USD, SHIP_UNIT_GIDs[], ALLOCATION_BASIS_CODE)',
              'postToCostCenter(COST_CENTER_GID, ALLOCATED_AMOUNT_USD, GL_PERIOD_GID)',
              'writeCostAllocation(COST_ALLOCATION_GID)',
              "emitEvent('COSTS_ALLOCATED', SHIPMENT_GID)"],
    },
    'AG-SHIP-CARRPERF': {
      reads: ['SHIPMENT_GID','CARRIER_GID','SCHEDULED_DELIVERY_DATE',
              'ACTUAL_DELIVERY_DATE','EXCEPTION_COUNT',
              'INVOICE_VARIANCE_PCT','TENDER_ACCEPTANCE_RATE'],
      writes:['CARRIER_SCORE_UPDATE_GID','ON_TIME_DELIVERY_PCT',
              'CARRIER_OVERALL_SCORE','SCORECARD_PERIOD'],
      conds: ["SHIPMENT.status = 'DELIVERED'",
              'CARRIER_GID is not null',
              'ACTUAL_DELIVERY_DATE is not null',
              "SCORECARD_PERIOD IN ('ROLLING_30D','ROLLING_90D')"],
      acts:  ['computeOnTimePct(SCHEDULED_DELIVERY_DATE, ACTUAL_DELIVERY_DATE)',
              "computeExceptionRate(CARRIER_GID, PERIOD='ROLLING_30D')",
              'computeTenderAcceptanceRate(CARRIER_GID)',
              'updateCarrierScorecard(CARRIER_GID, SCORES)',
              "emitEvent('CARRIER_SCORECARD_UPDATED', CARRIER_GID)"],
    },
    'AG-INV-ACCRUAL': {
      reads: ['SHIPMENT_GID','ESTIMATED_FREIGHT_COST_USD','GL_ACCOUNT_GID',
              'ACCOUNTING_PERIOD','ACCRUAL_METHOD_CODE','COST_CENTER_GID'],
      writes:['ACCRUAL_ENTRY_GID','ACCRUED_AMOUNT_USD',
              'GL_POSTING_STATUS','ACCRUAL_REVERSAL_DATE'],
      conds: ["SHIPMENT.status = 'CONFIRMED'",
              'GL_ACCOUNT_GID is not null',
              'ESTIMATED_FREIGHT_COST_USD > 0',
              'ACCOUNTING_PERIOD is not null',
              "ACCRUAL_ALREADY_POSTED_FLG = 'N'"],
      acts:  ['computeAccrualAmount(ESTIMATED_FREIGHT_COST_USD, ACCRUAL_METHOD_CODE)',
              'postAccrualEntry(GL_ACCOUNT_GID, ACCRUED_AMOUNT_USD, ACCOUNTING_PERIOD)',
              'scheduleReversalEntry(ACCRUAL_ENTRY_GID, ACCRUAL_REVERSAL_DATE)',
              'writeAccrualRecord(ACCRUAL_ENTRY_GID)',
              "emitEvent('ACCRUAL_POSTED', SHIPMENT_GID)"],
    },
    'AG-INV-DISPUTE': {
      reads: ['INVOICE_GID','DISPUTE_REASON_CODE','DISPUTE_AMOUNT_USD',
              'CARRIER_GID','DISPUTE_INITIATOR_GID',
              'CONTRACTED_RATE_GID','INVOICE_AUDIT_REPORT_GID'],
      writes:['DISPUTE_CASE_GID','DISPUTE_STATUS',
              'RESOLUTION_AMOUNT_USD','DISPUTE_RESOLVED_TS'],
      conds: ["INVOICE.status = 'DISPUTED'",
              'DISPUTE_REASON_CODE is not null',
              'DISPUTE_AMOUNT_USD > 0',
              'CARRIER_GID is not null',
              "DISPUTE_AGE_DAYS <= MAX_DISPUTE_WINDOW_DAYS (90)"],
      acts:  ['createDisputeCase(INVOICE_GID, DISPUTE_REASON_CODE)',
              'notifyCarrier(CARRIER_GID, DISPUTE_NOTIFICATION_TEMPLATE)',
              'reconcileWithContract(INVOICE_GID, CONTRACTED_RATE_GID)',
              'writeDisputeResolution(DISPUTE_CASE_GID, RESOLUTION_AMOUNT_USD)',
              "emitEvent('DISPUTE_RESOLVED', INVOICE_GID)"],
    },
    'AG-CAP-LOADPLAN': {
      reads: ['SHIPMENT_GID','SHIP_UNIT_GID[]','EQUIPMENT_TYPE_GID',
              'LOAD_WEIGHT_KG','LOAD_VOLUME_M3',
              'HAZMAT_SEPARATION_REQUIRED_FLG','TEMP_CONTROLLED_FLG'],
      writes:['LOAD_PLAN_GID','LOAD_SEQUENCE','EQUIPMENT_UTILIZATION_PCT',
              'LOAD_PLAN_APPROVED_FLG'],
      conds: ["SHIPMENT.status = 'PLANNED'",
              'SHIP_UNIT_GID is not null',
              'EQUIPMENT_TYPE_GID is not null',
              'LOAD_WEIGHT_KG > 0'],
      acts:  ['computeLoadSequence(SHIP_UNIT_GIDs[], EQUIPMENT_TYPE_GID)',
              'checkHazmatSeparation(SHIP_UNIT_GIDs[], HAZMAT_SEPARATION_REQUIRED_FLG)',
              'optimizeEquipmentUtilization(LOAD_WEIGHT_KG, LOAD_VOLUME_M3, EQUIPMENT_TYPE_GID)',
              'writeLoadPlan(LOAD_PLAN_GID, LOAD_SEQUENCE)',
              "emitEvent('LOAD_PLAN_APPROVED', SHIPMENT_GID)"],
    },
    'AG-AI-LANEOPT': {
      reads: ['LANE_GID','HISTORICAL_SHIPMENT_DATA_GID','CARRIER_SCORE_VECTOR',
              'LANE_VOLUME_QTY','CONTRACTED_RATE_GID',
              'SPOT_RATE_BASELINE_USD','LANE_TRANSIT_DAYS_AVG'],
      writes:['LANE_RECOMMENDATION_GID','OPTIMAL_CARRIER_GID',
              'PROJECTED_SAVINGS_USD','OPTIMIZATION_CONFIDENCE_PCT'],
      conds: ['LANE_GID is not null',
              'HISTORICAL_SHIPMENT_QTY >= 30',
              "LANE_REVIEW_PERIOD = 'QUARTERLY'",
              'CARRIER_SCORE_VECTOR is not null'],
      acts:  ["analyzeHistoricalLanePerformance(LANE_GID, PERIOD='ROLLING_90D')",
              'scoreCarrierFit(CARRIER_SCORE_VECTOR, LANE_GID)',
              'computeProjectedSavings(CONTRACTED_RATE_GID, OPTIMAL_CARRIER_GID)',
              'writeLaneRecommendation(LANE_GID, OPTIMAL_CARRIER_GID)',
              "emitEvent('LANE_OPTIMIZED', LANE_GID)"],
    },
    'AG-AI-CARRCHURN': {
      reads: ['CARRIER_GID','ON_TIME_DELIVERY_PCT','CARRIER_OVERALL_SCORE',
              'TENDER_ACCEPTANCE_RATE','CAPACITY_REDUCTION_SIGNAL',
              'LANE_COVERAGE_PCT'],
      writes:['CHURN_RISK_SCORE','CHURN_RISK_TIER',
              'CHURN_ALERT_GID','BACKUP_CARRIER_GID'],
      conds: ['CARRIER_GID is not null',
              "ROLLING_30D_DATA_AVAILABLE = 'Y'",
              'CARRIER_OVERALL_SCORE is not null',
              'TENDER_ACCEPTANCE_RATE is not null'],
      acts:  ['computeChurnProbability(CARRIER_GID, FEATURES[])',
              "classifyRiskTier(CHURN_RISK_SCORE, TIERS=['LOW','MEDIUM','HIGH','CRITICAL'])",
              'identifyBackupCarrier(CARRIER_GID, LANE_GIDs[])',
              'writeChurnAlert(CARRIER_GID, CHURN_RISK_TIER, BACKUP_CARRIER_GID)',
              "emitEvent('CHURN_RISK_ASSESSED', CARRIER_GID)"],
    },
  };

  for (const [id, d] of Object.entries(data)) {
    await insertReads(id, d.reads);
    await insertWrites(id, d.writes);
    await insertConditions(id, d.conds);
    await insertActions(id, d.acts);
  }
  console.log('[enrich] Agent data seeded for', Object.keys(data).length, 'new agents');
}

// ─── 3. Workflow edges ─────────────────────────────────────────────────────────
async function seedEdges() {
  console.log('\n[enrich] Inserting workflow edges…');
  const edges = [
    // Pre-release → Order Release
    ['AG-ORD-ORDERVAL',   'AG-ORD-RATESVC',       'flow'],
    ['AG-ORD-ORDERVAL',   'AG-ORD-CREDITHOLD',     'flow'],
    ['AG-ORD-ORDERVAL',   'AG-ORD-HAZMATVAL',      'flow'],
    ['AG-COMP-EXPORTLIC', 'AG-ORD-RATESVC',        'flow'],
    // Order consolidation
    ['AG-ORD-RATESVC',    'AG-ORD-CONSOL',         'flow'],
    ['AG-ORD-CONSOL',     'AG-SHIP-AUTOTENDER',    'flow'],
    // Spot rate path
    ['AG-RATE-SPOTBID',   'AG-SHIP-AUTOTENDER',    'flow'],
    // Accessorials
    ['AG-ORD-RATESVC',    'AG-RATE-ACCESSORIAL',   'flow'],
    ['AG-RATE-ACCESSORIAL','AG-SHIP-AUTOTENDER',   'flow'],
    // Load planning
    ['AG-SHIP-AUTOTENDER','AG-CAP-LOADPLAN',       'flow'],
    ['AG-CAP-LOADPLAN',   'AG-SHIP-DOCGEN',        'flow'],
    // Cost allocation + accrual
    ['AG-SHIP-TENDERRESP','AG-SHIP-COSTALLOC',     'flow'],
    ['AG-SHIP-TENDERRESP','AG-INV-ACCRUAL',        'flow'],
    ['AG-SHIP-COSTALLOC', 'AG-INV-ACCRUAL',        'flow'],
    // Carrier performance scorecard
    ['AG-SHIP-MILESTONEUPD','AG-SHIP-CARRPERF',    'flow'],
    ['AG-SHIP-CARRPERF',  'AG-AI-CARRCHURN',       'ai' ],
    ['AG-SHIP-CARRPERF',  'AG-AI-LANEOPT',         'ai' ],
    // Invoice dispute
    ['AG-INV-FRTAUDIT',   'AG-INV-DISPUTE',        'flow'],
    ['AG-INV-VARIANCE',   'AG-INV-DISPUTE',        'flow'],
    // Lane optimizer feeds back to carrier rank
    ['AG-AI-LANEOPT',     'AG-AI-CARRIERRANK',     'ai' ],
    // Carrier churn feeds upstream
    ['AG-AI-CARRCHURN',   'AG-AI-CARRIERRANK',     'ai' ],
  ];
  for (const [f,t,type] of edges) await insertEdge(f,t,type);
  console.log('[enrich] Edges inserted:', edges.length);
}

// ─── 4. New conflicts ──────────────────────────────────────────────────────────
async function seedConflicts() {
  console.log('\n[enrich] Inserting new conflicts…');
  const conflicts = [
    { id:'C-009', severity:'critical', event:'ORDER_RELEASED',
      agent_a:'AG-ORD-ORDERVAL', agent_b:'AG-COMP-EXPORTLIC',
      detail:'AG-ORD-ORDERVAL writes ORDER_VALIDATION_STATUS and AG-COMP-EXPORTLIC reads it before proceeding to license check. When both agents fire on ORDER_RELEASED in parallel (no guaranteed ordering), EXPORTLIC occasionally reads a NULL validation status and defaults to CLEARED — bypassing the validation gate entirely on cross-border shipments.',
      fix:'Chain EXPORTLIC to listen on ORDER_VALIDATED event emitted by ORDERVAL rather than ORDER_RELEASED directly. This serialises the two agents and eliminates the NULL-read race.' },
    { id:'C-010', severity:'warning', event:'SHIPMENT_CONFIRMED',
      agent_a:'AG-SHIP-COSTALLOC', agent_b:'AG-INV-ACCRUAL',
      detail:'Both COSTALLOC and ACCRUAL trigger on SHIPMENT_CONFIRMED and both write to the same GL period. When ESTIMATED_FREIGHT_COST_USD differs from the cost-centre split total by more than 0.01% (rounding), the accrual entry and the allocation entry are misaligned, causing a GL out-of-balance exception on period close. Observed in 1.8% of multi-stop shipments.',
      fix:'Introduce a shared COST_REFERENCE_GID written by COSTALLOC and read by ACCRUAL so both use the same authoritative freight cost figure. ACCRUAL should fire on COSTS_ALLOCATED not SHIPMENT_CONFIRMED.' },
    { id:'C-011', severity:'warning', event:'CARRIER_SCORECARD_UPDATED',
      agent_a:'AG-AI-CARRCHURN', agent_b:'AG-SHIP-CARRPERF',
      detail:'CARRCHURN reads CARRIER_OVERALL_SCORE written by CARRPERF. Because CARRPERF writes incrementally (one shipment at a time) and CARRCHURN triggers on each CARRIER_SCORECARD_UPDATED event, CARRCHURN may compute a churn probability from a partially-updated score mid-batch, inflating churn alerts by up to 22% during the nightly batch window (02:00–04:00).',
      fix:'Add a SCORECARD_BATCH_COMPLETE_FLG written by CARRPERF at end-of-batch. Gate CARRCHURN on that flag rather than per-event firing to ensure it always reads a fully settled score.' },
  ];
  for (const c of conflicts) {
    await q(`INSERT INTO conflicts(id,severity,event,agent_a,agent_b,detail,fix,acknowledged)
      VALUES($1,$2,$3,$4,$5,$6,$7,false) ON CONFLICT(id) DO NOTHING`,
      [c.id,c.severity,c.event,c.agent_a,c.agent_b,c.detail,c.fix]);
  }
  console.log('[enrich] Conflicts inserted:', conflicts.length);
}

// ─── 5. Agent diffs ────────────────────────────────────────────────────────────
async function seedDiffs() {
  console.log('\n[enrich] Inserting agent diffs…');
  const diffs = [
    { id:'DIFF-CONSOL-PT',
      prod_ver:'v2.2.1', test_ver:'v2.3.0',
      insight:'TEST adds stop-sequence optimisation using a nearest-neighbour heuristic. On 30-day simulation vs PROD baseline, average pool cost drops 6.4% with no change to on-time delivery SLA. Requires DEST_ZONE_GID to be populated on all ORDER_MOVEMENTs — currently ~8% of records have null zone.',
      warning:'Null DEST_ZONE_GID records will fall through to single-stop behaviour in TEST. Confirm zone-enrichment job JOB-ZONE-SYNC is complete before promoting v2.3.0.',
      conflict_id:null,
      rows: JSON.stringify([
        {step:'Condition 1',l:{t:'same',txt:"ORDER_MOVEMENT.transport_mode = 'LTL'"},r:{t:'same',txt:"ORDER_MOVEMENT.transport_mode = 'LTL'"}},
        {step:'Condition 2',l:{t:'none',txt:''},r:{t:'add',txt:'DEST_ZONE_GID is not null'}},
        {step:'Action 2',l:{t:'mod',txt:'writeConsolidationGroup(CONSOLIDATED_ORDER_SET_GID)'},r:{t:'mod',txt:'optimizeStopSequence(CONSOLIDATED_ORDER_SET_GID) → writeConsolidationGroup(CONSOLIDATED_ORDER_SET_GID)'}},
        {step:'Action 3',l:{t:'same',txt:"emitEvent('ORDERS_CONSOLIDATED', CONSOLIDATED_ORDER_SET_GID)"},r:{t:'same',txt:"emitEvent('ORDERS_CONSOLIDATED', CONSOLIDATED_ORDER_SET_GID)"}},
      ])
    },
    { id:'DIFF-CARRRANK-PT',
      prod_ver:'v3.0.1', test_ver:'v3.1.0-rc2',
      insight:'TEST introduces a real-time capacity signal feed from CARRIER_CAPACITY_API. When a carrier signals low capacity (< 20% headroom), their rank score is penalised by 0.35 sigma. Backtested on 90-day history: tender acceptance rate improves 4.1% and re-tender rate drops from 6.8% to 4.2%.',
      warning:'Requires a new API credential (CARRIER_CAPACITY_API_KEY) to be provisioned in PROD before promotion. If the API is unavailable, the agent silently falls back to historical score — add a monitoring alert for API timeout.',
      conflict_id:'C-002',
      rows: JSON.stringify([
        {step:'Read 1',l:{t:'same',txt:'CARRIER_SCORE_VECTOR'},r:{t:'same',txt:'CARRIER_SCORE_VECTOR'}},
        {step:'Read 2',l:{t:'none',txt:''},r:{t:'add',txt:'CARRIER_CAPACITY_SIGNAL (live API feed)'}},
        {step:'Action 2',l:{t:'mod',txt:'scoreAndRankCarriers(CARRIER_SCORE_VECTOR)'},r:{t:'mod',txt:'scoreAndRankCarriers(CARRIER_SCORE_VECTOR, CARRIER_CAPACITY_SIGNAL)'}},
        {step:'Action 3',l:{t:'same',txt:'writeCarrierRankHint(TOP_CARRIER_GID, RANK_VECTOR)'},r:{t:'same',txt:'writeCarrierRankHint(TOP_CARRIER_GID, RANK_VECTOR)'}},
      ])
    },
    { id:'DIFF-ACCRUAL-PT',
      prod_ver:'v1.0.2', test_ver:'v1.1.0',
      insight:'TEST adds automatic reversal scheduling: the accrual entry is posted with a reversal date set to the first day of the following accounting period. This eliminates the manual GL-reversal step that currently causes a 2-day delay in period close.',
      warning:'Reversal date logic must account for period-end holidays. Confirm ACCOUNTING_CALENDAR_GID is maintained in TEST config — 3 missing entries were found during UAT.',
      conflict_id:'C-010',
      rows: JSON.stringify([
        {step:'Condition 1',l:{t:'same',txt:"SHIPMENT.status = 'CONFIRMED'"},r:{t:'same',txt:"SHIPMENT.status = 'CONFIRMED'"}},
        {step:'Condition 2',l:{t:'none',txt:''},r:{t:'add',txt:"ACCRUAL_ALREADY_POSTED_FLG = 'N'"}},
        {step:'Action 2',l:{t:'mod',txt:'postAccrualEntry(GL_ACCOUNT_GID, ACCRUED_AMOUNT_USD, ACCOUNTING_PERIOD)'},r:{t:'mod',txt:'postAccrualEntry(GL_ACCOUNT_GID, ACCRUED_AMOUNT_USD, ACCOUNTING_PERIOD) + scheduleReversalEntry(ACCRUAL_REVERSAL_DATE)'}},
        {step:'Write 1',l:{t:'same',txt:'ACCRUAL_ENTRY_GID, ACCRUED_AMOUNT_USD'},r:{t:'same',txt:'ACCRUAL_ENTRY_GID, ACCRUED_AMOUNT_USD'}},
        {step:'Write 2',l:{t:'none',txt:''},r:{t:'add',txt:'ACCRUAL_REVERSAL_DATE'}},
      ])
    },
    { id:'DIFF-EXPORTLIC-PT',
      prod_ver:'v1.9.0', test_ver:'v2.0.1',
      insight:'TEST migrates from a static restricted-country lookup table to a real-time BIS EAR API check. Latency increases from <10ms to ~320ms average, but compliance coverage improves: 7 mis-cleared shipments in the past quarter would have been caught.',
      warning:'If BIS API is down, TEST fails-safe (blocks order). PROD currently fails-open (clears order). Agree fail-safe vs fail-open policy with Legal before promoting. SLA for BIS API uptime needs to be in the contract.',
      conflict_id:'C-009',
      rows: JSON.stringify([
        {step:'Read 1',l:{t:'same',txt:'ECCN_CODE, DEST_COUNTRY_CODE3'},r:{t:'same',txt:'ECCN_CODE, DEST_COUNTRY_CODE3'}},
        {step:'Read 2',l:{t:'mod',txt:'RESTRICTED_COUNTRY_TABLE (static)'},r:{t:'mod',txt:'BIS_EAR_API (real-time)'}},
        {step:'Action 1',l:{t:'mod',txt:'checkStaticCountryList(DEST_COUNTRY_CODE3, ECCN_CODE)'},r:{t:'mod',txt:'checkBISEARAPI(DEST_COUNTRY_CODE3, ECCN_CODE) [320ms avg]'}},
        {step:'Fail mode',l:{t:'mod',txt:"On API timeout: STATUS='CLEARED' (fail-open)"},r:{t:'mod',txt:"On API timeout: STATUS='BLOCKED' (fail-safe)"}},
      ])
    },
    { id:'DIFF-SPOTBID-PT',
      prod_ver:'v1.0.3', test_ver:'v1.0.4',
      insight:'Patch release: extends bid collection window from 45 to 60 minutes and adds a counter-offer acceptance threshold (within 5% of lowest bid). In TEST simulation, carrier participation rate rises from 3.2 to 4.1 carriers per solicitation, improving price competition.',
      warning:'60-minute window adds 15 minutes to critical-path for spot shipments with same-day pickup. Confirm operations team SLA agreement before deploying to PROD.',
      conflict_id:null,
      rows: JSON.stringify([
        {step:'Action 1',l:{t:'mod',txt:'collectCarrierBids(BID_WINDOW_MINS=45)'},r:{t:'mod',txt:'collectCarrierBids(BID_WINDOW_MINS=60)'}},
        {step:'Action 2',l:{t:'same',txt:'selectWinningBid(MIN_COST, MAX_TRANSIT_DAYS)'},r:{t:'same',txt:'selectWinningBid(MIN_COST, MAX_TRANSIT_DAYS)'}},
        {step:'Action 3',l:{t:'none',txt:''},r:{t:'add',txt:'acceptCounterOffer(BID, THRESHOLD_PCT=5) if within tolerance'}},
      ])
    },
    { id:'DIFF-LOADPLAN-PT',
      prod_ver:'v2.0.1', test_ver:'v2.1.3',
      insight:'TEST adds hazmat-separation logic: incompatible UN hazard classes are placed in separate sub-compartments with a minimum 0.5m gap. 100% of sampled hazmat shipments in TEST now pass DOT separation audit vs 84% in PROD. Equipment utilisation drops slightly (–2.3%) due to reserved separation space.',
      warning:'Hazmat class incompatibility matrix is hardcoded in v2.1.3. Any changes to DOT Table 3 (expected Q4 2026) require a code update. Recommend externalising to HAZMAT_COMPAT_TABLE config.',
      conflict_id:null,
      rows: JSON.stringify([
        {step:'Condition 1',l:{t:'same',txt:"SHIPMENT.status = 'PLANNED'"},r:{t:'same',txt:"SHIPMENT.status = 'PLANNED'"}},
        {step:'Action 2',l:{t:'none',txt:''},r:{t:'add',txt:'checkHazmatSeparation(SHIP_UNIT_GIDs[], HAZMAT_SEPARATION_REQUIRED_FLG)'}},
        {step:'Action 3',l:{t:'mod',txt:'optimizeEquipmentUtilization(LOAD_WEIGHT_KG, LOAD_VOLUME_M3, EQUIPMENT_TYPE_GID)'},r:{t:'mod',txt:'optimizeEquipmentUtilization(LOAD_WEIGHT_KG, LOAD_VOLUME_M3, EQUIPMENT_TYPE_GID, HAZMAT_ZONES[])'}},
        {step:'Write 1',l:{t:'same',txt:'LOAD_PLAN_GID, LOAD_SEQUENCE'},r:{t:'same',txt:'LOAD_PLAN_GID, LOAD_SEQUENCE'}},
        {step:'Write 2',l:{t:'none',txt:''},r:{t:'add',txt:'HAZMAT_ZONE_MAP (sub-compartment assignments)'}},
      ])
    },
  ];
  for (const d of diffs) {
    await q(`INSERT INTO agent_diffs(id,prod_ver,test_ver,insight,warning,conflict_id,rows)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
      [d.id,d.prod_ver,d.test_ver,d.insight,d.warning,d.conflict_id||null,d.rows]);
  }
  console.log('[enrich] Diffs inserted:', diffs.length);
}

// ─── 6. Back-fill snapshots ────────────────────────────────────────────────────
async function seedSnapshots() {
  console.log('\n[enrich] Back-filling agent snapshots…');

  // Agents that already have snapshots
  const existing = await q('SELECT DISTINCT agent_id FROM agent_snapshots');
  const haveSnap = new Set(existing.map(r=>r.agent_id));

  // History per agent: [{ date, ver, by, note, config_fragment }]
  const histories = {
    // Existing agents missing snapshots
    'AG-ORD-BULKPLAN': [
      { d:'2026-02-10T08:00:00Z', v:'v2.8.0', by:'r.nguyen', note:'Initial bulk-plan release — sequential order grouping by DEST_ZONE_GID' },
      { d:'2026-05-01T14:00:00Z', v:'v3.0.0', by:'r.nguyen', note:'Added volume-based consolidation; pool cost estimate now uses RATE_GEO_COST_GID' },
      { d:'2026-07-05T10:00:00Z', v:'v3.0.5', by:'r.nguyen', note:'Patch: null POOL_LOAD_GID guard prevents NPE on single-order bulk plans' },
    ],
    'AG-ORD-SVCLEVSEL': [
      { d:'2026-01-15T09:00:00Z', v:'v1.9.0', by:'s.patel', note:'Original selector — priority-based service level mapping only' },
      { d:'2026-04-20T11:00:00Z', v:'v2.0.1', by:'s.patel', note:'Added effective/expiry date guard to prevent expired service level selections' },
      { d:'2026-06-18T16:00:00Z', v:'v2.1.0', by:'s.patel', note:'Multi-provider service level selection — picks lowest cost when two providers share same level' },
    ],
    'AG-ORD-LANEPREF': [
      { d:'2026-03-01T10:00:00Z', v:'v1.2.0', by:'r.nguyen', note:'Lane preference override — static scoreboard rank check only' },
      { d:'2026-06-10T14:30:00Z', v:'v1.3.0', by:'r.nguyen', note:'Added OVERRIDE_REASON_CODE requirement for audit trail; amber on missing reason' },
      { d:'2026-07-01T09:00:00Z', v:'v1.3.3', by:'r.nguyen', note:'Patch: rank <= 3 guard prevents routing to low-performing carriers without explicit override' },
    ],
    'AG-ORD-HAZMATVAL': [
      { d:'2026-01-20T08:00:00Z', v:'v1.5.0', by:'c.morales', note:'Basic hazmat class validation against DOT 49 CFR table' },
      { d:'2026-05-15T13:00:00Z', v:'v1.8.0', by:'c.morales', note:'Added packing group validation (I/II/III) and ERG number requirement' },
      { d:'2026-07-18T09:00:00Z', v:'v2.0.0', by:'c.morales', note:'ERG number validation — DOT compliance requirement effective 2026-08-01; emergency contact phone required' },
    ],
    'AG-SHIP-AUTOTENDER': [
      { d:'2026-02-14T10:00:00Z', v:'v2.2.0', by:'m.reyes', note:'Auto-tender v2 — supports multi-carrier parallel tender broadcast' },
      { d:'2026-05-20T15:00:00Z', v:'v2.3.1', by:'m.reyes', note:'Added CARRIER_CONTRACT_STATUS = ACTIVE guard; prevents tendering to suspended carriers' },
      { d:'2026-07-01T09:00:00Z', v:'v2.4.1', by:'m.reyes', note:'TENDER_EXPIRY_HOURS configurable per carrier contract; default 4h for LTL, 2h for parcel' },
    ],
    'AG-SHIP-TENDERRESP': [
      { d:'2026-03-10T11:00:00Z', v:'v1.7.0', by:'m.reyes', note:'Initial tender response handler — ACCEPTED and DECLINED states only' },
      { d:'2026-06-25T14:00:00Z', v:'v1.8.0', by:'m.reyes', note:'Added COUNTERED status; routes counter-offers to planner queue for review' },
      { d:'2026-07-11T11:00:00Z', v:'v1.9.0', by:'m.reyes', note:'EDI 990 COUNTERED status handling — resolves OTM-5441; auto-accept if within 5% of contracted rate' },
    ],
    'AG-SHIP-DOCGEN': [
      { d:'2026-01-08T09:00:00Z', v:'v2.8.0', by:'l.tran', note:'BOL and packing list generation — PDF output only' },
      { d:'2026-04-12T14:00:00Z', v:'v3.0.0', by:'l.tran', note:'Added e-label generation for parcel; LABEL_GID written to shipment' },
      { d:'2026-06-30T10:30:00Z', v:'v3.1.0', by:'l.tran', note:'DOCUMENTS_READY_FLG now gates downstream customs declaration — prevents race with AG-COMP-CUSTSDECL' },
    ],
    'AG-SHIP-TRACKUPDATE': [
      { d:'2026-02-01T10:00:00Z', v:'v2.1.0', by:'l.tran', note:'Initial track-and-trace — polling carrier API every 4 hours' },
      { d:'2026-05-10T13:00:00Z', v:'v2.2.0', by:'l.tran', note:'Switched to webhook-based event ingestion for 12 major carriers; polling retained as fallback' },
      { d:'2026-07-08T11:00:00Z', v:'v2.3.1', by:'l.tran', note:'Patch: duplicate event deduplication by TRACKING_EVENT_GID; prevents double-milestone updates' },
    ],
    'AG-SHIP-EXCEPTIONMGR': [
      { d:'2026-02-20T08:00:00Z', v:'v1.3.0', by:'a.okafor', note:'Exception capture and routing — manual planner assignment' },
      { d:'2026-05-15T14:00:00Z', v:'v1.4.0', by:'a.okafor', note:'Auto-create claims for DAMAGED exceptions; CLAIM_GID written and carrier notified' },
      { d:'2026-07-15T16:00:00Z', v:'v1.5.2', by:'a.okafor', note:'Auto-create claims for DAMAGED exceptions over $500 USD — pre-approved by finance OTM-5476' },
    ],
    'AG-SHIP-APPOINTSCHED': [
      { d:'2026-03-05T10:00:00Z', v:'v1.0.0', by:'l.tran', note:'Initial appointment scheduling — creates appointment request, awaits facility confirmation' },
      { d:'2026-06-20T13:00:00Z', v:'v1.1.0', by:'l.tran', note:'Added FACILITY_APPT_LEAD_TIME_HRS guard; warns if requested date is within lead time' },
    ],
    'AG-SHIP-MILESTONEUPD': [
      { d:'2026-01-15T09:00:00Z', v:'v2.0.0', by:'l.tran', note:'Milestone state machine — PICKUP, DEPARTURE, ARRIVAL, DELIVERED lifecycle' },
      { d:'2026-04-28T11:00:00Z', v:'v2.1.0', by:'l.tran', note:'REVISED_ETA_TS now written on every milestone update; feeds AG-AI-ETAPRED' },
      { d:'2026-07-02T14:00:00Z', v:'v2.1.3', by:'l.tran', note:'Patch: timezone normalisation to UTC for MILESTONE_TS prevents cross-timezone anomalies' },
    ],
    'AG-INV-FRTAUDIT': [
      { d:'2026-02-15T10:00:00Z', v:'v2.1.0', by:'d.kim', note:'Freight bill audit — line-item charge matching against contracted rate schedule' },
      { d:'2026-05-20T13:00:00Z', v:'v2.2.0', by:'d.kim', note:'Accessorial charge audit added; flags undisclosed fuel surcharge overcharges' },
      { d:'2026-07-06T09:00:00Z', v:'v2.2.3', by:'d.kim', note:'Patch: multi-currency invoice support — converts to USD using INVOICE_DATE FX rate' },
    ],
    'AG-INV-REMATCH': [
      { d:'2026-02-01T08:00:00Z', v:'v1.5.0', by:'d.kim', note:'Invoice rematch — exact PRO-number matching only' },
      { d:'2026-05-01T12:00:00Z', v:'v1.6.0', by:'d.kim', note:'Fuzzy PRO-number match using Levenshtein distance (threshold=2)' },
      { d:'2026-07-07T08:30:00Z', v:'v1.6.1', by:'d.kim', note:'Fuzzy PRO-number match algorithm — resolves 340 unmatched invoices backlog; confidence score written' },
    ],
    'AG-INV-VARIANCE': [
      { d:'2026-03-10T10:00:00Z', v:'v1.2.0', by:'d.kim', note:'Variance detection — fixed 5% tolerance threshold, escalate on breach' },
      { d:'2026-06-14T14:00:00Z', v:'v1.3.1', by:'d.kim', note:'Configurable tolerance per carrier tier (GOLD=3%, SILVER=5%, STANDARD=8%)' },
    ],
    'AG-INV-PAYTERM': [
      { d:'2026-02-10T09:00:00Z', v:'v1.0.0', by:'d.kim', note:'Payment terms — net-30 baseline, resolves due date from invoice date' },
      { d:'2026-06-01T11:00:00Z', v:'v1.1.2', by:'d.kim', note:'Early-pay discount logic: 2% discount if payment within 10 days, per carrier contract' },
    ],
    'AG-CAP-YARDCHECK': [
      { d:'2026-02-20T10:00:00Z', v:'v1.5.0', by:'j.santos', note:'Yard capacity check — static dock door count per facility' },
      { d:'2026-06-10T13:00:00Z', v:'v1.7.0', by:'j.santos', note:'Dynamic dock door count from FACILITY_CAPACITY_API; equipment-type compatibility added' },
      { d:'2026-07-05T09:00:00Z', v:'v1.7.2', by:'j.santos', note:'Patch: RESERVED_FLG set atomically — prevents double-booking under concurrent SHIPMENT_PLANNED events' },
    ],
    'AG-CAP-DOCKALLOC': [
      { d:'2026-03-01T08:00:00Z', v:'v1.0.0', by:'j.santos', note:'Dock door allocation — first-available slot assignment' },
      { d:'2026-06-15T14:00:00Z', v:'v1.1.0', by:'j.santos', note:'Equipment-type preference routing: reefer shipments assigned to cold-dock doors first' },
    ],
    'AG-CAP-POOLLOAD': [
      { d:'2026-02-28T10:00:00Z', v:'v2.0.0', by:'j.santos', note:'Pool load builder — groups orders by DEST_ZONE_GID and consolidation window' },
      { d:'2026-07-12T13:00:00Z', v:'v2.1.0', by:'j.santos', note:'Pool cost estimate now uses RATE_GEO_COST_GID per lane; replaces flat rate estimate' },
    ],
    'AG-CAP-WEIGHTDIM': [
      { d:'2026-01-10T09:00:00Z', v:'v2.8.0', by:'j.santos', note:'Weight and dims validation — kg/cm based; equipment max lookup from static table' },
      { d:'2026-05-18T13:00:00Z', v:'v2.9.0', by:'j.santos', note:'Dimensional weight calculation per NMFC 2024 revision (DIM factor 5000)' },
      { d:'2026-07-10T11:00:00Z', v:'v3.0.0', by:'j.santos', note:'Added dimensional weight calculation per NMFC 2025 revision; DIM factor updated 5000→4800 for ground' },
    ],
    'AG-AI-DWELL': [
      { d:'2026-03-01T10:00:00Z', v:'v0.7-beta', by:'oracle.ai', note:'Initial dwell prediction model — gradient boost, 72h historical training window' },
      { d:'2026-05-20T14:00:00Z', v:'v0.8-beta', by:'oracle.ai', note:'Extended training window to 180 days; accuracy improved from 81% to 88.4%' },
    ],
    'AG-AI-CARRIERRANK': [
      { d:'2026-02-01T10:00:00Z', v:'v2.8.0', by:'oracle.ai', note:'Carrier ranking v2 — score vector based on on-time, acceptance rate, invoice accuracy' },
      { d:'2026-05-15T14:00:00Z', v:'v3.0.0', by:'oracle.ai', note:'Neural network scorer replaces linear model; lane-specific carrier fit incorporated' },
      { d:'2026-07-20T09:00:00Z', v:'v3.0.1', by:'oracle.ai', note:'Patch: score normalisation fix prevents outlier carriers from dominating the rank vector' },
    ],
    'AG-AI-ETAPRED': [
      { d:'2026-03-15T10:00:00Z', v:'v1.0.0', by:'oracle.ai', note:'ETA prediction — linear regression on transit time by lane and carrier' },
      { d:'2026-06-20T13:00:00Z', v:'v1.1.2', by:'oracle.ai', note:'Weather signal integrated; DELAY_RISK_SCORE now accounts for severe weather events on lane' },
    ],
    'AG-AI-ANOMALY': [
      { d:'2026-04-01T10:00:00Z', v:'v1.0.0', by:'oracle.ai', note:'Anomaly detection — isolation forest on tracking event sequence; trained on 60-day baseline' },
      { d:'2026-07-01T14:00:00Z', v:'v1.1.0', by:'oracle.ai', note:'Baseline vector updated to 90-day rolling window; false positive rate drops from 8% to 3.2%' },
    ],
    'AG-AI-CAPACITYFORECAST': [
      { d:'2026-07-16T10:00:00Z', v:'v0.8-beta', by:'r.nguyen', note:'First deployment — capacity forecast model trained on PTY 180-day history; LSTM time-series model' },
    ],
    'AG-COMP-HAZMAT': [
      { d:'2026-01-20T09:00:00Z', v:'v1.8.0', by:'c.morales', note:'Hazmat compliance — class validation and placard requirement lookup' },
      { d:'2026-06-01T13:00:00Z', v:'v1.9.0', by:'c.morales', note:'ERG verification added; cross-checks emergency response guide number against UN number' },
    ],
    'AG-COMP-CUSTSDECL': [
      { d:'2026-02-15T10:00:00Z', v:'v1.5.0', by:'c.morales', note:'Customs declaration builder — commercial invoice and ITN generation' },
      { d:'2026-06-10T14:00:00Z', v:'v1.6.0', by:'c.morales', note:'AES filing integration — ITN returned from CBP within 15s average; timeout fallback at 60s' },
    ],
    'AG-COMP-SANCTIONSCR': [
      { d:'2026-01-15T09:00:00Z', v:'v2.0.0', by:'c.morales', note:'OFAC screening — SDN list v1.0, batch refresh daily at midnight' },
      { d:'2026-06-20T11:00:00Z', v:'v2.1.0', by:'c.morales', note:'Added EU Consolidated List and UN Consolidated List screening; OFAC_LIST_VERSION tracked per check' },
    ],
    'AG-COMP-INCOTERM': [
      { d:'2026-02-01T10:00:00Z', v:'v1.2.0', by:'c.morales', note:'Incoterm rule enforcer — risk transfer point determination for standard 11 Incoterms 2020' },
      { d:'2026-07-05T13:00:00Z', v:'v1.3.0', by:'c.morales', note:'Cost responsibility split now assigns line items to shipper vs consignee GL codes per Incoterm' },
    ],
    // New agents
    'AG-ORD-ORDERVAL': [
      { d:'2026-04-01T10:00:00Z', v:'v1.0.0', by:'s.patel', note:'Initial order validation — address and weight checks only' },
      { d:'2026-07-01T14:00:00Z', v:'v1.2.0', by:'s.patel', note:'Added service level availability check and date feasibility guard; validation errors now include specific ERROR_CODE' },
    ],
    'AG-COMP-EXPORTLIC': [
      { d:'2026-02-10T09:00:00Z', v:'v1.9.0', by:'c.morales', note:'Export license validation — static BIS country-commodity control list lookup' },
      { d:'2026-07-20T10:00:00Z', v:'v2.0.1', by:'c.morales', note:'Migrated to real-time BIS EAR API; fail-safe (blocks on timeout) replaces fail-open behaviour' },
    ],
    'AG-ORD-CONSOL': [
      { d:'2026-05-10T10:00:00Z', v:'v2.2.1', by:'r.nguyen', note:'LTL consolidation — window-based grouping by DEST_ZONE_GID, 24h window' },
      { d:'2026-07-15T14:00:00Z', v:'v2.3.0', by:'r.nguyen', note:'Stop-sequence optimisation via nearest-neighbour heuristic; window extended to 48h' },
    ],
    'AG-RATE-SPOTBID': [
      { d:'2026-06-01T10:00:00Z', v:'v1.0.3', by:'s.patel', note:'Initial spot rate bidding — 45-minute bid window, lowest-price wins' },
      { d:'2026-07-18T14:00:00Z', v:'v1.0.4', by:'s.patel', note:'Extended bid window to 60 minutes; counter-offer acceptance within 5% tolerance added' },
    ],
    'AG-RATE-ACCESSORIAL': [
      { d:'2026-03-20T10:00:00Z', v:'v3.0.0', by:'s.patel', note:'Accessorial calculator — fuel surcharge and residential delivery charges' },
      { d:'2026-07-10T13:00:00Z', v:'v3.1.2', by:'s.patel', note:'Added liftgate and inside delivery charges; ACCESSORIAL_TOTAL_USD now includes all accessorials' },
    ],
    'AG-SHIP-COSTALLOC': [
      { d:'2026-05-01T10:00:00Z', v:'v1.3.0', by:'d.kim', note:'Cost allocation — equal-split basis only' },
      { d:'2026-07-12T14:00:00Z', v:'v1.4.0', by:'d.kim', note:'Four allocation bases now supported: WEIGHT, VOLUME, VALUE, EQUAL; basis from ALLOCATION_BASIS_CODE on shipment' },
    ],
    'AG-SHIP-CARRPERF': [
      { d:'2026-06-15T10:00:00Z', v:'v1.9.0', by:'a.okafor', note:'Carrier scorecard — on-time delivery and tender acceptance metrics' },
      { d:'2026-07-20T14:00:00Z', v:'v2.0.0', by:'a.okafor', note:'Added invoice variance metric; score now composite of OTD + acceptance rate + invoice accuracy' },
    ],
    'AG-INV-ACCRUAL': [
      { d:'2026-05-15T10:00:00Z', v:'v1.0.2', by:'d.kim', note:'Freight cost accrual — posts estimated cost to GL on SHIPMENT_CONFIRMED; manual reversal required' },
      { d:'2026-07-22T09:00:00Z', v:'v1.1.0', by:'d.kim', note:'Automatic reversal scheduling on period-open; eliminates manual 2-day GL-close delay' },
    ],
    'AG-INV-DISPUTE': [
      { d:'2026-06-01T10:00:00Z', v:'v1.2.0', by:'d.kim', note:'Invoice dispute — manual case creation and carrier notification' },
      { d:'2026-07-18T13:00:00Z', v:'v1.3.1', by:'d.kim', note:'Auto-reconciliation against contracted rate; RESOLUTION_AMOUNT_USD computed from rate delta' },
    ],
    'AG-CAP-LOADPLAN': [
      { d:'2026-05-20T10:00:00Z', v:'v2.0.1', by:'l.tran', note:'Load planning — weight and volume optimisation, sequential load sequencing' },
      { d:'2026-07-20T14:00:00Z', v:'v2.1.3', by:'l.tran', note:'Hazmat separation zones added; DOT incompatibility matrix enforced; equipment utilisation metric written' },
    ],
    'AG-AI-LANEOPT': [
      { d:'2026-07-01T10:00:00Z', v:'v0.9-beta', by:'r.nguyen', note:'Lane optimization model — beta deployment; 90-day rolling history, nearest-neighbour carrier fit' },
    ],
    'AG-AI-CARRCHURN': [
      { d:'2026-07-10T10:00:00Z', v:'v1.0.0', by:'r.nguyen', note:'Initial carrier churn predictor — gradient boost on OTD, acceptance rate, capacity signal' },
      { d:'2026-07-20T14:00:00Z', v:'v1.0.2', by:'r.nguyen', note:'Patch: churn tier thresholds calibrated against 6-month carrier attrition history (NWL fleet)' },
    ],
  };

  let snapCount = 0;
  for (const [agentId, snaps] of Object.entries(histories)) {
    if (haveSnap.has(agentId)) continue; // already has snapshots
    for (const s of snaps) {
      const cfg = { version: s.v, note: s.note };
      await q(`INSERT INTO agent_snapshots(agent_id,snapshot_at,version_label,changed_by,note,config_json)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [agentId, s.d, s.v, s.by, s.note, JSON.stringify(cfg)]);
      snapCount++;
    }
  }
  console.log('[enrich] Snapshots inserted:', snapCount);
}

// ─── 7. Back-fill trace runs ───────────────────────────────────────────────────
async function seedTraceRuns() {
  console.log('\n[enrich] Back-filling trace runs…');

  const existing = await q('SELECT DISTINCT agent_id FROM trace_runs');
  const have = new Set(existing.map(r=>r.agent_id));

  // run config per agent: { shipment, ms, health, label, steps[] }
  const runs = {
    'AG-ORD-ORDERVAL':   { ship:'NWL.OR31022', ms:112, health:'green', label:'Completed 112ms', steps:[
      {label:'Load order',       io:'in: ORDER_RELEASE_GID=NWL.OR31022  out: SHIP_FROM=NWL.DC.CHICAGO SHIP_TO=NWL.CUST.44812', s:5,  d:38, st:'ok'},
      {label:'Validate addresses',io:'in: SHIP_FROM=NWL.DC.CHICAGO SHIP_TO=NWL.CUST.44812  out: BOTH_VALID=true', s:43, d:44, st:'ok'},
      {label:'Check date window', io:'in: ESD=2026-07-25 LDD=2026-07-28  out: FEASIBLE=true TRANSIT_DAYS=3', s:87, d:12, st:'ok'},
      {label:'Write validation',  io:'wrote: ORDER_VALIDATION_STATUS=VALID VALIDATED_AT_TS=NOW()',  s:99, d:8,  st:'ok'},
      {label:'Emit ORDER_VALIDATED',io:'evt=ORDER_VALIDATED ORDER_GID=NWL.OR31022', s:107,d:5, st:'ok'},
    ]},
    'AG-ORD-SVCLEVSEL':  { ship:'NWL.OR30901', ms:88, health:'green', label:'Completed 88ms', steps:[
      {label:'Load order movement',io:'in: ORDER_MOVEMENT_GID=NWL.OM30901  out: REQUESTED_SL=STANDARD LANE_GID=NWL.LN.CHI-ATL', s:5, d:30, st:'ok'},
      {label:'Match service level',io:'in: LANE_GID=NWL.LN.CHI-ATL SL=STANDARD  out: SERVICE_LEVEL_GID=NWL.SL.LTL2 PROVIDER=NWL.CEVA', s:35, d:41, st:'ok'},
      {label:'Write service level',io:'wrote: SERVICE_LEVEL_GID=NWL.SL.LTL2 SERVICE_PROVIDER_GID=NWL.CEVA', s:76, d:7,  st:'ok'},
      {label:'Emit SVC_LEVEL_SELECTED',io:'evt=SVC_LEVEL_SELECTED ORDER_GID=NWL.OR30901', s:83, d:5, st:'ok'},
    ]},
    'AG-ORD-LANEPREF':   { ship:'NWL.OR30855', ms:145, health:'amber', label:'Completed 145ms — lane preference override applied', steps:[
      {label:'Load rate & lane',  io:'in: RATE_GID=NWL.RGC.9088 LANE_GID=NWL.LN.MEM-DAL  out: PREF_CARRIER=NWL.ESTES RANK=2', s:5, d:42, st:'ok'},
      {label:'Check scoreboard',  io:'in: CARRIER_GID=NWL.ESTES RANK=2  out: SCORE=87.4 RANK<=3=true', s:47, d:38, st:'ok'},
      {label:'Apply override',    io:'in: OVERRIDE_REASON=PREFERRED_VENDOR  out: LANE_OVERRIDE_APPLIED=true', s:85, d:52, st:'warn'},
      {label:'Emit RATE_APPLIED', io:'evt=RATE_APPLIED with LANE_OVERRIDE ORDER_GID=NWL.OR30855', s:137,d:8, st:'ok'},
    ]},
    'AG-ORD-BULKPLAN':   { ship:'NWL.OR30700', ms:392, health:'green', label:'Completed 392ms — 7 orders consolidated', steps:[
      {label:'Find pool candidates',io:'in: DEST_ZONE=NWL.ZONE.MID-ATL SHIP_DATE=2026-07-24  out: 7 ORDER_MOVEMENTs eligible', s:10, d:148, st:'ok'},
      {label:'Group into pool',   io:'in: 7 OM_GIDs  out: POOL_LOAD_GID=NWL.PL.8841', s:158,d:98, st:'ok'},
      {label:'Compute pool cost', io:'in: POOL_LOAD_GID=NWL.PL.8841 RATE_GEO=NWL.RGC.4421  out: POOL_COST_USD=12,480.00', s:256,d:122,st:'ok'},
      {label:'Write pool load',   io:'wrote: POOL_LOAD_GID=NWL.PL.8841 ORDER_COUNT=7 SAVINGS_USD=2,210.00', s:378,d:9,  st:'ok'},
      {label:'Emit POOL_LOAD_BUILT',io:'evt=POOL_LOAD_BUILT POOL_LOAD_GID=NWL.PL.8841', s:387,d:5, st:'ok'},
    ]},
    'AG-ORD-HAZMATVAL':  { ship:'NWL.OR30812', ms:68, health:'green', label:'Completed 68ms', steps:[
      {label:'Load hazmat lines', io:'in: SHIP_UNIT_LINE_GIDs=[NWL.SUL.1,NWL.SUL.2]  out: UN_NUMBER=UN1993 CLASS=3 PG=II', s:5, d:24, st:'ok'},
      {label:'Validate packaging',io:'in: UN_NUMBER=UN1993 CLASS=3 PG=II  out: PACKAGING_VALID=true', s:29, d:20, st:'ok'},
      {label:'Verify ERG number', io:'in: ERG_NUM=128 UN_NUMBER=UN1993  out: ERG_MATCH=true', s:49, d:12, st:'ok'},
      {label:'Write compliance',  io:'wrote: HAZMAT_CLEARED_FLG=Y PLACARD_CODE=FLAMMABLE_LIQUID', s:61, d:7,  st:'ok'},
    ]},
    'AG-SHIP-TENDERRESP':{ ship:'NWL.SHP.29107', ms:204, health:'green', label:'Completed 204ms — tender ACCEPTED', steps:[
      {label:'Read tender',       io:'in: TENDER_GID=NWL.TND.7841 STATUS=ACCEPTED CARRIER=NWL.CHRW', s:5, d:44, st:'ok'},
      {label:'Update shipment',   io:'in: SHIPMENT_GID=NWL.SHP.29107  wrote: STATUS=CONFIRMED CARRIER_GID=NWL.CHRW', s:49, d:92, st:'ok'},
      {label:'Gate doc generation',io:'out: DOCUMENTS_READY_FLG=N (pending doc gen)', s:141,d:28, st:'ok'},
      {label:'Emit SHIPMENT_CONFIRMED',io:'evt=SHIPMENT_CONFIRMED SHIPMENT_GID=NWL.SHP.29107', s:169,d:35, st:'ok'},
    ]},
    'AG-SHIP-TRACKUPDATE':{ ship:'NWL.SHP.28902', ms:178, health:'green', label:'Completed 178ms', steps:[
      {label:'Poll tracking API', io:'in: CARRIER_GID=NWL.ESTES PRO=0284911022  out: EVENT=IN_TRANSIT LOC=NWL.LOC.NASHVILLE', s:10, d:122, st:'ok'},
      {label:'Dedup event',       io:'in: TRACKING_EVENT_GID=EVT-8812  out: DUPLICATE=false', s:132,d:12, st:'ok'},
      {label:'Write location',    io:'wrote: CURRENT_LOCATION_GID=NWL.LOC.NASHVILLE LAST_TRACKING_TS=NOW()', s:144,d:22, st:'ok'},
      {label:'Emit TRACKING_EVENT',io:'evt=TRACKING_EVENT SHIPMENT_GID=NWL.SHP.28902 CODE=IN_TRANSIT', s:166,d:12, st:'ok'},
    ]},
    'AG-SHIP-EXCEPTIONMGR':{ ship:'NWL.SHP.28441', ms:312, health:'amber', label:'Completed 312ms — DAMAGED exception raised', steps:[
      {label:'Ingest exception',  io:'in: EXCEPTION_TYPE=DAMAGED SHIPMENT_GID=NWL.SHP.28441 VALUE_USD=840.00', s:5, d:48, st:'ok'},
      {label:'Assign responsible',io:'in: CARRIER_GID=NWL.WARD  out: RESPONSIBLE_PARTY=NWL.WARD', s:53, d:32, st:'ok'},
      {label:'Create claim',      io:'in: EXCEPTION_AMOUNT=840.00 > 500 threshold  wrote: CLAIM_GID=NWL.CLM.2241', s:85, d:188,st:'warn'},
      {label:'Notify carrier',    io:'sent: DAMAGE_CLAIM_NOTIFICATION to NWL.WARD', s:273,d:32, st:'ok'},
      {label:'Emit EXCEPTION_ESCALATED',io:'evt=EXCEPTION_ESCALATED SHIPMENT_GID=NWL.SHP.28441', s:305,d:7, st:'ok'},
    ]},
    'AG-SHIP-APPOINTSCHED':{ ship:'NWL.SHP.29200', ms:244, health:'green', label:'Completed 244ms', steps:[
      {label:'Check lead time',   io:'in: DELIVERY_DATE=2026-07-26 LEAD_TIME_HRS=24  out: LEAD_TIME_OK=true', s:5, d:28, st:'ok'},
      {label:'Request appointment',io:'in: FACILITY_GID=NWL.FAC.ATLANTA-DC  out: APPT_GID=NWL.APPT.19041', s:33, d:182,st:'ok'},
      {label:'Confirm appointment',io:'out: APPT_CONFIRMED_FLG=Y DOCK_WINDOW=2026-07-26 09:00-11:00', s:215,d:22, st:'ok'},
      {label:'Write appointment', io:'wrote: APPOINTMENT_GID=NWL.APPT.19041 APPT_CONFIRMED_FLG=Y', s:237,d:7,  st:'ok'},
    ]},
    'AG-INV-FRTAUDIT':   { ship:'NWL.INV.8841', ms:622, health:'green', label:'Completed 622ms — 2 discrepancies flagged', steps:[
      {label:'Load invoice',      io:'in: INVOICE_GID=NWL.INV.8841 CONTRACTED_RATE=NWL.RGC.4012  out: INVOICE_AMT=4,180.00 CONTRACTED=3,940.00', s:10, d:88, st:'ok'},
      {label:'Audit line items',  io:'in: FREIGHT_CHARGE_GIDs=[FC-1,FC-2,FC-3]  out: DISCREPANCY_1=FSC_OVERAGE $180 DISCREPANCY_2=RESIDENTIAL_CHARGE $60', s:98, d:344,st:'warn'},
      {label:'Generate report',   io:'wrote: AUDIT_REPORT_GID=NWL.AR.8841 DISCREPANCY_AMOUNT_USD=240.00 RESULT=FAIL', s:442,d:148,st:'ok'},
      {label:'Emit AUDIT_COMPLETE',io:'evt=FREIGHT_AUDIT_COMPLETE INVOICE_GID=NWL.INV.8841', s:590,d:32, st:'ok'},
    ]},
    'AG-INV-PAYTERM':    { ship:'NWL.INV.8800', ms:88, health:'green', label:'Completed 88ms', steps:[
      {label:'Load invoice',      io:'in: INVOICE_GID=NWL.INV.8800 PAYMENT_TERM=NET_30 INVOICE_DATE=2026-07-10', s:5, d:32, st:'ok'},
      {label:'Compute due date',  io:'in: INVOICE_DATE=2026-07-10 + 30 days  out: DUE_DATE=2026-08-09', s:37, d:12, st:'ok'},
      {label:'Check early pay',   io:'in: EARLY_PAY_DISCOUNT=2%@10 REMAINING_DAYS=22  out: EARLY_PAY_ELIGIBLE=false', s:49, d:22, st:'ok'},
      {label:'Schedule payment',  io:'wrote: DUE_DATE=2026-08-09 PAYMENT_AMOUNT_USD=3,940.00', s:71, d:12, st:'ok'},
      {label:'Emit PAYMENT_SCHEDULED',io:'evt=PAYMENT_SCHEDULED INVOICE_GID=NWL.INV.8800', s:83, d:5, st:'ok'},
    ]},
    'AG-ORD-SVCLEVSEL':  { ship:'NWL.OR29800', ms:92, health:'green', label:'Completed 92ms', steps:[
      {label:'Resolve service level',io:'in: LANE_GID=NWL.LN.DFW-NYC REQUESTED=EXPEDITED  out: SL_GID=NWL.SL.EXP2 EFFECTIVE_DATE=valid', s:5, d:44, st:'ok'},
      {label:'Write SL',          io:'wrote: SERVICE_LEVEL_GID=NWL.SL.EXP2 SERVICE_PROVIDER_GID=NWL.FEDEX', s:49, d:38, st:'ok'},
      {label:'Emit SL_SELECTED',  io:'evt=SVC_LEVEL_SELECTED', s:87, d:5, st:'ok'},
    ]},
    'AG-CAP-YARDCHECK':  { ship:'NWL.SHP.29100', ms:168, health:'green', label:'Completed 168ms', steps:[
      {label:'Query yard capacity',io:'in: FACILITY_GID=NWL.FAC.MEMPHIS-DC ARRIVAL_DATE=2026-07-25  out: AVAILABLE_DOORS=8 RESERVED=3', s:5, d:98, st:'ok'},
      {label:'Check compatibility',io:'in: EQUIPMENT_TYPE=53FT_DRY  out: COMPATIBLE_DOORS=6', s:103,d:28, st:'ok'},
      {label:'Reserve slot',      io:'wrote: YARD_SLOT_GID=NWL.YS.1041 RESERVED_FLG=Y CAPACITY_STATUS=OPEN', s:131,d:32, st:'ok'},
      {label:'Emit YARD_SLOT_RESERVED',io:'evt=YARD_SLOT_RESERVED SHIPMENT_GID=NWL.SHP.29100', s:163,d:5, st:'ok'},
    ]},
    'AG-CAP-DOCKALLOC':  { ship:'NWL.SHP.29088', ms:212, health:'green', label:'Completed 212ms', steps:[
      {label:'Load appointment',  io:'in: APPOINTMENT_GID=NWL.APPT.18900 FACILITY=NWL.FAC.MEMPHIS-DC', s:5, d:44, st:'ok'},
      {label:'Select dock door',  io:'in: EQUIPMENT_TYPE=53FT_DRY ARRIVAL_WINDOW=09:00-11:00  out: DOCK_DOOR_GID=NWL.DD.07', s:49, d:88, st:'ok'},
      {label:'Write allocation',  io:'wrote: DOCK_DOOR_GID=NWL.DD.07 SLOT_START=09:00 SLOT_END=11:00', s:137,d:68, st:'ok'},
      {label:'Notify yard manager',io:'sent: DOCK_ASSIGNMENT_NOTIFICATION to NWL.FAC.MEMPHIS-DC yard manager', s:205,d:7,  st:'ok'},
    ]},
    'AG-AI-CAPACITYFORECAST':{ ship:'NWL.LANE.DFW-NYC', ms:2840, health:'amber', label:'Completed 2840ms — low confidence', steps:[
      {label:'Load lane history', io:'in: LANE_GID=NWL.LN.DFW-NYC PERIOD=180D  out: 2,481 shipments loaded', s:20, d:1200,st:'ok'},
      {label:'Run LSTM model',    io:'in: LANE_VOLUME_QTY=2481 SEASONALITY=yes  out: PREDICTED_UNITS=312 CONFIDENCE=0.71', s:1220,d:1440,st:'warn'},
      {label:'Compute risk score',io:'in: PREDICTED=312 vs CAPACITY=340  out: CAPACITY_RISK_SCORE=0.28', s:2660,d:122,st:'ok'},
      {label:'Write forecast',    io:'wrote: CAPACITY_FORECAST_GID=NWL.CF.7841 PREDICTED_UNITS=312 RISK_SCORE=0.28', s:2782,d:48, st:'ok'},
    ]},
    'AG-AI-ETAPRED':     { ship:'NWL.SHP.28710', ms:380, health:'green', label:'Completed 380ms', steps:[
      {label:'Load milestone',    io:'in: MILESTONE_CODE=DEPARTURE SHIPMENT_GID=NWL.SHP.28710', s:5, d:48, st:'ok'},
      {label:'Score weather risk',io:'in: LANE=NWL.LN.SEA-CHI DATE=2026-07-24  out: WEATHER_RISK=LOW', s:53, d:82, st:'ok'},
      {label:'Predict ETA',       io:'in: CARRIER=NWL.BNSF TRANSIT_DAYS_AVG=4.2  out: REVISED_ETA=2026-07-28 CONFIDENCE=0.88', s:135,d:228,st:'ok'},
      {label:'Write prediction',  io:'wrote: REVISED_ETA_TS=2026-07-28T14:00Z ETA_CONFIDENCE_PCT=88 DELAY_RISK_SCORE=0.12', s:363,d:12, st:'ok'},
    ]},
    'AG-COMP-INCOTERM':  { ship:'NWL.SHP.29044', ms:98, health:'green', label:'Completed 98ms', steps:[
      {label:'Resolve Incoterm',  io:'in: INCOTERM_CODE=DAP SHIPMENT_GID=NWL.SHP.29044  out: RISK_TRANSFER=DEST_NAMED_PLACE', s:5, d:38, st:'ok'},
      {label:'Assign cost responsibility',io:'in: COST_LINE_ITEMS=3  out: SHIPPER_COST=FREIGHT+EXPORT CONSIGNEE_COST=IMPORT_DUTY', s:43, d:42, st:'ok'},
      {label:'Write Incoterm record',io:'wrote: RISK_TRANSFER_POINT_GID=NWL.RTP.44 INCOTERM_APPLIED_FLG=Y', s:85, d:8, st:'ok'},
      {label:'Emit INCOTERM_APPLIED',io:'evt=INCOTERM_APPLIED SHIPMENT_GID=NWL.SHP.29044', s:93, d:5, st:'ok'},
    ]},
    // New agents
    'AG-COMP-EXPORTLIC': { ship:'NWL.OR30905', ms:338, health:'green', label:'Completed 338ms', steps:[
      {label:'Load commodity',    io:'in: ORDER_RELEASE_GID=NWL.OR30905 COMMODITY_GID=NWL.COM.SEMICOND  out: ECCN=3A001 CONTROLLED=Y', s:5, d:44, st:'ok'},
      {label:'Call BIS EAR API',  io:'in: ECCN=3A001 DEST_COUNTRY=DEU  out: EAR_RESULT=NO_LICENSE_REQUIRED', s:49, d:272,st:'ok'},
      {label:'Verify license',    io:'in: EXPORT_LICENSE_GID=EL-2026-4412  out: EXPIRY=2027-06-30 STATUS=ACTIVE', s:321,d:12, st:'ok'},
      {label:'Write license status',io:'wrote: LICENSE_CLEARED_FLG=Y LICENSE_NUMBER=EL-2026-4412 STATUS=CLEARED', s:333,d:5, st:'ok'},
    ]},
    'AG-ORD-CONSOL':     { ship:'NWL.PL.8905', ms:484, health:'green', label:'Completed 484ms — 5 orders consolidated', steps:[
      {label:'Find LTL candidates',io:'in: DEST_ZONE=NWL.ZONE.SOUTHEAST SHIP_DATE=2026-07-25  out: 5 eligible OM_GIDs', s:10, d:148, st:'ok'},
      {label:'Compute savings',   io:'in: 5 OM_GIDs INDIVIDUAL_COST=8,800  out: CONSOLIDATED_COST=6,240 SAVINGS=2,560 USD', s:158,d:188,st:'ok'},
      {label:'Optimise stop seq', io:'in: 5 DESTs  out: STOP_SEQUENCE=[ATL,BHM,MOB,JAX,ORL]', s:346,d:122,st:'ok'},
      {label:'Write consolidation',io:'wrote: CONSOLIDATED_ORDER_SET_GID=NWL.COS.8905 SAVINGS_USD=2560.00', s:468,d:11, st:'ok'},
      {label:'Emit CONSOLIDATED', io:'evt=ORDERS_CONSOLIDATED POOL_GID=NWL.COS.8905', s:479,d:5, st:'ok'},
    ]},
    'AG-RATE-SPOTBID':   { ship:'NWL.OR30912', ms:3820, health:'amber', label:'Completed 3820ms — 4 bids received', steps:[
      {label:'Broadcast bid request',io:'in: CARRIER_LIST=4 carriers PICKUP=2026-07-25 DEST=NWL.CUST.88012', s:10, d:48, st:'ok'},
      {label:'Collect bids',      io:'in: BID_WINDOW=60min  out: BIDS_RECEIVED=4 LOWEST=NWL.COYOTE $3,220', s:58, d:3600,st:'warn'},
      {label:'Select winner',     io:'in: BIDS=[3220,3440,3680,3900]  out: WINNER=NWL.COYOTE AMOUNT=3220 USD', s:3658,d:88, st:'ok'},
      {label:'Write spot bid',    io:'wrote: SPOT_BID_GID=NWL.SB.2241 WINNING_BID_USD=3220 CARRIER=NWL.COYOTE', s:3746,d:74, st:'ok'},
    ]},
    'AG-RATE-ACCESSORIAL':{ ship:'NWL.SHP.29080', ms:122, health:'green', label:'Completed 122ms', steps:[
      {label:'Load accessorial codes',io:'in: RATE_GID=NWL.RGC.9041 SHIPMENT_GID=NWL.SHP.29080  out: CODES=[FSC,RESIDENTIAL]', s:5, d:32, st:'ok'},
      {label:'Compute fuel surcharge',io:'in: BASE_RATE=2847.50 FSC_RATE=12.8%  out: FSC_AMOUNT=364.48 USD', s:37, d:38, st:'ok'},
      {label:'Apply residential charge',io:'in: RESIDENTIAL_FLG=Y  out: RESI_CHARGE=75.00 USD', s:75, d:28, st:'ok'},
      {label:'Write accessorials',io:'wrote: ACCESSORIAL_TOTAL=439.48 ADJUSTED_FREIGHT_COST=3286.98 USD', s:103,d:14, st:'ok'},
      {label:'Emit ACCESSORIALS_APPLIED',io:'evt=ACCESSORIALS_APPLIED SHIPMENT_GID=NWL.SHP.29080', s:117,d:5, st:'ok'},
    ]},
    'AG-SHIP-COSTALLOC': { ship:'NWL.SHP.29107', ms:188, health:'green', label:'Completed 188ms', steps:[
      {label:'Load cost centres', io:'in: SHIPMENT_GID=NWL.SHP.29107 BASIS=WEIGHT  out: 3 COST_CENTER_GIDs', s:5, d:48, st:'ok'},
      {label:'Compute allocation',io:'in: TOTAL_COST=4180.00 WEIGHTS=[1200,800,600]kg  out: CC1=1950 CC2=1300 CC3=930 USD', s:53, d:88, st:'ok'},
      {label:'Post to GL',        io:'in: GL_PERIOD=2026-07  wrote: COST_CENTER_POSTING_GIDs=3 records', s:141,d:38, st:'ok'},
      {label:'Write allocation',  io:'wrote: COST_ALLOCATION_GID=NWL.CA.5841 STATUS=POSTED', s:179,d:9, st:'ok'},
    ]},
    'AG-SHIP-CARRPERF':  { ship:'NWL.CARR.CHRW', ms:228, health:'green', label:'Completed 228ms — scorecard updated', steps:[
      {label:'Load deliveries',   io:'in: CARRIER_GID=NWL.CHRW PERIOD=ROLLING_30D  out: 312 shipments evaluated', s:10, d:122, st:'ok'},
      {label:'Compute OTD',       io:'in: DELIVERED_ON_TIME=294 of 312  out: OTD_PCT=94.2%', s:132,d:48, st:'ok'},
      {label:'Compute acceptance',io:'in: TENDERS_SENT=341 ACCEPTED=328  out: ACCEPT_RATE=96.2%', s:180,d:32, st:'ok'},
      {label:'Update scorecard',  io:'wrote: CARRIER_OVERALL_SCORE=91.4 ON_TIME_PCT=94.2 ACCEPT_RATE=96.2', s:212,d:16, st:'ok'},
    ]},
    'AG-INV-ACCRUAL':    { ship:'NWL.SHP.29200', ms:148, health:'green', label:'Completed 148ms', steps:[
      {label:'Load shipment cost',io:'in: SHIPMENT_GID=NWL.SHP.29200 ESTIMATED_COST=3940.00 USD', s:5, d:38, st:'ok'},
      {label:'Post accrual',      io:'in: GL_ACCOUNT=NWL.GL.5010 PERIOD=2026-07  wrote: ACCRUAL_ENTRY_GID=NWL.ACC.1441', s:43, d:72, st:'ok'},
      {label:'Schedule reversal', io:'in: REVERSAL_DATE=2026-08-01  wrote: ACCRUAL_REVERSAL_DATE=2026-08-01', s:115,d:28, st:'ok'},
      {label:'Emit ACCRUAL_POSTED',io:'evt=ACCRUAL_POSTED SHIPMENT_GID=NWL.SHP.29200', s:143,d:5, st:'ok'},
    ]},
    'AG-INV-DISPUTE':    { ship:'NWL.INV.8841', ms:498, health:'amber', label:'Completed 498ms — dispute case created', steps:[
      {label:'Load dispute',      io:'in: INVOICE_GID=NWL.INV.8841 REASON=RATE_DISCREPANCY AMOUNT=240.00', s:5, d:48, st:'ok'},
      {label:'Create case',       io:'wrote: DISPUTE_CASE_GID=NWL.DC.441 STATUS=OPEN', s:53, d:38, st:'ok'},
      {label:'Notify carrier',    io:'sent: DISPUTE_NOTIFICATION to NWL.WARD re: NWL.INV.8841', s:91, d:288,st:'warn'},
      {label:'Reconcile contract',io:'in: CONTRACTED_RATE=NWL.RGC.4012  out: CONTRACTUAL_AMT=3940.00 DELTA=240.00', s:379,d:88, st:'ok'},
      {label:'Write resolution',  io:'wrote: RESOLUTION_AMOUNT_USD=240.00 DISPUTE_STATUS=PENDING_CARRIER', s:467,d:31, st:'ok'},
    ]},
    'AG-CAP-LOADPLAN':   { ship:'NWL.SHP.29088', ms:322, health:'green', label:'Completed 322ms', steps:[
      {label:'Load ship units',   io:'in: SHIPMENT_GID=NWL.SHP.29088 SHIP_UNIT_GIDs=4 items  out: TOTAL_WEIGHT=18400kg VOLUME=42m³', s:5, d:88, st:'ok'},
      {label:'Check hazmat',      io:'in: HAZMAT_REQUIRED=false  out: SEPARATION_NOT_REQUIRED', s:93, d:22, st:'ok'},
      {label:'Optimise load',     io:'in: EQUIPMENT=53FT_DRY MAX=22680kg 82m³  out: UTILISATION=81.2%', s:115,d:188,st:'ok'},
      {label:'Write load plan',   io:'wrote: LOAD_PLAN_GID=NWL.LP.6641 LOAD_SEQUENCE=[4,3,1,2] UTIL_PCT=81.2', s:303,d:14, st:'ok'},
      {label:'Emit LOAD_PLAN_APPROVED',io:'evt=LOAD_PLAN_APPROVED SHIPMENT_GID=NWL.SHP.29088', s:317,d:5, st:'ok'},
    ]},
    'AG-AI-LANEOPT':     { ship:'NWL.LN.MEM-ATL', ms:4200, health:'amber', label:'Completed 4200ms — lane recommendation generated', steps:[
      {label:'Load lane history', io:'in: LANE_GID=NWL.LN.MEM-ATL PERIOD=90D  out: 184 shipments loaded', s:20, d:1800,st:'ok'},
      {label:'Score carrier fit', io:'in: CARRIERS=8 candidates SCORE_VECTOR loaded  out: TOP=NWL.SAIA score=0.88', s:1820,d:1440,st:'ok'},
      {label:'Compute savings',   io:'in: CURRENT=NWL.ESTES AVG_RATE=2,640 OPTIMAL=NWL.SAIA AVG_RATE=2,410  out: SAVINGS=230 USD/shipment', s:3260,d:812,st:'ok'},
      {label:'Write recommendation',io:'wrote: LANE_RECOMMENDATION_GID=NWL.LR.441 OPTIMAL_CARRIER=NWL.SAIA CONFIDENCE=0.74', s:4072,d:128,st:'warn'},
    ]},
    'AG-AI-CARRCHURN':   { ship:'NWL.CARR.WARD', ms:1840, health:'red', label:'Completed 1840ms — HIGH churn risk', steps:[
      {label:'Load carrier signals',io:'in: CARRIER_GID=NWL.WARD OTD_30D=78.2% ACCEPT_RATE=81.4% CAPACITY_SIGNAL=LOW', s:10, d:48, st:'ok'},
      {label:'Run churn model',   io:'in: FEATURES=[OTD,ACCEPT,CAPACITY,INVOICE_VAR]  out: CHURN_PROB=0.72', s:58, d:1440,st:'ok'},
      {label:'Classify tier',     io:'in: CHURN_PROB=0.72  out: TIER=HIGH (threshold 0.65)', s:1498,d:22, st:'warn'},
      {label:'Identify backup',   io:'in: LANES=[NWL.LN.MEM-ATL, NWL.LN.CHI-DAL]  out: BACKUP=NWL.ESTES available', s:1520,d:282,st:'ok'},
      {label:'Write churn alert', io:'wrote: CHURN_RISK_SCORE=0.72 TIER=HIGH BACKUP_CARRIER=NWL.ESTES', s:1802,d:38, st:'ok'},
    ]},
  };

  let runCount = 0;
  const runIds = { 1:'RUN-60001',2:'RUN-60002',3:'RUN-60003',4:'RUN-60004',5:'RUN-60005',
    6:'RUN-60006',7:'RUN-60007',8:'RUN-60008',9:'RUN-60009',10:'RUN-60010',
    11:'RUN-60011',12:'RUN-60012',13:'RUN-60013',14:'RUN-60014',15:'RUN-60015',
    16:'RUN-60016',17:'RUN-60017',18:'RUN-60018',19:'RUN-60019',20:'RUN-60020',
    21:'RUN-60021',22:'RUN-60022',23:'RUN-60023',24:'RUN-60024',25:'RUN-60025',
    26:'RUN-60026',27:'RUN-60027',28:'RUN-60028' };
  let runSeq = 1;

  for (const [agentId, cfg] of Object.entries(runs)) {
    if (have.has(agentId)) continue;
    const started = new Date(Date.now() - Math.floor(Math.random()*7200000) - 3600000).toISOString();
    const [run] = await q(`INSERT INTO trace_runs(agent_id,run_id,shipment_gid,env,started,total_ms,health,status,status_label)
      VALUES($1,$2,$3,'PROD',$4,$5,$6,'ok',$7) RETURNING id`,
      [agentId, runIds[runSeq++]||`RUN-6${runCount+100}`, cfg.ship, started, cfg.ms, cfg.health, cfg.label]);
    for (let i=0; i<cfg.steps.length; i++) {
      const s = cfg.steps[i];
      await q(`INSERT INTO trace_steps(trace_run_id,label,io,start_ms,dur_ms,status,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [run.id, s.label, s.io, s.s, s.d, s.st, i+1]);
    }
    runCount++;
  }
  console.log('[enrich] Trace runs inserted:', runCount);
}

// ─── 8. Back-fill regression tests ────────────────────────────────────────────
async function seedRegressionTests() {
  console.log('\n[enrich] Back-filling regression tests…');

  const existing = await q('SELECT agent_id FROM regression_tests');
  const have = new Set(existing.map(r=>r.agent_id));

  const tests = [
    // AG-ORD-ORDERVAL
    {id:'TC-OV-01',agent:'AG-ORD-ORDERVAL',n:'Null ship-from location blocks order',       exp:"ORDER_VALIDATION_STATUS = 'INVALID' VALIDATION_ERROR_CODE = 'MISSING_SHIP_FROM'", res:'pass',   s:1},
    {id:'TC-OV-02',agent:'AG-ORD-ORDERVAL',n:'Infeasible date window (ESD > LDD) blocks',  exp:"ORDER_VALIDATION_STATUS = 'INVALID' VALIDATION_ERROR_CODE = 'DATE_INFEASIBLE'",    res:'pass',   s:2},
    {id:'TC-OV-03',agent:'AG-ORD-ORDERVAL',n:'Zero weight order blocks validation',         exp:"ORDER_VALIDATION_STATUS = 'INVALID' VALIDATION_ERROR_CODE = 'ZERO_WEIGHT'",        res:'pass',   s:3},
    {id:'TC-OV-04',agent:'AG-ORD-ORDERVAL',n:'Valid order emits ORDER_VALIDATED event',     exp:"ORDER_VALIDATION_STATUS = 'VALID' evt=ORDER_VALIDATED",                            res:'pass',   s:4},

    // AG-ORD-BULKPLAN
    {id:'TC-BP-01',agent:'AG-ORD-BULKPLAN',n:'Single order not consolidated into pool',     exp:'CONSOLIDATED_ORDER_COUNT = 1 POOL_COST_USD = individual rate',   res:'pass', s:1},
    {id:'TC-BP-02',agent:'AG-ORD-BULKPLAN',n:'7 orders same zone same date → consolidated',exp:'POOL_LOAD_GID created ORDER_COUNT = 7',                           res:'pass', s:2},
    {id:'TC-BP-03',agent:'AG-ORD-BULKPLAN',n:'Null POOL_LOAD_GID guard — no NPE on single order',exp:'Agent completes successfully with POOL_COST_USD = individual', res:'pass', s:3},

    // AG-ORD-SVCLEVSEL
    {id:'TC-SL-01',agent:'AG-ORD-SVCLEVSEL',n:'Expired service level rejected',            exp:"SERVICE_LEVEL_GID = NULL REASON = 'EXPIRED'",                    res:'pass', s:1},
    {id:'TC-SL-02',agent:'AG-ORD-SVCLEVSEL',n:'Two providers same level → lowest cost wins',exp:'SERVICE_PROVIDER_GID = lower_cost_provider',                   res:'pass', s:2},
    {id:'TC-SL-03',agent:'AG-ORD-SVCLEVSEL',n:'Null SERVICE_LEVEL_GID → agent skips silently',exp:'No error EVENT not emitted ORDER passes to next agent',      res:'pass', s:3},

    // AG-ORD-LANEPREF
    {id:'TC-LP-01',agent:'AG-ORD-LANEPREF',n:'Carrier rank > 3 blocked without override',  exp:"OVERRIDE_REJECTED REASON = 'RANK_TOO_LOW'",                      res:'pass', s:1},
    {id:'TC-LP-02',agent:'AG-ORD-LANEPREF',n:'Override without reason code blocked',        exp:"OVERRIDE_REJECTED REASON = 'MISSING_REASON_CODE'",               res:'pass', s:2},
    {id:'TC-LP-03',agent:'AG-ORD-LANEPREF',n:'Valid override rank ≤ 3 + reason applied',   exp:'LANE_OVERRIDE_APPLIED = true AUDIT_TRAIL written',               res:'pass', s:3},

    // AG-ORD-HAZMATVAL
    {id:'TC-HV-01',agent:'AG-ORD-HAZMATVAL',n:'Invalid packing group IV rejected',         exp:"HAZMAT_CLEARED_FLG = N REASON = 'INVALID_PG'",                   res:'pass', s:1},
    {id:'TC-HV-02',agent:'AG-ORD-HAZMATVAL',n:'Missing ERG number blocks clearance',       exp:"HAZMAT_CLEARED_FLG = N REASON = 'MISSING_ERG'",                  res:'pass', s:2},
    {id:'TC-HV-03',agent:'AG-ORD-HAZMATVAL',n:'Valid UN1993 PG-II + ERG 128 → cleared',   exp:"HAZMAT_CLEARED_FLG = Y PLACARD_CODE = 'FLAMMABLE_LIQUID'",        res:'pass', s:3},

    // AG-SHIP-AUTOTENDER
    {id:'TC-AT-01',agent:'AG-SHIP-AUTOTENDER',n:'Suspended carrier not tendered to',        exp:'TENDER not created for CARRIER_CONTRACT_STATUS = SUSPENDED',     res:'pass', s:1},
    {id:'TC-AT-02',agent:'AG-SHIP-AUTOTENDER',n:'Auto-tender sent with correct expiry',     exp:'TENDER_EXPIRY = NOW() + TENDER_EXPIRY_HOURS',                    res:'pass', s:2},
    {id:'TC-AT-03',agent:'AG-SHIP-AUTOTENDER',n:'No RATE_GID → tender not sent',            exp:'TENDER_STATUS = HELD REASON = MISSING_RATE',                    res:'pass', s:3},

    // AG-SHIP-TENDERRESP
    {id:'TC-TR-01',agent:'AG-SHIP-TENDERRESP',n:'ACCEPTED tender → SHIPMENT_CONFIRMED event',exp:"SHIPMENT.status = 'CONFIRMED' evt=SHIPMENT_CONFIRMED",          res:'pass', s:1},
    {id:'TC-TR-02',agent:'AG-SHIP-TENDERRESP',n:'DECLINED tender → re-tender path',         exp:'SHIPMENT routed to AG-SHIP-RETENDER',                            res:'pass', s:2},
    {id:'TC-TR-03',agent:'AG-SHIP-TENDERRESP',n:'COUNTERED within 5% → auto-accepted',      exp:"TENDER_STATUS = 'ACCEPTED' COUNTER_ACCEPTED = true",             res:'pass', s:3},
    {id:'TC-TR-04',agent:'AG-SHIP-TENDERRESP',n:'Expired tender rejected — no status update',exp:'TENDER_STATUS unchanged evt not emitted',                       res:'pass', s:4},

    // AG-SHIP-DOCGEN
    {id:'TC-DG-01',agent:'AG-SHIP-DOCGEN',n:'BOL generated with correct consignee address', exp:'BOL_GID created CONSIGNEE_ADDRESS populated',                   res:'pass', s:1},
    {id:'TC-DG-02',agent:'AG-SHIP-DOCGEN',n:'Parcel → label generated (no BOL)',            exp:'LABEL_GID created BOL_GID = NULL transport_mode=Parcel',         res:'pass', s:2},
    {id:'TC-DG-03',agent:'AG-SHIP-DOCGEN',n:'DOCUMENTS_READY_FLG set after doc gen',        exp:'DOCUMENTS_READY_FLG = Y evt=DOCUMENTS_READY',                   res:'pass', s:3},
    {id:'TC-DG-04',agent:'AG-SHIP-DOCGEN',n:'Zero ship units → doc gen blocked',            exp:'DOC_GEN_SKIPPED REASON = ZERO_SHIP_UNITS',                       res:'pass', s:4},

    // AG-SHIP-TRACKUPDATE
    {id:'TC-TU-01',agent:'AG-SHIP-TRACKUPDATE',n:'Duplicate tracking event deduped',        exp:'TRACKING_EVENT_GID count = 1 no duplicate MILESTONE_CODE',       res:'pass', s:1},
    {id:'TC-TU-02',agent:'AG-SHIP-TRACKUPDATE',n:'Carrier API timeout → fallback to poll',  exp:'LAST_TRACKING_TS updated via polling fallback',                  res:'pass', s:2},
    {id:'TC-TU-03',agent:'AG-SHIP-TRACKUPDATE',n:'DELIVERED event → final milestone set',   exp:'MILESTONE_CODE = DELIVERED SHIPMENT.status = DELIVERED',         res:'pass', s:3},

    // AG-SHIP-EXCEPTIONMGR
    {id:'TC-EM-01',agent:'AG-SHIP-EXCEPTIONMGR',n:'DAMAGED over $500 → claim auto-created', exp:'CLAIM_GID created carrier notified',                            res:'pass', s:1},
    {id:'TC-EM-02',agent:'AG-SHIP-EXCEPTIONMGR',n:'DAMAGED under $500 → no auto-claim',     exp:'EXCEPTION_STATUS = OPEN no CLAIM_GID',                          res:'pass', s:2},
    {id:'TC-EM-03',agent:'AG-SHIP-EXCEPTIONMGR',n:'LATE exception → planner queue assigned', exp:"EXCEPTION_STATUS = 'ASSIGNED' RESPONSIBLE_PARTY_GID set",       res:'pass', s:3},

    // AG-SHIP-APPOINTSCHED
    {id:'TC-AS-01',agent:'AG-SHIP-APPOINTSCHED',n:'Appointment within lead time → warning', exp:'APPT_CONFIRMED_FLG = N LEAD_TIME_WARNING emitted',               res:'pass', s:1},
    {id:'TC-AS-02',agent:'AG-SHIP-APPOINTSCHED',n:'Valid appointment → APPT_GID written',   exp:'APPOINTMENT_GID created APPT_CONFIRMED_FLG = Y',                 res:'pass', s:2},
    {id:'TC-AS-03',agent:'AG-SHIP-APPOINTSCHED',n:'No dest facility → agent skips',         exp:'APPT not created NO_FACILITY_GID logged',                        res:'pass', s:3},

    // AG-SHIP-MILESTONEUPD
    {id:'TC-MU-01',agent:'AG-SHIP-MILESTONEUPD',n:'PICKUP event updates milestone correctly',exp:'MILESTONE_CODE = PICKUP MILESTONE_TS = event timestamp',        res:'pass', s:1},
    {id:'TC-MU-02',agent:'AG-SHIP-MILESTONEUPD',n:'Cross-timezone MILESTONE_TS normalised to UTC',exp:'MILESTONE_TS stored as UTC regardless of carrier timezone',res:'pass', s:2},
    {id:'TC-MU-03',agent:'AG-SHIP-MILESTONEUPD',n:'Out-of-sequence event rejected',         exp:'MILESTONE_CODE not updated SEQUENCE_ERROR logged',               res:'pass', s:3},

    // AG-INV-AUTOAPPROVE
    {id:'TC-IA-01',agent:'AG-INV-AUTOAPPROVE',n:'Invoice within tolerance auto-approved',   exp:"INVOICE_STATUS = 'APPROVED' APPROVED_BY = 'SYSTEM'",             res:'pass', s:1},
    {id:'TC-IA-02',agent:'AG-INV-AUTOAPPROVE',n:'Invoice over tolerance routes to variance', exp:'INVOICE routed to AG-INV-VARIANCE INVOICE_STATUS = PENDING',    res:'pass', s:2},
    {id:'TC-IA-03',agent:'AG-INV-AUTOAPPROVE',n:'Idempotent — duplicate invoke no double approval',exp:'APPROVED_TS unchanged second call no-ops',               res:'pass', s:3},

    // AG-INV-VARIANCE
    {id:'TC-IV-01',agent:'AG-INV-VARIANCE',n:'Variance > GOLD tier threshold escalated',    exp:'ESCALATED_TO_GID set INVOICE_STATUS = ESCALATED',               res:'pass', s:1},
    {id:'TC-IV-02',agent:'AG-INV-VARIANCE',n:'Variance < STANDARD tier threshold cleared',  exp:'INVOICE_STATUS = CLEARED no escalation',                        res:'pass', s:2},
    {id:'TC-IV-03',agent:'AG-INV-VARIANCE',n:'Missing APPROVER_GID → variance held',        exp:'INVOICE_STATUS = HELD REASON = NO_APPROVER',                    res:'pass', s:3},

    // AG-INV-FRTAUDIT
    {id:'TC-FA-01',agent:'AG-INV-FRTAUDIT',n:'FSC overcharge flagged correctly',            exp:'DISCREPANCY_TYPE = FSC_OVERAGE DISCREPANCY_AMOUNT_USD > 0',      res:'pass', s:1},
    {id:'TC-FA-02',agent:'AG-INV-FRTAUDIT',n:'Invoice matching contracted rate → PASS',     exp:"AUDIT_RESULT_CODE = 'PASS' DISCREPANCY_AMOUNT_USD = 0.00",       res:'pass', s:2},
    {id:'TC-FA-03',agent:'AG-INV-FRTAUDIT',n:'Multi-currency invoice converted at invoice date FX',exp:'INVOICE_AMOUNT_USD correct per INVOICE_DATE FX rate',     res:'pass', s:3},

    // AG-INV-REMATCH
    {id:'TC-IR-01',agent:'AG-INV-REMATCH',n:'Exact PRO match → confidence 1.0',            exp:'MATCH_CONFIDENCE_SCORE = 1.0 MATCHED_SHIPMENT_GID set',           res:'pass', s:1},
    {id:'TC-IR-02',agent:'AG-INV-REMATCH',n:'PRO with 1-char typo → fuzzy match confidence ≥ 0.85',exp:'MATCH_CONFIDENCE_SCORE >= 0.85',                         res:'pass', s:2},
    {id:'TC-IR-03',agent:'AG-INV-REMATCH',n:'No match found → INVOICE_STATUS = UNMATCHED', exp:"INVOICE_STATUS = 'UNMATCHED' no SHIPMENT_GID",                   res:'pass', s:3},

    // AG-INV-PAYTERM
    {id:'TC-PT-01',agent:'AG-INV-PAYTERM',n:'NET_30 due date computed correctly',           exp:'DUE_DATE = INVOICE_DATE + 30 days',                              res:'pass', s:1},
    {id:'TC-PT-02',agent:'AG-INV-PAYTERM',n:'Early-pay eligible within 10 days → 2% discount',exp:'PAYMENT_AMOUNT_USD = INVOICE_AMOUNT * 0.98',                  res:'pass', s:2},
    {id:'TC-PT-03',agent:'AG-INV-PAYTERM',n:'Duplicate payment schedule not created',       exp:'PAYMENT_SCHEDULE_GID count = 1 idempotent',                      res:'pass', s:3},

    // AG-CAP-YARDCHECK
    {id:'TC-YC-01',agent:'AG-CAP-YARDCHECK',n:'No available dock doors → CAPACITY_STATUS = FULL',exp:"CAPACITY_STATUS = 'FULL' RESERVED_FLG = N SHIPMENT held",  res:'pass', s:1},
    {id:'TC-YC-02',agent:'AG-CAP-YARDCHECK',n:'Concurrent reservations → no double-booking',exp:'RESERVED_FLG set atomically second request returns FULL',        res:'pass', s:2},
    {id:'TC-YC-03',agent:'AG-CAP-YARDCHECK',n:'Incompatible equipment type → no slot reserved',exp:'RESERVED_FLG = N REASON = EQUIPMENT_INCOMPATIBLE',            res:'pass', s:3},

    // AG-CAP-DOCKALLOC
    {id:'TC-DA-01',agent:'AG-CAP-DOCKALLOC',n:'Reefer shipment assigned to cold dock first', exp:'DOCK_DOOR_GID = cold-capable door SLOT_TS assigned',             res:'pass', s:1},
    {id:'TC-DA-02',agent:'AG-CAP-DOCKALLOC',n:'No compatible door → allocation fails gracefully',exp:'DOCK_DOOR_GID = NULL SHIPMENT_STATUS = ON_HOLD',            res:'pass', s:2},

    // AG-CAP-POOLLOAD
    {id:'TC-PL-01',agent:'AG-CAP-POOLLOAD',n:'Orders with different DEST_ZONEs not consolidated',exp:'Separate POOL_LOAD_GIDs created per zone',                  res:'pass', s:1},
    {id:'TC-PL-02',agent:'AG-CAP-POOLLOAD',n:'Pool cost estimate uses RATE_GEO_COST_GID',   exp:'POOL_COST_USD = sum of RGC line rates not flat estimate',         res:'pass', s:2},

    // AG-CAP-WEIGHTDIM
    {id:'TC-WD-01',agent:'AG-CAP-WEIGHTDIM',n:'Weight exceeds equipment max → VALIDATED_FLG = N',exp:"VALIDATED_FLG = 'N' REASON = 'OVERWEIGHT'",               res:'pass', s:1},
    {id:'TC-WD-02',agent:'AG-CAP-WEIGHTDIM',n:'DIM weight > gross weight → billable = DIM', exp:'BILLABLE_WEIGHT_KG = DIMENSIONAL_WEIGHT_KG',                     res:'pass', s:2},
    {id:'TC-WD-03',agent:'AG-CAP-WEIGHTDIM',n:'DIM factor 4800 used for ground, 5000 for air',exp:'DIMENSIONAL_WEIGHT_KG differs by transport mode',              res:'pass', s:3},

    // AG-AI-DWELL
    {id:'TC-DW-01',agent:'AG-AI-DWELL',n:'Stale model (>24h) raises amber health',         exp:'health = amber TENDER_HINT = CAUTION',                           res:'pass', s:1},
    {id:'TC-DW-02',agent:'AG-AI-DWELL',n:'Fresh model within training window → green health',exp:'health = green DWELL_CONFIDENCE_PCT >= 75',                    res:'pass', s:2},

    // AG-AI-CARRIERRANK
    {id:'TC-CR-01',agent:'AG-AI-CARRIERRANK',n:'Score normalisation — no carrier dominates vector',exp:'No CARRIER_SCORE_VECTOR component > 1.0',                 res:'pass', s:1},
    {id:'TC-CR-02',agent:'AG-AI-CARRIERRANK',n:'Low-capacity signal penalises carrier rank', exp:'CARRIER rank drops when CAPACITY_SIGNAL = LOW (test v3.1.0)',   res:'fail', got:'CAPACITY_SIGNAL not yet wired in PROD (v3.0.1)', s:2},
    {id:'TC-CR-03',agent:'AG-AI-CARRIERRANK',n:'Carrier with zero history not ranked',       exp:'CARRIER excluded from TOP_CARRIER_GID if no shipment history',  res:'pass', s:3},

    // AG-AI-ETAPRED
    {id:'TC-EP-01',agent:'AG-AI-ETAPRED',n:'Weather-risk LOW → ETA unchanged from baseline',exp:'REVISED_ETA_TS = carrier transit baseline ETA_CONFIDENCE >= 0.80',res:'pass', s:1},
    {id:'TC-EP-02',agent:'AG-AI-ETAPRED',n:'Severe weather on lane → DELAY_RISK_SCORE > 0.5',exp:'DELAY_RISK_SCORE > 0.5 REVISED_ETA extended',                 res:'pass', s:2},

    // AG-AI-ANOMALY
    {id:'TC-AN-01',agent:'AG-AI-ANOMALY',n:'Normal event sequence → ANOMALY_SCORE < 0.3',  exp:'No ANOMALY_ALERT_GID created SCORE < 0.3',                       res:'pass', s:1},
    {id:'TC-AN-02',agent:'AG-AI-ANOMALY',n:'Reversed PICKUP/DEPARTURE sequence → anomaly raised',exp:'ANOMALY_TYPE = SEQUENCE_VIOLATION ANOMALY_SCORE > 0.7',   res:'pass', s:2},
    {id:'TC-AN-03',agent:'AG-AI-ANOMALY',n:'False positive rate < 5% on 90D rolling baseline',exp:'FP_RATE < 0.05 on holdout set',                               res:'pass', s:3},

    // AG-AI-CAPACITYFORECAST
    {id:'TC-CF-01',agent:'AG-AI-CAPACITYFORECAST',n:'< 30 shipments history → forecast skipped',exp:'No CAPACITY_FORECAST_GID REASON = INSUFFICIENT_HISTORY',     res:'pass', s:1},
    {id:'TC-CF-02',agent:'AG-AI-CAPACITYFORECAST',n:'CAPACITY_RISK_SCORE > 0.7 triggers alert',exp:'CAPACITY_RISK_SCORE > 0.7 PROCUREMENT_ALERT emitted',         res:'pass', s:2},

    // AG-COMP-HAZMAT
    {id:'TC-HM-01',agent:'AG-COMP-HAZMAT',n:'Incompatible hazmat classes on same shipment → blocked',exp:"HAZMAT_CLEARED_FLG = N REASON = 'CLASS_INCOMPATIBILITY'", res:'pass', s:1},
    {id:'TC-HM-02',agent:'AG-COMP-HAZMAT',n:'ERG number mismatch → compliance record not written',exp:'COMPLIANCE_RECORD_GID = NULL REASON = ERG_MISMATCH',        res:'pass', s:2},
    {id:'TC-HM-03',agent:'AG-COMP-HAZMAT',n:'Valid hazmat → placard code written and event emitted',exp:'PLACARD_REQUIREMENT_CODE set HAZMAT_CLEARED event emitted',res:'pass', s:3},

    // AG-COMP-CUSTSDECL
    {id:'TC-CD-01',agent:'AG-COMP-CUSTSDECL',n:'AES ITN returned within 15s → CUSTOMS_SUBMITTED_FLG = Y',exp:'ITN_NUMBER set CUSTOMS_SUBMITTED_FLG = Y',          res:'pass', s:1},
    {id:'TC-CD-02',agent:'AG-COMP-CUSTSDECL',n:'AES timeout after 60s → fallback ITN flagged for manual review',exp:'CUSTOMS_SUBMITTED_FLG = N MANUAL_REVIEW_FLG = Y', res:'pass', s:2},
    {id:'TC-CD-03',agent:'AG-COMP-CUSTSDECL',n:'Missing HS tariff code → submission blocked', exp:"CUSTOMS_SUBMITTED_FLG = N REASON = 'MISSING_HS_CODE'",         res:'pass', s:3},

    // AG-COMP-SANCTIONSCR
    {id:'TC-SS-01',agent:'AG-COMP-SANCTIONSCR',n:'SDN list match → ORDER blocked',          exp:"SANCTIONS_RESULT_CODE = 'BLOCKED' ORDER held for compliance review",res:'pass',s:1},
    {id:'TC-SS-02',agent:'AG-COMP-SANCTIONSCR',n:'EU Consolidated List checked alongside OFAC',exp:'SCREENING_RECORD_GID includes EU list version',               res:'pass', s:2},
    {id:'TC-SS-03',agent:'AG-COMP-SANCTIONSCR',n:'Clear result → OFAC_SCREEN_TS written',   exp:"SANCTIONS_RESULT_CODE = 'CLEAR' OFAC_SCREEN_TS = NOW()",          res:'pass', s:3},

    // AG-COMP-INCOTERM
    {id:'TC-IC-01',agent:'AG-COMP-INCOTERM',n:'DAP Incoterm → freight is shipper responsibility',exp:'COST_RESPONSIBILITY for FREIGHT assigned to shipper GL code', res:'pass', s:1},
    {id:'TC-IC-02',agent:'AG-COMP-INCOTERM',n:'EXW Incoterm → all costs consignee responsibility',exp:'All COST_LINE_ITEMS assigned to consignee GL code',         res:'pass', s:2},
    {id:'TC-IC-03',agent:'AG-COMP-INCOTERM',n:'Unrecognised Incoterm code → compliance blocked',exp:'INCOTERM_APPLIED_FLG = N REASON = UNRECOGNISED_INCOTERM',     res:'pass', s:3},

    // AG-COMP-EXPORTLIC
    {id:'TC-EL-01',agent:'AG-COMP-EXPORTLIC',n:'BIS API timeout → order blocked (fail-safe)', exp:"LICENSE_CLEARED_FLG = N REASON = 'BIS_API_TIMEOUT'",             res:'pass', s:1},
    {id:'TC-EL-02',agent:'AG-COMP-EXPORTLIC',n:'Non-controlled ECCN → license not required, cleared',exp:'LICENSE_CLEARED_FLG = Y LICENSE_NUMBER = NLR',           res:'pass', s:2},
    {id:'TC-EL-03',agent:'AG-COMP-EXPORTLIC',n:'Expired export license → order blocked',     exp:"LICENSE_CLEARED_FLG = N REASON = 'LICENSE_EXPIRED'",               res:'pass', s:3},

    // AG-ORD-CONSOL
    {id:'TC-CO-01',agent:'AG-ORD-CONSOL',n:'FTL order excluded from LTL consolidation',      exp:'No CONSOLIDATED_ORDER_SET_GID for FTL transport mode',            res:'pass', s:1},
    {id:'TC-CO-02',agent:'AG-ORD-CONSOL',n:'5 LTL orders same zone → consolidated with savings',exp:'CONSOLIDATED_ORDER_SET_GID created CONSOLIDATION_SAVINGS_USD > 0', res:'pass', s:2},
    {id:'TC-CO-03',agent:'AG-ORD-CONSOL',n:'Null DEST_ZONE_GID order excluded from pool',   exp:'Order with NULL zone falls through to single-stop behaviour',       res:'pass', s:3},

    // AG-RATE-SPOTBID
    {id:'TC-SB-01',agent:'AG-RATE-SPOTBID',n:'Contract rate available → spot bid not triggered',exp:'SPOT_BID_GID = NULL agent exits early',                      res:'pass', s:1},
    {id:'TC-SB-02',agent:'AG-RATE-SPOTBID',n:'Counter-offer within 5% → auto-accepted',      exp:"SPOT_BID_STATUS = 'ACCEPTED' COUNTER_ACCEPTED = true",            res:'pass', s:2},
    {id:'TC-SB-03',agent:'AG-RATE-SPOTBID',n:'Zero bids received → order escalated',         exp:"SPOT_BID_STATUS = 'NO_BIDS' ORDER escalated to planner",          res:'pass', s:3},

    // AG-RATE-ACCESSORIAL
    {id:'TC-AC-01',agent:'AG-RATE-ACCESSORIAL',n:'Residential + FSC applied correctly',      exp:'ACCESSORIAL_TOTAL_USD = FSC + RESI_CHARGE',                      res:'pass', s:1},
    {id:'TC-AC-02',agent:'AG-RATE-ACCESSORIAL',n:'Non-residential — residential charge not applied',exp:'ACCESSORIAL_TOTAL_USD = FSC only',                         res:'pass', s:2},
    {id:'TC-AC-03',agent:'AG-RATE-ACCESSORIAL',n:'ADJUSTED_FREIGHT_COST_USD = base + all accessorials',exp:'ADJUSTED_FREIGHT_COST = BASE + ACCESSORIAL_TOTAL',     res:'pass', s:3},

    // AG-SHIP-COSTALLOC
    {id:'TC-CA-01',agent:'AG-SHIP-COSTALLOC',n:'WEIGHT basis splits correctly by kg',        exp:'ALLOCATED_AMOUNT_USD proportional to SHIP_UNIT weight',           res:'pass', s:1},
    {id:'TC-CA-02',agent:'AG-SHIP-COSTALLOC',n:'EQUAL basis splits evenly across cost centres',exp:'ALLOCATED_AMOUNT_USD = TOTAL / COST_CENTER_COUNT for each CC',  res:'pass', s:2},
    {id:'TC-CA-03',agent:'AG-SHIP-COSTALLOC',n:'Rounding delta assigned to largest cost centre',exp:'Sum of ALLOCATED_AMOUNT_USD = FREIGHT_COST_USD exactly',       res:'pass', s:3},

    // AG-SHIP-CARRPERF
    {id:'TC-CP-01',agent:'AG-SHIP-CARRPERF',n:'OTD computed correctly from scheduled vs actual delivery',exp:'ON_TIME_DELIVERY_PCT = on_time_count/total * 100',    res:'pass', s:1},
    {id:'TC-CP-02',agent:'AG-SHIP-CARRPERF',n:'OVERALL_SCORE is composite of 3 metrics',     exp:'CARRIER_OVERALL_SCORE = weighted(OTD, ACCEPT_RATE, INV_ACCURACY)', res:'pass', s:2},
    {id:'TC-CP-03',agent:'AG-SHIP-CARRPERF',n:'Scorecard emits CARRIER_SCORECARD_UPDATED event',exp:'evt=CARRIER_SCORECARD_UPDATED CARRIER_GID in payload',         res:'pass', s:3},

    // AG-INV-ACCRUAL
    {id:'TC-ACC-01',agent:'AG-INV-ACCRUAL',n:'Idempotent — second SHIPMENT_CONFIRMED does not double-post',exp:'ACCRUAL_ENTRY_GID count = 1 ALREADY_POSTED guard works',res:'pass',s:1},
    {id:'TC-ACC-02',agent:'AG-INV-ACCRUAL',n:'Reversal date is first day of next accounting period',exp:'ACCRUAL_REVERSAL_DATE = first day of ACCOUNTING_PERIOD+1',  res:'pass', s:2},
    {id:'TC-ACC-03',agent:'AG-INV-ACCRUAL',n:'Missing GL_ACCOUNT_GID → accrual skipped with error log',exp:'No ACCRUAL_ENTRY_GID GL_ERROR logged',                 res:'pass', s:3},

    // AG-INV-DISPUTE
    {id:'TC-DIS-01',agent:'AG-INV-DISPUTE',n:'Dispute age > 90 days rejected',               exp:"DISPUTE_CASE_GID = NULL REASON = 'DISPUTE_WINDOW_EXPIRED'",       res:'pass', s:1},
    {id:'TC-DIS-02',agent:'AG-INV-DISPUTE',n:'Carrier notified within 24h of dispute case creation',exp:'CARRIER_NOTIFIED_TS within 24h of DISPUTE_CREATED_TS',     res:'pass', s:2},
    {id:'TC-DIS-03',agent:'AG-INV-DISPUTE',n:'Resolution amount = contracted vs invoiced delta',exp:'RESOLUTION_AMOUNT_USD = INVOICE_AMOUNT - CONTRACTED_AMOUNT',   res:'pass', s:3},

    // AG-CAP-LOADPLAN
    {id:'TC-LP2-01',agent:'AG-CAP-LOADPLAN',n:'Incompatible hazmat classes placed in separate zones',exp:'LOAD_SEQUENCE has separation gap HAZMAT_ZONE_MAP populated',res:'pass',s:1},
    {id:'TC-LP2-02',agent:'AG-CAP-LOADPLAN',n:'Equipment utilisation > 95% triggers review flag',exp:'LOAD_PLAN_APPROVED_FLG = N REVIEW_REASON = HIGH_UTILISATION', res:'pass', s:2},
    {id:'TC-LP2-03',agent:'AG-CAP-LOADPLAN',n:'Load plan is idempotent on replay',           exp:'LOAD_PLAN_GID unchanged on duplicate SHIPMENT_PLANNED event',     res:'pass', s:3},

    // AG-AI-LANEOPT
    {id:'TC-LO-01',agent:'AG-AI-LANEOPT',n:'< 30 shipments → no recommendation generated',  exp:'LANE_RECOMMENDATION_GID = NULL REASON = INSUFFICIENT_HISTORY',    res:'pass', s:1},
    {id:'TC-LO-02',agent:'AG-AI-LANEOPT',n:'Recommendation confidence < 0.6 → advisory only',exp:'OPTIMIZATION_CONFIDENCE_PCT < 60 label = ADVISORY_ONLY',         res:'fail', got:'Confidence threshold not yet enforced in v0.9-beta', s:2},
    {id:'TC-LO-03',agent:'AG-AI-LANEOPT',n:'PROJECTED_SAVINGS_USD > 0 when optimal != current carrier',exp:'PROJECTED_SAVINGS_USD > 0',                            res:'pass', s:3},

    // AG-AI-CARRCHURN
    {id:'TC-CC-01',agent:'AG-AI-CARRCHURN',n:'OTD < 80% AND acceptance < 85% → HIGH churn tier',exp:"CHURN_RISK_TIER = 'HIGH' CHURN_ALERT_GID created",            res:'pass', s:1},
    {id:'TC-CC-02',agent:'AG-AI-CARRCHURN',n:'Churn computed only on settled scorecard (BATCH_COMPLETE_FLG)',exp:'Agent waits for SCORECARD_BATCH_COMPLETE_FLG=Y',  res:'fail', got:'SCORECARD_BATCH_COMPLETE_FLG guard not yet implemented (C-011)', s:2},
    {id:'TC-CC-03',agent:'AG-AI-CARRCHURN',n:'BACKUP_CARRIER_GID identified from same lanes',  exp:'BACKUP_CARRIER_GID is a carrier active on same LANE_GIDs',       res:'pass', s:3},

    // AG-ORD-CREDITHOLD
    {id:'TC-CH-01',agent:'AG-ORD-CREDITHOLD',n:'Account over credit limit → hold applied',   exp:"HOLD_STATUS = 'HELD' HOLD_REASON = 'CREDIT_LIMIT_EXCEEDED'",       res:'pass', s:1},
    {id:'TC-CH-02',agent:'AG-ORD-CREDITHOLD',n:'Zero-value order passes credit check',        exp:"HOLD_STATUS = 'CLEAR' agent exits early on zero-value order",      res:'pass', s:2},
    {id:'TC-CH-03',agent:'AG-ORD-CREDITHOLD',n:'Null CREDIT_LIMIT_GID → hold not applied',   exp:"HOLD_STATUS = 'CLEAR' REASON = 'NO_CREDIT_LIMIT_CONFIGURED'",     res:'pass', s:3},
  ];

  let testCount = 0;
  for (const t of tests) {
    if (have.has(t.agent)) continue; // skip if agent already has regression tests
    await q(`INSERT INTO regression_tests(id,agent_id,name,expect_text,result,got_text,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [t.id, t.agent, t.n, t.exp, t.res, t.got||null, t.s]);
    testCount++;
  }
  console.log('[enrich] Regression tests inserted:', testCount);
}

// ─── 9. Fix overview_metrics ───────────────────────────────────────────────────
async function refreshMetrics() {
  console.log('\n[enrich] Refreshing overview_metrics…');
  const r = await q('SELECT COUNT(*) AS total, SUM(CASE WHEN health=\'green\' THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN health=\'amber\' THEN 1 ELSE 0 END) AS amber, SUM(CASE WHEN health=\'red\' THEN 1 ELSE 0 END) AS red FROM agents');
  const { total, healthy, amber, red } = r[0];
  const updates = [
    { key:'agents_total',   value:String(total),   sub:null },
    { key:'agents_healthy', value:String(healthy),  sub:Math.round(healthy/total*100)+'%' },
    { key:'agents_amber',   value:String(amber),    sub:Math.round(amber/total*100)+'%' },
    { key:'agents_red',     value:String(red),      sub:Math.round(red/total*100)+'%' },
  ];
  for (const u of updates) {
    await q('UPDATE overview_metrics SET value=$1,sub=$2 WHERE key=$3',[u.value,u.sub,u.key]);
  }
  console.log('[enrich] Metrics updated — total agents:', total, 'healthy:', healthy, 'amber:', amber, 'red:', red);
}

// ─── 10. Audit log entries for new promotions ─────────────────────────────────
async function seedAuditEntries() {
  console.log('\n[enrich] Adding audit log entries for new agents…');
  const entries = [
    { time:'2026-07-22T09:00:00Z', username:'s.patel',   action:'Promote agent version',  target:'AG-ORD-ORDERVAL v1.2.0 → PROD',       env:'PROD', result:'Success', tone:'teal', note:'Order validation agent — address, date, weight and service level guards' },
    { time:'2026-07-22T09:15:00Z', username:'c.morales', action:'Promote agent version',  target:'AG-COMP-EXPORTLIC v2.0.1 → PROD',      env:'PROD', result:'Success', tone:'teal', note:'BIS EAR API integration; fail-safe on timeout — approved by Legal 2026-07-21' },
    { time:'2026-07-21T14:00:00Z', username:'d.kim',     action:'Promote agent version',  target:'AG-INV-ACCRUAL v1.1.0 → PROD',         env:'PROD', result:'Success', tone:'teal', note:'Automatic GL reversal scheduling — closes 2-day period-end delay' },
    { time:'2026-07-21T11:30:00Z', username:'l.tran',    action:'Promote agent version',  target:'AG-CAP-LOADPLAN v2.1.3 → PROD',        env:'PROD', result:'Success', tone:'teal', note:'Hazmat separation zones — DOT compliance; equipment utilisation now tracked' },
    { time:'2026-07-20T16:00:00Z', username:'a.okafor',  action:'Promote agent version',  target:'AG-SHIP-CARRPERF v2.0.0 → PROD',       env:'PROD', result:'Success', tone:'teal', note:'Invoice variance metric added to carrier composite score' },
    { time:'2026-07-20T14:00:00Z', username:'d.kim',     action:'Promote agent version',  target:'AG-SHIP-COSTALLOC v1.4.0 → PROD',      env:'PROD', result:'Success', tone:'teal', note:'4 allocation bases now supported (WEIGHT/VOLUME/VALUE/EQUAL)' },
    { time:'2026-07-19T10:00:00Z', username:'r.nguyen',  action:'Deploy new agent',       target:'AG-AI-LANEOPT v0.9-beta → DEV',        env:'DEV',  result:'Success', tone:'blue', note:'Lane optimization model — beta deployment, confidence threshold enforcement pending' },
    { time:'2026-07-18T15:00:00Z', username:'r.nguyen',  action:'Deploy new agent',       target:'AG-AI-CARRCHURN v1.0.2 → PROD',        env:'PROD', result:'Success', tone:'teal', note:'Carrier churn risk predictor — HIGH risk NWL.WARD detected (C-011 noted)' },
    { time:'2026-07-17T09:00:00Z', username:'r.nguyen',  action:'Promote agent version',  target:'AG-ORD-CONSOL v2.3.0 → PROD',          env:'PROD', result:'Success', tone:'teal', note:'Stop-sequence optimisation adds 6.4% pool cost saving' },
    { time:'2026-07-16T11:00:00Z', username:'d.kim',     action:'Deploy new agent',       target:'AG-INV-DISPUTE v1.3.1 → PROD',         env:'PROD', result:'Success', tone:'teal', note:'Auto-reconciliation against contracted rate; NWL.INV.8841 dispute resolved' },
    { time:'2026-07-15T14:00:00Z', username:'s.patel',   action:'Promote agent version',  target:'AG-RATE-ACCESSORIAL v3.1.2 → PROD',    env:'PROD', result:'Success', tone:'teal', note:'Liftgate and inside delivery charges added' },
    { time:'2026-07-14T10:00:00Z', username:'s.patel',   action:'Promote agent version',  target:'AG-RATE-SPOTBID v1.0.4 → PROD',        env:'PROD', result:'Success', tone:'teal', note:'60-min bid window and counter-offer threshold — ops SLA agreed 2026-07-13' },
    { time:'2026-07-22T08:00:00Z', username:'system',    action:'Detect conflict',        target:'C-009', env:'PROD', result:'Critical raised', tone:'red', note:'AG-ORD-ORDERVAL / AG-COMP-EXPORTLIC race on ORDER_RELEASED — null validation status read by export check' },
    { time:'2026-07-21T08:00:00Z', username:'system',    action:'Detect conflict',        target:'C-010', env:'PROD', result:'Warning raised', tone:'amber', note:'AG-SHIP-COSTALLOC / AG-INV-ACCRUAL GL misalignment in 1.8% of multi-stop shipments' },
    { time:'2026-07-20T08:00:00Z', username:'system',    action:'Detect conflict',        target:'C-011', env:'PROD', result:'Warning raised', tone:'amber', note:'AG-AI-CARRCHURN reads partially-updated CARRIER_OVERALL_SCORE during nightly batch — 22% alert inflation' },
  ];
  for (const e of entries) {
    await q(`INSERT INTO audit_log(time,username,action,target,env,result,tone,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.time,e.username,e.action,e.target,e.env,e.result,e.tone,e.note]);
  }
  console.log('[enrich] Audit entries inserted:', entries.length);
}

// ─── 11. New scheduled jobs for new agents ─────────────────────────────────────
async function seedJobs() {
  console.log('\n[enrich] Inserting new scheduled jobs…');
  const jobs = [
    { id:'JOB-LANEOPT-RUN',    name:'Lane Optimization Quarterly Batch', cron:'0 1 1 */3 *', last_run:'2026-07-01 01:00', duration:'22m 18s', trend:'flat', health:'green' },
    { id:'JOB-CARRCHURN-DAILY',name:'Carrier Churn Risk Daily Sweep',    cron:'0 3 * * *',   last_run:'Today 03:00',     duration:'8m 44s',  trend:'up',   health:'amber' },
    { id:'JOB-COSTALLOC-CLOSE',name:'Monthly Cost Allocation Close',     cron:'0 6 1 * *',   last_run:'2026-07-01 06:00',duration:'14m 22s', trend:'flat', health:'green' },
    { id:'JOB-ACCRUAL-REV',    name:'GL Accrual Reversal Batch',         cron:'0 7 1 * *',   last_run:'2026-07-01 07:00',duration:'3m 18s',  trend:'down', health:'green' },
    { id:'JOB-EXPORTLIC-SYNC', name:'Export License List Refresh',       cron:'0 0 * * 1',   last_run:'2026-07-21 00:00',duration:'1m 12s',  trend:'flat', health:'green' },
    { id:'JOB-SPOTBID-EXPIRE', name:'Spot Bid Expiry Sweep',             cron:'*/15 * * * *',last_run:'Today 15:45',     duration:'0m 12s',  trend:'flat', health:'green' },
  ];
  for (const j of jobs) {
    await q(`INSERT INTO jobs(id,name,cron,last_run,duration,trend,health) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [j.id,j.name,j.cron,j.last_run,j.duration,j.trend,j.health]);
  }
  console.log('[enrich] Jobs inserted:', jobs.length);
}

// ─── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[enrich] Starting database enrichment…');
  try {
    await seedNewAgents();
    await seedNewAgentData();
    await seedEdges();
    await seedConflicts();
    await seedDiffs();
    await seedSnapshots();
    await seedTraceRuns();
    await seedRegressionTests();
    await refreshMetrics();
    await seedAuditEntries();
    await seedJobs();
    console.log('\n[enrich] ✅  Enrichment complete.');
  } catch (e) {
    console.error('[enrich] ✗ Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
