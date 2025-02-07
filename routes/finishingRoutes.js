// routes/finishingRoutes.js

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isFinishingMaster } = require('../middlewares/auth');

/* ---------------------------------------------------
   MULTER FOR IMAGE UPLOAD
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
const upload = multer({ storage });

/* =============================================================
   1) FINISHING DASHBOARD (GET /finishingdashboard)
   ============================================================= */
/**
 * We want to load finishing_assignments that:
 *   - belong to this finishing user,
 *   - are approved (`is_approved=1`),
 *   - reference a `lot_no` in either stitching_data or washing_data that is NOT in finishing_data.
 *
 * Then we pass them to EJS for an autocomplete search by `lot_no` or `sku`.
 */
router.get('/', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 1) Fetch all finishing_assignments for user, with is_approved=1
    const [faRows] = await pool.query(`
      SELECT fa.*,
             CASE
               WHEN fa.stitching_assignment_id IS NOT NULL THEN 'Stitching'
               WHEN fa.washing_assignment_id IS NOT NULL THEN 'Washing'
             END AS department
      FROM finishing_assignments fa
      WHERE fa.user_id = ?
        AND fa.is_approved = 1
      ORDER BY fa.assigned_on DESC
    `, [userId]);

    const finalAssignments = [];

    for (let fa of faRows) {
      let lotNo = null;
      let sku = null;

      if (fa.stitching_assignment_id) {
        // This references stitching_data.id
        const [[sd]] = await pool.query(`
          SELECT *
          FROM stitching_data
          WHERE id = ?
        `, [fa.stitching_assignment_id]);
        if (!sd) continue;  // invalid reference

        lotNo = sd.lot_no;
        sku = sd.sku;
      } else if (fa.washing_assignment_id) {
        // references washing_data.id
        const [[wd]] = await pool.query(`
          SELECT *
          FROM washing_data
          WHERE id = ?
        `, [fa.washing_assignment_id]);
        if (!wd) continue;

        lotNo = wd.lot_no;
        sku = wd.sku;
      } else {
        continue; // neither
      }

      // Check if lot_no is already used in finishing_data
      const [[usedCheck]] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM finishing_data
        WHERE lot_no = ?
      `, [lotNo]);
      if (usedCheck.cnt > 0) {
        // skip
        continue;
      }

      // store the lot_no and sku on the row so we can pass to EJS
      fa.lot_no = lotNo;
      fa.sku = sku;
      finalAssignments.push(fa);
    }

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    return res.render('finishingDashboard', {
      user: req.session.user,
      assignments: finalAssignments,  // pass to EJS
      error: errorMessages,
      success: successMessages
    });
  } catch (err) {
    console.error('Error loading finishing dashboard:', err);
    req.flash('error', 'Cannot load finishing dashboard data.');
    return res.redirect('/');
  }
});

/* =============================================================
   2) LIST EXISTING FINISHING_DATA (AJAX): GET /list-entries
   ============================================================= */
router.get('/list-entries', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    const limit = 5;
    const likeStr = `%${searchTerm}%`;

    // finishing_data for this user
    const [rows] = await pool.query(`
      SELECT *
      FROM finishing_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, likeStr, likeStr, limit, offset]);

    if (!rows.length) {
      return res.json({ data: [], hasMore: false });
    }

    // get finishing_data_sizes
    const ids = rows.map(r => r.id);
    const [sizeRows] = await pool.query(`
      SELECT *
      FROM finishing_data_sizes
      WHERE finishing_data_id IN (?)
    `, [ids]);
    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.finishing_data_id]) sizesMap[s.finishing_data_id] = [];
      sizesMap[s.finishing_data_id].push(s);
    });

    const dataOut = rows.map(r => ({
      ...r,
      sizes: sizesMap[r.id] || []
    }));

    // check total
    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM finishing_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
    `, [userId, likeStr, likeStr]);
    const hasMore = offset + rows.length < totalCount;

    return res.json({ data: dataOut, hasMore });
  } catch (err) {
    console.error('Error finishing list-entries:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* =============================================================
   3) GET ASSIGNMENT SIZES: GET /get-assignment-sizes/:assignmentId
   ============================================================= */
/**
 * For the "Create Entry" form: 
 *   1) Read finishing_assignments row
 *   2) If stitching_assignment_id => fetch from stitching_data
 *   3) If washing_assignment_id => fetch from washing_data
 *   4) Parse sizes_json => array of size labels
 *   5) For each label, check how many remain
 */
router.get('/get-assignment-sizes/:assignmentId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const assignmentId = req.params.assignmentId;

    // finishing_assignments
    const [[fa]] = await pool.query(`
      SELECT *
      FROM finishing_assignments
      WHERE id = ?
    `, [assignmentId]);
    if (!fa) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    let lotNo = null, tableSizes = null, dataIdField = null, dataIdValue = null;

    if (fa.stitching_assignment_id) {
      // references stitching_data.id
      const [[sd]] = await pool.query(`
        SELECT *
        FROM stitching_data
        WHERE id = ?
      `, [fa.stitching_assignment_id]);
      if (!sd) return res.json([]);

      lotNo = sd.lot_no;
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      dataIdValue = sd.id;
    } else if (fa.washing_assignment_id) {
      // references washing_data.id
      const [[wd]] = await pool.query(`
        SELECT *
        FROM washing_data
        WHERE id = ?
      `, [fa.washing_assignment_id]);
      if (!wd) return res.json([]);

      lotNo = wd.lot_no;
      tableSizes = 'washing_data_sizes';
      dataIdField = 'washing_data_id';
      dataIdValue = wd.id;
    } else {
      return res.json([]);
    }

    // parse sizes_json
    let assignedLabels = [];
    try {
      assignedLabels = JSON.parse(fa.sizes_json);  // e.g. ["S","M","L"]
    } catch (e) {
      assignedLabels = [];
    }
    if (!Array.isArray(assignedLabels) || !assignedLabels.length) {
      return res.json([]);
    }

    // fetch departmental sizes
    const [deptRows] = await pool.query(`
      SELECT size_label, pieces
      FROM ${tableSizes}
      WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => {
      deptMap[r.size_label] = r.pieces;
    });

    // compute remain
    const result = [];
    for (const lbl of assignedLabels) {
      const totalDept = deptMap[lbl] || 0;

      // how many used so far in finishing_data
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(fds.pieces),0) as usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [lotNo, lbl]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;

      result.push({
        size_label: lbl,
        total_produced: totalDept,
        used,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json(result);
  } catch (err) {
    console.error('Error finishing get-assignment-sizes:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* =============================================================
   4) CREATE FINISHING_DATA: POST /finishingdashboard/create
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

    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // finishing_assignments
    const [[fa]] = await conn.query(`
      SELECT *
      FROM finishing_assignments
      WHERE id = ?
        AND user_id = ?
        AND is_approved = 1
    `, [selectedAssignmentId, userId]);
    if (!fa) {
      req.flash('error', 'Invalid or unapproved finishing assignment.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // find lot_no, sku
    let lotNo, sku, tableSizes, dataIdField, dataIdValue;

    if (fa.stitching_assignment_id) {
      const [[sd]] = await conn.query(`
        SELECT *
        FROM stitching_data
        WHERE id = ?
      `, [fa.stitching_assignment_id]);
      if (!sd) {
        req.flash('error', 'Stitching data not found for this assignment.');
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }
      lotNo = sd.lot_no;
      sku = sd.sku;
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      dataIdValue = sd.id;
    } else if (fa.washing_assignment_id) {
      const [[wd]] = await conn.query(`
        SELECT *
        FROM washing_data
        WHERE id = ?
      `, [fa.washing_assignment_id]);
      if (!wd) {
        req.flash('error', 'Washing data not found for this assignment.');
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }
      lotNo = wd.lot_no;
      sku = wd.sku;
      tableSizes = 'washing_data_sizes';
      dataIdField = 'washing_data_id';
      dataIdValue = wd.id;
    } else {
      req.flash('error', 'Assignment is not linked to stitching or washing.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // check if lot_no already used
    const [[alreadyUsed]] = await conn.query(`
      SELECT COUNT(*) as cnt
      FROM finishing_data
      WHERE lot_no = ?
    `, [lotNo]);
    if (alreadyUsed.cnt > 0) {
      req.flash('error', 'This lot_no is already used in finishing_data.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // validate pieces
    const [deptRows] = await conn.query(`
      SELECT size_label, pieces
      FROM ${tableSizes}
      WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => {
      deptMap[r.size_label] = r.pieces;
    });

    let grandTotal = 0;
    for (const label in sizesObj) {
      const requested = parseInt(sizesObj[label], 10);
      if (isNaN(requested) || requested < 0) {
        req.flash('error', `Invalid piece count for size ${label}`);
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }
      if (requested === 0) continue;

      const totalDept = deptMap[label] || 0;
      // how many used so far
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(fds.pieces),0) as usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [lotNo, label]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;
      if (requested > remain) {
        req.flash('error', `Cannot request ${requested}; only ${remain} remain for size ${label}.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }

      grandTotal += requested;
    }

    if (grandTotal <= 0) {
      req.flash('error', 'No positive piece count provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // create finishing_data
    const [ins] = await conn.query(`
      INSERT INTO finishing_data
        (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, lotNo, sku, grandTotal, remark || null, image_url]);
    const newId = ins.insertId;

    // finishing_data_sizes
    for (const label in sizesObj) {
      const requested = parseInt(sizesObj[label], 10) || 0;
      if (requested > 0) {
        await conn.query(`
          INSERT INTO finishing_data_sizes
            (finishing_data_id, size_label, pieces, created_at)
          VALUES (?, ?, ?, NOW())
        `, [newId, label, requested]);
      }
    }

    await conn.commit();
    conn.release();

    req.flash('success', 'Finishing entry created successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error creating finishing data:', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error creating finishing data: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/* =============================================================
   5) APPROVAL ROUTES: GET /finishingdashboard/approve
   ============================================================= */
/**
 * Show all finishing_assignments that are PENDING (is_approved=0 or null).
 * Also fetch the `lot_no` and `total_pieces` from whichever data table is referenced.
 */
router.get('/approve', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [pending] = await pool.query(`
      SELECT fa.*,
             CASE
               WHEN fa.stitching_assignment_id IS NOT NULL THEN 'Stitching'
               WHEN fa.washing_assignment_id IS NOT NULL THEN 'Washing'
             END AS department
      FROM finishing_assignments fa
      WHERE fa.user_id = ?
        AND (fa.is_approved = 0 OR fa.is_approved IS NULL)
      ORDER BY fa.assigned_on DESC
    `, [userId]);

    // fetch lot_no, total_pieces from stitching_data or washing_data
    for (let row of pending) {
      let lotNo = null, totalPieces = 0;

      if (row.stitching_assignment_id) {
        // references stitching_data.id
        const [[sd]] = await pool.query(`
          SELECT *
          FROM stitching_data
          WHERE id = ?
        `, [row.stitching_assignment_id]);
        if (sd) {
          lotNo = sd.lot_no;
          totalPieces = sd.total_pieces;
        }
      } else if (row.washing_assignment_id) {
        const [[wd]] = await pool.query(`
          SELECT *
          FROM washing_data
          WHERE id = ?
        `, [row.washing_assignment_id]);
        if (wd) {
          lotNo = wd.lot_no;
          totalPieces = wd.total_pieces;
        }
      }

      // parse sizes_json
      let assignedSizes = [];
      try {
        assignedSizes = JSON.parse(row.sizes_json);
      } catch (e) {}

      row.lot_no = lotNo || 'N/A';
      row.total_pieces = totalPieces || 0;
      row.sizeCount = assignedSizes.length;
    }

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    return res.render('finishingApprove', {
      user: req.session.user,
      pending,
      error: errorMessages,
      success: successMessages
    });
  } catch (err) {
    console.error('Error loading finishing approvals:', err);
    req.flash('error', 'Error loading finishing approvals.');
    return res.redirect('/finishingdashboard');
  }
});

/**
 * POST /finishingdashboard/approve/:id
 */
router.post('/approve/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const assignmentId = req.params.id;
    const { assignment_remark } = req.body;

    await pool.query(`
      UPDATE finishing_assignments
      SET is_approved = 1,
          assignment_remark = ?
      WHERE id = ?
        AND user_id = ?
    `, [assignment_remark || null, assignmentId, userId]);

    req.flash('success', 'Assignment approved successfully.');
    return res.redirect('/finishingdashboard/approve');
  } catch (err) {
    console.error('Error approving finishing assignment:', err);
    req.flash('error', 'Could not approve: ' + err.message);
    return res.redirect('/finishingdashboard/approve');
  }
});

/**
 * POST /finishingdashboard/deny/:id
 */
router.post('/deny/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const assignmentId = req.params.id;
    const { assignment_remark } = req.body;

    await pool.query(`
      UPDATE finishing_assignments
      SET is_approved = 2,
          assignment_remark = ?
      WHERE id = ?
        AND user_id = ?
    `, [assignment_remark || null, assignmentId, userId]);

    req.flash('success', 'Assignment denied successfully.');
    return res.redirect('/finishingdashboard/approve');
  } catch (err) {
    console.error('Error denying finishing assignment:', err);
    req.flash('error', 'Could not deny: ' + err.message);
    return res.redirect('/finishingdashboard/approve');
  }
});

/* =============================================================
   6) UPDATE, CHALLAN, DOWNLOAD
   ============================================================= */
router.get('/update/:id/json', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    // finishing_data
    const [[entry]] = await pool.query(`
      SELECT *
      FROM finishing_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      return res.status(403).json({ error: 'Not found or no permission' });
    }

    // fetch finishing_data_sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM finishing_data_sizes
      WHERE finishing_data_id = ?
    `, [entryId]);

    // figure out if we can match it to stitching_data or washing_data by lot_no
    let tableSizes, dataIdField, dataIdValue;

    const [[sd]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      ORDER BY id DESC
      LIMIT 1
    `, [entry.lot_no]);
    if (sd) {
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      dataIdValue = sd.id;
    } else {
      const [[wd]] = await pool.query(`
        SELECT *
        FROM washing_data
        WHERE lot_no = ?
        ORDER BY id DESC
        LIMIT 1
      `, [entry.lot_no]);
      if (wd) {
        tableSizes = 'washing_data_sizes';
        dataIdField = 'washing_data_id';
        dataIdValue = wd.id;
      } else {
        // can't compute remain
        const outNoRemain = sizes.map(sz => ({ ...sz, remain: 0 }));
        return res.json({ sizes: outNoRemain });
      }
    }

    // fetch departmental total pieces
    const [deptRows] = await pool.query(`
      SELECT size_label, pieces
      FROM ${tableSizes}
      WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => {
      deptMap[r.size_label] = r.pieces;
    });

    const output = [];
    for (const sz of sizes) {
      const totalDept = deptMap[sz.size_label] || 0;
      // how many used so far
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(fds.pieces),0) AS usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;

      output.push({
        ...sz,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json({ sizes: output });
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
      SELECT *
      FROM finishing_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Record not found or no permission.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // see if we can match with stitching_data or washing_data by lot_no
    let tableSizes, dataIdField, dataIdValue;

    const [[sd]] = await conn.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      LIMIT 1
    `, [entry.lot_no]);
    if (sd) {
      tableSizes = 'stitching_data_sizes';
      dataIdField = 'stitching_data_id';
      dataIdValue = sd.id;
    } else {
      const [[wd]] = await conn.query(`
        SELECT *
        FROM washing_data
        WHERE lot_no = ?
        LIMIT 1
      `, [entry.lot_no]);
      if (wd) {
        tableSizes = 'washing_data_sizes';
        dataIdField = 'washing_data_id';
        dataIdValue = wd.id;
      } else {
        req.flash('error', 'Cannot find matching stitching_data or washing_data for lot_no.');
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }
    }

    // departmental map
    const [deptRows] = await conn.query(`
      SELECT size_label, pieces
      FROM ${tableSizes}
      WHERE ${dataIdField} = ?
    `, [dataIdValue]);
    const deptMap = {};
    deptRows.forEach(r => {
      deptMap[r.size_label] = r.pieces;
    });

    let updatedTotal = entry.total_pieces;

    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;

      const totalDept = deptMap[lbl] || 0;
      // used
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(fds.pieces),0) AS usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [entry.lot_no, lbl]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;

      if (increment > remain) {
        throw new Error(`Cannot add ${increment} for size ${lbl}, only ${remain} remain.`);
      }

      // check if finishing_data_sizes row exists
      const [[existing]] = await conn.query(`
        SELECT *
        FROM finishing_data_sizes
        WHERE finishing_data_id = ?
          AND size_label = ?
      `, [entryId, lbl]);

      if (!existing) {
        // create new
        await conn.query(`
          INSERT INTO finishing_data_sizes
            (finishing_data_id, size_label, pieces, created_at)
          VALUES (?, ?, ?, NOW())
        `, [entryId, lbl, increment]);
        updatedTotal += increment;
      } else {
        // update existing
        const newCount = existing.pieces + increment;
        await conn.query(`
          UPDATE finishing_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newCount, existing.id]);
        updatedTotal += increment;
      }

      // optional log
      await conn.query(`
        INSERT INTO finishing_data_updates
          (finishing_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
    }

    // update finishing_data total
    await conn.query(`
      UPDATE finishing_data
      SET total_pieces = ?
      WHERE id = ?
    `, [updatedTotal, entryId]);

    await conn.commit();
    conn.release();

    req.flash('success', 'Finishing data updated successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error updating finishing data:', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error updating finishing data: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/**
 * GET /finishingdashboard/challan/:id
 */
router.get('/challan/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    const [[row]] = await pool.query(`
      SELECT *
      FROM finishing_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/finishingdashboard');
    }

    const [sizes] = await pool.query(`
      SELECT *
      FROM finishing_data_sizes
      WHERE finishing_data_id = ?
      ORDER BY id ASC
    `, [entryId]);

    const [updates] = await pool.query(`
      SELECT *
      FROM finishing_data_updates
      WHERE finishing_data_id = ?
      ORDER BY updated_at ASC
    `, [entryId]);

    return res.render('finishingChallan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates
    });
  } catch (err) {
    console.error('Error finishing challan:', err);
    req.flash('error', 'Error loading finishing challan: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

/**
 * GET /finishingdashboard/download-all
 */
router.get('/download-all', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [mainRows] = await pool.query(`
      SELECT *
      FROM finishing_data
      WHERE user_id = ?
      ORDER BY created_at ASC
    `, [userId]);

    const [allSizes] = await pool.query(`
      SELECT fds.*
      FROM finishing_data_sizes fds
      JOIN finishing_data fd ON fd.id = fds.finishing_data_id
      WHERE fd.user_id = ?
      ORDER BY fds.finishing_data_id, fds.id
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

    const sizesSheet = workbook.addWorksheet('FinishingSizes');
    sizesSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Finishing ID', key: 'finishing_data_id', width: 12 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Pieces', key: 'pieces', width: 8 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        finishing_data_id: s.finishing_data_id,
        size_label: s.size_label,
        pieces: s.pieces,
        created_at: s.created_at
      });
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

module.exports = router;
