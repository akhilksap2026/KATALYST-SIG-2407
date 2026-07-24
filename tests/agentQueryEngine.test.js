'use strict';
/**
 * Tests for services/agentQueryEngine.js
 * Run with: node tests/agentQueryEngine.test.js
 *
 * Covers:
 *   • Every filter type (health, owner, domain, type, event, reads/writes/touches,
 *     success rate, version, name, action/email)
 *   • Known edge cases: OWNER_RE must match "owned by" / "owns"; agent names
 *     containing "&" must tokenise correctly via the & splitter in matchScore
 *   • TMS-domain synonym / stemming coverage (carrier, tender, route, invoice…)
 *   • Multi-clause AND queries (segment splitter)
 *   • translate() output shape + explanation text
 *   • buildVocab() correctness
 *   • Low-confidence broad fallback
 */

const assert = require('assert');
const { translate, execute, buildVocab } = require('../services/agentQueryEngine');

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// A small but representative agent catalogue.  Field names and event names are
// deliberately chosen to exercise stemming and TMS vocabulary.

const AGENTS = [
  // id, name, domain, type, version, owner, trigger (evt), priority, success, health, gx, gy
  { id: 'AG-RATESVC',  name: 'Rate & Service Selection', domain: 'Order',    type: 'Rating',       version: 'v2.1',     owner: 's.patel',    evt: 'ORDER_RELEASED',    priority: 1, success: 97.3, health: 'green'    },
  { id: 'AG-CARRIER',  name: 'AI Carrier Ranking',       domain: 'AI',       type: 'AI',           version: 'v1.4-beta',owner: 'j.nguyen',   evt: 'RATE_APPLIED',      priority: 2, success: 83.1, health: 'amber'    },
  { id: 'AG-TENDER',   name: 'Auto-Tender Dispatch',     domain: 'Shipping', type: 'Shipping',     version: 'v3.0',     owner: 's.patel',    evt: 'SHIPMENT_PLANNED',  priority: 1, success: 91.5, health: 'green'    },
  { id: 'AG-DWELL',    name: 'Dwell Prediction Model',   domain: 'AI',       type: 'AI',           version: 'v1.9-rc',  owner: 'a.kumar',    evt: 'SHIPMENT_PLANNED',  priority: 3, success: 78.4, health: 'red'      },
  { id: 'AG-INVOICE',  name: 'Invoice & Finance Audit',  domain: 'Finance',  type: 'Invoice',      version: 'v2.0',     owner: 'r.chen',     evt: 'FREIGHT_BILL_RECEIVED', priority: 2, success: 99.1, health: 'green' },
  { id: 'AG-CREDITCHK',name: 'Credit Hold Check',        domain: 'Order',    type: 'Compliance',   version: 'v1.1',     owner: 'r.chen',     evt: 'ORDER_RELEASED',    priority: 1, success: 99.8, health: 'green'    },
  { id: 'AG-DOCGEN',   name: 'Document Generation',      domain: 'Shipping', type: 'Shipping',     version: 'v2.3',     owner: 'j.nguyen',   evt: 'SHIPMENT_CONFIRMED',priority: 2, success: 94.0, health: 'green'    },
  { id: 'AG-OFAC',     name: 'OFAC Sanctions Screen',    domain: 'Compliance',type: 'Compliance',  version: 'v1.0-draft',owner: 'm.osei',    evt: 'ORDER_RELEASED',    priority: 1, success: 62.2, health: 'red'      },
];

