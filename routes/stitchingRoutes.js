// routes/stitchingRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isStitchingMaster } = require('../middlewares/auth');

// MULTER SETUP (for image uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + file.originalname;
    cb(null, 'stitch-' + uniqueSuffix);
  }
});
const upload = multer({ storage });

/*------------------------------------------------------------------
  1) APPROVE STITCHING ASSIGNMENTS
------------------------------------------------------------------*/

// GET /stitchingdashboard/approve
router.get('/approve', isAuthenticated, isStitchingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('stitchingApprove', { user: req.session.user, error, success });
});

// GET /stitchingdashboard/approve/list
router.get('/approve/list', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = req.query.search || '';
    const searchLike = `%${search}%`;

    const [rows] = await pool.query(
      `
      SELECT sa.id AS assignment_id,
             sa.cutting_lot_id,
             sa.assigned_on,
             sa.isApproved,
             sa.assignment_remark,
             c.lot_no,
             c.sku
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
        AND sa.isApproved IS NULL
        AND (c.lot_no LIKE ? OR c.sku LIKE ?)
      ORDER BY sa.assigned_on DESC
      `,
      [userId, searchLike, searchLike]
    );

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /approve/list =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/approve-lot
router.post('/approve-lot', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id } = req.body;
    if (!assignment_id) {
      req.flash('error', 'No assignment_id provided.');
      return res.redirect('/stitchingdashboard/approve');
    }

    await pool.query(
      `
      UPDATE stitching_assignments
      SET isApproved = 1, assignment_remark = NULL
      WHERE id = ? AND user_id = ?
      `,
      [assignment_id, userId]
    );

    req.flash('success', 'Assignment approved successfully!');
    return res.redirect('/stitchingdashboard/approve');
  } catch (error) {
    console.error('[ERROR] POST /approve-lot =>', error);
    req.flash('error', 'Error approving assignment: ' + error.message);
    return res.redirect('/stitchingdashboard/approve');
  }
});

// POST /stitchingdashboard/deny-lot
router.post('/deny-lot', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id, denial_remark } = req.body;
    if (!assignment_id) {
      req.flash('error', 'No assignment_id provided.');
      return res.redirect('/stitchingdashboard/approve');
    }
    if (!denial_remark || !denial_remark.trim()) {
      req.flash('error', 'You must provide a remark for denial.');
      return res.redirect('/stitchingdashboard/approve');
    }

    await pool.query(
      `
      UPDATE stitching_assignments
      SET isApproved = 0, assignment_remark = ?
      WHERE id = ? AND user_id = ?
      `,
      [denial_remark.trim(), assignment_id, userId]
    );

    req.flash('success', 'Assignment denied successfully.');
    return res.redirect('/stitchingdashboard/approve');
  } catch (error) {
    console.error('[ERROR] POST /deny-lot =>', error);
    req.flash('error', 'Error denying assignment: ' + error.message);
    return res.redirect('/stitchingdashboard/approve');
  }
});

/*------------------------------------------------------------------
  2) MAIN STITCHING DASHBOARD: CREATE ENTRY, LIST, UPDATE
  (The code for these functionalities remains similar to your current code.)
------------------------------------------------------------------*/

// GET /stitchingdashboard
router.get('/', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [lots] = await pool.query(
      `
      SELECT c.id, c.lot_no, c.sku, c.total_pieces
      FROM cutting_lots c
      JOIN stitching_assignments sa ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
        AND sa.isApproved = 1
        AND c.lot_no NOT IN (
          SELECT lot_no FROM stitching_data
        )
      ORDER BY c.created_at DESC
      LIMIT 10
      `,
      [userId]
    );
    const error = req.flash('error');
    const success = req.flash('success');
    return res.render('stitchingDashboard', { user: req.session.user, lots, error, success });
  } catch (err) {
    console.error('[ERROR] GET /stitchingdashboard =>', err);
    req.flash('error', 'Cannot load dashboard data.');
    return res.redirect('/');
  }
});

