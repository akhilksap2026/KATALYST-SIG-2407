"""Seed script — populates all tables from the hardcoded dataset in Catalyst.dc.html."""
import os, json
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]

def conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)

# ────────────────────────────────────────────── agents ──────────────────────
agents = [
    dict(id='AG-ORD-RATESVC', name='Rate & Service Selection', domain='Order Release', type='Rating', version='v4.2.1', owner='s.patel', trigger='Order Released', evt='ORDER_RELEASED', priority='High', success=97.3, health='green', gx=50, gy=64,
         conditions=["ORDER_MOVEMENT.status = 'NEW'","SERVICE_LEVEL is not null","SHIP_UNIT_GID is not null","HAZMAT_FLAG = false OR HAZMAT_CERT_GID is not null"],
         actions=["computeRate(ORDER_MOVEMENT_GID, LANE_GID)","selectServiceProvider(RATE_GEO_COST_GID)","writeRateGid(RATE_GID)","setServiceGid(SERVICE_GID)","emitEvent('RATE_APPLIED', ORDER_MOVEMENT_GID)"],
         reads=["ORDER_MOVEMENT_GID","SHIP_UNIT_GID","SERVICE_LEVEL","SHIP_FROM_GID","SHIP_TO_GID","LANE_GID","HAZMAT_FLAG"],
         writes=["RATE_GID","SERVICE_GID","RATE_GEO_COST_GID"]),
    dict(id='AG-ORD-CREDITHOLD', name='Credit Hold Check', domain='Order Release', type='Compliance', version='v1.4.2', owner='s.patel', trigger='Order Released', evt='ORDER_RELEASED', priority='Critical', success=99.1, health='green', gx=50, gy=212,
         conditions=["CUSTOMER.credit_status IN ('REVIEW','WATCH')","ORDER_VALUE > CUSTOMER.CREDIT_LIMIT * 0.85","OUTSTANDING_AR_BALANCE > 0"],
         actions=["checkCreditLimit(CUSTOMER_GID, ORDER_VALUE)","applyHold(ORDER_MOVEMENT_GID)","setHoldStatus('CREDIT')","auditLog('CREDIT_HOLD', ORDER_MOVEMENT_GID)","notifyCreditManager(CUSTOMER_GID, ORDER_VALUE)"],
         reads=["ORDER_MOVEMENT_GID","CUSTOMER_GID","ORDER_VALUE","CREDIT_LIMIT","OUTSTANDING_AR_BALANCE"],
         writes=["HOLD_STATUS","ORDER_STATUS","AUDIT_ENTRY"]),
    dict(id='AG-AI-CARRIERRANK', name='AI Carrier Ranking', domain='Oracle AI', type='AI', version='v1.2.0', owner='oracle.ai', trigger='Rate Applied', evt='RATE_APPLIED', priority='Medium', success=91.2, health='amber', gx=50, gy=360,
         conditions=["RATE_GID is not null","model.confidence > 0.72","CARRIER_POOL.count >= 2"],
         actions=["scoreCarriers(LANE_GID, HISTORICAL_PERF)","applyDwellPenalty(AVG_DWELL_HRS)","rankByOnTimeDelivery(SERVICE_PROVIDER_GID[])","emitHint('CARRIER_RANK_HINT', top3)"],
         reads=["LANE_GID","RATE_GID","SERVICE_PROVIDER_GID[]","HISTORICAL_PERF","AVG_DWELL_HRS","ON_TIME_PCT","CLAIM_RATE"],
         writes=["CARRIER_RANK_HINT"]),
    dict(id='AG-SHIP-AUTOTENDER', name='Auto-Tender on Plan', domain='Shipment Execution', type='Tender', version='v2.4.1', owner='m.reyes', trigger='Shipment Planned', evt='SHIPMENT_PLANNED', priority='Critical', success=98.2, health='green', gx=330, gy=64,
         conditions=["SHIPMENT.status = 'PLANNED'","PLANNED_SHIP_DATE <= sysdate + 2","PLANNED_COST < BUDGET_LIMIT","HOLD_STATUS is null","EQUIPMENT_GROUP_GID is not null"],
         actions=["readHint('CARRIER_RANK_HINT')","selectCarrier(CARRIER_RANK_HINT OR default_lane_prefs)","buildTenderPayload(SHIPMENT_GID, CARRIER_GID)","sendTender(SERVICE_PROVIDER_GID, TENDER_GID)","setTenderStatus('SENT')","scheduleAckTimeout(30s)"],
         reads=["SHIPMENT_GID","PLANNED_COST","PLANNED_SHIP_DATE","EQUIPMENT_GROUP_GID","CARRIER_RANK_HINT","TENDER_HINT","HOLD_STATUS"],
         writes=["TENDER_GID","TENDER_STATUS","CARRIER_GID"]),
    dict(id='AG-AI-DWELL', name='Dwell Prediction', domain='Oracle AI', type='AI', version='v0.9-beta', owner='oracle.ai', trigger='Shipment Planned', evt='SHIPMENT_PLANNED', priority='Medium', success=88.4, health='amber', gx=330, gy=226,
         conditions=["model.confidence > 0.60","LOCATION_GID in model.coverage_zones","SHIPMENT.equipment_type != 'RAIL'"],
         actions=["loadModelArtifact('dwell_rf_v3')","extractFeatures(LOCATION_GID, CARRIER_SCORE, TIME_OF_DAY)","predictDwellHours(HISTORICAL_DWELL, WEATHER_INDEX)","writeForecast(DWELL_FORECAST)","emitHint('TENDER_HINT', confidence)"],
         reads=["SHIPMENT_GID","LOCATION_GID","HISTORICAL_DWELL","CARRIER_SCORE","WEATHER_INDEX","TIME_OF_DAY"],
         writes=["DWELL_FORECAST","TENDER_HINT"]),
    dict(id='AG-SHIP-TENDERRESP', name='Tender Response Handler', domain='Shipment Execution', type='Tender', version='v1.9.0', owner='m.reyes', trigger='Tender Response Received', evt='TENDER_RESPONSE', priority='High', success=99.1, health='green', gx=610, gy=64,
         conditions=["TENDER_GID is not null","TENDER_STATUS IN ('SENT','RETENDERED')","RESPONSE_TIMESTAMP < TENDER_GID.expiry"],
         actions=["validateTenderVersion(TENDER_GID)","recordResponse(TENDER_RESPONSE, CARRIER_GID)","onAccept → setShipmentStatus('CONFIRMED')","onAccept → emitEvent('SHIPMENT_CONFIRMED')","onDecline → raise(TENDER_DECLINED)","logCarrierPerf(CARRIER_GID, RESPONSE_TIME_MS)"],
         reads=["TENDER_GID","TENDER_STATUS","CARRIER_GID","TENDER_RESPONSE","RESPONSE_TIMESTAMP"],
         writes=["SHIPMENT_STATUS","TENDER_STATUS","CARRIER_PERF_LOG"]),
    dict(id='AG-SHIP-RETENDER', name='Auto Re-Tender on Decline', domain='Shipment Execution', type='Tender', version='v2.0.3', owner='a.okafor', trigger='Tender Declined', evt='TENDER_DECLINED', priority='High', success=95.6, health='amber', gx=610, gy=226,
         conditions=["TENDER_STATUS = 'DECLINED'","RETENDER_COUNT < 3","ALT_CARRIER_POOL.size > 0","PLANNED_SHIP_DATE > sysdate + 0.5"],
         actions=["incrementRetenderCount(TENDER_GID)","excludeDeclinedCarrier(CARRIER_GID)","selectNextCarrier(ALT_CARRIER_POOL, CARRIER_RANK_HINT)","buildTenderPayload(SHIPMENT_GID, new_CARRIER_GID)","sendTender(new_CARRIER_GID, TENDER_GID)","setTenderStatus('RETENDERED')","onTimeout(30s) → escalate(SHIPMENT_GID, 'CARRIER_TIMEOUT')"],
         reads=["TENDER_GID","TENDER_STATUS","CARRIER_GID","RETENDER_COUNT","ALT_CARRIER_POOL","PLANNED_SHIP_DATE","CARRIER_RANK_HINT"],
         writes=["TENDER_STATUS","CARRIER_GID","RETENDER_COUNT"]),
    dict(id='AG-SHIP-TRACKUPDATE', name='Shipment Track & Trace', domain='Shipment Execution', type='Tracking', version='v2.3.1', owner='l.tran', trigger='Shipment Confirmed', evt='SHIPMENT_CONFIRMED', priority='Medium', success=96.4, health='green', gx=890, gy=226,
         conditions=["SHIPMENT.status = 'CONFIRMED'","CARRIER_GID.edi_capable = true OR CARRIER_GID.api_capable = true"],
         actions=["subscribeToTrackingFeed(CARRIER_GID, SHIPMENT_GID)","mapCarrierStatus(CARRIER_STATUS → OTM_STATUS)","updateMilestone(MILESTONE_CODE, EVENT_TIMESTAMP)","onDelivered → setShipmentStatus('DELIVERED')","onException → raise('SHIPMENT_EXCEPTION')","notifyStakeholders(CUSTOMER_GID, MILESTONE_CODE)"],
         reads=["SHIPMENT_GID","CARRIER_GID","TRACKING_NUMBER","CARRIER_STATUS"],
         writes=["SHIPMENT_STATUS","MILESTONE_LOG","ETA_TIMESTAMP"]),
    dict(id='AG-SHIP-DOCGEN', name='Document Generation', domain='Shipment Execution', type='Document', version='v3.1.0', owner='l.tran', trigger='Shipment Confirmed', evt='SHIPMENT_CONFIRMED', priority='Medium', success=99.7, health='green', gx=890, gy=64,
         conditions=["SHIPMENT.status = 'CONFIRMED'","CARRIER_GID.bol_required = true","SHIP_UNIT_GID is not null"],
         actions=["generateBOL(SHIPMENT_GID, CARRIER_GID)","generateLabels(SHIP_UNIT_GID[], format=ZPL)","generateProBill(CARRIER_GID, TENDER_GID)","writeDocs(DOCUMENT_SET_GID)","transmitToCarrier(DOCUMENT_SET_GID, CARRIER_GID.edi_mailbox)"],
         reads=["SHIPMENT_GID","CARRIER_GID","SHIP_UNIT_GID","TENDER_GID"],
         writes=["DOCUMENT_SET_GID","BOL_GID","LABEL_SET_GID"]),
    dict(id='AG-INV-AUTOAPPROVE', name='Auto-Approve under Tolerance', domain='Invoice & Finance', type='Invoice', version='v2.1.5', owner='d.kim', trigger='Invoice Received', evt='INVOICE_RECEIVED', priority='Medium', success=94.1, health='amber', gx=890, gy=352,
         conditions=["FREIGHT_BILL.status = 'RECEIVED'","abs(FB_AMOUNT - RATE_GEO_COST) <= TOLERANCE_BAND","RATE_GID is not null","SHIPMENT_GID.status = 'DELIVERED'","NOT exists(DUPLICATE_FB_FLAG)"],
         actions=["matchFreightBill(FREIGHT_BILL_GID, RATE_GID)","validateAccessorials(ACCESSORIAL_CHARGES)","computeVariance(FB_AMOUNT, RATE_GEO_COST)","setInvoiceStatus('APPROVED')","schedulePayment(PAYMENT_DUE_DATE, FB_AMOUNT)"],
         reads=["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST","TOLERANCE_BAND","ACCESSORIAL_CHARGES"],
         writes=["MATCH_STATUS","INVOICE_STATUS","PAYMENT_SCHEDULE_GID"]),
    dict(id='AG-INV-VARIANCE', name='Variance Escalation', domain='Invoice & Finance', type='Invoice', version='v1.2.0', owner='d.kim', trigger='Invoice Received', evt='INVOICE_RECEIVED', priority='Medium', success=92.5, health='amber', gx=610, gy=382,
         conditions=["abs(FB_AMOUNT - RATE_GEO_COST) > TOLERANCE_BAND","FREIGHT_BILL.status = 'RECEIVED'"],
         actions=["classifyVariance(FB_AMOUNT - RATE_GEO_COST)","openEscalation(FREIGHT_BILL_GID)","writeTicket(ESCALATION_TICKET_GID)","escalateToSLA(variance_amount, SLA_HOURS=4)","notify(d.kim, finance-ops@nwl.com)"],
         reads=["FREIGHT_BILL_GID","FB_AMOUNT","RATE_GID","RATE_GEO_COST","TOLERANCE_BAND"],
         writes=["ESCALATION_TICKET_GID","INVOICE_STATUS","SLA_CLOCK_START"]),
    dict(id='AG-INV-FRTAUDIT', name='Freight Bill Audit', domain='Invoice & Finance', type='Invoice', version='v1.0.4', owner='d.kim', trigger='Invoice Approved', evt='INVOICE_APPROVED', priority='Low', success=98.8, health='green', gx=890, gy=500,
         conditions=["INVOICE_STATUS = 'APPROVED'","FREIGHT_BILL.payment_method = 'NET30'","AUDIT_REQUIRED_FLAG = true OR FB_AMOUNT > 10000"],
         actions=["crossCheckAccessorials(FREIGHT_BILL_GID, CONTRACT_GID)","verifyFuelSurcharge(FSC_RATE, CARRIER_GID)","checkDuplicateInvoice(FREIGHT_BILL_GID, DATE_RANGE=90d)","flagDiscrepancy(DISCREPANCY_TYPE, DISCREPANCY_AMOUNT)","writeAuditTrail(AUDIT_LOG_GID)"],
         reads=["FREIGHT_BILL_GID","CONTRACT_GID","FSC_RATE","ACCESSORIAL_CHARGES","PAYMENT_TERMS"],
         writes=["AUDIT_STATUS","DISCREPANCY_AMOUNT","AUDIT_LOG_GID"]),
]

