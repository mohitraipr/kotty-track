
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
const upload = multer({ storage });

/*===================================================================
  1) APPROVE / DENY WASHING IN ASSIGNMENTS
===================================================================*/

// GET /washingin/approve
router.get('/approve', isAuthenticated, isWashingInMaster, (req, res) => {
  const error = req.flash('error');
  const success = req.flash('success');
  // Render an EJS (or any templating) page that shows "Approve washing_in_assignments"
  return res.render('washingInApprove', {
    user: req.session.user,
    error,
    success
  });
});

// GET /washingin/approve/list
router.get('/approve/list', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId     = req.session.user.id;
    const searchTerm = req.query.search || '';
    const searchLike = `%${searchTerm}%`;

    const [rows] = await pool.query(`
      SELECT
        wia.id            AS assignment_id,
        wia.sizes_json,
        wia.assigned_on,
        wia.is_approved,
        wia.assignment_remark,

        wd.lot_no,
        wd.sku,
        wd.total_pieces,               -- <- from washing_data

        cl.remark       AS cutting_remark  -- <- from cutting_lots
      FROM washing_in_assignments wia
      JOIN washing_data wd
        ON wia.washing_data_id = wd.id
      LEFT JOIN cutting_lots cl
        ON cl.lot_no = wd.lot_no
      WHERE wia.user_id     = ?
        AND wia.is_approved IS NULL
        AND (wd.lot_no LIKE ? OR wd.sku LIKE ?)
      ORDER BY wia.assigned_on DESC
    `, [userId, searchLike, searchLike]);

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /washingin/approve/list =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /washingin/approve-lot
router.post('/approve-lot', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId       = req.session.user.id;
    const { assignment_id } = req.body;
    if (!assignment_id) {
      return res.status(400).json({ success: false, error: 'No assignment_id provided.' });
    }

    await pool.query(`
      UPDATE washing_in_assignments
      SET is_approved    = 1,
          approved_on    = NOW(),
          assignment_remark = NULL
      WHERE id = ? AND user_id = ?
    `, [assignment_id, userId]);

    // **Return JSON** so the front‑end AJAX can see success immediately
    return res.json({ success: true, message: 'Assignment approved successfully!' });
  } catch (err) {
    console.error('[ERROR] POST /washingin/approve-lot =>', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// POST /washingin/deny-lot
router.post('/deny-lot', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id, denial_remark } = req.body;

    if (!assignment_id) {
      req.flash('error', 'No assignment_id provided.');
      return res.redirect('/washingin/approve');
    }
    if (!denial_remark || !denial_remark.trim()) {
      req.flash('error', 'You must provide a remark for denial.');
      return res.redirect('/washingin/approve');
    }

    await pool.query(`
      UPDATE washing_in_assignments
      SET is_approved = 0,approved_on = NOW(),
          assignment_remark = ?
      WHERE id = ? AND user_id = ?
    `, [denial_remark.trim(), assignment_id, userId]);

    req.flash('success', 'Assignment denied successfully.');
    return res.redirect('/washingin/approve');
  } catch (err) {
    console.error('[ERROR] POST /washingin/deny-lot =>', err);
    req.flash('error', 'Error denying assignment: ' + err.message);
    return res.redirect('/washingin/approve');
  }
});

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

