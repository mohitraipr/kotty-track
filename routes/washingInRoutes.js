
// 1) Show "Assign Rewash" page
// routes/washingInRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');

// If you have authentication middlewares for "washingInMaster" role:
const { isAuthenticated, isWashingInMaster } = require('../middlewares/auth');
const { createStagePayment } = require('../utils/stagePaymentHelper');
const stageEvents = require('../utils/stageEvents');

// ----------------------------------------------
// MULTER SETUP (for optional image uploads)
// ----------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + file.originalname;
    cb(null, 'washingIn-' + uniqueSuffix);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max for images
});

// ------------------------------------------------------------------
// Simple in-memory caching utility (expires after a short TTL)
// ------------------------------------------------------------------
const cacheStore = new Map();
const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes

function getCached(key) {
  const item = cacheStore.get(key);
  if (!item) return null;
  if (item.exp > Date.now()) return item.val;
  cacheStore.delete(key);
  return null;
}

function setCached(key, val, ttl = DEFAULT_TTL) {
  cacheStore.set(key, { val, exp: Date.now() + ttl });
}

/*===================================================================
  1) OLD APPROVAL ROUTES REMOVED (2026-04-23)
  Now using self-assign flow: /available-lots + /submit
  See git history if rollback needed
===================================================================*/

/*===================================================================
  2) WASHING IN DASHBOARD: CREATE, LIST, UPDATE, CHALLAN, DOWNLOAD
===================================================================*/

// GET /washingin
router.get('/', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Example query: show only approved washing_in_assignments for the current user,
    //   and filter out any lot_no that has already been used in washing_in_data for this user.
    //   That means we select from `washing_data` joined to `washing_in_assignments`
    //   which has is_approved = 1, and no existing washing_in_data record for that lot_no & user.
    const [lots] = await pool.query(`
      SELECT wd.id, wd.lot_no, wd.sku, wd.total_pieces,c.remark AS cutting_remark
      FROM washing_data wd
      JOIN washing_in_assignments wia ON wia.washing_data_id = wd.id
      LEFT JOIN cutting_lots c ON c.lot_no = wd.lot_no 
      WHERE wia.user_id = ?
        AND wia.is_approved = 1
        AND wd.lot_no NOT IN (
          SELECT lot_no
          FROM washing_in_data
          WHERE user_id = ?
        )
      ORDER BY wd.id DESC
    `, [userId, userId]);

    const error = req.flash('error');
    const success = req.flash('success');
    return res.render('washingInDashboard', {
      user: req.session.user,
      lots,
      error,
      success
    });
  } catch (err) {
    console.error('[ERROR] GET /washingin =>', err);
    req.flash('error', 'Cannot load washingIn dashboard data.');
    return res.redirect('/');
  }
});

// ==================================================================
//   NEW EVENT MODEL — multi-batch approve/complete/reject
//
//   Upstream pool = washing's COMPLETE events (legacy fallback to
//   washing_data). Each approve fires createStagePayment('washing', ...)
//   for the washing master.
// ==================================================================

const STAGE_WI = 'washing_in';

