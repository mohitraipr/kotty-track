/**
 * Lot journey data builders — shared by the operator lot-journey screen
 * (routes/lotJourneyRoutes.js) and the read-only lot viewer (routes/lotViewerRoutes.js).
 * Pure data assembly from *_events / cutting_lots / finishing_dispatches /
 * pm_lot_audit_log; no Express here.
 *
 * Timing/master come from *_events (the truth source), piece tallies from
 * utils/stageEvents.getStageAggregates, and the final step from finishing_dispatches.
 * Pure ordering/status/dispatch math lives in utils/lotJourney.js (unit-tested).
 */

const { pool } = require('../config/db');
const stageEvents = require('./stageEvents');
const {
  orderedStages, deriveStageStatus, dispatchSummary, currentStage, mergeActivity,
} = require('./lotJourney');

const TAT_DAYS = { cutting: 3, stitching: 7, jeans_assembly: 7, washing: 15, washing_in: 7, finishing: 7 };
const STAGE_LABEL = {
  cutting: 'Cutting', stitching: 'Stitching', jeans_assembly: 'Jeans Assembly',
  washing: 'Washing', washing_in: 'Washing-In', finishing: 'Finishing',
};

const EVENT_TABLE = {
  stitching: 'stitching_events', jeans_assembly: 'jeans_assembly_events',
  washing: 'washing_events', washing_in: 'washing_in_events', finishing: 'finishing_events',
};

// Resolve the best-matching lot for a free-text query: exact lot_no / manual_lot_number
// win, otherwise the most recent LIKE match across lot_no / manual_lot_number / sku.
async function resolveLot(q) {
  const exact = q.trim();
  const like = `%${exact}%`;
  const [rows] = await pool.query(
    `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.flow_type,
            cl.remark, cl.created_at, cl.manual_cutting_date, cl.user_id AS cutter_id, u.username AS cutter_name
       FROM cutting_lots cl
  LEFT JOIN users u ON u.id = cl.user_id
      WHERE cl.lot_no = ? OR cl.manual_lot_number = ?
            OR cl.lot_no LIKE ? OR cl.manual_lot_number LIKE ? OR cl.sku LIKE ?
   ORDER BY (cl.lot_no = ?) DESC, (cl.manual_lot_number = ?) DESC, cl.created_at DESC
      LIMIT 25`,
    [exact, exact, like, like, like, exact, exact]
  );
  return rows;
}

// Timing + accountable master for one stage from its events table.
async function stageTiming(table, lotId) {
  const [rows] = await pool.query(
    `SELECT e.event_type, e.created_at, e.manual_date, u.username
       FROM \`${table}\` e LEFT JOIN users u ON u.id = e.operator_id
      WHERE e.cutting_lot_id = ? ORDER BY e.created_at`,
    [lotId]
  );
  let entered = null; let completedAt = null; let master = null;
  for (const r of rows) {
    // Effective date: the user-declared floor date wins over the upload time.
    // Manual dates can be out of created_at order, so min/max explicitly.
    // Master stays "first approver by entry order" — accountability tracks who acted.
    const eff = r.manual_date || r.created_at;
    if (!entered || new Date(eff) < new Date(entered)) entered = eff;
    if (r.event_type === 'complete' && (!completedAt || new Date(eff) > new Date(completedAt))) {
      completedAt = eff;
    }
    if (r.event_type === 'approve' && !master) master = r.username;
  }
  return { entered, completedAt, master, hasRows: rows.length > 0 };
}