flow_edges = [
    ('AG-ORD-RATESVC','AG-SHIP-AUTOTENDER','flow'),
    ('AG-ORD-CREDITHOLD','AG-SHIP-AUTOTENDER','flow'),
    ('AG-SHIP-AUTOTENDER','AG-SHIP-TENDERRESP','flow'),
    ('AG-SHIP-TENDERRESP','AG-SHIP-DOCGEN','flow'),
    ('AG-SHIP-TENDERRESP','AG-SHIP-RETENDER','flow'),
    ('AG-SHIP-TENDERRESP','AG-SHIP-TRACKUPDATE','flow'),
    ('AG-SHIP-RETENDER','AG-SHIP-TENDERRESP','flow'),
    ('AG-SHIP-DOCGEN','AG-INV-AUTOAPPROVE','flow'),
    ('AG-INV-AUTOAPPROVE','AG-INV-FRTAUDIT','flow'),
    ('AG-INV-AUTOAPPROVE','AG-INV-VARIANCE','flow'),
    ('AG-AI-DWELL','AG-SHIP-AUTOTENDER','ai'),
    ('AG-AI-CARRIERRANK','AG-SHIP-AUTOTENDER','ai'),
    ('AG-AI-CARRIERRANK','AG-SHIP-RETENDER','ai'),
]

conflicts = [
    dict(id='C-002', severity='critical', event='SHIPMENT_PLANNED', agent_a='AG-SHIP-AUTOTENDER', agent_b='AG-AI-DWELL',
         detail="Both agents subscribe to SHIPMENT_PLANNED. Dwell Prediction writes TENDER_HINT which Auto-Tender reads — but execution order is non-deterministic. In 23% of observed runs, Auto-Tender fires before TENDER_HINT is written, producing sub-optimal carrier selection. Race window averages 504ms under production load.",
         fix="Sequence AG-AI-DWELL before AG-SHIP-AUTOTENDER using an event gate on DWELL_FORECAST availability, or gate Auto-Tender on TENDER_HINT with a bounded 500ms wait before falling back to default lane preferences."),
    dict(id='C-001', severity='critical', event='ORDER_RELEASED', agent_a='AG-ORD-RATESVC', agent_b='AG-ORD-CREDITHOLD',
         detail="Rate & Service Selection and Credit Hold Check both fire on ORDER_RELEASED and both write ORDER_STATUS fields. Credit Hold may apply a CREDIT hold after Rate & Service has already advanced the order to RATED status, leaving an ORDER_MOVEMENT that is simultaneously RATED and CREDIT-HELD — downstream shipment planning guards do not catch this state.",
         fix="Raise AG-ORD-CREDITHOLD priority above AG-ORD-RATESVC. Gate AG-ORD-RATESVC on HOLD_STATUS is null so rating never proceeds on a held order."),
    dict(id='C-005', severity='critical', event='ORDER_RELEASED', agent_a='AG-ORD-CREDITHOLD', agent_b='AG-AI-CARRIERRANK',
         detail="AI Carrier Ranking fires on ORDER_RELEASED and reads RATE_GID as a key input for lane-scoring. However AG-ORD-RATESVC may not have written RATE_GID yet when the AI agent fires. In those cases the model falls back to lane-average scoring — ignoring the awarded rate — and emits a CARRIER_RANK_HINT that does not reflect the actual cost basis. Observed in 18% of ORDER_RELEASED events.",
         fix="Rechain AG-AI-CARRIERRANK to trigger on RATE_APPLIED event (emitted by AG-ORD-RATESVC v4.2.1+) instead of ORDER_RELEASED, guaranteeing RATE_GID is present at score time."),
    dict(id='C-004', severity='warning', event='TENDER_STATUS', agent_a='AG-SHIP-RETENDER', agent_b='AG-SHIP-TENDERRESP',
         detail="Auto Re-Tender writes TENDER_STATUS = 'RETENDERED' while Tender Response Handler may still be processing a late TENDER_RESPONSE for the prior tender. A stale ACCEPTED response arriving after re-tender can overwrite the new CARRIER_GID, silently routing the shipment to the previously declined carrier. Affects roughly 2.1% of re-tender cycles under high carrier API latency.",
         fix="Add an optimistic concurrency field TENDER_VERSION_SEQ to TENDER_GID. Discard any TENDER_RESPONSE whose TENDER_VERSION_SEQ does not match the current active tender sequence number."),
    dict(id='C-003', severity='warning', event='INVOICE_RECEIVED', agent_a='AG-INV-AUTOAPPROVE', agent_b='AG-INV-VARIANCE',
         detail="Auto-Approve and Variance Escalation both trigger on INVOICE_RECEIVED and both write INVOICE_STATUS. At the TOLERANCE_BAND boundary ($5.00), IEEE 754 floating-point rounding on FB_AMOUNT and RATE_GEO_COST can cause both agents to evaluate the same FREIGHT_BILL_GID as within-tolerance and out-of-tolerance simultaneously, generating duplicate ESCALATION_TICKET entries and a stuck INVOICE_STATUS.",
         fix="Chain AG-INV-VARIANCE to trigger on INVOICE_VARIANCE_RAISED (an event emitted by AG-INV-AUTOAPPROVE on reject path) rather than sharing the INVOICE_RECEIVED trigger directly."),
]