async function wiUpstreamSizes(conn, cuttingLotId, lotNo) {
  const [evRows] = await conn.query(
    `SELECT s.size_label, COALESCE(SUM(s.pieces),0) AS pieces
     FROM washing_event_sizes s
     JOIN washing_events e ON e.id = s.event_id
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
      `SELECT wds.size_label, COALESCE(SUM(wds.pieces),0) AS pieces
       FROM washing_data_sizes wds
       JOIN washing_data wd ON wd.id = wds.washing_data_id
       WHERE wd.lot_no = ?
       GROUP BY wds.size_label`,
      [lotNo]
    );
    for (const r of legRows) {
      const k = stageEvents.normalizeSizeLabel(r.size_label);
      if (k) upstream[k] = (upstream[k] || 0) + (Number(r.pieces) || 0);
    }
  }

  const wiSizes = await stageEvents.getStageSizeAggregates(conn, STAGE_WI, cuttingLotId);
  const out = [];
  for (const [size_label, washed] of Object.entries(upstream)) {
    const sa = wiSizes[size_label] || { approved: 0, completed: 0, rejected: 0, inline: 0 };
    out.push({
      size_label,
      washed_qty: washed,
      approved: sa.approved,
      completed: sa.completed,
      rejected: sa.rejected,
      inline: sa.inline,
      approved_at_stage: sa.approved,
      available: Math.max(0, washed - sa.approved),
    });
  }
  return out;
}

async function wiPickWasherForPayment(conn, lotNo) {
  const [rows] = await conn.query(
    `SELECT wd.user_id, u.username, wd.sku
     FROM washing_data wd
     JOIN users u ON u.id = wd.user_id
     WHERE wd.lot_no = ?
     ORDER BY wd.total_pieces DESC, wd.created_at DESC
     LIMIT 1`,
    [lotNo]
  );
  return rows[0] || null;
}

router.get('/events', isAuthenticated, isWashingInMaster, (req, res) => {
  res.render('washingInEvents', { user: req.session.user });
});

router.get('/event/search', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ lots: [] });
    const like = `%${q}%`;
    const [lots] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.sku, cl.total_pieces, cl.remark AS cutting_remark, cl.flow_type,
              u.username AS cutting_master, u.is_denim_cutter
       FROM cutting_lots cl
       JOIN users u ON u.id = cl.user_id
       WHERE (cl.lot_no LIKE ? OR cl.sku LIKE ? OR cl.remark LIKE ?)
         AND (cl.flow_type = 'denim' OR (cl.flow_type IS NULL AND u.is_denim_cutter = 1)
              OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL
                  AND (cl.lot_no LIKE 'AK%' OR cl.lot_no LIKE 'UM%')))
       ORDER BY cl.created_at DESC
       LIMIT 25`,
      [like, like, like]
    );
    res.json({ lots });
  } catch (err) {
    console.error('[ERROR] GET /washingin/event/search =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/lot-state/:cuttingLotId', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const lotId = parseInt(req.params.cuttingLotId, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) return res.status(400).json({ error: 'Invalid cutting_lot_id' });

    const [[lot]] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.sku, cl.total_pieces, cl.remark AS cutting_remark, cl.flow_type,
              u.username AS cutting_master, u.is_denim_cutter
       FROM cutting_lots cl JOIN users u ON u.id = cl.user_id
       WHERE cl.id = ?`,
      [lotId]
    );
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    const aggregates     = await stageEvents.getStageAggregates(pool, STAGE_WI, lotId);
    const sizeAggregates = await stageEvents.getStageSizeAggregates(pool, STAGE_WI, lotId);
    const openApprovals  = await stageEvents.getOpenApprovals(pool, STAGE_WI, lotId);
    const upstreamSizes  = await wiUpstreamSizes(pool, lotId, lot.lot_no);
    const upstreamTotal  = upstreamSizes.reduce((a, s) => a + s.available, 0);

    res.json({
      lot,
      stage_aggregates: aggregates,
      stage_size_aggregates: sizeAggregates,
      upstream_sizes: upstreamSizes,
      upstream_total_available: upstreamTotal,
      open_approvals: openApprovals,
    });
  } catch (err) {
    console.error('[ERROR] GET /washingin/event/lot-state =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/event/approve', isAuthenticated, isWashingInMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { cutting_lot_id, sizes, remark } = req.body;
    const lotId = parseInt(cutting_lot_id, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) return res.status(400).json({ error: 'Invalid cutting_lot_id' });
    if (!Array.isArray(sizes) || !sizes.length) return res.status(400).json({ error: 'sizes is required' });

    const cleanSizes = sizes
      .map(s => ({ size_label: String(s.size_label || '').trim(), pieces: Number(s.pieces) || 0 }))
      .filter(s => s.size_label && s.pieces > 0);
    if (!cleanSizes.length) return res.status(400).json({ error: 'No positive size quantities provided' });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[lot]] = await conn.query(`SELECT lot_no, sku FROM cutting_lots WHERE id = ?`, [lotId]);
    if (!lot) { await conn.rollback(); return res.status(404).json({ error: 'Lot not found' }); }

    const upstream = await wiUpstreamSizes(conn, lotId, lot.lot_no);
    const upstreamMap = {};
    for (const r of upstream) upstreamMap[stageEvents.normalizeSizeLabel(r.size_label)] = r.available;
    for (const s of cleanSizes) {
      const avail = upstreamMap[stageEvents.normalizeSizeLabel(s.size_label)] || 0;
      if (s.pieces > avail) {
        await conn.rollback();
        return res.status(400).json({ error: `Size ${s.size_label}: only ${avail} pieces completed by washing not yet taken (requested ${s.pieces})` });
      }
    }

    const eventId = await stageEvents.recordEvent(conn, {
      stage: STAGE_WI, cuttingLotId: lotId, eventType: 'approve',
      operatorId: userId, sizes: cleanSizes, parentEventId: null,
      remark: remark ? String(remark).trim() : null,
    });

    await conn.commit();

    const totalPieces = cleanSizes.reduce((a, s) => a + s.pieces, 0);
    try {
      const washer = await wiPickWasherForPayment(pool, lot.lot_no);
      if (washer) {
        await createStagePayment('washing', {
          lot_no: lot.lot_no, sku: washer.sku || lot.sku, qty: totalPieces,
          user_id: washer.user_id, username: washer.username,
        });
      }
    } catch (payErr) {
      console.error('[WARN] /washingin/event/approve washing payment failed:', payErr.message);
    }

    res.json({ success: true, event_id: eventId, total_pieces: totalPieces, sizes: cleanSizes });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[ERROR] POST /washingin/event/approve =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/event/complete', isAuthenticated, isWashingInMaster, async (req, res) => {
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
    const { events, eventSizes } = stageEvents.tablesFor(STAGE_WI);

    const [[parent]] = await conn.query(
      `SELECT id, cutting_lot_id, event_type, pieces FROM ${events} WHERE id = ? FOR UPDATE`,
      [parentId]
    );
    if (!parent || parent.event_type !== 'approve') {
      await conn.rollback();
      return res.status(400).json({ error: 'parent_event_id must reference an approve event' });
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
      const newC = (cleanCompleted.find(s => s.size_label === label) || {}).pieces || 0;
      const newR = (cleanRejected.find(s => s.size_label === label) || {}).pieces || 0;
      if (prev.complete + prev.reject + newC + newR > approved) {
        await conn.rollback();
        return res.status(400).json({ error: `Size ${label}: total complete+reject exceeds approved ${approved}` });
      }
    }

    let completeEventId = null, rejectEventId = null;
    if (cleanCompleted.length) {
      completeEventId = await stageEvents.recordEvent(conn, {
        stage: STAGE_WI, cuttingLotId: parent.cutting_lot_id, eventType: 'complete',
        operatorId: userId, sizes: cleanCompleted, parentEventId: parentId,
        remark: complete_remark ? String(complete_remark).trim() : null,
      });
    }
    if (cleanRejected.length) {
      rejectEventId = await stageEvents.recordEvent(conn, {
        stage: STAGE_WI, cuttingLotId: parent.cutting_lot_id, eventType: 'reject',
        operatorId: userId, sizes: cleanRejected, parentEventId: parentId,
        remark: reject_reason ? String(reject_reason).trim() : null,
      });
    }

    if (cleanCompleted.length) {
      const [[lot]] = await conn.query(`SELECT lot_no, sku FROM cutting_lots WHERE id = ?`, [parent.cutting_lot_id]);
      const totalCompleted = cleanCompleted.reduce((a, s) => a + s.pieces, 0);
      const [adResult] = await conn.query(
        `INSERT INTO washing_in_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NOW())`,
        [userId, lot.lot_no, lot.sku, totalCompleted, complete_remark || null]
      );
      const widId = adResult.insertId;
      for (const s of cleanCompleted) {
        await conn.query(
          `INSERT INTO washing_in_data_sizes (washing_in_data_id, size_label, pieces, created_at)
           VALUES (?, ?, ?, NOW())`,
          [widId, s.size_label, s.pieces]
        );
      }
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
    console.error('[ERROR] POST /washingin/event/complete =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /washingin/list-entries => for lazy loading the existing washing_in_data
router.get('/list-entries', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = req.query.search || '';
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 5;
    const searchLike = `%${search}%`;

    // Fixed: Replace SELECT * with specific columns
    const [rows] = await pool.query(`
      SELECT id, user_id, lot_no, sku, total_pieces, created_at
      FROM washing_in_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, searchLike, searchLike, limit, offset]);

    if (!rows.length) {
      return res.json({ data: [], hasMore: false });
    }

    // gather ids
    const ids = rows.map(r => r.id);
    // Fixed: Replace SELECT * with specific columns
    const [sizeRows] = await pool.query(`
      SELECT id, washing_in_data_id, size_label, pieces
      FROM washing_in_data_sizes
      WHERE washing_in_data_id IN (?)
    `, [ids]);

    // map sizes
    const sizeMap = {};
    sizeRows.forEach(s => {
      if (!sizeMap[s.washing_in_data_id]) {
        sizeMap[s.washing_in_data_id] = [];
      }
      sizeMap[s.washing_in_data_id].push(s);
    });

    const data = rows.map(r => ({
      ...r,
      sizes: sizeMap[r.id] || []
    }));

    // check total for pagination
    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM washing_in_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
    `, [userId, searchLike, searchLike]);
    const hasMore = offset + rows.length < totalCount;

    return res.json({ data, hasMore });
  } catch (err) {
    console.error('[ERROR] GET /washingin/list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /washingin/get-lot-sizes/:washingDataId
//   to fetch sizes for a chosen washing_data record (similar to how we do it in stitching/washing).
//   Or if you prefer to fetch from the original table that your user will pick from:
router.get('/get-lot-sizes/:wdId', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const wdId = req.params.wdId;

    // Fixed: Replace SELECT * with specific columns
    const [[wd]] = await pool.query(
      `SELECT id, lot_no FROM washing_data WHERE id = ?`,
      [wdId]
    );
    if (!wd) return res.status(404).json({ error: 'washing_data not found' });

    // Fixed: Replace SELECT * with specific columns
    const [sizes] = await pool.query(
      `SELECT id, washing_data_id, size_label, pieces FROM washing_data_sizes WHERE washing_data_id = ?`,
      [wdId]
    );

    const labels = sizes.map(s => s.size_label);
    let usedRows = [];
    if (labels.length) {
      [usedRows] = await pool.query(
        `SELECT wids.size_label, SUM(wids.pieces) AS usedCount
         FROM washing_in_data_sizes wids
         JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
         WHERE wid.lot_no = ? AND wids.size_label IN (?)
         GROUP BY wids.size_label`,
        [wd.lot_no, labels]
      );
    }

    const usedMap = {};
    usedRows.forEach(r => { usedMap[r.size_label] = r.usedCount || 0; });

    const output = sizes.map(s => {
      const used = usedMap[s.size_label] || 0;
      const remain = Math.max(s.pieces - used, 0);
      return {
        id: s.id,
        size_label: s.size_label,
        total_pieces: s.pieces,
        used,
        remain
      };
    });

    return res.json(output);
  } catch (err) {
    console.error('[ERROR] GET /washingin/get-lot-sizes =>', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// OPTIONAL: GET /washingin/create/assignable-users => if you want to assign from washing_in_data to finishing
router.get('/create/assignable-users', isAuthenticated, isWashingInMaster, async (req, res) => {
  const cached = getCached('finishing_users');
  if (cached) return res.json({ data: cached });
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'finishing'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    setCached('finishing_users', rows);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingin/create/assignable-users =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /washingin/create => Insert new washing_in_data
router.post('/create', isAuthenticated, isWashingInMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const userId = req.session.user.id;
    const { selectedWashingDataId, remark } = req.body;
    const sizesObj = req.body.sizes || {};  // e.g. sizes[sizeId] = pieces
    const assignmentsObj = req.body.assignments || {}; // e.g. assignments[sizeId] = finishingUserId

    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    // 1) Validate the washing_data row
    const [[wd]] = await conn.query(`
      SELECT *
      FROM washing_data
      WHERE id = ?
    `, [selectedWashingDataId]);
    if (!wd) {
      req.flash('error', 'Invalid or no washing_data selected.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingin');
    }

    // 2) Ensure it's actually assigned & approved for the current user
    const [[assignRow]] = await conn.query(`
      SELECT id
      FROM washing_in_assignments
      WHERE user_id = ?
        AND washing_data_id = ?
        AND is_approved = 1
      LIMIT 1
    `, [userId, selectedWashingDataId]);
    if (!assignRow) {
      req.flash('error', 'Not approved or not assigned to you.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingin');
    }

    // 3) Ensure that we have NOT already used this lot_no
    const [[alreadyUsed]] = await conn.query(`
      SELECT id
      FROM washing_in_data
      WHERE lot_no = ?
        AND user_id = ?
      LIMIT 1
    `, [wd.lot_no, userId]);
    if (alreadyUsed) {
      req.flash('error', `Lot no. ${wd.lot_no} already used for washingIn by you.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/washingin');
    }

    // 4) Validate user piece entries
    const sizeIds = Object.keys(sizesObj).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const [sizeRows] = sizeIds.length
      ? await conn.query(
          `SELECT id, size_label, pieces FROM washing_data_sizes WHERE id IN (?)`,
          [sizeIds]
        )
      : [[]];
    const sizeMap = {};
    sizeRows.forEach(r => (sizeMap[r.id] = r));

    const labels = sizeRows.map(r => r.size_label);
    const [usedRows] = labels.length
      ? await conn.query(
          `SELECT wids.size_label, SUM(wids.pieces) AS usedCount
           FROM washing_in_data_sizes wids
           JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
           WHERE wid.lot_no = ? AND wids.size_label IN (?)
           GROUP BY wids.size_label`,
          [wd.lot_no, labels]
        )
      : [[]];
    const usedMap = {};
    usedRows.forEach(r => (usedMap[r.size_label] = r.usedCount || 0));

    let grandTotal = 0;
    for (const sizeId of sizeIds) {
      const userCount = parseInt(sizesObj[sizeId], 10);
      if (isNaN(userCount) || userCount < 0) {
        req.flash('error', `Invalid piece count for sizeId ${sizeId}`);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingin');
      }
      if (userCount === 0) continue;

      const row = sizeMap[sizeId];
      if (!row) {
        req.flash('error', 'Invalid size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingin');
      }

      const remain = row.pieces - (usedMap[row.size_label] || 0);
      if (userCount > remain) {
        req.flash(
          'error',
          `Cannot create: requested ${userCount} for size [${row.size_label}] but only ${remain} remain.`
        );
        await conn.rollback();
        conn.release();
        return res.redirect('/washingin');
      }

      grandTotal += userCount;
    }

    if (grandTotal <= 0) {
      req.flash('error', 'No pieces requested (> 0).');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingin');
    }

    // 5) Insert main row
    const [mainInsert] = await conn.query(`
      INSERT INTO washing_in_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, wd.lot_no, wd.sku, grandTotal, remark || null, image_url]);
    const newId = mainInsert.insertId;

    // 6) Insert sizes
    for (const sizeId of sizeIds) {
      const val = parseInt(sizesObj[sizeId], 10) || 0;
      if (val <= 0) continue;
      const row = sizeMap[sizeId];
      await conn.query(
        `INSERT INTO washing_in_data_sizes (washing_in_data_id, size_label, pieces, created_at)
         VALUES (?, ?, ?, NOW())`,
        [newId, row.size_label, val]
      );
    }

    // 7) (Optional) Assign partial sizes to finishing
    //    Suppose finishing_assignments table has columns (washing_in_master_id, user_id, washing_in_data_id, sizes_json, is_approved, etc.)
    const assignMap = {};
    for (const sizeId of Object.keys(assignmentsObj)) {
      const assignedFinUserId = assignmentsObj[sizeId];
      if (!assignedFinUserId) continue;
      const row = sizeMap[sizeId];
      if (!row) continue;
      if (!assignMap[assignedFinUserId]) {
        assignMap[assignedFinUserId] = [];
      }
      assignMap[assignedFinUserId].push(row.size_label);
    }

    for (const finUserId of Object.keys(assignMap)) {
      const arrLabels = assignMap[finUserId];
      if (!arrLabels.length) continue;
      const sizesJson = JSON.stringify(arrLabels);

      await conn.query(`
        INSERT INTO finishing_assignments
          (washing_in_master_id, user_id, washing_in_data_id, target_day, assigned_on, sizes_json, is_approved)
        VALUES (?, ?, ?, NULL, NOW(), ?, NULL)
      `, [userId, finUserId, newId, sizesJson]);
    }

    await conn.commit();
    conn.release();

    req.flash('success', 'Washing In entry created successfully (with optional finishing assignments)!');
    return res.redirect('/washingin');
  } catch (err) {
    console.error('[ERROR] POST /washingin/create =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error creating washingIn data: ' + err.message);
    return res.redirect('/washingin');
  }
});

// GET /washingin/update/:id/json => fetch the existing sizes for incremental updates
router.get('/update/:id/json', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const entryId = req.params.id;
    const userId = req.session.user.id;

    const [[entry]] = await pool.query(`
      SELECT *
      FROM washing_in_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      return res.status(403).json({ error: 'No permission or not found' });
    }

    // fetch the row sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_in_data_sizes
      WHERE washing_in_data_id = ?
      ORDER BY id ASC
    `, [entryId]);

    // for each size, compute remain from the original washing_data_sizes
    const output = [];
    for (const sz of sizes) {
      // 1) find the total allowed from washing_data_sizes
      const [[wdsRow]] = await pool.query(`
        SELECT wds.pieces
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ?
          AND wds.size_label = ?
        LIMIT 1
      `, [entry.lot_no, sz.size_label]);
      const totalAllowed = wdsRow ? wdsRow.pieces : 0;

      // 2) how many used so far in washing_in_data
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wids.pieces),0) AS usedCount
        FROM washing_in_data_sizes wids
        JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
        WHERE wid.lot_no = ?
          AND wids.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = totalAllowed - used;

      output.push({
        ...sz,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json({ sizes: output });
  } catch (err) {
    console.error('[ERROR] GET /washingin/update/:id/json =>', err);
    return res.status(500).json({ error: err.message });
  }
  // No further processing needed

});

// POST /washingin/update/:id => handle incremental piece additions
// POST /washingin/update/:id
// Fixed backend route for POST /washingin/update/:id
router.post('/update/:id', isAuthenticated, isWashingInMaster, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const entryId = req.params.id;
    const userId = req.session.user.id;
    const updateSizes = req.body.updateSizes || {};

    const [[entry]] = await conn.query(`
      SELECT * FROM washing_in_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);

    if (!entry) {
      req.flash('error', 'Washing In entry not found.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingin');
    }

    let updatedTotal = entry.total_pieces;

    const sizeIds = Object.keys(updateSizes).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const [sizeRows] = sizeIds.length
      ? await conn.query(
          `SELECT id, size_label, pieces FROM washing_data_sizes WHERE id IN (?)`,
          [sizeIds]
        )
      : [[]];
    const sizeMap = {};
    sizeRows.forEach(r => (sizeMap[r.id] = r));

    const labels = sizeRows.map(r => r.size_label);
    const [usedRows] = labels.length
      ? await conn.query(
          `SELECT wids.size_label, SUM(wids.pieces) AS usedCount
           FROM washing_in_data_sizes wids
           JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
           WHERE wid.lot_no = ? AND wids.size_label IN (?)
           GROUP BY wids.size_label`,
          [entry.lot_no, labels]
        )
      : [[]];
    const usedMap = {};
    usedRows.forEach(r => (usedMap[r.size_label] = r.usedCount || 0));

    const [existingRows] = labels.length
      ? await conn.query(
          `SELECT id, size_label FROM washing_in_data_sizes WHERE washing_in_data_id = ? AND size_label IN (?)`,
          [entryId, labels]
        )
      : [[]];
    const existingMap = {};
    existingRows.forEach(r => (existingMap[r.size_label] = r));

    for (const sizeId of sizeIds) {
      const increment = parseInt(updateSizes[sizeId], 10);
      if (isNaN(increment) || increment <= 0) continue;

      const row = sizeMap[sizeId];
      if (!row) throw new Error(`Invalid size ID: ${sizeId}`);

      const remain = row.pieces - (usedMap[row.size_label] || 0);
      if (increment > remain) {
        throw new Error(`Cannot add ${increment} to size [${row.size_label}]. Only ${remain < 0 ? 0 : remain} remain.`);
      }

      const existing = existingMap[row.size_label];
      if (!existing) {
        await conn.query(
          `INSERT INTO washing_in_data_sizes (washing_in_data_id, size_label, pieces, created_at)
           VALUES (?, ?, ?, NOW())`,
          [entryId, row.size_label, increment]
        );
      } else {
        await conn.query(
          `UPDATE washing_in_data_sizes SET pieces = pieces + ? WHERE id = ?`,
          [increment, existing.id]
        );
      }

      await conn.query(
        `INSERT INTO washing_in_data_updates (washing_in_data_id, size_label, pieces, updated_at)
         VALUES (?, ?, ?, NOW())`,
        [entryId, row.size_label, increment]
      );

      updatedTotal += increment;
    }

    await conn.query(`
      UPDATE washing_in_data
      SET total_pieces = ?
      WHERE id = ?
    `, [updatedTotal, entryId]);

    await conn.commit();
    conn.release();

    req.flash('success', 'Washing In entry updated successfully!');
    return res.redirect('/washingin');

  } catch (err) {
    console.error('[ERROR] POST /washingin/update/:id =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error updating Washing In entry: ' + err.message);
    return res.redirect('/washingin');
  }
});
// GET /washingin/challan/:id => show a "challan" summary
router.get('/challan/:id', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    const [[row]] = await pool.query(`
      SELECT *
      FROM washing_in_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/washingin');
    }

    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_in_data_sizes
      WHERE washing_in_data_id = ?
      ORDER BY id ASC
    `, [entryId]);

    const [updates] = await pool.query(`
      SELECT *
      FROM washing_in_data_updates
      WHERE washing_in_data_id = ?
      ORDER BY updated_at ASC
    `, [entryId]);

    // Render an EJS page that displays the row, the sizes, and the update logs
    return res.render('washingInChallan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates
    });
  } catch (err) {
    console.error('[ERROR] GET /washingin/challan/:id =>', err);
    req.flash('error', 'Error loading challan: ' + err.message);
    return res.redirect('/washingin');
  }
});