// GET /washingin/list-entries => for lazy loading the existing washing_in_data
router.get('/list-entries', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = req.query.search || '';
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 5;
    const searchLike = `%${search}%`;

    const [rows] = await pool.query(`
      SELECT *
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
    const [sizeRows] = await pool.query(`
      SELECT *
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

    // 1) find the washing_data row
    const [[wd]] = await pool.query(`
      SELECT *
      FROM washing_data
      WHERE id = ?
    `, [wdId]);
    if (!wd) {
      return res.status(404).json({ error: 'washing_data not found' });
    }

    // 2) gather sizes from washing_data_sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id = ?
    `, [wdId]);

    // 3) for each size_label, see how many have already been used in washing_in_data
    const output = [];
    for (const s of sizes) {
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wids.pieces),0) AS usedCount
        FROM washing_in_data_sizes wids
        JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
        WHERE wid.lot_no = ?
          AND wids.size_label = ?
      `, [wd.lot_no, s.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = Math.max(s.pieces - used, 0);
      output.push({
        id: s.id,
        size_label: s.size_label,
        total_pieces: s.pieces,
        used,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json(output);
  } catch (err) {
    console.error('[ERROR] GET /washingin/get-lot-sizes =>', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// OPTIONAL: GET /washingin/create/assignable-users => if you want to assign from washing_in_data to finishing
router.get('/create/assignable-users', isAuthenticated, isWashingInMaster, async (req, res) => {
  try {
    // Suppose we have finishing users with role 'finishing'
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
    let grandTotal = 0;
    for (const sizeId of Object.keys(sizesObj)) {
      const userCount = parseInt(sizesObj[sizeId], 10);
      if (isNaN(userCount) || userCount < 0) {
        req.flash('error', `Invalid piece count for sizeId ${sizeId}`);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingin');
      }
      if (userCount === 0) continue;

      // fetch from washing_data_sizes
      const [[wds]] = await conn.query(`
        SELECT *
        FROM washing_data_sizes
        WHERE id = ?
      `, [sizeId]);
      if (!wds) {
        req.flash('error', 'Invalid size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingin');
      }

      // how many used so far in washing_in_data
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(wids.pieces),0) AS usedCount
        FROM washing_in_data_sizes wids
        JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
        WHERE wid.lot_no = ?
          AND wids.size_label = ?
      `, [wd.lot_no, wds.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = wds.pieces - used;
      if (userCount > remain) {
        req.flash(
          'error',
          `Cannot create: requested ${userCount} for size [${wds.size_label}] but only ${remain} remain.`
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
    for (const sizeId of Object.keys(sizesObj)) {
      const val = parseInt(sizesObj[sizeId], 10) || 0;
      if (val <= 0) continue;

      const [[wds]] = await conn.query(`
        SELECT *
        FROM washing_data_sizes
        WHERE id = ?
      `, [sizeId]);

      await conn.query(`
        INSERT INTO washing_in_data_sizes (washing_in_data_id, size_label, pieces, created_at)
        VALUES (?, ?, ?, NOW())
      `, [newId, wds.size_label, val]);
    }

    // 7) (Optional) Assign partial sizes to finishing
    //    Suppose finishing_assignments table has columns (washing_in_master_id, user_id, washing_in_data_id, sizes_json, is_approved, etc.)
    const assignMap = {};
    for (const sizeId of Object.keys(assignmentsObj)) {
      const assignedFinUserId = assignmentsObj[sizeId];
      if (!assignedFinUserId) continue;

      // get the label
      const [[wds]] = await conn.query(`
        SELECT size_label
        FROM washing_data_sizes
        WHERE id = ?
      `, [sizeId]);
      if (!assignMap[assignedFinUserId]) {
        assignMap[assignedFinUserId] = [];
      }
      assignMap[assignedFinUserId].push(wds.size_label);
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
  console.log('updateSizes received →', req.body.updateSizes);

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

    for (const sizeId of Object.keys(updateSizes)) {
      const increment = parseInt(updateSizes[sizeId], 10);
      if (isNaN(increment) || increment <= 0) continue;

      const [[wds]] = await conn.query(`
        SELECT wds.size_label, wds.pieces
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wds.id = ?
        LIMIT 1
      `, [sizeId]);

      if (!wds) {
        throw new Error(`Invalid size ID: ${sizeId}`);
      }

      const { size_label, pieces } = wds;

      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(wids.pieces), 0) AS usedCount
        FROM washing_in_data_sizes wids
        JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
        WHERE wid.lot_no = ? AND wids.size_label = ?
      `, [entry.lot_no, size_label]);

      const used = usedRow.usedCount || 0;
      const remain = pieces - used;

      if (increment > remain) {
        throw new Error(`Cannot add ${increment} to size [${size_label}]. Only ${remain < 0 ? 0 : remain} remain.`);
      }

      const [[existingRow]] = await conn.query(`
        SELECT * FROM washing_in_data_sizes
        WHERE washing_in_data_id = ? AND size_label = ?
      `, [entryId, size_label]);

      if (!existingRow) {
        await conn.query(`
          INSERT INTO washing_in_data_sizes (washing_in_data_id, size_label, pieces, created_at)
          VALUES (?, ?, ?, NOW())
        `, [entryId, size_label, increment]);
      } else {
        await conn.query(`
          UPDATE washing_in_data_sizes
          SET pieces = pieces + ?
          WHERE id = ?
        `, [increment, existingRow.id]);
      }

      await conn.query(`
        INSERT INTO washing_in_data_updates (washing_in_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, size_label, increment]);

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
        wd.id             AS washing_data_id,
        wd.lot_no,
        wd.sku,
        wd.total_pieces
      FROM washing_data wd
      JOIN washing_in_assignments wia
        ON wia.washing_data_id = wd.id
      LEFT JOIN rewash_requests rr
        ON rr.washing_data_id = wd.id
          AND rr.status = 'pending'
      LEFT JOIN washing_in_data wid
        ON wid.lot_no = wd.lot_no
          AND wid.user_id = ?
      WHERE
        wia.user_id    = ?
        AND wia.is_approved = 1
        -- no already‑pending rewash
        AND rr.id IS NULL
        -- no already‑created washingIn data
        AND wid.id IS NULL
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
    // base washing_data row
    const [[wd]] = await pool.query(`SELECT * FROM washing_data WHERE id = ?`, [wdId]);
    if (!wd) return res.status(404).json({ error: 'Lot not found' });

    // sizes from washing_data_sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id = ?
    `, [wdId]);

    // compute how many already used in rewash_requests + existing rewash sizes?
    // But since we only allow one pending per lot, we can just show full pool
    const output = sizes.map(s => ({
      id: s.id,
      size_label: s.size_label,
      available: s.pieces, 
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
    for (let sizeId in sizes) {
      const reqCount = parseInt(sizes[sizeId], 10) || 0;
      if (reqCount <= 0) continue;

      // fetch size row
      const [[srow]] = await conn.query(`
        SELECT * FROM washing_data_sizes WHERE id = ?
      `, [sizeId]);
      if (!srow) throw new Error('Bad size reference.');

      if (reqCount > srow.pieces) throw new Error(`Requested ${reqCount} exceeds available ${srow.pieces} for ${srow.size_label}`);

      // record request size
      await conn.query(`
        INSERT INTO rewash_request_sizes
          (rewash_request_id, size_label, pieces_requested)
        VALUES (?, ?, ?)
      `, [rewashId, srow.size_label, reqCount]);

      // deduct from washing_data_sizes
      await conn.query(`
        UPDATE washing_data_sizes
        SET pieces = pieces - ?
        WHERE id = ?
      `, [reqCount, sizeId]);

      // deduct from washing_data.total_pieces
      await conn.query(`
        UPDATE washing_data
        SET total_pieces = total_pieces - ?
        WHERE id = ?
      `, [reqCount, wd.id]);

      // log negative update
      await conn.query(`
        INSERT INTO washing_data_updates
          (washing_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [wd.id, srow.size_label, -reqCount]);
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
module.exports = router;
