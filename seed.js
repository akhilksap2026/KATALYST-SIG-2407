'use strict';
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

async function run() {
  const force = process.argv.includes('--force');

  // Guard: skip seeding if data already exists, unless --force is passed.
  const existing = await q('SELECT COUNT(*) AS n FROM agents');
  if (parseInt(existing[0].n) > 0) {
    if (!force) {
      console.log('[seed] Data already exists (' + existing[0].n + ' agents). Skipping seed.');
      console.log('[seed] Run with --force to truncate and re-seed: node seed.js --force');
      await pool.end();
      return;
    }
    console.log('[seed] --force flag set — truncating existing data and re-seeding...');
  }

  console.log('Truncating tables...');
  await q(`TRUNCATE TABLE
    regression_tests, agent_diffs, overview_metrics, live_events,
    trace_steps, trace_runs, audit_log, conflicts,
    workflow_edges, agent_drafts, agent_writes, agent_reads,
    agent_actions, agent_conditions, agents, jobs
    RESTART IDENTITY CASCADE`);

  // ─── AGENTS ────────────────────────────────────────────────────────────────
  console.log('Seeding agents...');
  const agents = [
    // ── Order Release ──────────────────────────────────────────────────────
    {
      id:'AG-ORD-RATESVC', name:'Rate & Service Selection',
      domain:'Order Release', type:'Rating', version:'v4.2.1',
      owner:'s.patel', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'High', success_rate:97.3, health:'green', gx:50, gy:64
    },
    {
      id:'AG-ORD-CREDITHOLD', name:'Credit Hold Check',
      domain:'Order Release', type:'Compliance', version:'v1.4.2',
      owner:'s.patel', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'Critical', success_rate:99.1, health:'green', gx:50, gy:212
    },
    {
      id:'AG-ORD-BULKPLAN', name:'Bulk Plan Builder',
      domain:'Order Release', type:'Planning', version:'v3.0.5',
      owner:'r.nguyen', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'High', success_rate:96.8, health:'green', gx:50, gy:360
    },
    {
      id:'AG-ORD-SVCLEVSEL', name:'Service Level Selector',
      domain:'Order Release', type:'Rating', version:'v2.1.0',
      owner:'s.patel', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'High', success_rate:98.4, health:'green', gx:50, gy:508
    },
    {
      id:'AG-ORD-LANEPREF', name:'Lane Preference Override',
      domain:'Order Release', type:'Routing', version:'v1.3.3',
      owner:'r.nguyen', trigger_name:'Rate Applied', evt:'RATE_APPLIED',
      priority:'Medium', success_rate:93.7, health:'amber', gx:50, gy:656
    },
    {
      id:'AG-ORD-HAZMATVAL', name:'Hazmat Pre-Validation',
      domain:'Order Release', type:'Compliance', version:'v2.0.0',
      owner:'c.morales', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'Critical', success_rate:99.9, health:'green', gx:50, gy:804
    },
    // ── Shipment Execution ─────────────────────────────────────────────────
    {
      id:'AG-SHIP-AUTOTENDER', name:'Auto-Tender on Plan',
      domain:'Shipment Execution', type:'Tender', version:'v2.4.1',
      owner:'m.reyes', trigger_name:'Shipment Planned', evt:'SHIPMENT_PLANNED',
      priority:'Critical', success_rate:98.2, health:'green', gx:330, gy:64
    },
    {
      id:'AG-SHIP-TENDERRESP', name:'Tender Response Handler',
      domain:'Shipment Execution', type:'Tender', version:'v1.9.0',
      owner:'m.reyes', trigger_name:'Tender Response Received', evt:'TENDER_RESPONSE',
      priority:'High', success_rate:99.1, health:'green', gx:330, gy:212
    },
    {
      id:'AG-SHIP-RETENDER', name:'Auto Re-Tender on Decline',
      domain:'Shipment Execution', type:'Tender', version:'v2.0.3',
      owner:'a.okafor', trigger_name:'Tender Declined', evt:'TENDER_DECLINED',
      priority:'High', success_rate:95.6, health:'amber', gx:330, gy:360
    },
    {
      id:'AG-SHIP-DOCGEN', name:'Document Generation',
      domain:'Shipment Execution', type:'Document', version:'v3.1.0',
      owner:'l.tran', trigger_name:'Shipment Confirmed', evt:'SHIPMENT_CONFIRMED',
      priority:'Medium', success_rate:99.7, health:'green', gx:330, gy:508
    },
    {
      id:'AG-SHIP-TRACKUPDATE', name:'Shipment Track & Trace',
      domain:'Shipment Execution', type:'Tracking', version:'v2.3.1',
      owner:'l.tran', trigger_name:'Shipment Confirmed', evt:'SHIPMENT_CONFIRMED',
      priority:'Medium', success_rate:96.4, health:'green', gx:330, gy:656
    },
    {
      id:'AG-SHIP-EXCEPTIONMGR', name:'Exception Manager',
      domain:'Shipment Execution', type:'Exception', version:'v1.5.2',
      owner:'a.okafor', trigger_name:'Exception Raised', evt:'EXCEPTION_RAISED',
      priority:'High', success_rate:91.2, health:'amber', gx:330, gy:804
    },
    {
      id:'AG-SHIP-APPOINTSCHED', name:'Appointment Scheduler',
      domain:'Shipment Execution', type:'Scheduling', version:'v1.1.0',
      owner:'l.tran', trigger_name:'Shipment Confirmed', evt:'SHIPMENT_CONFIRMED',
      priority:'Medium', success_rate:94.8, health:'amber', gx:330, gy:952
    },
    {
      id:'AG-SHIP-MILESTONEUPD', name:'Milestone Status Updater',
      domain:'Shipment Execution', type:'Tracking', version:'v2.6.0',
      owner:'l.tran', trigger_name:'Tracking Event Received', evt:'TRACKING_EVENT',
      priority:'Medium', success_rate:99.3, health:'green', gx:330, gy:1100
    },
    // ── Invoice & Finance ──────────────────────────────────────────────────
    {
      id:'AG-INV-AUTOAPPROVE', name:'Auto-Approve under Tolerance',
      domain:'Invoice & Finance', type:'Invoice', version:'v2.1.5',
      owner:'d.kim', trigger_name:'Invoice Received', evt:'INVOICE_RECEIVED',
      priority:'Medium', success_rate:94.1, health:'amber', gx:610, gy:64
    },
    {
      id:'AG-INV-VARIANCE', name:'Variance Escalation',
      domain:'Invoice & Finance', type:'Invoice', version:'v1.2.0',
      owner:'d.kim', trigger_name:'Invoice Received', evt:'INVOICE_RECEIVED',
      priority:'Medium', success_rate:92.5, health:'amber', gx:610, gy:212
    },
    {
      id:'AG-INV-FRTAUDIT', name:'Freight Bill Audit',
      domain:'Invoice & Finance', type:'Invoice', version:'v1.0.4',
      owner:'d.kim', trigger_name:'Invoice Approved', evt:'INVOICE_APPROVED',
      priority:'Low', success_rate:98.8, health:'green', gx:610, gy:360
    },
    {
      id:'AG-INV-REMATCH', name:'Invoice Rematch Engine',
      domain:'Invoice & Finance', type:'Invoice', version:'v1.6.1',
      owner:'d.kim', trigger_name:'Invoice Received', evt:'INVOICE_RECEIVED',
      priority:'Medium', success_rate:97.4, health:'green', gx:610, gy:508
    },
    {
      id:'AG-INV-PAYTERM', name:'Payment Term Enforcer',
      domain:'Invoice & Finance', type:'Compliance', version:'v1.0.1',
      owner:'c.morales', trigger_name:'Invoice Approved', evt:'INVOICE_APPROVED',
      priority:'Low', success_rate:99.6, health:'green', gx:610, gy:656
    },
    // ── Capacity & Yard ────────────────────────────────────────────────────
    {
      id:'AG-CAP-YARDCHECK', name:'Yard Capacity Check',
      domain:'Capacity & Yard', type:'Capacity', version:'v1.2.0',
      owner:'j.santos', trigger_name:'Shipment Planned', evt:'SHIPMENT_PLANNED',
      priority:'High', success_rate:97.1, health:'green', gx:890, gy:64
    },
    {
      id:'AG-CAP-DOCKALLOC', name:'Dock Door Allocation',
      domain:'Capacity & Yard', type:'Scheduling', version:'v2.0.2',
      owner:'j.santos', trigger_name:'Appointment Confirmed', evt:'APPT_CONFIRMED',
      priority:'High', success_rate:95.3, health:'amber', gx:890, gy:212
    },
    {
      id:'AG-CAP-POOLLOAD', name:'Pool Load Optimizer',
      domain:'Capacity & Yard', type:'Planning', version:'v1.4.0',
      owner:'r.nguyen', trigger_name:'Shipment Planned', evt:'SHIPMENT_PLANNED',
      priority:'Medium', success_rate:88.9, health:'red', gx:890, gy:360
    },
    {
      id:'AG-CAP-WEIGHTDIM', name:'Weight & Dims Validator',
      domain:'Capacity & Yard', type:'Compliance', version:'v3.0.0',
      owner:'j.santos', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'Critical', success_rate:99.8, health:'green', gx:890, gy:508
    },
    // ── Oracle AI ──────────────────────────────────────────────────────────
    {
      id:'AG-AI-DWELL', name:'Dwell Prediction',
      domain:'Oracle AI', type:'AI', version:'v0.9-beta',
      owner:'oracle.ai', trigger_name:'Shipment Planned', evt:'SHIPMENT_PLANNED',
      priority:'Medium', success_rate:88.4, health:'amber', gx:1170, gy:64
    },
    {
      id:'AG-AI-CARRIERRANK', name:'AI Carrier Ranking',
      domain:'Oracle AI', type:'AI', version:'v1.2.0',
      owner:'oracle.ai', trigger_name:'Rate Applied', evt:'RATE_APPLIED',
      priority:'Medium', success_rate:91.2, health:'amber', gx:1170, gy:212
    },
    {
      id:'AG-AI-ETAPRED', name:'ETA Prediction Engine',
      domain:'Oracle AI', type:'AI', version:'v2.1.0',
      owner:'oracle.ai', trigger_name:'Shipment Confirmed', evt:'SHIPMENT_CONFIRMED',
      priority:'Medium', success_rate:93.7, health:'green', gx:1170, gy:360
    },
    {
      id:'AG-AI-ANOMALY', name:'Anomaly Detection',
      domain:'Oracle AI', type:'AI', version:'v1.0.3',
      owner:'oracle.ai', trigger_name:'Tracking Event Received', evt:'TRACKING_EVENT',
      priority:'High', success_rate:87.6, health:'red', gx:1170, gy:508
    },
    {
      id:'AG-AI-CAPACITYFORECAST', name:'Capacity Demand Forecast',
      domain:'Oracle AI', type:'AI', version:'v0.8-beta',
      owner:'oracle.ai', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'Low', success_rate:84.2, health:'amber', gx:1170, gy:656
    },
    // ── Compliance & Customs ───────────────────────────────────────────────
    {
      id:'AG-COMP-HAZMAT', name:'Hazmat Compliance Validator',
      domain:'Compliance & Customs', type:'Compliance', version:'v4.1.0',
      owner:'c.morales', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'Critical', success_rate:100.0, health:'green', gx:1450, gy:64
    },
    {
      id:'AG-COMP-CUSTSDECL', name:'Customs Declaration Builder',
      domain:'Compliance & Customs', type:'Compliance', version:'v2.3.0',
      owner:'c.morales', trigger_name:'Shipment Confirmed', evt:'SHIPMENT_CONFIRMED',
      priority:'High', success_rate:98.1, health:'green', gx:1450, gy:212
    },
    {
      id:'AG-COMP-SANCTIONSCR', name:'Sanctions Screening',
      domain:'Compliance & Customs', type:'Compliance', version:'v3.0.1',
      owner:'c.morales', trigger_name:'Order Released', evt:'ORDER_RELEASED',
      priority:'Critical', success_rate:99.7, health:'green', gx:1450, gy:360
    },
    {
      id:'AG-COMP-INCOTERM', name:'Incoterm Rule Enforcer',
      domain:'Compliance & Customs', type:'Compliance', version:'v1.5.0',
      owner:'c.morales', trigger_name:'Shipment Planned', evt:'SHIPMENT_PLANNED',
      priority:'High', success_rate:99.2, health:'green', gx:1450, gy:508
    },
  ];

  for (const a of agents) {
    await q(`INSERT INTO agents(id,name,domain,type,version,owner,trigger_name,evt,priority,success_rate,health,gx,gy)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [a.id,a.name,a.domain,a.type,a.version,a.owner,a.trigger_name,a.evt,a.priority,a.success_rate,a.health,a.gx,a.gy]);
  }

  // ─── CONDITIONS ───────────────────────────────────────────────────────────
  console.log('Seeding conditions...');
  const conditions = {
    'AG-ORD-RATESVC': [
      "ORDER_MOVEMENT.status = 'NEW'",
      "SERVICE_LEVEL is not null",
      "SHIP_UNIT.total_weight_kg > 0",
      "SOURCE_LOCATION.country_code3_gid is not null",
      "DEST_LOCATION.country_code3_gid is not null",
    ],
    'AG-ORD-CREDITHOLD': [
      "CUSTOMER_CREDIT_STATUS = 'HOLD' OR CUSTOMER_CREDIT_STATUS = 'REVIEW'",
      "ORDER_RELEASE.total_value_usd > 0",
      "CREDIT_LIMIT_GID is not null",
      "ACCOUNT_RECEIVABLE_BALANCE <= CREDIT_LIMIT_USD",
    ],
    'AG-ORD-BULKPLAN': [
      "BULK_PLAN_ENABLED_FLG = 'Y'",
      "ORDER_MOVEMENT.status = 'RATE_APPLIED'",
      "ORDER_RELEASE.ship_date_range_hours <= 48",
      "SHIP_FROM_LOCATION_GID = CONSOLIDATION_HUB_GID",
      "OPEN_ORDER_COUNT >= BULK_MIN_THRESHOLD",
    ],
    'AG-ORD-SVCLEVSEL': [
      "REQUESTED_SERVICE_LEVEL is not null",
      "LANE_GID is not null",
      "EFFECTIVE_DATE <= NOW() AND EXPIRY_DATE >= NOW()",
      "SERVICE_PROVIDER_GID is not null",
    ],
    'AG-ORD-LANEPREF': [
      "LANE_PREFERENCE.status = 'ACTIVE'",
      "RATE_GID is not null",
      "CARRIER_SCOREBOARD_RANK <= 3",
      "OVERRIDE_REASON_CODE is not null",
    ],
    'AG-ORD-HAZMATVAL': [
      "SHIP_UNIT_LINE.hazmat_class_gid is not null",
      "UN_NUMBER is not null",
      "PACKING_GROUP IN ('I','II','III')",
      "EMERGENCY_CONTACT_PHONE is not null",
    ],
    'AG-SHIP-AUTOTENDER': [
      "SHIPMENT.status = 'PLANNED'",
      "RATE_GID is not null",
      "SERVICE_PROVIDER_GID is not null",
      "AUTO_TENDER_FLG = 'Y'",
      "TENDER_EXPIRY_HOURS > 0",
      "CARRIER_CONTRACT_STATUS = 'ACTIVE'",
    ],
    'AG-SHIP-TENDERRESP': [
      "TENDER_STATUS IN ('ACCEPTED','DECLINED','COUNTERED')",
      "TENDER_EXPIRY_TS > NOW()",
      "SHIPMENT_GID is not null",
    ],
    'AG-SHIP-RETENDER': [
      "TENDER_STATUS = 'DECLINED'",
      "RETENDER_ATTEMPT_COUNT < MAX_RETENDER_ATTEMPTS",
      "NEXT_CARRIER_RANK is not null",
      "RETENDER_WINDOW_HOURS > 0",
    ],
    'AG-SHIP-DOCGEN': [
      "SHIPMENT.status = 'CONFIRMED'",
      "BOL_REQUIRED_FLG = 'Y'",
      "CONSIGNEE_ADDRESS is not null",
      "SHIP_UNIT_COUNT > 0",
    ],
    'AG-SHIP-TRACKUPDATE': [
      "SHIPMENT.status IN ('CONFIRMED','IN_TRANSIT')",
      "TRACKING_PROVIDER_GID is not null",
      "CARRIER_PRO_NUMBER is not null",
    ],
    'AG-SHIP-EXCEPTIONMGR': [
      "EXCEPTION_TYPE IN ('LATE','DAMAGED','MISSING','REFUSED')",
      "EXCEPTION_STATUS = 'OPEN'",
      "RESPONSIBLE_PARTY_GID is not null",
    ],
    'AG-SHIP-APPOINTSCHED': [
      "APPOINTMENT_REQUIRED_FLG = 'Y'",
      "DEST_FACILITY_GID is not null",
      "SCHEDULED_DELIVERY_DATE is not null",
      "FACILITY_APPT_LEAD_TIME_HRS > 0",
    ],
    'AG-SHIP-MILESTONEUPD': [
      "TRACKING_EVENT_CODE IN ('PICKUP','DEPARTURE','ARRIVAL','DELIVERED')",
      "SHIPMENT_GID is not null",
      "EVENT_TIMESTAMP is not null",
    ],
    'AG-INV-AUTOAPPROVE': [
      "INVOICE_STATUS = 'RECEIVED'",
      "ABS(INVOICE_AMOUNT - CONTRACTED_AMOUNT) / CONTRACTED_AMOUNT <= TOLERANCE_PCT",
      "SHIPMENT_GID is not null",
      "INVOICE_CURRENCY_CODE = 'USD'",
    ],
    'AG-INV-VARIANCE': [
      "INVOICE_STATUS = 'RECEIVED'",
      "ABS(INVOICE_AMOUNT - CONTRACTED_AMOUNT) / CONTRACTED_AMOUNT > TOLERANCE_PCT",
      "VARIANCE_REASON_CODE is null",
    ],
    'AG-INV-FRTAUDIT': [
      "INVOICE_STATUS = 'APPROVED'",
      "FREIGHT_BILL_AUDIT_FLG = 'Y'",
      "AUDITOR_GID is not null",
    ],
    'AG-INV-REMATCH': [
      "INVOICE_STATUS = 'UNMATCHED'",
      "SHIPMENT_GID is not null OR ORDER_RELEASE_GID is not null",
      "REMATCH_ATTEMPT_COUNT < 3",
    ],
    'AG-INV-PAYTERM': [
      "INVOICE_STATUS = 'APPROVED'",
      "PAYMENT_TERM_GID is not null",
      "DUE_DATE > NOW()",
    ],
    'AG-CAP-YARDCHECK': [
      "FACILITY_GID is not null",
      "AVAILABLE_DOCK_DOORS > 0",
      "SCHEDULED_ARRIVAL_DATE is not null",
      "EQUIPMENT_TYPE_GID matches FACILITY_COMPATIBLE_EQUIPMENT",
    ],
    'AG-CAP-DOCKALLOC': [
      "APPOINTMENT_STATUS = 'CONFIRMED'",
      "DOCK_DOOR_GID is not null",
      "ARRIVAL_WINDOW_START < ARRIVAL_WINDOW_END",
      "EQUIPMENT_GID is not null",
    ],
    'AG-CAP-POOLLOAD': [
      "POOL_LOAD_ELIGIBLE_FLG = 'Y'",
      "DEST_ZONE_GID matches POOL_ZONE_GID",
      "SHIP_UNIT_COUNT >= MIN_POOL_UNITS",
      "POOL_CLOSE_DATE >= SHIP_DATE",
    ],
    'AG-CAP-WEIGHTDIM': [
      "SHIP_UNIT.total_weight_kg is not null",
      "SHIP_UNIT.height_cm is not null AND SHIP_UNIT.width_cm is not null",
      "EQUIPMENT_TYPE_GID is not null",
      "MAX_WEIGHT_KG is not null",
    ],
    'AG-AI-DWELL': [
      "SHIPMENT_GID is not null",
      "DEST_LOCATION_GID is not null",
      "HISTORICAL_DWELL_DAYS_AVG is not null",
      "CARRIER_GID is not null",
    ],
    'AG-AI-CARRIERRANK': [
      "RATE_GID is not null",
      "LANE_GID is not null",
      "CARRIER_SCOREBOARD_DATA_AGE_DAYS <= 30",
      "CANDIDATE_CARRIER_COUNT >= 2",
    ],
    'AG-AI-ETAPRED': [
      "SHIPMENT.status = 'IN_TRANSIT'",
      "ORIGIN_LOCATION_GID is not null",
      "DEST_LOCATION_GID is not null",
      "CARRIER_PRO_NUMBER is not null",
    ],
    'AG-AI-ANOMALY': [
      "TRACKING_EVENT_CODE is not null",
      "SHIPMENT_GID is not null",
      "ANOMALY_DETECTION_ENABLED_FLG = 'Y'",
    ],
    'AG-AI-CAPACITYFORECAST': [
      "FORECAST_HORIZON_DAYS > 0",
      "ORIGIN_LOCATION_GID is not null",
      "HISTORICAL_VOLUME_DATA_AVAILABLE = 'Y'",
    ],
    'AG-COMP-HAZMAT': [
      "HAZMAT_CLASS_GID is not null",
      "UN_NUMBER REGEXP '^UN[0-9]{4}$'",
      "CARRIER_HAZMAT_CERTIFIED = 'Y'",
      "PROPER_SHIPPING_NAME is not null",
      "EMERGENCY_RESPONSE_GUIDE_NUM is not null",
    ],
    'AG-COMP-CUSTSDECL': [
      "CROSS_BORDER_FLG = 'Y'",
      "CUSTOMS_BROKER_GID is not null",
      "HS_TARIFF_CODE is not null",
      "COUNTRY_OF_ORIGIN_GID is not null",
      "COMMERCIAL_VALUE_USD > 0",
    ],
    'AG-COMP-SANCTIONSCR': [
      "CONSIGNEE_PARTY_GID is not null",
      "COUNTRY_OF_DEST_CODE3 is not null",
      "OFAC_SCREEN_REQUIRED_FLG = 'Y'",
    ],
    'AG-COMP-INCOTERM': [
      "INCOTERM_CODE IN ('EXW','FCA','CPT','CIP','DAP','DPU','DDP','FAS','FOB','CFR','CIF')",
      "RISK_TRANSFER_POINT_GID is not null",
      "COST_RESPONSIBILITY_PARTY_GID is not null",
    ],
  };

  for (const [agentId, conds] of Object.entries(conditions)) {
    for (let i = 0; i < conds.length; i++) {
      await q('INSERT INTO agent_conditions(agent_id,condition_text,sort_order) VALUES($1,$2,$3)',
        [agentId, conds[i], i]);
    }
  }

  // ─── ACTIONS ──────────────────────────────────────────────────────────────
  console.log('Seeding actions...');
  const actions = {
    'AG-ORD-RATESVC': [
      "computeRate(ORDER_MOVEMENT_GID, LANE_GID, SERVICE_LEVEL_GID)",
      "selectServiceProvider(RATE_GEO_COST_GID)",
      "writeRateOffering(ORDER_MOVEMENT_GID, RATE_GID, COST_USD)",
      "emitEvent('RATE_APPLIED', ORDER_MOVEMENT_GID)",
    ],
    'AG-ORD-CREDITHOLD': [
      "queryCreditStatus(INVOICE_CORP_GID)",
      "applyHold(ORDER_RELEASE_GID, HOLD_REASON='CREDIT_LIMIT_EXCEEDED')",
      "notifyUser(CREDIT_MANAGER_GID, HOLD_NOTIFICATION_TEMPLATE)",
      "emitEvent('CREDIT_HOLD_APPLIED', ORDER_RELEASE_GID)",
    ],
    'AG-ORD-BULKPLAN': [
      "groupOrders(SOURCE_LOCATION_GID, SHIP_DATE_WINDOW_HOURS=48)",
      "computeBulkPlan(ORDER_GROUP_GID, EQUIPMENT_TYPE_GID)",
      "createBulkPlanRecord(BULK_PLAN_GID, ORDER_MOVEMENT_GIDs[])",
      "emitEvent('BULK_PLAN_CREATED', BULK_PLAN_GID)",
    ],
    'AG-ORD-SVCLEVSEL': [
      "lookupServiceLevel(LANE_GID, REQUESTED_TRANSIT_DAYS)",
      "applyServiceLevel(ORDER_MOVEMENT_GID, SERVICE_LEVEL_GID)",
      "writeTransitTime(ORDER_MOVEMENT_GID, TRANSIT_DAYS)",
      "emitEvent('SERVICE_LEVEL_ASSIGNED', ORDER_MOVEMENT_GID)",
    ],
    'AG-ORD-LANEPREF': [
      "queryLanePreference(LANE_GID, SHIPPER_GID)",
      "overrideCarrier(ORDER_MOVEMENT_GID, PREFERRED_CARRIER_GID)",
      "logOverride(LANE_PREF_OVERRIDE_AUDIT_GID, OVERRIDE_REASON_CODE)",
      "emitEvent('LANE_OVERRIDE_APPLIED', ORDER_MOVEMENT_GID)",
    ],
    'AG-ORD-HAZMATVAL': [
      "validateHazmatClass(SHIP_UNIT_LINE_GID)",
      "checkCarrierHazmatCertification(CARRIER_GID, HAZMAT_CLASS_GID)",
      "attachSDS(ORDER_RELEASE_GID, SDS_DOCUMENT_GID)",
      "emitEvent('HAZMAT_VALIDATED', ORDER_RELEASE_GID)",
    ],
    'AG-SHIP-AUTOTENDER': [
      "buildTenderRequest(SHIPMENT_GID, SERVICE_PROVIDER_GID, RATE_GID)",
      "transmitTender(TENDER_GID, CARRIER_COMM_METHOD_GID)",
      "setTenderExpiry(TENDER_GID, EXPIRY_TS=NOW()+TENDER_EXPIRY_HOURS)",
      "writeShipmentStatus(SHIPMENT_GID, 'TENDERED')",
      "emitEvent('TENDER_SENT', SHIPMENT_GID)",
    ],
    'AG-SHIP-TENDERRESP': [
      "parseTenderResponse(TENDER_RESPONSE_GID)",
      "updateTenderStatus(TENDER_GID, TENDER_STATUS)",
      "updateShipmentStatus(SHIPMENT_GID, RESOLVED_STATUS)",
      "emitEvent(TENDER_STATUS_RESOLVED_EVT, SHIPMENT_GID)",
    ],
    'AG-SHIP-RETENDER': [
      "selectNextCarrier(SHIPMENT_GID, CARRIER_RANK_OFFSET+1)",
      "buildRetenderRequest(SHIPMENT_GID, NEXT_CARRIER_GID)",
      "incrementRetenderCount(SHIPMENT_GID)",
      "transmitTender(RETENDER_GID, CARRIER_COMM_METHOD_GID)",
      "emitEvent('RETENDER_SENT', SHIPMENT_GID)",
    ],
    'AG-SHIP-DOCGEN': [
      "generateBOL(SHIPMENT_GID, BOL_TEMPLATE_GID)",
      "generatePackingList(SHIPMENT_GID)",
      "generateShippingLabel(SHIP_UNIT_GID, LABEL_TEMPLATE_GID)",
      "attachDocuments(SHIPMENT_GID, [BOL_GID, PACKING_LIST_GID, LABEL_GID])",
      "emitEvent('DOCUMENTS_GENERATED', SHIPMENT_GID)",
    ],
    'AG-SHIP-TRACKUPDATE': [
      "registerTrackingSubscription(SHIPMENT_GID, CARRIER_PRO_NUMBER)",
      "pollCarrierTrackingAPI(CARRIER_TRACKING_URL, CARRIER_PRO_NUMBER)",
      "writeTrackingEvent(SHIPMENT_GID, EVENT_CODE, EVENT_TS, EVENT_LOCATION)",
      "emitEvent('TRACKING_EVENT', SHIPMENT_GID)",
    ],
    'AG-SHIP-EXCEPTIONMGR': [
      "classifyException(EXCEPTION_TYPE, SEVERITY_CODE)",
      "assignResponsibleParty(EXCEPTION_GID, RESPONSIBLE_PARTY_GID)",
      "createClaimRecord(EXCEPTION_GID, CLAIM_AMOUNT_USD)",
      "notifyStakeholders(SHIPMENT_GID, EXCEPTION_NOTIFICATION_TEMPLATE)",
      "emitEvent('EXCEPTION_ASSIGNED', EXCEPTION_GID)",
    ],
    'AG-SHIP-APPOINTSCHED': [
      "requestAppointment(DEST_FACILITY_GID, ARRIVAL_WINDOW_GID)",
      "writeAppointmentConfirmation(SHIPMENT_GID, APPT_GID)",
      "notifyCarrier(CARRIER_GID, APPT_CONFIRMATION_TEMPLATE)",
      "emitEvent('APPT_CONFIRMED', SHIPMENT_GID)",
    ],
    'AG-SHIP-MILESTONEUPD': [
      "mapTrackingCodeToMilestone(TRACKING_EVENT_CODE, MILESTONE_CODE)",
      "writeMilestoneRecord(SHIPMENT_GID, MILESTONE_CODE, EVENT_TS)",
      "updateETA(SHIPMENT_GID, REVISED_ETA_TS)",
      "emitEvent('MILESTONE_UPDATED', SHIPMENT_GID)",
    ],
    'AG-INV-AUTOAPPROVE': [
      "matchInvoiceToShipment(INVOICE_GID, SHIPMENT_GID)",
      "computeVariancePct(INVOICE_AMOUNT, CONTRACTED_AMOUNT)",
      "approveInvoice(INVOICE_GID, APPROVAL_REASON='WITHIN_TOLERANCE')",
      "emitEvent('INVOICE_APPROVED', INVOICE_GID)",
    ],
    'AG-INV-VARIANCE': [
      "computeVariancePct(INVOICE_AMOUNT, CONTRACTED_AMOUNT)",
      "lookupVarianceReason(INVOICE_GID)",
      "escalateToApprover(INVOICE_GID, APPROVER_GID, VARIANCE_PCT)",
      "emitEvent('INVOICE_ESCALATED', INVOICE_GID)",
    ],
    'AG-INV-FRTAUDIT': [
      "auditFreightCharges(INVOICE_GID, CONTRACTED_RATE_GID)",
      "flagDiscrepancy(INVOICE_GID, DISCREPANCY_TYPE, AMOUNT_USD)",
      "generateAuditReport(INVOICE_GID, AUDIT_REPORT_GID)",
      "emitEvent('FREIGHT_AUDIT_COMPLETE', INVOICE_GID)",
    ],
    'AG-INV-REMATCH': [
      "searchMatchableShipments(INVOICE_GID, MATCH_STRATEGY='FUZZY_PRO')",
      "proposeMatch(INVOICE_GID, CANDIDATE_SHIPMENT_GID, CONFIDENCE_SCORE)",
      "applyMatch(INVOICE_GID, SHIPMENT_GID)",
      "emitEvent('INVOICE_MATCHED', INVOICE_GID)",
    ],
    'AG-INV-PAYTERM': [
      "resolveDueDate(INVOICE_GID, PAYMENT_TERM_GID, INVOICE_DATE)",
      "schedulePayment(INVOICE_GID, DUE_DATE, PAYMENT_AMOUNT_USD)",
      "writePaymentSchedule(INVOICE_GID, PAYMENT_SCHEDULE_GID)",
      "emitEvent('PAYMENT_SCHEDULED', INVOICE_GID)",
    ],
    'AG-CAP-YARDCHECK': [
      "queryYardCapacity(FACILITY_GID, ARRIVAL_DATE)",
      "checkEquipmentCompatibility(EQUIPMENT_TYPE_GID, FACILITY_GID)",
      "reserveYardSlot(FACILITY_GID, ARRIVAL_WINDOW_GID)",
      "emitEvent('YARD_SLOT_RESERVED', SHIPMENT_GID)",
    ],
    'AG-CAP-DOCKALLOC': [
      "selectDockDoor(FACILITY_GID, EQUIPMENT_TYPE_GID, ARRIVAL_WINDOW_GID)",
      "writeDockAssignment(SHIPMENT_GID, DOCK_DOOR_GID, SLOT_TS)",
      "notifyYardManager(FACILITY_GID, DOCK_ASSIGNMENT_TEMPLATE)",
      "emitEvent('DOCK_ASSIGNED', SHIPMENT_GID)",
    ],
    'AG-CAP-POOLLOAD': [
      "consolidateOrdersToPool(ORDER_MOVEMENT_GIDs[], POOL_LOAD_GID)",
      "optimizeStopSequence(POOL_LOAD_GID)",
      "computePoolLoadCost(POOL_LOAD_GID, RATE_GEO_COST_GID)",
      "emitEvent('POOL_LOAD_BUILT', POOL_LOAD_GID)",
    ],
    'AG-CAP-WEIGHTDIM': [
      "sumShipUnitWeight(SHIP_UNIT_GIDs[])",
      "validateAgainstEquipmentMax(TOTAL_WEIGHT_KG, EQUIPMENT_TYPE_GID)",
      "computeDimensionalWeight(L_CM, W_CM, H_CM, DIM_FACTOR=5000)",
      "emitEvent('WEIGHT_DIMS_VALIDATED', SHIPMENT_GID)",
    ],
    'AG-AI-DWELL': [
      "inferDwellPrediction(DEST_LOCATION_GID, CARRIER_GID, EQUIPMENT_TYPE_GID)",
      "writeDwellForecast(SHIPMENT_GID, PREDICTED_DWELL_HOURS, CONFIDENCE)",
      "emitHint('DWELL_FORECAST', SHIPMENT_GID)",
    ],
    'AG-AI-CARRIERRANK': [
      "scoreCarriers(LANE_GID, RATE_GID, SCOREBOARD_WEIGHTS)",
      "rankCandidateCarriers(CARRIER_GID[], SCORE_VECTOR)",
      "writeCarrierRankHint(SHIPMENT_GID, RANKED_CARRIER_GIDs[])",
      "emitHint('CARRIER_RANK_HINT', SHIPMENT_GID)",
    ],
    'AG-AI-ETAPRED': [
      "predictETA(SHIPMENT_GID, CURRENT_LOCATION_GID, DEST_LOCATION_GID)",
      "adjustForHistoricalDelay(CARRIER_GID, LANE_GID)",
      "writeEtaRevision(SHIPMENT_GID, REVISED_ETA_TS, CONFIDENCE_PCT)",
      "emitEvent('ETA_REVISED', SHIPMENT_GID)",
    ],
    'AG-AI-ANOMALY': [
      "scoreAnomalyProbability(TRACKING_EVENT_GID, BASELINE_VECTOR)",
      "classifyAnomaly(ANOMALY_TYPE, SEVERITY_CODE)",
      "alertOperations(SHIPMENT_GID, ANOMALY_TYPE, ANOMALY_SCORE)",
      "emitEvent('ANOMALY_DETECTED', SHIPMENT_GID)",
    ],
    'AG-AI-CAPACITYFORECAST': [
      "forecastVolume(ORIGIN_LOCATION_GID, HORIZON_DAYS=14)",
      "writeCapacityForecast(LANE_GID, FORECAST_DATE, PREDICTED_UNITS)",
      "alertProcurement(LANE_GID, CAPACITY_RISK_SCORE)",
      "emitEvent('CAPACITY_FORECAST_UPDATED', LANE_GID)",
    ],
    'AG-COMP-HAZMAT': [
      "validateHazmatPackaging(SHIP_UNIT_LINE_GID, UN_NUMBER)",
      "verifyERG(EMERGENCY_RESPONSE_GUIDE_NUM, HAZMAT_CLASS_GID)",
      "applyPlacardingRules(SHIPMENT_GID, HAZMAT_CLASS_GID)",
      "writeComplianceRecord(SHIPMENT_GID, 'HAZMAT_COMPLIANT')",
      "emitEvent('HAZMAT_CLEARED', ORDER_RELEASE_GID)",
    ],
    'AG-COMP-CUSTSDECL': [
      "buildCommercialInvoice(SHIPMENT_GID, HS_TARIFF_CODE, DECLARED_VALUE_USD)",
      "submitCustomsEntry(CUSTOMS_BROKER_GID, SHIPMENT_GID)",
      "writeITN(SHIPMENT_GID, ITN_NUMBER)",
      "emitEvent('CUSTOMS_SUBMITTED', SHIPMENT_GID)",
    ],
    'AG-COMP-SANCTIONSCR': [
      "screenPartyAgainstOFAC(CONSIGNEE_PARTY_GID)",
      "screenDestinationCountry(COUNTRY_OF_DEST_CODE3)",
      "writeScreeningResult(ORDER_RELEASE_GID, RESULT='CLEAR')",
      "emitEvent('SANCTIONS_CLEARED', ORDER_RELEASE_GID)",
    ],
    'AG-COMP-INCOTERM': [
      "resolveRiskTransferPoint(INCOTERM_CODE, SHIPMENT_GID)",
      "assignCostResponsibility(INCOTERM_CODE, COST_LINE_ITEMS[])",
      "writeIncotermCompliance(SHIPMENT_GID, INCOTERM_CODE)",
      "emitEvent('INCOTERM_APPLIED', SHIPMENT_GID)",
    ],
  };

  for (const [agentId, acts] of Object.entries(actions)) {
    for (let i = 0; i < acts.length; i++) {
      await q('INSERT INTO agent_actions(agent_id,action_text,sort_order) VALUES($1,$2,$3)',
        [agentId, acts[i], i]);
    }
  }

  // ─── READS ────────────────────────────────────────────────────────────────
  console.log('Seeding reads/writes...');
  const reads = {
    'AG-ORD-RATESVC':        ['ORDER_MOVEMENT_GID','SHIP_UNIT_GID','SERVICE_LEVEL_GID','LANE_GID','SHIPPER_CORP_GID','EQUIPMENT_TYPE_GID'],
    'AG-ORD-CREDITHOLD':     ['ORDER_RELEASE_GID','INVOICE_CORP_GID','CREDIT_LIMIT_GID','CREDIT_LIMIT_USD','ACCOUNT_RECEIVABLE_BALANCE'],
    'AG-ORD-BULKPLAN':       ['ORDER_MOVEMENT_GID','SOURCE_LOCATION_GID','SHIP_DATE','EQUIPMENT_TYPE_GID','OPEN_ORDER_COUNT'],
    'AG-ORD-SVCLEVSEL':      ['ORDER_MOVEMENT_GID','REQUESTED_TRANSIT_DAYS','LANE_GID','SERVICE_PROVIDER_GID'],
    'AG-ORD-LANEPREF':       ['ORDER_MOVEMENT_GID','LANE_GID','RATE_GID','CARRIER_SCOREBOARD_RANK','SHIPPER_GID'],
    'AG-ORD-HAZMATVAL':      ['SHIP_UNIT_LINE_GID','HAZMAT_CLASS_GID','UN_NUMBER','PACKING_GROUP','CARRIER_GID'],
    'AG-SHIP-AUTOTENDER':    ['SHIPMENT_GID','RATE_GID','SERVICE_PROVIDER_GID','TENDER_EXPIRY_HOURS','CARRIER_CONTRACT_STATUS','TENDER_HINT'],
    'AG-SHIP-TENDERRESP':    ['TENDER_RESPONSE_GID','TENDER_GID','SHIPMENT_GID','TENDER_STATUS'],
    'AG-SHIP-RETENDER':      ['SHIPMENT_GID','TENDER_GID','RETENDER_ATTEMPT_COUNT','MAX_RETENDER_ATTEMPTS','CARRIER_RANK_HINT'],
    'AG-SHIP-DOCGEN':        ['SHIPMENT_GID','BOL_TEMPLATE_GID','CONSIGNEE_ADDRESS_GID','SHIP_UNIT_GID[]'],
    'AG-SHIP-TRACKUPDATE':   ['SHIPMENT_GID','CARRIER_PRO_NUMBER','CARRIER_TRACKING_URL','TRACKING_PROVIDER_GID'],
    'AG-SHIP-EXCEPTIONMGR':  ['EXCEPTION_GID','EXCEPTION_TYPE','SHIPMENT_GID','RESPONSIBLE_PARTY_GID'],
    'AG-SHIP-APPOINTSCHED':  ['SHIPMENT_GID','DEST_FACILITY_GID','SCHEDULED_DELIVERY_DATE','FACILITY_APPT_LEAD_TIME_HRS'],
    'AG-SHIP-MILESTONEUPD':  ['TRACKING_EVENT_GID','SHIPMENT_GID','TRACKING_EVENT_CODE','EVENT_TIMESTAMP'],
    'AG-INV-AUTOAPPROVE':    ['INVOICE_GID','SHIPMENT_GID','INVOICE_AMOUNT','CONTRACTED_AMOUNT','TOLERANCE_PCT'],
    'AG-INV-VARIANCE':       ['INVOICE_GID','INVOICE_AMOUNT','CONTRACTED_AMOUNT','TOLERANCE_PCT','APPROVER_GID'],
    'AG-INV-FRTAUDIT':       ['INVOICE_GID','CONTRACTED_RATE_GID','FREIGHT_CHARGE_GID[]','AUDITOR_GID'],
    'AG-INV-REMATCH':        ['INVOICE_GID','CARRIER_PRO_NUMBER','SHIPMENT_GID','ORDER_RELEASE_GID'],
    'AG-INV-PAYTERM':        ['INVOICE_GID','PAYMENT_TERM_GID','INVOICE_DATE','INVOICE_AMOUNT'],
    'AG-CAP-YARDCHECK':      ['FACILITY_GID','ARRIVAL_DATE','EQUIPMENT_TYPE_GID','AVAILABLE_DOCK_DOORS'],
    'AG-CAP-DOCKALLOC':      ['APPOINTMENT_GID','FACILITY_GID','EQUIPMENT_TYPE_GID','ARRIVAL_WINDOW_GID'],
    'AG-CAP-POOLLOAD':       ['ORDER_MOVEMENT_GID[]','POOL_LOAD_GID','DEST_ZONE_GID','POOL_CLOSE_DATE'],
    'AG-CAP-WEIGHTDIM':      ['SHIP_UNIT_GID[]','EQUIPMENT_TYPE_GID','MAX_WEIGHT_KG','MAX_DIMS_CM'],
    'AG-AI-DWELL':           ['SHIPMENT_GID','DEST_LOCATION_GID','CARRIER_GID','EQUIPMENT_TYPE_GID','HISTORICAL_DWELL_DAYS_AVG'],
    'AG-AI-CARRIERRANK':     ['LANE_GID','RATE_GID','CARRIER_GID[]','SCOREBOARD_WEIGHTS','CARRIER_SCOREBOARD_RANK'],
    'AG-AI-ETAPRED':         ['SHIPMENT_GID','CURRENT_LOCATION_GID','DEST_LOCATION_GID','CARRIER_PRO_NUMBER','LANE_GID'],
    'AG-AI-ANOMALY':         ['TRACKING_EVENT_GID','SHIPMENT_GID','TRACKING_EVENT_CODE','BASELINE_VECTOR'],
    'AG-AI-CAPACITYFORECAST':['LANE_GID','ORIGIN_LOCATION_GID','HISTORICAL_VOLUME_DATA','FORECAST_HORIZON_DAYS'],
    'AG-COMP-HAZMAT':        ['SHIP_UNIT_LINE_GID','HAZMAT_CLASS_GID','UN_NUMBER','CARRIER_GID','EMERGENCY_RESPONSE_GUIDE_NUM'],
    'AG-COMP-CUSTSDECL':     ['SHIPMENT_GID','HS_TARIFF_CODE','COMMERCIAL_VALUE_USD','CUSTOMS_BROKER_GID','COUNTRY_OF_ORIGIN_GID'],
    'AG-COMP-SANCTIONSCR':   ['ORDER_RELEASE_GID','CONSIGNEE_PARTY_GID','COUNTRY_OF_DEST_CODE3','OFAC_LIST_VERSION'],
    'AG-COMP-INCOTERM':      ['SHIPMENT_GID','INCOTERM_CODE','RISK_TRANSFER_POINT_GID','COST_LINE_ITEMS[]'],
  };

  const writes = {
    'AG-ORD-RATESVC':        ['RATE_GID','SERVICE_GID','COST_USD','CARRIER_GID'],
    'AG-ORD-CREDITHOLD':     ['HOLD_STATUS','HOLD_REASON','HOLD_APPLIED_TS'],
    'AG-ORD-BULKPLAN':       ['BULK_PLAN_GID','CONSOLIDATED_ORDER_COUNT','ESTIMATED_COST_USD'],
    'AG-ORD-SVCLEVSEL':      ['SERVICE_LEVEL_GID','TRANSIT_DAYS','COMMIT_DATE'],
    'AG-ORD-LANEPREF':       ['PREFERRED_CARRIER_GID','OVERRIDE_REASON_CODE','OVERRIDE_APPLIED_FLG'],
    'AG-ORD-HAZMATVAL':      ['HAZMAT_VALIDATED_FLG','HAZMAT_COMPLIANCE_RECORD_GID'],
    'AG-SHIP-AUTOTENDER':    ['TENDER_GID','TENDER_STATUS','TENDER_EXPIRY_TS','SHIPMENT_STATUS'],
    'AG-SHIP-TENDERRESP':    ['TENDER_STATUS','SHIPMENT_STATUS','RESPONSE_RECORDED_TS'],
    'AG-SHIP-RETENDER':      ['TENDER_GID','RETENDER_ATTEMPT_COUNT','SHIPMENT_STATUS'],
    'AG-SHIP-DOCGEN':        ['BOL_GID','PACKING_LIST_GID','LABEL_GID','DOCUMENTS_READY_FLG'],
    'AG-SHIP-TRACKUPDATE':   ['TRACKING_EVENT_GID','CURRENT_LOCATION_GID','LAST_TRACKING_TS'],
    'AG-SHIP-EXCEPTIONMGR':  ['EXCEPTION_STATUS','RESPONSIBLE_PARTY_GID','CLAIM_GID'],
    'AG-SHIP-APPOINTSCHED':  ['APPOINTMENT_GID','APPT_CONFIRMED_FLG','DOCK_WINDOW_TS'],
    'AG-SHIP-MILESTONEUPD':  ['MILESTONE_CODE','MILESTONE_TS','REVISED_ETA_TS'],
    'AG-INV-AUTOAPPROVE':    ['INVOICE_STATUS','APPROVED_BY','APPROVED_TS'],
    'AG-INV-VARIANCE':       ['INVOICE_STATUS','VARIANCE_REASON_CODE','ESCALATED_TO_GID'],
    'AG-INV-FRTAUDIT':       ['AUDIT_RESULT_CODE','DISCREPANCY_AMOUNT_USD','AUDIT_REPORT_GID'],
    'AG-INV-REMATCH':        ['MATCHED_SHIPMENT_GID','MATCH_CONFIDENCE_SCORE','INVOICE_STATUS'],
    'AG-INV-PAYTERM':        ['DUE_DATE','PAYMENT_SCHEDULE_GID','PAYMENT_AMOUNT_USD'],
    'AG-CAP-YARDCHECK':      ['YARD_SLOT_GID','CAPACITY_STATUS','RESERVED_FLG'],
    'AG-CAP-DOCKALLOC':      ['DOCK_DOOR_GID','SLOT_START_TS','SLOT_END_TS'],
    'AG-CAP-POOLLOAD':       ['POOL_LOAD_GID','STOP_SEQUENCE','POOL_COST_USD'],
    'AG-CAP-WEIGHTDIM':      ['VALIDATED_FLG','GROSS_WEIGHT_KG','DIMENSIONAL_WEIGHT_KG','BILLABLE_WEIGHT_KG'],
    'AG-AI-DWELL':           ['PREDICTED_DWELL_HOURS','DWELL_CONFIDENCE_PCT','TENDER_HINT'],
    'AG-AI-CARRIERRANK':     ['CARRIER_RANK_HINT','CARRIER_SCORE_VECTOR','TOP_CARRIER_GID'],
    'AG-AI-ETAPRED':         ['REVISED_ETA_TS','ETA_CONFIDENCE_PCT','DELAY_RISK_SCORE'],
    'AG-AI-ANOMALY':         ['ANOMALY_TYPE','ANOMALY_SCORE','ANOMALY_ALERT_GID'],
    'AG-AI-CAPACITYFORECAST':['CAPACITY_FORECAST_GID','PREDICTED_UNITS','CAPACITY_RISK_SCORE'],
    'AG-COMP-HAZMAT':        ['HAZMAT_CLEARED_FLG','PLACARD_REQUIREMENT_CODE','COMPLIANCE_RECORD_GID'],
    'AG-COMP-CUSTSDECL':     ['CUSTOMS_ENTRY_GID','ITN_NUMBER','CUSTOMS_SUBMITTED_FLG'],
    'AG-COMP-SANCTIONSCR':   ['SANCTIONS_RESULT_CODE','OFAC_SCREEN_TS','SCREENING_RECORD_GID'],
    'AG-COMP-INCOTERM':      ['RISK_TRANSFER_POINT_GID','COST_RESPONSIBILITY_RECORD_GID','INCOTERM_APPLIED_FLG'],
  };

  for (const [agentId, fields] of Object.entries(reads)) {
    for (let i = 0; i < fields.length; i++)
      await q('INSERT INTO agent_reads(agent_id,field_name,sort_order) VALUES($1,$2,$3)', [agentId, fields[i], i]);
  }
  for (const [agentId, fields] of Object.entries(writes)) {
    for (let i = 0; i < fields.length; i++)
      await q('INSERT INTO agent_writes(agent_id,field_name,sort_order) VALUES($1,$2,$3)', [agentId, fields[i], i]);
  }

  // ─── WORKFLOW EDGES ───────────────────────────────────────────────────────
  console.log('Seeding workflow edges...');
  const edges = [
    // Order Release chain
    ['AG-ORD-HAZMATVAL',      'AG-ORD-RATESVC',       'flow'],
    ['AG-COMP-SANCTIONSCR',   'AG-ORD-RATESVC',       'flow'],
    ['AG-ORD-RATESVC',        'AG-ORD-BULKPLAN',      'flow'],
    ['AG-ORD-RATESVC',        'AG-ORD-SVCLEVSEL',     'flow'],
    ['AG-ORD-CREDITHOLD',     'AG-ORD-RATESVC',       'flow'],
    ['AG-ORD-SVCLEVSEL',      'AG-ORD-LANEPREF',      'flow'],
    ['AG-CAP-WEIGHTDIM',      'AG-ORD-RATESVC',       'flow'],
    // Order -> Shipment
    ['AG-ORD-RATESVC',        'AG-SHIP-AUTOTENDER',   'flow'],
    ['AG-ORD-BULKPLAN',       'AG-SHIP-AUTOTENDER',   'flow'],
    // Shipment execution chain
    ['AG-CAP-YARDCHECK',      'AG-SHIP-AUTOTENDER',   'flow'],
    ['AG-SHIP-AUTOTENDER',    'AG-SHIP-TENDERRESP',   'flow'],
    ['AG-SHIP-TENDERRESP',    'AG-SHIP-DOCGEN',       'flow'],
    ['AG-SHIP-TENDERRESP',    'AG-SHIP-RETENDER',     'flow'],
    ['AG-SHIP-TENDERRESP',    'AG-SHIP-TRACKUPDATE',  'flow'],
    ['AG-SHIP-RETENDER',      'AG-SHIP-TENDERRESP',   'flow'],
    ['AG-SHIP-DOCGEN',        'AG-COMP-CUSTSDECL',    'flow'],
    ['AG-SHIP-TRACKUPDATE',   'AG-SHIP-MILESTONEUPD', 'flow'],
    ['AG-SHIP-MILESTONEUPD',  'AG-AI-ETAPRED',        'ai' ],
    ['AG-SHIP-MILESTONEUPD',  'AG-AI-ANOMALY',        'ai' ],
    ['AG-SHIP-APPOINTSCHED',  'AG-CAP-DOCKALLOC',     'flow'],
    ['AG-SHIP-DOCGEN',        'AG-SHIP-APPOINTSCHED', 'flow'],
    // Invoice chain
    ['AG-SHIP-DOCGEN',        'AG-INV-AUTOAPPROVE',   'flow'],
    ['AG-INV-AUTOAPPROVE',    'AG-INV-FRTAUDIT',      'flow'],
    ['AG-INV-AUTOAPPROVE',    'AG-INV-VARIANCE',      'flow'],
    ['AG-INV-AUTOAPPROVE',    'AG-INV-REMATCH',       'flow'],
    ['AG-INV-VARIANCE',       'AG-INV-FRTAUDIT',      'flow'],
    ['AG-INV-FRTAUDIT',       'AG-INV-PAYTERM',       'flow'],
    // AI hints
    ['AG-AI-DWELL',           'AG-SHIP-AUTOTENDER',   'ai' ],
    ['AG-AI-CARRIERRANK',     'AG-SHIP-AUTOTENDER',   'ai' ],
    ['AG-AI-CARRIERRANK',     'AG-SHIP-RETENDER',     'ai' ],
    ['AG-AI-CAPACITYFORECAST','AG-ORD-BULKPLAN',      'ai' ],
    // Compliance
    ['AG-COMP-HAZMAT',        'AG-SHIP-DOCGEN',       'flow'],
    ['AG-COMP-INCOTERM',      'AG-INV-AUTOAPPROVE',   'flow'],
    ['AG-COMP-CUSTSDECL',     'AG-INV-AUTOAPPROVE',   'flow'],
    // Exception
    ['AG-SHIP-TRACKUPDATE',   'AG-SHIP-EXCEPTIONMGR', 'flow'],
    ['AG-SHIP-EXCEPTIONMGR',  'AG-INV-VARIANCE',      'flow'],
  ];
  for (const [from, to, type] of edges) {
    await q('INSERT INTO workflow_edges(from_agent_id,to_agent_id,edge_type) VALUES($1,$2,$3)', [from, to, type]);
  }

  // ─── CONFLICTS ────────────────────────────────────────────────────────────
  console.log('Seeding conflicts...');
  const conflicts = [
    {
      id:'C-001', severity:'critical', event:'ORDER_RELEASED',
      agent_a:'AG-ORD-RATESVC', agent_b:'AG-ORD-CREDITHOLD',
      detail:"Both AG-ORD-RATESVC and AG-ORD-CREDITHOLD trigger on ORDER_RELEASED and both attempt to write ORDER_MOVEMENT.status in the same transaction window. When a credit hold is applied after RATE_APPLIED is written, the hold flag is silently cleared on subsequent ORDER_MOVEMENT reads, allowing orders from suspended accounts to enter the tender queue. Observed in 3.1% of ORDER_RELEASED events against accounts in CREDIT_LIMIT_EXCEEDED state.",
      fix:"Introduce a checkpoint barrier: gate AG-ORD-RATESVC on a new CREDIT_CLEARED event emitted by AG-ORD-CREDITHOLD rather than ORDER_RELEASED directly. This guarantees credit validation precedes rate computation and eliminates the write-order ambiguity.",
      acknowledged: false
    },
    {
      id:'C-002', severity:'critical', event:'SHIPMENT_PLANNED',
      agent_a:'AG-SHIP-AUTOTENDER', agent_b:'AG-AI-DWELL',
      detail:"Both agents subscribe to SHIPMENT_PLANNED. Dwell Prediction writes TENDER_HINT which Auto-Tender reads -- but execution order is non-deterministic under PROD load. In 23% of observed runs Auto-Tender fires before TENDER_HINT is committed, producing sub-optimal carrier selection that ignores predicted dwell and penalizes high-dwell lanes. Race window averages 504ms under the PUNL66 morning surge (07:30–09:00 local).",
      fix:"Sequence AG-AI-DWELL before AG-SHIP-AUTOTENDER using an event gate on DWELL_FORECAST_READY availability. Alternatively gate Auto-Tender on TENDER_HINT with a bounded 500ms wait and fallback to default lane preference weights if the hint is absent.",
      acknowledged: false
    },
    {
      id:'C-003', severity:'warning', event:'INVOICE_RECEIVED',
      agent_a:'AG-INV-AUTOAPPROVE', agent_b:'AG-INV-VARIANCE',
      detail:"AG-INV-AUTOAPPROVE and AG-INV-VARIANCE both read INVOICE_AMOUNT and CONTRACTED_AMOUNT to compute variance independently. When CONTRACTED_AMOUNT is updated by a mid-cycle rate amendment (RATE_GEO_COST_GID revision), one agent may compute against the old rate while the other uses the new rate, causing contradictory approval and escalation signals to be emitted for the same INVOICE_GID. Affects invoices arriving within 90 seconds of a rate amendment.",
      fix:"Centralise variance computation into a shared view (V_INVOICE_VARIANCE) that agents read rather than recomputing. Add an optimistic lock on CONTRACTED_AMOUNT so both agents read the same snapshot within an event processing window.",
      acknowledged: false
    },
    {
      id:'C-004', severity:'warning', event:'TENDER_RESPONSE',
      agent_a:'AG-SHIP-RETENDER', agent_b:'AG-SHIP-TENDERRESP',
      detail:"AG-SHIP-TENDERRESP updates TENDER_STATUS to 'DECLINED' and emits TENDER_DECLINED. AG-SHIP-RETENDER, which subscribes to TENDER_DECLINED, immediately writes a new TENDER_GID for the same SHIPMENT_GID. In high-frequency decline scenarios (carrier queue exhaustion) both agents loop in a tight re-entrant cycle that creates orphaned TENDER_GID records without progressing SHIPMENT_STATUS. Observed 7 orphan tenders in the last 30 days.",
      fix:"Add a guard in AG-SHIP-RETENDER to check RETENDER_ATTEMPT_COUNT against MAX_RETENDER_ATTEMPTS before emitting a new tender. Add an idempotency key on TENDER_GID derived from SHIPMENT_GID+ATTEMPT_COUNT to prevent duplicate tender records.",
      acknowledged: false
    },
    {
      id:'C-005', severity:'critical', event:'RATE_APPLIED',
      agent_a:'AG-ORD-CREDITHOLD', agent_b:'AG-AI-CARRIERRANK',
      detail:"AG-AI-CARRIERRANK fires on RATE_APPLIED and reads RATE_GID as a primary scoring input for lane-ranking. However AG-ORD-RATESVC may emit RATE_APPLIED before AG-ORD-CREDITHOLD has resolved the hold status. If credit hold is subsequently applied, the shipment is suspended -- but AG-AI-CARRIERRANK has already emitted CARRIER_RANK_HINT with a carrier selection based on the now-cancelled rate. When the hold is released and the order re-enters the queue, the stale CARRIER_RANK_HINT is consumed by AG-SHIP-AUTOTENDER, selecting a carrier that may no longer have the rate offering. Observed in 18% of holds that are released within 2 hours.",
      fix:"Chain AG-AI-CARRIERRANK to a new CREDIT_CLEARED+RATE_APPLIED composite event rather than RATE_APPLIED alone. Alternatively, invalidate CARRIER_RANK_HINT whenever HOLD_STATUS changes and force AG-AI-CARRIERRANK to re-score on credit clearance.",
      acknowledged: false
    },
    {
      id:'C-006', severity:'critical', event:'SHIPMENT_CONFIRMED',
      agent_a:'AG-SHIP-DOCGEN', agent_b:'AG-COMP-CUSTSDECL',
      detail:"AG-SHIP-DOCGEN and AG-COMP-CUSTSDECL both trigger on SHIPMENT_CONFIRMED for cross-border shipments. AG-SHIP-DOCGEN writes BOL_GID which AG-COMP-CUSTSDECL requires to build the customs commercial invoice. On PUNL66 cross-border lanes, AG-COMP-CUSTSDECL fires within 120ms of SHIPMENT_CONFIRMED -- before AG-SHIP-DOCGEN has committed BOL_GID -- resulting in customs entries with null BOL reference. Mexican customs authority CBP rejects filings without BOL. Affects 11% of cross-border PUNL66 → MEXICO shipments.",
      fix:"Gate AG-COMP-CUSTSDECL on a BOL_READY event emitted by AG-SHIP-DOCGEN rather than SHIPMENT_CONFIRMED directly. This adds ~200ms of latency on cross-border lanes but eliminates null-BOL customs rejections.",
      acknowledged: false
    },
    {
      id:'C-007', severity:'warning', event:'SHIPMENT_PLANNED',
      agent_a:'AG-CAP-YARDCHECK', agent_b:'AG-CAP-POOLLOAD',
      detail:"AG-CAP-YARDCHECK reserves a yard slot (YARD_SLOT_GID) on SHIPMENT_PLANNED. AG-CAP-POOLLOAD consolidates orders into pool loads on the same event and may change the equipment type, invalidating the yard slot reserved by AG-CAP-YARDCHECK for the original equipment type. Dock door compatibility mismatches are then discovered only at appointment scheduling time, requiring manual yard manager intervention. Affects 8% of pool-eligible orders at DC Memphis and DC Laredo.",
      fix:"Sequence AG-CAP-POOLLOAD before AG-CAP-YARDCHECK. Emit a POOL_EQUIPMENT_FINALIZED event from AG-CAP-POOLLOAD that carries the confirmed EQUIPMENT_TYPE_GID, and use that as the trigger for AG-CAP-YARDCHECK slot reservation.",
      acknowledged: false
    },
    {
      id:'C-008', severity:'warning', event:'TRACKING_EVENT',
      agent_a:'AG-AI-ANOMALY', agent_b:'AG-SHIP-MILESTONEUPD',
      detail:"AG-AI-ANOMALY and AG-SHIP-MILESTONEUPD both process TRACKING_EVENT. AG-SHIP-MILESTONEUPD writes REVISED_ETA_TS while AG-AI-ANOMALY reads REVISED_ETA_TS as part of its anomaly baseline. If AG-SHIP-MILESTONEUPD has not yet committed REVISED_ETA_TS when AG-AI-ANOMALY reads it, the anomaly model scores against a stale ETA, producing false-positive delay anomalies on accurately-tracking shipments. False-positive rate is 14% on the BRAZIL lanes where milestone update latency averages 800ms.",
      fix:"AG-AI-ANOMALY should subscribe to MILESTONE_UPDATED event (emitted after REVISED_ETA_TS is committed) rather than the raw TRACKING_EVENT. This eliminates the read-before-write window.",
      acknowledged: true
    },
  ];
  for (const c of conflicts) {
    await q(`INSERT INTO conflicts(id,severity,event,agent_a,agent_b,detail,fix,acknowledged)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [c.id, c.severity, c.event, c.agent_a, c.agent_b, c.detail, c.fix, c.acknowledged]);
  }

  // ─── AUDIT LOG ────────────────────────────────────────────────────────────
  console.log('Seeding audit log...');
  const auditRows = [
    // Recent — today (reverse-chron)
    { time:'2026-07-21T16:44:00Z', username:'m.reyes',  action:'Promote agent version', target:'AG-SHIP-AUTOTENDER v2.4.1 → PROD', env:'PROD', result:'Success', tone:'teal', note:'TENDER_HINT gate backport — approved by a.okafor via OTM-5512' },
    { time:'2026-07-21T15:31:00Z', username:'s.patel',  action:'Edit agent conditions', target:'AG-ORD-RATESVC', env:'TEST', result:'Draft saved', tone:'blue', note:'Added CROSS_BORDER_FLG guard to prevent rating international orders against domestic RATE_GEO_COST records' },
    { time:'2026-07-21T14:17:00Z', username:'system',   action:'Detect conflict',        target:'C-006', env:'PROD', result:'Critical raised', tone:'red', note:'AG-SHIP-DOCGEN / AG-COMP-CUSTSDECL race on SHIPMENT_CONFIRMED — 11% of PUNL66→MEXICO CBP rejections correlated' },
    { time:'2026-07-21T13:58:00Z', username:'c.morales',action:'Acknowledge conflict',   target:'C-008', env:'PROD', result:'Acknowledged', tone:'teal', note:'AG-AI-ANOMALY will subscribe to MILESTONE_UPDATED in v1.0.4 — OTM-5489' },
    { time:'2026-07-21T13:02:00Z', username:'d.kim',    action:'Edit agent actions',     target:'AG-INV-AUTOAPPROVE', env:'DEV', result:'Draft saved', tone:'blue', note:'Extending TOLERANCE_PCT lookup to carrier-level override table (SP_INVOICE_TOLERANCE)' },
    { time:'2026-07-21T11:30:00Z', username:'a.okafor', action:'Run regression tests',   target:'AG-SHIP-RETENDER', env:'TEST', result:'6/6 passed', tone:'teal', note:null },
    { time:'2026-07-21T10:45:00Z', username:'system',   action:'Job missed schedule',    target:'JOB-DWELL-REFRESH', env:'PROD', result:'Missed — model stale', tone:'red', note:'Dwell Prediction model last refreshed 2026-07-20T01:12Z — OTM-5501 raised' },
    { time:'2026-07-21T09:14:00Z', username:'r.nguyen', action:'Edit agent conditions',  target:'AG-ORD-BULKPLAN', env:'DEV', result:'Draft saved', tone:'blue', note:'Lowered BULK_MIN_THRESHOLD from 5 to 3 for PTY hub — pilot program approval OTM-5497' },
    { time:'2026-07-21T08:52:00Z', username:'l.tran',   action:'Promote agent version',  target:'AG-SHIP-MILESTONEUPD v2.6.0 → TEST', env:'TEST', result:'Success', tone:'teal', note:'Added MILESTONE_UPDATED event emission — prerequisite for C-008 fix' },
    { time:'2026-07-21T07:30:00Z', username:'system',   action:'Detect conflict',        target:'C-007', env:'PROD', result:'Warning raised', tone:'amber', note:'AG-CAP-YARDCHECK / AG-CAP-POOLLOAD equipment type race at DC Memphis (8% hit rate)' },
    // Yesterday
    { time:'2026-07-20T22:05:00Z', username:'system',   action:'Job complete',           target:'JOB-TENDER-SWEEP', env:'PROD', result:'12,847 tenders processed — 4m 12s', tone:'teal', note:null },
    { time:'2026-07-20T18:41:00Z', username:'j.santos', action:'Edit agent conditions',  target:'AG-CAP-DOCKALLOC', env:'TEST', result:'Draft saved', tone:'blue', note:'Add REEFER equipment type exclusion for dock doors D1–D4 at DC Laredo' },
    { time:'2026-07-20T16:22:00Z', username:'m.reyes',  action:'Force retender',         target:'NWL.SH48201 (CHRW→ODFL)', env:'PROD', result:'Retender accepted', tone:'teal', note:'CHRW capacity refused — route PTY→PUNL66, escalated to planner per SLA policy' },
    { time:'2026-07-20T15:09:00Z', username:'system',   action:'Detect conflict',        target:'C-007', env:'PROD', result:'Warning raised', tone:'amber', note:'First detection of AG-CAP-YARDCHECK / AG-CAP-POOLLOAD equipment type mismatch' },
    { time:'2026-07-20T14:44:00Z', username:'d.kim',    action:'Acknowledge conflict',   target:'C-003', env:'PROD', result:'Acknowledged', tone:'teal', note:'V_INVOICE_VARIANCE shared view RFC submitted — OTM-5488' },
    { time:'2026-07-20T13:30:00Z', username:'oracle.ai',action:'Model retrain complete', target:'AG-AI-CARRIERRANK v1.2.0', env:'PROD', result:'Accuracy 91.2% (+2.1% vs prior)', tone:'teal', note:'Retrain on 90-day rolling window — new feature: CARRIER_DWELL_HISTORY' },
    { time:'2026-07-20T11:11:00Z', username:'c.morales',action:'Promote agent version',  target:'AG-COMP-SANCTIONSCR v3.0.1 → PROD', env:'PROD', result:'Success', tone:'teal', note:'OFAC SDN list 2026-07-15 update incorporated — zero-downtime hot-swap' },
    { time:'2026-07-20T09:00:00Z', username:'system',   action:'Job complete',           target:'JOB-FRTAUDIT', env:'PROD', result:'3,214 invoices audited — $47,820 discrepancy flagged', tone:'teal', note:null },
    { time:'2026-07-20T06:00:00Z', username:'system',   action:'Job complete',           target:'JOB-INV-TOL', env:'PROD', result:'841 auto-approved — avg variance 0.4%', tone:'teal', note:null },
    // Last week
    { time:'2026-07-18T17:29:00Z', username:'s.patel',  action:'Promote agent version',  target:'AG-ORD-HAZMATVAL v2.0.0 → PROD', env:'PROD', result:'Success', tone:'teal', note:'Added ERG number validation — DOT compliance requirement effective 2026-08-01' },
    { time:'2026-07-18T14:15:00Z', username:'a.okafor', action:'Edit agent actions',     target:'AG-SHIP-EXCEPTIONMGR', env:'DEV', result:'Draft saved', tone:'blue', note:'Auto-create claims for DAMAGED exceptions over $500 USD — pre-approved by finance OTM-5476' },
    { time:'2026-07-17T11:44:00Z', username:'system',   action:'Detect conflict',        target:'C-005', env:'PROD', result:'Critical raised', tone:'red', note:'Stale CARRIER_RANK_HINT consumed by AG-SHIP-AUTOTENDER after credit hold released — 18% hit rate on 2h release window' },
    { time:'2026-07-16T10:30:00Z', username:'r.nguyen', action:'Promote agent version',  target:'AG-AI-CAPACITYFORECAST v0.8-beta → DEV', env:'DEV', result:'Success', tone:'teal', note:'First deployment — capacity forecast model trained on PTY 180-day history' },
    { time:'2026-07-15T16:02:00Z', username:'l.tran',   action:'Run regression tests',   target:'AG-SHIP-DOCGEN', env:'TEST', result:'4/4 passed', tone:'teal', note:null },
    { time:'2026-07-14T09:22:00Z', username:'system',   action:'Detect conflict',        target:'C-001', env:'PROD', result:'Critical raised', tone:'red', note:'ORDER_MOVEMENT.status write collision between AG-ORD-RATESVC and AG-ORD-CREDITHOLD (3.1% hit rate)' },
    { time:'2026-07-11T14:00:00Z', username:'m.reyes',  action:'Promote agent version',  target:'AG-SHIP-TENDERRESP v1.9.0 → PROD', env:'PROD', result:'Success', tone:'teal', note:'EDI 990 COUNTERED status handling — resolves OTM-5441' },
    { time:'2026-07-10T11:22:00Z', username:'j.santos', action:'Promote agent version',  target:'AG-CAP-WEIGHTDIM v3.0.0 → PROD', env:'PROD', result:'Success', tone:'teal', note:'Added dimensional weight calculation per NMFC 2025 revision' },
    { time:'2026-07-09T09:00:00Z', username:'oracle.ai',action:'Model retrain complete', target:'AG-AI-DWELL v0.9-beta', env:'PROD', result:'Accuracy 88.4% (-1.3% — training data gap)', tone:'amber', note:'Missed 2026-07-21 refresh — JOB-DWELL-REFRESH failure cascades to stale model' },
    { time:'2026-07-07T08:30:00Z', username:'d.kim',    action:'Promote agent version',  target:'AG-INV-REMATCH v1.6.1 → PROD', env:'PROD', result:'Success', tone:'teal', note:'Fuzzy PRO-number match algorithm — resolves 340 unmatched invoices backlog' },
    { time:'2026-07-04T15:50:00Z', username:'system',   action:'Detect conflict',        target:'C-002', env:'PROD', result:'Critical raised', tone:'red', note:'AG-SHIP-AUTOTENDER / AG-AI-DWELL race on SHIPMENT_PLANNED — TENDER_HINT read before write in 23% of runs' },
  ];
  for (const row of auditRows) {
    await q(`INSERT INTO audit_log(time,username,action,target,env,result,tone,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.time, row.username, row.action, row.target, row.env, row.result, row.tone, row.note]);
  }

  // ─── JOBS ─────────────────────────────────────────────────────────────────
  console.log('Seeding jobs...');
  const jobs = [
    { id:'JOB-TENDER-SWEEP',      name:'Nightly Tender Sweep',             cron:'0 2 * * *',   last_run:'Today 02:00',     duration:'4m 12s',   trend:'up',   health:'green' },
    { id:'JOB-INV-TOL',           name:'Invoice Tolerance Batch',          cron:'0 */4 * * *', last_run:'Today 16:00',     duration:'1m 38s',   trend:'flat', health:'green' },
    { id:'JOB-FRTAUDIT',          name:'Freight Bill Audit Batch',         cron:'0 6 * * *',   last_run:'Today 06:00',     duration:'12m 07s',  trend:'up',   health:'green' },
    { id:'JOB-CREDIT-REC',        name:'Credit Hold Reconcile',            cron:'0 */6 * * *', last_run:'Today 12:00',     duration:'2m 05s',   trend:'down', health:'green' },
    { id:'JOB-CARRRANK-TRAIN',    name:'Carrier Rank Model Retrain',       cron:'0 3 * * 0',   last_run:'Sun 03:00',       duration:'28m 44s',  trend:'up',   health:'amber' },
    { id:'JOB-DWELL-REFRESH',     name:'Dwell Prediction Model Refresh',   cron:'0 1 * * *',   last_run:'-- missed --',    duration:'--',       trend:'flat', health:'red'   },
    { id:'JOB-CARR-ROLLUP',       name:'Carrier Performance Rollup',       cron:'0 5 * * 1',   last_run:'Mon 05:00',       duration:'3m 21s',   trend:'flat', health:'green' },
    { id:'JOB-DOC-ARCH',          name:'Document Archive',                 cron:'0 23 * * *',  last_run:'Yesterday 23:00', duration:'8m 44s',   trend:'up',   health:'amber' },
    { id:'JOB-SANCTIONS-REFRESH', name:'OFAC Sanctions List Refresh',      cron:'0 0 * * *',   last_run:'Today 00:00',     duration:'0m 48s',   trend:'flat', health:'green' },
    { id:'JOB-ETA-REFORECAST',    name:'ETA Re-Forecast Batch',            cron:'*/30 * * * *',last_run:'Today 16:30',     duration:'0m 52s',   trend:'flat', health:'green' },
    { id:'JOB-YARD-RECON',        name:'Yard Capacity Reconcile',          cron:'0 */2 * * *', last_run:'Today 16:00',     duration:'1m 14s',   trend:'down', health:'green' },
    { id:'JOB-CAPFORECAST-RUN',   name:'Capacity Demand Forecast Run',     cron:'0 4 * * *',   last_run:'Today 04:00',     duration:'6m 30s',   trend:'up',   health:'amber' },
    { id:'JOB-ANOMALY-RETRAIN',   name:'Anomaly Detection Model Retrain',  cron:'0 2 * * 3',   last_run:'Wed 02:00',       duration:'19m 22s',  trend:'down', health:'red'   },
    { id:'JOB-CUSTOMS-RESUBMIT',  name:'Customs Failed Entry Resubmit',    cron:'0 7 * * *',   last_run:'Today 07:00',     duration:'3m 09s',   trend:'up',   health:'green' },
  ];
  for (const j of jobs) {
    await q(`INSERT INTO jobs(id,name,cron,last_run,duration,trend,health) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [j.id, j.name, j.cron, j.last_run, j.duration, j.trend, j.health]);
  }

  // ─── TRACE RUNS & STEPS ───────────────────────────────────────────────────
  console.log('Seeding trace runs & steps...');
  const traceRuns = [
    { agent_id:'AG-ORD-RATESVC',      run_id:'RUN-55301', shipment_gid:'NWL.OR29044', env:'PROD', started:'2026-07-21T16:41:07Z', total_ms:448,  health:'green', status:'ok',    status_label:'Completed 448ms' },
    { agent_id:'AG-ORD-CREDITHOLD',   run_id:'RUN-55298', shipment_gid:'NWL.OR29041', env:'PROD', started:'2026-07-21T16:38:53Z', total_ms:203,  health:'green', status:'ok',    status_label:'Completed 203ms' },
    { agent_id:'AG-SHIP-AUTOTENDER',  run_id:'RUN-55302', shipment_gid:'NWL.SH48310', env:'PROD', started:'2026-07-21T16:41:55Z', total_ms:1240, health:'green', status:'ok',    status_label:'Completed 1.24s' },
    { agent_id:'AG-SHIP-RETENDER',    run_id:'RUN-55287', shipment_gid:'NWL.SH48291', env:'PROD', started:'2026-07-21T15:22:10Z', total_ms:874,  health:'amber', status:'warn',  status_label:'Retender attempt 2/3' },
    { agent_id:'AG-INV-AUTOAPPROVE',  run_id:'RUN-55280', shipment_gid:'NWL.INV19384',env:'PROD', started:'2026-07-21T14:55:00Z', total_ms:312,  health:'green', status:'ok',    status_label:'Completed 312ms' },
    { agent_id:'AG-INV-VARIANCE',     run_id:'RUN-55279', shipment_gid:'NWL.INV19381',env:'PROD', started:'2026-07-21T14:54:12Z', total_ms:512,  health:'amber', status:'warn',  status_label:'Escalated — 8.4% variance' },
    { agent_id:'AG-AI-CARRIERRANK',   run_id:'RUN-55290', shipment_gid:'NWL.SH48295', env:'PROD', started:'2026-07-21T15:40:00Z', total_ms:2100, health:'green', status:'ok',    status_label:'Completed 2.1s' },
    { agent_id:'AG-AI-DWELL',         run_id:'RUN-55291', shipment_gid:'NWL.SH48296', env:'PROD', started:'2026-07-21T15:40:02Z', total_ms:3410, health:'amber', status:'warn',  status_label:'Model stale — fallback used' },
    { agent_id:'AG-COMP-HAZMAT',      run_id:'RUN-55303', shipment_gid:'NWL.OR29046', env:'PROD', started:'2026-07-21T16:43:10Z', total_ms:189,  health:'green', status:'ok',    status_label:'Completed 189ms' },
    { agent_id:'AG-COMP-CUSTSDECL',   run_id:'RUN-55276', shipment_gid:'NWL.SH48278', env:'PROD', started:'2026-07-21T14:20:00Z', total_ms:2800, health:'red',   status:'error', status_label:'BOL_GID null — CBP rejected' },
    { agent_id:'AG-CAP-WEIGHTDIM',    run_id:'RUN-55304', shipment_gid:'NWL.OR29048', env:'PROD', started:'2026-07-21T16:44:00Z', total_ms:78,   health:'green', status:'ok',    status_label:'Completed 78ms' },
    { agent_id:'AG-CAP-POOLLOAD',     run_id:'RUN-55292', shipment_gid:'NWL.BLK00812',env:'PROD', started:'2026-07-21T15:45:00Z', total_ms:5200, health:'red',   status:'error', status_label:'Pool optimizer timeout — 5.2s' },
    { agent_id:'AG-SHIP-MILESTONEUPD',run_id:'RUN-55270', shipment_gid:'NWL.SH48244', env:'PROD', started:'2026-07-21T13:10:00Z', total_ms:142,  health:'green', status:'ok',    status_label:'Completed 142ms' },
    { agent_id:'AG-AI-ANOMALY',       run_id:'RUN-55271', shipment_gid:'NWL.SH48244', env:'PROD', started:'2026-07-21T13:10:01Z', total_ms:4800, health:'red',   status:'error', status_label:'False positive — stale ETA read' },
    { agent_id:'AG-SHIP-DOCGEN',      run_id:'RUN-55305', shipment_gid:'NWL.SH48311', env:'PROD', started:'2026-07-21T16:44:22Z', total_ms:891,  health:'green', status:'ok',    status_label:'Completed 891ms' },
    { agent_id:'AG-SHIP-APPOINTSCHED',run_id:'RUN-55293', shipment_gid:'NWL.SH48298', env:'PROD', started:'2026-07-21T15:55:00Z', total_ms:1650, health:'amber', status:'warn',  status_label:'Appt window negotiated — 2d delay' },
    { agent_id:'AG-COMP-SANCTIONSCR', run_id:'RUN-55306', shipment_gid:'NWL.OR29044', env:'PROD', started:'2026-07-21T16:40:50Z', total_ms:94,   health:'green', status:'ok',    status_label:'Completed 94ms — CLEAR' },
    { agent_id:'AG-INV-REMATCH',      run_id:'RUN-55284', shipment_gid:'NWL.INV19370',env:'PROD', started:'2026-07-21T15:10:00Z', total_ms:712,  health:'green', status:'ok',    status_label:'Matched NWL.SH48261 — 97% confidence' },
  ];

  const traceStepMap = {
    'RUN-55301': [ // AG-ORD-RATESVC
      { label:'Trigger received',         io:'evt=ORDER_RELEASED ORDER_GID=NWL.OR29044',                              start_ms:0,   dur_ms:8,   status:'ok' },
      { label:'Load order context',       io:'in: ORDER_GID=NWL.OR29044  out: SERVICE_LEVEL=LTL SHIP_FROM=NWL.DC.MEMPHIS', start_ms:8, dur_ms:94, status:'ok' },
      { label:'Query rate offering',      io:'in: LANE_GID=NWL.MEMPHIS-PUNL66 SERVICE_LEVEL=LTL  out: RATE_GID=NWL.RGC.9041 COST=2,847.50 USD', start_ms:102, dur_ms:218, status:'ok' },
      { label:'Select service provider',  io:'in: RATE_GID=NWL.RGC.9041  out: CARRIER_GID=NWL.CHRW SCAC=CHRW',     start_ms:320, dur_ms:88,  status:'ok' },
      { label:'Write RATE_GID',           io:'wrote: RATE_GID=NWL.RGC.9041 SERVICE_GID=NWL.SRV.LTL2 COST_USD=2847.50', start_ms:408, dur_ms:32, status:'ok' },
      { label:'Emit RATE_APPLIED',        io:'evt=RATE_APPLIED ORDER_GID=NWL.OR29044',                              start_ms:440, dur_ms:8,   status:'ok' },
    ],
    'RUN-55298': [ // AG-ORD-CREDITHOLD
      { label:'Trigger received',         io:'evt=ORDER_RELEASED ORDER_GID=NWL.OR29041',                              start_ms:0,   dur_ms:6,   status:'ok' },
      { label:'Query credit status',      io:'in: INVOICE_CORP_GID=NWL.CORP.LATAM  out: CREDIT_STATUS=OK LIMIT=500000 BALANCE=312440', start_ms:6, dur_ms:144, status:'ok' },
      { label:'Evaluate hold condition',  io:'BALANCE(312440) <= LIMIT(500000) — no hold required',                 start_ms:150, dur_ms:12,  status:'ok' },
      { label:'Write hold status',        io:'wrote: HOLD_STATUS=CLEAR',                                             start_ms:162, dur_ms:34,  status:'ok' },
      { label:'Emit CREDIT_CLEARED',      io:'evt=CREDIT_CLEARED ORDER_GID=NWL.OR29041',                            start_ms:196, dur_ms:7,   status:'ok' },
    ],
    'RUN-55302': [ // AG-SHIP-AUTOTENDER
      { label:'Trigger received',         io:'evt=SHIPMENT_PLANNED SHIPMENT_GID=NWL.SH48310',                        start_ms:0,   dur_ms:9,   status:'ok' },
      { label:'Read TENDER_HINT',         io:'in: SHIPMENT_GID=NWL.SH48310  TENDER_HINT present: CARRIER=CHRW confidence=0.84', start_ms:9, dur_ms:62, status:'ok' },
      { label:'Read rate & contract',     io:'in: RATE_GID=NWL.RGC.9041  out: CARRIER=CHRW SCAC=CHRW CONTRACT=ACTIVE COST=2847.50', start_ms:71, dur_ms:310, status:'ok' },
      { label:'Build tender request',     io:'TENDER_GID=NWL.TND.88201 SHIPMENT=NWL.SH48310 CARRIER=CHRW METHOD=EDI-990', start_ms:381, dur_ms:44, status:'ok' },
      { label:'Transmit tender (EDI 204)',io:'transmitted to CHRW EDI endpoint — ACK received 312ms',               start_ms:425, dur_ms:720, status:'ok' },
      { label:'Set tender expiry',        io:'EXPIRY_TS=2026-07-21T20:41:55Z (4h window)',                          start_ms:1145, dur_ms:58, status:'ok' },
      { label:'Write TENDER_GID',         io:'wrote: TENDER_GID=NWL.TND.88201 TENDER_STATUS=SENT SHIPMENT_STATUS=TENDERED', start_ms:1203, dur_ms:28, status:'ok' },
      { label:'Emit TENDER_SENT',         io:'evt=TENDER_SENT SHIPMENT_GID=NWL.SH48310',                            start_ms:1231, dur_ms:9,   status:'ok' },
    ],
    'RUN-55287': [ // AG-SHIP-RETENDER (warn)
      { label:'Trigger received',         io:'evt=TENDER_DECLINED SHIPMENT_GID=NWL.SH48291 CARRIER=ODFL ATTEMPT=1', start_ms:0,   dur_ms:7,   status:'ok' },
      { label:'Check retender count',     io:'RETENDER_ATTEMPT_COUNT=1 MAX=3 — proceed',                            start_ms:7,   dur_ms:18,  status:'ok' },
      { label:'Read carrier rank hint',   io:'CARRIER_RANK_HINT: [CHRW(0.84), ODFL(0.71), JBHT(0.66)] — selecting rank 2: JBHT', start_ms:25, dur_ms:88, status:'ok' },
      { label:'Build retender',           io:'TENDER_GID=NWL.TND.88198 CARRIER=JBHT SCAC=JBHT METHOD=EDI-990',    start_ms:113, dur_ms:41,  status:'ok' },
      { label:'Transmit retender',        io:'transmitted to JBHT — no ACK after 500ms (timeout)',                  start_ms:154, dur_ms:628, status:'warn' },
      { label:'Increment retender count', io:'wrote: RETENDER_ATTEMPT_COUNT=2 SHIPMENT_STATUS=RETENDERED',          start_ms:782, dur_ms:54,  status:'ok' },
      { label:'Emit RETENDER_SENT',       io:'evt=RETENDER_SENT SHIPMENT_GID=NWL.SH48291 attempt=2',               start_ms:836, dur_ms:38,  status:'warn' },
    ],
    'RUN-55279': [ // AG-INV-VARIANCE (warn)
      { label:'Trigger received',         io:'evt=INVOICE_RECEIVED INVOICE_GID=NWL.INV19381',                       start_ms:0,   dur_ms:6,   status:'ok' },
      { label:'Match to shipment',        io:'in: CARRIER_PRO=CHRW-7741209  out: SHIPMENT_GID=NWL.SH48244',        start_ms:6,   dur_ms:128, status:'ok' },
      { label:'Compute variance',         io:'INVOICE=3,087.40 CONTRACTED=2,847.50 VARIANCE=239.90 (8.4%) > TOL(3%)', start_ms:134, dur_ms:72, status:'warn' },
      { label:'Escalate to approver',     io:'APPROVER_GID=NWL.USER.d.kim VARIANCE_PCT=8.4 INVOICE=NWL.INV19381', start_ms:206, dur_ms:290, status:'warn' },
      { label:'Emit INVOICE_ESCALATED',   io:'evt=INVOICE_ESCALATED INVOICE_GID=NWL.INV19381',                      start_ms:496, dur_ms:16,  status:'ok' },
    ],
    'RUN-55276': [ // AG-COMP-CUSTSDECL (error)
      { label:'Trigger received',         io:'evt=SHIPMENT_CONFIRMED SHIPMENT_GID=NWL.SH48278 CROSS_BORDER=Y DEST=MEXICO', start_ms:0, dur_ms:8, status:'ok' },
      { label:'Validate cross-border flag',io:'CROSS_BORDER_FLG=Y CUSTOMS_BROKER=NWL.BROKER.RYDER',                start_ms:8,   dur_ms:34,  status:'ok' },
      { label:'Read BOL_GID',             io:'in: SHIPMENT_GID=NWL.SH48278  BOL_GID=null — AG-SHIP-DOCGEN not yet committed', start_ms:42, dur_ms:112, status:'error' },
      { label:'Build commercial invoice', io:'ABORTED — BOL_GID required for CBP AES filing, not available',       start_ms:154, dur_ms:8,   status:'error' },
      { label:'Emit failure event',       io:'CUSTOMS_SUBMISSION_FAILED REASON=BOL_GID_NULL SHIPMENT=NWL.SH48278', start_ms:162, dur_ms:14,  status:'error' },
    ],
    'RUN-55292': [ // AG-CAP-POOLLOAD (error)
      { label:'Trigger received',         io:'evt=SHIPMENT_PLANNED BULK_PLAN_GID=NWL.BLK00812 ORDERS=14',           start_ms:0,   dur_ms:11,  status:'ok' },
      { label:'Group pool-eligible orders',io:'14 orders → 11 pool-eligible DEST_ZONE=PUNL66',                      start_ms:11,  dur_ms:220, status:'ok' },
      { label:'Run stop-sequence optimizer',io:'ILP optimizer started — 11 stops 3 equipment types',               start_ms:231, dur_ms:4800,status:'error' },
      { label:'Timeout — fallback',       io:'OPTIMIZER_TIMEOUT=5000ms — fallback to greedy nearest-neighbor',      start_ms:5031,dur_ms:169, status:'error' },
    ],
    'RUN-55291': [ // AG-AI-DWELL (warn)
      { label:'Trigger received',         io:'evt=SHIPMENT_PLANNED SHIPMENT_GID=NWL.SH48296',                        start_ms:0,   dur_ms:6,   status:'ok' },
      { label:'Load model',               io:'Dwell model last_trained=2026-07-09T01:12Z (12 days stale) — using cached weights', start_ms:6, dur_ms:810, status:'warn' },
      { label:'Infer dwell',              io:'DEST=NWL.DC.PUNL66 CARRIER=ODFL EQUIP=VAN → predicted_dwell=18.4h confidence=0.61 (low)', start_ms:816, dur_ms:2410, status:'warn' },
      { label:'Write DWELL_FORECAST',     io:'wrote: PREDICTED_DWELL_HOURS=18.4 CONFIDENCE=0.61 TENDER_HINT=ODFL(fallback)',start_ms:3226,dur_ms:184,status:'ok' },
    ],
    'RUN-55271': [ // AG-AI-ANOMALY (error — false positive)
      { label:'Trigger received',         io:'evt=TRACKING_EVENT SHIPMENT_GID=NWL.SH48244 CODE=DEPARTURE',          start_ms:0,   dur_ms:7,   status:'ok' },
      { label:'Read REVISED_ETA_TS',      io:'REVISED_ETA_TS=null — AG-SHIP-MILESTONEUPD not yet committed (800ms lag)', start_ms:7, dur_ms:112, status:'error' },
      { label:'Score anomaly',            io:'BASELINE_ETA=2026-07-22T14:00Z ACTUAL_ETA=null → anomaly_score=0.91 (false positive)', start_ms:119, dur_ms:4560, status:'error' },
      { label:'Alert operations',         io:'ALERT_GID=NWL.ANO.00441 ANOMALY_TYPE=UNEXPECTED_DELAY SCORE=0.91 — FALSE POSITIVE', start_ms:4679, dur_ms:121, status:'error' },
    ],
  };

  const traceRunRows = [];
  for (const r of traceRuns) {
    const inserted = await q(`INSERT INTO trace_runs(agent_id,run_id,shipment_gid,env,started,total_ms,health,status,status_label)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [r.agent_id, r.run_id, r.shipment_gid, r.env, r.started, r.total_ms, r.health, r.status, r.status_label]);
    traceRunRows.push({ db_id: inserted[0].id, run_id: r.run_id });
  }

  for (const { db_id, run_id } of traceRunRows) {
    const steps = traceStepMap[run_id];
    if (!steps) continue;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await q(`INSERT INTO trace_steps(trace_run_id,label,io,start_ms,dur_ms,status,sort_order)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [db_id, s.label, s.io, s.start_ms, s.dur_ms, s.status, i]);
    }
  }

  // ─── LIVE EVENTS ──────────────────────────────────────────────────────────
  console.log('Seeding live events...');
  const liveEventsData = [
    // 16:4x
    { ts:'16:47', evt:'ORDER_RELEASED',     gid:'NWL.OR29048', agent_id:'AG-ORD-RATESVC',      ms:312, ok:true  },
    { ts:'16:47', evt:'ORDER_RELEASED',     gid:'NWL.OR29048', agent_id:'AG-ORD-CREDITHOLD',   ms:44,  ok:true  },
    { ts:'16:47', evt:'ORDER_RELEASED',     gid:'NWL.OR29048', agent_id:'AG-ORD-HAZMATVAL',    ms:38,  ok:true  },
    { ts:'16:47', evt:'ORDER_RELEASED',     gid:'NWL.OR29048', agent_id:'AG-COMP-SANCTIONSCR', ms:92,  ok:true  },
    { ts:'16:46', evt:'SHIPMENT_PLANNED',   gid:'NWL.SH48312', agent_id:'AG-SHIP-AUTOTENDER',  ms:1180,ok:true  },
    { ts:'16:46', evt:'SHIPMENT_PLANNED',   gid:'NWL.SH48312', agent_id:'AG-AI-DWELL',         ms:3210,ok:false },
    { ts:'16:46', evt:'SHIPMENT_PLANNED',   gid:'NWL.SH48312', agent_id:'AG-CAP-YARDCHECK',    ms:210, ok:true  },
    { ts:'16:44', evt:'RATE_APPLIED',       gid:'NWL.OR29044', agent_id:'AG-AI-CARRIERRANK',   ms:2100,ok:true  },
    { ts:'16:44', evt:'RATE_APPLIED',       gid:'NWL.OR29044', agent_id:'AG-ORD-LANEPREF',     ms:144, ok:true  },
    { ts:'16:43', evt:'ORDER_RELEASED',     gid:'NWL.OR29046', agent_id:'AG-COMP-HAZMAT',      ms:189, ok:true  },
    { ts:'16:42', evt:'TENDER_RESPONSE',    gid:'NWL.TND.88199',agent_id:'AG-SHIP-TENDERRESP', ms:88,  ok:true  },
    { ts:'16:41', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48310', agent_id:'AG-SHIP-DOCGEN',      ms:891, ok:true  },
    { ts:'16:41', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48310', agent_id:'AG-SHIP-TRACKUPDATE', ms:110, ok:true  },
    { ts:'16:41', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48310', agent_id:'AG-COMP-CUSTSDECL',   ms:2800,ok:false },
    { ts:'16:40', evt:'ORDER_RELEASED',     gid:'NWL.OR29044', agent_id:'AG-ORD-RATESVC',      ms:448, ok:true  },
    { ts:'16:40', evt:'ORDER_RELEASED',     gid:'NWL.OR29044', agent_id:'AG-COMP-SANCTIONSCR', ms:94,  ok:true  },
    // 16:3x
    { ts:'16:39', evt:'TENDER_DECLINED',    gid:'NWL.TND.88197',agent_id:'AG-SHIP-RETENDER',   ms:874, ok:false },
    { ts:'16:38', evt:'APPT_CONFIRMED',     gid:'NWL.APPT.4401',agent_id:'AG-CAP-DOCKALLOC',   ms:312, ok:true  },
    { ts:'16:37', evt:'SHIPMENT_PLANNED',   gid:'NWL.BLK00813', agent_id:'AG-CAP-POOLLOAD',    ms:5200,ok:false },
    { ts:'16:36', evt:'TRACKING_EVENT',     gid:'NWL.SH48244',  agent_id:'AG-SHIP-MILESTONEUPD',ms:142,ok:true  },
    { ts:'16:36', evt:'TRACKING_EVENT',     gid:'NWL.SH48244',  agent_id:'AG-AI-ANOMALY',      ms:4800,ok:false },
    { ts:'16:35', evt:'INVOICE_RECEIVED',   gid:'NWL.INV19388', agent_id:'AG-INV-AUTOAPPROVE', ms:312, ok:true  },
    { ts:'16:35', evt:'INVOICE_RECEIVED',   gid:'NWL.INV19386', agent_id:'AG-INV-VARIANCE',    ms:512, ok:false },
    { ts:'16:35', evt:'INVOICE_RECEIVED',   gid:'NWL.INV19387', agent_id:'AG-INV-REMATCH',     ms:712, ok:true  },
    { ts:'16:34', evt:'INVOICE_APPROVED',   gid:'NWL.INV19380', agent_id:'AG-INV-FRTAUDIT',    ms:2100,ok:true  },
    { ts:'16:34', evt:'INVOICE_APPROVED',   gid:'NWL.INV19380', agent_id:'AG-INV-PAYTERM',     ms:88,  ok:true  },
    { ts:'16:33', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48308',  agent_id:'AG-SHIP-APPOINTSCHED',ms:1650,ok:false},
    { ts:'16:32', evt:'ORDER_RELEASED',     gid:'NWL.OR29043',  agent_id:'AG-ORD-BULKPLAN',    ms:680, ok:true  },
    { ts:'16:31', evt:'ORDER_RELEASED',     gid:'NWL.OR29041',  agent_id:'AG-CAP-WEIGHTDIM',   ms:78,  ok:true  },
    { ts:'16:30', evt:'RATE_APPLIED',       gid:'NWL.OR29040',  agent_id:'AG-ORD-SVCLEVSEL',   ms:98,  ok:true  },
    // 16:2x
    { ts:'16:29', evt:'SHIPMENT_PLANNED',   gid:'NWL.SH48305',  agent_id:'AG-COMP-INCOTERM',   ms:204, ok:true  },
    { ts:'16:28', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48303',  agent_id:'AG-AI-ETAPRED',      ms:1420,ok:true  },
    { ts:'16:27', evt:'ORDER_RELEASED',     gid:'NWL.OR29038',  agent_id:'AG-ORD-HAZMATVAL',   ms:188, ok:true  },
    { ts:'16:25', evt:'TRACKING_EVENT',     gid:'NWL.SH48290',  agent_id:'AG-AI-ANOMALY',      ms:3900,ok:true  },
    { ts:'16:24', evt:'TENDER_RESPONSE',    gid:'NWL.TND.88192',agent_id:'AG-SHIP-TENDERRESP', ms:72,  ok:true  },
    { ts:'16:22', evt:'INVOICE_RECEIVED',   gid:'NWL.INV19378', agent_id:'AG-INV-AUTOAPPROVE', ms:298, ok:true  },
    { ts:'16:20', evt:'ORDER_RELEASED',     gid:'NWL.OR29036',  agent_id:'AG-AI-CAPACITYFORECAST',ms:6100,ok:true},
    // 16:1x
    { ts:'16:18', evt:'SHIPMENT_PLANNED',   gid:'NWL.SH48298',  agent_id:'AG-SHIP-AUTOTENDER', ms:1310,ok:true  },
    { ts:'16:17', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48295',  agent_id:'AG-COMP-CUSTSDECL',  ms:2440,ok:true  },
    { ts:'16:15', evt:'INVOICE_APPROVED',   gid:'NWL.INV19372', agent_id:'AG-INV-FRTAUDIT',    ms:1980,ok:true  },
    { ts:'16:14', evt:'TRACKING_EVENT',     gid:'NWL.SH48281',  agent_id:'AG-SHIP-MILESTONEUPD',ms:138,ok:true  },
    { ts:'16:12', evt:'EXCEPTION_RAISED',   gid:'NWL.EXC00214', agent_id:'AG-SHIP-EXCEPTIONMGR',ms:441,ok:true },
    { ts:'16:10', evt:'ORDER_RELEASED',     gid:'NWL.OR29033',  agent_id:'AG-ORD-RATESVC',     ms:388, ok:true  },
    { ts:'16:10', evt:'ORDER_RELEASED',     gid:'NWL.OR29033',  agent_id:'AG-ORD-CREDITHOLD',  ms:51,  ok:true  },
    // 16:0x
    { ts:'16:08', evt:'SHIPMENT_PLANNED',   gid:'NWL.SH48292',  agent_id:'AG-CAP-YARDCHECK',   ms:190, ok:true  },
    { ts:'16:06', evt:'RATE_APPLIED',       gid:'NWL.OR29030',  agent_id:'AG-AI-CARRIERRANK',  ms:2280,ok:true  },
    { ts:'16:04', evt:'APPT_CONFIRMED',     gid:'NWL.APPT.4398',agent_id:'AG-CAP-DOCKALLOC',   ms:288, ok:true  },
    { ts:'16:02', evt:'INVOICE_RECEIVED',   gid:'NWL.INV19366', agent_id:'AG-INV-VARIANCE',    ms:490, ok:false },
    { ts:'16:00', evt:'ORDER_RELEASED',     gid:'NWL.OR29028',  agent_id:'AG-COMP-SANCTIONSCR',ms:88,  ok:true  },
    // 15:5x
    { ts:'15:58', evt:'SHIPMENT_CONFIRMED', gid:'NWL.SH48288',  agent_id:'AG-SHIP-DOCGEN',     ms:912, ok:true  },
    { ts:'15:55', evt:'TENDER_DECLINED',    gid:'NWL.TND.88188',agent_id:'AG-SHIP-RETENDER',   ms:810, ok:true  },
    { ts:'15:52', evt:'TRACKING_EVENT',     gid:'NWL.SH48277',  agent_id:'AG-AI-ETAPRED',      ms:1380,ok:true  },
    { ts:'15:50', evt:'ORDER_RELEASED',     gid:'NWL.OR29025',  agent_id:'AG-ORD-BULKPLAN',    ms:720, ok:true  },
  ];
  for (const e of liveEventsData) {
    await q('INSERT INTO live_events(ts,evt,gid,agent_id,ms,ok) VALUES($1,$2,$3,$4,$5,$6)',
      [e.ts, e.evt, e.gid, e.agent_id, e.ms, e.ok]);
  }

  // ─── OVERVIEW METRICS ─────────────────────────────────────────────────────
  console.log('Seeding overview metrics...');
  const metrics = [
    { key:'agents_total',     value:'31',      sub:null },
    { key:'agents_healthy',   value:'19',      sub:'61%' },
    { key:'agents_amber',     value:'8',       sub:'26%' },
    { key:'agents_red',       value:'4',       sub:'13%' },
    { key:'conflicts_open',   value:'7',       sub:'5 critical' },
    { key:'events_today',     value:'84,417',  sub:'+18% vs yesterday' },
    { key:'jobs_healthy',     value:'9/14',    sub:'2 missed' },
    { key:'success_rate_avg', value:'95.2%',   sub:'last 7d rolling' },
  ];
  for (const m of metrics) {
    await q('INSERT INTO overview_metrics(key,value,sub) VALUES($1,$2,$3)', [m.key, m.value, m.sub]);
  }

  // ─── AGENT DIFFS ──────────────────────────────────────────────────────────
  console.log('Seeding agent diffs...');
  const diffs = [
    {
      id:'DIFF-RATESVC-PT',
      prod_ver:'v4.2.1', test_ver:'v4.3.0-rc1',
      insight:'TEST adds CROSS_BORDER_FLG guard preventing international orders from matching domestic RATE_GEO_COST records. This resolves 14 mis-rated cross-border shipments logged in the last 30 days. Requires schema migration to add CROSS_BORDER_FLG column to ORDER_MOVEMENT view.',
      warning:'Migration must run before v4.3.0-rc1 promotion. PROD rollback requires restoring 3 condition rows. Confirm TEST regression suite (12 tests) passes before promoting.',
      conflict_id:'C-001',
      rows: JSON.stringify([
        { step:'Condition 1', l:{t:'same',txt:"ORDER_MOVEMENT.status = 'NEW'"}, r:{t:'same',txt:"ORDER_MOVEMENT.status = 'NEW'"} },
        { step:'Condition 2', l:{t:'same',txt:'SERVICE_LEVEL is not null'}, r:{t:'same',txt:'SERVICE_LEVEL is not null'} },
        { step:'Condition 3', l:{t:'none',txt:''}, r:{t:'add',txt:"CROSS_BORDER_FLG = 'N' OR DEST_COUNTRY_CODE3 = SOURCE_COUNTRY_CODE3"} },
        { step:'Action 1',    l:{t:'same',txt:'computeRate(ORDER_MOVEMENT_GID, LANE_GID, SERVICE_LEVEL_GID)'}, r:{t:'same',txt:'computeRate(ORDER_MOVEMENT_GID, LANE_GID, SERVICE_LEVEL_GID)'} },
        { step:'Action 2',    l:{t:'mod',txt:'selectServiceProvider(RATE_GEO_COST_GID)'}, r:{t:'mod',txt:'selectServiceProvider(RATE_GEO_COST_GID, CROSS_BORDER_FLG)'} },
        { step:'Action 3',    l:{t:'same',txt:"writeRateOffering(ORDER_MOVEMENT_GID, RATE_GID, COST_USD)"}, r:{t:'same',txt:"writeRateOffering(ORDER_MOVEMENT_GID, RATE_GID, COST_USD)"} },
        { step:'Action 4',    l:{t:'none',txt:''}, r:{t:'add',txt:"emitEvent('CROSS_BORDER_RATE_VALIDATED', ORDER_MOVEMENT_GID)"} },
      ])
    },
    {
      id:'DIFF-AUTOTENDER-PT',
      prod_ver:'v2.4.1', test_ver:'v2.5.0-rc2',
      insight:'TEST introduces a bounded 500ms wait on TENDER_HINT before falling back to default lane weights. This directly mitigates conflict C-002 (AG-AI-DWELL race). In TEST load replay, sub-optimal carrier selection dropped from 23% to 4% of SHIPMENT_PLANNED events during the PUNL66 morning surge.',
      warning:'v2.5.0-rc2 adds a 500ms p99 latency increase on the tender path. Confirm tender SLA (currently 2s p99) is acceptable after increase. Carrier EDI endpoints must support the revised TENDER_GID format in action 4.',
      conflict_id:'C-002',
      rows: JSON.stringify([
        { step:'Condition 5', l:{t:'none',txt:''}, r:{t:'add',txt:'TENDER_HINT_WAIT_MS = 500 OR TENDER_HINT is not null'} },
        { step:'Action 1',    l:{t:'same',txt:'buildTenderRequest(SHIPMENT_GID, SERVICE_PROVIDER_GID, RATE_GID)'}, r:{t:'same',txt:'buildTenderRequest(SHIPMENT_GID, SERVICE_PROVIDER_GID, RATE_GID)'} },
        { step:'Action 2',    l:{t:'mod',txt:'transmitTender(TENDER_GID, CARRIER_COMM_METHOD_GID)'}, r:{t:'mod',txt:'transmitTender(TENDER_GID, CARRIER_COMM_METHOD_GID, IDEMPOTENCY_KEY)'} },
        { step:'Action 3',    l:{t:'same',txt:"setTenderExpiry(TENDER_GID, EXPIRY_TS=NOW()+TENDER_EXPIRY_HOURS)"}, r:{t:'same',txt:"setTenderExpiry(TENDER_GID, EXPIRY_TS=NOW()+TENDER_EXPIRY_HOURS)"} },
        { step:'Action 5',    l:{t:'del',txt:"writeShipmentStatus(SHIPMENT_GID, 'TENDERED')"}, r:{t:'none',txt:''} },
        { step:'Action 5*',   l:{t:'none',txt:''}, r:{t:'add',txt:"writeShipmentStatus(SHIPMENT_GID, 'TENDERED', SOURCE_AGENT='AG-SHIP-AUTOTENDER')"} },
      ])
    },
    {
      id:'DIFF-CUSTSDECL-PT',
      prod_ver:'v2.3.0', test_ver:'v2.4.0-rc1',
      insight:'TEST rekeys trigger from SHIPMENT_CONFIRMED to BOL_READY event emitted by AG-SHIP-DOCGEN. This eliminates the BOL_GID null issue (C-006) that caused 11% of PUNL66→MEXICO CBP filings to be rejected. In TEST simulation zero null-BOL customs entries were observed over 72h.',
      warning:'Requires AG-SHIP-DOCGEN to emit BOL_READY event (added in v3.2.0-rc1 — separate promotion). If AG-SHIP-DOCGEN promotion is delayed, AG-COMP-CUSTSDECL v2.4.0-rc1 will queue indefinitely. Coordinate promotions or add a timeout fallback.',
      conflict_id:'C-006',
      rows: JSON.stringify([
        { step:'Trigger',      l:{t:'mod',txt:'evt=SHIPMENT_CONFIRMED'}, r:{t:'mod',txt:'evt=BOL_READY'} },
        { step:'Condition 1',  l:{t:'same',txt:"CROSS_BORDER_FLG = 'Y'"}, r:{t:'same',txt:"CROSS_BORDER_FLG = 'Y'"} },
        { step:'Condition 2',  l:{t:'same',txt:'CUSTOMS_BROKER_GID is not null'}, r:{t:'same',txt:'CUSTOMS_BROKER_GID is not null'} },
        { step:'Condition 3',  l:{t:'del',txt:'HS_TARIFF_CODE is not null'}, r:{t:'none',txt:''} },
        { step:'Condition 3*', l:{t:'none',txt:''}, r:{t:'add',txt:'HS_TARIFF_CODE is not null AND BOL_GID is not null'} },
        { step:'Action 1',     l:{t:'same',txt:'buildCommercialInvoice(SHIPMENT_GID, HS_TARIFF_CODE, DECLARED_VALUE_USD)'}, r:{t:'same',txt:'buildCommercialInvoice(SHIPMENT_GID, HS_TARIFF_CODE, DECLARED_VALUE_USD)'} },
        { step:'Action 2',     l:{t:'mod',txt:'submitCustomsEntry(CUSTOMS_BROKER_GID, SHIPMENT_GID)'}, r:{t:'mod',txt:'submitCustomsEntry(CUSTOMS_BROKER_GID, SHIPMENT_GID, BOL_GID)'} },
      ])
    },
  ];
  for (const d of diffs) {
    await q(`INSERT INTO agent_diffs(id,prod_ver,test_ver,insight,warning,conflict_id,rows)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [d.id, d.prod_ver, d.test_ver, d.insight, d.warning, d.conflict_id, d.rows]);
  }

  // ─── REGRESSION TESTS ─────────────────────────────────────────────────────
  console.log('Seeding regression tests...');
  const tests = [
    // AG-SHIP-RETENDER
    { id:'TC-RT-01', agent_id:'AG-SHIP-RETENDER', name:'Decline → retender to rank-2 carrier',                   expect_text:"TENDER_STATUS = 'SENT' CARRIER = rank-2",                      result:'pass', got_text:null, sort_order:1 },
    { id:'TC-RT-02', agent_id:'AG-SHIP-RETENDER', name:'Decline × 3 → escalate to planner',                      expect_text:"SHIPMENT_STATUS = 'ESCALATED' RETENDER_COUNT = 3",              result:'pass', got_text:null, sort_order:2 },
    { id:'TC-RT-03', agent_id:'AG-SHIP-RETENDER', name:'Idempotent retender — no duplicate TENDER_GID on replay', expect_text:'TENDER_GID count = 1 for SHIPMENT_GID+ATTEMPT combination',     result:'pass', got_text:null, sort_order:3 },
    { id:'TC-RT-04', agent_id:'AG-SHIP-RETENDER', name:'Counter-offer within 5% → accept',                       expect_text:"TENDER_STATUS = 'ACCEPTED' COUNTER_DELTA_PCT <= 5",              result:'fail', got_text:"TENDER_STATUS = 'SENT' — counter-offer handler not yet implemented", sort_order:4 },
    // AG-ORD-RATESVC
    { id:'TC-RS-01', agent_id:'AG-ORD-RATESVC',   name:'LTL order routes to lowest RATE_GEO_COST',               expect_text:'RATE_GID = lowest cost NWL.RGC.* for LANE_GID',                result:'pass', got_text:null, sort_order:1 },
    { id:'TC-RS-02', agent_id:'AG-ORD-RATESVC',   name:'No active rate → order holds for manual rating',          expect_text:"ORDER_MOVEMENT.status = 'HOLD_RATE'",                          result:'pass', got_text:null, sort_order:2 },
    { id:'TC-RS-03', agent_id:'AG-ORD-RATESVC',   name:'Cross-border order rejected by domestic rate record',     expect_text:'computeRate aborts — CROSS_BORDER_FLG mismatch',               result:'fail', got_text:'computeRate completes — CROSS_BORDER_FLG guard not yet in PROD', sort_order:3 },
    { id:'TC-RS-04', agent_id:'AG-ORD-RATESVC',   name:'Expired rate offering not selected',                      expect_text:'RATE_GID with EXPIRY_DATE < NOW() excluded',                   result:'pass', got_text:null, sort_order:4 },
    // AG-INV-AUTOAPPROVE
    { id:'TC-IA-01', agent_id:'AG-INV-AUTOAPPROVE',name:'Variance 2.9% → auto-approved',                         expect_text:"INVOICE_STATUS = 'APPROVED' VARIANCE_PCT = 2.9",               result:'pass', got_text:null, sort_order:1 },
    { id:'TC-IA-02', agent_id:'AG-INV-AUTOAPPROVE',name:'Variance 3.1% → escalated, not auto-approved',          expect_text:"INVOICE_STATUS = 'ESCALATED'",                                 result:'pass', got_text:null, sort_order:2 },
    { id:'TC-IA-03', agent_id:'AG-INV-AUTOAPPROVE',name:'Foreign currency invoice rejected',                      expect_text:"INVOICE_STATUS = 'REJECTED' REASON = CURRENCY_MISMATCH",      result:'pass', got_text:null, sort_order:3 },
    { id:'TC-IA-04', agent_id:'AG-INV-AUTOAPPROVE',name:'Rate amended mid-cycle — recompute against new rate',    expect_text:'VARIANCE computed against CONTRACTED_AMOUNT v2 not v1',        result:'fail', got_text:'VARIANCE computed against stale CONTRACTED_AMOUNT — V_INVOICE_VARIANCE not yet deployed', sort_order:4 },
    // AG-SHIP-AUTOTENDER
    { id:'TC-AT-01', agent_id:'AG-SHIP-AUTOTENDER',name:'TENDER_HINT present → carrier matches hint',             expect_text:'CARRIER_GID = TENDER_HINT.top_carrier',                        result:'pass', got_text:null, sort_order:1 },
    { id:'TC-AT-02', agent_id:'AG-SHIP-AUTOTENDER',name:'TENDER_HINT absent → default lane preference used',     expect_text:'CARRIER_GID = LANE_PREFERENCE.default_carrier',                result:'pass', got_text:null, sort_order:2 },
    { id:'TC-AT-03', agent_id:'AG-SHIP-AUTOTENDER',name:'Inactive contract → tender blocked',                     expect_text:"TENDER blocked — CARRIER_CONTRACT_STATUS != 'ACTIVE'",         result:'pass', got_text:null, sort_order:3 },
    { id:'TC-AT-04', agent_id:'AG-SHIP-AUTOTENDER',name:'500ms TENDER_HINT wait — fallback on timeout',          expect_text:'TENDER uses default after 500ms with no HINT',                  result:'fail', got_text:'Wait gate not in PROD v2.4.1 — promoted in v2.5.0-rc2', sort_order:4 },
    // AG-COMP-CUSTSDECL
    { id:'TC-CD-01', agent_id:'AG-COMP-CUSTSDECL', name:'Domestic shipment — no customs entry created',          expect_text:'CUSTOMS_SUBMITTED_FLG = N — CROSS_BORDER_FLG = N',             result:'pass', got_text:null, sort_order:1 },
    { id:'TC-CD-02', agent_id:'AG-COMP-CUSTSDECL', name:'Cross-border with BOL_GID → customs entry submitted',   expect_text:'CUSTOMS_ENTRY_GID is not null ITN_NUMBER is not null',          result:'pass', got_text:null, sort_order:2 },
    { id:'TC-CD-03', agent_id:'AG-COMP-CUSTSDECL', name:'Cross-border with null BOL_GID → abort submission',     expect_text:'CUSTOMS_SUBMISSION_FAILED REASON = BOL_GID_NULL',              result:'fail', got_text:'Submission attempted — null BOL_GID not guarded in PROD v2.3.0', sort_order:3 },
    // AG-AI-DWELL
    { id:'TC-DW-01', agent_id:'AG-AI-DWELL',        name:'Stale model (>7 days) → confidence flagged low',       expect_text:'DWELL_CONFIDENCE_PCT < 0.70 when model_age_days > 7',          result:'pass', got_text:null, sort_order:1 },
    { id:'TC-DW-02', agent_id:'AG-AI-DWELL',        name:'Known high-dwell lane (DC Memphis) → dwell > 12h',     expect_text:'PREDICTED_DWELL_HOURS > 12 for DEST=NWL.DC.MEMPHIS CARRIER=ODFL', result:'pass', got_text:null, sort_order:2 },
    // AG-COMP-HAZMAT
    { id:'TC-HZ-01', agent_id:'AG-COMP-HAZMAT',     name:'UN1203 gasoline — class 3 placard required',           expect_text:"PLACARD_REQUIREMENT_CODE = 'FLAMMABLE_LIQUID'",                result:'pass', got_text:null, sort_order:1 },
    { id:'TC-HZ-02', agent_id:'AG-COMP-HAZMAT',     name:'Non-hazmat shipment — no placard, cleared',            expect_text:"HAZMAT_CLEARED_FLG = Y PLACARD_REQUIREMENT_CODE = 'NONE'",    result:'pass', got_text:null, sort_order:2 },
    { id:'TC-HZ-03', agent_id:'AG-COMP-HAZMAT',     name:'Non-certified carrier → block tender',                 expect_text:"HAZMAT block applied — CARRIER_HAZMAT_CERTIFIED = N",          result:'pass', got_text:null, sort_order:3 },
  ];
  for (const t of tests) {
    await q(`INSERT INTO regression_tests(id,agent_id,name,expect_text,result,got_text,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [t.id, t.agent_id, t.name, t.expect_text, t.result, t.got_text, t.sort_order]);
  }

  console.log('✅  Seed complete.');
  pool.end();
}

run().catch(e => { console.error('❌ Seed failed:', e.message); pool.end(); process.exit(1); });