// GET /washingin/download-all => export data to Excel
router.get('/download-all', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // fetch main rows
    const [mainRows] = await pool.query(`
      SELECT *
      FROM washing_in_data
      WHERE user_id = ?
      ORDER BY created_at ASC
    `, [userId]);

    // fetch size rows
    const [allSizes] = await pool.query(`
      SELECT wids.*
      FROM washing_in_data_sizes wids
      JOIN washing_in_data wid ON wid.id = wids.washing_in_data_id
      WHERE wid.user_id = ?
      ORDER BY wids.washing_in_data_id, wids.id
    `, [userId]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();

    const mainSheet = workbook.addWorksheet('WashingInData');
    mainSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 12 },
      { header: 'Remark', key: 'remark', width: 25 },
      { header: 'Image URL', key: 'image_url', width: 30 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];

    mainRows.forEach(r => {
      mainSheet.addRow({
        id: r.id,
        lot_no: r.lot_no,
        sku: r.sku,
        total_pieces: r.total_pieces,
        remark: r.remark || '',
        image_url: r.image_url || '',
        created_at: r.created_at
      });
    });

    const sizesSheet = workbook.addWorksheet('WashingInSizes');
    sizesSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'WashingIn ID', key: 'washing_in_data_id', width: 12 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Pieces', key: 'pieces', width: 8 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];

    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        washing_in_data_id: s.washing_in_data_id,
        size_label: s.size_label,
        pieces: s.pieces,
        created_at: s.created_at
      });
    });

    res.setHeader('Content-Disposition', 'attachment; filename="WashingInData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('[ERROR] GET /washingin/download-all =>', err);
    req.flash('error', 'Could not download Excel: ' + err.message);
    return res.redirect('/washingin');
  }
});

