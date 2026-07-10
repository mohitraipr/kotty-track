const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isFinishingMaster } = require('../middlewares/auth');
const { createStagePayment } = require('../utils/stagePaymentHelper');
const stageEvents = require('../utils/stageEvents');
const { getLotStageUsers } = require('../utils/lotStageUsers');

/* ---------------------------------------------------
   MULTER FOR IMAGE UPLOAD & BULK EXCEL UPLOAD
--------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + file.originalname;
    cb(null, 'finish-' + uniqueSuffix);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

/* =============================================================
   1) FINISHING DASHBOARD (GET /finishingdashboard)
   ============================================================= */
router.get('/', isAuthenticated, isFinishingMaster, (req, res) => {
  res.render('finishingEvents', { user: req.session.user });
});

router.get('/legacy', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Fixed: Replaced SELECT fa.* with specific columns
    const [faRows] = await pool.query(
      `SELECT fa.id, fa.user_id, fa.stitching_assignment_id, fa.washing_in_data_id,
              fa.sizes_json, fa.assigned_on, fa.is_approved, fa.assignment_remark,
              COALESCE(sd.lot_no, wd.lot_no) AS lot_no,
              COALESCE(sd.sku, wd.sku) AS sku,
              cl.remark AS cutting_remark,
              cl.sku    AS cutting_sku,
              CASE
                WHEN fa.stitching_assignment_id IS NOT NULL THEN 'Stitching'
                WHEN fa.washing_in_data_id IS NOT NULL THEN 'Washing'
              END AS department,
              COALESCE(fdCnt.cnt, 0) AS has_finishing
       FROM finishing_assignments fa
       LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
       LEFT JOIN washing_in_data wd ON fa.washing_in_data_id = wd.id
       LEFT JOIN cutting_lots cl ON cl.lot_no = COALESCE(sd.lot_no, wd.lot_no)
       LEFT JOIN (SELECT lot_no, COUNT(*) cnt FROM finishing_data GROUP BY lot_no) fdCnt
              ON fdCnt.lot_no = COALESCE(sd.lot_no, wd.lot_no)
       WHERE fa.user_id = ? AND fa.is_approved = 1
       ORDER BY fa.assigned_on DESC`,
      [userId]
    );

    // Filter assignments already used in finishing_data
    const finalAssignments = faRows.filter(fa => fa.has_finishing === 0);

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');
    return res.render('finishingDashboard', {
      user: req.session.user,
      assignments: finalAssignments,
      error: errorMessages,
      success: successMessages
    });
  } catch (err) {
    console.error('Error loading finishing dashboard:', err);
    req.flash('error', 'Cannot load finishing dashboard data.');
    return res.redirect('/');
  }
});
// ==================================================================
//   NEW EVENT MODEL — multi-batch approve/complete/reject
//
//   Finishing has TWO upstream sources by flow_type:
//     - Hosiery flow: from stitching complete events (pays stitching)
//     - Denim flow:   from washing_in complete events (pays washing_in)
//
//   The lot's flow_type determines which upstream + payee.
// ==================================================================

const STAGE_F = 'finishing';

function isHosieryLot(lot) {
  if (!lot) return false;
  if ((lot.flow_type || '').toLowerCase() === 'hosiery') return true;
  // Legacy fallback: flow_type NULL + non-denim cutter or non-AK/UM lot
  if (lot.flow_type === null || lot.flow_type === undefined) {
    if (lot.is_denim_cutter === 1) return false;
    if (lot.lot_no && (lot.lot_no.startsWith('AK') || lot.lot_no.startsWith('UM'))) return false;
    return true; // assume hosiery for legacy non-denim
  }
  return false;
}

async function fUpstreamSizes(conn, lot) {
  const cuttingLotId = lot.id;
  const lotNo = lot.lot_no;
  const hosiery = isHosieryLot(lot);

  // Source events table is stitching_events for hosiery, washing_in_events for denim
  const evTable = hosiery ? 'stitching' : 'washing_in';
  const dataTable = hosiery ? 'stitching_data' : 'washing_in_data';
  const dataSizes = hosiery ? 'stitching_data_sizes' : 'washing_in_data_sizes';
  const dataFk = hosiery ? 'stitching_data_id' : 'washing_in_data_id';

  const [evRows] = await conn.query(
    `SELECT s.size_label, COALESCE(SUM(s.pieces),0) AS pieces
     FROM ${evTable}_event_sizes s
     JOIN ${evTable}_events e ON e.id = s.event_id
     WHERE e.cutting_lot_id = ? AND e.event_type = 'complete'
     GROUP BY s.size_label`,
    [cuttingLotId]
  );
  const upstream = {};
  for (const r of evRows) {
    const k = stageEvents.normalizeSizeLabel(r.size_label);
    if (k) upstream[k] = (upstream[k] || 0) + (Number(r.pieces) || 0);
  }

  if (Object.keys(upstream).length === 0) {
    const [legRows] = await conn.query(
      `SELECT ds.size_label, COALESCE(SUM(ds.pieces),0) AS pieces
       FROM ${dataSizes} ds
       JOIN ${dataTable} d ON d.id = ds.${dataFk}
       WHERE d.lot_no = ?
       GROUP BY ds.size_label`,
      [lotNo]
    );
    for (const r of legRows) {
      const k = stageEvents.normalizeSizeLabel(r.size_label);
      if (k) upstream[k] = (upstream[k] || 0) + (Number(r.pieces) || 0);
    }
  }

  const fSizes = await stageEvents.getStageSizeAggregates(conn, STAGE_F, cuttingLotId);
  const out = [];
  for (const [size_label, qty] of Object.entries(upstream)) {
    const sa = fSizes[size_label] || { approved: 0, completed: 0, rejected: 0, inline: 0, upstream_rejected: 0, inline_rejected: 0 };
    const consumed = (sa.approved || 0) + (sa.upstream_rejected || 0);
    out.push({
      size_label,
      upstream_qty: qty,
      approved: sa.approved,
      completed: sa.completed,
      rejected: sa.rejected,
      upstream_rejected: sa.upstream_rejected || 0,
      inline_rejected: sa.inline_rejected || 0,
      inline: sa.inline,
      approved_at_stage: sa.approved,
      available: Math.max(0, qty - consumed),
    });
  }
  return out;
}

async function fPickPayeeForLot(conn, lot) {
  const hosiery = isHosieryLot(lot);
  const tbl = hosiery ? 'stitching_data' : 'washing_in_data';
  const [rows] = await conn.query(
    `SELECT d.user_id, u.username, d.sku
     FROM ${tbl} d JOIN users u ON u.id = d.user_id
     WHERE d.lot_no = ?
     ORDER BY d.total_pieces DESC, d.created_at DESC
     LIMIT 1`,
    [lot.lot_no]
  );
  return rows[0] ? { ...rows[0], stage: hosiery ? 'stitching' : 'washing_in' } : null;
}

router.get('/events', isAuthenticated, isFinishingMaster, (req, res) => {
  res.render('finishingEvents', { user: req.session.user });
});

// ==================================================================
//   EVENT-MODEL HISTORY / JOURNEY / EXPORT / PAYMENTS
//   Cascade from stitching pattern.
// ==================================================================

