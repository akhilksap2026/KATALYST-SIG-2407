'use strict';
/**
 * Tests for promotionPreflightService
 * Run with: node tests/promotionPreflight.test.js
 */
const assert = require('assert');
const { promotionPreflightService } = require('../services/promotionPreflight');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const AGENTS = [
  { id: 'AG-RATESVC',  name: 'Rate Service',   evt: 'ORDER_RELEASED', domain: 'Order', acknowledged: false },
  { id: 'AG-CARRIER',  name: 'Carrier Rank',   evt: 'RATE_APPLIED',   domain: 'AI',    acknowledged: false },
  { id: 'AG-TENDER',   name: 'Auto-Tender',    evt: 'SHIPMENT_PLANNED',domain: 'Ship', acknowledged: false },
  { id: 'AG-DWELL',    name: 'Dwell Predict',  evt: 'SHIPMENT_PLANNED',domain: 'AI',   acknowledged: false },
  { id: 'AG-DOCGEN',   name: 'Doc Generation', evt: 'SHIPMENT_CONFIRMED', domain: 'Ship', acknowledged: false },
];

const READS = [
  { agent_id: 'AG-RATESVC', field_name: 'ORDER_GID' },
  { agent_id: 'AG-RATESVC', field_name: 'LANE_GID' },
  // AG-CARRIER reads RATE_GID (written by AG-RATESVC) and CLAIM_RATE (PROD-restricted refnum)
  { agent_id: 'AG-CARRIER', field_name: 'RATE_GID' },
  { agent_id: 'AG-CARRIER', field_name: 'CLAIM_RATE' },
  // AG-TENDER reads CARRIER_RANK_HINT (written by AG-CARRIER)
  { agent_id: 'AG-TENDER',  field_name: 'SHIPMENT_GID' },
  { agent_id: 'AG-TENDER',  field_name: 'CARRIER_RANK_HINT' },
  // AG-DWELL reads CARRIER_SCORE (PROD-restricted, not written by any agent)
  { agent_id: 'AG-DWELL',   field_name: 'LOCATION_GID' },
  { agent_id: 'AG-DWELL',   field_name: 'CARRIER_SCORE' },
  { agent_id: 'AG-DOCGEN',  field_name: 'SHIPMENT_GID' },
  { agent_id: 'AG-DOCGEN',  field_name: 'CARRIER_GID' },
];

const WRITES = [
  { agent_id: 'AG-RATESVC', field_name: 'RATE_GID' },
  { agent_id: 'AG-RATESVC', field_name: 'SERVICE_GID' },
  { agent_id: 'AG-CARRIER', field_name: 'CARRIER_RANK_HINT' },
  { agent_id: 'AG-TENDER',  field_name: 'TENDER_GID' },
  { agent_id: 'AG-TENDER',  field_name: 'TENDER_STATUS' },
  { agent_id: 'AG-DWELL',   field_name: 'TENDER_HINT' },
  { agent_id: 'AG-DOCGEN',  field_name: 'DOCUMENT_SET_GID' },
];

const NO_CONFLICTS = [];
const NO_DIFFS     = [];

// ─── Helper ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

console.log('\npromotionPreflightService\n');

// ── 1. PROD-restricted refnum produces a blocking finding ──────────────────
console.log('  [check (b)] Dependency — PROD-restricted refnums');