/*=================================================================================
   3) OPTIONAL: ASSIGN WASHING_IN_DATA TO FINISHING (SAME PATTERN AS STITCHING)
=================================================================================*/

// GET /washingin/assign-finishing
router.get('/assign-finishing', isAuthenticated, isWashingInMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('washingInAssignFinishing', {
    user: req.session.user,
    error,
    success
  });
});

// GET /washingin/assign-finishing/users => finishing users
router.get('/assign-finishing/users', isAuthenticated, isWashingInMaster, async (req, res) => {
  const cached = getCached('finishing_users');
  if (cached) return res.json({ data: cached });
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'finishing'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    setCached('finishing_users', rows);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingin/assign-finishing/users =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /washingin/assign-finishing/data
router.get('/assign-finishing/data', isAuthenticated, isWashingInMaster, async (req, res) => {
    try {
      const userId = req.session.user.id;
  
      // fetch all washing_in_data for current user with their sizes
      const [mainRows] = await pool.query(`
        SELECT wid.id AS washing_in_data_id, wid.lot_no, wid.sku, wid.total_pieces,
               wids.size_label, wids.pieces
        FROM washing_in_data wid
        JOIN washing_in_data_sizes wids ON wid.id = wids.washing_in_data_id
        WHERE wid.user_id = ?
      `, [userId]);
  
      if (!mainRows.length) return res.json({ data: [] });
  
      // fetch already assigned sizes
      const [finRows] = await pool.query(`
        SELECT washing_in_data_id, sizes_json
        FROM finishing_assignments
        WHERE washing_in_master_id = ?
      `, [userId]);
  
      // Create map of assigned sizes
      const assignedMap = {};
      finRows.forEach(r => {
        if (!assignedMap[r.washing_in_data_id]) {
          assignedMap[r.washing_in_data_id] = new Set();
        }
        try {
          const sizes = JSON.parse(r.sizes_json);
          if (Array.isArray(sizes)) {
            sizes.forEach(size => assignedMap[r.washing_in_data_id].add(size));
          }
        } catch (e) {
          console.error('Error parsing sizes_json:', e);
        }
      });
  
      // Group data by washing_in_data_id
      const dataMap = {};
      mainRows.forEach(row => {
        if (!dataMap[row.washing_in_data_id]) {
          dataMap[row.washing_in_data_id] = {
            washing_in_data_id: row.washing_in_data_id,
            lot_no: row.lot_no,
            sku: row.sku,
            total_pieces: row.total_pieces,
            sizes: []
          };
        }
        
        // Only include sizes not already assigned
        const assignedSizes = assignedMap[row.washing_in_data_id] || new Set();
        if (!assignedSizes.has(row.size_label)) {
          dataMap[row.washing_in_data_id].sizes.push({
            size_label: row.size_label,
            pieces: row.pieces
          });
        }
      });
  
      // Convert to array and filter out entries with no sizes
      const output = Object.values(dataMap).filter(d => d.sizes.length > 0);
      return res.json({ data: output });
    } catch (err) {
      console.error('[ERROR] GET /washingin/assign-finishing/data =>', err);
      return res.status(500).json({ error: err.message });
    }
  });


  // POST /washingin/assign-finishing
router.post('/assign-finishing', isAuthenticated, isWashingInMaster, async (req, res) => {
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
  
      const userId = req.session.user.id;
      const { target_day } = req.body;
      
      // Expecting format: { userId: [{ washing_in_data_id, size_label }] }
      const assignments = req.body.finishingAssignments || {};
  
      // Validate we have assignments
      if (Object.keys(assignments).length === 0) {
        req.flash('error', 'No assignments provided');
        await conn.rollback();
        conn.release();
        return res.redirect('/washingin/assign-finishing');
      }
  
      // Process each user's assignments
      for (const [finUserId, sizeAssignments] of Object.entries(assignments)) {
        if (!sizeAssignments || !Array.isArray(sizeAssignments)) continue;
  
        // Group by washing_in_data_id
        const assignmentsByWashingId = {};
        sizeAssignments.forEach(({ washing_in_data_id, size_label }) => {
          if (!assignmentsByWashingId[washing_in_data_id]) {
            assignmentsByWashingId[washing_in_data_id] = [];
          }
          assignmentsByWashingId[washing_in_data_id].push(size_label);
        });
  
        // Create assignment records
        for (const [washingId, sizeLabels] of Object.entries(assignmentsByWashingId)) {
          // Validate ownership
          const [[exists]] = await conn.query(`
            SELECT id FROM washing_in_data 
            WHERE id = ? AND user_id = ?
          `, [washingId, userId]);
  
          if (!exists) {
            throw new Error(`Invalid washing_in_data_id ${washingId} for user ${userId}`);
          }
  
          await conn.query(`
            INSERT INTO finishing_assignments (
              washing_in_master_id, 
              user_id, 
              washing_in_data_id, 
              target_day, 
              assigned_on, 
              sizes_json, 
              is_approved
            ) VALUES (?, ?, ?, ?, NOW(), ?, NULL)
          `, [
            userId,
            finUserId,
            washingId,
            target_day || null,
            JSON.stringify(sizeLabels)
          ]);
        }
      }
  
      await conn.commit();
      conn.release();
      req.flash('success', 'Assignments created successfully');
      return res.redirect('/washingin/assign-finishing');
    } catch (err) {
      console.error('[ERROR] POST /washingin/assign-finishing =>', err);
      if (conn) {
        await conn.rollback();
        conn.release();
      }
      req.flash('error', 'Failed to create assignments: ' + err.message);
      return res.redirect('/washingin/assign-finishing');
    }
  });


// routes/washingInRoutes.js — in your GET /assign-rewash
router.get('/assign-rewash', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [lots] = await pool.query(`
      SELECT
        wd.id   AS washing_data_id,
        wd.lot_no,
        wd.sku,
        wd.total_pieces,
        SUM(GREATEST(wds.pieces - COALESCE(used.total_used, 0), 0)) AS available_for_rewash
      FROM washing_data wd
      JOIN washing_in_assignments wia
        ON wia.washing_data_id = wd.id
      LEFT JOIN washing_data_sizes wds
        ON wds.washing_data_id = wd.id
      LEFT JOIN (
        SELECT
          wid.lot_no,
          wids.size_label,
          SUM(wids.pieces) AS total_used
        FROM washing_in_data wid
        JOIN washing_in_data_sizes wids ON wids.washing_in_data_id = wid.id
        WHERE wid.user_id = ?
        GROUP BY wid.lot_no, wids.size_label
      ) used
        ON used.lot_no = wd.lot_no AND used.size_label = wds.size_label
      LEFT JOIN rewash_requests rr
        ON rr.washing_data_id = wd.id
          AND rr.status = 'pending'
      WHERE
        wia.user_id    = ?
        AND wia.is_approved = 1
        AND rr.id IS NULL
      GROUP BY wd.id, wd.lot_no, wd.sku, wd.total_pieces
      HAVING available_for_rewash > 0
      ORDER BY wd.id DESC
    `, [userId, userId]);

    res.render('washingInAssignRewash', {
      user: req.session.user,
      lots,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    console.error('[ERROR] GET /washingin/assign-rewash =>', err);
    req.flash('error', 'Cannot load rewash page.');
    res.redirect('/washingin');
  }
});


// 2) Fetch sizes & remaining for a chosen lot
router.get('/assign-rewash/data/:wdId', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const wdId = req.params.wdId;
    const userId = req.session.user.id;

    const [[wd]] = await pool.query(`SELECT * FROM washing_data WHERE id = ?`, [wdId]);
    if (!wd) return res.status(404).json({ error: 'Lot not found' });

    const [sizes] = await pool.query(`
      SELECT
        wds.id,
        wds.size_label,
        GREATEST(wds.pieces - COALESCE(used.total_used, 0), 0) AS available
      FROM washing_data_sizes wds
      LEFT JOIN (
        SELECT
          wids.size_label,
          SUM(wids.pieces) AS total_used
        FROM washing_in_data wid
        JOIN washing_in_data_sizes wids ON wids.washing_in_data_id = wid.id
        WHERE wid.lot_no = ?
          AND wid.user_id = ?
        GROUP BY wids.size_label
      ) used
        ON used.size_label = wds.size_label
      WHERE wds.washing_data_id = ?
    `, [wd.lot_no, userId, wdId]);

    const output = sizes
      .filter(s => s.available > 0)
      .map(s => ({
        id: s.id,
        size_label: s.size_label,
        available: s.available,
      }));

    res.json(output);
  } catch (err) {
    console.error('[ERROR] GET /assign-rewash/data] =>', err);
    res.status(500).json({ error: err.message });
  }
});

