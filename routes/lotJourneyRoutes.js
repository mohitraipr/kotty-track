/**
 * Lot Journey — one lot's status through EVERY production stage, ending at finishing
 * dispatch, on a single screen. Search by lot no / manual lot no / SKU.
 *
 * Timing/master come from *_events (the truth source), piece tallies from
 * utils/stageEvents.getStageAggregates, and the final step from finishing_dispatches.
 * Pure ordering/status/dispatch math lives in utils/lotJourney.js (unit-tested).
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const stageEvents = require('../utils/stageEvents');
const {
  orderedStages, deriveStageStatus, dispatchSummary, currentStage,
} = require('../utils/lotJourney');

const TAT_DAYS = { cutting: 3, stitching: 7, jeans_assembly: 7, washing: 15, washing_in: 7, finishing: 7 };
const STAGE_LABEL = {
  cutting: 'Cutting', stitching: 'Stitching', jeans_assembly: 'Jeans Assembly',
  washing: 'Washing', washing_in: 'Washing-In', finishing: 'Finishing',
};

router.get('/', isAuthenticated, isOperator, (req, res) => res.render('lotJourney'));

// Resolve the best-matching lot for a free-text query: exact lot_no / manual_lot_number
// win, otherwise the most recent LIKE match across lot_no / manual_lot_number / sku.
async function resolveLot(q) {
  const exact = q.trim();
  const like = `%${exact}%`;
  const [rows] = await pool.query(
    `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.flow_type,
            cl.remark, cl.created_at, cl.user_id AS cutter_id, u.username AS cutter_name
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
    `SELECT e.event_type, e.created_at, u.username
       FROM \`${table}\` e LEFT JOIN users u ON u.id = e.operator_id
      WHERE e.cutting_lot_id = ? ORDER BY e.created_at`,
    [lotId]
  );
  let entered = null; let completedAt = null; let master = null;
  for (const r of rows) {
    if (!entered) entered = r.created_at;
    if (r.event_type === 'complete' && (!completedAt || new Date(r.created_at) > new Date(completedAt))) {
      completedAt = r.created_at;
    }
    if (r.event_type === 'approve' && !master) master = r.username;
  }
  return { entered, completedAt, master, hasRows: rows.length > 0 };
}

const EVENT_TABLE = {
  stitching: 'stitching_events', jeans_assembly: 'jeans_assembly_events',
  washing: 'washing_events', washing_in: 'washing_in_events', finishing: 'finishing_events',
};

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
      entered = lot.created_at;
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
    `SELECT size_label, SUM(quantity) AS qty, GROUP_CONCAT(DISTINCT COALESCE(NULLIF(custom_destination,''), destination)) AS dests
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
  };
}

router.get('/data', isAuthenticated, isOperator, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, matches: [], journey: null });
    const matches = await resolveLot(q);
    if (!matches.length) return res.json({ ok: true, matches: [], journey: null });
    const journey = await buildJourney(matches[0]);
    res.json({
      ok: true,
      journey,
      matches: matches.map((m) => ({
        id: m.id, lot_no: m.lot_no, manual_lot_number: m.manual_lot_number || '', sku: m.sku,
      })),
    });
  } catch (err) {
    console.error('GET /operator/lot-journey/data error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