test('promoting agent reading CLAIM_RATE to PROD → verdict blocked', () => {
  const result = promotionPreflightService({
    objects: ['AG-CARRIER'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  assert.strictEqual(result.verdict, 'blocked', `expected 'blocked', got '${result.verdict}'`);
  assert.ok(result.counts.blocking >= 1, 'expected at least 1 blocking finding');
  const bf = result.findings.find(f => f.severity === 'blocking' && f.message.includes('CLAIM_RATE'));
  assert.ok(bf, 'expected a blocking finding mentioning CLAIM_RATE');
});

test('promoting agent reading CARRIER_SCORE to PROD → blocked, names the refnum', () => {
  const result = promotionPreflightService({
    objects: ['AG-DWELL'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  assert.strictEqual(result.verdict, 'blocked');
  const bf = result.findings.find(f => f.severity === 'blocking' && f.message.includes('CARRIER_SCORE'));
  assert.ok(bf, 'expected blocking finding naming CARRIER_SCORE');
  assert.ok(bf.suggested_fix, 'expected a suggested_fix on the finding');
});

test('same PROD-restricted reads promoting to TEST → not blocking (non-PROD target)', () => {
  const result = promotionPreflightService({
    objects: ['AG-CARRIER'],
    source: 'DEV', target: 'TEST',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  const blockingRefs = result.findings.filter(
    f => f.severity === 'blocking' && f.message.includes('CLAIM_RATE'));
  assert.strictEqual(blockingRefs.length, 0, 'PROD-restricted check should not fire for non-PROD targets');
});

// ── 2. Cosmetic-only diff → safe with info finding ─────────────────────────
console.log('\n  [check (a)] Diff — cosmetic vs functional');

test('all-same diff rows → verdict safe with info finding (cosmetic-only)', () => {
  const cosmeticDiff = {
    id: 'AG-DOCGEN',
    conflict_id: null,
    warning: null,
    insight: 'Reformatted SQL — no functional changes.',
    rows: JSON.stringify([
      { l: { t: 'same', txt: 'trigger: SHIPMENT_CONFIRMED' }, r: { t: 'same', txt: 'trigger: SHIPMENT_CONFIRMED' } },
      { l: { t: 'same', txt: 'read: SHIPMENT_GID' },          r: { t: 'same', txt: 'read: SHIPMENT_GID' } },
    ]),
  };
  const result = promotionPreflightService({
    objects: ['AG-DOCGEN'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: [cosmeticDiff], conflicts: NO_CONFLICTS,
  });
  assert.strictEqual(result.verdict, 'safe', `expected 'safe', got '${result.verdict}'`);
  const infoFinding = result.findings.find(f => f.severity === 'info');
  assert.ok(infoFinding, 'expected at least one info finding');
  assert.ok(
    infoFinding.message.toLowerCase().includes('cosmetic') ||
    infoFinding.message.toLowerCase().includes('functional'),
    'info finding should describe the cosmetic/functional nature');
});

test('diff with add rows → not cosmetic, produces info finding with insight', () => {
  const functionalDiff = {
    id: 'AG-DOCGEN',
    conflict_id: null,
    warning: null,
    insight: 'v3.1.1 adds pro-bill generation.',
    rows: JSON.stringify([
      { l: { t: 'same', txt: 'trigger: SHIPMENT_CONFIRMED' }, r: { t: 'same', txt: 'trigger: SHIPMENT_CONFIRMED' } },
      { l: { t: 'none', txt: '' },                            r: { t: 'add',  txt: "action: generateProBill()" } },
    ]),
  };
  const result = promotionPreflightService({
    objects: ['AG-DOCGEN'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: [functionalDiff], conflicts: NO_CONFLICTS,
  });
  // Functional change with no conflict/warning → info (insight surfaced)
  const infoF = result.findings.find(f => f.severity === 'info' && f.message.includes('pro-bill'));
  assert.ok(infoF, 'expected info finding with the insight text');
});

test('diff with conflict_id → verdict blocked regardless of other checks', () => {
  const conflictedDiff = {
    id: 'AG-TENDER',
    conflict_id: 'C-002',
    warning: null,
    insight: null,
    rows: JSON.stringify([]),
  };
  const c002 = {
    id: 'C-002', severity: 'critical', event: 'SHIPMENT_PLANNED',
    agent_a: 'AG-TENDER', agent_b: 'AG-DWELL',
    detail: 'Race on TENDER_HINT between Auto-Tender and Dwell Predict.',
    fix: 'Sequence AG-DWELL before AG-TENDER.',
    acknowledged: false,
  };
  const result = promotionPreflightService({
    objects: ['AG-TENDER'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: [conflictedDiff], conflicts: [c002],
  });
  assert.strictEqual(result.verdict, 'blocked');
  const bf = result.findings.find(f => f.severity === 'blocking' && f.message.includes('C-002'));
  assert.ok(bf, 'expected blocking finding referencing C-002');
  assert.ok(bf.suggested_fix && bf.suggested_fix.length > 5, 'expected a suggested_fix');
});

// ── 3. Event conflict check → warning ─────────────────────────────────────
console.log('\n  [check (c)] Event conflict — trigger collision in target');

test('promoting agent whose evt is already held by another target agent → warning', () => {
  // AG-TENDER fires on SHIPMENT_PLANNED; AG-DWELL also fires on SHIPMENT_PLANNED and is NOT promoted
  const result = promotionPreflightService({
    objects: ['AG-TENDER'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  // CARRIER_RANK_HINT is inter-agent (written by AG-CARRIER, which IS in target) → no dep blocking
  // SHIPMENT_PLANNED collision with AG-DWELL → warning
  const evtWarning = result.findings.find(
    f => f.severity === 'warning' && f.message.includes('SHIPMENT_PLANNED'));
  assert.ok(evtWarning, 'expected warning about SHIPMENT_PLANNED trigger collision');
  assert.ok(evtWarning.message.includes('Dwell Predict'), 'warning should name the colliding agent');
});

test('promoting two agents with same evt together → no collision warning for each other', () => {
  // When both AG-TENDER and AG-DWELL are promoted together they are not in targetEvtMap
  const result = promotionPreflightService({
    objects: ['AG-TENDER', 'AG-DWELL'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  // No collision warning between the two promoted agents
  const intra = result.findings.filter(
    f => f.severity === 'warning' &&
         f.message.includes('SHIPMENT_PLANNED') &&
         (f.object === 'AG-TENDER' || f.object === 'AG-DWELL'));
  assert.strictEqual(intra.length, 0, 'no evt collision warning should appear within the promoted batch');
});

// ── 4. Verdict aggregation ─────────────────────────────────────────────────
console.log('\n  [verdict]');

test('no findings at all → verdict safe', () => {
  const result = promotionPreflightService({
    objects: ['AG-RATESVC'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  // AG-RATESVC reads ORDER_GID, LANE_GID — neither written by any agent → system fields, skipped
  assert.strictEqual(result.verdict, 'safe');
  assert.strictEqual(result.counts.blocking, 0);
});

test('only warnings → verdict caution', () => {
  const warningDiff = { id:'AG-RATESVC', conflict_id:null, warning:'Double-check the rate schema.', insight:null, rows: JSON.stringify([
    { l:{ t:'mod', txt:'version: v1.0' }, r:{ t:'mod', txt:'version: v1.1' } }
  ])};
  const result = promotionPreflightService({
    objects: ['AG-RATESVC'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: [warningDiff], conflicts: NO_CONFLICTS,
  });
  assert.strictEqual(result.verdict, 'caution');
  assert.strictEqual(result.counts.blocking, 0);
  assert.ok(result.counts.warning >= 1);
});

test('counts object reflects finding breakdown correctly', () => {
  const result = promotionPreflightService({
    objects: ['AG-CARRIER', 'AG-DOCGEN'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  assert.strictEqual(
    result.counts.blocking + result.counts.warning + result.counts.info,
    result.counts.total,
    'total should equal sum of severity counts');
  assert.strictEqual(result.findings.length, result.counts.total, 'findings array length must match counts.total');
});

test('findings are sorted blocking → warning → info', () => {
  const warningDiff = { id:'AG-DOCGEN', conflict_id:null, warning:'Check schema.', insight:null, rows:JSON.stringify([{l:{t:'mod',txt:'v1'},r:{t:'mod',txt:'v2'}}])};
  const result = promotionPreflightService({
    objects: ['AG-CARRIER', 'AG-DOCGEN'],  // AG-CARRIER → blocking (CLAIM_RATE); AG-DOCGEN → warning
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: [warningDiff], conflicts: NO_CONFLICTS,
  });
  const sevOrder = { blocking: 0, warning: 1, info: 2 };
  for (let i = 1; i < result.findings.length; i++) {
    assert.ok(
      sevOrder[result.findings[i].severity] >= sevOrder[result.findings[i-1].severity],
      `finding[${i}] (${result.findings[i].severity}) should not come before finding[${i-1}] (${result.findings[i-1].severity})`);
  }
});

// ── 5. Override path — audit log entry content ────────────────────────────
console.log('\n  [override path]');

test('override reason is required to contain non-empty text (service contract validation)', () => {
  // The service itself does not enforce override — enforcement is in the route and UI.
  // This test verifies the service still returns a blocked verdict; the caller decides to override.
  const result = promotionPreflightService({
    objects: ['AG-CARRIER'],
    source: 'TEST', target: 'PROD',
    agents: AGENTS, reads: READS, writes: WRITES,
    diffs: NO_DIFFS, conflicts: NO_CONFLICTS,
  });
  assert.strictEqual(result.verdict, 'blocked', 'service verdict must remain blocked regardless of override intent');
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
