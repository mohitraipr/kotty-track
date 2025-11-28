const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isStitchingMaster } = require('../middlewares/auth');

// ----------------------------
// MULTER SETUP (for image uploads)
// ----------------------------
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

// ==================================================================
//               1) APPROVE STITCHING ASSIGNMENTS
// ==================================================================

// GET /stitchingdashboard/approve
router.get('/approve', isAuthenticated, isStitchingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('stitchingApprove', {
    user: req.session.user,
    error,
    success
  });
});

// GET /stitchingdashboard/approve/list
router.get('/approve/list', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = req.query.search || '';
    const searchLike = `%${search}%`;

    const [rows] = await pool.query(`
      SELECT sa.id AS assignment_id,
             sa.cutting_lot_id,
             sa.assigned_on,
             sa.isApproved,
             sa.assignment_remark,
             c.lot_no,
             c.total_pieces,
             c.remark AS cutting_remark,
             c.sku
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
        AND sa.isApproved IS NULL
        AND (c.lot_no LIKE ? OR c.sku LIKE ?)
      ORDER BY sa.assigned_on DESC
    `, [userId, searchLike, searchLike]);

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

    await pool.query(`
      UPDATE stitching_assignments
      SET isApproved = 1,approved_on = NOW(), assignment_remark = NULL
      WHERE id = ? AND user_id = ?
    `, [assignment_id, userId]);

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

    await pool.query(`
      UPDATE stitching_assignments
      SET isApproved = 0,approved_on = NOW(), assignment_remark = ?
      WHERE id = ? AND user_id = ?
    `, [denial_remark.trim(), assignment_id, userId]);

    req.flash('success', 'Assignment denied successfully.');
    return res.redirect('/stitchingdashboard/approve');
  } catch (error) {
    console.error('[ERROR] POST /deny-lot =>', error);
    req.flash('error', 'Error denying assignment: ' + error.message);
    return res.redirect('/stitchingdashboard/approve');
  }
});

// ==================================================================
//   2) MAIN STITCHING DASHBOARD (Create, List, Update, Challan, Download)
// ==================================================================