const READS_RAW = [
  { agent_id: 'AG-RATESVC',   field_name: 'ORDER_GID' },
  { agent_id: 'AG-RATESVC',   field_name: 'LANE_GID' },
  { agent_id: 'AG-CARRIER',   field_name: 'RATE_GID' },
  { agent_id: 'AG-CARRIER',   field_name: 'CARRIER_SCORE' },
  { agent_id: 'AG-TENDER',    field_name: 'CARRIER_RANK_HINT' },
  { agent_id: 'AG-TENDER',    field_name: 'SHIPMENT_GID' },
  { agent_id: 'AG-DWELL',     field_name: 'LOCATION_GID' },
  { agent_id: 'AG-DWELL',     field_name: 'CARRIER_SCORE' },
  { agent_id: 'AG-INVOICE',   field_name: 'FREIGHT_BILL_GID' },
  { agent_id: 'AG-INVOICE',   field_name: 'INVOICE_AMOUNT' },
  { agent_id: 'AG-CREDITCHK', field_name: 'ORDER_GID' },
  { agent_id: 'AG-CREDITCHK', field_name: 'CREDIT_LIMIT' },
  { agent_id: 'AG-DOCGEN',    field_name: 'SHIPMENT_GID' },
  { agent_id: 'AG-DOCGEN',    field_name: 'CARRIER_GID' },
  { agent_id: 'AG-OFAC',      field_name: 'ORDER_GID' },
  { agent_id: 'AG-OFAC',      field_name: 'PARTY_GID' },
];

const WRITES_RAW = [
  { agent_id: 'AG-RATESVC',   field_name: 'RATE_GID' },
  { agent_id: 'AG-RATESVC',   field_name: 'SERVICE_GID' },
  { agent_id: 'AG-CARRIER',   field_name: 'CARRIER_RANK_HINT' },
  { agent_id: 'AG-TENDER',    field_name: 'TENDER_GID' },
  { agent_id: 'AG-TENDER',    field_name: 'TENDER_STATUS' },
  { agent_id: 'AG-DWELL',     field_name: 'DWELL_PREDICTION' },
  { agent_id: 'AG-INVOICE',   field_name: 'INVOICE_STATUS' },
  { agent_id: 'AG-INVOICE',   field_name: 'PAYMENT_FLAG' },
  { agent_id: 'AG-CREDITCHK', field_name: 'CREDIT_HOLD_FLAG' },
  { agent_id: 'AG-DOCGEN',    field_name: 'DOCUMENT_SET_GID' },
  { agent_id: 'AG-OFAC',      field_name: 'SANCTIONS_FLAG' },
];

const ACTIONS_RAW = [
  { agent_id: 'AG-RATESVC',   action_text: 'Select lowest cost rate' },
  { agent_id: 'AG-CARRIER',   action_text: 'Score and rank carrier options' },
  { agent_id: 'AG-CARRIER',   action_text: 'Write CARRIER_RANK_HINT to order' },
  { agent_id: 'AG-TENDER',    action_text: 'Dispatch tender to preferred carrier' },
  { agent_id: 'AG-TENDER',    action_text: 'Send email notification on tender acceptance' },
  { agent_id: 'AG-DWELL',     action_text: 'Predict dwell time at origin' },
  { agent_id: 'AG-INVOICE',   action_text: 'Audit freight invoice for discrepancies' },
  { agent_id: 'AG-INVOICE',   action_text: 'Send email alert on invoice mismatch' },
  { agent_id: 'AG-CREDITCHK', action_text: 'Place credit hold on delinquent accounts' },
  { agent_id: 'AG-DOCGEN',    action_text: 'Generate shipment document set' },
  { agent_id: 'AG-OFAC',      action_text: 'Screen order parties against OFAC list' },
];

// Build vocab + data bundle once
const vocab = buildVocab(AGENTS, READS_RAW, WRITES_RAW, ACTIONS_RAW);

// agentReads / agentWrites / agentActions keyed by agent id (the shape execute() expects)
const agentReads    = {};
const agentWrites   = {};
const agentActions  = {};
for (const r of READS_RAW)   (agentReads[r.agent_id]   ||= []).push(r.field_name);
for (const w of WRITES_RAW)  (agentWrites[w.agent_id]  ||= []).push(w.field_name);
for (const a of ACTIONS_RAW) (agentActions[a.agent_id] ||= []).push(a.action_text);

const DATA = { agents: AGENTS, agentReads, agentWrites, agentActions };

// ─── Test runner ──────────────────────────────────────────────────────────────

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

/** Convenience: run query end-to-end and return matched agent ids */
function query(question) {
  const { filters } = translate(question, vocab);
  const { matches }  = execute(filters, DATA);
  return matches.map(m => m.agent.id);
}

