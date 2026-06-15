/**
 * Operator — Lot TAT.
 *
 * Replica of /my-lots scoped to operators. Shows EVERY lot (subject
 * to optional filters), with per-stage elapsed days vs the stage's
 * TAT target. Lots overdue at any stage are highlighted.
 *
 * Timing is derived strictly from *_events (the new truth source).
 * Cutting start = cutting_lots.created_at. Stage entered = first event
 * row's created_at for that lot in that stage's events table. Stage
 * exited = first event of the next stage (or NOW if no next yet).
 */

const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

const TAT_DAYS = {
  cutting: 3,
  stitching: 7,
  assembly: 7,
  washing: 15,
  washing_in: 7,
  finishing: 7,
};

const STAGE_EVENT_TABLE = {
  stitching: 'stitching_events',
  assembly: 'jeans_assembly_events',
  washing: 'washing_events',
  washing_in: 'washing_in_events',
  finishing: 'finishing_events',
};

router.get('/', isAuthenticated, isOperator, async (req, res) => {
  return res.render('operatorLotTat', { tat: TAT_DAYS });
});

async function loadLotTat({ days, search, remark, flow, overdue, limit }) {
  const params = [];
  let where = '1=1';
  if (days && Number(days) > 0) {
    where += ' AND cl.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    params.push(Number(days));
  }
  if (flow === 'denim' || flow === 'hosiery') {
    where += ' AND cl.flow_type = ?';
    params.push(flow);
  }
  if (search && search.trim()) {
    where += ' AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)';
    const q = `%${search.trim()}%`;
    params.push(q, q);
  }
  if (remark && remark.trim()) {
    where += ' AND cl.remark LIKE ?';
    params.push(`%${remark.trim()}%`);
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  params.push(safeLimit);

  const [lots] = await pool.query(
    `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.flow_type, cl.remark,
            cl.created_at, cl.user_id AS cutter_id, cu.username AS cutter_name
       FROM cutting_lots cl
  LEFT JOIN users cu ON cu.id = cl.user_id
      WHERE ${where}
   ORDER BY cl.created_at DESC
      LIMIT ?`,
    params
  );

  if (lots.length === 0) return [];

  const lotIds = lots.map(l => l.id);
  const lotById = {};
  for (const l of lots) {
    lotById[l.id] = {
      lot_id: l.id, lot_no: l.lot_no, manual_lot_number: l.manual_lot_number || '', sku: l.sku,
      pieces: Number(l.total_pieces) || 0,
      flow_type: l.flow_type || 'unknown',
      remark: l.remark || '',
      created_at: l.created_at,
      cutter: { user_id: l.cutter_id, name: l.cutter_name },
      stages: {}, // per-stage timing + master
    };
  }

  // For each stage's events table, fetch every event for these lots
  // and reduce in JS: entered_at = min, completed_at = max(complete),
  // master = operator of FIRST approve event (the one accountable).
  for (const [stageKey, table] of Object.entries(STAGE_EVENT_TABLE)) {
    const [rows] = await pool.query(
      `SELECT e.cutting_lot_id, e.event_type, e.operator_id, e.created_at, u.username
         FROM \`${table}\` e
    LEFT JOIN users u ON u.id = e.operator_id
        WHERE e.cutting_lot_id IN (?)
     ORDER BY e.cutting_lot_id, e.created_at`,
      [lotIds]
    );
    const byLot = {};
    for (const r of rows) {
      const slot = byLot[r.cutting_lot_id] || (byLot[r.cutting_lot_id] = {
        entered_at: null, completed_at: null, master_id: null, master: null,
      });
      if (!slot.entered_at) slot.entered_at = r.created_at;
      if (r.event_type === 'complete') {
        if (!slot.completed_at || new Date(r.created_at) > new Date(slot.completed_at)) {
          slot.completed_at = r.created_at;
        }
      }
      if (r.event_type === 'approve' && !slot.master_id) {
        slot.master_id = r.operator_id;
        slot.master = r.username;
      }
    }
    for (const [lotIdStr, slot] of Object.entries(byLot)) {
      const lot = lotById[lotIdStr];
      if (lot) lot.stages[stageKey] = slot;
    }
  }

  // Compute per-stage elapsed days + overdue flags.
  const STAGES_DENIM   = ['cutting', 'stitching', 'assembly', 'washing', 'washing_in', 'finishing'];
  const STAGES_HOSIERY = ['cutting', 'stitching', 'finishing'];

  const now = Date.now();
  const dayMs = 86400000;
  const result = [];

  for (const lot of Object.values(lotById)) {
    const stages = lot.flow_type === 'denim' ? STAGES_DENIM : STAGES_HOSIERY;
    const timeline = [];

    // Cutting is special — no events table; created_at IS the entry point.
    let prevExit = lot.created_at;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const next  = stages[i + 1];

      let entered, master, masterId, completedAt;
      if (stage === 'cutting') {
        entered = lot.created_at;
        master  = lot.cutter.name;
        masterId = lot.cutter.user_id;
      } else {
        const ev = lot.stages[stage];
        entered = ev ? ev.entered_at : null;
        master  = ev ? ev.master : null;
        masterId = ev ? ev.master_id : null;
        completedAt = ev ? ev.completed_at : null;
      }

      // Exit = entered_at of next stage in this chain. For finishing,
      // exit = completed_at if available.
      let exit = null;
      if (next) {
        const ne = lot.stages[next];
        exit = ne ? ne.entered_at : null;
      } else {
        // last stage (finishing)
        exit = completedAt || null;
      }

      // Days in this stage
      const startMs = entered ? new Date(entered).getTime() : null;
      const endMs   = exit ? new Date(exit).getTime() : (startMs ? now : null);
      const days = startMs != null && endMs != null
        ? Math.max(0, Math.round((endMs - startMs) / dayMs))
        : null;
      const inProgress = startMs != null && exit == null;
      const tat = TAT_DAYS[stage];
      const overdueFlag = days != null && days > tat;

      timeline.push({
        stage,
        entered: entered || null,
        exited: exit,
        days,
        tat,
        overdue: overdueFlag,
        in_progress: inProgress,
        not_started: startMs == null,
        master: master || null,
        master_id: masterId || null,
      });

      if (entered) prevExit = entered;
    }

    // Current stage = first stage that's in_progress (entered but not exited).
    let currentStage = 'Done';
    for (const t of timeline) {
      if (t.in_progress) { currentStage = t.stage; break; }
      if (t.not_started) { currentStage = t.stage; break; }
    }

    // Per-lot any-overdue flag (for filter)
    const anyOverdue = timeline.some(t => t.overdue);

    lot.timeline = timeline;
    lot.current_stage = currentStage;
    lot.any_overdue = anyOverdue;
    result.push(lot);
  }

  if (overdue === '1' || overdue === 'true') {
    return result.filter(l => l.any_overdue);
  }
  return result;
}