audit_entries = [
    dict(time='2026-06-30 08:17', username='m.reyes', action='Acknowledge conflict', target='C-005', env='PROD', result='Acknowledged', tone='teal', note='Rechaining AG-AI-CARRIERRANK to RATE_APPLIED — tracked in JIRA OTM-4412'),
    dict(time='2026-06-30 07:44', username='system', action='Detect conflict', target='C-005', env='PROD', result='Critical raised', tone='red', note='AI carrier scoring on null RATE_GID in 18% of ORDER_RELEASED events'),
    dict(time='2026-06-29 14:30', username='system', action='Auto-promote', target='AG-INV-FRTAUDIT@v1.0.4', env='TEST→PROD', result='Promoted', tone='green', note='All 8 regression tests passed · zero discrepancy on 3,200 sample bills'),
    dict(time='2026-06-29 12:18', username='d.kim', action='Edit conditions', target='AG-INV-FRTAUDIT', env='TEST', result='Saved', tone='green', note='Raised audit threshold: FB_AMOUNT > $10,000 OR AUDIT_REQUIRED_FLAG = true'),
    dict(time='2026-06-29 09:42', username='m.reyes', action='Promote agent', target='AG-SHIP-RETENDER@v2.1.0-draft', env='TEST→PROD', result='BLOCKED', tone='red', note='TC-04 failing — unbounded carrier ack timeout (30s→∞ on SWFT API)'),
    dict(time='2026-06-29 09:38', username='m.reyes', action='Run regression suite', target='AG-SHIP-RETENDER@v2.1.0-draft', env='TEST', result='5 passed / 1 failed', tone='amber', note=None),
    dict(time='2026-06-29 09:15', username='a.okafor', action='Edit conditions', target='AG-SHIP-RETENDER', env='TEST', result='Saved', tone='green', note='Added PLANNED_SHIP_DATE > sysdate + 0.5 guard to block late re-tenders'),
    dict(time='2026-06-29 08:50', username='s.patel', action='Acknowledge conflict', target='C-001', env='PROD', result='Acknowledged', tone='teal', note=None),
    dict(time='2026-06-29 08:31', username='system', action='Detect conflict', target='C-002', env='PROD', result='Critical raised', tone='red', note='TENDER_HINT race on 3 consecutive SHIPMENT_PLANNED events · 504ms avg gap'),
    dict(time='2026-06-28 22:04', username='l.tran', action='Promote agent', target='AG-SHIP-DOCGEN@v3.1.0', env='TEST→PROD', result='Promoted', tone='green', note=None),
    dict(time='2026-06-28 18:12', username='d.kim', action='Edit tolerance', target='AG-INV-AUTOAPPROVE', env='DEV', result='Saved', tone='green', note='TOLERANCE_BAND raised $2.00 → $5.00 per Finance Directive FIN-2026-14'),
    dict(time='2026-06-28 14:09', username='oracle.ai', action='Model deploy', target='AG-AI-DWELL@v0.9-beta', env='DEV', result='Deployed', tone='teal', note='Switched RF-v2 → gradient boost v3 · coverage zones expanded to 94 DCs'),
    dict(time='2026-06-28 13:22', username='oracle.ai', action='Model deploy', target='AG-AI-CARRIERRANK@v1.2.0', env='DEV', result='Deployed', tone='teal', note='New agent · scores carriers on OTD %, dwell penalty, and claim rate'),
    dict(time='2026-06-27 15:30', username='s.patel', action='Edit conditions', target='AG-ORD-RATESVC', env='TEST', result='Saved', tone='green', note='Added HAZMAT_FLAG guard · HAZMAT_CERT_GID required for hazmat orders'),
    dict(time='2026-06-27 09:10', username='l.tran', action='Clone blueprint', target='AG-SHIP-TRACKUPDATE → BP-TRACKUPDATE-V2', env='DEV', result='Created', tone='teal', note='Blueprint created for exception-branch rework'),
]

jobs = [
    dict(id='JOB-TENDER-SWEEP', name='Nightly Tender Sweep', cron='0 2 * * *', last_run='Today 02:00', duration='4m 12s', trend='up', health='green'),
    dict(id='JOB-INV-TOL', name='Invoice Tolerance Batch', cron='0 */4 * * *', last_run='Today 04:00', duration='1m 38s', trend='flat', health='green'),
    dict(id='JOB-CREDIT-REC', name='Credit Hold Reconcile', cron='0 */6 * * *', last_run='Today 06:00', duration='2m 05s', trend='down', health='green'),
    dict(id='JOB-FRTAUDIT', name='Freight Bill Audit Batch', cron='0 6 * * *', last_run='Today 06:00', duration='12m 07s', trend='up', health='green'),
    dict(id='JOB-CARRRANK-TRAIN', name='Carrier Rank Model Retrain', cron='0 3 * * 0', last_run='Sun 03:00', duration='28m 44s', trend='up', health='amber'),
    dict(id='JOB-DOC-ARCH', name='Document Archive', cron='0 23 * * *', last_run='Yesterday 23:00', duration='8m 44s', trend='up', health='amber'),
    dict(id='JOB-DWELL-REFRESH', name='Dwell Prediction Model Refresh', cron='0 1 * * *', last_run='— missed —', duration='—', trend='flat', health='red'),
    dict(id='JOB-CARR-ROLLUP', name='Carrier Performance Rollup', cron='0 5 * * 1', last_run='Mon 05:00', duration='3m 21s', trend='flat', health='green'),
]