/** Convenience: return translate() output shape for structural assertions */
function plan(question) {
  return translate(question, vocab);
}

// ─── 1. buildVocab ────────────────────────────────────────────────────────────
console.log('\n  [buildVocab]');

test('vocab.fields contains all unique read+write field names', () => {
  const allFields = new Set([...READS_RAW, ...WRITES_RAW].map(r => r.field_name));
  for (const f of allFields) assert.ok(vocab.fields.includes(f), `missing field: ${f}`);
});

test('vocab.readFields only contains fields that appear in reads', () => {
  for (const f of vocab.readFields) {
    assert.ok(READS_RAW.some(r => r.field_name === f), `unexpected readField: ${f}`);
  }
});

test('vocab.writeFields only contains fields that appear in writes', () => {
  for (const f of vocab.writeFields) {
    assert.ok(WRITES_RAW.some(r => r.field_name === f), `unexpected writeField: ${f}`);
  }
});

test('vocab.owners deduplicates correctly', () => {
  const expected = [...new Set(AGENTS.map(a => a.owner))];
  assert.deepStrictEqual([...vocab.owners].sort(), expected.sort());
});

test('vocab.events deduplicates correctly', () => {
  const expected = [...new Set(AGENTS.map(a => a.evt).filter(Boolean))];
  assert.deepStrictEqual([...vocab.events].sort(), expected.sort());
});

// ─── 2. translate() — output shape ───────────────────────────────────────────
console.log('\n  [translate() shape]');

test('translate returns { filters, explanation, confidence }', () => {
  const result = plan('agents that are degraded');
  assert.ok(Array.isArray(result.filters), 'filters must be an array');
  assert.strictEqual(typeof result.explanation, 'string', 'explanation must be a string');
  assert.strictEqual(typeof result.confidence,  'number', 'confidence must be a number');
});

test('empty / unrecognisable query produces zero filters and "showing all agents" explanation', () => {
  const result = plan('xyzzy plugh');
  // Might match nothing or produce a low-confidence name fallback — either way confidence < 0.6
  // The explanation for zero filters should say "No recognizable intent"
  if (result.filters.length === 0) {
    assert.ok(result.explanation.includes('No recognizable'), `got: ${result.explanation}`);
  }
  assert.ok(result.confidence < 0.7, `expected low confidence, got ${result.confidence}`);
});

test('explanation is capitalised and ends with a period', () => {
  const result = plan('degraded agents');
  if (result.filters.length > 0) {
    assert.ok(/^[A-Z]/.test(result.explanation), 'must start with uppercase');
    assert.ok(result.explanation.endsWith('.'), 'must end with period');
  }
});

// ─── 3. Health filter ─────────────────────────────────────────────────────────
console.log('\n  [health filter]');

test('query "degraded agents" returns only non-green agents', () => {
  const ids = query('degraded agents');
  const nonGreen = AGENTS.filter(a => a.health !== 'green').map(a => a.id);
  for (const id of nonGreen) assert.ok(ids.includes(id), `expected ${id} in results`);
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.notStrictEqual(agent.health, 'green', `${id} is green but was returned`);
  }
});

test('query "red health" returns only red-health agents', () => {
  const ids = query('red health');
  const redAgents = AGENTS.filter(a => a.health === 'red').map(a => a.id);
  assert.ok(ids.length > 0, 'should return at least one agent');
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.strictEqual(agent.health, 'red', `${id} is not red`);
  }
  for (const id of redAgents) assert.ok(ids.includes(id), `expected red agent ${id}`);
});

test('query "healthy agents" does not return red or amber agents', () => {
  const ids = query('healthy agents');
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.ok(
      agent.health === 'green' || agent.health == null,
      `${id} has health=${agent.health}, should not be in healthy results`
    );
  }
});

test('"broken agents" returns red-health agents (synonym for red)', () => {
  const ids = query('broken agents');
  assert.ok(ids.length > 0, 'broken query should match something');
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.notStrictEqual(agent.health, 'green');
  }
});