// GET /stitchingdashboard/list-entries
router.get('/list-entries', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;
    const limit = 5;
    const searchLike = `%${searchTerm}%`;

    const [rows] = await pool.query(
      `
      SELECT *
      FROM stitching_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
      `,
      [userId, searchLike, searchLike, limit, offset]
    );
    if (!rows.length) {
      return res.json({ data: [], hasMore: false });
    }
    const entryIds = rows.map(r => r.id);
    const [sizeRows] = await pool.query(
      `
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id IN (?)
      `,
      [entryIds]
    );
    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.stitching_data_id]) sizesMap[s.stitching_data_id] = [];
      sizesMap[s.stitching_data_id].push(s);
    });
    const resultData = rows.map(r => ({ ...r, sizes: sizesMap[r.id] || [] }));
    const [[{ totalCount }]] = await pool.query(
      `
      SELECT COUNT(*) AS totalCount
      FROM stitching_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      `,
      [userId, searchLike, searchLike]
    );
    const hasMore = offset + rows.length < totalCount;
    return res.json({ data: resultData, hasMore });
  } catch (err) {
    console.error('[ERROR] GET /list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /stitchingdashboard/get-lot-sizes/:lotId
router.get('/get-lot-sizes/:lotId', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;
    const [[lot]] = await pool.query(`SELECT * FROM cutting_lots WHERE id = ?`, [lotId]);
    if (!lot) {
      return res.status(404).json({ error: 'Lot not found' });
    }
    const [lotSizes] = await pool.query(
      `
      SELECT *
      FROM cutting_lot_sizes
      WHERE cutting_lot_id = ?
      ORDER BY id ASC
      `,
      [lotId]
    );
    const output = [];
    for (const s of lotSizes) {
      const [[usedRow]] = await pool.query(
        `
        SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
        FROM stitching_data_sizes sds
        JOIN stitching_data sd ON sds.stitching_data_id = sd.id
        WHERE sd.lot_no = ?
          AND sds.size_label = ?
        `,
        [lot.lot_no, s.size_label]
      );
      const used = usedRow.usedCount || 0;
      const remain = s.total_pieces - used;
      output.push({
        id: s.id,
        size_label: s.size_label,
        total_pieces: s.total_pieces,
        used,
        remain: remain < 0 ? 0 : remain
      });
    }
    return res.json(output);
  } catch (err) {
    console.error('[ERROR] GET /get-lot-sizes =>', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /stitchingdashboard/create
router.post('/create', isAuthenticated, isStitchingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { selectedLotId, remark } = req.body;
    console.log('[DEBUG] Creating stitching entry for lotId =>', selectedLotId);
    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }
    const sizesObj = req.body.sizes || {};
    console.log('[DEBUG] sizesObj =>', sizesObj);
    if (!Object.keys(sizesObj).length) {
      req.flash('error', 'No size data provided.');
      return res.redirect('/stitchingdashboard');
    }
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[lot]] = await conn.query(`SELECT * FROM cutting_lots WHERE id = ?`, [selectedLotId]);
    if (!lot) {
      req.flash('error', 'Invalid or no lot selected.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }
    const [[assignRow]] = await conn.query(`
      SELECT id
      FROM stitching_assignments
      WHERE user_id = ?
        AND cutting_lot_id = ?
        AND isApproved = 1
      LIMIT 1
    `, [userId, selectedLotId]);
    if (!assignRow) {
      req.flash('error', 'Lot is not approved or not assigned to you.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }
    const [[alreadyUsed]] = await conn.query(`
      SELECT id
      FROM stitching_data
      WHERE lot_no = ?
    `, [lot.lot_no]);
    if (alreadyUsed) {
      req.flash('error', `Lot no. ${lot.lot_no} is already used for stitching.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }
    let grandTotal = 0;
    for (const sizeId of Object.keys(sizesObj)) {
      const userCount = parseInt(sizesObj[sizeId], 10);
      if (isNaN(userCount) || userCount < 0) {
        req.flash('error', `Invalid piece count for sizeId ${sizeId}.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/stitchingdashboard');
      }
      if (userCount === 0) continue;
      const [[cls]] = await conn.query(`SELECT * FROM cutting_lot_sizes WHERE id = ?`, [sizeId]);
      if (!cls) {
        req.flash('error', 'Invalid size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/stitchingdashboard');
      }
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
        FROM stitching_data_sizes sds
        JOIN stitching_data sd ON sds.stitching_data_id = sd.id
        WHERE sd.lot_no = ?
          AND sds.size_label = ?
      `, [lot.lot_no, cls.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = cls.total_pieces - used;
      if (userCount > remain) {
        req.flash('error', `Cannot create: requested ${userCount} for size [${cls.size_label}] but only ${remain} remain.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/stitchingdashboard');
      }
      grandTotal += userCount;
    }
    if (grandTotal <= 0) {
      req.flash('error', 'No pieces requested.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }
    const [main] = await conn.query(`
      INSERT INTO stitching_data
        (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, lot.lot_no, lot.sku, grandTotal, remark || null, image_url]);
    const newId = main.insertId;
    console.log('[DEBUG] Created new stitching_data ID =>', newId);
    for (const sizeId of Object.keys(sizesObj)) {
      const countVal = parseInt(sizesObj[sizeId], 10) || 0;
      if (countVal <= 0) continue;
      const [[cls]] = await conn.query(`SELECT * FROM cutting_lot_sizes WHERE id = ?`, [sizeId]);
      await conn.query(`
        INSERT INTO stitching_data_sizes
          (stitching_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [newId, cls.size_label, countVal]);
    }
    await conn.commit();
    conn.release();
    req.flash('success', 'Stitching entry created successfully!');
    return res.redirect('/stitchingdashboard');
  } catch (err) {
    console.error('[ERROR] POST /create =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error creating data: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

// GET /stitchingdashboard/update/:id/json
router.get('/update/:id/json', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const [[entry]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      return res.status(403).json({ error: 'No permission or not found' });
    }
    const [sizes] = await pool.query(`
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
      ORDER BY id ASC
    `, [entryId]);
    const output = [];
    for (const sz of sizes) {
      const [[cls]] = await pool.query(`
        SELECT *
        FROM cutting_lot_sizes
        WHERE cutting_lot_id = (
          SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
        )
          AND size_label = ?
      `, [entry.lot_no, sz.size_label]);
      if (!cls) {
        output.push({ ...sz, remain: 99999 });
        continue;
      }
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
        FROM stitching_data_sizes sds
        JOIN stitching_data sd ON sds.stitching_data_id = sd.id
        WHERE sd.lot_no = ? AND sds.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;
      const remainNow = cls.total_pieces - used;
      output.push({ ...sz, remain: remainNow < 0 ? 0 : remainNow });
    }
    return res.json({ sizes: output });
  } catch (err) {
    console.error('[ERROR] GET /update/:id/json =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/update/:id
router.post('/update/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const updateSizes = req.body.updateSizes || {};
    console.log('[DEBUG] Updating stitching_data ID:', entryId, ' with updateSizes:', updateSizes);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[entry]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Record not found or no permission');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }
    let updatedGrandTotal = entry.total_pieces;
    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;
      const [[existingRow]] = await pool.query(`
        SELECT *
        FROM stitching_data_sizes
        WHERE stitching_data_id = ? AND size_label = ?
      `, [entryId, lbl]);
      if (!existingRow) {
        const [[cls]] = await pool.query(`
          SELECT *
          FROM cutting_lot_sizes
          WHERE cutting_lot_id = (
            SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
          ) AND size_label = ?
        `, [entry.lot_no, lbl]);
        if (!cls) {
          throw new Error(`Size label ${lbl} not found in cutting_lot_sizes`);
        }
        const [[usedRow]] = await pool.query(`
          SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
          FROM stitching_data_sizes sds
          JOIN stitching_data sd ON sds.stitching_data_id = sd.id
          WHERE sd.lot_no = ? AND sds.size_label = ?
        `, [entry.lot_no, lbl]);
        const used = usedRow.usedCount || 0;
        const remain = cls.total_pieces - used;
        if (increment > remain) {
          throw new Error(`Cannot add ${increment} to size [${lbl}]. Max remain is ${remain}.`);
        }
        await conn.query(`
          INSERT INTO stitching_data_sizes (stitching_data_id, size_label, pieces)
          VALUES (?, ?, ?)
        `, [entryId, lbl, increment]);
        updatedGrandTotal += increment;
      } else {
        const [[cls]] = await pool.query(`
          SELECT *
          FROM cutting_lot_sizes
          WHERE cutting_lot_id = (
            SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
          ) AND size_label = ?
        `, [entry.lot_no, lbl]);
        if (!cls) {
          throw new Error(`Size label ${lbl} not found in cutting_lot_sizes.`);
        }
        const [[usedRow]] = await pool.query(`
          SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
          FROM stitching_data_sizes sds
          JOIN stitching_data sd ON sds.stitching_data_id = sd.id
          WHERE sd.lot_no = ? AND sds.size_label = ?
        `, [entry.lot_no, lbl]);
        const used = usedRow.usedCount || 0;
        const remainGlobal = cls.total_pieces - used;
        if (increment > remainGlobal) {
          throw new Error(`Cannot add ${increment} to size [${lbl}]. Max remain is ${remainGlobal}.`);
        }
        const newPieceCount = existingRow.pieces + increment;
        await conn.query(`
          UPDATE stitching_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newPieceCount, existingRow.id]);
        updatedGrandTotal += increment;
      }
      await conn.query(`
        INSERT INTO stitching_data_updates (stitching_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
    }
    await conn.query(`
      UPDATE stitching_data
      SET total_pieces = ?
      WHERE id = ?
    `, [updatedGrandTotal, entryId]);
    await conn.commit();
    conn.release();
    req.flash('success', 'Stitching data updated successfully!');
    return res.redirect('/stitchingdashboard');
  } catch (err) {
    console.error('[ERROR] POST /update/:id =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Could not update data: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

// GET /stitchingdashboard/challan/:id
router.get('/challan/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const [[row]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/stitchingdashboard');
    }
    const [sizes] = await pool.query(`
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
      ORDER BY id ASC
    `, [entryId]);
    const [updates] = await pool.query(`
      SELECT *
      FROM stitching_data_updates
      WHERE stitching_data_id = ?
      ORDER BY updated_at ASC
    `, [entryId]);
    return res.render('challan', { user: req.session.user, entry: row, sizes, updates });
  } catch (err) {
    console.error('[ERROR] GET /challan/:id =>', err);
    req.flash('error', 'Error loading challan: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

// GET /stitchingdashboard/download-all
router.get('/download-all', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [mainRows] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE user_id = ?
      ORDER BY created_at ASC
    `, [userId]);
    const [allSizes] = await pool.query(`
      SELECT s.*
      FROM stitching_data_sizes s
      JOIN stitching_data d ON s.stitching_data_id = d.id
      WHERE d.user_id = ?
      ORDER BY s.stitching_data_id, s.id
    `, [userId]);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();
    const mainSheet = workbook.addWorksheet('MainData');
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
    const sizesSheet = workbook.addWorksheet('Sizes');
    sizesSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Stitching ID', key: 'stitching_data_id', width: 12 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Pieces', key: 'pieces', width: 8 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        stitching_data_id: s.stitching_data_id,
        size_label: s.size_label,
        pieces: s.pieces
      });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="StitchingData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /download-all =>', err);
    req.flash('error', 'Could not download Excel: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

/*------------------------------------------------------------------
  3) ASSIGN TO FINISHING (Partial-Size Assignment)
------------------------------------------------------------------*/

// GET /stitchingdashboard/assign-finishing
router.get('/assign-finishing', isAuthenticated, isStitchingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('StitchingAssignFinishing', { user: req.session.user, error, success });
});

// GET /stitchingdashboard/assign-finishing/users
router.get('/assign-finishing/users', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'finishing'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /assign-finishing/users =>', err);
    return res.status(500).json({ error: 'Server error fetching finishing users.' });
  }
});

// GET /stitchingdashboard/assign-finishing/data
router.get('/assign-finishing/data', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    console.log('[DEBUG] GET /assign-finishing/data for userId =>', userId);

    // 1) Get approved stitching assignments for this user
    const [assignments] = await pool.query(`
      SELECT sa.id AS stitching_assignment_id,
             c.lot_no,
             c.sku
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
        AND sa.isApproved = 1
    `, [userId]);
    console.log('[DEBUG] Found assignments =>', assignments.length);
    if (!assignments.length) return res.json({ data: [] });

    const dataMap = {};
    const lotNos = [];
    for (let asg of assignments) {
      dataMap[asg.stitching_assignment_id] = {
        stitching_assignment_id: asg.stitching_assignment_id,
        lot_no: asg.lot_no,
        sku: asg.sku,
        sizes: []
      };
      lotNos.push(asg.lot_no);
    }
    const uniqueLotNos = [...new Set(lotNos)];
    if (!uniqueLotNos.length) return res.json({ data: [] });

    // 2) Get stitching_data for these lot numbers
    const [stDataRows] = await pool.query(`
      SELECT sd.id, sd.lot_no
      FROM stitching_data sd
      WHERE sd.user_id = ?
        AND sd.lot_no IN (?)
    `, [userId, uniqueLotNos]);
    console.log('[DEBUG] stDataRows =>', stDataRows.length);
    if (!stDataRows.length) return res.json({ data: [] });
    const stDataIds = stDataRows.map(x => x.id);

    // 3) Get stitching_data_sizes
    const [stDataSizes] = await pool.query(`
      SELECT sds.id, sds.stitching_data_id, sds.size_label, sds.pieces
      FROM stitching_data_sizes sds
      WHERE sds.stitching_data_id IN (?)
    `, [stDataIds]);
    console.log('[DEBUG] stDataSizes =>', stDataSizes.length);

    // 4) Get finishing_assignments (to subtract already assigned sizes)
    const [finRows] = await pool.query(`
      SELECT fa.stitching_assignment_id, fa.sizes_json
      FROM finishing_assignments fa
      WHERE fa.stitching_master_id = ?
    `, [userId]);
    console.log('[DEBUG] finishing_assignments =>', finRows.length);

    const finishingAssignedMap = {}; // stitching_assignment_id => Set of assigned sizes
    finRows.forEach(r => {
      const sAsgId = r.stitching_assignment_id;
      if (!finishingAssignedMap[sAsgId]) finishingAssignedMap[sAsgId] = new Set();
      if (r.sizes_json) {
        try {
          const arr = JSON.parse(r.sizes_json);
          if (!Array.isArray(arr)) {
            console.warn('[WARN] Skipping non-array sizes_json:', r.sizes_json);
            return;
          }
          arr.forEach(lbl => finishingAssignedMap[sAsgId].add(lbl));
        } catch (e) {
          console.error('[ERROR] Parsing sizes_json:', e);
        }
      }
    });

    // 5) For each assignment, gather leftover sizes from stitching_data_sizes
    for (let asg of assignments) {
      const sAsgId = asg.stitching_assignment_id;
      const assignedSet = finishingAssignedMap[sAsgId] || new Set();
      const relevantSD = stDataRows.filter(x => x.lot_no === asg.lot_no);
      for (let sdRow of relevantSD) {
        const relevantSizes = stDataSizes.filter(sz => sz.stitching_data_id === sdRow.id);
        relevantSizes.forEach(sz => {
          if (!assignedSet.has(sz.size_label)) {
            dataMap[sAsgId].sizes.push({
              size_label: sz.size_label,
              pieces: sz.pieces
            });
          }
        });
      }
    }
    const output = Object.values(dataMap).filter(o => o.sizes.length > 0);
    console.log('[DEBUG] Final finishing data =>', output.length, 'assignments with leftover sizes');
    return res.json({ data: output });
  } catch (err) {
    console.error('[ERROR] GET /assign-finishing/data =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/assign-finishing
router.post('/assign-finishing', isAuthenticated, isStitchingMaster, async (req, res) => {
  console.log('[DEBUG] Entered POST /assign-finishing');
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const stitchingMasterId = req.session.user.id;
    const { finishingAssignments, target_day } = req.body;
    console.log('[DEBUG] finishingAssignments (raw) =>', finishingAssignments);
    console.log('[DEBUG] target_day =>', target_day);

    if (!finishingAssignments) {
      req.flash('error', 'No finishing assignments data provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-finishing');
    }

    let parsed;
    try {
      parsed = JSON.parse(finishingAssignments);
      console.log('[DEBUG] parsed finishingAssignments =>', parsed);
    } catch (e) {
      console.error('[ERROR] JSON parse error on finishingAssignments:', e);
      req.flash('error', 'Invalid finishing assignments data (JSON parse error).');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-finishing');
    }

    const finishingUserIds = Object.keys(parsed);
    if (!finishingUserIds.length) {
      req.flash('error', 'No finishing user selected for any size.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-finishing');
    }

    // Expected structure: { finishingUserId: [ { stitching_assignment_id, size_label }, ... ] }
    for (const finUserId of finishingUserIds) {
      const arr = parsed[finUserId];
      console.log(`[DEBUG] For finishing user ${finUserId}, data:`, arr);
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Group items by stitching_assignment_id
      const mapByAsgId = {};
      arr.forEach(item => {
        const sAsgId = item.stitching_assignment_id;
        const sizeLabel = item.size_label;
        if (!mapByAsgId[sAsgId]) mapByAsgId[sAsgId] = [];
        mapByAsgId[sAsgId].push(sizeLabel);
      });

      for (const sAsgId of Object.keys(mapByAsgId)) {
        const sizeLabels = mapByAsgId[sAsgId];
        if (!sizeLabels.length) continue;
        console.log('[DEBUG] Creating finishing assignment for stitching_assignment_id:', sAsgId, 'with sizes:', sizeLabels);

        // Confirm the stitching_assignment belongs to this user and is approved
        const [[checkRow]] = await pool.query(`
          SELECT id
          FROM stitching_assignments
          WHERE id = ? AND user_id = ? AND isApproved = 1
          LIMIT 1
        `, [sAsgId, stitchingMasterId]);
        if (!checkRow) {
          throw new Error(`No valid or approved stitching_assignment_id=${sAsgId} for user ${stitchingMasterId}`);
        }

        const sizesJson = JSON.stringify(sizeLabels);
        const [insResult] = await pool.query(`
          INSERT INTO finishing_assignments
            (stitching_master_id, user_id, stitching_assignment_id, target_day, assigned_on, sizes_json, is_approved)
          VALUES (?, ?, ?, ?, NOW(), ?, NULL)
        `, [stitchingMasterId, finUserId, sAsgId, target_day || null, sizesJson]);
        console.log('[DEBUG] Inserted finishing_assignments.id =>', insResult.insertId);
      }
    }

    await conn.commit();
    conn.release();
    console.log('[DEBUG] Successfully assigned to finishing');
    req.flash('success', 'Successfully assigned partial sizes to finishing!');
    return res.redirect('/stitchingdashboard/assign-finishing');
  } catch (err) {
    console.error('[ERROR] POST /assign-finishing =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error assigning finishing: ' + err.message);
    return res.redirect('/stitchingdashboard/assign-finishing');
  }
});

/*------------------------------------------------------------------
  4) ASSIGN TO washing (Partial-Size Assignment)
------------------------------------------------------------------*/

// GET /stitchingdashboard/assign-washing
router.get('/assign-washing', isAuthenticated, isStitchingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('stitchingAssignwashing', { user: req.session.user, error, success });
});

// GET /stitchingdashboard/assign-washing/users
router.get('/assign-washing/users', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'washing'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /assign-washing/users =>', err);
    return res.status(500).json({ error: 'Server error fetching washing users.' });
  }
});

// GET /stitchingdashboard/assign-washing/data
router.get('/assign-washing/data', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    console.log('[DEBUG] GET /assign-washing/data for userId =>', userId);

    // 1) Get approved stitching assignments for this user
    const [assignments] = await pool.query(`
      SELECT sa.id AS stitching_assignment_id,
             c.lot_no,
             c.sku
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
        AND sa.isApproved = 1
    `, [userId]);
    console.log('[DEBUG] Found assignments =>', assignments.length);
    if (!assignments.length) return res.json({ data: [] });

    const dataMap = {};
    const lotNos = [];
    for (let asg of assignments) {
      dataMap[asg.stitching_assignment_id] = {
        stitching_assignment_id: asg.stitching_assignment_id,
        lot_no: asg.lot_no,
        sku: asg.sku,
        sizes: []
      };
      lotNos.push(asg.lot_no);
    }
    const uniqueLotNos = [...new Set(lotNos)];
    if (!uniqueLotNos.length) return res.json({ data: [] });

    // 2) Get stitching_data for these lot numbers
    const [stDataRows] = await pool.query(`
      SELECT sd.id, sd.lot_no
      FROM stitching_data sd
      WHERE sd.user_id = ?
        AND sd.lot_no IN (?)
    `, [userId, uniqueLotNos]);
    console.log('[DEBUG] stDataRows =>', stDataRows.length);
    if (!stDataRows.length) return res.json({ data: [] });
    const stDataIds = stDataRows.map(x => x.id);

    // 3) Get stitching_data_sizes
    const [stDataSizes] = await pool.query(`
      SELECT sds.id, sds.stitching_data_id, sds.size_label, sds.pieces
      FROM stitching_data_sizes sds
      WHERE sds.stitching_data_id IN (?)
    `, [stDataIds]);
    console.log('[DEBUG] stDataSizes =>', stDataSizes.length);

    // 4) Get washing_assignments (to subtract already assigned sizes)
    const [finRows] = await pool.query(`
      SELECT fa.stitching_assignment_id, fa.sizes_json
      FROM washing_assignments fa
      WHERE fa.stitching_master_id = ?
    `, [userId]);
    console.log('[DEBUG] washing_assignments =>', finRows.length);

    const washingAssignedMap = {}; // stitching_assignment_id => Set of assigned sizes
    finRows.forEach(r => {
      const sAsgId = r.stitching_assignment_id;
      if (!washingAssignedMap[sAsgId]) washingAssignedMap[sAsgId] = new Set();
      if (r.sizes_json) {
        try {
          const arr = JSON.parse(r.sizes_json);
          if (!Array.isArray(arr)) {
            console.warn('[WARN] Skipping non-array sizes_json:', r.sizes_json);
            return;
          }
          arr.forEach(lbl => washingAssignedMap[sAsgId].add(lbl));
        } catch (e) {
          console.error('[ERROR] Parsing sizes_json:', e);
        }
      }
    });

    // 5) For each assignment, gather leftover sizes from stitching_data_sizes
    for (let asg of assignments) {
      const sAsgId = asg.stitching_assignment_id;
      const assignedSet = washingAssignedMap[sAsgId] || new Set();
      const relevantSD = stDataRows.filter(x => x.lot_no === asg.lot_no);
      for (let sdRow of relevantSD) {
        const relevantSizes = stDataSizes.filter(sz => sz.stitching_data_id === sdRow.id);
        relevantSizes.forEach(sz => {
          if (!assignedSet.has(sz.size_label)) {
            dataMap[sAsgId].sizes.push({
              size_label: sz.size_label,
              pieces: sz.pieces
            });
          }
        });
      }
    }
    const output = Object.values(dataMap).filter(o => o.sizes.length > 0);
    console.log('[DEBUG] Final washing data =>', output.length, 'assignments with leftover sizes');
    return res.json({ data: output });
  } catch (err) {
    console.error('[ERROR] GET /assign-washing/data =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/assign-washing
router.post('/assign-washing', isAuthenticated, isStitchingMaster, async (req, res) => {
  console.log('[DEBUG] Entered POST /assign-washing');
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const stitchingMasterId = req.session.user.id;
    const { washingAssignments, target_day } = req.body;
    console.log('[DEBUG] washingAssignments (raw) =>', washingAssignments);
    console.log('[DEBUG] target_day =>', target_day);

    if (!washingAssignments) {
      req.flash('error', 'No washing assignments data provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-washing');
    }

    let parsed;
    try {
      parsed = JSON.parse(washingAssignments);
      console.log('[DEBUG] parsed washingAssignments =>', parsed);
    } catch (e) {
      console.error('[ERROR] JSON parse error on washingAssignments:', e);
      req.flash('error', 'Invalid washing assignments data (JSON parse error).');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-washing');
    }

    const washingUserIds = Object.keys(parsed);
    if (!washingUserIds.length) {
      req.flash('error', 'No washing user selected for any size.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-washing');
    }

    // Expected structure: { washingUserId: [ { stitching_assignment_id, size_label }, ... ] }
    for (const finUserId of washingUserIds) {
      const arr = parsed[finUserId];
      console.log(`[DEBUG] For washing user ${finUserId}, data:`, arr);
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Group items by stitching_assignment_id
      const mapByAsgId = {};
      arr.forEach(item => {
        const sAsgId = item.stitching_assignment_id;
        const sizeLabel = item.size_label;
        if (!mapByAsgId[sAsgId]) mapByAsgId[sAsgId] = [];
        mapByAsgId[sAsgId].push(sizeLabel);
      });

      for (const sAsgId of Object.keys(mapByAsgId)) {
        const sizeLabels = mapByAsgId[sAsgId];
        if (!sizeLabels.length) continue;
        console.log('[DEBUG] Creating washing assignment for stitching_assignment_id:', sAsgId, 'with sizes:', sizeLabels);

        // Confirm the stitching_assignment belongs to this user and is approved
        const [[checkRow]] = await pool.query(`
          SELECT id
          FROM stitching_assignments
          WHERE id = ? AND user_id = ? AND isApproved = 1
          LIMIT 1
        `, [sAsgId, stitchingMasterId]);
        if (!checkRow) {
          throw new Error(`No valid or approved stitching_assignment_id=${sAsgId} for user ${stitchingMasterId}`);
        }

        const sizesJson = JSON.stringify(sizeLabels);
        const [insResult] = await pool.query(`
          INSERT INTO washing_assignments
            (stitching_master_id, user_id, stitching_assignment_id, target_day, assigned_on, sizes_json, is_approved)
          VALUES (?, ?, ?, ?, NOW(), ?, NULL)
        `, [stitchingMasterId, finUserId, sAsgId, target_day || null, sizesJson]);
        console.log('[DEBUG] Inserted washing_assignments.id =>', insResult.insertId);
      }
    }

    await conn.commit();
    conn.release();
    console.log('[DEBUG] Successfully assigned to washing');
    req.flash('success', 'Successfully assigned partial sizes to washing!');
    return res.redirect('/stitchingdashboard/assign-washing');
  } catch (err) {
    console.error('[ERROR] POST /assign-washing =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error assigning washing: ' + err.message);
    return res.redirect('/stitchingdashboard/assign-washing');
  }
});

module.exports = router;