trace_runs = [
    dict(agent_id='AG-ORD-RATESVC', run_id='RUN-44201', shipment='NWL.OR20811', env='PROD', started='2026-06-29 09:41:07', total_ms=448, status='ok', status_label='Completed · 448ms',
         steps=[{'label':'Trigger received','io':'evt=ORDER_RELEASED · ORDER_GID=NWL.OR20811','start':0,'dur':8,'status':'ok'},{'label':'Load order context','io':'in: ORDER_GID=NWL.OR20811 → out: SERVICE_LEVEL=LTL, SHIP_FROM_GID=NWL.DC.MEMPHIS','start':8,'dur':94,'status':'ok'},{'label':'Evaluate guard conditions','io':"ORDER_STATUS='NEW' ✓ · SERVICE_LEVEL not null ✓",'start':102,'dur':11,'status':'ok'},{'label':'Compute rate','io':'calling RATE_ENGINE · shipment weight=4,820lbs · lane=MEM→ATL','start':113,'dur':287,'status':'ok'},{'label':'Write rate to order','io':'out: RATE_GID=RT.20811 · $1,204.50 · SVC=LTL-STANDARD','start':400,'dur':41,'status':'ok'},{'label':'Completed','io':'write: RATE_GID ✓, SERVICE_GID ✓','start':441,'dur':7,'status':'ok'}]),
    dict(agent_id='AG-ORD-CREDITHOLD', run_id='RUN-44198', shipment='NWL.OR20809', env='PROD', started='2026-06-29 09:38:53', total_ms=203, status='ok', status_label='Completed · 203ms',
         steps=[{'label':'Trigger received','io':'evt=ORDER_RELEASED · CUSTOMER_GID=NWL.CUST.4481','start':0,'dur':6,'status':'ok'},{'label':'Load customer credit profile','io':'in: CUSTOMER_GID=NWL.CUST.4481 → out: credit_status=OK, CREDIT_LIMIT=$50,000','start':6,'dur':118,'status':'ok'},{'label':'Evaluate credit conditions','io':'ORDER_VALUE=$12,400 < CREDIT_LIMIT=$50,000 ✓ · no hold applied','start':124,'dur':14,'status':'ok'},{'label':'Completed (no hold)','io':'HOLD_STATUS unchanged · ORDER_STATUS=RELEASED','start':138,'dur':65,'status':'ok'}]),
    dict(agent_id='AG-SHIP-AUTOTENDER', run_id='RUN-48207', shipment='NWL.SH10290', env='PROD', started='2026-06-29 08:52:14', total_ms=1842, status='warn', status_label='Completed · 1.8s · TENDER_HINT race (C-002)',
         steps=[{'label':'Trigger received','io':'evt=SHIPMENT_PLANNED · SHIPMENT_GID=NWL.SH10290','start':0,'dur':9,'status':'ok'},{'label':'Load shipment context','io':'out: status=PLANNED, PLANNED_COST=$2,104 < BUDGET_LIMIT ✓, HOLD_STATUS=null ✓','start':9,'dur':74,'status':'ok'},{'label':'Read TENDER_HINT','io':'⚠ TENDER_HINT not yet available — AG-AI-DWELL still running, falling back to default carrier selection','start':83,'dur':504,'status':'warn'},{'label':'Select carrier (no hint)','io':'out: CARRIER_GID=NWL.CARR.JBH (fallback, no dwell scoring applied)','start':587,'dur':38,'status':'ok'},{'label':'Build tender payload','io':'out: payload 2.0KB · rate=$2,104.00 · service=TL','start':625,'dur':29,'status':'ok'},{'label':'POST tender → carrier API','io':'POST /v2/tender carrier=JBH · ack received in 1,170ms','start':654,'dur':1170,'status':'ok'},{'label':'Completed','io':'write: TENDER_STATUS=SENT ✓, CARRIER_GID ✓ · conflict C-002 risk materialised this run','start':1824,'dur':18,'status':'ok'}]),
    dict(agent_id='AG-AI-DWELL', run_id='RUN-47990', shipment='NWL.SH10277', env='PROD', started='2026-06-29 01:02:18', total_ms=450, status='warn', status_label='Degraded · confidence below threshold (stale model)',
         steps=[{'label':'Trigger received','io':'evt=SHIPMENT_PLANNED · SHIPMENT_GID=NWL.SH10277','start':0,'dur':7,'status':'ok'},{'label':'Load location context','io':'in: LOCATION_GID=NWL.DC.MEMPHIS → out: HISTORICAL_DWELL=2.4h avg','start':7,'dur':112,'status':'ok'},{'label':'Load model artifact','io':'⚠ loading dwell_rf_v2 — JOB-DWELL-REFRESH missed 01:00 run, model is 25h stale','start':119,'dur':38,'status':'warn'},{'label':'Run inference','io':'confidence=0.42 < threshold 0.60 — prediction suppressed','start':157,'dur':284,'status':'warn'},{'label':'Emit hint (suppressed)','io':'TENDER_HINT NOT emitted · downstream AG-SHIP-AUTOTENDER will fall back to default carrier selection','start':441,'dur':9,'status':'warn'}]),
    dict(agent_id='AG-SHIP-TENDERRESP', run_id='RUN-48210', shipment='NWL.SH10292', env='PROD', started='2026-06-29 09:22:44', total_ms=318, status='ok', status_label='Completed · 318ms',
         steps=[{'label':'Trigger received','io':'evt=TENDER_RESPONSE_RECEIVED · CARRIER_GID=NWL.CARR.JBH','start':0,'dur':8,'status':'ok'},{'label':'Validate tender state','io':'TENDER_STATUS=SENT ✓ · version match ✓','start':8,'dur':19,'status':'ok'},{'label':'Process carrier response','io':'TENDER_RESPONSE=ACCEPTED · carrier=NWL.CARR.JBH','start':27,'dur':44,'status':'ok'},{'label':'Set shipment confirmed','io':'write: SHIPMENT_STATUS=CONFIRMED · TENDER_STATUS=ACCEPTED','start':71,'dur':218,'status':'ok'},{'label':'Completed','io':'SHIPMENT_STATUS=CONFIRMED ✓','start':289,'dur':29,'status':'ok'}]),
    dict(agent_id='AG-SHIP-RETENDER', run_id='RUN-48213', shipment='NWL.SH10293', env='PROD', started='2026-06-29 03:14:02', total_ms=30206, status='error', status_label='Failed · CARRIER_TIMEOUT',
         steps=[{'label':'Trigger received','io':'evt=TENDER_DECLINED · SHIPMENT_GID=NWL.SH10293','start':0,'dur':12,'status':'ok'},{'label':'Load shipment context','io':'in: SHIPMENT_GID=NWL.SH10293 → out: status=DECLINED, retry_count=1','start':12,'dur':86,'status':'ok'},{'label':'Evaluate guard conditions','io':'retry_count(1) < 3 ✓ · alt_carrier_exists ✓','start':98,'dur':22,'status':'ok'},{'label':'Select next carrier','io':'out: CARRIER_GID=NWL.CARR.SWFT (Swift Freight)','start':120,'dur':41,'status':'ok'},{'label':'Build tender payload','io':'out: payload 2.1KB · rate=$1,842.00 · service=LTL','start':161,'dur':33,'status':'ok'},{'label':'POST tender → carrier API','io':'POST /v2/tender carrier=SWFT · awaiting ack…','start':194,'dur':30000,'status':'error'},{'label':'Agent run failed','io':'error: CARRIER_TIMEOUT after 30000ms · no response from NWL.CARR.SWFT','start':30194,'dur':12,'status':'error'}]),
    dict(agent_id='AG-SHIP-DOCGEN', run_id='RUN-48201', shipment='NWL.SH10288', env='PROD', started='2026-06-29 09:14:09', total_ms=624, status='ok', status_label='Completed · 624ms',
         steps=[{'label':'Trigger received','io':'evt=SHIPMENT_CONFIRMED · SHIPMENT_GID=NWL.SH10288','start':0,'dur':7,'status':'ok'},{'label':'Load shipment & carrier data','io':'in: SHIPMENT_GID=NWL.SH10288, CARRIER_GID=NWL.CARR.JBH','start':7,'dur':88,'status':'ok'},{'label':'Generate Bill of Lading','io':'out: BOL-SH10288.pdf · 4 pages · 2.2 MB','start':95,'dur':312,'status':'ok'},{'label':'Generate carrier labels','io':'out: LABELS-SH10288.pdf · 2 labels · ZPL format','start':407,'dur':188,'status':'ok'},{'label':'Write document set','io':'write: DOCUMENT_SET ✓ · 2 documents stored','start':595,'dur':29,'status':'ok'}]),
    dict(agent_id='AG-INV-AUTOAPPROVE', run_id='RUN-48215', shipment='NWL.INV40192', env='PROD', started='2026-06-29 11:04:22', total_ms=2810, status='warn', status_label='Degraded · tolerance boundary exceeded',
         steps=[{'label':'Trigger received','io':'evt=INVOICE_RECEIVED · INVOICE_GID=NWL.INV40192','start':0,'dur':6,'status':'ok'},{'label':'Load invoice & rate','io':'in: INVOICE_AMOUNT=$1,207.50, RATE_GID=RT.20811, RATE_AMOUNT=$1,204.50','start':6,'dur':124,'status':'ok'},{'label':'Evaluate tolerance','io':'⚠ abs($1,207.50 − $1,204.50) = $3.00 > TOLERANCE=$2.00 — auto-approve BLOCKED','start':130,'dur':18,'status':'warn'},{'label':'Route to variance escalation','io':'raising INVOICE_VARIANCE event → AG-INV-VARIANCE will handle','start':148,'dur':2614,'status':'warn'},{'label':'Completed (no approval)','io':'INVOICE_STATUS=VARIANCE · escalation ticket to be created by AG-INV-VARIANCE','start':2762,'dur':48,'status':'ok'}]),
    dict(agent_id='AG-INV-VARIANCE', run_id='RUN-48216', shipment='NWL.INV40192', env='PROD', started='2026-06-29 11:04:25', total_ms=3940, status='warn', status_label='Degraded · escalation SLA risk',
         steps=[{'label':'Trigger received','io':'evt=INVOICE_RECEIVED · FREIGHT_BILL_GID=NWL.FB40192','start':0,'dur':7,'status':'ok'},{'label':'Load freight bill & rate','io':'in: FB_AMOUNT=$1,207.50, RATE_GEO_COST=$1,204.50, variance=$3.00 > TOLERANCE_BAND($5.00)? No — checking float precision…','start':7,'dur':118,'status':'ok'},{'label':'Classify variance','io':'⚠ abs(1207.50 - 1204.50)=$3.00 — TOLERANCE_BAND=$5.00 but IEEE 754 rounding places result at $5.0000000001 — C-003 risk pattern','start':125,'dur':19,'status':'warn'},{'label':'Open escalation ticket','io':'⚠ SLA = 4h remaining · ESCALATION_TICKET_GID=ESC-20929 created · SLA_CLOCK_START=11:04:25','start':144,'dur':44,'status':'warn'},{"label":"Notify d.kim","io":"notification sent: d.kim@nwl.com + in-app · finance-ops@nwl.com cc'd",'start':188,'dur':3697,'status':'ok'},{'label':'Write invoice status','io':'write: INVOICE_STATUS=ESCALATED ✓, ESCALATION_TICKET_GID=ESC-20929 ✓, SLA_CLOCK_START ✓','start':3885,'dur':55,'status':'ok'}]),
    dict(agent_id='AG-AI-CARRIERRANK', run_id='RUN-44195', shipment='NWL.OR20806', env='PROD', started='2026-06-30 07:18:42', total_ms=812, status='warn', status_label='Degraded · scored on null RATE_GID (C-005)',
         steps=[{'label':'Trigger received','io':'evt=ORDER_RELEASED · ORDER_MOVEMENT_GID=NWL.OM20806 (C-005 race: RATE_APPLIED not yet fired)','start':0,'dur':6,'status':'ok'},{'label':'Check RATE_GID availability','io':'⚠ RATE_GID is null — AG-ORD-RATESVC has not completed yet · falling back to lane-average scoring (C-005 materialised)','start':6,'dur':18,'status':'warn'},{'label':'Load lane performance data','io':'in: LANE_GID=NWL.LANE.MEM-ATL · 94 historical shipments · 6 eligible carriers in pool','start':24,'dur':141,'status':'ok'},{'label':'Score carriers (lane-average fallback)','io':'⚠ scoring without awarded RATE_GEO_COST · XPO=0.87, JBH=0.84, ODL=0.79, WRNR=0.71, SAIA=0.68, SWFT=0.52 · dwell penalty applied','start':165,'dur':388,'status':'warn'},{'label':'Apply dwell penalty','io':'SWFT penalised -0.14 (AVG_DWELL_HRS=3.8h) · NWL.CARR.SWFT dropped to rank 6','start':553,'dur':84,'status':'ok'},{'label':'Emit CARRIER_RANK_HINT','io':'⚠ hint emitted without RATE_GID context: top3=[XPO,JBH,ODL] · confidence=0.61 < threshold 0.72 — degraded output','start':637,'dur':175,'status':'warn'}]),
    dict(agent_id='AG-SHIP-TRACKUPDATE', run_id='RUN-48209', shipment='NWL.SH10291', env='PROD', started='2026-06-29 10:04:17', total_ms=1104, status='ok', status_label='Completed · 1.1s',
         steps=[{'label':'Trigger received','io':'evt=SHIPMENT_CONFIRMED · SHIPMENT_GID=NWL.SH10291 · CARRIER_GID=NWL.CARR.JBH','start':0,'dur':8,'status':'ok'},{'label':'Verify carrier capabilities','io':'NWL.CARR.JBH: edi_capable=true, api_capable=true, tracking_api=JBH-TRACK-v3','start':8,'dur':44,'status':'ok'},{'label':'Subscribe to tracking feed','io':'POST jbh-track.api.oracle.com/subscribe · TRACKING_NUMBER=JBH-TRK-882144 · webhook registered','start':52,'dur':318,'status':'ok'},{'label':'Receive initial milestone','io':'CARRIER_STATUS=IN_TRANSIT → OTM_STATUS=IN_TRANSIT · EVENT_TIMESTAMP=10:04 · GPS: 35.1°N 90.0°W (Memphis TN)','start':370,'dur':212,'status':'ok'},{'label':'Update shipment milestone','io':'write: MILESTONE_LOG[PICKUP]=10:04 ✓ · ETA_TIMESTAMP=2026-06-30 14:00 ✓','start':582,'dur':488,'status':'ok'},{'label':'Notify customer','io':'CUSTOMER_GID=NWL.CUST.4481 notified: shipment in transit, ETA Jun-30 14:00','start':1070,'dur':34,'status':'ok'}]),
    dict(agent_id='AG-INV-FRTAUDIT', run_id='RUN-48220', shipment='NWL.FB40188', env='PROD', started='2026-06-29 06:14:33', total_ms=2240, status='ok', status_label='Completed · 2.2s · no discrepancies',
         steps=[{'label':'Trigger received','io':'evt=INVOICE_APPROVED · FREIGHT_BILL_GID=NWL.FB40188 · FB_AMOUNT=$18,420.00 > $10,000 threshold → AUDIT_REQUIRED','start':0,'dur':7,'status':'ok'},{'label':'Load contract & freight bill','io':'in: CONTRACT_GID=NWL.CONT.JBH-2026 · FSC_RATE=28.4% · ACCESSORIAL_CHARGES=[fuel=$412, liftgate=$85, residential=$0]','start':7,'dur':134,'status':'ok'},{'label':'Cross-check accessorials','io':'fuel surcharge: agreed=$412.00 vs billed=$412.00 ✓ · liftgate: agreed=$85 vs billed=$85 ✓','start':141,'dur':286,'status':'ok'},{'label':'Verify fuel surcharge rate','io':'FSC_RATE lookup: DOE index week 2026-06-23 = 28.4% → carrier applied 28.4% ✓ · base freight=$1,450 · FSC=$412 ✓','start':427,'dur':318,'status':'ok'},{'label':'Check duplicate invoice','io':'scan DATE_RANGE=90d · no prior FREIGHT_BILL_GID matching NWL.FB40188 found ✓','start':745,'dur':1108,'status':'ok'},{'label':'Write audit trail','io':'AUDIT_STATUS=CLEAN · DISCREPANCY_AMOUNT=$0.00 · AUDIT_LOG_GID=AUDT-NWL-88204 written','start':1853,'dur':387,'status':'ok'}]),
]