// ─── 4. Owner filter — edge cases ─────────────────────────────────────────────
console.log('\n  [owner filter — edge cases]');

test('"owned by s.patel" returns agents owned by s.patel', () => {
  const ids = query('owned by s.patel');
  const expected = AGENTS.filter(a => a.owner === 's.patel').map(a => a.id);
  assert.ok(expected.length > 0, 'fixture must have s.patel agents');
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"owns" variant — "managed by r.chen" returns r.chen\'s agents', () => {
  const ids = query('managed by r.chen');
  const expected = AGENTS.filter(a => a.owner === 'r.chen').map(a => a.id);
  assert.ok(expected.length > 0, 'fixture must have r.chen agents');
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"belongs to j.nguyen" returns j.nguyen\'s agents', () => {
  const ids = query('belongs to j.nguyen');
  const expected = AGENTS.filter(a => a.owner === 'j.nguyen').map(a => a.id);
  assert.ok(expected.length > 0, 'fixture must have j.nguyen agents');
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"owner: a.kumar" returns a.kumar\'s agents', () => {
  const ids = query('owner: a.kumar');
  const expected = AGENTS.filter(a => a.owner === 'a.kumar').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

// ─── 5. Agent names with "&" ──────────────────────────────────────────────────
console.log('\n  [agent names containing "&"]');

test('"Rate Service Selection" resolves to AG-RATESVC (name contains &)', () => {
  const ids = query('rate service selection');
  assert.ok(ids.includes('AG-RATESVC'), `expected AG-RATESVC, got: ${ids}`);
});

test('"Invoice Finance" resolves to AG-INVOICE (name is "Invoice & Finance Audit")', () => {
  const ids = query('agents named invoice finance audit');
  assert.ok(ids.includes('AG-INVOICE'), `expected AG-INVOICE, got: ${ids}`);
});

// ─── 6. Domain filter ─────────────────────────────────────────────────────────
console.log('\n  [domain filter]');

test('"in the Finance domain" returns only Finance agents', () => {
  const ids = query('in the Finance domain');
  const expected = AGENTS.filter(a => a.domain === 'Finance').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id));
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.strictEqual(agent.domain, 'Finance', `${id} is not in Finance domain`);
  }
});

test('"AI domain" returns only AI-domain agents', () => {
  const ids = query('in the AI domain');
  const expected = AGENTS.filter(a => a.domain === 'AI').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id));
});

// ─── 7. Type filter ───────────────────────────────────────────────────────────
console.log('\n  [type filter]');

test('"only compliance agents" returns Compliance-type agents', () => {
  const ids = query('only compliance agents');
  const expected = AGENTS.filter(a => a.type === 'Compliance').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id));
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.strictEqual(agent.type, 'Compliance');
  }
});

test('"are shipping type" returns Shipping-type agents', () => {
  const ids = query('are shipping type');
  const expected = AGENTS.filter(a => a.type === 'Shipping').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id));
});

// ─── 8. Event / trigger filter ────────────────────────────────────────────────
console.log('\n  [event/trigger filter]');

test('"triggers on ORDER_RELEASED" returns all ORDER_RELEASED agents', () => {
  const ids = query('triggers on ORDER_RELEASED');
  const expected = AGENTS.filter(a => a.evt === 'ORDER_RELEASED').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"fires when SHIPMENT_PLANNED" returns SHIPMENT_PLANNED agents', () => {
  const ids = query('fires when SHIPMENT_PLANNED');
  const expected = AGENTS.filter(a => a.evt === 'SHIPMENT_PLANNED').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"listen to FREIGHT_BILL_RECEIVED" returns AG-INVOICE', () => {
  const ids = query('listen to FREIGHT_BILL_RECEIVED');
  assert.ok(ids.includes('AG-INVOICE'), `expected AG-INVOICE, got: ${ids}`);
});

// ─── 9. Writes / reads / touches field ────────────────────────────────────────
console.log('\n  [reads/writes/touches field]');

