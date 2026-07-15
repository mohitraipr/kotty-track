// Assemble a single lot's journey through every production stage, ending at finishing
// dispatch. Pure helpers (no DB) so the ordering/status/dispatch math is unit-tested; the
// route (routes/lotJourneyRoutes.js) supplies the raw per-stage data from *_events via
// utils/stageEvents.getStageAggregates and a finishing_dispatches query.
//
// Stage names match utils/stageEvents.STAGES (plus 'cutting' at the front, which has no
// events table — cutting_lots.created_at is its entry point).

const DAY_MS = 86400000;

const STAGES_BY_FLOW = {
  denim:   ['cutting', 'stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing'],
  hosiery: ['cutting', 'stitching', 'finishing'],
};

// The ordered stage chain for a lot. Unknown/null flow falls back to the hosiery chain
// (mirrors operatorLotTatRoutes, which treats anything non-denim as the short chain).
function orderedStages(flowType) {
  return flowType === 'denim' ? STAGES_BY_FLOW.denim : STAGES_BY_FLOW.hosiery;
}

// Status + elapsed days for one stage given its entry/exit timestamps.
//   not_started: never entered. in_progress: entered, no exit (days counted to `nowMs`).
//   done: entered and exited (days = the span).
function deriveStageStatus({ entered, exited }, nowMs) {
  if (!entered) return { status: 'not_started', days: null };
  const startMs = new Date(entered).getTime();
  if (!exited) {
    return { status: 'in_progress', days: Math.max(0, Math.round((nowMs - startMs) / DAY_MS)) };
  }
  const endMs = new Date(exited).getTime();
  return { status: 'done', days: Math.max(0, Math.round((endMs - startMs) / DAY_MS)) };
}

// Compare finished pieces (per size) to dispatched pieces (per size) so the journey ends
// with how much of the lot has actually left for the warehouse.
function dispatchSummary(finishedBySize, dispatchedBySize) {
  const fin = finishedBySize || {};
  const disp = dispatchedBySize || {};
  const sizes = new Set([...Object.keys(fin), ...Object.keys(disp)]);
  const bySize = {};
  let totalFinished = 0;
  let totalDispatched = 0;
  for (const s of sizes) {
    const finished = Number(fin[s]) || 0;
    const dispatched = Number(disp[s]) || 0;
    bySize[s] = { finished, dispatched, remaining: finished - dispatched };
    totalFinished += finished;
    totalDispatched += dispatched;
  }
  const remaining = totalFinished - totalDispatched;
  return {
    bySize,
    totalFinished,
    totalDispatched,
    remaining,
    complete: totalFinished > 0 && remaining <= 0,
  };
}

// ── Activity feed ──────────────────────────────────────────────────────────
// Every individual update to a lot, across every flow, as one chronological list.
// Sources: lot creation (cutting_lots), every *_events row, every finishing
// dispatch, and every Lot Admin correction (pm_lot_audit_log).

const ACTIVITY_LABEL = {
  created: 'Lot created', approve: 'Taken (approved)', complete: 'Completed', reject: 'Rejected',
};
const ADMIN_ACTION_LABEL = {
  flow_change: 'Flow change', stage_reversal: 'Stage reversal', qty_edit: 'Qty edit',
};

// Human-readable one-liner from a pm_lot_audit_log detail JSON (object or string).
function auditNote(detail) {
  let d = detail;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (_e) { return d; }
  }
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ');
}

// Merge all update sources into one chronological feed. Pure — the route supplies
// the rows. Stable: equal timestamps keep their source/insert order.
//   cutting:     { created_at, by, total_pieces, note }
//   stageEvents: { [stage]: [{ event_type, pieces, remark, created_at, username }] }
//   dispatches:  [{ destination, quantity, size_label, created_at }]
//   audits:      [{ action, detail, performed_by_name, created_at }]
// Returns [{ when, stage, kind, label, pieces, by, note }] sorted ascending.
function mergeActivity({ cutting, stageEvents, dispatches, audits } = {}) {
  const rows = [];
  if (cutting && cutting.created_at) {
    rows.push({
      when: cutting.created_at, stage: 'cutting', kind: 'created', label: ACTIVITY_LABEL.created,
      pieces: cutting.total_pieces != null ? Number(cutting.total_pieces) : null,
      by: cutting.by || null, note: cutting.note || '',
    });
  }
  for (const [stage, events] of Object.entries(stageEvents || {})) {
    for (const e of events || []) {
      if (!e || !e.created_at) continue;
      rows.push({
        when: e.created_at, stage, kind: e.event_type,
        label: ACTIVITY_LABEL[e.event_type] || e.event_type,
        pieces: e.pieces != null ? Number(e.pieces) : null,
        by: e.username || null, note: e.remark || '',
      });
    }
  }
  for (const d of dispatches || []) {
    if (!d || !d.created_at) continue;
    const dest = d.destination || '';
    rows.push({
      when: d.created_at, stage: 'dispatch', kind: 'dispatch', label: 'Dispatched',
      pieces: d.quantity != null ? Number(d.quantity) : null, by: d.by || null,
      note: [dest && `→ ${dest}`, d.size_label && `size ${d.size_label}`].filter(Boolean).join(' · '),
    });
  }
  for (const a of audits || []) {
    if (!a || !a.created_at) continue;
    rows.push({
      when: a.created_at, stage: 'admin', kind: 'admin',
      label: ADMIN_ACTION_LABEL[a.action] || a.action,
      pieces: null, by: a.performed_by_name || null, note: auditNote(a.detail),
    });
  }
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => (new Date(x.r.when).getTime() - new Date(y.r.when).getTime()) || (x.i - y.i))
    .map((x) => x.r);
}

// The stage the lot is sitting at: the first one in progress or not yet started.
// 'Done' when every stage is finished.
function currentStage(timeline) {
  for (const t of timeline || []) {
    if (t.status === 'in_progress' || t.status === 'not_started') return t.stage;
  }
  return 'Done';
}

module.exports = {
  STAGES_BY_FLOW,
  orderedStages,
  deriveStageStatus,
  dispatchSummary,
  currentStage,
  mergeActivity,
  DAY_MS,
};
