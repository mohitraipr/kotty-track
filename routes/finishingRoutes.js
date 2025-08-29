const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isFinishingMaster } = require('../middlewares/auth');

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
const upload = multer({ storage });

/* =============================================================
   1) FINISHING DASHBOARD (GET /finishingdashboard)
   ============================================================= */
router.get('/', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Fetch all details in one go to avoid per-row queries
    const [faRows] = await pool.query(
      `SELECT fa.*, 
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
    const [rows] = await pool.query(
      `SELECT *
         FROM finishing_data
        WHERE user_id = ? AND (lot_no LIKE ? OR sku LIKE ?)
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [userId, likeStr, likeStr, limit, offset]
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
      FROM finishing_data
      WHERE user_id = ? AND (lot_no LIKE ? OR sku LIKE ?)
    `, [userId, likeStr, likeStr]);
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
    const [[fa]] = await pool.query(`
      SELECT *
      FROM finishing_assignments
      WHERE id = ?
    `, [assignmentId]);
    if (!fa) return res.status(404).json({ error: 'Assignment not found.' });
    let lotNo = null, tableSizes = null, dataIdField = null, dataIdValue = null;
    if (fa.stitching_assignment_id) {
      const [[sd]] = await pool.query(`SELECT * FROM stitching_data WHERE id = ?`, [fa.stitching_assignment_id]);
      if (!sd) return res.json([]);
      lotNo = sd.lot_no; tableSizes = 'stitching_data_sizes'; dataIdField = 'stitching_data_id'; dataIdValue = sd.id;
    } else if (fa.washing_in_data_id) {
      const [[wd]] = await pool.query(`SELECT * FROM washing_in_data WHERE id = ?`, [fa.washing_in_data_id]);
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
   5) APPROVAL ROUTES
   ============================================================= */
router.get('/approve', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [pending] = await pool.query(`
      SELECT fa.*,
             CASE
               WHEN fa.stitching_assignment_id IS NOT NULL THEN 'Stitching'
               WHEN fa.washing_in_data_id IS NOT NULL THEN 'Washing'
             END AS department
      FROM finishing_assignments fa
      WHERE fa.user_id = ? AND (fa.is_approved = 0 OR fa.is_approved IS NULL)
      ORDER BY fa.assigned_on DESC
    `, [userId]);
    for (let row of pending) {
      let lotNo = null, totalPieces = 0, sizes = [];
      if (row.stitching_assignment_id) {
        const [[sd]] = await pool.query(`SELECT * FROM stitching_data WHERE id = ?`, [row.stitching_assignment_id]);
        if (sd) {
          lotNo = sd.lot_no; 
          totalPieces = sd.total_pieces;
          const [sizeRows] = await pool.query(`SELECT size_label, pieces FROM stitching_data_sizes WHERE stitching_data_id = ?`, [sd.id]);
          sizes = sizeRows;
        }
      } else if (row.washing_in_data_id) {
        const [[wd]] = await pool.query(`SELECT * FROM washing_in_data WHERE id = ?`, [row.washing_in_data_id]);
        if (wd) {
          lotNo = wd.lot_no; 
          totalPieces = wd.total_pieces;
          const [sizeRows] = await pool.query(`SELECT size_label, pieces FROM washing_in_data_sizes WHERE washing_in_data_id = ?`, [wd.id]);
          sizes = sizeRows;
        }
      }
      let cuttingRemark = '', cuttingSku = '';
      if (lotNo) {
        const [[cutData]] = await pool.query(`SELECT remark, sku FROM cutting_lots WHERE lot_no = ? LIMIT 1`, [lotNo]);
        if (cutData) {
          cuttingRemark = cutData.remark || '';
          cuttingSku = cutData.sku || '';
        }
      }
      row.lot_no = lotNo || 'N/A';
      row.total_pieces = totalPieces || 0;
      row.sizes = sizes;
      row.cutting_remark = cuttingRemark;
      row.cutting_sku = cuttingSku;
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

router.post('/approve/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const assignmentId = req.params.id;
    const { assignment_remark } = req.body;
    await pool.query(`
      UPDATE finishing_assignments SET is_approved = 1,approved_on = NOW(), assignment_remark = ?
      WHERE id = ? AND user_id = ?
    `, [assignment_remark || null, assignmentId, userId]);
    req.flash('success', 'Assignment approved successfully.');
    return res.redirect('/finishingdashboard/approve');
  } catch (err) {
    console.error('Error approving finishing assignment:', err);
    req.flash('error', 'Could not approve: ' + err.message);
    return res.redirect('/finishingdashboard/approve');
  }
});

router.post('/deny/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const assignmentId = req.params.id;
    const { assignment_remark } = req.body;
    await pool.query(`
      UPDATE finishing_assignments SET is_approved = 2, approved_on = NOW(),assignment_remark = ?
      WHERE id = ? AND user_id = ?
    `, [assignment_remark || null, assignmentId, userId]);
    req.flash('success', 'Assignment denied successfully.');
    return res.redirect('/finishingdashboard');
  } catch (err) {
    console.error('Error denying finishing assignment:', err);
    req.flash('error', 'Could not deny: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

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
      SELECT * FROM finishing_data WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/finishingdashboard');
    }
    const [sizes] = await pool.query(`
      SELECT * FROM finishing_data_sizes WHERE finishing_data_id = ? ORDER BY id ASC
    `, [entryId]);
    const [updates] = await pool.query(`
      SELECT * FROM finishing_data_updates WHERE finishing_data_id = ? ORDER BY updated_at ASC
    `, [entryId]);
    const [dispatches] = await pool.query(`
      SELECT destination, size_label, quantity, sent_at
        FROM finishing_dispatches
       WHERE finishing_data_id = ?
       ORDER BY sent_at ASC, id ASC
    `, [entryId]);
    const [[cuttingLot]] = await pool.query(`
      SELECT remark FROM cutting_lots WHERE lot_no = ? LIMIT 1
    `, [row.lot_no]);
    const cuttingRemark = cuttingLot ? cuttingLot.remark : null;
    return res.render('finishingChallan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates,
      dispatches,
      cuttingRemark
    });
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
      SELECT * FROM finishing_data WHERE user_id = ? ORDER BY created_at ASC
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
      mainSheet.addRow({ id: r.id, lot_no: r.lot_no, sku: r.sku, total_pieces: r.total_pieces, remark: r.remark || '', image_url: r.image_url || '', created_at: r.created_at });
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
      sizesSheet.addRow({ id: s.id, finishing_data_id: s.finishing_data_id, size_label: s.size_label, pieces: s.pieces, created_at: s.created_at });
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

module.exports = router;
