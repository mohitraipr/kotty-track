// routes/washingRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isWashingMaster } = require('../middlewares/auth');
const { createStagePayment } = require('../utils/stagePaymentHelper');

// MULTER SETUP
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + file.originalname;
    cb(null, 'wash-' + uniqueSuffix);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max for images
});

/*------------------------------------------
  1) WASHING DASHBOARD ENDPOINTS
------------------------------------------*/
// GET /washingdashboard
router.get('/', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Now with LEFT JOIN to cutting_lots for remark
    const [lots] = await pool.query(`
      SELECT jd.id,
             jd.lot_no,
             jd.sku,
             jd.total_pieces,
             jd.created_at,
             cl.remark AS cutting_remark
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd
        ON wa.jeans_assembly_assignment_id = jd.id
      LEFT JOIN cutting_lots cl
        ON cl.lot_no = jd.lot_no  -- or whichever column matches
      WHERE wa.user_id = ?
        AND wa.is_approved = 1
        AND jd.lot_no NOT IN (
          SELECT lot_no
          FROM washing_data
          WHERE user_id = ?
        )
      ORDER BY jd.created_at DESC
     
    `, [userId, userId]);

    // Now each lot object has cutting_remark as well
    return res.render('washingDashboard', {
      user: req.session.user,
      lots,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard =>', err);
    req.flash('error', 'Cannot load washing dashboard data.');
    return res.redirect('/');
  }
});