router.get('/event/history', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 7));
    const type = String(req.query.type || 'all');
    const allowed = new Set(['all', 'approve', 'complete', 'reject']);
    if (!allowed.has(type)) return res.status(400).json({ error: 'Invalid type' });

    const params = [userId, days];
    let typeFilter = '';
    if (type !== 'all') { typeFilter = 'AND e.event_type = ?'; params.push(type); }

    const [events] = await pool.query(
      `SELECT e.id, e.cutting_lot_id, e.event_type, e.pieces, e.remark, e.created_at, e.parent_event_id,
              cl.lot_no, cl.sku
       FROM finishing_events e
       JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
       WHERE e.operator_id = ?
         AND e.created_at >= (NOW() - INTERVAL ? DAY)
         ${typeFilter}
       ORDER BY e.created_at DESC
       LIMIT 500`,
      params
    );

    if (!events.length) return res.json({ events: [] });

    const eventIds = events.map(e => e.id);
    const [sizes] = await pool.query(
      `SELECT event_id, size_label, pieces FROM finishing_event_sizes WHERE event_id IN (?)`,
      [eventIds]
    );
    const sizeMap = {};
    for (const s of sizes) {
      if (!sizeMap[s.event_id]) sizeMap[s.event_id] = {};
      sizeMap[s.event_id][s.size_label] = Number(s.pieces) || 0;
    }
    events.forEach(e => { e.sizes = sizeMap[e.id] || {}; });

    res.json({ events });
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/event/history =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/lot-journey/:cuttingLotId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const lotId = parseInt(req.params.cuttingLotId, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) {
      return res.status(400).json({ error: 'Invalid cutting_lot_id' });
    }
    const [events] = await pool.query(
      `SELECT e.id, e.event_type, e.pieces, e.remark, e.created_at, e.parent_event_id,
              u.username AS operator
       FROM finishing_events e
       JOIN users u ON u.id = e.operator_id
       WHERE e.cutting_lot_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
      [lotId]
    );
    if (!events.length) return res.json({ events: [] });
    const ids = events.map(e => e.id);
    const [sizes] = await pool.query(
      `SELECT event_id, size_label, pieces FROM finishing_event_sizes WHERE event_id IN (?)`,
      [ids]
    );
    const sizeMap = {};
    for (const s of sizes) {
      if (!sizeMap[s.event_id]) sizeMap[s.event_id] = {};
      sizeMap[s.event_id][s.size_label] = Number(s.pieces) || 0;
    }
    events.forEach(e => { e.sizes = sizeMap[e.id] || {}; });
    res.json({ events });
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/event/lot-journey =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/export', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const username = req.session.user.username || 'operator';
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const type = String(req.query.type || 'all');
    const allowed = new Set(['all', 'approve', 'complete', 'reject']);
    if (!allowed.has(type)) return res.status(400).json({ error: 'Invalid type' });

    const params = [userId, days];
    let typeFilter = '';
    if (type !== 'all') { typeFilter = 'AND e.event_type = ?'; params.push(type); }

    const [events] = await pool.query(
      `SELECT e.id, e.event_type, e.pieces, e.remark, e.created_at, e.parent_event_id,
              cl.lot_no, cl.sku
       FROM finishing_events e
       JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
       WHERE e.operator_id = ?
         AND e.created_at >= (NOW() - INTERVAL ? DAY)
         ${typeFilter}
       ORDER BY e.created_at DESC`,
      params
    );

    let sizeMap = {};
    if (events.length) {
      const eventIds = events.map(e => e.id);
      const [sizes] = await pool.query(
        `SELECT event_id, size_label, pieces FROM finishing_event_sizes
         WHERE event_id IN (?) ORDER BY size_label`,
        [eventIds]
      );
      for (const s of sizes) {
        if (!sizeMap[s.event_id]) sizeMap[s.event_id] = [];
        sizeMap[s.event_id].push(`${s.size_label}:${Number(s.pieces) || 0}`);
      }
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kotty Track';
    wb.created = new Date();
    const ws = wb.addWorksheet('Finishing Events');
    ws.columns = [
      { header: 'Date',      key: 'date',   width: 20 },
      { header: 'Event',     key: 'event',  width: 12 },
      { header: 'Lot No',    key: 'lot',    width: 14 },
      { header: 'SKU',       key: 'sku',    width: 22 },
      { header: 'Pieces',    key: 'pieces', width: 10 },
      { header: 'Sizes',     key: 'sizes',  width: 36 },
      { header: 'Remark',    key: 'remark', width: 32 },
      { header: 'Parent ID', key: 'parent', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };

    events.forEach(e => {
      ws.addRow({
        date:   e.created_at ? new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19) : '',
        event:  e.event_type,
        lot:    e.lot_no,
        sku:    e.sku,
        pieces: Number(e.pieces) || 0,
        sizes:  (sizeMap[e.id] || []).join('  ·  '),
        remark: e.remark || '',
        parent: e.parent_event_id || '',
      });
    });

    const fname = `finishing_${username}_${days}d_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/event/export =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/payments', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const status = String(req.query.status || 'all');
    const allowedStatus = new Set(['all', 'pending', 'paid', 'cancelled']);
    if (!allowedStatus.has(status)) return res.status(400).json({ error: 'Invalid status' });

    const params = [userId, days];
    let statusFilter = '';
    if (status !== 'all') { statusFilter = 'AND status = ?'; params.push(status); }

    const [rows] = await pool.query(
      `SELECT id, lot_no, sku, qty, base_rate, extra_amount, total_amount,
              rate_configured, status, paid_on, created_at, payment_remark
       FROM stage_payments
       WHERE user_id = ?
         AND stage = 'finishing'
         AND created_at >= (NOW() - INTERVAL ? DAY)
         ${statusFilter}
       ORDER BY created_at DESC
       LIMIT 500`,
      params
    );

    const [[summary]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='pending' THEN total_amount ELSE 0 END), 0)   AS pending_amount,
         COALESCE(SUM(CASE WHEN status='paid'    THEN total_amount ELSE 0 END), 0)   AS paid_amount,
         COALESCE(SUM(CASE WHEN status='pending' THEN qty ELSE 0 END), 0)            AS pending_qty,
         COALESCE(SUM(CASE WHEN status='paid'    THEN qty ELSE 0 END), 0)            AS paid_qty,
         COUNT(*)                                                                     AS total_rows
       FROM stage_payments
       WHERE user_id = ? AND stage = 'finishing'
         AND created_at >= (NOW() - INTERVAL ? DAY)`,
      [userId, days]
    );

    res.json({
      payments: rows,
      summary: {
        pending_amount: Number(summary.pending_amount) || 0,
        paid_amount:    Number(summary.paid_amount)    || 0,
        pending_qty:    Number(summary.pending_qty)    || 0,
        paid_qty:       Number(summary.paid_qty)       || 0,
        total_rows:     Number(summary.total_rows)     || 0,
      },
    });
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/event/payments =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/payments/export', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const username = req.session.user.username || 'operator';
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const status = String(req.query.status || 'all');
    const allowedStatus = new Set(['all', 'pending', 'paid', 'cancelled']);
    if (!allowedStatus.has(status)) return res.status(400).json({ error: 'Invalid status' });

    const params = [userId, days];
    let statusFilter = '';
    if (status !== 'all') { statusFilter = 'AND status = ?'; params.push(status); }

    const [rows] = await pool.query(
      `SELECT lot_no, sku, qty, base_rate, extra_amount, total_amount,
              rate_configured, status, paid_on, created_at, payment_remark
       FROM stage_payments
       WHERE user_id = ?
         AND stage = 'finishing'
         AND created_at >= (NOW() - INTERVAL ? DAY)
         ${statusFilter}
       ORDER BY created_at DESC`,
      params
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kotty Track';
    wb.created = new Date();
    const ws = wb.addWorksheet('Finishing Payments');
    ws.columns = [
      { header: 'Created',     key: 'created',  width: 20 },
      { header: 'Lot No',      key: 'lot',      width: 14 },
      { header: 'SKU',         key: 'sku',      width: 22 },
      { header: 'Pieces',      key: 'qty',      width: 10 },
      { header: 'Base Rate',   key: 'base',     width: 12 },
      { header: 'Extras',      key: 'extras',   width: 12 },
      { header: 'Total ₹',     key: 'total',    width: 14 },
      { header: 'Rate Set?',   key: 'rateset',  width: 10 },
      { header: 'Status',      key: 'status',   width: 12 },
      { header: 'Paid On',     key: 'paid',     width: 20 },
      { header: 'Remark',      key: 'remark',   width: 30 },
    ];
    ws.getRow(1).font = { bold: true };

    rows.forEach(r => {
      ws.addRow({
        created: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19) : '',
        lot:     r.lot_no,
        sku:     r.sku,
        qty:     Number(r.qty) || 0,
        base:    Number(r.base_rate) || 0,
        extras:  Number(r.extra_amount) || 0,
        total:   Number(r.total_amount) || 0,
        rateset: r.rate_configured ? 'YES' : 'NO',
        status:  r.status,
        paid:    r.paid_on ? new Date(r.paid_on).toISOString().replace('T', ' ').slice(0, 19) : '',
        remark:  r.payment_remark || '',
      });
    });

    const fname = `finishing_payments_${username}_${days}d_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/event/payments/export =>', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================================================================
//   DISPATCH (post-complete) — cutting-lot-keyed dispatch surface for
//   the new event-model UI. Wraps the existing finishing_dispatches +
//   finishing_data tables. Owner-locked: only the operator who owns
//   the finishing_data row can dispatch from it.
// ==================================================================

