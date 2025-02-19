// routes/washingRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isWashingMaster } = require('../middlewares/auth');

// -------------------------------
// MULTER SETUP FOR IMAGE UPLOAD
// -------------------------------
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
  1) DASHBOARD & GENERAL ENDPOINTS
------------------------------------------*/

// GET /washingdashboard
router.get('/', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    // We use jeans_assembly_data to obtain lot/sku details.
    // Note: washing_assignments now references jeans assembly via jeans_assembly_assignment_id.
    const [lots] = await pool.query(`
      SELECT jd.id, jd.lot_no, jd.sku, jd.total_pieces, jd.created_at
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      WHERE wa.user_id = ?
        AND wa.is_approved = 1
        AND jd.lot_no NOT IN (SELECT lot_no FROM washing_data)
      ORDER BY jd.created_at DESC
      LIMIT 10
    `, [userId]);
    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');
    return res.render('washingDashboard', { user: req.session.user, lots, error: errorMessages, success: successMessages });
  } catch (err) {
    console.error('[ERROR] GET /washingdashboard =>', err);
    req.flash('error', 'Cannot load washing dashboard data.');
    return res.redirect('/');
  }
});

// POST /washingdashboard/create - Create a new washing_data entry.
router.post('/create', isAuthenticated, isWashingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    console.log('[DEBUG] Entered POST /create');
    const userId = req.session.user.id;
    const { selectedLotId, remark } = req.body;
    console.log('[DEBUG] selectedLotId:', selectedLotId, 'remark:', remark);
    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
      console.log('[DEBUG] Image uploaded:', image_url);
    }
    const sizesObj = req.body.sizes || {};
    console.log('[DEBUG] Sizes object received:', sizesObj);
    if (!Object.keys(sizesObj).length) {
      req.flash('error', 'No size data provided.');
      return res.redirect('/washingdashboard');
    }
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Get jeans_assembly_data record (for lot/sku details)
    console.log('[DEBUG] Querying jeans_assembly_data for lot id:', selectedLotId);
    const [[jd]] = await conn.query(`SELECT * FROM jeans_assembly_data WHERE id = ?`, [selectedLotId]);
    if (!jd) {
      req.flash('error', 'Invalid lot selection.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }
    console.log('[DEBUG] Jeans Assembly data found:', jd);

    // Check if a washing entry already exists for this lot
    const [[already]] = await conn.query(`SELECT id FROM washing_data WHERE lot_no = ?`, [jd.lot_no]);
    if (already) {
      req.flash('error', `Lot ${jd.lot_no} already used for washing.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }
    let grandTotal = 0;
    for (const sizeId of Object.keys(sizesObj)) {
      const requested = parseInt(sizesObj[sizeId], 10) || 0;
      if (requested < 0) {
        req.flash('error', 'Invalid negative pieces.');
        await conn.rollback();
        conn.release();
        return res.redirect('/washingdashboard');
      }
      if (requested === 0) continue;
      // Use jeans_assembly_data_sizes instead of stitching_data_sizes
      const [[sds]] = await conn.query(`SELECT * FROM jeans_assembly_data_sizes WHERE id = ?`, [sizeId]);
      if (!sds) {
        req.flash('error', 'Bad size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingdashboard');
      }
      // Compute used pieces for this lot and size from washing_data_sizes
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(wds.pieces),0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ? AND wds.size_label = ?
      `, [jd.lot_no, sds.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = sds.pieces - used;
      if (requested > remain) {
        req.flash('error', `Requested ${requested} for ${sds.size_label} but only ${remain} remain.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingdashboard');
      }
      grandTotal += requested;
    }
    if (grandTotal <= 0) {
      req.flash('error', 'No pieces > 0 provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }
    console.log('[DEBUG] Inserting washing_data for lot:', jd.lot_no);
    const [main] = await conn.query(`
      INSERT INTO washing_data
        (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, jd.lot_no, jd.sku, grandTotal, remark || null, image_url]);
    const newId = main.insertId;
    for (const sizeId of Object.keys(sizesObj)) {
      const numVal = parseInt(sizesObj[sizeId], 10) || 0;
      if (numVal <= 0) continue;
      const [[sds]] = await conn.query(`SELECT * FROM jeans_assembly_data_sizes WHERE id = ?`, [sizeId]);
      await conn.query(`
        INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [newId, sds.size_label, numVal]);
    }
    await conn.commit();
    conn.release();
    req.flash('success', 'Washing entry created successfully.');
    return res.redirect('/washingdashboard');
  } catch (err) {
    console.error('[ERROR] POST /create =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error creating washing data: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

/*
  GET /washingdashboard/get-lot-sizes/:lotId
  Returns sizes for the selected lot along with remaining available pieces.
*/
router.get('/get-lot-sizes/:lotId', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;
    const [[stData]] = await pool.query(`SELECT * FROM jeans_assembly_data WHERE id = ?`, [lotId]);
    if (!stData) {
      return res.status(404).json({ error: 'Lot not found' });
    }
    const [sizes] = await pool.query(`SELECT * FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = ?`, [lotId]);
    const results = [];
    for (const size of sizes) {
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wds.pieces), 0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ? AND wds.size_label = ?
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
    console.error('[ERROR] GET /get-lot-sizes/:lotId =>', err);
    return res.status(500).json({ error: 'Error fetching lot sizes: ' + err.message });
  }
});

// GET /washingdashboard/update/:id/json
router.get('/update/:id/json', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const entryId = req.params.id;
    const userId = req.session.user.id;
    const [[entry]] = await pool.query(`
      SELECT *
      FROM washing_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      return res.status(403).json({ error: 'Not found or no permission' });
    }
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id = ?
    `, [entryId]);
    const output = [];
    for (const sz of sizes) {
      const [[latest]] = await pool.query(`
        SELECT pieces FROM jeans_assembly_data_sizes
        WHERE jeans_assembly_data_id = (SELECT id FROM jeans_assembly_data WHERE lot_no = ? LIMIT 1)
          AND size_label = ?
        LIMIT 1
      `, [entry.lot_no, sz.size_label]);
      let totalAllowed = latest ? latest.pieces : 0;
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wds.pieces),0) AS usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ? AND wds.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = totalAllowed - used;
      output.push({ ...sz, remain: remain < 0 ? 0 : remain });
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
    const entryId = req.params.id;
    const userId = req.session.user.id;
    const updateSizes = req.body.updateSizes || {};
    console.log('[DEBUG] Updating washing_data ID:', entryId, 'with updateSizes:', updateSizes);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[entry]] = await pool.query(`
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
    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;
      const [[existingRow]] = await pool.query(`
        SELECT *
        FROM washing_data_sizes
        WHERE washing_data_id = ? AND size_label = ?
      `, [entryId, lbl]);
      if (!existingRow) {
        const [[latest]] = await pool.query(`
          SELECT pieces FROM jeans_assembly_data_sizes
          WHERE jeans_assembly_data_id = (SELECT id FROM jeans_assembly_data WHERE lot_no = ? LIMIT 1)
            AND size_label = ?
          LIMIT 1
        `, [entry.lot_no, lbl]);
        if (!latest) {
          throw new Error(`Size label ${lbl} not found in jeans_assembly_data_sizes`);
        }
        const [[usedRow]] = await pool.query(`
          SELECT COALESCE(SUM(wds.pieces),0) as usedCount
          FROM washing_data_sizes wds
          JOIN washing_data wd ON wds.washing_data_id = wd.id
          WHERE wd.lot_no = ? AND wds.size_label = ?
        `, [entry.lot_no, lbl]);
        const used = usedRow.usedCount || 0;
        const remain = latest.pieces - used;
        if (increment > remain) {
          throw new Error(`Cannot add ${increment} for [${lbl}]; only ${remain} remain.`);
        }
        await conn.query(`
          INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces)
          VALUES (?, ?, ?)
        `, [entryId, lbl, increment]);
        updatedTotal += increment;
      } else {
        const [[latest]] = await pool.query(`
          SELECT pieces FROM jeans_assembly_data_sizes
          WHERE jeans_assembly_data_id = (SELECT id FROM jeans_assembly_data WHERE lot_no = ? LIMIT 1)
            AND size_label = ?
          LIMIT 1
        `, [entry.lot_no, lbl]);
        if (!latest) {
          throw new Error(`Size label ${lbl} not found in jeans_assembly_data_sizes`);
        }
        const [[usedRow]] = await pool.query(`
          SELECT COALESCE(SUM(wds.pieces),0) as usedCount
          FROM washing_data_sizes wds
          JOIN washing_data wd ON wds.washing_data_id = wd.id
          WHERE wd.lot_no = ? AND wds.size_label = ?
        `, [entry.lot_no, lbl]);
        const used = usedRow.usedCount || 0;
        const remain = latest.pieces - used;
        if (increment > remain) {
          throw new Error(`Cannot add ${increment} for [${lbl}]; only ${remain} remain.`);
        }
        const newPieces = existingRow.pieces + increment;
        await conn.query(`
          UPDATE washing_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newPieces, existingRow.id]);
        updatedTotal += increment;
      }
      await conn.query(`
        INSERT INTO washing_data_updates (washing_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
    }
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
      WHERE id = ? AND user_id = ?
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
    return res.render('washingChallan', { user: req.session.user, entry: row, sizes, updates });
  } catch (err) {
    console.error('[ERROR] GET /challan/:id =>', err);
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
      { header: 'Pieces', key: 'pieces', width: 8 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        washing_data_id: s.washing_data_id,
        size_label: s.size_label,
        pieces: s.pieces
      });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="WashingData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /download-all =>', err);
    req.flash('error', 'Could not download washing Excel: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

/*
  GET /washingdashboard/list-entries
  Used by the front-end to load existing washing entries with pagination and search.
*/
router.get('/list-entries', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const limit = 10;
    const [rows] = await pool.query(
      `
      SELECT wd.*,
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('size_label', wds.size_label, 'pieces', wds.pieces))
              FROM washing_data_sizes wds
              WHERE wds.washing_data_id = wd.id) AS sizes
      FROM washing_data wd
      WHERE wd.user_id = ?
        AND (wd.lot_no LIKE ? OR wd.sku LIKE ?)
      ORDER BY wd.created_at DESC
      LIMIT ?, ?
      `,
      [userId, search, search, offset, limit]
    );
    const hasMore = rows.length === limit;
    return res.json({ data: rows, hasMore });
  } catch (err) {
    console.error('[ERROR] GET /list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------
// 2) APPROVAL ROUTES (AJAX-based)
// --------------------------------------------------------------------
router.get('/approve', isAuthenticated, isWashingMaster, (req, res) => {
  res.render('washingApprove', { user: req.session.user });
});

router.get('/approve/list', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    const searchLike = `%${searchTerm}%`;
    // Note: Join now uses jeans_assembly_data with updated column references.
    const [rows] = await pool.query(
      `
      SELECT wa.id AS assignment_id,
             wa.sizes_json,
             wa.assigned_on,
             wa.is_approved,
             wa.assignment_remark,
             jd.lot_no,
             jd.sku
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      WHERE wa.user_id = ?
        AND wa.is_approved IS NULL
        AND (jd.lot_no LIKE ? OR jd.sku LIKE ?)
      ORDER BY wa.assigned_on DESC
      `,
      [userId, searchLike, searchLike]
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /approve/list =>', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/approve-lot', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id } = req.body;
    if (!assignment_id) {
      return res.status(400).json({ error: 'No assignment_id provided.' });
    }
    await pool.query(
      `
      UPDATE washing_assignments
      SET is_approved = 1, assignment_remark = NULL
      WHERE id = ? AND user_id = ?
      `,
      [assignment_id, userId]
    );
    return res.json({ success: true, message: 'Assignment approved successfully!' });
  } catch (error) {
    console.error('[ERROR] POST /approve-lot =>', error);
    return res.status(500).json({ error: 'Error approving assignment: ' + error.message });
  }
});

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
    await pool.query(
      `
      UPDATE washing_assignments
      SET is_approved = 0, assignment_remark = ?
      WHERE id = ? AND user_id = ?
      `,
      [denial_remark.trim(), assignment_id, userId]
    );
    return res.json({ success: true, message: 'Assignment denied successfully.' });
  } catch (error) {
    console.error('[ERROR] POST /deny-lot =>', error);
    return res.status(500).json({ error: 'Error denying assignment: ' + error.message });
  }
});

// --------------------------------------------------------------------
// 3) ASSIGN TO FINISHING (Partial-Size Assignment)
// --------------------------------------------------------------------
router.get('/assign-finishing', isAuthenticated, isWashingMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  return res.render('WashingAssignFinishing', { user: req.session.user, error, success });
});

router.get('/assign-finishing/users', isAuthenticated, isWashingMaster, async (req, res) => {
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

/*
  GET /washingdashboard/assign-finishing/data
  For finishing assignments, we now use washing_data as the source.
  We then exclude sizes that have already been assigned.
  Also, if a washing_data row has some sizes assigned (but not all),
  it is still visible with only the leftover sizes.
*/
router.get('/assign-finishing/data', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    console.log('[DEBUG] GET /assign-finishing/data for userId =>', userId);

    // 1) Get all washing_data rows for this user.
    const [rows] = await pool.query(`
      SELECT id AS washing_assignment_id, lot_no, sku
      FROM washing_data
      WHERE user_id = ?
    `, [userId]);
    console.log('[DEBUG] Found washing_data rows =>', rows.length);
    if (!rows.length) return res.json({ data: [] });

    // 2) Get finishing assignments for this user (for washing).
    const [finRows] = await pool.query(`
      SELECT washing_assignment_id, sizes_json
      FROM finishing_assignments
      WHERE washing_master_id = ?
    `, [userId]);
    const assignedMap = {}; // washing_assignment_id => Set of assigned size labels
    finRows.forEach(r => {
      const id = r.washing_assignment_id;
      if (!assignedMap[id]) assignedMap[id] = new Set();
      if (r.sizes_json) {
        try {
          const parsed = JSON.parse(r.sizes_json);
          if (Array.isArray(parsed)) {
            parsed.forEach(lbl => assignedMap[id].add(lbl));
          }
        } catch (e) {
          console.error('[ERROR] Parsing sizes_json:', e);
        }
      }
    });

    // 3) Get washing_data_sizes for these washing_data rows.
    const washingDataIds = rows.map(x => x.washing_assignment_id);
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id IN (?)
    `, [washingDataIds]);

    // 4) For each washing_data row, subtract assigned sizes.
    const dataMap = {};
    rows.forEach(row => {
      dataMap[row.washing_assignment_id] = {
        washing_assignment_id: row.washing_assignment_id,
        lot_no: row.lot_no,
        sku: row.sku,
        sizes: [] // Only leftover sizes
      };
    });
    sizes.forEach(s => {
      // If this size label is not in the assigned set for this washing_data row, include it.
      const assignedSet = assignedMap[s.washing_data_id] || new Set();
      if (!assignedSet.has(s.size_label)) {
        dataMap[s.washing_data_id].sizes.push({
          size_label: s.size_label,
          pieces: s.pieces
        });
      }
    });
    const output = Object.values(dataMap).filter(o => o.sizes.length > 0);
    console.log('[DEBUG] Final finishing data =>', output.length, 'assignments with leftover sizes');
    return res.json({ data: output });
  } catch (err) {
    console.error('[ERROR] GET /assign-finishing/data =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /washingdashboard/assign-finishing
// Expects a JSON payload.
router.post('/assign-finishing', isAuthenticated, isWashingMaster, async (req, res) => {
  console.log('[DEBUG] Entered POST /assign-finishing (Washing)');
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const washingMasterId = req.session.user.id;
    const { finishingAssignments, target_day } = req.body;
    console.log('[DEBUG] finishingAssignments (raw) =>', finishingAssignments);
    console.log('[DEBUG] target_day =>', target_day);

    if (!finishingAssignments) {
      req.flash('error', 'No finishing assignments data provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard/assign-finishing');
    }

    // finishingAssignments is already an object thanks to express.json()
    const finishingUserIds = Object.keys(finishingAssignments);
    if (!finishingUserIds.length) {
      req.flash('error', 'No finishing user selected for any size.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard/assign-finishing');
    }

    // Expected structure: { finishingUserId: [ { washing_assignment_id, size_label }, ... ] }
    for (const finUserId of finishingUserIds) {
      const arr = finishingAssignments[finUserId];
      console.log(`[DEBUG] For finishing user ${finUserId}, data:`, arr);
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Group items by washing_assignment_id
      const mapByAsgId = {};
      arr.forEach(item => {
        const wAsgId = item.washing_assignment_id;
        const sizeLabel = item.size_label;
        if (!mapByAsgId[wAsgId]) {
          mapByAsgId[wAsgId] = [];
        }
        mapByAsgId[wAsgId].push(sizeLabel);
      });

      for (const wAsgId of Object.keys(mapByAsgId)) {
        const sizeLabels = mapByAsgId[wAsgId];
        if (!sizeLabels.length) continue;
        console.log('[DEBUG] Creating finishing assignment for washing_assignment_id:', wAsgId, 'with sizes:', sizeLabels);

        // Check that the washing_data record exists and belongs to this user.
        const [[checkRow]] = await pool.query(`
          SELECT id
          FROM washing_data
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `, [wAsgId, washingMasterId]);
        if (!checkRow) {
          throw new Error(`No valid washing_data id=${wAsgId} for user ${washingMasterId}`);
        }

        const sizesJson = JSON.stringify(sizeLabels);
        await pool.query(`
          INSERT INTO finishing_assignments
            (washing_master_id, user_id, washing_assignment_id, target_day, assigned_on, sizes_json, is_approved)
          VALUES (?, ?, ?, ?, NOW(), ?, NULL)
        `, [washingMasterId, finUserId, wAsgId, target_day || null, sizesJson]);
        console.log('[DEBUG] Created finishing assignment for washing_assignment_id:', wAsgId);
      }
    }

    await conn.commit();
    conn.release();
    console.log('[DEBUG] Successfully assigned to finishing (Washing)');
    req.flash('success', 'Successfully assigned partial sizes to finishing!');
    return res.json({ success: true, message: 'Successfully assigned partial sizes to finishing!' });
  } catch (err) {
    console.error('[ERROR] POST /assign-finishing =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error assigning finishing: ' + err.message);
    return res.status(500).json({ success: false, error: 'Error assigning finishing: ' + err.message });
  }
});

module.exports = router;