router.get('/data', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lots = await loadLotTat({
      days: req.query.days,
      search: req.query.search,
      remark: req.query.remark,
      flow: req.query.flow,
      overdue: req.query.overdue,
      limit: req.query.limit,
    });
    return res.json({ tat: TAT_DAYS, lots });
  } catch (err) {
    console.error('GET /operator/lot-tat/data error:', err);
    return res.status(500).json({ error: 'Failed to load lot TAT data' });
  }
});

router.get('/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lots = await loadLotTat({
      days: req.query.days,
      search: req.query.search,
      remark: req.query.remark,
      flow: req.query.flow,
      overdue: req.query.overdue,
      limit: req.query.limit || 2000,
    });

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Lot TAT');
    sheet.columns = [
      { header: 'Lot No',        key: 'lot_no',         width: 14 },
      { header: 'Manual Lot No', key: 'manual_lot_number', width: 14 },
      { header: 'SKU',           key: 'sku',            width: 22 },
      { header: 'Dept',          key: 'dept',           width: 9 },
      { header: 'Pieces',        key: 'pieces',         width: 9 },
      { header: 'Remark',        key: 'remark',         width: 22 },
      { header: 'Cutter',        key: 'cutter',         width: 14 },
      { header: 'Cut Date',      key: 'cut_date',       width: 12 },
      { header: 'Current Stage', key: 'current_stage',  width: 13 },
      { header: 'Cutting (3d)',   key: 'cutting_days',     width: 11 },
      { header: 'Cutting Master',  key: 'cutting_master',  width: 14 },
      { header: 'Stitching (7d)', key: 'stitching_days',  width: 11 },
      { header: 'Stitching Master', key: 'stitching_master', width: 14 },
      { header: 'Assembly (7d)',  key: 'assembly_days',   width: 11 },
      { header: 'Assembly Master', key: 'assembly_master', width: 14 },
      { header: 'Washing (15d)',  key: 'washing_days',    width: 11 },
      { header: 'Washing Master',  key: 'washing_master',  width: 14 },
      { header: 'Wash-In (7d)',   key: 'washing_in_days', width: 11 },
      { header: 'Wash-In Master',  key: 'washing_in_master', width: 14 },
      { header: 'Finishing (7d)', key: 'finishing_days',  width: 11 },
      { header: 'Finishing Master', key: 'finishing_master', width: 14 },
      { header: 'Any Overdue',   key: 'any_overdue',    width: 10 },
    ];

    const fmt = d => d ? new Date(d).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
    }) : '';

    const dayCell = t => {
      if (!t) return '';
      if (t.not_started) return '—';
      if (t.in_progress) return `${t.days}d (ongoing)`;
      return `${t.days}d`;
    };

    for (const lot of lots) {
      const byStage = Object.fromEntries(lot.timeline.map(t => [t.stage, t]));
      const row = {
        lot_no: lot.lot_no, manual_lot_number: lot.manual_lot_number || '', sku: lot.sku, dept: lot.flow_type,
        pieces: lot.pieces, remark: lot.remark || '',
        cutter: lot.cutter.name || '', cut_date: fmt(lot.created_at),
        current_stage: lot.current_stage,
        cutting_days: dayCell(byStage.cutting),
        cutting_master: byStage.cutting ? byStage.cutting.master || '' : '',
        stitching_days: dayCell(byStage.stitching),
        stitching_master: byStage.stitching ? byStage.stitching.master || '' : '',
        assembly_days: lot.flow_type === 'denim' ? dayCell(byStage.assembly) : 'N/A',
        assembly_master: lot.flow_type === 'denim' && byStage.assembly ? byStage.assembly.master || '' : '',
        washing_days: lot.flow_type === 'denim' ? dayCell(byStage.washing) : 'N/A',
        washing_master: lot.flow_type === 'denim' && byStage.washing ? byStage.washing.master || '' : '',
        washing_in_days: lot.flow_type === 'denim' ? dayCell(byStage.washing_in) : 'N/A',
        washing_in_master: lot.flow_type === 'denim' && byStage.washing_in ? byStage.washing_in.master || '' : '',
        finishing_days: dayCell(byStage.finishing),
        finishing_master: byStage.finishing ? byStage.finishing.master || '' : '',
        any_overdue: lot.any_overdue ? 'YES' : '',
      };
      const r = sheet.addRow(row);
      // Highlight overdue cells in red
      const stageColMap = {
        cutting: 9, stitching: 11, assembly: 13, washing: 15, washing_in: 17, finishing: 19,
      };
      for (const t of lot.timeline) {
        if (t.overdue) {
          r.getCell(stageColMap[t.stage]).fill = {
            type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' },
          };
          r.getCell(stageColMap[t.stage]).font = { color: { argb: 'FFB91C1C' }, bold: true };
        }
      }
    }

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="LotTAT-${today}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('GET /operator/lot-tat/download error:', err);
    return res.status(500).send('Failed to export lot TAT');
  }
});

module.exports = router;
