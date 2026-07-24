'use strict';
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, Table, TableRow, TableCell, WidthType,
  BorderStyle, ShadingType, PageBreak,
  convertInchesToTwip, UnderlineType,
} = require('docx');
const fs = require('fs');

// ── Palette
const TEAL   = '1A56DB';
const NAVY   = '0F2A63';
const GOLD   = 'B45309';
const SLATE  = '334155';
const MID    = '64748B';
const BORDER = 'CBD5E1';
const WHITE  = 'FFFFFF';
const GREEN  = '059669';
const PURPLE = '7C3AED';
const LIGHT  = 'EFF6FF';
const NAVY_L = '1E3A8A';

// ── Helpers
function noBorder() {
  const s = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: s, bottom: s, left: s, right: s, insideH: s, insideV: s };
}
function thinBorder(color) {
  const s = { style: BorderStyle.SINGLE, size: 4, color: color || BORDER };
  return { top: s, bottom: s, left: s, right: s };
}
function cell(children, opts) {
  opts = opts || {};
  return new TableCell(Object.assign({
    margins: { top: 120, bottom: 120, left: 160, right: 160 },
    children: children,
  }, opts));
}
function shadedCell(color, children, extraOpts) {
  return cell(children, Object.assign({
    shading: { type: ShadingType.SOLID, color: color, fill: color },
    borders: thinBorder(color),
  }, extraOpts || {}));
}
function p(runs, opts) {
  return new Paragraph(Object.assign({ children: Array.isArray(runs) ? runs : [runs] }, opts || {}));
}
function t(text, opts) {
  return new TextRun(Object.assign({ text: text, font: 'Calibri' }, opts || {}));
}
function space(pts) {
  return new Paragraph({ children: [], spacing: { after: (pts || 6) * 20 } });
}
function hr(color) {
  return new Paragraph({
    children: [],
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: color || BORDER, space: 4 } },
    spacing: { after: 0 },
  });
}
function fullTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorder(),
    rows: rows,
  });
}

// ── Capability row
function capRow(icon, title, desc) {
  return new TableRow({ children: [
    cell([p([t(icon, { size: 24 })])], {
      width: { size: 5, type: WidthType.PERCENTAGE },
      borders: thinBorder(BORDER),
      verticalAlign: 'center',
    }),
    cell([
      p([t(title, { bold: true, color: NAVY, size: 20 })]),
      p([t(desc, { color: SLATE, size: 17 })], { spacing: { before: 40 } }),
    ], {
      width: { size: 95, type: WidthType.PERCENTAGE },
      borders: thinBorder(BORDER),
    }),
  ]});
}

// ── Module card
function modCard(title, tagline, bullets, color) {
  color = color || TEAL;
  var items = bullets.map(function(b) {
    return p([t('\u2022 ' + b, { color: SLATE, size: 17 })], { spacing: { before: 20 } });
  });
  return cell([
    p([t(title, { bold: true, color: color, size: 19 })]),
    p([t(tagline, { color: MID, size: 17, italics: true })], { spacing: { before: 30, after: 40 } }),
  ].concat(items), {
    borders: thinBorder(BORDER),
    width: { size: 50, type: WidthType.PERCENTAGE },
  });
}

// ── Stat cell
function statCell(num, label, color) {
  color = color || TEAL;
  return shadedCell(LIGHT, [
    p([t(num, { bold: true, size: 40, color: color })], { alignment: AlignmentType.CENTER }),
    p([t(label, { size: 16, color: SLATE })], { alignment: AlignmentType.CENTER, spacing: { before: 40 } }),
  ], { width: { size: 25, type: WidthType.PERCENTAGE } });
}

// ── Spec cell
function specCell(heading, lines) {
  var children = [p([t(heading, { bold: true, color: NAVY, size: 18 })])];
  lines.forEach(function(l) {
    children.push(p([t(l, { size: 17, color: SLATE })], { spacing: { before: 24 } }));
  });
  return cell(children, {
    borders: thinBorder(BORDER),
    width: { size: 33, type: WidthType.PERCENTAGE },
  });
}

