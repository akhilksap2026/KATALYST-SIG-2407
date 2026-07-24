'use strict';
/**
 * Agent Query Engine
 * ------------------
 * Translates a natural-language question into a typed QueryPlan, then
 * executes that plan against real agent data.  No external LLM is called —
 * the "translation" layer fuzzy-matches tokens against the actual vocabulary
 * built from the database at request time, so every result is grounded in
 * real data, not a hallucination.
 *
 * Pipeline:
 *   NL question
 *   → tokenize + segment on conjunctions
 *   → per-segment: intent detection + entity extraction (fuzzy vocab match)
 *   → [FilterSpec, ...]
 *   → executeFilters(agents, reads, writes, actions)
 *   → { queryPlan, matches, explanation, timing }
 */

// ─── Text utilities ───────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had',
  'to','of','in','on','at','for','with','by','from','that','which','who','what',
  'me','i','my','all','every','show','list','find','get','tell','give','display',
  'agents','agent','field','fields','event','events','does','do','can','will',
  'any','some','these','those','there','here','then','than','more','less','most',
  'or','and','but','not','no','yes','its','their','our','your','trigger','triggers',
  'currently','currently','using','used','use','uses','make','makes','made',
]);

function tokenize(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/[\s_\-]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * How similar are two tokens? Returns 0–1.
 * Handles prefix overlap (e.g. "invoic-ing" vs "invoic-e") via a common-prefix
 * length check so stemming variants still score well.
 */
function tokenSimilarity(a, b) {
  if (a === b) return 1.0;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  // Length ratio guard: avoid false positives where a short word accidentally
  // appears as a substring of a much longer, unrelated word (e.g. "rate" ⊂ "generates").
  const ratio = shorter.length / longer.length;
  // One starts with the other
  if (longer.startsWith(shorter) && shorter.length >= 4 && ratio >= 0.45) return 0.85;
  // One is a substring of the other
  if (longer.includes(shorter) && shorter.length >= 4 && ratio >= 0.45) return 0.72;
  // Common prefix of ≥5 chars covers stemming variants ("invoic-e" / "invoic-ing")
  let i = 0;
  while (i < shorter.length && i < longer.length && shorter[i] === longer[i]) i++;
  if (i >= 6) return 0.72;
  if (i >= 5) return 0.58;
  return 0;
}

/**
 * Score how well a set of query tokens matches a structured name (field/event/domain).
 * Returns 0–1.  Considers: exact normalized match, substring, and token intersection.
 * Name parts are split on underscores, hyphens, spaces AND ampersands/slashes so
 * multi-word names like "Invoice & Finance" tokenise correctly.
 */
function matchScore(queryTokens, name) {
  if (!name) return 0;
  const norm      = normalize(name);
  // Split on all common separators including & / ()
  const nameParts = name.split(/[_\s\-&\/()]+/).map(p => p.toLowerCase()).filter(p => p.length > 0);
  const nameSet   = new Set(nameParts);
  const qJoined   = queryTokens.join('');
  const qStr      = queryTokens.join(' ');

  // Exact normalized match
  if (qJoined === norm || qStr.replace(/\s/g,'') === norm) return 1.0;

  // Full substring in either direction
  if (norm.includes(qJoined) && qJoined.length >= 4) return 0.92;
  if (qJoined.includes(norm) && norm.length >= 4)    return 0.88;

  // Token intersection with stemming-variant similarity
  let hits = 0;
  for (const qt of queryTokens) {
    if (nameSet.has(qt)) { hits += 1; continue; }
    let best = 0;
    for (const np of nameParts) {
      if (np.length < 3 && qt.length < 3) continue;
      const sim = tokenSimilarity(qt, np);
      if (sim > best) best = sim;
    }
    hits += best;
  }
  if (hits === 0) return 0;
  const precision = hits / Math.max(queryTokens.length, 1);
  const recall    = hits / Math.max(nameParts.length, 1);
  return Math.min((2 * precision * recall) / (precision + recall + 0.001), 0.98);
}

/**
 * Find the best-matching vocabulary item for a set of tokens.
 * Returns { value, score, matchedAs } or null if score < threshold.
 */
function bestMatch(queryTokens, vocab, threshold = 0.35) {
  let best = null;
  for (const item of vocab) {
    const s = matchScore(queryTokens, item);
    if (s > threshold && (!best || s > best.score))
      best = { value: item, score: s,
               matchedAs: s >= 0.9 ? 'exact' : s >= 0.65 ? 'partial' : 'inferred' };
  }
  return best;
}

// ─── Intent patterns ──────────────────────────────────────────────────────────

const RAISES_RE  = /\b(raise[s]?|emit[s]?|broadcast[s]?|invoke[s]?|dispatch[e]?[s]?|triggers?\s+downstream|triggers?\s+another|fires?\s+downstream)\b/i;
const WRITE_RE   = /\b(write[s]?|output[s]?|set[s]?|update[s]?|emit[s]?|produce[s]?|creat[e]?[s]?|generat[e]?[s]?|output[s]?)\b/i;
const READ_RE    = /\b(read[s]?|consume[s]?|use[s]?|input[s]?|depend[s]?\s+on|require[s]?|need[s]?|access[e]?[s]?|look[s]?\s+at|check[s]?)\b/i;
const EVENT_RE   = /\b(fire[s]?\s+on|trigger[s]?(?:\s+on)?|listen[s]?(?:\s+to)?|respond[s]?\s+to|on\s+event|handle[s]?|react[s]?\s+to|when\s+|subscrib[e]?[s]?)/i;
const EMAIL_RE   = /\b(send[s]?\s+(an?\s+)?email|email[s]?|notify|notification[s]?|alert[s]?|message[s]?)\b/i;
const DOMAIN_RE  = /\b(in\s+(?:the\s+)?|domain:?\s*)([a-z][\w\s]+?)\s*(domain|area|category)?\s*(?:$|\band\b)/i;
const TYPE_RE    = /\b(type[:\s]+|are\s+(?:all\s+)?|only\s+)(rating|shipping|order|ai|notification|invoice|analytics|integration|exception|capacity|compliance)\b/i;
const HEALTH_RE  = /\b(health|broken|degraded|failing|unhealthy|issues|problem[s]?|down|amber|red|green|warning)\b/i;
const OWNER_RE   = /\b(owned?\s+by|owner:?\s*|belong[s]?(?:\s+to)?|assigned\s+to|managed\s+by)\s*([a-z][.\w]+)/i;
const SUCCESS_RE = /\b(success|accuracy|rate|score)\s*(below|under|less\s+than|<|above|over|greater)\s*([\d.]+)\s*%?/i;
const VERSION_RE = /\b(version|v\d|beta|draft|rc|snapshot)\b/i;
const NAME_RE    = /\b(called|named|name[d]?|like|matching|with\s+name)\s+["']?([a-z][\w\s-]+?)["']?(?:\s+|\s*$)/i;

// ─── Segment splitter ─────────────────────────────────────────────────────────
// Splits "X and Y" into two separate clauses for multi-filter queries.
function splitSegments(question) {
  // Split on "and" / "," but NOT inside a field name context
  const segments = question
    .split(/\s+and\s+(?=(?:also\s+)?(?:write|read|fire|trigger|send|in\s+the|are|have|whose|with|on|handle))/i)
    .flatMap(s => s.split(/\s*,\s*(?=[a-z])/));
  return segments.map(s => s.trim()).filter(Boolean);
}

// ─── Filter extraction ────────────────────────────────────────────────────────

function extractFilters(question, vocab) {
  const { fields, readFields, writeFields, events, domains, types, owners,
          raisedEvents = [], actionTypes = [] } = vocab;
  const filters = [];
  const segments = splitSegments(question);

  for (const seg of segments) {
    const toks = tokenize(seg);

    // ── Raises event (downstream invocation) ──────────────────────────────
    if (RAISES_RE.test(seg) && !WRITE_RE.test(seg)) {
      const evtMatch = bestMatch(toks, raisedEvents, 0.28);
      if (evtMatch) {
        filters.push({ type: 'raises_event', value: evtMatch.value, confidence: evtMatch.score,
          matchedAs: evtMatch.matchedAs, label: 'raises event "' + evtMatch.value + '"',
          explanation: 'Agents that raise/invoke event "' + evtMatch.value + '" downstream',
          icon: '⛓', color: 'teal' });
        continue;
      }
      // Match on action type (e.g. "raises internal event", "invokes via RAISE EVENT")
      const atMatch = bestMatch(toks, actionTypes, 0.28);
      if (atMatch) {
        filters.push({ type: 'action_type', value: atMatch.value, confidence: atMatch.score,
          matchedAs: atMatch.matchedAs, label: 'uses action ' + atMatch.value,
          explanation: 'Agents that use the "' + atMatch.value + '" action step',
          icon: '⚙', color: 'gold' });
        continue;
      }
    }

    // ── Email / notification ───────────────────────────────────────────────
    if (EMAIL_RE.test(seg)) {
      // Real action text uses notify*/alert*/message* helpers as well as literal
      // "email" — match any notification-style action, not just the word "email".
      filters.push({ type: 'action_contains', value: 'email|notif|alert|message', confidence: 0.92,
        label: 'action sends a notification', explanation: 'Matches agents that send email / notification / alert actions',
        icon: '✉', color: 'teal' });
      continue;
    }

    // ── Owner ──────────────────────────────────────────────────────────────
    const ownerM = seg.match(OWNER_RE);
    if (ownerM) {
      const candidate = ownerM[2].trim();
      const match = bestMatch(tokenize(candidate), owners, 0.3);
      if (match) {
        filters.push({ type: 'owner', value: match.value, confidence: match.score,
          matchedAs: match.matchedAs, label: 'owner = ' + match.value,
          explanation: 'Agents owned / managed by ' + match.value, icon: '👤', color: 'navy' });
        continue;
      }
    }

    // ── Type ───────────────────────────────────────────────────────────────
    const typeM = seg.match(TYPE_RE);
    if (typeM) {
      const candidate = typeM[2];
      const match = bestMatch(tokenize(candidate), types, 0.3);
      if (match) {
        filters.push({ type: 'agent_type', value: match.value, confidence: match.score,
          matchedAs: match.matchedAs, label: 'type = ' + match.value,
          explanation: 'Only ' + match.value + ' agents', icon: '🏷', color: 'gold' });
        continue;
      }
    }

    // ── Health ────────────────────────────────────────────────────────────
    if (HEALTH_RE.test(seg)) {
      const healthToks = toks.filter(t => ['red','amber','green','broken','degraded','failing','unhealthy','issues','warning'].includes(t));
      const severity = healthToks.find(t => t === 'green') ? 'green'
                     : healthToks.find(t => ['red','broken','failing','down'].includes(t)) ? 'red'
                     : 'not_green';
      filters.push({ type: 'health', value: severity, confidence: 0.88,
        matchedAs: 'inferred', label: severity === 'not_green' ? 'health ≠ green' : 'health = ' + severity,
        explanation: severity === 'not_green' ? 'Agents not in healthy state' : 'Agents with ' + severity + ' health status',
        icon: '❤', color: severity === 'green' ? 'green' : severity === 'red' ? 'red' : 'gold' });
      continue;
    }

    // ── Domain ────────────────────────────────────────────────────────────
    const domainM = seg.match(DOMAIN_RE);
    if (domainM) {
      const candidate = domainM[2].trim();
      const match = bestMatch(tokenize(candidate), domains, 0.3);
      if (match) {
        filters.push({ type: 'domain', value: match.value, confidence: match.score,
          matchedAs: match.matchedAs, label: 'domain = ' + match.value,
          explanation: 'Agents in the ' + match.value + ' domain', icon: '◈', color: 'teal' });
        continue;
      }
    }

    // ── Success rate ──────────────────────────────────────────────────────
    const successM = seg.match(SUCCESS_RE);
    if (successM) {
      const dir = /below|under|less|</.test(successM[2]) ? 'below' : 'above';
      const val = parseFloat(successM[3]);
      if (!isNaN(val)) {
        filters.push({ type: 'success', direction: dir, value: val, confidence: 0.95,
          matchedAs: 'exact', label: 'success ' + (dir === 'below' ? '<' : '>') + ' ' + val + '%',
          explanation: 'Agents with success rate ' + (dir === 'below' ? 'below' : 'above') + ' ' + val + '%',
          icon: '📊', color: dir === 'below' ? 'red' : 'green' });
        continue;
      }
    }

    // ── Version / stage ───────────────────────────────────────────────────
    if (VERSION_RE.test(seg)) {
      const verToks = toks.filter(t => /^v\d/.test(t) || ['beta','draft','rc','snapshot'].includes(t));
      if (verToks.length > 0) {
        filters.push({ type: 'version_contains', value: verToks[0], confidence: 0.85,
          matchedAs: 'partial', label: 'version contains "' + verToks[0] + '"',
          explanation: 'Agents whose version contains "' + verToks[0] + '"', icon: '🔖', color: 'faint' });
        continue;
      }
    }

    // ── Name ──────────────────────────────────────────────────────────────
    const nameM = seg.match(NAME_RE);
    if (nameM) {
      const candidate = nameM[2].trim();
      filters.push({ type: 'name_contains', value: candidate, confidence: 0.82,
        matchedAs: 'partial', label: 'name contains "' + candidate + '"',
        explanation: 'Agent name contains "' + candidate + '"', icon: '🔤', color: 'navy' });
      continue;
    }

    // ── Writes / Reads + field extraction ────────────────────────────────
    const isWrite = WRITE_RE.test(seg);
    const isRead  = READ_RE.test(seg);
    const isEvent = EVENT_RE.test(seg);

    if (isEvent && !isWrite && !isRead) {
      // Try to match an event name
      const evtMatch = bestMatch(toks, events, 0.30);
      if (evtMatch) {
        filters.push({ type: 'evt', value: evtMatch.value, confidence: evtMatch.score,
          matchedAs: evtMatch.matchedAs, label: 'triggers on ' + evtMatch.value,
          explanation: 'Agents that fire when event ' + evtMatch.value + ' occurs', icon: '⚡', color: 'teal' });
        continue;
      }
    }

    // Field-based intent (writes / reads / either)
    const targetFields = isWrite ? writeFields : isRead ? readFields : fields;
    const fieldMatch = bestMatch(toks, Array.from(targetFields), 0.32);

    if (fieldMatch) {
      const filterType = isWrite ? 'writes_field' : isRead ? 'reads_field' : 'touches_field';
      const verb = isWrite ? 'write to' : isRead ? 'read from' : 'read or write';
      filters.push({ type: filterType, field: fieldMatch.value, confidence: fieldMatch.score,
        matchedAs: fieldMatch.matchedAs,
        label: (isWrite ? 'writes' : isRead ? 'reads' : 'touches') + ' ' + fieldMatch.value,
        explanation: 'Agents that ' + verb + ' field "' + fieldMatch.value + '"',
        icon: isWrite ? '✏' : isRead ? '👁' : '⟷', color: isWrite ? 'gold' : 'teal' });
      continue;
    }

    // Fall back: if there's an event-looking token try to match it
    const evtFallback = bestMatch(toks, events, 0.28);
    if (evtFallback) {
      filters.push({ type: 'evt', value: evtFallback.value, confidence: evtFallback.score,
        matchedAs: evtFallback.matchedAs, label: 'triggers on ' + evtFallback.value,
        explanation: 'Agents that fire when event ' + evtFallback.value + ' occurs', icon: '⚡', color: 'teal' });
      continue;
    }

    // No filter extracted for this segment — fall through (will add a low-confidence name search)
    if (toks.length > 0) {
      filters.push({ type: 'name_contains', value: toks.join(' '), confidence: 0.45,
        matchedAs: 'inferred', label: 'name/id contains "' + toks.join(' ') + '"',
        explanation: 'Broad search across agent names and IDs', icon: '🔍', color: 'faint' });
    }
  }

  return filters;
}

// ─── Filter executor ──────────────────────────────────────────────────────────

function testFilter(filter, agent, agentReads, agentWrites, agentActions, agentRaisedEvents) {
  const reads   = (agentReads[agent.id]   || []).map(f => f.toLowerCase());
  const writes  = (agentWrites[agent.id]  || []).map(f => f.toLowerCase());
  const actions = (agentActions[agent.id] || []).join(' ').toLowerCase();
  const raised  = agentRaisedEvents ? (agentRaisedEvents[agent.id] || []) : [];
  const fv      = (v) => (v || '').toLowerCase();

  switch (filter.type) {
    case 'writes_field':
      return writes.some(f => matchScore(tokenize(filter.field), f) >= 0.55);
    case 'reads_field':
      return reads.some(f => matchScore(tokenize(filter.field), f) >= 0.55);
    case 'touches_field':
      return reads.concat(writes).some(f => matchScore(tokenize(filter.field), f) >= 0.55);
    case 'evt':
      return matchScore(tokenize(filter.value), agent.evt) >= 0.50;
    case 'domain':
      return matchScore(tokenize(filter.value), agent.domain) >= 0.40;
    case 'agent_type':
      return matchScore(tokenize(filter.value), agent.type) >= 0.40;
    case 'health':
      if (filter.value === 'not_green') return agent.health !== 'green';
      return (agent.health || '').toLowerCase() === filter.value;
    case 'owner':
      return matchScore(tokenize(filter.value), agent.owner) >= 0.40;
    case 'raises_event':
      return raised.some(ev => matchScore(tokenize(filter.value), ev) >= 0.45);
    case 'action_type':
      return actions.includes(fv(filter.value));
    case 'action_contains':
      // value may be a |-separated list of synonyms (e.g. "email|notif|alert")
      return fv(filter.value).split('|').some(term => term && actions.includes(term));
    case 'success':
      return filter.direction === 'below'
        ? parseFloat(agent.success) < filter.value
        : parseFloat(agent.success) > filter.value;
    case 'version_contains':
      return (agent.version || '').toLowerCase().includes(fv(filter.value));
    case 'name_contains': {
      const hay = (agent.name + ' ' + agent.id).toLowerCase();
      return fv(filter.value).split(/\s+/).some(tok => tok.length > 2 && hay.includes(tok));
    }
    default:
      return false;
  }
}

function getMatchHighlights(filters, agent, agentReads, agentWrites, agentRaisedEvents) {
  const reads   = agentReads[agent.id]  || [];
  const writes  = agentWrites[agent.id] || [];
  const raised  = agentRaisedEvents ? (agentRaisedEvents[agent.id] || []) : [];
  const readMatched  = new Set();
  const writeMatched = new Set();
  const reasons = [];

  for (const f of filters) {
    if (f.type === 'writes_field') {
      writes.filter(w => matchScore(tokenize(f.field), w.toLowerCase()) >= 0.55)
            .forEach(w => { writeMatched.add(w); reasons.push('writes ' + w); });
    } else if (f.type === 'reads_field') {
      reads.filter(r => matchScore(tokenize(f.field), r.toLowerCase()) >= 0.55)
           .forEach(r => { readMatched.add(r); reasons.push('reads ' + r); });
    } else if (f.type === 'touches_field') {
      writes.filter(w => matchScore(tokenize(f.field), w.toLowerCase()) >= 0.55)
            .forEach(w => { writeMatched.add(w); reasons.push('writes ' + w); });
      reads.filter(r => matchScore(tokenize(f.field), r.toLowerCase()) >= 0.55)
           .forEach(r => { readMatched.add(r); reasons.push('reads ' + r); });
    } else if (f.type === 'evt') {
      reasons.push('fires on ' + agent.evt);
    } else if (f.type === 'domain') {
      reasons.push('domain: ' + agent.domain);
    } else if (f.type === 'agent_type') {
      reasons.push('type: ' + agent.type);
    } else if (f.type === 'health') {
      reasons.push('health: ' + agent.health);
    } else if (f.type === 'raises_event') {
      raised.filter(ev => matchScore(tokenize(f.value), ev) >= 0.45)
            .forEach(ev => reasons.push('raises event: ' + ev));
    } else if (f.type === 'action_type') {
      reasons.push('uses action: ' + f.value);
    } else if (f.type === 'action_contains') {
      // f.value may be a |-separated synonym list — render it human-readably.
      const terms = String(f.value).split('|').filter(Boolean);
      reasons.push(terms.length > 1
        ? 'action sends a notification (' + terms.join(' / ') + ')'
        : 'action includes "' + terms[0] + '"');
    } else if (f.type === 'owner') {
      reasons.push('owner: ' + agent.owner);
    } else if (f.type === 'success') {
      reasons.push('success rate: ' + agent.success + '%');
    } else if (f.type === 'version_contains') {
      reasons.push('version: ' + agent.version);
    } else if (f.type === 'name_contains') {
      reasons.push('matched name/id');
    }
  }

  return { readMatched: [...readMatched], writeMatched: [...writeMatched], reasons };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * translate(question, vocab) → { filters, explanation, confidence }
 */
function translate(question, vocab) {
  const filters = extractFilters(question, vocab);
  const avgConf = filters.length
    ? filters.reduce((s, f) => s + f.confidence, 0) / filters.length
    : 0;

  let explanation;
  if (!filters.length) {
    explanation = 'No recognizable intent — showing all agents.';
  } else {
    explanation = filters.map(f => f.explanation).join(', and ');
    explanation = explanation.charAt(0).toUpperCase() + explanation.slice(1) + '.';
  }

  return { filters, explanation, confidence: avgConf };
}

/**
 * execute(filters, data) → { matches }
 * data = { agents, agentReads, agentWrites, agentActions }
 */
function execute(filters, data) {
  const { agents, agentReads, agentWrites, agentActions, agentRaisedEvents = {} } = data;

  const matches = [];
  for (const agent of agents) {
    // All filters must match (AND logic)
    const passes = filters.length === 0 ||
      filters.every(f => testFilter(f, agent, agentReads, agentWrites, agentActions, agentRaisedEvents));
    if (!passes) continue;

    const { readMatched, writeMatched, reasons } =
      getMatchHighlights(filters, agent, agentReads, agentWrites, agentRaisedEvents);
    matches.push({ agent, readMatched, writeMatched, reasons });
  }

  // Sort: most highlights first, then by name
  matches.sort((a, b) =>
    (b.readMatched.length + b.writeMatched.length + b.reasons.length) -
    (a.readMatched.length + a.writeMatched.length + a.reasons.length) ||
    a.agent.name.localeCompare(b.agent.name));

  return { matches };
}

/**
 * buildVocab(agents, reads, writes, actions) → vocab object used by translate()
 */
function buildVocab(agents, reads, writes, actions) {
  // Extract raised event names and action types from action rows for SkyMFG coverage
  const raisedEventsSet = new Set();
  const actionTypesSet  = new Set();
  for (const r of (actions || [])) {
    if (r.action_gid) actionTypesSet.add(r.action_gid);
    if (r.action_params) {
      const m1 = r.action_params.match(/-internalEvent\s+\{([^}]+)\}/);
      if (m1) raisedEventsSet.add(m1[1]);
      const m2 = r.action_params.match(/-customEvent\s+(\S+)/);
      if (m2) raisedEventsSet.add(m2[1]);
    }
  }
  return {
    fields:        [...new Set([...reads, ...writes].map(r => r.field_name))],
    readFields:    new Set(reads.map(r => r.field_name)),
    writeFields:   new Set(writes.map(r => r.field_name)),
    events:        [...new Set(agents.map(a => a.evt).filter(Boolean))],
    domains:       [...new Set(agents.map(a => a.domain).filter(Boolean))],
    types:         [...new Set(agents.map(a => a.type).filter(Boolean))],
    owners:        [...new Set(agents.map(a => a.owner).filter(Boolean))],
    raisedEvents:  [...raisedEventsSet],
    actionTypes:   [...actionTypesSet],
  };
}

module.exports = { translate, execute, buildVocab };