// Every individual update to the lot, across ALL stage tables (not just the lot's
// current flow — a flow-changed lot keeps its history in the old chain's tables),
// plus dispatches and Lot Admin corrections. Merged/sorted by utils/lotJourney.
async function buildActivity(lot) {
  const stageEventRows = {};
  for (const stage of stageEvents.STAGES) {
    const [rows] = await pool.query(
      `SELECT e.event_type, e.pieces, e.remark, e.created_at, e.manual_date, u.username
         FROM \`${EVENT_TABLE[stage]}\` e LEFT JOIN users u ON u.id = e.operator_id
        WHERE e.cutting_lot_id = ? ORDER BY e.created_at, e.id`,
      [lot.id]
    );
    if (rows.length) stageEventRows[stage] = rows;
  }
  // Note: custom destinations are folded into `destination` at insert time
  // (routes/finishingRoutes.js dispatch handler) — there is no custom_destination column.
  const [dispatches] = await pool.query(
    `SELECT destination, size_label, quantity, created_at
       FROM finishing_dispatches WHERE lot_no = ? ORDER BY created_at, id`,
    [lot.lot_no]
  );
  // Lot Admin corrections. Guarded: this table is newer than some environments.
  let audits = [];
  try {
    const [rows] = await pool.query(
      `SELECT action, detail, performed_by_name, created_at
         FROM pm_lot_audit_log
        WHERE cutting_lot_id = ? OR (lot_no IS NOT NULL AND lot_no = ?)
     ORDER BY created_at, id`,
      [lot.id, lot.lot_no]
    );
    audits = rows;
  } catch (err) {
    console.error('lot-journey: pm_lot_audit_log unavailable:', err.message);
  }
  return mergeActivity({
    cutting: {
      created_at: lot.created_at, by: lot.cutter_name,
      total_pieces: lot.total_pieces, note: lot.remark || '',
      manual_date: lot.manual_cutting_date || null,
    },
    stageEvents: stageEventRows,
    dispatches,
    audits,
  });
}

async function buildJourney(lot) {
  const stages = orderedStages(lot.flow_type);
  const now = Date.now();

  // Gather raw per-stage data (timing + piece tallies) for the non-cutting stages.
  const raw = {};
  for (const stage of stages) {
    if (stage === 'cutting') continue;
    const [timing, aggregates] = await Promise.all([
      stageTiming(EVENT_TABLE[stage], lot.id),
      stageEvents.getStageAggregates(pool, stage, lot.id),
    ]);
    raw[stage] = { timing, aggregates };
  }

  const timeline = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const next = stages[i + 1];
    let entered; let master; let pieces; let completedAt = null;
    if (stage === 'cutting') {
      entered = lot.manual_cutting_date || lot.created_at;
      master = lot.cutter_name;
      pieces = { approved: lot.total_pieces, completed: lot.total_pieces, rejected: 0, inline: 0 };
    } else {
      entered = raw[stage].timing.entered;
      master = raw[stage].timing.master;
      completedAt = raw[stage].timing.completedAt;
      pieces = raw[stage].aggregates;
    }
    const exit = next ? (next === 'cutting' ? null : (raw[next] && raw[next].timing.entered)) : completedAt;
    let { status, days } = deriveStageStatus({ entered, exited: exit }, now);
    if (stage === 'cutting') status = 'done'; // the cut itself is a completed act
    timeline.push({
      stage, label: STAGE_LABEL[stage] || stage,
      entered: entered || null, exited: exit || null,
      days, tat: TAT_DAYS[stage], overdue: days != null && days > TAT_DAYS[stage],
      status, master: master || null, pieces,
    });
  }

  // Finishing dispatch: finished (finishing completed per size) vs dispatched (by lot_no).
  const finishedBySize = {};
  if (stages.includes('finishing')) {
    const sz = await stageEvents.getStageSizeAggregates(pool, 'finishing', lot.id);
    for (const [s, v] of Object.entries(sz)) finishedBySize[s] = v.completed || 0;
  }
  const [dispRows] = await pool.query(
    `SELECT size_label, SUM(quantity) AS qty, GROUP_CONCAT(DISTINCT destination) AS dests
       FROM finishing_dispatches WHERE lot_no = ? GROUP BY size_label`,
    [lot.lot_no]
  );
  const dispatchedBySize = {};
  const destinations = new Set();
  for (const r of dispRows) {
    dispatchedBySize[String(r.size_label || '').trim().toUpperCase()] = Number(r.qty) || 0;
    if (r.dests) r.dests.split(',').forEach((d) => d && destinations.add(d.trim()));
  }
  const dispatch = dispatchSummary(finishedBySize, dispatchedBySize);
  dispatch.destinations = [...destinations];

  return {
    lot: {
      id: lot.id, lot_no: lot.lot_no, manual_lot_number: lot.manual_lot_number || '',
      sku: lot.sku, flow_type: lot.flow_type || 'unknown', total_pieces: lot.total_pieces,
      remark: lot.remark || '', created_at: lot.created_at, cutter: lot.cutter_name || '',
    },
    timeline,
    current_stage: dispatch.complete ? 'Dispatched' : currentStage(timeline),
    dispatch,
    activity: await buildActivity(lot),
  };
}