live_events = [
    dict(ts='08:17:42',evt='ORDER_RELEASED',gid='NWL.OM20814',agent='AG-ORD-RATESVC',ms=312,ok=True),
    dict(ts='08:17:42',evt='ORDER_RELEASED',gid='NWL.OM20814',agent='AG-ORD-CREDITHOLD',ms=44,ok=True),
    dict(ts='08:17:44',evt='RATE_APPLIED',gid='NWL.OM20814',agent='AG-AI-CARRIERRANK',ms=388,ok=True),
    dict(ts='08:17:49',evt='SHIPMENT_PLANNED',gid='NWL.SH10296',agent='AG-AI-DWELL',ms=198,ok=False),
    dict(ts='08:17:49',evt='SHIPMENT_PLANNED',gid='NWL.SH10296',agent='AG-SHIP-AUTOTENDER',ms=204,ok=True),
    dict(ts='08:17:53',evt='TENDER_RESPONSE',gid='NWL.TND8822',agent='AG-SHIP-TENDERRESP',ms=88,ok=True),
    dict(ts='08:17:53',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10296',agent='AG-SHIP-DOCGEN',ms=1204,ok=True),
    dict(ts='08:17:53',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10296',agent='AG-SHIP-TRACKUPDATE',ms=318,ok=True),
    dict(ts='08:18:01',evt='ORDER_RELEASED',gid='NWL.OM20815',agent='AG-ORD-RATESVC',ms=284,ok=True),
    dict(ts='08:18:01',evt='ORDER_RELEASED',gid='NWL.OM20815',agent='AG-ORD-CREDITHOLD',ms=52,ok=True),
    dict(ts='08:18:03',evt='RATE_APPLIED',gid='NWL.OM20815',agent='AG-AI-CARRIERRANK',ms=412,ok=False),
    dict(ts='08:18:08',evt='SHIPMENT_PLANNED',gid='NWL.SH10297',agent='AG-AI-DWELL',ms=211,ok=True),
    dict(ts='08:18:08',evt='SHIPMENT_PLANNED',gid='NWL.SH10297',agent='AG-SHIP-AUTOTENDER',ms=187,ok=True),
    dict(ts='08:18:14',evt='TENDER_DECLINED',gid='NWL.TND8823',agent='AG-SHIP-RETENDER',ms=9204,ok=False),
    dict(ts='08:18:23',evt='TENDER_RESPONSE',gid='NWL.TND8823-R1',agent='AG-SHIP-TENDERRESP',ms=204,ok=True),
    dict(ts='08:18:23',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10297',agent='AG-SHIP-DOCGEN',ms=1104,ok=True),
    dict(ts='08:18:23',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10297',agent='AG-SHIP-TRACKUPDATE',ms=344,ok=True),
    dict(ts='08:18:31',evt='INVOICE_RECEIVED',gid='NWL.FB40200',agent='AG-INV-AUTOAPPROVE',ms=880,ok=True),
    dict(ts='08:18:31',evt='INVOICE_APPROVED',gid='NWL.FB40200',agent='AG-INV-FRTAUDIT',ms=2240,ok=True),
    dict(ts='08:18:44',evt='ORDER_RELEASED',gid='NWL.OM20816',agent='AG-ORD-RATESVC',ms=298,ok=True),
    dict(ts='08:18:44',evt='ORDER_RELEASED',gid='NWL.OM20816',agent='AG-ORD-CREDITHOLD',ms=88,ok=True),
    dict(ts='08:18:46',evt='RATE_APPLIED',gid='NWL.OM20816',agent='AG-AI-CARRIERRANK',ms=401,ok=True),
    dict(ts='08:18:51',evt='SHIPMENT_PLANNED',gid='NWL.SH10298',agent='AG-AI-DWELL',ms=178,ok=True),
    dict(ts='08:18:51',evt='SHIPMENT_PLANNED',gid='NWL.SH10298',agent='AG-SHIP-AUTOTENDER',ms=192,ok=True),
    dict(ts='08:18:57',evt='TENDER_RESPONSE',gid='NWL.TND8824',agent='AG-SHIP-TENDERRESP',ms=76,ok=True),
    dict(ts='08:18:57',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10298',agent='AG-SHIP-DOCGEN',ms=1312,ok=True),
    dict(ts='08:19:02',evt='INVOICE_RECEIVED',gid='NWL.FB40201',agent='AG-INV-AUTOAPPROVE',ms=744,ok=False),
    dict(ts='08:19:02',evt='INVOICE_RECEIVED',gid='NWL.FB40201',agent='AG-INV-VARIANCE',ms=3940,ok=True),
    dict(ts='08:19:12',evt='ORDER_RELEASED',gid='NWL.OM20817',agent='AG-ORD-RATESVC',ms=322,ok=True),
    dict(ts='08:19:12',evt='ORDER_RELEASED',gid='NWL.OM20817',agent='AG-ORD-CREDITHOLD',ms=41,ok=True),
    dict(ts='08:19:16',evt='RATE_APPLIED',gid='NWL.OM20817',agent='AG-AI-CARRIERRANK',ms=394,ok=True),
    dict(ts='08:19:21',evt='SHIPMENT_PLANNED',gid='NWL.SH10299',agent='AG-AI-DWELL',ms=204,ok=True),
    dict(ts='08:19:21',evt='SHIPMENT_PLANNED',gid='NWL.SH10299',agent='AG-SHIP-AUTOTENDER',ms=199,ok=True),
    dict(ts='08:19:27',evt='TENDER_RESPONSE',gid='NWL.TND8825',agent='AG-SHIP-TENDERRESP',ms=91,ok=True),
    dict(ts='08:19:27',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10299',agent='AG-SHIP-DOCGEN',ms=1188,ok=True),
    dict(ts='08:19:27',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10299',agent='AG-SHIP-TRACKUPDATE',ms=302,ok=True),
    dict(ts='08:19:34',evt='MILESTONE_UPDATE',gid='NWL.SH10291',agent='AG-SHIP-TRACKUPDATE',ms=14,ok=True),
    dict(ts='08:19:41',evt='INVOICE_APPROVED',gid='NWL.FB40200',agent='AG-INV-FRTAUDIT',ms=2108,ok=True),
    dict(ts='08:19:48',evt='ORDER_RELEASED',gid='NWL.OM20818',agent='AG-ORD-RATESVC',ms=307,ok=True),
    dict(ts='08:19:48',evt='ORDER_RELEASED',gid='NWL.OM20818',agent='AG-ORD-CREDITHOLD',ms=49,ok=True),
    dict(ts='08:19:50',evt='RATE_APPLIED',gid='NWL.OM20818',agent='AG-AI-CARRIERRANK',ms=388,ok=False),
    dict(ts='08:19:55',evt='SHIPMENT_PLANNED',gid='NWL.SH10300',agent='AG-AI-DWELL',ms=218,ok=True),
    dict(ts='08:19:55',evt='SHIPMENT_PLANNED',gid='NWL.SH10300',agent='AG-SHIP-AUTOTENDER',ms=196,ok=True),
    dict(ts='08:20:01',evt='TENDER_RESPONSE',gid='NWL.TND8826',agent='AG-SHIP-TENDERRESP',ms=84,ok=True),
    dict(ts='08:20:01',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10300',agent='AG-SHIP-DOCGEN',ms=1244,ok=True),
    dict(ts='08:20:01',evt='SHIPMENT_CONFIRMED',gid='NWL.SH10300',agent='AG-SHIP-TRACKUPDATE',ms=289,ok=True),
    dict(ts='08:20:08',evt='INVOICE_RECEIVED',gid='NWL.FB40202',agent='AG-INV-AUTOAPPROVE',ms=812,ok=True),
    dict(ts='08:20:08',evt='INVOICE_APPROVED',gid='NWL.FB40202',agent='AG-INV-FRTAUDIT',ms=2380,ok=True),
]

agent_diffs = [
    dict(id='AG-ORD-RATESVC', prod_ver='v1.8.0', test_ver='v1.8.1', insight="v1.8.1 emits a RATE_APPLIED event after rating, enabling downstream agents to react without polling ORDER_GID.", warning=None, conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: ORDER_RELEASED'},'r':{'t':'same','txt':'trigger: ORDER_RELEASED'}},{'l':{'t':'mod','txt':'version: v1.8.0'},'r':{'t':'mod','txt':'version: v1.8.1'}},{'l':{'t':'same','txt':"condition: ORDER_STATUS = 'RELEASED'"},'r':{'t':'same','txt':"condition: ORDER_STATUS = 'RELEASED'"}},{'l':{'t':'same','txt':'condition: SERVICE_LEVEL not null'},'r':{'t':'same','txt':'condition: SERVICE_LEVEL not null'}},{'l':{'t':'same','txt':'read: ORDER_GID, SERVICE_LEVEL, SHIP_FROM_GID'},'r':{'t':'same','txt':'read: ORDER_GID, SERVICE_LEVEL, SHIP_FROM_GID'}},{'l':{'t':'same','txt':'action: applyRate(RATE_GID)'},'r':{'t':'same','txt':'action: applyRate(RATE_GID)'}},{'l':{'t':'same','txt':'action: setServiceLevel(SERVICE_LEVEL)'},'r':{'t':'same','txt':'action: setServiceLevel(SERVICE_LEVEL)'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':"action: emitEvent('RATE_APPLIED')"}},{'l':{'t':'same','txt':'write: RATE_GID, SERVICE_GID'},'r':{'t':'same','txt':'write: RATE_GID, SERVICE_GID'}}]),
    dict(id='AG-ORD-CREDITHOLD', prod_ver='v1.2.3', test_ver='v1.2.4', insight="v1.2.4 adds an audit trail write and a credit team notification, improving compliance traceability.", warning='Verify no duplicate hold events with C-001 conflict on ORDER_RELEASED.', conflict_id='C-001',
         rows=[{'l':{'t':'same','txt':'trigger: ORDER_RELEASED'},'r':{'t':'same','txt':'trigger: ORDER_RELEASED'}},{'l':{'t':'mod','txt':'version: v1.2.3'},'r':{'t':'mod','txt':'version: v1.2.4'}},{'l':{'t':'same','txt':'condition: CUSTOMER_GID exists'},'r':{'t':'same','txt':'condition: CUSTOMER_GID exists'}},{'l':{'t':'same','txt':'condition: ORDER_VALUE > CREDIT_LIMIT'},'r':{'t':'same','txt':'condition: ORDER_VALUE > CREDIT_LIMIT'}},{'l':{'t':'same','txt':'read: ORDER_GID, ORDER_VALUE, CUSTOMER_GID'},'r':{'t':'same','txt':'read: ORDER_GID, ORDER_VALUE, CUSTOMER_GID'}},{'l':{'t':'same','txt':"action: setHoldStatus('CREDIT')"},'r':{'t':'same','txt':"action: setHoldStatus('CREDIT')"}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'action: auditLog(CREDIT_HOLD)'}},{'l':{'t':'same','txt':'action: notifyCredit(CUSTOMER_GID)'},'r':{'t':'same','txt':'action: notifyCredit(CUSTOMER_GID)'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'write: AUDIT_ENTRY'}},{'l':{'t':'same','txt':'write: HOLD_STATUS, ORDER_STATUS'},'r':{'t':'same','txt':'write: HOLD_STATUS, ORDER_STATUS'}}]),
    dict(id='AG-SHIP-AUTOTENDER', prod_ver='v2.4.0', test_ver='v2.4.1', insight="v2.4.1 raises priority to Critical, adds a budget guard and a hold check, and now reads TENDER_HINT from AG-AI-DWELL.", warning='Review against conflict C-002 before promoting — the new TENDER_HINT read is the source of the AI overlap.', conflict_id='C-002',
         rows=[{'l':{'t':'same','txt':'trigger: SHIPMENT_PLANNED'},'r':{'t':'same','txt':'trigger: SHIPMENT_PLANNED'}},{'l':{'t':'mod','txt':'priority: High'},'r':{'t':'mod','txt':'priority: Critical'}},{'l':{'t':'same','txt':"condition: SHIPMENT.status = 'PLANNED'"},'r':{'t':'same','txt':"condition: SHIPMENT.status = 'PLANNED'"}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'condition: PLANNED_COST < BUDGET_LIMIT'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'condition: HOLD_STATUS is null'}},{'l':{'t':'same','txt':'read: SHIPMENT_GID, PLANNED_COST'},'r':{'t':'same','txt':'read: SHIPMENT_GID, PLANNED_COST'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'read: TENDER_HINT  (from AG-AI-DWELL)'}},{'l':{'t':'same','txt':'action: selectCarrier()'},'r':{'t':'same','txt':'action: selectCarrier()'}},{'l':{'t':'del','txt':'action: notify(planner)'},'r':{'t':'none','txt':''}},{'l':{'t':'same','txt':'action: sendTender(CARRIER_GID)'},'r':{'t':'same','txt':'action: sendTender(CARRIER_GID)'}},{'l':{'t':'same','txt':'write: TENDER_STATUS, CARRIER_GID'},'r':{'t':'same','txt':'write: TENDER_STATUS, CARRIER_GID'}},{'l':{'t':'mod','txt':'success rate: 97.9%'},'r':{'t':'mod','txt':'success rate: 98.2%'}}]),
    dict(id='AG-AI-DWELL', prod_ver='v3.1.0', test_ver='v3.2.0-beta', insight='v3.2.0-beta retrains on a wider carrier dataset, lowers the confidence threshold to 0.55, and adds CARRIER_SCORE as an input feature.', warning='This model update is the source of conflict C-002 — validate TENDER_HINT output stability before promoting.', conflict_id='C-002',
         rows=[{'l':{'t':'same','txt':'trigger: SHIPMENT_PLANNED'},'r':{'t':'same','txt':'trigger: SHIPMENT_PLANNED'}},{'l':{'t':'mod','txt':'version: v3.1.0'},'r':{'t':'mod','txt':'version: v3.2.0-beta'}},{'l':{'t':'mod','txt':'model: dwell_rf_v2 (random forest)'},'r':{'t':'mod','txt':'model: dwell_rf_v3 (gradient boost)'}},{'l':{'t':'mod','txt':'confidence threshold: 0.60'},'r':{'t':'mod','txt':'confidence threshold: 0.55'}},{'l':{'t':'same','txt':'read: LOCATION_GID, HISTORICAL_DWELL'},'r':{'t':'same','txt':'read: LOCATION_GID, HISTORICAL_DWELL'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'read: CARRIER_SCORE  (new input feature)'}},{'l':{'t':'same','txt':'write: DWELL_FORECAST, TENDER_HINT'},'r':{'t':'same','txt':'write: DWELL_FORECAST, TENDER_HINT'}}]),
    dict(id='AG-SHIP-TENDERRESP', prod_ver='v1.5.2', test_ver='v1.5.3', insight="v1.5.3 adds carrier performance logging after each response, feeding AG-AI-DWELL's training pipeline.", warning=None, conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: TENDER_RESPONSE_RECEIVED'},'r':{'t':'same','txt':'trigger: TENDER_RESPONSE_RECEIVED'}},{'l':{'t':'mod','txt':'version: v1.5.2'},'r':{'t':'mod','txt':'version: v1.5.3'}},{'l':{'t':'same','txt':'condition: TENDER_RESPONSE in (ACCEPTED, DECLINED)'},'r':{'t':'same','txt':'condition: TENDER_RESPONSE in (ACCEPTED, DECLINED)'}},{'l':{'t':'same','txt':'read: TENDER_STATUS, TENDER_RESPONSE, CARRIER_GID'},'r':{'t':'same','txt':'read: TENDER_STATUS, TENDER_RESPONSE, CARRIER_GID'}},{'l':{'t':'same','txt':'action: updateTenderStatus(TENDER_RESPONSE)'},'r':{'t':'same','txt':'action: updateTenderStatus(TENDER_RESPONSE)'}},{'l':{'t':'same','txt':'action: routeShipment(CARRIER_GID)'},'r':{'t':'same','txt':'action: routeShipment(CARRIER_GID)'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'action: logCarrierPerf(CARRIER_GID, TENDER_RESPONSE)'}},{'l':{'t':'same','txt':'write: SHIPMENT_STATUS'},'r':{'t':'same','txt':'write: SHIPMENT_STATUS'}}]),
    dict(id='AG-SHIP-RETENDER', prod_ver='v2.0.3', test_ver='v2.0.4-draft', insight='v2.0.4-draft bounds the carrier ack timeout with retry(max=2, backoff=5s), preventing unbounded CARRIER_TIMEOUT failures.', warning='TC-04 is currently failing — the bounded retry is not yet effective. Do not promote.', conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: TENDER_DECLINED'},'r':{'t':'same','txt':'trigger: TENDER_DECLINED'}},{'l':{'t':'mod','txt':'version: v2.0.3'},'r':{'t':'mod','txt':'version: v2.0.4-draft'}},{'l':{'t':'same','txt':"condition: TENDER_STATUS = 'DECLINED'"},'r':{'t':'same','txt':"condition: TENDER_STATUS = 'DECLINED'"}},{'l':{'t':'same','txt':'condition: retry_count < 3'},'r':{'t':'same','txt':'condition: retry_count < 3'}},{'l':{'t':'same','txt':'condition: alt_carrier_exists'},'r':{'t':'same','txt':'condition: alt_carrier_exists'}},{'l':{'t':'same','txt':'action: selectNextCarrier()'},'r':{'t':'same','txt':'action: selectNextCarrier()'}},{'l':{'t':'same','txt':'action: sendTender(CARRIER_GID)'},'r':{'t':'same','txt':'action: sendTender(CARRIER_GID)'}},{'l':{'t':'del','txt':'# no timeout handling'},'r':{'t':'none','txt':''}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'action: onTimeout: retry(max=2, backoff=5s) → escalate'}},{'l':{'t':'same','txt':"action: setTenderStatus('RETENDERED')"},'r':{'t':'same','txt':"action: setTenderStatus('RETENDERED')"}},{'l':{'t':'same','txt':'write: TENDER_STATUS, CARRIER_GID'},'r':{'t':'same','txt':'write: TENDER_STATUS, CARRIER_GID'}}]),
    dict(id='AG-SHIP-DOCGEN', prod_ver='v3.1.0', test_ver='v3.1.0', insight='No differences detected — PROD and TEST are identical at v3.1.0.', warning=None, conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: SHIPMENT_CONFIRMED'},'r':{'t':'same','txt':'trigger: SHIPMENT_CONFIRMED'}},{'l':{'t':'same','txt':'version: v3.1.0'},'r':{'t':'same','txt':'version: v3.1.0'}},{'l':{'t':'same','txt':"condition: SHIPMENT.status = 'CONFIRMED'"},'r':{'t':'same','txt':"condition: SHIPMENT.status = 'CONFIRMED'"}},{'l':{'t':'same','txt':'read: SHIPMENT_GID, CARRIER_GID'},'r':{'t':'same','txt':'read: SHIPMENT_GID, CARRIER_GID'}},{'l':{'t':'same','txt':'action: generateBOL(SHIPMENT_GID)'},'r':{'t':'same','txt':'action: generateBOL(SHIPMENT_GID)'}},{'l':{'t':'same','txt':'action: generateLabels(CARRIER_GID)'},'r':{'t':'same','txt':'action: generateLabels(CARRIER_GID)'}},{'l':{'t':'same','txt':'write: DOCUMENT_SET'},'r':{'t':'same','txt':'write: DOCUMENT_SET'}}]),
    dict(id='AG-INV-AUTOAPPROVE', prod_ver='v2.2.1', test_ver='v2.2.2', insight='v2.2.2 widens the tolerance band from $2.00 to $5.00, reducing escalation volume for minor freight adjustments.', warning=None, conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: INVOICE_RECEIVED'},'r':{'t':'same','txt':'trigger: INVOICE_RECEIVED'}},{'l':{'t':'mod','txt':'version: v2.2.1'},'r':{'t':'mod','txt':'version: v2.2.2'}},{'l':{'t':'same','txt':"condition: INVOICE_STATUS = 'RECEIVED'"},'r':{'t':'same','txt':"condition: INVOICE_STATUS = 'RECEIVED'"}},{'l':{'t':'mod','txt':'condition: abs(INVOICE_AMOUNT - RATE_AMOUNT) <= 2.00'},'r':{'t':'mod','txt':'condition: abs(INVOICE_AMOUNT - RATE_AMOUNT) <= 5.00'}},{'l':{'t':'same','txt':'read: INVOICE_AMOUNT, RATE_GID, RATE_AMOUNT'},'r':{'t':'same','txt':'read: INVOICE_AMOUNT, RATE_GID, RATE_AMOUNT'}},{'l':{'t':'same','txt':"action: setInvoiceStatus('APPROVED')"},'r':{'t':'same','txt':"action: setInvoiceStatus('APPROVED')"}},{'l':{'t':'same','txt':'write: INVOICE_STATUS'},'r':{'t':'same','txt':'write: INVOICE_STATUS'}}]),
    dict(id='AG-INV-VARIANCE', prod_ver='v1.1.0', test_ver='v1.1.1', insight='v1.1.1 adds an SLA escalation step and writes SLA_CLOCK_START, ensuring high-variance freight bills are flagged before the 4-hour payment SLA expires.', warning='Review C-003 float rounding conflict before promoting — tolerance boundary duplicates may generate double escalation tickets.', conflict_id='C-003',
         rows=[{'l':{'t':'same','txt':'trigger: INVOICE_RECEIVED'},'r':{'t':'same','txt':'trigger: INVOICE_RECEIVED'}},{'l':{'t':'mod','txt':'version: v1.1.0'},'r':{'t':'mod','txt':'version: v1.1.1'}},{'l':{'t':'same','txt':'condition: abs(FB_AMOUNT - RATE_GEO_COST) > TOLERANCE_BAND'},'r':{'t':'same','txt':'condition: abs(FB_AMOUNT - RATE_GEO_COST) > TOLERANCE_BAND'}},{'l':{'t':'same','txt':'read: FREIGHT_BILL_GID, FB_AMOUNT, RATE_GEO_COST'},'r':{'t':'same','txt':'read: FREIGHT_BILL_GID, FB_AMOUNT, RATE_GEO_COST'}},{'l':{'t':'same','txt':'action: openEscalation(FREIGHT_BILL_GID)'},'r':{'t':'same','txt':'action: openEscalation(FREIGHT_BILL_GID)'}},{'l':{'t':'same','txt':'action: writeTicket(ESCALATION_TICKET_GID)'},'r':{'t':'same','txt':'action: writeTicket(ESCALATION_TICKET_GID)'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'action: escalateToSLA(variance_amount, SLA_HOURS=4)'}},{'l':{'t':'same','txt':'action: notify(d.kim)'},'r':{'t':'same','txt':'action: notify(d.kim, finance-ops@nwl.com)'}},{'l':{'t':'mod','txt':'write: ESCALATION_TICKET, INVOICE_STATUS'},'r':{'t':'mod','txt':'write: ESCALATION_TICKET_GID, INVOICE_STATUS, SLA_CLOCK_START'}}]),
    dict(id='AG-AI-CARRIERRANK', prod_ver='v1.1.2', test_ver='v1.2.0', insight="v1.2.0 reanchors the trigger from ORDER_RELEASED to RATE_APPLIED, eliminating the C-005 null RATE_GID race. Carrier pool minimum raised from 1 to 2, and CLAIM_RATE added as a scoring feature.", warning='Resolve C-005 before promoting — the EVENT trigger change is breaking if AG-ORD-RATESVC is not yet at v4.2.1+ with RATE_APPLIED emission.', conflict_id='C-005',
         rows=[{'l':{'t':'mod','txt':'trigger: ORDER_RELEASED'},'r':{'t':'mod','txt':'trigger: RATE_APPLIED  (resolves C-005)'}},{'l':{'t':'mod','txt':'version: v1.1.2'},'r':{'t':'mod','txt':'version: v1.2.0'}},{'l':{'t':'mod','txt':'condition: CARRIER_POOL.count >= 1'},'r':{'t':'mod','txt':'condition: CARRIER_POOL.count >= 2'}},{'l':{'t':'same','txt':'condition: model.confidence > 0.72'},'r':{'t':'same','txt':'condition: model.confidence > 0.72'}},{'l':{'t':'same','txt':'read: LANE_GID, RATE_GID, HISTORICAL_PERF'},'r':{'t':'same','txt':'read: LANE_GID, RATE_GID, HISTORICAL_PERF'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'read: CLAIM_RATE  (new scoring feature)'}},{'l':{'t':'del','txt':'action: applyDwellPenalty(AVG_DWELL_HRS)'},'r':{'t':'none','txt':''}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'action: applyRiskScore(CLAIM_RATE, AVG_DWELL_HRS)'}},{'l':{'t':'same','txt':'action: emitHint(CARRIER_RANK_HINT, top3)'},'r':{'t':'same','txt':'action: emitHint(CARRIER_RANK_HINT, top3)'}}]),
    dict(id='AG-SHIP-TRACKUPDATE', prod_ver='v2.3.1', test_ver='v2.4.0', insight="v2.4.0 adds SHIPMENT_EXCEPTION event handling with automatic re-ETA computation, and now notifies the customer via both email and in-app push when a delivery exception occurs.", warning=None, conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: SHIPMENT_CONFIRMED'},'r':{'t':'same','txt':'trigger: SHIPMENT_CONFIRMED'}},{'l':{'t':'mod','txt':'version: v2.3.1'},'r':{'t':'mod','txt':'version: v2.4.0'}},{'l':{'t':'same','txt':'action: subscribeToTrackingFeed(CARRIER_GID)'},'r':{'t':'same','txt':'action: subscribeToTrackingFeed(CARRIER_GID)'}},{'l':{'t':'same','txt':'action: mapCarrierStatus(CARRIER_STATUS → OTM_STATUS)'},'r':{'t':'same','txt':'action: mapCarrierStatus(CARRIER_STATUS → OTM_STATUS)'}},{'l':{'t':'same','txt':'action: updateMilestone(MILESTONE_CODE)'},'r':{'t':'same','txt':'action: updateMilestone(MILESTONE_CODE)'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':"action: onException → recomputeETA(DELAY_HOURS)"}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':"action: onException → notifyStakeholders('EXCEPTION', CUSTOMER_GID)"}},{'l':{'t':'same','txt':'write: SHIPMENT_STATUS, MILESTONE_LOG'},'r':{'t':'same','txt':'write: SHIPMENT_STATUS, MILESTONE_LOG, EXCEPTION_LOG'}}]),
    dict(id='AG-INV-FRTAUDIT', prod_ver='v1.0.4', test_ver='v1.0.5', insight="v1.0.5 adds a linhaul vs accessorial split check, catching carriers who reclassify base freight as accessorial charges to avoid contracted rate caps.", warning=None, conflict_id=None,
         rows=[{'l':{'t':'same','txt':'trigger: INVOICE_APPROVED'},'r':{'t':'same','txt':'trigger: INVOICE_APPROVED'}},{'l':{'t':'mod','txt':'version: v1.0.4'},'r':{'t':'mod','txt':'version: v1.0.5'}},{'l':{'t':'same','txt':'action: crossCheckAccessorials(FREIGHT_BILL_GID)'},'r':{'t':'same','txt':'action: crossCheckAccessorials(FREIGHT_BILL_GID)'}},{'l':{'t':'none','txt':''},'r':{'t':'add','txt':'action: validateLineHaulSplit(LINEHAUL_AMT, ACCESSORIAL_AMT)'}},{'l':{'t':'same','txt':'action: verifyFuelSurcharge(FSC_RATE, CARRIER_GID)'},'r':{'t':'same','txt':'action: verifyFuelSurcharge(FSC_RATE, CARRIER_GID)'}},{'l':{'t':'mod','txt':'action: checkDuplicateInvoice(FREIGHT_BILL_GID, DATE_RANGE=60d)'},'r':{'t':'mod','txt':'action: checkDuplicateInvoice(FREIGHT_BILL_GID, DATE_RANGE=90d)'}},{'l':{'t':'same','txt':'action: writeAuditTrail(AUDIT_LOG_GID)'},'r':{'t':'same','txt':'action: writeAuditTrail(AUDIT_LOG_GID)'}}]),
]

agent_tests = [
    dict(id='TC-01', agent_id='AG-SHIP-RETENDER', name='Decline → re-tender to next carrier', expect='TENDER_STATUS = RETENDERED', result='pass', got=None),
    dict(id='TC-02', agent_id='AG-SHIP-RETENDER', name='Decline ×3 → escalate to planner', expect='state = ESCALATED', result='pass', got=None),
    dict(id='TC-03', agent_id='AG-SHIP-RETENDER', name='No alternate carrier available', expect='route → MANUAL_QUEUE', result='pass', got=None),
    dict(id='TC-04', agent_id='AG-SHIP-RETENDER', name='Carrier timeout during re-tender', expect='bounded retry (2×) then escalate', result='fail', got='unbounded wait → CARRIER_TIMEOUT after 30s'),
    dict(id='TC-05', agent_id='AG-SHIP-RETENDER', name='Spot rate exceeds threshold', expect='HOLD_FOR_APPROVAL', result='pass', got=None),
    dict(id='TC-06', agent_id='AG-SHIP-RETENDER', name='Late decline after confirm', expect='event IGNORED', result='pass', got=None),
]


def ensure_schema():
    """Create tables if they don't exist (reads schema.sql)."""
    import pathlib
    schema_path = pathlib.Path(__file__).parent / "schema.sql"
    sql = schema_path.read_text()
    c = conn()
    try:
        with c.cursor() as cur:
            cur.execute(sql)
        c.commit()
        print("Schema ensured.")
    finally:
        c.close()


def seed():
    ensure_schema()
    c = conn()
    try:
        with c.cursor() as cur:
            # clear tables
            cur.execute("TRUNCATE agents, workflow_edges, conflicts, audit_log, jobs, trace_runs, live_events, agent_diffs, agent_tests RESTART IDENTITY CASCADE")

            # agents
            for a in agents:
                cur.execute(
                    "INSERT INTO agents (id,name,domain,type,version,owner,trigger,evt,priority,success,health,gx,gy,conditions,actions,reads,writes) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb)",
                    (a['id'],a['name'],a['domain'],a['type'],a['version'],a['owner'],a['trigger'],a['evt'],a['priority'],a['success'],a['health'],a['gx'],a['gy'],
                     json.dumps(a['conditions']),json.dumps(a['actions']),json.dumps(a['reads']),json.dumps(a['writes']))
                )

            # edges
            for frm, to, etype in flow_edges:
                cur.execute("INSERT INTO workflow_edges (from_agent, to_agent, edge_type) VALUES (%s,%s,%s)", (frm, to, etype))

            # conflicts
            for cf in conflicts:
                cur.execute(
                    "INSERT INTO conflicts (id,severity,event,agent_a,agent_b,detail,fix) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (cf['id'],cf['severity'],cf['event'],cf['agent_a'],cf['agent_b'],cf['detail'],cf['fix'])
                )

            # audit
            for ae in audit_entries:
                cur.execute(
                    "INSERT INTO audit_log (time,username,action,target,env,result,tone,note) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    (ae['time'],ae['username'],ae['action'],ae['target'],ae['env'],ae['result'],ae['tone'],ae.get('note'))
                )

            # jobs
            for j in jobs:
                cur.execute(
                    "INSERT INTO jobs (id,name,cron,last_run,duration,trend,health) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (j['id'],j['name'],j['cron'],j['last_run'],j['duration'],j['trend'],j['health'])
                )

            # traces
            for t in trace_runs:
                cur.execute(
                    "INSERT INTO trace_runs (agent_id,run_id,shipment,env,started,total_ms,status,status_label,steps) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
                    (t['agent_id'],t['run_id'],t['shipment'],t['env'],t['started'],t['total_ms'],t['status'],t['status_label'],json.dumps(t['steps']))
                )

            # live events
            for ev in live_events:
                cur.execute(
                    "INSERT INTO live_events (ts,evt,gid,agent,ms,ok) VALUES (%s,%s,%s,%s,%s,%s)",
                    (ev['ts'],ev['evt'],ev['gid'],ev['agent'],ev['ms'],ev['ok'])
                )

            # agent diffs
            for d in agent_diffs:
                cur.execute(
                    "INSERT INTO agent_diffs (id,prod_ver,test_ver,insight,warning,conflict_id,rows) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb)",
                    (d['id'],d['prod_ver'],d['test_ver'],d['insight'],d.get('warning'),d.get('conflict_id'),json.dumps(d['rows']))
                )

            # tests
            for t in agent_tests:
                cur.execute(
                    "INSERT INTO agent_tests (id,agent_id,name,expect,result,got) VALUES (%s,%s,%s,%s,%s,%s)",
                    (t['id'],t['agent_id'],t['name'],t['expect'],t['result'],t.get('got'))
                )

        c.commit()
        print("Seed complete.")
    finally:
        c.close()


if __name__ == "__main__":
    seed()