router.post('/create', isAuthenticated, isWashingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { selectedLotId, remark } = req.body;
    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }
    const sizesObj = req.body.sizes || {};          // e.g. sizes[sizeId] = pieces
    const assignmentsObj = req.body.assignments || {}; // e.g. assignments[sizeId] = washing_in user id

    // Validate presence of at least one size
    let grandTotal = 0;
    for (const sizeId of Object.keys(sizesObj)) {
      const countVal = parseInt(sizesObj[sizeId], 10);
      if (isNaN(countVal) || countVal < 0) {
        req.flash('error', `Invalid piece count for sizeId ${sizeId}.`);
        return res.redirect('/washingdashboard');
      }
      if (countVal > 0) {
        grandTotal += countVal;
      }
    }
    if (grandTotal <= 0) {
      req.flash('error', 'No pieces requested.');
      return res.redirect('/washingdashboard');
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Find the selected lot in jeans_assembly_data for washing
    const [[jd]] = await conn.query(`SELECT * FROM jeans_assembly_data WHERE id = ?`, [selectedLotId]);
    if (!jd) {
      req.flash('error', 'Invalid lot selection.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }

    // 2) Check if the lot has already been used for washing by this user
    const [[already]] = await conn.query(`SELECT id FROM washing_data WHERE lot_no = ? AND user_id = ?`, [jd.lot_no, userId]);
    if (already) {
      req.flash('error', `Lot ${jd.lot_no} already used for washing by you.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }

  // 3) Validate each requested size against its available pieces in bulk
  const sizeIds = Object.keys(sizesObj).map(id => parseInt(id, 10)).filter(Boolean);
  const [sizeRows] = await conn.query(
    `SELECT id, size_label, pieces FROM jeans_assembly_data_sizes WHERE id IN (?)`,
    [sizeIds]
  );
  const sizeMap = {};
  for (const row of sizeRows) sizeMap[row.id] = row;
  if (sizeRows.length !== sizeIds.length) {
    req.flash('error', 'Invalid size reference.');
    await conn.rollback();
    conn.release();
    return res.redirect('/washingdashboard');
  }

  const sizeLabels = sizeRows.map(r => r.size_label);
  const [usedRows] = await conn.query(
    `SELECT wds.size_label, COALESCE(SUM(wds.pieces),0) AS usedCount
       FROM washing_data_sizes wds
       JOIN washing_data wd ON wds.washing_data_id = wd.id
      WHERE wd.lot_no = ? AND wds.size_label IN (?)
      GROUP BY wds.size_label`,
    [jd.lot_no, sizeLabels]
  );
  const usedMap = {};
  for (const row of usedRows) usedMap[row.size_label] = row.usedCount;

  for (const sizeId of sizeIds) {
    const row = sizeMap[sizeId];
    const requested = parseInt(sizesObj[sizeId], 10) || 0;
    if (requested === 0) continue;
    const used = usedMap[row.size_label] || 0;
    const remain = row.pieces - used;
    if (requested > remain) {
      req.flash('error', `Requested ${requested} for ${row.size_label}, but only ${remain} remain.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }
  }

    // 4) Insert main record into washing_data
    const [mainResult] = await conn.query(`
      INSERT INTO washing_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, jd.lot_no, jd.sku, grandTotal, remark || null, image_url]);
    const newId = mainResult.insertId;

    // 5) Insert into washing_data_sizes for each provided size
    for (const sizeId of Object.keys(sizesObj)) {
      const numVal = parseInt(sizesObj[sizeId], 10) || 0;
      if (numVal <= 0) continue;
      const sds = sizeMap[sizeId];
      await conn.query(
        `INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces, created_at)
         VALUES (?, ?, ?, NOW())`,
        [newId, sds.size_label, numVal]
      );
    }

    // 6) Process partial assignment (optional)
    const assignMap = {}; // { washing_in_user_id: [sizeLabel1, sizeLabel2, ...] }
    for (const sizeId of Object.keys(assignmentsObj)) {
      const assignedUser = assignmentsObj[sizeId];
      if (!assignedUser) continue;
      const sds = sizeMap[sizeId];
      if (!sds) {
        req.flash('error', 'Invalid size reference in assignment: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingdashboard');
      }
      if (!assignMap[assignedUser]) {
        assignMap[assignedUser] = [];
      }
      assignMap[assignedUser].push(sds.size_label);
    }
    // For each user, insert one record in washing_in_assignments
    for (const assignedUserId of Object.keys(assignMap)) {
      const sizesJson = JSON.stringify(assignMap[assignedUserId]);
      await conn.query(`
        INSERT INTO washing_in_assignments
          (washing_master_id, user_id, washing_data_id, target_day, assigned_on, sizes_json, is_approved)
        VALUES (?, ?, ?, NULL, NOW(), ?, NULL)
      `, [userId, assignedUserId, newId, sizesJson]);
    }

    await conn.commit();
    conn.release();

    req.flash('success', 'Washing entry created successfully (with optional assignments)!');
    return res.redirect('/washingdashboard');
  } catch (err) {
    console.error('[ERROR] POST /washingdashboard/create =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error creating washing data: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

// GET /washingdashboard/get-lot-sizes/:lotId
router.get('/get-lot-sizes/:lotId', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;
    const [[stData]] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data
      WHERE id = ?
    `, [lotId]);
    if (!stData) {
      return res.status(404).json({ error: 'Lot not found' });
    }

    const [rows] = await pool.query(`
      SELECT s.id, s.size_label, s.pieces,
             s.pieces - COALESCE(SUM(wds.pieces),0) AS remain
        FROM jeans_assembly_data_sizes s
        LEFT JOIN washing_data_sizes wds
          ON s.size_label = wds.size_label
         AND wds.washing_data_id IN (
              SELECT id FROM washing_data WHERE lot_no = ?
          )
       WHERE s.jeans_assembly_data_id = ?
       GROUP BY s.id
    `, [stData.lot_no, lotId]);

    return res.json(rows.map(r => ({
      id: r.id,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    })));
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/get-lot-sizes/:lotId =>', err);
    return res.status(500).json({ error: 'Error fetching lot sizes: ' + err.message });
  }
});