// ════════════════════════════════════════════════════
// BUILD DOCUMENT
// ════════════════════════════════════════════════════
var doc = new Document({
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 18, color: SLATE } },
    },
  },
  sections: [{
    properties: {
      page: { margin: { top: 720, bottom: 720, left: 864, right: 864 } },
    },
    children: [

      // ══ PAGE 1 ══════════════════════════════════════

      // Hero banner
      fullTable([new TableRow({ children: [
        shadedCell(NAVY, [
          p([t('KATALYST', { bold: true, size: 72, color: WHITE })],
            { alignment: AlignmentType.LEFT, spacing: { before: 80 } }),
          p([t('OTM Agent Intelligence Platform', { size: 28, color: '93C5FD' })],
            { alignment: AlignmentType.LEFT }),
          p([t('End-to-end visibility, governance, and automation for Oracle Transportation Management agent networks',
            { size: 19, color: 'CBD5E1' })],
            { alignment: AlignmentType.LEFT, spacing: { before: 60, after: 100 } }),
        ], { width: { size: 100, type: WidthType.PERCENTAGE } }),
      ]})]),

      space(10),

      // Pull quote
      p([t('\u201cKatalyst transforms black-box OTM agent orchestration into a fully observable, governable, and intelligent control plane \u2014 giving logistics operations teams the visibility they have never had before.\u201d',
        { italics: true, color: NAVY_L, size: 20 })],
        { alignment: AlignmentType.CENTER, spacing: { after: 200 } }),

      hr(TEAL),
      space(6),

      // What is Katalyst
      p([t('WHAT IS KATALYST?', { bold: true, size: 22, color: TEAL, allCaps: true })],
        { spacing: { after: 100 } }),

      p([t('Modern logistics operations run on Oracle Transportation Management (OTM), but the agent automation layer powering those operations has always been invisible. Katalyst is a purpose-built intelligence dashboard that exposes every OTM agent \u2014 its logic, its dependencies, its health, and its change history \u2014 through a single unified interface.',
        { size: 18, color: SLATE })],
        { spacing: { after: 100 } }),

      p([t('Deployed against any OTM 26B+ tenant, Katalyst ingests your agent network and delivers real-time dependency graphs, environment promotion tooling, AI agent monitoring, event conflict detection, impact analysis, and natural-language agent discovery. It is the operating system for your OTM automation.',
        { size: 18, color: SLATE })],
        { spacing: { after: 220 } }),

      // Stats bar
      fullTable([new TableRow({ children: [
        statCell('160+', 'Agents monitored', TEAL),
        statCell('6',    'Link types tracked', NAVY),
        statCell('3',    'Environment tiers', GOLD),
        statCell('5',    'Impact depth (BFS)', GREEN),
      ]})]),

      space(12),
      hr(BORDER),
      space(8),

      // Core Capabilities
      p([t('CORE CAPABILITIES', { bold: true, size: 22, color: TEAL, allCaps: true })],
        { spacing: { after: 120 } }),

      fullTable([
        capRow('\uD83D\uDDD8', 'Agent Dependency Graph',
          'Interactive spider-web map of every causal, delegation, status-chain, peer, and shared-system link across your agent network. Six color-coded edge types, BFS layer layout, domain section headers, and always-on event-label pills. Hover to trace propagation; click to open any agent.'),
        capRow('\uD83D\uDD2C', 'Agent Inspector & Workbench',
          'Full read/write view of agent logic \u2014 trigger events, normal flow, error flow, data reads/writes, cross-references, and live dependency panel. Edit, compare versions, and initiate environment promotion from a single pane of glass.'),
        capRow('\uD83D\uDE80', 'Environment Promotion',
          'Formal DEV \u2192 TEST \u2192 PROD promotion workflow with three-step wizard, pre-flight safety verdict (Allow / Block), step-aligned change diff, orphan detection, and force-promote override for authorized Prod-Admin roles.'),
        capRow('\uD83D\uDCA5', 'Impact Analysis \u2014 Blast Radius',
          'BFS-powered downstream and upstream impact chain up to depth 5. Before any change ships, know exactly which agents \u2014 and which business processes \u2014 will be affected. Rendered as an interactive right-drawer with chip-based agent cards.'),
        capRow('\uD83E\uDD16', 'AI Agent Monitoring',
          'Native support for inference-driven agents (Dwell Prediction, Carrier Ranking). Track model name, confidence scores, last-run statistics, data ops, and prediction outputs alongside deterministic agents in the same workbench.'),
        capRow('\u26A1', 'Event Conflict Detection',
          'Automatic identification of race conditions and priority conflicts across OTM trigger events. Sequence diagrams, priority fix panels, and gate modals guide operators through resolution without requiring OTM admin access.'),
      ]),

      space(6),

      // Page break
      new Paragraph({ children: [new PageBreak()] }),

      // ══ PAGE 2 ══════════════════════════════════════

      p([t('PLATFORM MODULES', { bold: true, size: 22, color: TEAL, allCaps: true })],
        { spacing: { after: 120 } }),

      fullTable([
        new TableRow({ children: [
          modCard('Command Center', 'Real-time operations at a glance', [
            'Order-to-cash pipeline conversion metrics by stage',
            'Domain promotion status across DEV / TEST / PROD',
            'OTM event queue depth and elevated process alerts',
            'Runtime health heat-map across all 160+ agents',
          ], TEAL),
          modCard('OTM Process Monitor', 'Background job observability', [
            'Live status of every OTM background process master',
            'Duration trends and missed-schedule detection',
            'Failed / degraded process triage with timestamps',
            'Drill-through to process-level metrics in one click',
          ], NAVY),
        ]}),
        new TableRow({ children: [
          modCard('Promotion Diff & Compare', 'Safe, auditable change management', [
            'Side-by-side agent comparison across environments',
            'Step-aligned diff with dependency and orphan warnings',
            'Time-travel axis: compare any two historical snapshots',
            'Downloadable diff report for change-advisory board',
          ], GOLD),
          modCard('Execution Replay', 'Root-cause debugging in seconds', [
            'Step-by-step playback of any agent execution path',
            'Visual trace of branching decisions (normal / error)',
            'Timestamp and duration overlay per action step',
            'Shareable replay link for cross-team collaboration',
          ], GREEN),
        ]}),
        new TableRow({ children: [
          modCard('Data Dictionary & Lineage', 'Field-level data governance', [
            'OTM schema reads and writes tracked per agent',
            'Cross-reference: which agents touch the same fields',
            'Coverage map of OTM tables across agent population',
            'Export to Draw.io, Visio, or stakeholder Doc Pack',
          ], PURPLE),
          modCard('Platform Admin & Governance', 'Enterprise access control', [
            'RBAC with role assignment per environment tier',
            'SSO configuration and rotatable API key management',
            'Tamper-evident audit log for all platform actions',
            'Agent import tooling and global configuration panel',
          ], SLATE),
        ]}),
      ]),

      space(12),
      hr(TEAL),
      space(8),

      // SkyMFG callout
      fullTable([new TableRow({ children: [
        shadedCell(LIGHT, [
          p([
            t('SkyMFG Manufacturing Suite  ', { bold: true, size: 21, color: NAVY }),
            t('\u2014 Tenant-Partitioned Intelligence', { size: 20, color: MID, italics: true }),
          ]),
          space(4),
          p([t('Katalyst ships with a fully partitioned module for manufacturing and logistics tenants running SkyMFG on OTM 26B. The suite delivers a layered dependency graph (Causal / +Systems / All tiers), domain-grouped agent cards with link-count badges and health-status dots, always-on event-label edge pills, and an agent workbench with embedded dependency panels \u2014 all isolated from the core OTM agent namespace. Hub agents (those with three or more causal connections) are automatically identified and badged for prioritised monitoring.',
            { size: 17, color: SLATE })]),
        ], {
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top:    { style: BorderStyle.SINGLE, size: 16, color: TEAL },
            bottom: { style: BorderStyle.SINGLE, size:  4, color: BORDER },
            left:   { style: BorderStyle.SINGLE, size:  4, color: BORDER },
            right:  { style: BorderStyle.SINGLE, size:  4, color: BORDER },
          },
        }),
      ]})]),

      space(12),
      hr(BORDER),
      space(8),

      // Technical Specs
      p([t('TECHNICAL SPECIFICATIONS', { bold: true, size: 22, color: TEAL, allCaps: true })],
        { spacing: { after: 120 } }),

      fullTable([new TableRow({ children: [
        specCell('Deployment & Infrastructure', [
          'Node.js / Express API server',
          'PostgreSQL 15+ relational store',
          'OTM 26B+ tenant required',
          'Multi-tenant namespace isolation',
          'Session-less \u2014 integrates with SSO',
        ]),
        specCell('Agent Graph Engine', [
          '6 link types fully modelled',
          'RAISES_EVENT \u00b7 FOR_EACH_DELEGATES',
          'WRAPPER_DELEGATES \u00b7 STATUS_CHAIN',
          'EXECUTION_PEER \u00b7 SHARED_EXTERNAL_SYSTEM',
          'BFS impact traversal to depth 5',
        ]),
        specCell('Integrations & Export', [
          'Draw.io XML workflow export',
          'Visio .vdx diagram export',
          'Stakeholder Doc Pack generation',
          'REST API with 2-min TTL cache',
          'NL query engine (token similarity)',
        ]),
      ]})]),

      space(14),

      // CTA
      fullTable([new TableRow({ children: [
        shadedCell(NAVY, [
          p([t('Ready to see your agent network clearly?', { bold: true, size: 26, color: WHITE })],
            { alignment: AlignmentType.CENTER, spacing: { before: 80 } }),
          p([t('Contact your OTM implementation partner to schedule a Katalyst deployment assessment and live demo.',
            { size: 19, color: '93C5FD' })],
            { alignment: AlignmentType.CENTER, spacing: { before: 60 } }),
          p([t('katalyst.ksap.io  \u00b7  enterprise@ksap.io  \u00b7  OTM 26B+ compatible',
            { size: 17, color: 'BFDBFE', italics: true })],
            { alignment: AlignmentType.CENTER, spacing: { before: 40, after: 80 } }),
        ], { width: { size: 100, type: WidthType.PERCENTAGE } }),
      ]})]),

    ],
  }],
});

Packer.toBuffer(doc).then(function(buf) {
  fs.writeFileSync('attached_assets/Katalyst_Marketing_Brief.docx', buf);
  console.log('OK bytes=' + buf.length);
}).catch(function(e) {
  console.error('ERR', e.message);
  process.exit(1);
});
