// routes/washingRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isWashingMaster } = require('../middlewares/auth');

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
const upload = multer({ storage });

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

    // 3) Validate each requested size against its available pieces in jeans_assembly_data_sizes
    for (const sizeId of Object.keys(sizesObj)) {
      const requested = parseInt(sizesObj[sizeId], 10) || 0;
      if (requested === 0) continue;
      const [[sds]] = await conn.query(`SELECT * FROM jeans_assembly_data_sizes WHERE id = ?`, [sizeId]);
      if (!sds) {
        req.flash('error', `Bad size reference: ${sizeId}`);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingdashboard');
      }
      // Calculate how many have been used so far in washing_data_sizes for this lot and size
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(wds.pieces),0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ? AND wds.size_label = ?
      `, [jd.lot_no, sds.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = sds.pieces - used;
      if (requested > remain) {
        req.flash('error', `Requested ${requested} for ${sds.size_label}, but only ${remain} remain.`);
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
      const [[sds]] = await conn.query(`SELECT * FROM jeans_assembly_data_sizes WHERE id = ?`, [sizeId]);
      await conn.query(`
        INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces, created_at)
        VALUES (?, ?, ?, NOW())
      `, [newId, sds.size_label, numVal]);
    }

    // 6) Process partial assignment (optional)
    const assignMap = {}; // { washing_in_user_id: [sizeLabel1, sizeLabel2, ...] }
    for (const sizeId of Object.keys(assignmentsObj)) {
      const assignedUser = assignmentsObj[sizeId];
      if (!assignedUser) continue;
      const [[sds]] = await conn.query(`SELECT * FROM jeans_assembly_data_sizes WHERE id = ?`, [sizeId]);
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

    const [sizes] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data_sizes
      WHERE jeans_assembly_data_id = ?
    `, [lotId]);

    const results = [];
    for (const size of sizes) {
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wds.pieces),0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ?
          AND wds.size_label = ?
      `, [stData.lot_no, size.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = size.pieces - used;
      results.push({
        id: size.id,
        size_label: size.size_label,
        pieces: size.pieces,
        remain: remain < 0 ? 0 : remain
      });
    }
    return res.json(results);
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

    // 2) Fetch each size-row (we need its ID, label & existing pieces)
    const [ sizes ] = await pool.query(`
      SELECT id, size_label, pieces
      FROM washing_data_sizes
      WHERE washing_data_id = ?
    `, [entryId]);

    // 3) For each, compute remaining from jeans_assembly_data_sizes
    const output = [];
    for (const sz of sizes) {
      const [[ latest ]] = await pool.query(`
        SELECT pieces
        FROM jeans_assembly_data_sizes
        WHERE jeans_assembly_data_id = (
          SELECT id FROM jeans_assembly_data
          WHERE lot_no = ?
          LIMIT 1
        )
        AND size_label = ?
        LIMIT 1
      `, [entry.lot_no, sz.size_label]);
      const totalAllowed = latest ? latest.pieces : 0;

      const [[ usedRow ]] = await pool.query(`
        SELECT COALESCE(SUM(wds.pieces),0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ?
          AND wds.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;

      const remain = totalAllowed - used;
      output.push({
        id:          sz.id,
        size_label: sz.size_label,
        pieces:     sz.pieces,
        remain:     remain < 0 ? 0 : remain
      });
    }

    return res.json({ sizes: output });
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

    // 2) Loop by size-row ID
    for (const sizeIdStr of Object.keys(updateSizes)) {
      const sizeId    = parseInt(sizeIdStr, 10);
      let   increment = parseInt(updateSizes[sizeIdStr], 10);
      if (isNaN(increment) || increment <= 0) continue;

      // 3) Fetch the existing size-row
      const [[ existingRow ]] = await conn.query(`
        SELECT * 
        FROM washing_data_sizes
        WHERE id = ? AND washing_data_id = ?
      `, [sizeId, entryId]);
      if (!existingRow) {
        throw new Error(`Invalid size ID ${sizeId} for this entry.`);
      }
      const label = existingRow.size_label;

      // 4) Compute allowed / used by label
      const [[ latest ]] = await conn.query(`
        SELECT pieces
        FROM jeans_assembly_data_sizes
        WHERE jeans_assembly_data_id = (
          SELECT id FROM jeans_assembly_data
          WHERE lot_no = ?
          LIMIT 1
        )
        AND size_label = ?
        LIMIT 1
      `, [entry.lot_no, label]);
      const totalAllowed = latest ? latest.pieces : 0;

      const [[ usedRow ]] = await conn.query(`
        SELECT COALESCE(SUM(wds.pieces),0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ? AND wds.size_label = ?
      `, [entry.lot_no, label]);
      const used   = usedRow.usedCount || 0;
      const remain = totalAllowed - used;

      if (increment > remain) {
        throw new Error(`Cannot add ${increment} to size [${label}]; only ${remain} remain.`);
      }

      // 5) Update the size-row
      const newCount = existingRow.pieces + increment;
      await conn.query(`
        UPDATE washing_data_sizes
        SET pieces = ?
        WHERE id = ?
      `, [newCount, sizeId]);

      // 6) Log the update
      await conn.query(`
        INSERT INTO washing_data_updates
          (washing_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, label, increment]);

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
  2) APPROVAL ROUTES: washing_assignments
-----------------------------------------*/

router.get('/approve', isAuthenticated, isWashingMaster, (req, res) => {
  res.render('washingApprove', { user: req.session.user });
});

// GET /washingdashboard/approve/list
// GET /washingdashboard/approve/list
router.get('/approve/list', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId     = req.session.user.id;
    const searchTerm = req.query.search || '';
    const searchLike = `%${searchTerm}%`;

    const [rows] = await pool.query(`
      SELECT
        wa.id            AS assignment_id,
        wa.sizes_json,
        wa.assigned_on,
        wa.is_approved,
        wa.assignment_remark,

        jd.lot_no,
        jd.sku,
        jd.total_pieces,

        cl.remark       AS cutting_remark
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd
        ON wa.jeans_assembly_assignment_id = jd.id
      LEFT JOIN cutting_lots cl
        ON cl.lot_no = jd.lot_no
      WHERE wa.user_id    = ?
        AND wa.is_approved IS NULL
        AND ( jd.lot_no LIKE ? OR jd.sku LIKE ? )
      ORDER BY wa.assigned_on DESC
    `, [userId, searchLike, searchLike]);

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard/approve/list =>', err);
    return res.status(500).json({ error: 'Could not load assignments: ' + err.message });
  }
});


// POST /washingdashboard/approve-lot
router.post('/approve-lot', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id } = req.body;
    if (!assignment_id) {
      return res.status(400).json({ error: 'No assignment_id provided.' });
    }
    await pool.query(`
      UPDATE washing_assignments
      SET is_approved = 1,approved_on = NOW(), assignment_remark = NULL
      WHERE id = ? AND user_id = ?
    `, [assignment_id, userId]);
    return res.json({ success: true, message: 'Assignment approved successfully!' });
  } catch (error) {
    console.error('[ERROR] POST /washingdashboard/approve-lot =>', error);
    return res.status(500).json({ error: 'Error approving assignment: ' + error.message });
  }
});

// POST /washingdashboard/deny-lot
router.post('/deny-lot', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id, denial_remark } = req.body;
    if (!assignment_id) {
      return res.status(400).json({ error: 'No assignment_id provided.' });
    }
    if (!denial_remark || !denial_remark.trim()) {
      return res.status(400).json({ error: 'You must provide a remark for denial.' });
    }
    await pool.query(`
      UPDATE washing_assignments
      SET is_approved = 0,approved_on = NOW(), assignment_remark = ?
      WHERE id = ? AND user_id = ?
    `, [denial_remark.trim(), assignment_id, userId]);
    return res.json({ success: true, message: 'Assignment denied successfully.' });
  } catch (error) {
    console.error('[ERROR] POST /washingdashboard/deny-lot =>', error);
    return res.status(500).json({ error: 'Error denying assignment: ' + error.message });
  }
});

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
        const [[checkRow]] = await conn.query(`
          SELECT id
          FROM washing_data
          WHERE id = ?
            AND user_id = ?
          LIMIT 1
        `, [wDataId, washingMasterId]);
        if (!checkRow) {
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

module.exports = router;