// GET /finishingdashboard/event/dispatch-state/:cuttingLotId
// Returns this operator's dispatchable finishing_data rows for the lot,
// each with per-size produced/dispatched/available, plus a flat lot-level
// availability summary.
router.get('/event/dispatch-state/:cuttingLotId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const lotId = parseInt(req.params.cuttingLotId, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) return res.status(400).json({ error: 'Invalid cutting_lot_id' });
    const userId = req.session.user.id;

    const [[lot]] = await pool.query(`SELECT id, lot_no, sku FROM cutting_lots WHERE id = ?`, [lotId]);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    const [batches] = await pool.query(
      `SELECT id, lot_no, sku, total_pieces, remark, created_at
       FROM finishing_data
       WHERE user_id = ? AND lot_no = ?
       ORDER BY created_at ASC`,
      [userId, lot.lot_no]
    );
    if (!batches.length) {
      return res.json({ lot, batches: [], lot_summary: { available: 0, dispatched: 0, produced: 0 } });
    }

    const ids = batches.map(b => b.id);
    const [sizeRows] = await pool.query(
      `SELECT fds.finishing_data_id, fds.size_label, fds.pieces,
              COALESCE(d.qty, 0) AS dispatched
       FROM finishing_data_sizes fds
       LEFT JOIN (
         SELECT finishing_data_id, size_label, SUM(quantity) AS qty
         FROM finishing_dispatches
         WHERE finishing_data_id IN (?)
         GROUP BY finishing_data_id, size_label
       ) d ON d.finishing_data_id = fds.finishing_data_id AND d.size_label = fds.size_label
       WHERE fds.finishing_data_id IN (?)
       ORDER BY fds.finishing_data_id, fds.id`,
      [ids, ids]
    );

    const sizesByBatch = {};
    let lotProduced = 0, lotDispatched = 0, lotAvailable = 0;
    for (const r of sizeRows) {
      const produced  = Number(r.pieces) || 0;
      const dispatched = Number(r.dispatched) || 0;
      const available = Math.max(0, produced - dispatched);
      lotProduced   += produced;
      lotDispatched += dispatched;
      lotAvailable  += available;
      if (!sizesByBatch[r.finishing_data_id]) sizesByBatch[r.finishing_data_id] = [];
      sizesByBatch[r.finishing_data_id].push({
        size_label: r.size_label,
        produced, dispatched, available,
      });
    }

    const out = batches.map(b => {
      const sizes = sizesByBatch[b.id] || [];
      const batchAvailable = sizes.reduce((a, s) => a + s.available, 0);
      const batchProduced  = sizes.reduce((a, s) => a + s.produced, 0);
      const batchDispatched = sizes.reduce((a, s) => a + s.dispatched, 0);
      return {
        finishing_data_id: b.id,
        lot_no: b.lot_no,
        sku: b.sku,
        total_pieces: b.total_pieces,
        remark: b.remark,
        created_at: b.created_at,
        sizes,
        produced: batchProduced,
        dispatched: batchDispatched,
        available: batchAvailable,
        fully_dispatched: batchAvailable === 0,
      };
    });

    res.json({
      lot,
      batches: out,
      lot_summary: { available: lotAvailable, dispatched: lotDispatched, produced: lotProduced },
    });
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/event/dispatch-state =>', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /finishingdashboard/event/dispatch
// Body: { finishing_data_id, destination, custom_destination?, sizes: [{size_label, pieces}] }
// Inserts finishing_dispatches rows. Owner-locked: only the user who owns
// this finishing_data row may dispatch from it.
router.post('/event/dispatch', isAuthenticated, isFinishingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { finishing_data_id, destination, custom_destination, sizes } = req.body;

    const fdId = parseInt(finishing_data_id, 10);
    if (!Number.isFinite(fdId) || fdId <= 0) return res.status(400).json({ error: 'Invalid finishing_data_id' });

    let dest = String(destination || '').trim();
    if (dest === 'other' || !dest) {
      dest = String(custom_destination || '').trim();
    }
    if (!dest) return res.status(400).json({ error: 'Destination is required' });

    const cleanSizes = (Array.isArray(sizes) ? sizes : [])
      .map(s => ({ size_label: String(s.size_label || '').trim(), pieces: Number(s.pieces) || 0 }))
      .filter(s => s.size_label && s.pieces > 0);
    if (!cleanSizes.length) return res.status(400).json({ error: 'No positive size quantities provided' });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[fd]] = await conn.query(
      `SELECT id, user_id, lot_no FROM finishing_data WHERE id = ? FOR UPDATE`,
      [fdId]
    );
    if (!fd) {
      await conn.rollback();
      return res.status(404).json({ error: 'Finishing batch not found' });
    }
    if (fd.user_id !== userId) {
      await conn.rollback();
      return res.status(403).json({ error: 'You can only dispatch from your own finishing batches' });
    }

    // Per-size availability check under the txn
    const [sizeRows] = await conn.query(
      `SELECT fds.id, fds.size_label, fds.pieces,
              COALESCE(d.qty, 0) AS dispatched,
              COALESCE(dDest.qty, 0) AS dest_dispatched
       FROM finishing_data_sizes fds
       LEFT JOIN (
         SELECT size_label, SUM(quantity) AS qty FROM finishing_dispatches
         WHERE finishing_data_id = ? GROUP BY size_label
       ) d ON d.size_label = fds.size_label
       LEFT JOIN (
         SELECT size_label, SUM(quantity) AS qty FROM finishing_dispatches
         WHERE finishing_data_id = ? AND destination = ? GROUP BY size_label
       ) dDest ON dDest.size_label = fds.size_label
       WHERE fds.finishing_data_id = ?`,
      [fdId, fdId, dest, fdId]
    );
    const fdSizeMap = {};
    for (const r of sizeRows) fdSizeMap[stageEvents.normalizeSizeLabel(r.size_label)] = r;

    const inserts = [];
    let totalDispatch = 0;
    for (const s of cleanSizes) {
      const k = stageEvents.normalizeSizeLabel(s.size_label);
      const row = fdSizeMap[k];
      if (!row) {
        await conn.rollback();
        return res.status(400).json({ error: `Size ${s.size_label} not produced in this batch` });
      }
      const available = (Number(row.pieces) || 0) - (Number(row.dispatched) || 0);
      if (s.pieces > available) {
        await conn.rollback();
        return res.status(400).json({ error: `Size ${row.size_label}: only ${available} pieces available to dispatch (requested ${s.pieces})` });
      }
      const newTotalSent = (Number(row.dest_dispatched) || 0) + s.pieces;
      inserts.push([fdId, fd.lot_no, dest, row.size_label, s.pieces, newTotalSent, new Date(), new Date()]);
      totalDispatch += s.pieces;
    }

    if (inserts.length) {
      await conn.query(
        `INSERT INTO finishing_dispatches
          (finishing_data_id, lot_no, destination, size_label, quantity, total_sent, sent_at, created_at)
         VALUES ?`,
        [inserts]
      );
    }
    await conn.commit();
    res.json({ success: true, dispatched_total: totalDispatch, destination: dest });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[ERROR] POST /finishingdashboard/event/dispatch =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

router.get('/event/search', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ lots: [] });
    const like = `%${q}%`;
    const [lots] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.remark AS cutting_remark, cl.flow_type,
              u.username AS cutting_master, u.is_denim_cutter
       FROM cutting_lots cl JOIN users u ON u.id = cl.user_id
       WHERE cl.lot_no LIKE ? OR cl.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?
       ORDER BY cl.created_at DESC
       LIMIT 25`,
      [like, like, like, like]
    );
    res.json({ lots });
  } catch (err) {
    console.error('[ERROR] GET /finishing/event/search =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/lot-state/:cuttingLotId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const lotId = parseInt(req.params.cuttingLotId, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) return res.status(400).json({ error: 'Invalid cutting_lot_id' });

    const [[lot]] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.remark AS cutting_remark, cl.flow_type,
              u.username AS cutting_master, u.is_denim_cutter
       FROM cutting_lots cl JOIN users u ON u.id = cl.user_id WHERE cl.id = ?`,
      [lotId]
    );
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    const userId = req.session?.user?.id;
    const aggregates     = await stageEvents.getStageAggregates(pool, STAGE_F, lotId);
    const sizeAggregates = await stageEvents.getStageSizeAggregates(pool, STAGE_F, lotId);
    // Owner-locked: only show this operator's own open approves.
    const openApprovals  = await stageEvents.getOpenApprovals(pool, STAGE_F, lotId, userId);
    const upstreamSizes  = await fUpstreamSizes(pool, lot);
    const upstreamTotal  = upstreamSizes.reduce((a, s) => a + s.available, 0);

    const stageUsers = await getLotStageUsers(pool, { id: lot.id, flow_type: lot.flow_type, cutter_name: lot.cutting_master });

    // Dispatch visibility: where this lot's finished pieces have gone. Dispatches live in
    // finishing_dispatches (not the events ledger), so without this the UI showed nothing
    // after a dispatch.
    const [dispatchSummary] = await pool.query(
      `SELECT destination, SUM(quantity) AS qty, MAX(created_at) AS last_at
         FROM finishing_dispatches WHERE lot_no = ? GROUP BY destination ORDER BY qty DESC`,
      [lot.lot_no]
    );
    const dispatchedTotal = dispatchSummary.reduce((a, d) => a + (Number(d.qty) || 0), 0);

    res.json({
      lot,
      flow_kind: isHosieryLot(lot) ? 'hosiery' : 'denim',
      stage_aggregates: aggregates,
      stage_size_aggregates: sizeAggregates,
      upstream_sizes: upstreamSizes,
      upstream_total_available: upstreamTotal,
      open_approvals: openApprovals,
      stage_users: stageUsers,
      dispatch_summary: dispatchSummary,
      dispatched_total: dispatchedTotal,
    });
  } catch (err) {
    console.error('[ERROR] GET /finishing/event/lot-state =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/event/approve', isAuthenticated, isFinishingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { cutting_lot_id, sizes, rejected_sizes, remark, reject_reason } = req.body;
    const lotId = parseInt(cutting_lot_id, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) return res.status(400).json({ error: 'Invalid cutting_lot_id' });

    const cleanSizes = (Array.isArray(sizes) ? sizes : [])
      .map(s => ({ size_label: String(s.size_label || '').trim(), pieces: Number(s.pieces) || 0 }))
      .filter(s => s.size_label && s.pieces > 0);
    const cleanRejected = (Array.isArray(rejected_sizes) ? rejected_sizes : [])
      .map(s => ({ size_label: String(s.size_label || '').trim(), pieces: Number(s.pieces) || 0 }))
      .filter(s => s.size_label && s.pieces > 0);
    if (!cleanSizes.length && !cleanRejected.length) {
      return res.status(400).json({ error: 'No positive size quantities provided' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[lot]] = await conn.query(
      `SELECT cl.*, u.is_denim_cutter
       FROM cutting_lots cl JOIN users u ON u.id = cl.user_id WHERE cl.id = ?`, [lotId]
    );
    if (!lot) { await conn.rollback(); return res.status(404).json({ error: 'Lot not found' }); }

    const upstream = await fUpstreamSizes(conn, lot);
    const upstreamMap = {};
    for (const r of upstream) upstreamMap[stageEvents.normalizeSizeLabel(r.size_label)] = r.available;

    const labels = new Set([
      ...cleanSizes.map(s => stageEvents.normalizeSizeLabel(s.size_label)),
      ...cleanRejected.map(s => stageEvents.normalizeSizeLabel(s.size_label)),
    ]);
    for (const k of labels) {
      const avail = upstreamMap[k] || 0;
      // Sum ALL entries for this label — .find() counted only the first, so a payload
      // with duplicate labels validated one slice but inserted all of them.
      const taken = cleanSizes.filter(s => stageEvents.normalizeSizeLabel(s.size_label) === k).reduce((a, s) => a + s.pieces, 0);
      const rej   = cleanRejected.filter(s => stageEvents.normalizeSizeLabel(s.size_label) === k).reduce((a, s) => a + s.pieces, 0);
      if (taken + rej > avail) {
        await conn.rollback();
        return res.status(400).json({ error: `Size ${k}: only ${avail} pieces available (requested ${taken + rej} = take ${taken} + reject ${rej})` });
      }
    }

    let approveEventId = null;
    let rejectEventId  = null;

    if (cleanSizes.length) {
      approveEventId = await stageEvents.recordEvent(conn, {
        stage: STAGE_F, cuttingLotId: lotId, eventType: 'approve',
        operatorId: userId, sizes: cleanSizes, parentEventId: null,
        remark: remark ? String(remark).trim() : null,
      });
    }
    if (cleanRejected.length) {
      rejectEventId = await stageEvents.recordEvent(conn, {
        stage: STAGE_F, cuttingLotId: lotId, eventType: 'reject',
        operatorId: userId, sizes: cleanRejected, parentEventId: null,
        remark: reject_reason ? String(reject_reason).trim() : null,
      });
    }

    await conn.commit();

    const totalPieces = cleanSizes.reduce((a, s) => a + s.pieces, 0);
    if (totalPieces > 0) {
      try {
        const payee = await fPickPayeeForLot(pool, lot);
        if (payee) {
          await createStagePayment(payee.stage, {
            lot_no: lot.lot_no, sku: payee.sku || lot.sku, qty: totalPieces,
            user_id: payee.user_id, username: payee.username,
          });
        }
      } catch (payErr) {
        console.error('[WARN] /finishing/event/approve payment failed:', payErr.message);
      }
    }

    res.json({
      success: true,
      event_id: approveEventId,
      reject_event_id: rejectEventId,
      total_pieces: totalPieces,
      rejected_total: cleanRejected.reduce((a, s) => a + s.pieces, 0),
      sizes: cleanSizes,
    });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[ERROR] POST /finishing/event/approve =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/event/complete', isAuthenticated, isFinishingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { parent_event_id, completed_sizes, rejected_sizes, reject_reason, complete_remark } = req.body;
    const parentId = parseInt(parent_event_id, 10);
    if (!Number.isFinite(parentId) || parentId <= 0) return res.status(400).json({ error: 'Invalid parent_event_id' });

    const cleanCompleted = (Array.isArray(completed_sizes) ? completed_sizes : [])
      .map(s => ({ size_label: String(s.size_label || '').trim(), pieces: Number(s.pieces) || 0 }))
      .filter(s => s.size_label && s.pieces > 0);
    const cleanRejected = (Array.isArray(rejected_sizes) ? rejected_sizes : [])
      .map(s => ({ size_label: String(s.size_label || '').trim(), pieces: Number(s.pieces) || 0 }))
      .filter(s => s.size_label && s.pieces > 0);

    if (!cleanCompleted.length && !cleanRejected.length) {
      return res.status(400).json({ error: 'Provide completed and/or rejected sizes' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const { events, eventSizes } = stageEvents.tablesFor(STAGE_F);

    const [[parent]] = await conn.query(
      `SELECT id, cutting_lot_id, event_type, operator_id FROM ${events} WHERE id = ? FOR UPDATE`, [parentId]
    );
    if (!parent || parent.event_type !== 'approve') {
      await conn.rollback();
      return res.status(400).json({ error: 'parent_event_id must reference an approve event' });
    }
    if (parent.operator_id !== userId) {
      await conn.rollback();
      return res.status(403).json({
        error: 'You can only complete pieces against your own approve. Ask the original approver to record the completion.',
      });
    }

    const [parentSizesRows] = await conn.query(
      `SELECT size_label, pieces FROM ${eventSizes} WHERE event_id = ?`, [parentId]
    );
    const parentSizeMap = {};
    for (const r of parentSizesRows) parentSizeMap[r.size_label] = Number(r.pieces) || 0;

    const [childSizesRows] = await conn.query(
      `SELECT s.size_label, e.event_type, SUM(s.pieces) AS pieces
       FROM ${events} e JOIN ${eventSizes} s ON s.event_id = e.id
       WHERE e.parent_event_id = ?
       GROUP BY s.size_label, e.event_type`,
      [parentId]
    );
    const childSizeMap = {};
    for (const r of childSizesRows) {
      if (!childSizeMap[r.size_label]) childSizeMap[r.size_label] = { complete: 0, reject: 0 };
      childSizeMap[r.size_label][r.event_type] = Number(r.pieces) || 0;
    }

    const allLabels = new Set([
      ...cleanCompleted.map(s => s.size_label),
      ...cleanRejected.map(s => s.size_label),
    ]);
    for (const label of allLabels) {
      const approved = parentSizeMap[label] || 0;
      const prev = childSizeMap[label] || { complete: 0, reject: 0 };
      const newC = cleanCompleted.filter(s => s.size_label === label).reduce((a, s) => a + s.pieces, 0);
      const newR = cleanRejected.filter(s => s.size_label === label).reduce((a, s) => a + s.pieces, 0);
      if (prev.complete + prev.reject + newC + newR > approved) {
        await conn.rollback();
        return res.status(400).json({ error: `Size ${label}: total complete+reject exceeds approved ${approved}` });
      }
    }

    let completeEventId = null, rejectEventId = null;
    if (cleanCompleted.length) {
      completeEventId = await stageEvents.recordEvent(conn, {
        stage: STAGE_F, cuttingLotId: parent.cutting_lot_id, eventType: 'complete',
        operatorId: userId, sizes: cleanCompleted, parentEventId: parentId,
        remark: complete_remark ? String(complete_remark).trim() : null,
      });
    }
    if (cleanRejected.length) {
      rejectEventId = await stageEvents.recordEvent(conn, {
        stage: STAGE_F, cuttingLotId: parent.cutting_lot_id, eventType: 'reject',
        operatorId: userId, sizes: cleanRejected, parentEventId: parentId,
        remark: reject_reason ? String(reject_reason).trim() : null,
      });
    }

    if (cleanCompleted.length) {
      const [[lot]] = await conn.query(`SELECT lot_no, sku FROM cutting_lots WHERE id = ?`, [parent.cutting_lot_id]);
      const totalCompleted = cleanCompleted.reduce((a, s) => a + s.pieces, 0);
      const [adResult] = await conn.query(
        `INSERT INTO finishing_data
           (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NOW())`,
        [userId, lot.lot_no, lot.sku, totalCompleted, complete_remark || null]
      );
      const fdId = adResult.insertId;
      const fdSizes = cleanCompleted.map(s => [fdId, s.size_label, s.pieces]);
      await conn.query(
        `INSERT INTO finishing_data_sizes (finishing_data_id, size_label, pieces, created_at)
         VALUES ?`,
        [fdSizes.map(r => [...r, new Date()])]
      );
    }

    await conn.commit();
    res.json({
      success: true,
      complete_event_id: completeEventId, reject_event_id: rejectEventId,
      completed_total: cleanCompleted.reduce((a, s) => a + s.pieces, 0),
      rejected_total: cleanRejected.reduce((a, s) => a + s.pieces, 0),
    });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[ERROR] POST /finishing/event/complete =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

/* =============================================================
   2) LIST EXISTING FINISHING_DATA (AJAX)
   ============================================================= */
router.get('/list-entries', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;
    const limit = 5;
    const likeStr = `%${searchTerm}%`;
    // Fixed: Replace SELECT * with specific columns
    const [rows] = await pool.query(
      `SELECT fd.id, fd.user_id, fd.lot_no, cl.manual_lot_number, fd.sku, fd.total_pieces, fd.created_at,
              cl.remark AS cutting_remark
         FROM finishing_data fd
         LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
        WHERE fd.user_id = ? AND (fd.lot_no LIKE ? OR fd.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
        ORDER BY fd.created_at DESC
        LIMIT ? OFFSET ?`,
      [userId, likeStr, likeStr, likeStr, likeStr, limit, offset]
    );
    if (!rows.length) return res.json({ data: [], hasMore: false });

    const ids = rows.map(r => r.id);
    // Fetch sizes and dispatched totals for all entries at once
    const [sizeRows] = await pool.query(
      `SELECT fds.*, COALESCE(d.qty,0) AS dispatched
         FROM finishing_data_sizes fds
         LEFT JOIN (
             SELECT finishing_data_id, size_label, SUM(quantity) AS qty
               FROM finishing_dispatches
              WHERE finishing_data_id IN (?)
              GROUP BY finishing_data_id, size_label
         ) d ON fds.finishing_data_id=d.finishing_data_id AND fds.size_label=d.size_label
        WHERE fds.finishing_data_id IN (?)`,
      [ids, ids]
    );
    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.finishing_data_id]) sizesMap[s.finishing_data_id] = [];
      sizesMap[s.finishing_data_id].push({ id: s.id, size_label: s.size_label, pieces: s.pieces, dispatched: s.dispatched });
    });
    const dataOut = rows.map(r => {
      const sizes = sizesMap[r.id] || [];
      const fullyDispatched = !sizes.some(sz => sz.dispatched < sz.pieces);
      return { ...r, sizes, fullyDispatched };
    });
    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM finishing_data fd
      LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
      WHERE fd.user_id = ? AND (fd.lot_no LIKE ? OR fd.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
    `, [userId, likeStr, likeStr, likeStr, likeStr]);
    const hasMore = offset + rows.length < totalCount;
    return res.json({ data: dataOut, hasMore });
  } catch (err) {
    console.error('Error finishing list-entries:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* =============================================================
   3) GET ASSIGNMENT SIZES (for Create Entry)
   ============================================================= */
router.get('/get-assignment-sizes/:assignmentId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const assignmentId = req.params.assignmentId;
    // Fixed: Replace SELECT * with specific columns
    const [[fa]] = await pool.query(`
      SELECT id, stitching_assignment_id, washing_in_data_id, sizes_json
      FROM finishing_assignments
      WHERE id = ?
    `, [assignmentId]);
    if (!fa) return res.status(404).json({ error: 'Assignment not found.' });
    let lotNo = null, tableSizes = null, dataIdField = null, dataIdValue = null;
    if (fa.stitching_assignment_id) {
      // Fixed: Replace SELECT * with specific columns
      const [[sd]] = await pool.query(`SELECT id, lot_no FROM stitching_data WHERE id = ?`, [fa.stitching_assignment_id]);
      if (!sd) return res.json([]);
      lotNo = sd.lot_no; tableSizes = 'stitching_data_sizes'; dataIdField = 'stitching_data_id'; dataIdValue = sd.id;
    } else if (fa.washing_in_data_id) {
      // Fixed: Replace SELECT * with specific columns
      const [[wd]] = await pool.query(`SELECT id, lot_no FROM washing_in_data WHERE id = ?`, [fa.washing_in_data_id]);
      if (!wd) return res.json([]);
      lotNo = wd.lot_no; tableSizes = 'washing_in_data_sizes'; dataIdField = 'washing_in_data_id'; dataIdValue = wd.id;
    } else return res.json([]);
    let assignedLabels = [];
    try { assignedLabels = JSON.parse(fa.sizes_json); } catch (e) { assignedLabels = []; }
    if (!Array.isArray(assignedLabels) || !assignedLabels.length) return res.json([]);
    const [deptRows] = await pool.query(`
      SELECT size_label, pieces
      FROM ${tableSizes}
      WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => { deptMap[r.size_label] = r.pieces; });
    // Fetch used count for all labels in a single query
    const [usedRows] = await pool.query(
      `SELECT fds.size_label, SUM(fds.pieces) AS used
         FROM finishing_data_sizes fds
         JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ? AND fds.size_label IN (?)
        GROUP BY fds.size_label`,
      [lotNo, assignedLabels]
    );
    const usedMap = {};
    usedRows.forEach(r => { usedMap[r.size_label] = r.used; });
    const result = assignedLabels.map(lbl => {
      const totalDept = deptMap[lbl] || 0;
      const used = usedMap[lbl] || 0;
      const remain = totalDept - used;
      return { size_label: lbl, total_produced: totalDept, used, remain: remain < 0 ? 0 : remain };
    });
    return res.json(result);
  } catch (err) {
    console.error('Error finishing get-assignment-sizes:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* =============================================================
   4) CREATE FINISHING_DATA (POST /finishingdashboard/create)
   ============================================================= */
router.post('/create', isAuthenticated, isFinishingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { selectedAssignmentId, remark } = req.body;
    const sizesObj = req.body.sizes || {};
    if (!Object.keys(sizesObj).length) {
      req.flash('error', 'No size data provided.');
      return res.redirect('/finishingdashboard');
    }
    let image_url = req.file ? '/uploads/' + req.file.filename : null;
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[fa]] = await conn.query(`
      SELECT *
      FROM finishing_assignments
      WHERE id = ? AND user_id = ? AND is_approved = 1
    `, [selectedAssignmentId, userId]);
    if (!fa) {
      req.flash('error', 'Invalid or unapproved finishing assignment.');
      await conn.rollback(); conn.release();
      return res.redirect('/finishingdashboard');
    }
    let lotNo, sku, tableSizes, dataIdField, dataIdValue;
    if (fa.stitching_assignment_id) {
      const [[sd]] = await conn.query(`SELECT * FROM stitching_data WHERE id = ?`, [fa.stitching_assignment_id]);
      if (!sd) {
        req.flash('error', 'Stitching data not found.');
        await conn.rollback(); conn.release();
        return res.redirect('/finishingdashboard');
      }
      lotNo = sd.lot_no; sku = sd.sku;
      tableSizes = 'stitching_data_sizes'; dataIdField = 'stitching_data_id'; dataIdValue = sd.id;
    } else if (fa.washing_in_data_id) {
      const [[wd]] = await conn.query(`SELECT * FROM washing_in_data WHERE id = ?`, [fa.washing_in_data_id]);
      if (!wd) {
        req.flash('error', 'Washing data not found.');
        await conn.rollback(); conn.release();
        return res.redirect('/finishingdashboard');
      }
      lotNo = wd.lot_no; sku = wd.sku;
      tableSizes = 'washing_in_data_sizes'; dataIdField = 'washing_in_data_id'; dataIdValue = wd.id;
    } else {
      req.flash('error', 'Assignment not linked to stitching or washing.');
      await conn.rollback(); conn.release();
      return res.redirect('/finishingdashboard');
    }
    const [[alreadyUsed]] = await conn.query(`SELECT COUNT(*) as cnt FROM finishing_data WHERE lot_no = ?`, [lotNo]);
    if (alreadyUsed.cnt > 0) {
      req.flash('error', 'This lot no is already used in finishing_data.');
      await conn.rollback(); conn.release();
      return res.redirect('/finishingdashboard');
    }
    const [deptRows] = await conn.query(
      `SELECT size_label, pieces FROM ${tableSizes} WHERE ${dataIdField} = ?`,
      [dataIdValue]
    );
    const deptMap = {};
    deptRows.forEach(r => { deptMap[r.size_label] = r.pieces; });

    const labels = Object.keys(sizesObj);
    const [usedRows] = await conn.query(
      `SELECT fds.size_label, SUM(fds.pieces) AS used
         FROM finishing_data_sizes fds
         JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ? AND fds.size_label IN (?)
        GROUP BY fds.size_label`,
      [lotNo, labels]
    );
    const usedMap = {};
    usedRows.forEach(r => { usedMap[r.size_label] = r.used; });

    let grandTotal = 0;
    for (const label of labels) {
      const requested = parseInt(sizesObj[label], 10);
      if (isNaN(requested) || requested < 0) {
        req.flash('error', `Invalid count for size ${label}`);
        await conn.rollback(); conn.release();
        return res.redirect('/finishingdashboard');
      }
      if (requested === 0) continue;
      const totalDept = deptMap[label] || 0;
      const used = usedMap[label] || 0;
      const remain = totalDept - used;
      if (requested > remain) {
        req.flash('error', `Cannot request ${requested} for size ${label}; only ${remain} remain.`);
        await conn.rollback(); conn.release();
        return res.redirect('/finishingdashboard');
      }
      grandTotal += requested;
    }
    if (grandTotal <= 0) {
      req.flash('error', 'No positive piece count provided.');
      await conn.rollback(); conn.release();
      return res.redirect('/finishingdashboard');
    }
    const [ins] = await conn.query(
      `INSERT INTO finishing_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [userId, lotNo, sku, grandTotal, remark || null, image_url]
    );
    const newId = ins.insertId;
    const sizeInserts = [];
    for (const label of labels) {
      const requested = parseInt(sizesObj[label], 10) || 0;
      if (requested > 0) sizeInserts.push([newId, label, requested, new Date()]);
    }
    if (sizeInserts.length) {
      await conn.query(
        'INSERT INTO finishing_data_sizes (finishing_data_id, size_label, pieces, created_at) VALUES ?',
        [sizeInserts]
      );
    }
    await conn.commit();
    conn.release();
    req.flash('success', 'Finishing entry created successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error creating finishing data:', err);
    if (conn) { await conn.rollback(); conn.release(); }
    req.flash('error', 'Error creating finishing data: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/* =============================================================
   5) OLD APPROVAL ROUTES REMOVED (2026-04-23)
   Now using self-assign flow: /available-lots + /submit
   See git history if rollback needed
   ============================================================= */

/* =============================================================
   6) UPDATE / CHALLAN / DOWNLOAD
   ============================================================= */
router.get('/update/:id/json', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const [[entry]] = await pool.query(`
      SELECT * FROM finishing_data WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) return res.status(403).json({ error: 'Not found or no permission' });
    const [sizes] = await pool.query(`
      SELECT * FROM finishing_data_sizes WHERE finishing_data_id = ?
    `, [entryId]);
    let tableSizes, dataIdField, dataIdValue;
    const [[sd]] = await pool.query(`
      SELECT * FROM stitching_data WHERE lot_no = ? ORDER BY id DESC LIMIT 1
    `, [entry.lot_no]);
    if (sd) {
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      dataIdValue = sd.id;
    } else {
      const [[wd]] = await pool.query(`
        SELECT * FROM washing_in_data WHERE lot_no = ? ORDER BY id DESC LIMIT 1
      `, [entry.lot_no]);
      if (wd) {
        tableSizes = 'washing_in_data_sizes';
        dataIdField = 'washing_in_data_id';
        dataIdValue = wd.id;
      } else {
        const outNoRemain = sizes.map(sz => ({ ...sz, remain: 0 }));
        return res.json({ sizes: outNoRemain, fullyDispatched: true });
      }
    }
    const [deptRows] = await pool.query(`
      SELECT size_label, pieces FROM ${tableSizes} WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => { deptMap[r.size_label] = r.pieces; });
    const output = [];
    let allDispatched = true;
    for (const sz of sizes) {
      const totalDept = deptMap[sz.size_label] || 0;
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(fds.pieces),0) AS usedCount
        FROM finishing_data_sizes fds JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ? AND fds.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;
      if (remain > 0) allDispatched = false;
      output.push({ ...sz, remain: remain < 0 ? 0 : remain });
    }
    return res.json({ sizes: output, fullyDispatched: allDispatched });
  } catch (err) {
    console.error('Error finishing update JSON:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/update/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const updateSizes = req.body.updateSizes || {};
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[entry]] = await conn.query(`
      SELECT * FROM finishing_data WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Record not found or no permission.');
      await conn.rollback(); conn.release();
      return res.redirect('/finishingdashboard');
    }
    let tableSizes, dataIdField, dataIdValue;
    const [[sd]] = await conn.query(`
      SELECT * FROM stitching_data WHERE lot_no = ? LIMIT 1
    `, [entry.lot_no]);
    if (sd) {
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      dataIdValue = sd.id;
    } else {
      const [[wd]] = await conn.query(`
        SELECT * FROM washing_in_data WHERE lot_no = ? LIMIT 1
      `, [entry.lot_no]);
      if (wd) {
        tableSizes = 'washing_in_data_sizes';
        dataIdField = 'washing_in_data_id';
        dataIdValue = wd.id;
      } else {
        req.flash('error', 'No matching departmental data found.');
        await conn.rollback(); conn.release();
        return res.redirect('/finishingdashboard');
      }
    }
    const [deptRows] = await conn.query(`
      SELECT size_label, pieces FROM ${tableSizes} WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => { deptMap[r.size_label] = r.pieces; });
    let updatedTotal = parseFloat(entry.total_pieces);
    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;
      const totalDept = deptMap[lbl] || 0;
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(fds.pieces),0) AS usedCount
        FROM finishing_data_sizes fds JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ? AND fds.size_label = ?
      `, [entry.lot_no, lbl]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;
      if (increment > remain) throw new Error(`Cannot add ${increment} for size ${lbl}, only ${remain} remain.`);
      const [[existing]] = await conn.query(`
        SELECT * FROM finishing_data_sizes WHERE finishing_data_id = ? AND size_label = ?
      `, [entryId, lbl]);
      if (!existing) {
        await conn.query(`
          INSERT INTO finishing_data_sizes (finishing_data_id, size_label, pieces, created_at)
          VALUES (?, ?, ?, NOW())
        `, [entryId, lbl, increment]);
        updatedTotal += increment;
      } else {
        const newCount = existing.pieces + increment;
        await conn.query(`
          UPDATE finishing_data_sizes SET pieces = ? WHERE id = ?
        `, [newCount, existing.id]);
        updatedTotal += increment;
      }
      await conn.query(`
        INSERT INTO finishing_data_updates (finishing_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
    }
    await conn.query(`
      UPDATE finishing_data SET total_pieces = ? WHERE id = ?
    `, [updatedTotal, entryId]);
    await conn.commit();
    conn.release();
    req.flash('success', 'Finishing data updated successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error updating finishing data:', err);
    if (conn) { await conn.rollback(); conn.release(); }
    req.flash('error', 'Error updating finishing data: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

router.get('/challan/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const [[row]] = await pool.query(`
      SELECT fd.*, cl.remark AS cutting_remark, cl.manual_lot_number
      FROM finishing_data fd
      LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
      WHERE fd.id = ? AND fd.user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/finishingdashboard');
    }
    const [sizes] = await pool.query(`
      SELECT fds.*,
             COALESCE(d.dispatched, 0) AS dispatched,
             COALESCE(d.destinations, '') AS destinations
      FROM finishing_data_sizes fds
      LEFT JOIN (
        SELECT size_label, SUM(quantity) AS dispatched,
               GROUP_CONCAT(DISTINCT destination ORDER BY sent_at DESC SEPARATOR ', ') AS destinations
        FROM finishing_dispatches
        WHERE finishing_data_id = ?
        GROUP BY size_label
      ) d ON fds.size_label = d.size_label
      WHERE fds.finishing_data_id = ?
      ORDER BY fds.id ASC
    `, [entryId, entryId]);
    const [updates] = await pool.query(`
      SELECT * FROM finishing_data_updates WHERE finishing_data_id = ? ORDER BY updated_at ASC
    `, [entryId]);
    const [dispatches] = await pool.query(`
      SELECT destination, sent_at
      FROM finishing_dispatches
      WHERE finishing_data_id = ?
      ORDER BY sent_at ASC
    `, [entryId]);
    return res.render('finishingChallan', { user: req.session.user, entry: row, sizes, updates, dispatches });
  } catch (err) {
    console.error('Error finishing challan:', err);
    req.flash('error', 'Error loading finishing challan: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

router.get('/download-all', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [mainRows] = await pool.query(`
      SELECT fd.*, cl.lot_no as cutting_lot_no
      FROM finishing_data fd
      LEFT JOIN cutting_lots cl ON fd.lot_no = cl.lot_no
      WHERE fd.user_id = ?
      ORDER BY fd.created_at ASC
    `, [userId]);
    const [allSizes] = await pool.query(`
      SELECT fds.*, fd.lot_no,
             COALESCE(d.dispatched, 0) AS dispatched,
             COALESCE(d.destinations, '') AS destinations
      FROM finishing_data_sizes fds
      JOIN finishing_data fd ON fd.id = fds.finishing_data_id
      LEFT JOIN (
        SELECT finishing_data_id, size_label, SUM(quantity) AS dispatched,
               GROUP_CONCAT(DISTINCT destination ORDER BY sent_at DESC SEPARATOR ', ') AS destinations
        FROM finishing_dispatches
        GROUP BY finishing_data_id, size_label
      ) d ON fds.finishing_data_id = d.finishing_data_id AND fds.size_label = d.size_label
      WHERE fd.user_id = ?
      ORDER BY fds.finishing_data_id, fds.id
    `, [userId]);
    const [dispatchRows] = await pool.query(`
      SELECT d.finishing_data_id, d.lot_no, fd.sku, d.destination, d.size_label, d.quantity, d.sent_at
      FROM finishing_dispatches d
      JOIN finishing_data fd ON fd.id = d.finishing_data_id
      WHERE fd.user_id = ?
      ORDER BY d.finishing_data_id, d.id
    `, [userId]);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();
    const mainSheet = workbook.addWorksheet('FinishingData');
    mainSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 12 },
      { header: 'Remark', key: 'remark', width: 25 },
      { header: 'Image URL', key: 'image_url', width: 25 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];
    mainRows.forEach(r => {
      mainSheet.addRow({ id: r.id, lot_no: r.lot_no, sku: r.sku, total_pieces: r.total_pieces, remark: r.remark || '', image_url: r.image_url || '', created_at: r.created_at });
    });
    const sizesSheet = workbook.addWorksheet('FinishingSizes');
    sizesSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Finishing ID', key: 'finishing_data_id', width: 12 },
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Finished', key: 'pieces', width: 10 },
      { header: 'Dispatched', key: 'dispatched', width: 12 },
      { header: 'Pending', key: 'pending', width: 10 },
      { header: 'Destination', key: 'destinations', width: 25 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        finishing_data_id: s.finishing_data_id,
        lot_no: s.lot_no,
        size_label: s.size_label,
        pieces: s.pieces,
        dispatched: s.dispatched || 0,
        pending: s.pieces - (s.dispatched || 0),
        destinations: s.destinations || '',
        created_at: s.created_at
      });
    });
    const dispatchSheet = workbook.addWorksheet('FinishingDispatches');
    dispatchSheet.columns = [
      { header: 'Finishing ID', key: 'finishing_data_id', width: 12 },
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Destination', key: 'destination', width: 20 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Sent At', key: 'sent_at', width: 20 }
    ];
    dispatchRows.forEach(d => {
      dispatchSheet.addRow({ finishing_data_id: d.finishing_data_id, lot_no: d.lot_no, sku: d.sku, destination: d.destination, size_label: d.size_label, quantity: d.quantity, sent_at: d.sent_at });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="FinishingData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('Error finishing download-all:', err);
    req.flash('error', 'Could not download finishing Excel: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/* =============================================================
   7) DISPATCH ROUTES
   ============================================================= */
router.get('/dispatch/:id/json', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const [[entry]] = await pool.query(`
      SELECT * FROM finishing_data WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) return res.status(403).json({ error: 'Not found or no permission' });
    const [sizes] = await pool.query(
      `SELECT fds.*, COALESCE(d.qty,0) AS dispatched
         FROM finishing_data_sizes fds
         LEFT JOIN (
           SELECT size_label, SUM(quantity) AS qty
             FROM finishing_dispatches
            WHERE finishing_data_id = ?
            GROUP BY size_label
         ) d ON fds.size_label = d.size_label
        WHERE fds.finishing_data_id = ?`,
      [entryId, entryId]
    );
    let allDispatched = true;
    const dispatchData = sizes.map(sz => {
      const available = sz.pieces - sz.dispatched;
      if (available > 0) allDispatched = false;
      return {
        size_label: sz.size_label,
        total_produced: sz.pieces,
        dispatched: sz.dispatched,
        available: available < 0 ? 0 : available
      };
    });
    return res.json({ sizes: dispatchData, lot_no: entry.lot_no, fullyDispatched: allDispatched });
  } catch (err) {
    console.error('Error in dispatch JSON:', err);
    return res.status(500).json({ error: err.message });
  }
});

  router.post('/dispatch/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    console.log('Dispatch request received', {
      entryId,
      body: req.body,
    });
    let destination = req.body.destination;
    if (destination === 'other') {
      destination = req.body.customDestination;
      if (!destination) {
        req.flash('error', 'Please enter a custom destination.');
        return res.redirect('/finishingdashboard');
      }
    }

    let rawDispatch = req.body.dispatchSizes || {};
    const hasQtyRaw = (Array.isArray(rawDispatch) ? rawDispatch : Object.values(rawDispatch))
      .some(v => {
        const n = parseInt(v, 10);
        return !isNaN(n) && n > 0;
      });
    if (!hasQtyRaw) {
      req.flash('error', 'No dispatch quantities provided.');
      return res.redirect('/finishingdashboard');
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[entry]] = await conn.query(
      'SELECT * FROM finishing_data WHERE id = ? AND user_id = ?',
      [entryId, userId]
    );
    if (!entry) {
      req.flash('error', 'Record not found or no permission.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }
    const [sizeRows] = await conn.query(
      `SELECT fds.id, fds.size_label, fds.pieces,
              COALESCE(d.qty,0) AS dispatched,
              COALESCE(dDest.qty,0) AS dest_dispatched
         FROM finishing_data_sizes fds
         LEFT JOIN (
             SELECT size_label, SUM(quantity) AS qty
               FROM finishing_dispatches
              WHERE finishing_data_id = ?
              GROUP BY size_label
         ) d ON fds.size_label = d.size_label
         LEFT JOIN (
             SELECT size_label, SUM(quantity) AS qty
               FROM finishing_dispatches
              WHERE finishing_data_id = ? AND destination = ?
              GROUP BY size_label
         ) dDest ON fds.size_label = dDest.size_label
        WHERE fds.finishing_data_id = ?
        ORDER BY fds.id`,
      [entryId, entryId, destination, entryId]
    );

    // Normalize dispatch sizes so that we always work with an object keyed by label
    const dispatchSizes = {};
    if (Array.isArray(rawDispatch)) {
      console.log('Dispatch sizes received as array', rawDispatch);
      rawDispatch.forEach((val, idx) => {
        if (sizeRows[idx]) dispatchSizes[sizeRows[idx].size_label] = val;
      });
    } else if (rawDispatch && typeof rawDispatch === 'object') {
      Object.assign(dispatchSizes, rawDispatch);
    } else {
      for (const key of Object.keys(req.body)) {
        const match = /^dispatchSizes\[(.+)\]$/.exec(key);
        if (match) dispatchSizes[match[1]] = req.body[key];
      }
    }

    console.log('Normalized dispatch sizes', dispatchSizes);

    const hasQty = Object.values(dispatchSizes).some((v) => {
      const n = parseInt(v, 10);
      return !isNaN(n) && n > 0;
    });
    if (!hasQty) {
      req.flash('error', 'No dispatch quantities provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }
    const dispatchInserts = [];
    for (const sz of sizeRows) {
      const size = sz.size_label;
      const qty = parseInt(dispatchSizes[size], 10);
      if (isNaN(qty) || qty <= 0) continue;

      const available = sz.pieces - sz.dispatched;
      if (qty > available) {
        req.flash('error', `Cannot dispatch ${qty} for size ${size}; only ${available} available.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }

      const newTotalSent = sz.dest_dispatched + qty;
      dispatchInserts.push([entryId, entry.lot_no, destination, size, qty, newTotalSent, new Date(), new Date()]);
    }

    if (dispatchInserts.length) {
      await conn.query(
        'INSERT INTO finishing_dispatches (finishing_data_id, lot_no, destination, size_label, quantity, total_sent, sent_at, created_at) VALUES ?',
        [dispatchInserts]
      );
    }
    await conn.commit();
    conn.release();
    console.log('Dispatch processed successfully for entry', entryId);
    req.flash('success', 'Dispatch recorded successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error processing dispatch:', err);
    if (conn) { await conn.rollback(); conn.release(); }
    req.flash('error', 'Error processing dispatch: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

router.post('/dispatch-all/:id', isFinishingMaster, isAuthenticated, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    let destination = req.body.destination;
    if (destination === 'other') {
      destination = req.body.customDestination;
      if (!destination) {
        req.flash('error', 'Please enter a custom destination.');
        return res.redirect('/finishingdashboard');
      }
    }
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[entry]] = await conn.query(`
      SELECT * FROM finishing_data WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Record not found or no permission.');
      await conn.rollback(); conn.release();
      return res.redirect('/finishingdashboard');
    }
    const [sizes] = await conn.query(
      `SELECT fds.size_label, fds.pieces,
              COALESCE(d.qty,0) AS dispatched,
              COALESCE(dDest.qty,0) AS dest_dispatched
         FROM finishing_data_sizes fds
         LEFT JOIN (
             SELECT size_label, SUM(quantity) AS qty
               FROM finishing_dispatches
              WHERE finishing_data_id = ?
              GROUP BY size_label
         ) d ON fds.size_label = d.size_label
         LEFT JOIN (
             SELECT size_label, SUM(quantity) AS qty
               FROM finishing_dispatches
              WHERE finishing_data_id = ? AND destination = ?
              GROUP BY size_label
         ) dDest ON fds.size_label = dDest.size_label
        WHERE fds.finishing_data_id = ?`,
      [entryId, entryId, destination, entryId]
    );
    const inserts = [];
    for (const sz of sizes) {
      const available = sz.pieces - sz.dispatched;
      if (available <= 0) continue;
      const newTotalSent = sz.dest_dispatched + available;
      inserts.push([entryId, entry.lot_no, destination, sz.size_label, available, newTotalSent, new Date(), new Date()]);
    }
    if (inserts.length) {
      await conn.query(
        'INSERT INTO finishing_dispatches (finishing_data_id, lot_no, destination, size_label, quantity, total_sent, sent_at, created_at) VALUES ?',
        [inserts]
      );
    }
    await conn.commit();
    conn.release();
    req.flash('success', 'Bulk dispatch recorded successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error in bulk dispatch:', err);
    if (conn) { await conn.rollback(); conn.release(); }
    req.flash('error', 'Error in bulk dispatch: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/* =============================================================
   8) BULK DISPATCH VIA EXCEL
   ============================================================= */
router.get('/download-bulk-template', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('BulkDispatchTemplate');
    sheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Destination', key: 'destination', width: 15 },
      { header: 'S', key: 'S', width: 8 },
      { header: 'M', key: 'M', width: 8 },
      { header: 'L', key: 'L', width: 8 },
      { header: 'XL', key: 'XL', width: 8 }
    ];
    res.setHeader('Content-Disposition', 'attachment; filename="BulkDispatchTemplate.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('Error downloading bulk template:', err);
    req.flash('error', 'Error downloading bulk template: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

router.post('/bulk-dispatch-excel', isAuthenticated, isFinishingMaster, upload.single('excel_file'), async (req, res) => {
  let conn;
  try {
    if (!req.file) {
      req.flash('error', 'Please upload an Excel file.');
      return res.redirect('/finishingdashboard');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.getWorksheet('BulkDispatchTemplate') || workbook.worksheets[0];

    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push({
        lotNo: row.getCell('A').value,
        destination: row.getCell('B').value,
        sizes: {
          S: parseInt(row.getCell('C').value || 0, 10),
          M: parseInt(row.getCell('D').value || 0, 10),
          L: parseInt(row.getCell('E').value || 0, 10),
          XL: parseInt(row.getCell('F').value || 0, 10)
        }
      });
    });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    for (const r of rows) {
      let destination = r.destination === 'other' ? 'other' : r.destination;
      const [[entry]] = await conn.query('SELECT id, lot_no FROM finishing_data WHERE lot_no = ?', [r.lotNo]);
      if (!entry) continue;

      const [sizeInfo] = await conn.query(
        `SELECT fds.size_label, fds.pieces,
                COALESCE(d.qty,0) AS dispatched,
                COALESCE(dDest.qty,0) AS dest_dispatched
           FROM finishing_data_sizes fds
           LEFT JOIN (
               SELECT size_label, SUM(quantity) AS qty
                 FROM finishing_dispatches
                WHERE finishing_data_id = ?
                GROUP BY size_label
           ) d ON fds.size_label = d.size_label
           LEFT JOIN (
               SELECT size_label, SUM(quantity) AS qty
                 FROM finishing_dispatches
                WHERE finishing_data_id = ? AND destination = ?
                GROUP BY size_label
           ) dDest ON fds.size_label = dDest.size_label
          WHERE fds.finishing_data_id = ?`,
        [entry.id, entry.id, destination, entry.id]
      );

      const inserts = [];
      for (const sz of sizeInfo) {
        const qty = parseInt(r.sizes[sz.size_label], 10);
        if (!qty || qty <= 0) continue;
        const available = sz.pieces - sz.dispatched;
        if (qty > available) continue;
        const newTotalSent = sz.dest_dispatched + qty;
        inserts.push([entry.id, entry.lot_no, destination, sz.size_label, qty, newTotalSent, new Date(), new Date()]);
      }
      if (inserts.length) {
        await conn.query(
          'INSERT INTO finishing_dispatches (finishing_data_id, lot_no, destination, size_label, quantity, total_sent, sent_at, created_at) VALUES ?',
          [inserts]
        );
      }
    }

    await conn.commit();
    conn.release();
    req.flash('success', 'Bulk dispatch via Excel processed successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error in bulk dispatch via Excel:', err);
    if (conn) { await conn.rollback(); conn.release(); }
    req.flash('error', 'Error in bulk dispatch via Excel: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/*-----------------------------------------
  SELF-ASSIGN FLOW (Stitching-style)
  Worker picks available lot + submits in one step
  Finishing receives from two sources:
  - Hosiery: stitching_data (no washing stages)
  - Denim: washing_in_data
-----------------------------------------*/

// GET /finishingdashboard/available-lots
// Shows lots that haven't been finished yet - both hosiery (from stitching) and denim (from washing_in)
router.get('/available-lots', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : '%';

    // Hosiery lots: from stitching_data where flow_type is hosiery and not yet in finishing
    const [hosieryRows] = await pool.query(`
      SELECT
        sd.id,
        sd.lot_no,
        cl.manual_lot_number,
        sd.sku,
        sd.total_pieces,
        sd.created_at,
        cl.remark AS cutting_remark,
        'hosiery' AS source_type,
        'stitching' AS source_stage,
        u.username AS source_master,
        sd.total_pieces - COALESCE((
          SELECT SUM(fd.total_pieces)
          FROM finishing_data fd
          WHERE fd.lot_no = sd.lot_no
        ), 0) AS remaining_pieces
      FROM stitching_data sd
      JOIN users u ON sd.user_id = u.id
      LEFT JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
      WHERE (sd.lot_no LIKE ? OR sd.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
        AND (
          cl.flow_type = 'hosiery'
          OR (cl.flow_type IS NULL AND NOT EXISTS (
            SELECT 1 FROM users cu
            WHERE cu.id = cl.user_id AND cu.is_denim_cutter = 1
          ))
          OR (cl.flow_type IS NULL AND cl.user_id IS NULL AND sd.lot_no NOT REGEXP '^(AK|UM)')
        )
      HAVING remaining_pieces > 0
      ORDER BY sd.created_at DESC
      LIMIT 25
    `, [search, search, search, search]);

    // Denim lots: from washing_in_data where flow_type is denim and not yet in finishing
    const [denimRows] = await pool.query(`
      SELECT
        wid.id,
        wid.lot_no,
        cl.manual_lot_number,
        wid.sku,
        wid.total_pieces,
        wid.created_at,
        cl.remark AS cutting_remark,
        'denim' AS source_type,
        'washing_in' AS source_stage,
        u.username AS source_master,
        wid.total_pieces - COALESCE((
          SELECT SUM(fd.total_pieces)
          FROM finishing_data fd
          WHERE fd.lot_no = wid.lot_no
        ), 0) AS remaining_pieces
      FROM washing_in_data wid
      JOIN users u ON wid.user_id = u.id
      LEFT JOIN cutting_lots cl ON cl.lot_no = wid.lot_no
      WHERE (wid.lot_no LIKE ? OR wid.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
        AND (
          cl.flow_type = 'denim'
          OR EXISTS (
            SELECT 1 FROM users cu
            WHERE cu.id = cl.user_id AND cu.is_denim_cutter = 1
          )
          OR wid.lot_no REGEXP '^(AK|UM)'
        )
      HAVING remaining_pieces > 0
      ORDER BY wid.created_at DESC
      LIMIT 25
    `, [search, search, search, search]);

    const allRows = [...hosieryRows, ...denimRows].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    ).slice(0, 50);

    return res.json({ data: allRows });
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/available-lots =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /finishingdashboard/available-lot-sizes/:sourceType/:lotId
// Get sizes for a specific lot (hosiery from stitching_data, denim from washing_in_data)
router.get('/available-lot-sizes/:sourceType/:lotId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const { sourceType, lotId } = req.params;

    let lotNo, tableSizes, dataIdField;

    if (sourceType === 'hosiery') {
      const [[sd]] = await pool.query(`SELECT * FROM stitching_data WHERE id = ?`, [lotId]);
      if (!sd) return res.status(404).json({ error: 'Lot not found' });
      lotNo = sd.lot_no;
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
    } else {
      const [[wid]] = await pool.query(`SELECT * FROM washing_in_data WHERE id = ?`, [lotId]);
      if (!wid) return res.status(404).json({ error: 'Lot not found' });
      lotNo = wid.lot_no;
      tableSizes = 'washing_in_data_sizes';
      dataIdField = 'washing_in_data_id';
    }

    const [rows] = await pool.query(`
      SELECT
        s.id,
        s.size_label,
        s.pieces,
        s.pieces - COALESCE((
          SELECT SUM(fds.pieces)
          FROM finishing_data_sizes fds
          JOIN finishing_data fd ON fds.finishing_data_id = fd.id
          WHERE fd.lot_no = ? AND fds.size_label = s.size_label
        ), 0) AS remain
      FROM ${tableSizes} s
      WHERE s.${dataIdField} = ?
    `, [lotNo, lotId]);

    return res.json(rows.map(r => ({
      id: r.id,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    })));
  } catch (err) {
    console.error('[ERROR] GET /finishingdashboard/available-lot-sizes =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /finishingdashboard/submit
// Self-assign + complete finishing in one step (stitching-style flow)
router.post('/submit', isAuthenticated, isFinishingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const username = req.session.user.username;
    const { selectedLotId, sourceType, remark, destination, destination_remark } = req.body;
    const sizesObj = req.body.sizes || {};

    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    // Calculate total pieces
    let grandTotal = 0;
    for (const sizeLabel of Object.keys(sizesObj)) {
      const countVal = parseInt(sizesObj[sizeLabel], 10);
      if (!isNaN(countVal) && countVal > 0) {
        grandTotal += countVal;
      }
    }
    if (grandTotal <= 0) {
      return res.status(400).json({ error: 'No pieces requested.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let lotNo, sku, sourceDataId, tableSizes, dataIdField, previousStageMasterId, previousStageUsername;

    if (sourceType === 'hosiery') {
      const [[sd]] = await conn.query(`
        SELECT sd.*, u.username AS stitcher_username
        FROM stitching_data sd
        JOIN users u ON sd.user_id = u.id
        WHERE sd.id = ?
      `, [selectedLotId]);
      if (!sd) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: 'Invalid lot selection.' });
      }
      lotNo = sd.lot_no;
      sku = sd.sku;
      sourceDataId = sd.id;
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      previousStageMasterId = sd.user_id;
      previousStageUsername = sd.stitcher_username;
    } else {
      const [[wid]] = await conn.query(`
        SELECT wid.*, u.username AS washingin_master_username
        FROM washing_in_data wid
        JOIN users u ON wid.user_id = u.id
        WHERE wid.id = ?
      `, [selectedLotId]);
      if (!wid) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: 'Invalid lot selection.' });
      }
      lotNo = wid.lot_no;
      sku = wid.sku;
      sourceDataId = wid.id;
      tableSizes = 'washing_in_data_sizes';
      dataIdField = 'washing_in_data_id';
      previousStageMasterId = wid.user_id;
      previousStageUsername = wid.washingin_master_username;
    }

    // Validate sizes against available pieces
    const [deptRows] = await conn.query(
      `SELECT size_label, pieces FROM ${tableSizes} WHERE ${dataIdField} = ?`,
      [sourceDataId]
    );
    const deptMap = {};
    deptRows.forEach(r => { deptMap[r.size_label] = r.pieces; });

    const labels = Object.keys(sizesObj).filter(l => parseInt(sizesObj[l], 10) > 0);
    const [usedRows] = await conn.query(
      `SELECT fds.size_label, SUM(fds.pieces) AS used
       FROM finishing_data_sizes fds
       JOIN finishing_data fd ON fd.id = fds.finishing_data_id
       WHERE fd.lot_no = ? AND fds.size_label IN (?)
       GROUP BY fds.size_label`,
      [lotNo, labels.length ? labels : ['']]
    );
    const usedMap = {};
    usedRows.forEach(r => { usedMap[r.size_label] = r.used; });

    for (const label of labels) {
      const requested = parseInt(sizesObj[label], 10);
      const totalDept = deptMap[label] || 0;
      const used = usedMap[label] || 0;
      const remain = totalDept - used;
      if (requested > remain) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: `Cannot request ${requested} for size ${label}; only ${remain} remain.` });
      }
    }

    // Create finishing_assignments record (auto-approved)
    const sizesJson = JSON.stringify(labels);
    const assignmentFields = sourceType === 'hosiery'
      ? `(stitching_master_id, user_id, stitching_assignment_id, assigned_on, sizes_json, is_approved, approved_on)`
      : `(washing_in_master_id, user_id, washing_in_data_id, assigned_on, sizes_json, is_approved, approved_on)`;

    await conn.query(`
      INSERT INTO finishing_assignments ${assignmentFields}
      VALUES (?, ?, ?, NOW(), ?, 1, NOW())
    `, [previousStageMasterId, userId, sourceDataId, sizesJson]);

    // Insert finishing_data
    const [ins] = await conn.query(
      `INSERT INTO finishing_data (user_id, lot_no, sku, total_pieces, remark, image_url, destination, destination_remark, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, lotNo, sku, grandTotal, remark || null, image_url, destination || null, destination_remark || null]
    );
    const newId = ins.insertId;

    // Insert finishing_data_sizes
    const sizeInserts = [];
    for (const label of labels) {
      const requested = parseInt(sizesObj[label], 10) || 0;
      if (requested > 0) sizeInserts.push([newId, label, requested, new Date()]);
    }
    if (sizeInserts.length) {
      await conn.query(
        'INSERT INTO finishing_data_sizes (finishing_data_id, size_label, pieces, created_at) VALUES ?',
        [sizeInserts]
      );
    }

    // Auto-create payment for previous stage
    if (sourceType === 'hosiery') {
      // Hosiery: pay stitching master
      await createStagePayment('stitching', {
        lot_no: lotNo,
        sku: sku,
        qty: grandTotal,
        user_id: previousStageMasterId,
        username: previousStageUsername
      });
    } else {
      // Denim: pay washing_in master
      await createStagePayment('washing_in', {
        lot_no: lotNo,
        sku: sku,
        qty: grandTotal,
        user_id: previousStageMasterId,
        username: previousStageUsername
      });
    }

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      message: 'Finishing entry created successfully!',
      finishingDataId: newId
    });
  } catch (err) {
    console.error('[ERROR] POST /finishingdashboard/submit =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    return res.status(500).json({ error: 'Error creating finishing data: ' + err.message });
  }
});

// GET /finishingdashboard/my-today
router.get('/my-today', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [rows] = await pool.query(`
      SELECT id, lot_no, sku, total_pieces, created_at
      FROM finishing_data
      WHERE user_id = ? AND DATE(created_at) = CURDATE()
      ORDER BY created_at DESC
    `, [userId]);

    return res.json({
      entries: rows,
      total_pieces: rows.reduce((sum, r) => sum + r.total_pieces, 0),
      count: rows.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /finishingdashboard/my-entries
router.get('/my-entries', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = `
      SELECT fd.id, fd.lot_no, fd.sku, fd.total_pieces, fd.created_at, cl.remark as cutting_remark
      FROM finishing_data fd
      LEFT JOIN cutting_lots cl ON fd.lot_no = cl.lot_no
      WHERE fd.user_id = ? AND (fd.lot_no LIKE ? OR fd.sku LIKE ?)
    `;
    const params = [userId, search, search];

    if (startDate) { query += ` AND DATE(fd.created_at) >= ?`; params.push(startDate); }
    if (endDate) { query += ` AND DATE(fd.created_at) <= ?`; params.push(endDate); }
    query += ` ORDER BY fd.created_at DESC LIMIT 20 OFFSET ?`;
    params.push(offset);

    const [rows] = await pool.query(query, params);
    return res.json({ entries: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /finishingdashboard/lot-details/:lotNo
router.get('/lot-details/:lotNo', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const lotNo = req.params.lotNo;
    const userId = req.session.user.id;

    const [[cuttingLot]] = await pool.query(`
      SELECT cl.*, u.username as cutting_master_name
      FROM cutting_lots cl
      LEFT JOIN users u ON cl.user_id = u.id
      WHERE cl.lot_no = ?
    `, [lotNo]);

    if (!cuttingLot) {
      return res.status(404).json({ error: 'Lot not found' });
    }

    const [cuttingSizes] = await pool.query(`
      SELECT size_label, SUM(total_pieces) as pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ? GROUP BY size_label
    `, [cuttingLot.id]);

    const [[finishingData]] = await pool.query(`
      SELECT fd.*, u.username as finishing_master_name
      FROM finishing_data fd
      LEFT JOIN users u ON fd.user_id = u.id
      WHERE fd.lot_no = ? AND fd.user_id = ?
    `, [lotNo, userId]);

    let finishingSizes = [];
    if (finishingData) {
      const [sizes] = await pool.query(`
        SELECT size_label, pieces FROM finishing_data_sizes WHERE finishing_data_id = ?
      `, [finishingData.id]);
      finishingSizes = sizes;
    }

    const [[paymentInfo]] = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) as total_paid, COUNT(*) as payment_count
      FROM stage_payments
      WHERE user_id = ? AND lot_no = ? AND stage = 'finishing' AND status = 'approved'
    `, [userId, lotNo]);

    const [[pendingPayment]] = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) as pending_amount
      FROM stage_payments
      WHERE user_id = ? AND lot_no = ? AND stage = 'finishing' AND status = 'pending'
    `, [userId, lotNo]);

    const totalCutPieces = cuttingSizes.reduce((sum, s) => sum + (s.pieces || 0), 0);
    const totalFinishedPieces = finishingSizes.reduce((sum, s) => sum + (s.pieces || 0), 0);

    res.json({
      success: true,
      lot: {
        lot_no: cuttingLot.lot_no,
        sku: cuttingLot.sku,
        cutting_remark: cuttingLot.remark,
        cutting_master: cuttingLot.cutting_master_name,
        cutting_date: cuttingLot.created_at,
        flow_type: cuttingLot.flow_type,
        fabric_type: cuttingLot.fabric_type
      },
      cutting: { sizes: cuttingSizes, total_pieces: totalCutPieces },
      finishing: {
        data_id: finishingData?.id,
        sizes: finishingSizes,
        total_pieces: totalFinishedPieces,
        pending_pieces: totalCutPieces - totalFinishedPieces,
        created_at: finishingData?.created_at
      },
      payment: {
        total_paid: paymentInfo?.total_paid || 0,
        payment_count: paymentInfo?.payment_count || 0,
        pending_amount: pendingPayment?.pending_amount || 0
      }
    });
  } catch (err) {
    console.error('[ERROR] GET /lot-details =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /finishingdashboard/history-download
router.get('/history-download', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = `
      SELECT fd.id, fd.lot_no, fd.sku, fd.total_pieces, fd.created_at,
             cl.remark as cutting_remark, cl.fabric_type,
             COALESCE(pay.total_paid, 0) as total_paid,
             COALESCE(disp.dispatched, 0) as dispatched,
             COALESCE(disp.destinations, '') as destinations
      FROM finishing_data fd
      LEFT JOIN cutting_lots cl ON fd.lot_no = cl.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_amount) as total_paid
        FROM stage_payments WHERE user_id = ? AND stage = 'finishing' AND status = 'approved'
        GROUP BY lot_no
      ) pay ON fd.lot_no = pay.lot_no
      LEFT JOIN (
        SELECT finishing_data_id, SUM(quantity) as dispatched,
               GROUP_CONCAT(DISTINCT destination ORDER BY sent_at DESC SEPARATOR ', ') as destinations
        FROM finishing_dispatches
        GROUP BY finishing_data_id
      ) disp ON fd.id = disp.finishing_data_id
      WHERE fd.user_id = ?
    `;
    const params = [userId, userId];

    if (startDate) { query += ` AND DATE(fd.created_at) >= ?`; params.push(startDate); }
    if (endDate) { query += ` AND DATE(fd.created_at) <= ?`; params.push(endDate); }
    query += ` ORDER BY fd.created_at DESC`;

    const [rows] = await pool.query(query, params);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Finishing History');

    sheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Finished', key: 'total_pieces', width: 10 },
      { header: 'Dispatched', key: 'dispatched', width: 12 },
      { header: 'Pending', key: 'pending', width: 10 },
      { header: 'Destination', key: 'destinations', width: 25 },
      { header: 'Cutting Remark', key: 'cutting_remark', width: 30 },
      { header: 'Fabric Type', key: 'fabric_type', width: 15 },
      { header: 'Payment (₹)', key: 'total_paid', width: 12 },
      { header: 'Date', key: 'created_at', width: 18 }
    ];

    sheet.getRow(1).font = { bold: true };
    rows.forEach(row => {
      sheet.addRow({
        lot_no: row.lot_no,
        sku: row.sku,
        total_pieces: row.total_pieces,
        dispatched: row.dispatched || 0,
        pending: row.total_pieces - (row.dispatched || 0),
        destinations: row.destinations || '-',
        cutting_remark: row.cutting_remark || '-',
        fabric_type: row.fabric_type || '-',
        total_paid: row.total_paid,
        created_at: row.created_at ? new Date(row.created_at).toLocaleDateString('en-IN') : '-'
      });
    });

    const filename = `finishing_history_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /history-download =>', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /finishingdashboard/dispatch-download
 * Excel dump of every dispatch row (warehouse / PO / return / other)
 * for the current finishing master's lots. One row per
 * (lot, destination, size).
 */
router.get('/dispatch-download', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [rows] = await pool.query(
      `SELECT fd.lot_no, cl.manual_lot_number, fd.sku,
              d.destination,
              fd.destination_remark,
              d.size_label,
              d.quantity,
              d.total_sent,
              d.sent_at,
              fd.total_pieces AS batch_total,
              cl.remark        AS cutting_remark
         FROM finishing_dispatches d
         JOIN finishing_data fd ON fd.id = d.finishing_data_id
    LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
        WHERE fd.user_id = ?
     ORDER BY d.sent_at DESC, fd.lot_no, d.destination, d.size_label`,
      [userId]
    );

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Dispatches');
    sheet.columns = [
      { header: 'Lot No',          key: 'lot_no',          width: 14 },
      { header: 'Manual Lot No',   key: 'manual_lot_number', width: 14 },
      { header: 'SKU',             key: 'sku',             width: 22 },
      { header: 'Destination',     key: 'destination',     width: 14 },
      { header: 'Destination Note', key: 'destination_remark', width: 24 },
      { header: 'Size',            key: 'size_label',      width: 8  },
      { header: 'Qty Dispatched',  key: 'quantity',        width: 12 },
      { header: 'Total Sent',      key: 'total_sent',      width: 12 },
      { header: 'Batch Total',     key: 'batch_total',     width: 12 },
      { header: 'Dispatched On',   key: 'sent_at',         width: 14 },
      { header: 'Cutting Remark',  key: 'cutting_remark',  width: 22 },
    ];

    const fmt = d => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';
    for (const r of rows) {
      sheet.addRow({
        lot_no: r.lot_no, manual_lot_number: r.manual_lot_number || '', sku: r.sku,
        destination: r.destination || '',
        destination_remark: r.destination_remark || '',
        size_label: r.size_label || '',
        quantity: r.quantity || 0,
        total_sent: r.total_sent || 0,
        batch_total: r.batch_total || 0,
        sent_at: fmt(r.sent_at),
        cutting_remark: r.cutting_remark || '',
      });
    }

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Dispatches-${today}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /dispatch-download =>', err);
    return res.status(500).send('Failed to export dispatch list');
  }
});

module.exports = router;