// 3) Create a new rewash request
router.post('/assign-rewash', isAuthenticated, isWashingInMaster, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session.user.id;
    const { selectedWashingDataId, sizes = {} } = req.body;
    // 1) Validate lot
    const [[wd]] = await conn.query(`SELECT * FROM washing_data WHERE id = ?`, [selectedWashingDataId]);
    if (!wd) throw new Error('Invalid lot selection.');

    // 2) Compute total_requested & ensure <= available
    let totalReq = 0;
    for (let sizeId in sizes) {
      const reqCount = parseInt(sizes[sizeId], 10) || 0;
      if (reqCount < 0) throw new Error('Invalid piece count.');
      if (reqCount > 0) totalReq += reqCount;
    }
    if (totalReq <= 0) throw new Error('No pieces requested.');

    // 3) Insert into rewash_requests
    const [rr] = await conn.query(`
      INSERT INTO rewash_requests
        (washing_data_id, user_id, lot_no, sku, total_requested, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `, [wd.id, userId, wd.lot_no, wd.sku, totalReq]);
    const rewashId = rr.insertId;

    // 4) Insert each size & deduct from washing_data_sizes + log in washing_data_updates
    const sizeIds = Object.keys(sizes).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const [sizeRows] = sizeIds.length
      ? await conn.query(
          `SELECT id, size_label, pieces FROM washing_data_sizes WHERE id IN (?)`,
          [sizeIds]
        )
      : [[]];
    const sizeMap = {};
    sizeRows.forEach(r => (sizeMap[r.id] = r));

    const sizeLabels = sizeRows.map(r => r.size_label);
    const [usedRows] = sizeLabels.length
      ? await conn.query(
          `SELECT wids.size_label, SUM(wids.pieces) AS usedCount
             FROM washing_in_data wid
             JOIN washing_in_data_sizes wids ON wids.washing_in_data_id = wid.id
            WHERE wid.lot_no = ?
              AND wid.user_id = ?
              AND wids.size_label IN (?)
            GROUP BY wids.size_label`,
          [wd.lot_no, userId, sizeLabels]
        )
      : [[]];
    const usedMap = {};
    usedRows.forEach(r => (usedMap[r.size_label] = r.usedCount || 0));

    for (const sizeId of sizeIds) {
      const reqCount = parseInt(sizes[sizeId], 10) || 0;
      if (reqCount <= 0) continue;
      const srow = sizeMap[sizeId];
      if (!srow) throw new Error('Bad size reference.');

      const alreadyUsed = usedMap[srow.size_label] || 0;
      const available = srow.pieces - alreadyUsed;
      if (reqCount > available)
        throw new Error(`Requested ${reqCount} exceeds available ${available < 0 ? 0 : available} for ${srow.size_label}`);

      await conn.query(
        `INSERT INTO rewash_request_sizes (rewash_request_id, size_label, pieces_requested)
         VALUES (?, ?, ?)`,
        [rewashId, srow.size_label, reqCount]
      );

      await conn.query(
        `UPDATE washing_data_sizes SET pieces = pieces - ? WHERE id = ?`,
        [reqCount, sizeId]
      );

      await conn.query(
        `UPDATE washing_data SET total_pieces = total_pieces - ? WHERE id = ?`,
        [reqCount, wd.id]
      );

      await conn.query(
        `INSERT INTO washing_data_updates (washing_data_id, size_label, pieces)
         VALUES (?, ?, ?)`,
        [wd.id, srow.size_label, -reqCount]
      );
    }

    await conn.commit();
    req.flash('success', 'Rewash request created successfully!');
    res.redirect('/washingin/assign-rewash');
  } catch (err) {
    await conn.rollback();
    console.error('[ERROR] POST /assign-rewash =>', err);
    req.flash('error', err.message);
    res.redirect('/washingin/assign-rewash');
  } finally {
    conn.release();
  }
});