// GET /washingdashboard/update/:id/json
// GET /washingdashboard/update/:id/json
router.get('/update/:id/json', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const entryId = req.params.id;
    const userId  = req.session.user.id;

    // 1) Fetch the parent entry
    const [[ entry ]] = await pool.query(`
      SELECT * 
      FROM washing_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);

    if (!entry) {
      return res.status(403).json({ error: 'Not found or no permission' });
    }

    const [rows] = await pool.query(`
      SELECT wds.id, wds.size_label, wds.pieces,
             jad.pieces - COALESCE(u.usedCount,0) AS remain
        FROM washing_data_sizes wds
        JOIN jeans_assembly_data_sizes jad
          ON jad.size_label = wds.size_label
         AND jad.jeans_assembly_data_id = (
              SELECT id FROM jeans_assembly_data WHERE lot_no = ? LIMIT 1
          )
        LEFT JOIN (
          SELECT wds.size_label, SUM(wds.pieces) AS usedCount
            FROM washing_data_sizes wds
            JOIN washing_data wd ON wds.washing_data_id = wd.id
           WHERE wd.lot_no = ?
           GROUP BY wds.size_label
        ) u ON u.size_label = wds.size_label
       WHERE wds.washing_data_id = ?
    `, [entry.lot_no, entry.lot_no, entryId]);

    return res.json({ sizes: rows.map(r => ({
      id: r.id,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    })) });
  } catch (err) {
    console.error('[ERROR] GET /update/:id/json =>', err);
    return res.status(500).json({ error: err.message });
  }
});


// POST /washingdashboard/update/:id
router.post('/update/:id', isAuthenticated, isWashingMaster, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const entryId     = req.params.id;
    const userId      = req.session.user.id;
    const updateSizes = req.body.updateSizes || {};

    // 1) Re-fetch & authorize
    const [[ entry ]] = await conn.query(`
      SELECT * 
      FROM washing_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Record not found or no permission.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }

    let updatedTotal = entry.total_pieces;

    const sizeRows = await conn.query(
      `SELECT id, size_label, pieces FROM washing_data_sizes WHERE washing_data_id = ?`,
      [entryId]
    );
    const sizeMap = {};
    const labels = [];
    for (const row of sizeRows[0]) { sizeMap[row.id] = row; labels.push(row.size_label); }

    const [allowedRows] = await conn.query(
      `SELECT size_label, pieces FROM jeans_assembly_data_sizes
        WHERE jeans_assembly_data_id = (SELECT id FROM jeans_assembly_data WHERE lot_no = ? LIMIT 1)
          AND size_label IN (?)`,
      [entry.lot_no, labels]
    );
    const allowedMap = {};
    for (const r of allowedRows) allowedMap[r.size_label] = r.pieces;

    const [usedRows] = await conn.query(
      `SELECT wds.size_label, SUM(wds.pieces) AS usedCount
         FROM washing_data_sizes wds
         JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ? AND wds.size_label IN (?)
        GROUP BY wds.size_label`,
      [entry.lot_no, labels]
    );
    const usedMap = {};
    for (const r of usedRows) usedMap[r.size_label] = r.usedCount;

    for (const sizeIdStr of Object.keys(updateSizes)) {
      const sizeId    = parseInt(sizeIdStr, 10);
      let increment   = parseInt(updateSizes[sizeIdStr], 10);
      if (isNaN(increment) || increment <= 0) continue;

      const existingRow = sizeMap[sizeId];
      if (!existingRow) throw new Error(`Invalid size ID ${sizeId} for this entry.`);
      const label = existingRow.size_label;
      const totalAllowed = allowedMap[label] || 0;
      const used = usedMap[label] || 0;
      const remain = totalAllowed - used;
      if (increment > remain) {
        throw new Error(`Cannot add ${increment} to size [${label}]; only ${remain} remain.`);
      }

      const newCount = existingRow.pieces + increment;
      await conn.query(`UPDATE washing_data_sizes SET pieces = ? WHERE id = ?`, [newCount, sizeId]);
      await conn.query(`INSERT INTO washing_data_updates (washing_data_id, size_label, pieces, updated_at)
                        VALUES (?, ?, ?, NOW())`, [entryId, label, increment]);
      updatedTotal += increment;
    }

    // 7) Persist the new total
    await conn.query(`
      UPDATE washing_data
      SET total_pieces = ?
      WHERE id = ?
    `, [updatedTotal, entryId]);

    await conn.commit();
    conn.release();

    req.flash('success', 'Washing data updated successfully!');
    return res.redirect('/washingdashboard');

  } catch (err) {
    console.error('[ERROR] POST /update/:id =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error updating washing data: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

// GET /washingdashboard/challan/:id
router.get('/challan/:id', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const [[row]] = await pool.query(`
      SELECT *
      FROM washing_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/washingdashboard');
    }
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id = ?
      ORDER BY id ASC
    `, [entryId]);
    const [updates] = await pool.query(`
      SELECT *
      FROM washing_data_updates
      WHERE washing_data_id = ?
      ORDER BY updated_at ASC
    `, [entryId]);

    return res.render('washingChallan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates
    });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/challan/:id =>', err);
    req.flash('error', 'Error loading washing challan: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

// GET /washingdashboard/download-all
router.get('/download-all', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [mainRows] = await pool.query(`
      SELECT *
      FROM washing_data
      WHERE user_id = ?
      ORDER BY created_at ASC
    `, [userId]);

    const [allSizes] = await pool.query(`
      SELECT wds.*
      FROM washing_data_sizes wds
      JOIN washing_data wd ON wd.id = wds.washing_data_id
      WHERE wd.user_id = ?
      ORDER BY wds.washing_data_id, wds.id
    `, [userId]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();

    const mainSheet = workbook.addWorksheet('WashingData');
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

    const sizesSheet = workbook.addWorksheet('WashingSizes');
    sizesSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Washing ID', key: 'washing_data_id', width: 12 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Pieces', key: 'pieces', width: 8 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        washing_data_id: s.washing_data_id,
        size_label: s.size_label,
        pieces: s.pieces,
        created_at: s.created_at
      });
    });

    res.setHeader('Content-Disposition', 'attachment; filename="WashingData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/download-all =>', err);
    req.flash('error', 'Could not download washing Excel: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

// GET /washingdashboard/download-summary
router.get('/download-summary', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [assignRows] = await pool.query(
      `SELECT wa.assigned_on, wa.sizes_json, jd.lot_no, jd.sku,
              cl.remark AS cutting_remark, cl.total_pieces AS cutting_pieces
         FROM washing_assignments wa
         JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
         LEFT JOIN cutting_lots cl ON cl.lot_no = jd.lot_no
        WHERE wa.user_id = ?
        ORDER BY wa.assigned_on ASC`,
      [userId]
    );

    const summaryMap = {};
    assignRows.forEach(r => {
      let pieces = 0;
      try {
        const arr = JSON.parse(r.sizes_json || '[]');
        if (Array.isArray(arr)) {
          for (const s of arr) pieces += parseInt(s.pieces, 10) || 0;
        }
      } catch (e) { pieces = 0; }
      if (!summaryMap[r.lot_no]) {
        summaryMap[r.lot_no] = {
          lot_no: r.lot_no,
          sku: r.sku,
          cutting_pieces: r.cutting_pieces || 0,
          cutting_remark: r.cutting_remark || '',
          assigned_pieces: 0,
          completed_pieces: 0,
          washing_in_pieces: 0,
          assigned_on: r.assigned_on,
          washing_date: null
        };
      }
      summaryMap[r.lot_no].assigned_pieces += pieces;
    });

    const [washRows] = await pool.query(
      `SELECT lot_no, SUM(total_pieces) AS completed_pieces,
              MIN(created_at) AS washing_date
         FROM washing_data
        WHERE user_id = ?
        GROUP BY lot_no`,
      [userId]
    );
    washRows.forEach(r => {
      if (!summaryMap[r.lot_no]) {
        summaryMap[r.lot_no] = {
          lot_no: r.lot_no,
          sku: '',
          cutting_pieces: 0,
          cutting_remark: '',
          assigned_pieces: 0,
          completed_pieces: parseInt(r.completed_pieces, 10) || 0,
          washing_in_pieces: 0,
          assigned_on: null,
          washing_date: r.washing_date
        };
      } else {
        summaryMap[r.lot_no].completed_pieces = parseInt(r.completed_pieces, 10) || 0;
        summaryMap[r.lot_no].washing_date = r.washing_date;
      }
    });

    const [wiaRows] = await pool.query(
      `SELECT wia.washing_data_id, wia.sizes_json, wd.lot_no
         FROM washing_in_assignments wia
         JOIN washing_data wd ON wia.washing_data_id = wd.id
        WHERE wia.washing_master_id = ?`,
      [userId]
    );
    const dataIds = [...new Set(wiaRows.map(r => r.washing_data_id))];
    if (dataIds.length) {
      const [sizeRows] = await pool.query(
        `SELECT washing_data_id, size_label, pieces
           FROM washing_data_sizes
          WHERE washing_data_id IN (?)`,
        [dataIds]
      );
      const sizeMap = {};
      sizeRows.forEach(s => {
        if (!sizeMap[s.washing_data_id]) sizeMap[s.washing_data_id] = {};
        sizeMap[s.washing_data_id][s.size_label] = s.pieces;
      });
      wiaRows.forEach(r => {
        let pcs = 0;
        try {
          const arr = JSON.parse(r.sizes_json || '[]');
          const mp = sizeMap[r.washing_data_id] || {};
          if (Array.isArray(arr)) {
            for (const lbl of arr) pcs += mp[lbl] || 0;
          }
        } catch (e) { pcs = 0; }
        if (!summaryMap[r.lot_no]) {
          summaryMap[r.lot_no] = {
            lot_no: r.lot_no,
            sku: '',
            cutting_pieces: 0,
            cutting_remark: '',
            assigned_pieces: 0,
            completed_pieces: 0,
            washing_in_pieces: pcs,
            assigned_on: null,
            washing_date: null
          };
        } else {
          summaryMap[r.lot_no].washing_in_pieces += pcs;
        }
      });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('WashingSummary');
    sheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Cutting Pieces', key: 'cutting_pieces', width: 15 },
      { header: 'Cutting Remark', key: 'cutting_remark', width: 25 },
      { header: 'Assigned On', key: 'assigned_on', width: 20 },
      { header: 'Assigned Pieces', key: 'assigned_pieces', width: 15 },
      { header: 'Completed Pieces', key: 'completed_pieces', width: 15 },
      { header: 'Assigned to Washing In', key: 'washing_in_pieces', width: 20 },
      { header: 'Washing Date', key: 'washing_date', width: 20 }
    ];
    Object.values(summaryMap).forEach(r => sheet.addRow(r));

    res.setHeader('Content-Disposition', 'attachment; filename="WashingSummary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/download-summary =>', err);
    req.flash('error', 'Could not download summary: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

/*
  GET /washingdashboard/list-entries
  Used by front-end for pagination & searching existing washing_data
*/// GET /washingdashboard/list-entries
router.get('/list-entries', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const limit = 10;

    const [rows] = await pool.query(`
      SELECT 
        wd.*,
        cl.remark AS cutting_remark,
        (
          SELECT JSON_ARRAYAGG(
            JSON_OBJECT('size_label', wds.size_label, 'pieces', wds.pieces)
          )
          FROM washing_data_sizes wds
          WHERE wds.washing_data_id = wd.id
        ) AS sizes
      FROM washing_data wd
      LEFT JOIN cutting_lots cl
        ON cl.lot_no = wd.lot_no
      WHERE wd.user_id = ?
        AND (wd.lot_no LIKE ? OR wd.sku LIKE ?)
      ORDER BY wd.created_at DESC
      LIMIT ?, ?
    `, [userId, search, search, offset, limit]);

    const hasMore = rows.length === limit;
    return res.json({ data: rows, hasMore });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

/*-----------------------------------------
  2) OLD APPROVAL ROUTES REMOVED (2026-04-23)
  Now using self-assign flow: /available-lots + /submit
  See git history if rollback needed
-----------------------------------------*/

/*-----------------------------------------
  3) ASSIGN TO "WASHING_IN"
-----------------------------------------*/

router.get('/assign-washing-in', isAuthenticated, isWashingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('washingAssignWashingIn', {
    user: req.session.user,
    error,
    success
  });
});

// GET /washingdashboard/assign-washing-in/users => WashingIn users
router.get('/assign-washing-in/users', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    // Example: role name is 'washing_in'
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'washing_in'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /assign-washing-in/users =>', err);
    return res.status(500).json({ error: 'Server error fetching washing_in users.' });
  }
});

// GET /washingdashboard/assign-washing-in/data => unassigned partial sizes from washing_data
router.get('/assign-washing-in/data', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    // 1) fetch all washing_data for this user
    const [rows] = await pool.query(`
      SELECT id AS washing_data_id, lot_no, sku, total_pieces
      FROM washing_data
      WHERE user_id = ?
    `, [userId]);
    if (!rows.length) return res.json({ data: [] });

    // 2) find what's already assigned in washing_in_assignments
    const [winRows] = await pool.query(`
      SELECT washing_data_id, sizes_json
      FROM washing_in_assignments
      WHERE washing_master_id = ?
    `, [userId]);

    const assignedMap = {};
    for (const r of winRows) {
      if (!assignedMap[r.washing_data_id]) {
        assignedMap[r.washing_data_id] = new Set();
      }
      if (r.sizes_json) {
        try {
          const arr = JSON.parse(r.sizes_json); 
          if (Array.isArray(arr)) {
            for (const lbl of arr) {
              assignedMap[r.washing_data_id].add(lbl);
            }
          }
        } catch (e) {
          console.error('[ERROR] parsing sizes_json =>', e);
        }
      }
    }

    // 3) gather sizes from washing_data_sizes
    const wDataIds = rows.map(r => r.washing_data_id);
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id IN (?)
    `, [wDataIds]);

    const dataMap = {};
    for (const row of rows) {
      dataMap[row.washing_data_id] = {
        washing_data_id: row.washing_data_id,
        lot_no: row.lot_no,
        sku: row.sku,
        sizes: []
      };
    }

    // For each size, skip if it's already assigned
    for (const s of sizes) {
      const assignedSet = assignedMap[s.washing_data_id] || new Set();
      if (!assignedSet.has(s.size_label)) {
        dataMap[s.washing_data_id].sizes.push({
          size_label: s.size_label,
          pieces: s.pieces
        });
      }
    }

    // filter out any with 0 sizes left unassigned
    const output = Object.values(dataMap).filter(o => o.sizes.length > 0);
    return res.json({ data: output });
  } catch (err) {
    console.error('[ERROR] GET /assign-washing-in/data =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /assign-washing-in => Insert rows in washing_in_assignments
router.post('/assign-washing-in', isAuthenticated, isWashingMaster, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const washingMasterId = req.session.user.id;
    const washingInAssignments = req.body.washingInAssignments || {};
    const washingInUserIds = Object.keys(washingInAssignments);

    if (!washingInUserIds.length) {
      req.flash('error', 'No washing_in assignments data provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard/assign-washing-in');
    }

    const allWDataIds = [];
    for (const wInUserId of washingInUserIds) {
      const arr = washingInAssignments[wInUserId];
      if (Array.isArray(arr)) {
        for (const item of arr) allWDataIds.push(parseInt(item.washing_data_id, 10));
      }
    }
    const uniqueIds = [...new Set(allWDataIds)];
    const [validRows] = await conn.query(
      `SELECT id FROM washing_data WHERE user_id = ? AND id IN (?)`,
      [washingMasterId, uniqueIds]
    );
    const validSet = new Set(validRows.map(r => r.id));

    for (const wInUserId of washingInUserIds) {
      const arr = washingInAssignments[wInUserId];
      if (!Array.isArray(arr) || !arr.length) continue;

      // group by "washing_data_id"
      const mapByDataId = {};
      for (const item of arr) {
        const wDataIdStr = item.washing_data_id;
        const sizeLabel = item.size_label;

        const wDataId = parseInt(wDataIdStr, 10);
        if (!wDataId || isNaN(wDataId)) {
          throw new Error(`Invalid washing_data_id: ${wDataIdStr}`);
        }
        if (!mapByDataId[wDataId]) {
          mapByDataId[wDataId] = [];
        }
        mapByDataId[wDataId].push(sizeLabel);
      }

      // Insert one row in washing_in_assignments per (wDataId, user)
      for (const wDataId of Object.keys(mapByDataId).map(k => parseInt(k, 10))) {
        const sizeLabels = mapByDataId[wDataId];
        if (!sizeLabels || !sizeLabels.length) continue;

        // Check that washing_data belongs to this washing master
        if (!validSet.has(wDataId)) {
          throw new Error(`No valid washing_data id=${wDataId} for user=${washingMasterId}`);
        }

        const sizesJson = JSON.stringify(sizeLabels);

        await conn.query(`
          INSERT INTO washing_in_assignments
            (washing_master_id, user_id, washing_data_id, target_day, assigned_on, sizes_json, is_approved)
          VALUES (?, ?, ?, ?, NOW(), ?, NULL)
        `, [
          washingMasterId,
          wInUserId,
          wDataId,
          req.body.target_day || null, // optional
          sizesJson
        ]);
      }
    }

    await conn.commit();
    conn.release();
    req.flash('success', 'Successfully assigned partial sizes to washing_in!');
    return res.json({ success: true, message: 'Assigned partial sizes to washing_in!' });
  } catch (err) {
    console.error('[ERROR] POST /assign-washing-in =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error assigning washing_in: ' + err.message);
    return res.status(500).json({ success: false, error: 'Error assigning washing_in: ' + err.message });
  }
});
// POST /washingdashboard/create

// GET /washingdashboard/create/assignable-users
router.get('/create/assignable-users', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    // Fetch all active users with the "washing_in" role
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'washing_in'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/create/assignable-users =>', err);
    return res.status(500).json({ error: err.message });
  }
});

/*-----------------------------------------
  SELF-ASSIGN FLOW (Stitching-style)
  Worker picks available lot + submits in one step
-----------------------------------------*/

// GET /washingdashboard/available-lots
// Shows denim lots with jeans_assembly_data that haven't been fully washed
router.get('/available-lots', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : '%';

    // Find jeans_assembly_data records where:
    // 1. flow_type is denim (or cutter is_denim_cutter = 1)
    // 2. Has remaining pieces not yet washed
    const [rows] = await pool.query(`
      SELECT
        jad.id,
        jad.lot_no,
        jad.sku,
        jad.total_pieces,
        jad.created_at,
        cl.remark AS cutting_remark,
        jad.total_pieces - COALESCE((
          SELECT SUM(wd.total_pieces)
          FROM washing_data wd
          WHERE wd.lot_no = jad.lot_no
        ), 0) AS remaining_pieces,
        u.username AS assembly_master
      FROM jeans_assembly_data jad
      LEFT JOIN users u ON jad.user_id = u.id
      LEFT JOIN cutting_lots cl ON cl.lot_no = jad.lot_no
      WHERE (jad.lot_no LIKE ? OR jad.sku LIKE ? OR cl.remark LIKE ?)
        AND (
          cl.flow_type = 'denim'
          OR EXISTS (
            SELECT 1 FROM users cu
            WHERE cu.id = cl.user_id AND cu.is_denim_cutter = 1
          )
          OR jad.lot_no REGEXP '^(AK|UM)'
        )
      HAVING remaining_pieces > 0
      ORDER BY jad.created_at DESC
      LIMIT 50
    `, [search, search, search]);

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/available-lots =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /washingdashboard/available-lot-sizes/:lotId
// Get sizes for a specific assembly lot with remaining counts for washing
router.get('/available-lot-sizes/:lotId', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;

    const [[jad]] = await pool.query(`SELECT * FROM jeans_assembly_data WHERE id = ?`, [lotId]);
    if (!jad) {
      return res.status(404).json({ error: 'Lot not found' });
    }

    const [rows] = await pool.query(`
      SELECT
        jads.id,
        jads.size_label,
        jads.pieces,
        jads.pieces - COALESCE((
          SELECT SUM(wds.pieces)
          FROM washing_data_sizes wds
          JOIN washing_data wd ON wds.washing_data_id = wd.id
          WHERE wd.lot_no = ? AND wds.size_label = jads.size_label
        ), 0) AS remain
      FROM jeans_assembly_data_sizes jads
      WHERE jads.jeans_assembly_data_id = ?
    `, [jad.lot_no, lotId]);

    return res.json(rows.map(r => ({
      id: r.id,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    })));
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/available-lot-sizes/:lotId =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /washingdashboard/submit
// Self-assign + complete washing in one step (stitching-style flow)
router.post('/submit', isAuthenticated, isWashingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const username = req.session.user.username;
    const { selectedLotId, remark } = req.body;
    const sizesObj = req.body.sizes || {};

    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    // Calculate total pieces
    let grandTotal = 0;
    for (const sizeId of Object.keys(sizesObj)) {
      const countVal = parseInt(sizesObj[sizeId], 10);
      if (!isNaN(countVal) && countVal > 0) {
        grandTotal += countVal;
      }
    }
    if (grandTotal <= 0) {
      return res.status(400).json({ error: 'No pieces requested.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Get jeans_assembly_data
    const [[jad]] = await conn.query(`SELECT * FROM jeans_assembly_data WHERE id = ?`, [selectedLotId]);
    if (!jad) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ error: 'Invalid lot selection.' });
    }

    // 2) Validate sizes against available pieces
    const sizeIds = Object.keys(sizesObj).map(id => parseInt(id, 10)).filter(Boolean);
    const [sizeRows] = await conn.query(
      `SELECT id, size_label, pieces FROM jeans_assembly_data_sizes WHERE id IN (?)`,
      [sizeIds.length ? sizeIds : [0]]
    );
    const sizeMap = {};
    for (const row of sizeRows) sizeMap[row.id] = row;

    const sizeLabels = sizeRows.map(r => r.size_label);
    const [usedRows] = await conn.query(
      `SELECT wds.size_label, COALESCE(SUM(wds.pieces), 0) AS usedCount
       FROM washing_data_sizes wds
       JOIN washing_data wd ON wds.washing_data_id = wd.id
       WHERE wd.lot_no = ? AND wds.size_label IN (?)
       GROUP BY wds.size_label`,
      [jad.lot_no, sizeLabels.length ? sizeLabels : ['']]
    );
    const usedMap = {};
    for (const row of usedRows) usedMap[row.size_label] = row.usedCount;

    for (const sizeId of sizeIds) {
      const row = sizeMap[sizeId];
      if (!row) continue;
      const requested = parseInt(sizesObj[sizeId], 10) || 0;
      if (requested === 0) continue;
      const used = usedMap[row.size_label] || 0;
      const remain = row.pieces - used;
      if (requested > remain) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: `Requested ${requested} for ${row.size_label}, but only ${remain} remain.` });
      }
    }

    // 3) Get assembly master info for payment (directly from jeans_assembly_data.user_id)
    const [[jadAssignment]] = await conn.query(`
      SELECT jad2.user_id AS assembly_master_id, u.username AS assembly_master_username
      FROM jeans_assembly_data jad2
      JOIN users u ON jad2.user_id = u.id
      WHERE jad2.id = ?
    `, [jad.id]);

    // 4) Create washing_assignments record (auto-approved)
    const sizesJson = JSON.stringify(sizeRows.filter(r => parseInt(sizesObj[r.id], 10) > 0).map(r => ({
      size_label: r.size_label,
      pieces: parseInt(sizesObj[r.id], 10)
    })));

    const [assignResult] = await conn.query(`
      INSERT INTO washing_assignments
        (jeans_assembly_master_id, user_id, jeans_assembly_assignment_id, assigned_on, sizes_json, is_approved, approved_on)
      VALUES (?, ?, ?, NOW(), ?, 1, NOW())
    `, [jadAssignment?.assembly_master_id || null, userId, jad.id, sizesJson]);

    // 5) Insert washing_data
    const [dataResult] = await conn.query(`
      INSERT INTO washing_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, jad.lot_no, jad.sku, grandTotal, remark || null, image_url]);
    const newId = dataResult.insertId;

    // 6) Insert washing_data_sizes
    for (const sizeId of sizeIds) {
      const numVal = parseInt(sizesObj[sizeId], 10) || 0;
      if (numVal <= 0) continue;
      const sds = sizeMap[sizeId];
      await conn.query(
        `INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces, created_at)
         VALUES (?, ?, ?, NOW())`,
        [newId, sds.size_label, numVal]
      );
    }

    // 7) Auto-create assembly payment
    if (jadAssignment) {
      await createStagePayment('assembly', {
        lot_no: jad.lot_no,
        sku: jad.sku,
        qty: grandTotal,
        user_id: jadAssignment.assembly_master_id,
        username: jadAssignment.assembly_master_username
      });
    }

    await conn.commit();
    conn.release();

    return res.json({
      success: true,
      message: 'Washing entry created successfully!',
      washingDataId: newId
    });
  } catch (err) {
    console.error('[ERROR] POST /washingdashboard/submit =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    return res.status(500).json({ error: 'Error creating washing data: ' + err.message });
  }
});

// GET /washingdashboard/my-today - Today's entries for current user
router.get('/my-today', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [rows] = await pool.query(`
      SELECT id, lot_no, sku, total_pieces, created_at
      FROM washing_data
      WHERE user_id = ? AND DATE(created_at) = CURDATE()
      ORDER BY created_at DESC
    `, [userId]);

    const totalToday = rows.reduce((sum, r) => sum + r.total_pieces, 0);

    return res.json({
      entries: rows,
      total_pieces: totalToday,
      count: rows.length
    });
  } catch (err) {
    console.error('[ERROR] GET /my-today =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /washingdashboard/my-entries - Paginated history
router.get('/my-entries', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset) || 0;
    const limit = 20;
    const search = req.query.search ? `%${req.query.search}%` : '%';

    const [rows] = await pool.query(`
      SELECT id, lot_no, sku, total_pieces, created_at
      FROM washing_data
      WHERE user_id = ? AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, search, search, limit, offset]);

    return res.json({ entries: rows });
  } catch (err) {
    console.error('[ERROR] GET /my-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