// ── Lot viewer additions ────────────────────────────────────────────────────
// New builders take an explicit db handle (pool or a stub in tests), unlike the
// extracted functions above which keep their original pool-bound signatures.

// "Where is every size right now" — rows per size from cutting_lot_sizes,
// approved/completed per stage from the event size aggregates, dispatched from
// finishing_dispatches. Labels matched via normalizeSizeLabel throughout.
async function buildSizeMatrix(db, lot) {
  const stages = orderedStages(lot.flow_type).filter((s) => s !== 'cutting');

  const [cutRows] = await db.query(
    `SELECT size_label, SUM(total_pieces) AS cut
       FROM cutting_lot_sizes WHERE cutting_lot_id = ?
      GROUP BY size_label ORDER BY MIN(id)`,
    [lot.id]
  );

  const aggByStage = {};
  for (const stage of stages) {
    aggByStage[stage] = await stageEvents.getStageSizeAggregates(db, stage, lot.id);
  }

  const [dispRows] = await db.query(
    `SELECT size_label, COALESCE(SUM(quantity),0) AS dispatched
       FROM finishing_dispatches WHERE lot_no = ? GROUP BY size_label`,
    [lot.lot_no]
  );
  const dispMap = {};
  for (const d of dispRows) {
    dispMap[stageEvents.normalizeSizeLabel(d.size_label)] = Number(d.dispatched) || 0;
  }

  const totals = { cut: 0, byStage: {}, dispatched: 0 };
  for (const s of stages) totals.byStage[s] = { approved: 0, completed: 0 };

  const rows = cutRows.map((r) => {
    const key = stageEvents.normalizeSizeLabel(r.size_label);
    const byStage = {};
    for (const s of stages) {
      const a = aggByStage[s][key] || {};
      byStage[s] = { approved: Number(a.approved) || 0, completed: Number(a.completed) || 0 };
      totals.byStage[s].approved += byStage[s].approved;
      totals.byStage[s].completed += byStage[s].completed;
    }
    const row = {
      size: String(r.size_label),
      cut: Number(r.cut) || 0,
      byStage,
      dispatched: dispMap[key] || 0,
    };
    totals.cut += row.cut;
    totals.dispatched += row.dispatched;
    return row;
  });

  return { stages, rows, totals };
}

// Newest cutting lots for the viewer home list, with a cheap current-stage
// chip: furthest stage (full denim chain) that has ANY events for the lot.
// Approximation is fine for a list — the detail screen computes real status.
async function recentLots(db, limit = 30) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const [lots] = await db.query(
    `SELECT id, lot_no, manual_lot_number, sku, total_pieces, flow_type, created_at
       FROM cutting_lots ORDER BY created_at DESC LIMIT ${lim}`
  );
  if (!lots.length) return [];

  const ids = lots.map((l) => l.id);
  const stageOf = {};
  for (const stage of stageEvents.STAGES) { // chain order: stitching → … → finishing
    const [rows] = await db.query(
      `SELECT DISTINCT cutting_lot_id FROM ${EVENT_TABLE[stage]} WHERE cutting_lot_id IN (?)`,
      [ids]
    );
    for (const r of rows) stageOf[r.cutting_lot_id] = stage; // later stages overwrite
  }
  return lots.map((l) => ({ ...l, current_stage: stageOf[l.id] || 'cutting' }));
}

module.exports = {
  TAT_DAYS,
  STAGE_LABEL,
  EVENT_TABLE,
  resolveLot,
  stageTiming,
  buildActivity,
  buildJourney,
  buildSizeMatrix,
  recentLots,
};