test('"writes TENDER_STATUS" returns AG-TENDER', () => {
  const ids = query('writes TENDER_STATUS');
  assert.ok(ids.includes('AG-TENDER'), `expected AG-TENDER, got: ${ids}`);
});

test('"outputs CARRIER_RANK_HINT" (synonym for writes) returns AG-CARRIER', () => {
  const ids = query('outputs CARRIER_RANK_HINT');
  assert.ok(ids.includes('AG-CARRIER'), `expected AG-CARRIER, got: ${ids}`);
});

test('"reads CARRIER_SCORE" returns agents that read CARRIER_SCORE', () => {
  const ids = query('reads CARRIER_SCORE');
  const expected = READS_RAW.filter(r => r.field_name === 'CARRIER_SCORE').map(r => r.agent_id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"consumes ORDER_GID" (synonym for reads) matches ORDER_GID readers', () => {
  const ids = query('consumes ORDER_GID');
  const expected = READS_RAW.filter(r => r.field_name === 'ORDER_GID').map(r => r.agent_id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"depends on CREDIT_LIMIT" returns AG-CREDITCHK', () => {
  const ids = query('depends on CREDIT_LIMIT');
  assert.ok(ids.includes('AG-CREDITCHK'), `expected AG-CREDITCHK, got: ${ids}`);
});

test('"touches INVOICE_AMOUNT" returns agents reading or writing it', () => {
  const ids = query('touches INVOICE_AMOUNT');
  const allIds = new Set([
    ...READS_RAW.filter(r => r.field_name === 'INVOICE_AMOUNT').map(r => r.agent_id),
    ...WRITES_RAW.filter(r => r.field_name === 'INVOICE_AMOUNT').map(r => r.agent_id),
  ]);
  assert.ok(allIds.size > 0);
  for (const id of allIds) assert.ok(ids.includes(id), `expected ${id}`);
});

// ─── 10. Email / notification action ─────────────────────────────────────────
console.log('\n  [email/notification action]');

test('"send email" returns agents with email actions', () => {
  const ids = query('send email');
  const expected = AGENTS
    .filter(a => (agentActions[a.id] || []).some(t => t.toLowerCase().includes('email')))
    .map(a => a.id);
  assert.ok(expected.length > 0, 'fixture must have email-action agents');
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"sends notification" returns agents with email-type actions', () => {
  const ids = query('sends notification');
  assert.ok(ids.length > 0, 'should match at least one notifying agent');
});

test('notification filter matches notify/alert-style actions, not just literal "email"', () => {
  // AG-CREDITCHK's action is "Place credit hold..." — swap in a notify-style
  // action fixture on a throwaway copy to prove synonym matching works.
  const acts = { ...agentActions, 'AG-OFAC': ['alertCompliance(ORDER_GID, SANCTIONS_HIT)'] };
  const { filters } = translate('send email', vocab);
  const { matches } = execute(filters, { agents: AGENTS, agentReads, agentWrites, agentActions: acts });
  assert.ok(matches.some(m => m.agent.id === 'AG-OFAC'), 'alert* action should match notification query');
});

test('match reasons never leak raw "|" synonym syntax to the UI', () => {
  const { filters } = translate('send email', vocab);
  const { matches } = execute(filters, DATA);
  assert.ok(matches.length > 0);
  for (const m of matches) {
    for (const reason of m.reasons) {
      assert.ok(!/"[^"]*\|[^"]*"/.test(reason), `raw | syntax leaked in reason: ${reason}`);
    }
  }
});

// ─── 11. Success rate filter ──────────────────────────────────────────────────
console.log('\n  [success rate filter]');

test('"success below 85%" returns only low-success agents', () => {
  const ids = query('success below 85%');
  const expected = AGENTS.filter(a => parseFloat(a.success) < 85).map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.ok(parseFloat(agent.success) < 85, `${id} has success=${agent.success}`);
  }
});

test('"accuracy above 95" returns only high-success agents', () => {
  const ids = query('accuracy above 95');
  assert.ok(ids.length > 0, 'should match high-success agents');
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.ok(parseFloat(agent.success) > 95, `${id} has success=${agent.success}`);
  }
});