// 4) List pending rewash requests
router.get('/assign-rewash/pending', isAuthenticated, isWashingInMaster, (req, res) => {
  res.render('washingInRewashPending', {
    user: req.session.user,
    error: req.flash('error'),
    success: req.flash('success'),
  });
});

router.get('/assign-rewash/pending/list', isAuthenticated, isWashingInMaster, async (req, res) => {
  const userId = req.session.user.id;
  const [rows] = await pool.query(`
    SELECT rr.id, rr.lot_no, rr.sku, rr.total_requested, rr.created_at
    FROM rewash_requests rr
    WHERE rr.user_id = ? AND rr.status = 'pending'
    ORDER BY rr.created_at DESC
  `, [userId]);
  res.json({ data: rows });
});

// 5) Complete a rewash request
router.post('/assign-rewash/pending/:id/complete', isAuthenticated, isWashingInMaster, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const rrId = req.params.id;
    // fetch request
    const [[rr]] = await conn.query(`SELECT * FROM rewash_requests WHERE id = ? AND status = 'pending'`, [rrId]);
    if (!rr) throw new Error('Invalid or already completed.');

    // fetch sizes requested
    const [sizes] = await conn.query(`
      SELECT * FROM rewash_request_sizes WHERE rewash_request_id = ?
    `, [rrId]);

    // process completion: add back to pools, log positive updates
    for (let sz of sizes) {
      // update washing_data_sizes
      await conn.query(`
        UPDATE washing_data_sizes
        SET pieces = pieces + ?
        WHERE washing_data_id = ? AND size_label = ?
      `, [sz.pieces_requested, rr.washing_data_id, sz.size_label]);

      // update washing_data.total_pieces
      await conn.query(`
        UPDATE washing_data
        SET total_pieces = total_pieces + ?
        WHERE id = ?
      `, [sz.pieces_requested, rr.washing_data_id]);

      // log positive update
      await conn.query(`
        INSERT INTO washing_data_updates
          (washing_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [rr.washing_data_id, sz.size_label, sz.pieces_requested]);
    }

    // mark request completed
    await conn.query(`
      UPDATE rewash_requests
      SET status = 'completed', updated_at = NOW()
      WHERE id = ?
    `, [rrId]);

    await conn.commit();
    req.flash('success', 'Rewash completed and pieces returned to pool.');
    res.redirect('/washingin/assign-rewash/pending');
  } catch (err) {
    await conn.rollback();
    console.error('[ERROR] POST /assign-rewash/pending/:id/complete =>', err);
    req.flash('error', err.message);
    res.redirect('/washingin/assign-rewash/pending');
  } finally {
    conn.release();
  }
});

/*-----------------------------------------
  SELF-ASSIGN FLOW (Stitching-style)
  Worker picks available lot + submits in one step
-----------------------------------------*/

// GET /washingin/available-lots
// Shows denim lots with washing_data that haven't been fully processed in washing_in
router.get('/available-lots', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : '%';

    const [rows] = await pool.query(`
      SELECT
        wd.id,
        wd.lot_no,
        wd.sku,
        wd.total_pieces,
        wd.created_at,
        cl.remark AS cutting_remark,
        wd.total_pieces - COALESCE((
          SELECT SUM(wid.total_pieces)
          FROM washing_in_data wid
          WHERE wid.lot_no = wd.lot_no
        ), 0) AS remaining_pieces,
        u.username AS washing_master
      FROM washing_data wd
      JOIN users u ON wd.user_id = u.id
      LEFT JOIN cutting_lots cl ON cl.lot_no = wd.lot_no
      WHERE (wd.lot_no LIKE ? OR wd.sku LIKE ? OR cl.remark LIKE ?)
        AND (
          cl.flow_type = 'denim'
          OR EXISTS (
            SELECT 1 FROM users cu
            WHERE cu.id = cl.user_id AND cu.is_denim_cutter = 1
          )
          OR wd.lot_no REGEXP '^(AK|UM)'
        )
      HAVING remaining_pieces > 0
      ORDER BY wd.created_at DESC
      LIMIT 50
    `, [search, search, search]);

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingin/available-lots =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /washingin/available-lot-sizes/:lotId
// Get sizes for a specific washing_data lot with remaining counts for washing_in
router.get('/available-lot-sizes/:lotId', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;

    const [[wd]] = await pool.query(`SELECT * FROM washing_data WHERE id = ?`, [lotId]);
    if (!wd) {
      return res.status(404).json({ error: 'Lot not found' });
    }

    const [rows] = await pool.query(`
      SELECT
        wds.id,
        wds.size_label,
        wds.pieces,
        wds.pieces - COALESCE((
          SELECT SUM(wids.pieces)
          FROM washing_in_data_sizes wids
          JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
          WHERE wid.lot_no = ? AND wids.size_label = wds.size_label
        ), 0) AS remain
      FROM washing_data_sizes wds
      WHERE wds.washing_data_id = ?
    `, [wd.lot_no, lotId]);

    return res.json(rows.map(r => ({
      id: r.id,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    })));
  } catch (err) {
    console.error('[ERROR] GET /washingin/available-lot-sizes/:lotId =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// Rewash debit rate (configurable)
const REWASH_DEBIT_RATE = 200;

// POST /washingin/submit
// Self-assign + complete washing_in in one step with rewash/reject support
router.post('/submit', isAuthenticated, isWashingInMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const username = req.session.user.username;
    const { selectedLotId, remark, rejectReason } = req.body;
    const sizesObj = req.body.sizes || {};
    const rewashObj = req.body.rewash || {};
    const rejectObj = req.body.reject || {};

    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    // Calculate totals
    let okTotal = 0, rewashTotal = 0, rejectTotal = 0;
    const allSizeIds = new Set([
      ...Object.keys(sizesObj),
      ...Object.keys(rewashObj),
      ...Object.keys(rejectObj)
    ].map(id => parseInt(id, 10)).filter(Boolean));

    for (const sizeId of allSizeIds) {
      okTotal += parseInt(sizesObj[sizeId], 10) || 0;
      rewashTotal += parseInt(rewashObj[sizeId], 10) || 0;
      rejectTotal += parseInt(rejectObj[sizeId], 10) || 0;
    }

    const grandTotal = okTotal + rewashTotal + rejectTotal;
    if (grandTotal <= 0) {
      return res.status(400).json({ error: 'No pieces entered.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Get washing_data
    const [[wd]] = await conn.query(`SELECT * FROM washing_data WHERE id = ?`, [selectedLotId]);
    if (!wd) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ error: 'Invalid lot selection.' });
    }

    // 2) Validate sizes against available pieces
    const sizeIds = Array.from(allSizeIds);
    const [sizeRows] = await conn.query(
      `SELECT id, size_label, pieces FROM washing_data_sizes WHERE id IN (?)`,
      [sizeIds.length ? sizeIds : [0]]
    );
    const sizeMap = {};
    for (const row of sizeRows) sizeMap[row.id] = row;

    const sizeLabels = sizeRows.map(r => r.size_label);
    const [usedRows] = await conn.query(
      `SELECT wids.size_label, COALESCE(SUM(wids.pieces), 0) AS usedCount
       FROM washing_in_data_sizes wids
       JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
       WHERE wid.lot_no = ? AND wids.size_label IN (?)
       GROUP BY wids.size_label`,
      [wd.lot_no, sizeLabels.length ? sizeLabels : ['']]
    );
    const usedMap = {};
    for (const row of usedRows) usedMap[row.size_label] = row.usedCount;

    // Validate total requested per size doesn't exceed available
    for (const sizeId of sizeIds) {
      const row = sizeMap[sizeId];
      if (!row) continue;
      const ok = parseInt(sizesObj[sizeId], 10) || 0;
      const rw = parseInt(rewashObj[sizeId], 10) || 0;
      const rj = parseInt(rejectObj[sizeId], 10) || 0;
      const requested = ok + rw + rj;
      if (requested === 0) continue;
      const used = usedMap[row.size_label] || 0;
      const remain = row.pieces - used;
      if (requested > remain) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: `Total ${requested} for ${row.size_label} exceeds available ${remain}.` });
      }
    }

    // 3) Create washing_in_assignments record (auto-approved)
    const sizesJson = JSON.stringify(sizeRows.filter(r => {
      const sid = r.id;
      return (parseInt(sizesObj[sid], 10) || 0) + (parseInt(rewashObj[sid], 10) || 0) + (parseInt(rejectObj[sid], 10) || 0) > 0;
    }).map(r => r.size_label));

    await conn.query(`
      INSERT INTO washing_in_assignments
        (washing_master_id, user_id, washing_data_id, assigned_on, sizes_json, is_approved, approved_on)
      VALUES (?, ?, ?, NOW(), ?, 1, NOW())
    `, [wd.user_id, userId, wd.id, sizesJson]);

    let newWashingInId = null;
    let rewashRequestId = null;
    let rejectDataId = null;

    // 4) Insert washing_in_data for OK pieces (if any)
    if (okTotal > 0) {
      const [dataResult] = await conn.query(`
        INSERT INTO washing_in_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `, [userId, wd.lot_no, wd.sku, okTotal, remark || null, image_url]);
      newWashingInId = dataResult.insertId;

      // Insert washing_in_data_sizes for OK pieces
      for (const sizeId of sizeIds) {
        const numVal = parseInt(sizesObj[sizeId], 10) || 0;
        if (numVal <= 0) continue;
        const sds = sizeMap[sizeId];
        await conn.query(
          `INSERT INTO washing_in_data_sizes (washing_in_data_id, size_label, pieces, created_at)
           VALUES (?, ?, ?, NOW())`,
          [newWashingInId, sds.size_label, numVal]
        );
      }
    }

    // 5) Handle REWASH pieces
    if (rewashTotal > 0) {
      // Create rewash_request
      const [rrResult] = await conn.query(`
        INSERT INTO rewash_requests
          (washing_data_id, washer_id, user_id, lot_no, sku, total_requested, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `, [wd.id, wd.user_id, userId, wd.lot_no, wd.sku, rewashTotal]);
      rewashRequestId = rrResult.insertId;

      // Insert rewash_request_sizes
      for (const sizeId of sizeIds) {
        const numVal = parseInt(rewashObj[sizeId], 10) || 0;
        if (numVal <= 0) continue;
        const sds = sizeMap[sizeId];
        await conn.query(
          `INSERT INTO rewash_request_sizes (rewash_request_id, size_label, pieces_requested)
           VALUES (?, ?, ?)`,
          [rewashRequestId, sds.size_label, numVal]
        );
      }

      // Create DEBIT against washer (rewashTotal × REWASH_DEBIT_RATE)
      const [[washerInfo]] = await conn.query(`SELECT username FROM users WHERE id = ?`, [wd.user_id]);
      const debitAmount = rewashTotal * REWASH_DEBIT_RATE;

      const [debitResult] = await conn.query(`
        INSERT INTO stage_debits
          (user_id, username, lot_no, sku, stage, qty, rate, amount, reason, raised_by, rewash_request_id, auto_created, status)
        VALUES (?, ?, ?, ?, 'washing', ?, ?, ?, ?, ?, ?, 1, 'approved')
      `, [
        wd.user_id,
        washerInfo?.username || 'Unknown',
        wd.lot_no,
        wd.sku,
        rewashTotal,
        REWASH_DEBIT_RATE,
        debitAmount,
        `Rewash penalty: ${rewashTotal} pcs × ₹${REWASH_DEBIT_RATE}`,
        userId,
        rewashRequestId
      ]);

      // Update rewash_request with debit_id
      await conn.query(`UPDATE rewash_requests SET debit_id = ? WHERE id = ?`, [debitResult.insertId, rewashRequestId]);
    }

    // 6) Handle REJECT pieces
    if (rejectTotal > 0) {
      const [rejectResult] = await conn.query(`
        INSERT INTO reject_data
          (lot_no, sku, stage, user_id, source_data_id, total_pieces, reason, created_at)
        VALUES (?, ?, 'washing_in', ?, ?, ?, ?, NOW())
      `, [wd.lot_no, wd.sku, userId, wd.id, rejectTotal, rejectReason || 'Quality issue']);
      rejectDataId = rejectResult.insertId;

      // Insert reject_data_sizes
      for (const sizeId of sizeIds) {
        const numVal = parseInt(rejectObj[sizeId], 10) || 0;
        if (numVal <= 0) continue;
        const sds = sizeMap[sizeId];
        await conn.query(
          `INSERT INTO reject_data_sizes (reject_data_id, size_label, pieces)
           VALUES (?, ?, ?)`,
          [rejectDataId, sds.size_label, numVal]
        );
      }
    }

    // 7) Auto-create washing payment ONLY for OK pieces (not rewash, not reject)
    if (okTotal > 0) {
      const [[washingMaster]] = await conn.query(
        `SELECT username FROM users WHERE id = ?`,
        [wd.user_id]
      );
      if (washingMaster) {
        await createStagePayment('washing', {
          lot_no: wd.lot_no,
          sku: wd.sku,
          qty: okTotal,
          user_id: wd.user_id,
          username: washingMaster.username
        });
      }
    }

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      message: `Washing In completed! OK: ${okTotal}, Rewash: ${rewashTotal}, Reject: ${rejectTotal}`,
      washingInDataId: newWashingInId,
      rewashRequestId,
      rejectDataId
    });
  } catch (err) {
    console.error('[ERROR] POST /washingin/submit =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    return res.status(500).json({ error: 'Error creating washing_in data: ' + err.message });
  }
});

// GET /washingin/my-today
router.get('/my-today', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [rows] = await pool.query(`
      SELECT id, lot_no, sku, total_pieces, created_at
      FROM washing_in_data
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

// GET /washingin/my-entries
router.get('/my-entries', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = `
      SELECT wid.id, wid.lot_no, wid.sku, wid.total_pieces, wid.created_at, cl.remark as cutting_remark
      FROM washing_in_data wid
      LEFT JOIN cutting_lots cl ON wid.lot_no = cl.lot_no
      WHERE wid.user_id = ? AND (wid.lot_no LIKE ? OR wid.sku LIKE ?)
    `;
    const params = [userId, search, search];

    if (startDate) { query += ` AND DATE(wid.created_at) >= ?`; params.push(startDate); }
    if (endDate) { query += ` AND DATE(wid.created_at) <= ?`; params.push(endDate); }
    query += ` ORDER BY wid.created_at DESC LIMIT 20 OFFSET ?`;
    params.push(offset);

    const [rows] = await pool.query(query, params);
    return res.json({ entries: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /washingin/lot-details/:lotNo
router.get('/lot-details/:lotNo', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const lotNo = req.params.lotNo;
    const userId = req.session.user.id;

    const [[lot]] = await pool.query(`
      SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.remark as cutting_remark,
             u_cut.username as cutting_master
      FROM cutting_lots cl
      LEFT JOIN users u_cut ON cl.user_id = u_cut.id
      WHERE cl.lot_no = ?
    `, [lotNo]);

    if (!lot) {
      return res.json({ success: false, error: 'Lot not found' });
    }

    const [[stitched]] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) as qty FROM stitching_data WHERE lot_no = ?`, [lotNo]);
    const [[assembled]] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) as qty FROM jeans_assembly_data WHERE lot_no = ?`, [lotNo]);
    const [[washed]] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) as qty FROM washing_data WHERE lot_no = ?`, [lotNo]);
    const [[washedIn]] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) as qty FROM washing_in_data WHERE lot_no = ?`, [lotNo]);
    const [[finished]] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) as qty FROM finishing_data WHERE lot_no = ?`, [lotNo]);

    const [[payment]] = await pool.query(`
      SELECT sp.status as payment_status, sp.total_amount as payment_amount
      FROM stage_payments sp
      WHERE sp.lot_no = ? AND sp.stage = 'washing_in' AND sp.user_id = ?
      ORDER BY sp.created_at DESC LIMIT 1
    `, [lotNo, userId]);

    lot.stitched_qty = stitched.qty;
    lot.assembly_qty = assembled.qty;
    lot.washed_qty = washed.qty;
    lot.washed_in_qty = washedIn.qty;
    lot.finished_qty = finished.qty;
    lot.payment_status = payment ? payment.payment_status : null;
    lot.payment_amount = payment ? payment.payment_amount : 0;

    return res.json({ success: true, lot });
  } catch (err) {
    console.error('[ERROR] GET /lot-details =>', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /washingin/history-download
router.get('/history-download', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = `
      SELECT wid.lot_no, wid.sku, wid.total_pieces, wid.created_at, cl.remark as cutting_remark
      FROM washing_in_data wid
      LEFT JOIN cutting_lots cl ON wid.lot_no = cl.lot_no
      WHERE wid.user_id = ? AND (wid.lot_no LIKE ? OR wid.sku LIKE ?)
    `;
    const params = [userId, search, search];

    if (startDate) { query += ` AND DATE(wid.created_at) >= ?`; params.push(startDate); }
    if (endDate) { query += ` AND DATE(wid.created_at) <= ?`; params.push(endDate); }
    query += ` ORDER BY wid.created_at DESC`;

    const [rows] = await pool.query(query, params);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Washing In History');

    sheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 25 },
      { header: 'Pieces', key: 'total_pieces', width: 10 },
      { header: 'Date', key: 'created_at', width: 15 },
      { header: 'Cutting Remark', key: 'cutting_remark', width: 30 }
    ];

    rows.forEach(r => {
      sheet.addRow({
        lot_no: r.lot_no,
        sku: r.sku,
        total_pieces: r.total_pieces,
        created_at: new Date(r.created_at).toLocaleDateString('en-IN'),
        cutting_remark: r.cutting_remark || ''
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=washing_in_history.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /history-download =>', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