// GET /stitchingdashboard
router.get('/', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Show only approved, not-yet-used cutting lots for creation:
    const [lots] = await pool.query(`
      SELECT c.id, c.lot_no, c.sku, c.total_pieces, c.remark AS cutting_remark
      FROM cutting_lots c
      JOIN stitching_assignments sa ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
        AND sa.isApproved = 1
        AND c.lot_no NOT IN (SELECT lot_no FROM stitching_data)
      ORDER BY c.created_at DESC
    `, [userId]);

    const error = req.flash('error');
    const success = req.flash('success');

    return res.render('stitchingDashboard', {
      user: req.session.user,
      lots,
      error,
      success
    });
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

    // Fixed: Replace SELECT * with specific columns
    const [rows] = await pool.query(`
      SELECT id, user_id, lot_no, sku, total_pieces, image_path, created_at
      FROM stitching_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, searchLike, searchLike, limit, offset]);

    if (!rows.length) {
      return res.json({ data: [], hasMore: false });
    }

    const entryIds = rows.map(r => r.id);
    // Fixed: Replace SELECT * with specific columns
    const [sizeRows] = await pool.query(`
      SELECT id, stitching_data_id, size_label, pieces
      FROM stitching_data_sizes
      WHERE stitching_data_id IN (?)
    `, [entryIds]);

    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.stitching_data_id]) sizesMap[s.stitching_data_id] = [];
      sizesMap[s.stitching_data_id].push(s);
    });

    const resultData = rows.map(r => ({
      ...r,
      sizes: sizesMap[r.id] || []
    }));

    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM stitching_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
    `, [userId, searchLike, searchLike]);

    const hasMore = offset + rows.length < totalCount;

    return res.json({
      data: resultData,
      hasMore
    });
  } catch (err) {
    console.error('[ERROR] GET /list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /stitchingdashboard/get-lot-sizes/:lotId
router.get('/get-lot-sizes/:lotId', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;
    // Fixed: Replace SELECT * with specific columns
    const [[lot]] = await pool.query(`SELECT id, lot_no FROM cutting_lots WHERE id = ?`, [lotId]);
    if (!lot) {
      return res.status(404).json({ error: 'Lot not found' });
    }
    const [lotSizes] = await pool.query(`
      SELECT id, size_label, total_pieces
      FROM cutting_lot_sizes
      WHERE cutting_lot_id = ?
      ORDER BY id ASC
    `, [lotId]);

    const [usageRows] = await pool.query(`
      SELECT sds.size_label, SUM(sds.pieces) AS usedCount
      FROM stitching_data_sizes sds
      JOIN stitching_data sd ON sds.stitching_data_id = sd.id
      WHERE sd.lot_no = ?
      GROUP BY sds.size_label
    `, [lot.lot_no]);
    const usedMap = {};
    usageRows.forEach(u => {
      usedMap[u.size_label] = u.usedCount || 0;
    });

    const output = lotSizes.map(s => {
      const used = usedMap[s.size_label] || 0;
      const remain = s.total_pieces - used;
      return {
        id: s.id,
        size_label: s.size_label,
        total_pieces: s.total_pieces,
        used,
        remain: remain < 0 ? 0 : remain
      };
    });
    return res.json(output);
  } catch (err) {
    console.error('[ERROR] GET /get-lot-sizes =>', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// NEW: get assignable users based on whether current user is "hoisery" or not
router.get('/create/assignable-users', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const username = req.session.user.username || '';
    let roleFilter = 'jeans_assembly'; // default to jeans assignment

    if (username.toLowerCase().includes('hoisery')) {
      roleFilter = 'finishing';
    }

    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = ?
        AND u.is_active = 1
      ORDER BY u.username ASC
    `, [roleFilter]);

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /create/assignable-users =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/create
router.post('/create', isAuthenticated, isStitchingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { selectedLotId, remark } = req.body;

    // Determine finishing vs. jeans flow
    const username = req.session.user.username.toLowerCase();
    const isFinishingFlow = username.includes('hoisery');

    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    const sizesObj = req.body.sizes || {}; // e.g. sizes[sizeId] = pieces
    const assignmentsObj = req.body.assignments || {}; // e.g. assignments[sizeId] = userId

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validate the cutting lot
    const [[lot]] = await conn.query(`SELECT * FROM cutting_lots WHERE id = ?`, [selectedLotId]);
    if (!lot) {
      req.flash('error', 'Invalid or no lot selected.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }

    // Ensure lot is assigned & approved for current user
    const [[assignRow]] = await conn.query(`
      SELECT id
      FROM stitching_assignments
      WHERE user_id = ?
        AND cutting_lot_id = ?
        AND isApproved = 1
      LIMIT 1
    `, [userId, selectedLotId]);
    if (!assignRow) {
      req.flash('error', 'Lot not approved or not assigned to you.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }

    // Ensure not already used
    const [[alreadyUsed]] = await conn.query(`
      SELECT id
      FROM stitching_data
      WHERE lot_no = ?
      LIMIT 1
    `, [lot.lot_no]);
    if (alreadyUsed) {
      req.flash('error', `Lot no. ${lot.lot_no} already used for stitching.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }

    // Validate pieces
    let grandTotal = 0;
    const sizeIds = Object.keys(sizesObj).map(id => parseInt(id, 10)).filter(id => !isNaN(id));

    const [clsRows] = sizeIds.length
      ? await conn.query(`SELECT * FROM cutting_lot_sizes WHERE id IN (?)`, [sizeIds])
      : [ [] ];
    const clsMap = {};
    clsRows.forEach(r => {
      clsMap[r.id] = r;
    });

    const [usageRows] = await conn.query(`
      SELECT sds.size_label, SUM(sds.pieces) AS usedCount
      FROM stitching_data_sizes sds
      JOIN stitching_data sd ON sds.stitching_data_id = sd.id
      WHERE sd.lot_no = ?
      GROUP BY sds.size_label
    `, [lot.lot_no]);
    const usedMap = {};
    usageRows.forEach(u => {
      usedMap[u.size_label] = u.usedCount || 0;
    });

    for (const sizeId of sizeIds) {
      const userCount = parseInt(sizesObj[sizeId], 10);
      if (isNaN(userCount) || userCount < 0) {
        req.flash('error', `Invalid piece count for sizeId ${sizeId}.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/stitchingdashboard');
      }
      if (userCount === 0) continue;

      const cls = clsMap[sizeId];
      if (!cls) {
        req.flash('error', 'Invalid size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/stitchingdashboard');
      }

      const used = usedMap[cls.size_label] || 0;
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

    // 1) Insert into stitching_data
    const [mainResult] = await conn.query(`
      INSERT INTO stitching_data (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, lot.lot_no, lot.sku, grandTotal, remark || null, image_url]);
    const newStitchingId = mainResult.insertId;

    // 2) Insert into stitching_data_sizes (bulk)
    const sizeValues = [];
    for (const sizeId of Object.keys(sizesObj)) {
      const countVal = parseInt(sizesObj[sizeId], 10) || 0;
      if (countVal <= 0) continue;
      const cls = clsMap[sizeId];
      sizeValues.push([newStitchingId, cls.size_label, countVal]);
    }
    if (sizeValues.length) {
      await conn.query(
        `INSERT INTO stitching_data_sizes (stitching_data_id, size_label, pieces) VALUES ?`,
        [sizeValues]
      );
    }

    // 3) Partial assignment (optional)
    //    assignments[sizeId] = userId
    const assignMap = {}; // { userId: [sizeLabel1, sizeLabel2, ...] }
    for (const sizeId of Object.keys(assignmentsObj)) {
      const assignedUser = assignmentsObj[sizeId];
      if (!assignedUser) continue;

      const cls = clsMap[sizeId];
      if (!assignMap[assignedUser]) {
        assignMap[assignedUser] = [];
      }
      assignMap[assignedUser].push(cls.size_label);
    }

    const assignValues = [];
    for (const uId of Object.keys(assignMap)) {
      assignValues.push([userId, uId, newStitchingId, JSON.stringify(assignMap[uId])]);
    }
    if (assignValues.length) {
      const table = isFinishingFlow ? 'finishing_assignments' : 'jeans_assembly_assignments';
      await conn.query(
        `INSERT INTO ${table} (stitching_master_id, user_id, stitching_assignment_id, target_day, assigned_on, sizes_json, is_approved) VALUES ?`,
        [assignValues.map(v => [v[0], v[1], v[2], null, new Date(), v[3], null])]
      );
    }

    await conn.commit();
    conn.release();

    req.flash('success', 'Stitching entry created successfully (with optional assignments)!');
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

    const labels = sizes.map(s => s.size_label);

    const totalMap = {};
    const usedMap = {};
    if (labels.length) {
      const [clsRows] = await pool.query(`
        SELECT cls.size_label, cls.total_pieces
        FROM cutting_lot_sizes cls
        JOIN cutting_lots cl ON cls.cutting_lot_id = cl.id
        WHERE cl.lot_no = ? AND cls.size_label IN (?)
      `, [entry.lot_no, labels]);
      clsRows.forEach(r => { totalMap[r.size_label] = r.total_pieces; });

      const [usedRows] = await pool.query(`
        SELECT sds.size_label, SUM(sds.pieces) AS usedCount
        FROM stitching_data_sizes sds
        JOIN stitching_data sd ON sds.stitching_data_id = sd.id
        WHERE sd.lot_no = ? AND sds.size_label IN (?)
        GROUP BY sds.size_label
      `, [entry.lot_no, labels]);
      usedRows.forEach(r => { usedMap[r.size_label] = r.usedCount || 0; });
    }

    const output = sizes.map(sz => {
      const total = totalMap[sz.size_label] || 0;
      const used = usedMap[sz.size_label] || 0;
      const remainNow = total - used;
      return { ...sz, remain: remainNow < 0 ? 0 : remainNow };
    });

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


    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validate stitching_data record
    const [[entry]] = await conn.query(`
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
    const labels = Object.keys(updateSizes).map(k => k.replace(/^size_/, ''));

    const [existingRows] = labels.length
      ? await conn.query(`SELECT * FROM stitching_data_sizes WHERE stitching_data_id = ? AND size_label IN (?)`, [entryId, labels])
      : [ [] ];
    const existingMap = {};
    existingRows.forEach(r => { existingMap[r.size_label] = r; });

    const [clsRows] = labels.length
      ? await conn.query(`
          SELECT cls.size_label, cls.total_pieces
          FROM cutting_lot_sizes cls
          JOIN cutting_lots cl ON cls.cutting_lot_id = cl.id
          WHERE cl.lot_no = ? AND cls.size_label IN (?)
        `, [entry.lot_no, labels])
      : [ [] ];
    const clsMap = {};
    clsRows.forEach(r => { clsMap[r.size_label] = r; });

    const [usageRows] = await conn.query(`
      SELECT sds.size_label, SUM(sds.pieces) AS usedCount
      FROM stitching_data_sizes sds
      JOIN stitching_data sd ON sds.stitching_data_id = sd.id
      WHERE sd.lot_no = ? AND sds.size_label IN (?)
      GROUP BY sds.size_label
    `, [entry.lot_no, labels]);
    const usedMap = {};
    usageRows.forEach(u => { usedMap[u.size_label] = u.usedCount || 0; });

    for (const lbl of labels) {
      let increment = parseInt(updateSizes[`size_${lbl}`], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;

      const existingRow = existingMap[lbl];
      const cls = clsMap[lbl];
      if (!cls) {
        throw new Error(`Size label ${lbl} not found in cutting_lot_sizes for lot ${entry.lot_no}.`);
      }

      const used = usedMap[lbl] || 0;
      const remainGlobal = cls.total_pieces - used;

      if (increment > remainGlobal) {
        throw new Error(`Cannot add ${increment} to size [${lbl}]. Max remain is ${remainGlobal}.`);
      }

      if (!existingRow) {
        await conn.query(`
          INSERT INTO stitching_data_sizes (stitching_data_id, size_label, pieces)
          VALUES (?, ?, ?)
        `, [entryId, lbl, increment]);
      } else {
        const newPieceCount = existingRow.pieces + increment;
        await conn.query(`
          UPDATE stitching_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newPieceCount, existingRow.id]);
      }

      updatedGrandTotal += increment;
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
// GET /stitchingdashboard/challan/:id
router.get('/challan/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    // 1) Verify the user owns this stitching_data record
    const [[row]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/stitchingdashboard');
    }

    // 2) Get the sizes from stitching_data_sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
      ORDER BY id ASC
    `, [entryId]);

    // 3) Get the update logs (if any)
    const [updates] = await pool.query(`
      SELECT *
      FROM stitching_data_updates
      WHERE stitching_data_id = ?
      ORDER BY updated_at ASC
    `, [entryId]);

    // 4) Fetch finishing assignments for this stitching_data
    //    This will return 0 or more rows if partial sizes were assigned multiple times.
    const [finishingRows] = await pool.query(`
      SELECT fa.*,
             fu.username AS assignedUserName,
             mu.username AS masterUserName
      FROM finishing_assignments fa
      JOIN users fu ON fu.id = fa.user_id
      JOIN users mu ON mu.id = fa.stitching_master_id
      WHERE fa.stitching_assignment_id = ?
    `, [entryId]);

    // 5) Fetch jeans assignments for this stitching_data
    const [jeansRows] = await pool.query(`
      SELECT ja.*,
             ju.username AS assignedUserName,
             mu.username AS masterUserName
      FROM jeans_assembly_assignments ja
      JOIN users ju ON ju.id = ja.user_id
      JOIN users mu ON mu.id = ja.stitching_master_id
      WHERE ja.stitching_assignment_id = ?
    `, [entryId]);

    // 6) Render the challan EJS
    return res.render('challan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates,

      // Pass these to your EJS
      finishingAssignments: finishingRows,
      jeansAssignments: jeansRows
    });
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

// ==================================================================
//   3) OPTIONAL: Keep or remove these if you still want separate assignment screens
// ==================================================================

// GET /stitchingdashboard/assign-finishing
router.get('/assign-finishing', isAuthenticated, isStitchingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('StitchingAssignFinishing', {
    user: req.session.user,
    error,
    success
  });
});

// GET finishing users
router.get('/assign-finishing/users', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'finishing' AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /assign-finishing/users =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /stitchingdashboard/assign-finishing/data
router.get('/assign-finishing/data', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [stDataRows] = await pool.query(`
      SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces, c.remark AS cutting_remark
      FROM stitching_data sd
      JOIN cutting_lots c ON sd.lot_no = c.lot_no
      WHERE sd.user_id = ?
    `, [userId]);

    if (!stDataRows.length) return res.json({ data: [] });

    const dataMap = {};
    stDataRows.forEach(sd => {
      dataMap[sd.id] = {
        stitching_assignment_id: sd.id,
        lot_no: sd.lot_no,
        sku: sd.sku,
        cutting_remark: sd.cutting_remark,
        total_pieces: sd.total_pieces,
        sizes: []
      };
    });

    const stDataIds = stDataRows.map(x => x.id);
    const [stDataSizes] = await pool.query(`
      SELECT sds.id, sds.stitching_data_id, sds.size_label, sds.pieces
      FROM stitching_data_sizes sds
      WHERE sds.stitching_data_id IN (?)
    `, [stDataIds]);

    // Exclude sizes already assigned to finishing
    const [finRows] = await pool.query(`
      SELECT fa.stitching_assignment_id, fa.sizes_json
      FROM finishing_assignments fa
      WHERE fa.stitching_master_id = ?
    `, [userId]);

    const finishingAssignedMap = {};
    finRows.forEach(r => {
      const id = r.stitching_assignment_id;
      if (!finishingAssignedMap[id]) finishingAssignedMap[id] = new Set();
      if (r.sizes_json) {
        try {
          const arr = JSON.parse(r.sizes_json);
          if (Array.isArray(arr)) {
            arr.forEach(lbl => finishingAssignedMap[id].add(lbl));
          }
        } catch {}
      }
    });

    stDataRows.forEach(sd => {
      const assignedSet = finishingAssignedMap[sd.id] || new Set();
      const relevantSizes = stDataSizes.filter(sz => sz.stitching_data_id === sd.id);
      relevantSizes.forEach(sz => {
        if (!assignedSet.has(sz.size_label)) {
          dataMap[sd.id].sizes.push({
            size_label: sz.size_label,
            pieces: sz.pieces
          });
        }
      });
    });

    const output = Object.values(dataMap).filter(o => o.sizes.length > 0);
    return res.json({ data: output });
  } catch (err) {
    console.error('[ERROR] GET /assign-finishing/data =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/assign-finishing
router.post('/assign-finishing', isAuthenticated, isStitchingMaster, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const stitchingMasterId = req.session.user.id;
    const { finishingAssignments, target_day } = req.body;
    if (!finishingAssignments) {
      req.flash('error', 'No finishing assignments data provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-finishing');
    }

    let parsed = {};
    try {
      parsed = JSON.parse(finishingAssignments);
    } catch (e) {
      req.flash('error', 'Invalid finishing assignments data (JSON parse error).');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-finishing');
    }

    const assignValues = [];
    const idSet = new Set();
    for (const finUserId of Object.keys(parsed)) {
      const arr = parsed[finUserId];
      if (!Array.isArray(arr) || arr.length === 0) continue;

      const mapByAsgId = {};
      arr.forEach(item => {
        const id = item.stitching_assignment_id;
        const sizeLabel = item.size_label;
        if (!mapByAsgId[id]) mapByAsgId[id] = [];
        mapByAsgId[id].push(sizeLabel);
        idSet.add(id);
      });

      for (const sAsgId of Object.keys(mapByAsgId)) {
        const sizeLabels = mapByAsgId[sAsgId];
        if (sizeLabels.length) {
          assignValues.push([finUserId, sAsgId, JSON.stringify(sizeLabels)]);
        }
      }
    }

    if (assignValues.length) {
      const ids = Array.from(idSet);
      if (ids.length) {
        const [valid] = await conn.query(
          `SELECT id FROM stitching_data WHERE user_id = ? AND id IN (?)`,
          [stitchingMasterId, ids]
        );
        if (valid.length !== ids.length) {
          throw new Error('Invalid stitching_data id found in assignments');
        }
      }

      const insertRows = assignValues.map(v => [stitchingMasterId, v[0], v[1], target_day || null, new Date(), v[2], null]);
      await conn.query(
        `INSERT INTO finishing_assignments (stitching_master_id, user_id, stitching_assignment_id, target_day, assigned_on, sizes_json, is_approved) VALUES ?`,
        [insertRows]
      );
    }

    await conn.commit();
    conn.release();
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

// GET /stitchingdashboard/assign-jeansassembly
router.get('/assign-jeansassembly', isAuthenticated, isStitchingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('StitchingAssignJeansAssembly', {
    user: req.session.user,
    error,
    success
  });
});

// GET jeans assembly users
router.get('/assign-jeansassembly/users', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'jeans_assembly' AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /assign-jeansassembly/users =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /stitchingdashboard/assign-jeansassembly/data
router.get('/assign-jeansassembly/data', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [stDataRows] = await pool.query(`
      SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces
      FROM stitching_data sd
      WHERE sd.user_id = ?
    `, [userId]);

    if (!stDataRows.length) return res.json({ data: [] });

    const dataMap = {};
    stDataRows.forEach(sd => {
      dataMap[sd.id] = {
        stitching_assignment_id: sd.id,
        lot_no: sd.lot_no,
        sku: sd.sku,
        total_pieces: sd.total_pieces,
        sizes: []
      };
    });
    const stDataIds = stDataRows.map(x => x.id);

    const [stDataSizes] = await pool.query(`
      SELECT sds.id, sds.stitching_data_id, sds.size_label, sds.pieces
      FROM stitching_data_sizes sds
      WHERE sds.stitching_data_id IN (?)
    `, [stDataIds]);

    const [jaAssignRows] = await pool.query(`
      SELECT jaa.stitching_assignment_id, jaa.sizes_json
      FROM jeans_assembly_assignments jaa
      WHERE jaa.stitching_master_id = ?
    `, [userId]);

    const jaAssignedMap = {};
    jaAssignRows.forEach(r => {
      const id = r.stitching_assignment_id;
      if (!jaAssignedMap[id]) jaAssignedMap[id] = new Set();
      if (r.sizes_json) {
        try {
          const arr = JSON.parse(r.sizes_json);
          if (Array.isArray(arr)) {
            arr.forEach(lbl => jaAssignedMap[id].add(lbl));
          }
        } catch {}
      }
    });

    stDataRows.forEach(sd => {
      const assignedSet = jaAssignedMap[sd.id] || new Set();
      const relevantSizes = stDataSizes.filter(sz => sz.stitching_data_id === sd.id);
      relevantSizes.forEach(sz => {
        if (!assignedSet.has(sz.size_label)) {
          dataMap[sd.id].sizes.push({
            size_label: sz.size_label,
            pieces: sz.pieces
          });
        }
      });
    });

    const output = Object.values(dataMap).filter(o => o.sizes.length > 0);
    return res.json({ data: output });
  } catch (err) {
    console.error('[ERROR] GET /assign-jeansassembly/data =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /stitchingdashboard/assign-jeansassembly
router.post('/assign-jeansassembly', isAuthenticated, isStitchingMaster, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const stitchingMasterId = req.session.user.id;
    const { jeansAssemblyAssignments, target_day } = req.body;
    if (!jeansAssemblyAssignments) {
      req.flash('error', 'No jeans assembly assignments data provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-jeansassembly');
    }

    let parsed = {};
    try {
      parsed = JSON.parse(jeansAssemblyAssignments);
    } catch (e) {
      req.flash('error', 'Invalid jeans assembly assignments data (JSON parse error).');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard/assign-jeansassembly');
    }

    const assignValues = [];
    const idSet = new Set();
    for (const jaUserId of Object.keys(parsed)) {
      const arr = parsed[jaUserId];
      if (!Array.isArray(arr) || arr.length === 0) continue;

      const mapByAsgId = {};
      arr.forEach(item => {
        const id = item.stitching_assignment_id;
        const sizeLabel = item.size_label;
        if (!mapByAsgId[id]) mapByAsgId[id] = [];
        mapByAsgId[id].push(sizeLabel);
        idSet.add(id);
      });

      for (const sAsgId of Object.keys(mapByAsgId)) {
        const sizeLabels = mapByAsgId[sAsgId];
        if (sizeLabels.length) {
          assignValues.push([jaUserId, sAsgId, JSON.stringify(sizeLabels)]);
        }
      }
    }

    if (assignValues.length) {
      const ids = Array.from(idSet);
      if (ids.length) {
        const [valid] = await conn.query(
          `SELECT id FROM stitching_data WHERE user_id = ? AND id IN (?)`,
          [stitchingMasterId, ids]
        );
        if (valid.length !== ids.length) {
          throw new Error('Invalid stitching_data id found in assignments');
        }
      }

      const insertRows = assignValues.map(v => [stitchingMasterId, v[0], v[1], target_day || null, new Date(), v[2], null]);
      await conn.query(
        `INSERT INTO jeans_assembly_assignments (stitching_master_id, user_id, stitching_assignment_id, target_day, assigned_on, sizes_json, is_approved) VALUES ?`,
        [insertRows]
      );
    }

    await conn.commit();
    conn.release();
    req.flash('success', 'Successfully assigned partial sizes to jeans assembly!');
    return res.redirect('/stitchingdashboard/assign-jeansassembly');
  } catch (err) {
    console.error('[ERROR] POST /assign-jeansassembly =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error assigning jeans assembly: ' + err.message);
    return res.redirect('/stitchingdashboard/assign-jeansassembly');
  }
});

module.exports = router;