// ─── 12. Version filter ───────────────────────────────────────────────────────
console.log('\n  [version filter]');

test('"beta version" returns only beta-version agents', () => {
  const ids = query('beta version');
  const expected = AGENTS.filter(a => (a.version || '').toLowerCase().includes('beta')).map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"draft agents" returns agents with draft in version', () => {
  const ids = query('draft agents');
  const expected = AGENTS.filter(a => (a.version || '').toLowerCase().includes('draft')).map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

// ─── 13. Name filter ──────────────────────────────────────────────────────────
console.log('\n  [name filter]');

test('"named Credit Hold Check" returns AG-CREDITCHK', () => {
  const ids = query('named Credit Hold Check');
  assert.ok(ids.includes('AG-CREDITCHK'), `expected AG-CREDITCHK, got: ${ids}`);
});

test('"called OFAC" returns AG-OFAC', () => {
  const ids = query('called OFAC');
  assert.ok(ids.includes('AG-OFAC'), `expected AG-OFAC, got: ${ids}`);
});

// ─── 14. Multi-filter AND logic ───────────────────────────────────────────────
console.log('\n  [multi-filter AND logic]');

test('health + owner AND logic: "degraded agents and are owned by j.nguyen"', () => {
  // The segment splitter splits on "and are", producing two separate clauses:
  //   clause 1 → health filter (not_green)
  //   clause 2 → owner filter (j.nguyen)
  // Both must hold simultaneously (AND).
  const ids = query('degraded agents and are owned by j.nguyen');
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.notStrictEqual(agent.health, 'green', `${id} is green`);
    assert.strictEqual(agent.owner, 'j.nguyen', `${id} not owned by j.nguyen`);
  }
  // AG-CARRIER: amber, owner j.nguyen — must appear
  assert.ok(ids.includes('AG-CARRIER'), 'expected AG-CARRIER');
  // AG-DOCGEN: green, owner j.nguyen — must NOT appear
  assert.ok(!ids.includes('AG-DOCGEN'), 'AG-DOCGEN is green, should not appear');
});

test('success + domain: "AI domain agents with success below 90"', () => {
  const ids = query('in the AI domain agents with success below 90');
  for (const id of ids) {
    const agent = AGENTS.find(a => a.id === id);
    assert.strictEqual(agent.domain, 'AI');
    assert.ok(parseFloat(agent.success) < 90);
  }
  assert.ok(ids.includes('AG-DWELL'), 'AG-DWELL is AI + success 78.4');
});

// ─── 15. TMS synonym / stemming coverage ─────────────────────────────────────
console.log('\n  [TMS synonym & stemming]');

test('"carrier ranking" resolves to AG-CARRIER (prefix stemming)', () => {
  const ids = query('carrier ranking');
  assert.ok(ids.includes('AG-CARRIER'), `expected AG-CARRIER, got: ${ids}`);
});

test('"tender dispatch" resolves to AG-TENDER', () => {
  const ids = query('tender dispatch');
  assert.ok(ids.includes('AG-TENDER'), `expected AG-TENDER, got: ${ids}`);
});

test('"invoicing" resolves to AG-INVOICE (stemming via common prefix)', () => {
  const ids = query('invoicing');
  assert.ok(ids.includes('AG-INVOICE'), `expected AG-INVOICE, got: ${ids}`);
});

test('"shipment confirmation event" resolves to SHIPMENT_CONFIRMED listeners', () => {
  const ids = query('respond to shipment confirmation');
  const expected = AGENTS.filter(a => a.evt === 'SHIPMENT_CONFIRMED').map(a => a.id);
  assert.ok(expected.length > 0);
  for (const id of expected) assert.ok(ids.includes(id), `expected ${id}`);
});

test('"generates documents" matches agents that write document fields', () => {
  // "generates" is a WRITE synonym; DOCUMENT_SET_GID is a write field of AG-DOCGEN
  const ids = query('generates documents');
  assert.ok(ids.includes('AG-DOCGEN'), `expected AG-DOCGEN, got: ${ids}`);
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
