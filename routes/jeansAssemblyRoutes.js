// routes/jeansAssemblyRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isJeansAssemblyMaster } = require('../middlewares/auth');
const { createStagePayment } = require('../utils/stagePaymentHelper');
const stageEvents = require('../utils/stageEvents');
const { getLotStageUsers } = require('../utils/lotStageUsers');

// -------------------------------------
// MULTER for Image Upload
// -------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + file.originalname;
    cb(null, 'jeans-' + uniqueSuffix);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max for images
});

// Simple in-memory cache for washers dropdown
const washersCache = { data: null, expiry: 0 };
const CACHE_TTL_MS = 60 * 1000; // 1 minute

// ------------------------------------------------------------------
// 1) GET /jeansassemblydashboard
//    Renders the main "Jeans Assembly Dashboard" with lots & washers
// ------------------------------------------------------------------
router.get('/', isAuthenticated, isJeansAssemblyMaster, (req, res) => {
  res.render('jeansAssemblyEvents', { user: req.session.user });
});

// Legacy assignment-based dashboard, kept for any old links / bookmarks.
router.get('/legacy', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [lots] = await pool.query(`
      SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces, sd.created_at,c.remark AS cutting_remark
      FROM jeans_assembly_assignments ja
      JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
      LEFT JOIN cutting_lots c ON c.lot_no = sd.lot_no
      WHERE ja.user_id = ?
        AND ja.is_approved = 1
        AND sd.lot_no NOT IN (
          SELECT lot_no FROM jeans_assembly_data
        )
      ORDER BY sd.created_at DESC

    `, [userId]);

    const now = Date.now();
    let washers;
    if (washersCache.data && washersCache.expiry > now) {
      washers = washersCache.data;
    } else {
      const [rows] = await pool.query(`
        SELECT u.id, u.username
        FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'washing'
          AND u.is_active = 1
        ORDER BY u.username ASC
      `);
      washersCache.data = rows;
      washersCache.expiry = now + CACHE_TTL_MS;
      washers = rows;
    }

    const error = req.flash('error');
    const success = req.flash('success');

    return res.render('jeansAssemblyDashboard', {
      user: req.session.user,
      lots,
      washers,
      error,
      success
    });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/legacy =>', err);
    req.flash('error', 'Cannot load jeans assembly dashboard data.');
    return res.redirect('/jeansassemblydashboard');
  }
});

// ------------------------------------------------------------------
// 2) POST /jeansassemblydashboard/create
//    Create new jeans_assembly_data from a chosen lot
//    Optionally assign to Washing immediately if washer_id is selected
// ------------------------------------------------------------------
router.post('/create',
  isAuthenticated,
  isJeansAssemblyMaster,
  upload.single('image_file'),
  async (req, res) => {
    let conn;
    try {
      const userId = req.session.user.id;
      const { selectedLotId, remark, washer_id } = req.body;  // <--- direct washer assignment
      let image_url = null;
      if (req.file) {
        image_url = '/uploads/' + req.file.filename;
      }

      // The sizes object from the form: { "stitching_data_size_id": "piecesRequested", ... }
      const sizesObj = req.body.sizes || {};

      if (!selectedLotId) {
        req.flash('error', 'No lot selected.');
        return res.redirect('/jeansassemblydashboard');
      }

      if (!Object.keys(sizesObj).length) {
        req.flash('error', 'No size data provided.');
        return res.redirect('/jeansassemblydashboard');
      }

      conn = await pool.getConnection();
      await conn.beginTransaction();

      // 1) Validate lot
      const [[sd]] = await conn.query(`
        SELECT *
        FROM stitching_data
        WHERE id = ?
      `, [selectedLotId]);
      if (!sd) {
        req.flash('error', 'Invalid lot selection.');
        await conn.rollback();
        conn.release();
        return res.redirect('/jeansassemblydashboard');
      }

      // 2) Check if lot_no is already used in jeans_assembly_data
      const [[already]] = await conn.query(`
        SELECT id FROM jeans_assembly_data
        WHERE lot_no = ?
      `, [sd.lot_no]);
      if (already) {
        req.flash('error', `Lot ${sd.lot_no} already used for jeans assembly.`);
        await conn.rollback();
        conn.release();
        return res.redirect('/jeansassemblydashboard');
      }

      // 3) Validate each size piece count in batch
      const sizeIds = Object.keys(sizesObj).map(id => parseInt(id, 10));
      const [sizeRows] = await conn.query(
        `SELECT id, size_label, pieces FROM stitching_data_sizes WHERE id IN (?)`,
        [sizeIds]
      );
      const sizeMap = {};
      sizeRows.forEach(r => { sizeMap[r.id] = r; });

      const [usedRows] = await conn.query(
        `SELECT jds.size_label, COALESCE(SUM(jds.pieces),0) AS used
         FROM jeans_assembly_data_sizes jds
         JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
         WHERE jd.lot_no = ?
         GROUP BY jds.size_label`,
        [sd.lot_no]
      );
      const usedMap = {};
      usedRows.forEach(r => { usedMap[r.size_label] = r.used; });

      let grandTotal = 0;
      for (const sizeId of sizeIds) {
        const requested = parseInt(sizesObj[sizeId], 10) || 0;
        if (requested < 0) {
          req.flash('error', 'Invalid negative pieces');
          await conn.rollback();
          conn.release();
          return res.redirect('/jeansassemblydashboard');
        }
        if (requested === 0) continue;

        const sds = sizeMap[sizeId];
        if (!sds) {
          req.flash('error', 'Bad size reference: ' + sizeId);
          await conn.rollback();
          conn.release();
          return res.redirect('/jeansassemblydashboard');
        }
        const used = usedMap[sds.size_label] || 0;
        const remain = sds.pieces - used;
        if (requested > remain) {
          req.flash('error', `Requested ${requested} but only ${remain} remain for size ${sds.size_label}.`);
          await conn.rollback();
          conn.release();
          return res.redirect('/jeansassemblydashboard');
        }
        grandTotal += requested;
      }

      if (grandTotal <= 0) {
        req.flash('error', 'No pieces > 0 provided.');
        await conn.rollback();
        conn.release();
        return res.redirect('/jeansassemblydashboard');
      }

      // 4) Insert into jeans_assembly_data
      const [main] = await conn.query(`
        INSERT INTO jeans_assembly_data
          (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `, [userId, sd.lot_no, sd.sku, grandTotal, remark || null, image_url]);
      const newAssemblyId = main.insertId;

      // 5) Insert each size in a single query
      const sizeInsertValues = [];
      const now = new Date();
      for (const sizeId of sizeIds) {
        const requested = parseInt(sizesObj[sizeId], 10) || 0;
        if (requested > 0) {
          const sds = sizeMap[sizeId];
          sizeInsertValues.push([newAssemblyId, sds.size_label, requested, now]);
        }
      }
      if (sizeInsertValues.length) {
        await conn.query(
          `INSERT INTO jeans_assembly_data_sizes
            (jeans_assembly_data_id, size_label, pieces, created_at)
           VALUES ?`,
          [sizeInsertValues]
        );
      }

      // 6) If user selected a Washer, immediately assign to washing
      if (washer_id) {
        const [sizes] = await conn.query(`
          SELECT size_label, pieces
          FROM jeans_assembly_data_sizes
          WHERE jeans_assembly_data_id = ?
        `, [newAssemblyId]);

        const sizes_json = JSON.stringify(sizes);

        // Insert a new washing assignment (pending approval by default)
        await conn.query(`
          INSERT INTO washing_assignments
            (jeans_assembly_master_id, user_id, jeans_assembly_assignment_id, target_day, assigned_on, sizes_json, is_approved)
          VALUES (?, ?, ?, CURDATE(), NOW(), ?, NULL)
        `, [userId, washer_id, newAssemblyId, sizes_json]);
      }

      // 7) Commit
      await conn.commit();
      conn.release();

      req.flash('success', 'Jeans Assembly entry created successfully.');
      return res.redirect('/jeansassemblydashboard');
    } catch (err) {
      console.error('[ERROR] POST /jeansassemblydashboard/create =>', err);
      if (conn) {
        await conn.rollback();
        conn.release();
      }
      req.flash('error', 'Error creating jeans assembly data: ' + err.message);
      return res.redirect('/jeansassemblydashboard');
    }
  }
);

// ------------------------------------------------------------------
// 3) GET /jeansassemblydashboard/get-lot-sizes/:lotId
//    Return size info (remain) from stitching_data_sizes
//    This is used dynamically when user picks a lot from the dropdown
// ------------------------------------------------------------------
router.get('/get-lot-sizes/:lotId', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;

    // Validate
    const [[stData]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE id = ?
    `, [lotId]);
    if (!stData) {
      return res.status(404).json({ error: 'Lot not found' });
    }

    // Fetch sizes with remain calculation in one query
    const [rows] = await pool.query(`
      SELECT s.id, s.size_label, s.pieces,
             s.pieces - COALESCE(u.usedCount,0) AS remain
      FROM stitching_data_sizes s
      LEFT JOIN (
        SELECT jds.size_label, SUM(jds.pieces) AS usedCount
        FROM jeans_assembly_data_sizes jds
        JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
        WHERE jd.lot_no = ?
        GROUP BY jds.size_label
      ) u ON s.size_label = u.size_label
      WHERE s.stitching_data_id = ?
    `, [stData.lot_no, lotId]);

    const results = rows.map(r => ({
      id: r.id,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    }));

    return res.json(results);
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/get-lot-sizes =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// 4) GET /jeansassemblydashboard/update/:id/json
//    Return existing data + remain for the update modal
// ------------------------------------------------------------------
router.get('/update/:id/json', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const entryId = req.params.id;
    const userId = req.session.user.id;

    // Validate
    const [[entry]] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      return res.status(403).json({ error: 'Not found or no permission' });
    }

    // Fetch existing sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data_sizes
      WHERE jeans_assembly_data_id = ?
    `, [entryId]);

    // Find remain
    const [[sd]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      LIMIT 1
    `, [entry.lot_no]);
    if (!sd) {
      // can't calculate remain if no stitching_data found
      const outNoRemain = sizes.map(sz => ({ ...sz, remain: 999999 }));
      return res.json({ sizes: outNoRemain });
    }

    // Calculate remain for each size in one query using stitching_data_sizes
    const [rows] = await pool.query(`
      SELECT sz.id, sz.size_label, sz.pieces,
             COALESCE(sds.pieces,0) - COALESCE(u.usedCount,0) AS remain
      FROM jeans_assembly_data_sizes sz
      JOIN jeans_assembly_data ja   ON sz.jeans_assembly_data_id = ja.id
      JOIN stitching_data sd        ON ja.lot_no = sd.lot_no
      JOIN stitching_data_sizes sds ON sds.stitching_data_id = sd.id
                                   AND sds.size_label = sz.size_label
      LEFT JOIN (
        SELECT jds.size_label, SUM(jds.pieces) AS usedCount
        FROM jeans_assembly_data_sizes jds
        JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
        WHERE jd.lot_no = ?
        GROUP BY jds.size_label
      ) u ON sz.size_label = u.size_label
      WHERE sz.jeans_assembly_data_id = ?
    `, [entry.lot_no, entryId]);

    const output = rows.map(r => ({
      id: r.id,
      jeans_assembly_data_id: entryId,
      size_label: r.size_label,
      pieces: r.pieces,
      remain: r.remain < 0 ? 0 : r.remain
    }));

    return res.json({ sizes: output });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/update/:id/json =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// 5) POST /jeansassemblydashboard/update/:id
//    Increment existing pieces in a single Jeans Assembly record
// ------------------------------------------------------------------
router.post('/update/:id', isAuthenticated, isJeansAssemblyMaster, upload.none(), async (req, res) => {
  let conn;
  try {
    const entryId = req.params.id;
    const userId = req.session.user.id;
    const updateSizes = req.body.updateSizes || {};

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validate ownership
    const [[entry]] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data
      WHERE id = ? AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Record not found or no permission.');
      await conn.rollback();
      conn.release();
      return res.redirect('/jeansassemblydashboard');
    }

    // find the matching stitching_data
    const [[sd]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      LIMIT 1
    `, [entry.lot_no]);
    if (!sd) {
      req.flash('error', `Cannot find stitching_data for lot ${entry.lot_no}.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/jeansassemblydashboard');
    }

    // create a map of size_label => total pieces
    const [sdRows] = await pool.query(`
      SELECT size_label, pieces
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
    `, [sd.id]);
    const sdMap = {};
    sdRows.forEach(r => { sdMap[r.size_label] = r.pieces; });

    let updatedTotal = entry.total_pieces;

    const labels = Object.keys(updateSizes);
    if (labels.length) {
      const [usedRows] = await conn.query(
        `SELECT jds.size_label, SUM(jds.pieces) AS usedCount
         FROM jeans_assembly_data_sizes jds
         JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
         WHERE jd.lot_no = ?
         GROUP BY jds.size_label`,
        [entry.lot_no]
      );
      const usedMap = {};
      usedRows.forEach(r => { usedMap[r.size_label] = r.usedCount; });

      const [existingRows] = await conn.query(
        `SELECT id, size_label, pieces FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = ?`,
        [entryId]
      );
      const existMap = {};
      existingRows.forEach(r => { existMap[r.size_label] = r; });

      const now = new Date();
      const insertValues = [];
      const logValues = [];

      for (const lbl of labels) {
        let increment = parseInt(updateSizes[lbl], 10);
        if (isNaN(increment) || increment < 0) increment = 0;
        if (increment === 0) continue;

        const totalDept = sdMap[lbl] || 0;
        const used = usedMap[lbl] || 0;
        const remain = totalDept - used;
        if (increment > remain) {
          throw new Error(`Cannot add ${increment} for [${lbl}]; only ${remain} remain.`);
        }

        const existing = existMap[lbl];
        if (!existing) {
          insertValues.push([entryId, lbl, increment, now]);
          updatedTotal += increment;
        } else {
          const newCount = existing.pieces + increment;
          await conn.query(
            `UPDATE jeans_assembly_data_sizes SET pieces = ? WHERE id = ?`,
            [newCount, existing.id]
          );
          updatedTotal += increment;
        }

        logValues.push([entryId, lbl, increment, now]);
      }

      if (insertValues.length) {
        await conn.query(
          `INSERT INTO jeans_assembly_data_sizes (jeans_assembly_data_id, size_label, pieces, created_at) VALUES ?`,
          [insertValues]
        );
      }

      if (logValues.length) {
        await conn.query(
          `INSERT INTO jeans_assembly_data_updates (jeans_assembly_data_id, size_label, pieces, updated_at) VALUES ?`,
          [logValues]
        );
      }
    }

    // Update total
    await conn.query(`
      UPDATE jeans_assembly_data
      SET total_pieces = ?
      WHERE id = ?
    `, [updatedTotal, entryId]);

    await conn.commit();
    conn.release();

    req.flash('success', 'Jeans assembly data updated successfully!');
    return res.redirect('/jeansassemblydashboard');
  } catch (err) {
    console.error('[ERROR] POST /jeansassemblydashboard/update/:id =>', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error updating jeans assembly data: ' + err.message);
    return res.redirect('/jeansassemblydashboard');
  }
});

// ------------------------------------------------------------------
// 6) GET /jeansassemblydashboard/challan/:id
//    Renders a "Jeans Assembly to Washing" challan in your custom style
// ------------------------------------------------------------------
router.get('/challan/:id', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    // 1) Jeans assembly record
    const [[entry]] = await pool.query(`
      SELECT jad.*, cl.manual_lot_number
      FROM jeans_assembly_data jad
      LEFT JOIN cutting_lots cl ON cl.lot_no = jad.lot_no
      WHERE jad.id = ? AND jad.user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/jeansassemblydashboard');
    }

    // 2) Sizes
    const [sizes] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data_sizes
      WHERE jeans_assembly_data_id = ?
      ORDER BY id ASC
    `, [entryId]);

    // 3) Wash assignments referencing this Jeans Assembly
    //    (like finishingAssignments example, but for washing)
    const [washingAssignments] = await pool.query(`
      SELECT wa.*,
             u.username AS assignedUserName,
             m.username AS masterUserName
      FROM washing_assignments wa
      JOIN users u ON wa.user_id = u.id
      JOIN users m ON wa.jeans_assembly_master_id = m.id
      WHERE wa.jeans_assembly_assignment_id = ?
      ORDER BY wa.assigned_on ASC
    `, [entryId]);

    // 4) Update logs
    const [updates] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data_updates
      WHERE jeans_assembly_data_id = ?
      ORDER BY updated_at ASC
    `, [entryId]);

    return res.render('jeansAssemblyChallan', {
      entry,
      sizes,
      washingAssignments,
      updates
    });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/challan/:id =>', err);
    req.flash('error', 'Error loading jeans assembly challan: ' + err.message);
    return res.redirect('/jeansassemblydashboard');
  }
});

// ------------------------------------------------------------------
// 7) GET /jeansassemblydashboard/download-all
//    Export all jeans_assembly_data & sizes to Excel
// ------------------------------------------------------------------
router.get('/download-all', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // main data
    const [mainRows] = await pool.query(`
      SELECT *
      FROM jeans_assembly_data
      WHERE user_id = ?
      ORDER BY created_at ASC
    `, [userId]);

    // sizes
    const [allSizes] = await pool.query(`
      SELECT jas.*
      FROM jeans_assembly_data_sizes jas
      JOIN jeans_assembly_data ja ON ja.id = jas.jeans_assembly_data_id
      WHERE ja.user_id = ?
      ORDER BY jas.jeans_assembly_data_id, jas.id
    `, [userId]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();

    // Sheet 1
    const mainSheet = workbook.addWorksheet('JeansAssemblyData');
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

    // Sheet 2
    const sizesSheet = workbook.addWorksheet('JeansAssemblySizes');
    sizesSheet.columns = [
      { header: 'ID', key: 'id', width: 6 },
      { header: 'Assembly ID', key: 'jeans_assembly_data_id', width: 12 },
      { header: 'Size Label', key: 'size_label', width: 12 },
      { header: 'Pieces', key: 'pieces', width: 8 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        jeans_assembly_data_id: s.jeans_assembly_data_id,
        size_label: s.size_label,
        pieces: s.pieces
      });
    });

    res.setHeader('Content-Disposition', 'attachment; filename="JeansAssemblyData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/download-all =>', err);
    req.flash('error', 'Could not download Jeans Assembly Excel: ' + err.message);
    return res.redirect('/jeansassemblydashboard');
  }
});

// ------------------------------------------------------------------
// 8) APPROVAL ROUTES (Optional, if you still use them)
// ------------------------------------------------------------------
router.get('/approve', isAuthenticated, isJeansAssemblyMaster, (req, res) => {
  res.render('JeansAssemblyApprove', { user: req.session.user });
});

router.get('/approve/list', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    const likeStr = `%${searchTerm}%`;

    const [rows] = await pool.query(`
      SELECT
        ja.id AS assignment_id,
        ja.sizes_json,
        ja.assigned_on,
        ja.is_approved,
        ja.assignment_remark,
        sd.lot_no,
        sd.total_pieces,
        c.remark AS cutting_remark,
        c.sku
      FROM jeans_assembly_assignments ja
      JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
      JOIN cutting_lots c ON sd.lot_no = c.lot_no
      WHERE ja.user_id = ?
        AND (ja.is_approved IS NULL OR ja.is_approved = 0)
        AND (sd.lot_no LIKE ? OR c.sku LIKE ?)
      ORDER BY ja.assigned_on DESC
    `, [userId, likeStr, likeStr]);

    return res.json({ data: rows });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/approve/list =>', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/approve-lot', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { assignment_id, approval_remark } = req.body;
    if (!assignment_id) {
      return res.status(400).json({ error: 'No assignment_id provided.' });
    }
    const remark = approval_remark && approval_remark.trim() ? approval_remark.trim() : null;

    // Get stitching data before updating
    const [stitchingData] = await pool.query(`
      SELECT jaa.stitching_assignment_id, sd.user_id, sd.lot_no, sd.sku, sd.total_pieces,
             u.username
      FROM jeans_assembly_assignments jaa
      JOIN stitching_data sd ON jaa.stitching_assignment_id = sd.id
      JOIN users u ON sd.user_id = u.id
      WHERE jaa.id = ? AND jaa.user_id = ?
    `, [assignment_id, userId]);

    await pool.query(`
      UPDATE jeans_assembly_assignments
      SET is_approved = 1,approved_on = NOW(),
          assignment_remark = ?
      WHERE id = ?
        AND user_id = ?
    `, [remark, assignment_id, userId]);

    // Auto-create stitching payment after approval
    if (stitchingData.length > 0) {
      const sd = stitchingData[0];
      await createStagePayment('stitching', {
        lot_no: sd.lot_no,
        sku: sd.sku,
        qty: sd.total_pieces,
        user_id: sd.user_id,
        username: sd.username
      });
    }

    return res.redirect('/jeansassemblydashboard/approve');
  } catch (err) {
    console.error('[ERROR] POST /jeansassemblydashboard/approve-lot =>', err);
    return res.status(500).json({ error: 'Error approving assignment: ' + err.message });
  }
});

router.post('/deny-lot', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
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
      UPDATE jeans_assembly_assignments
      SET is_approved = 0,
      approved_on = NOW(),
          assignment_remark = ?
      WHERE id = ?
        AND user_id = ?
    `, [denial_remark.trim(), assignment_id, userId]);

    return res.json({ success: true, message: 'Assignment denied successfully.' });
  } catch (err) {
    console.error('[ERROR] POST /jeansassemblydashboard/deny-lot =>', err);
    return res.status(500).json({ error: 'Error denying assignment: ' + err.message });
  }
});

// ==================================================================
//   NEW EVENT MODEL — multi-batch approve/complete/reject
//
//   Mirrors stitching's /event/* endpoints. The upstream pool here is
//   stitching's COMPLETE event totals for the lot; assembly approves
//   pieces from that pool.
//
//   On every approve event we fire createStagePayment('stitching', …)
//   for the qty being taken — this replaces the old "submit pays the
//   stitcher" trigger and supports per-batch payments.
// ==================================================================

const STAGE_JA = 'jeans_assembly';

// Helper: stitching's "downstream available" pool for a cutting lot.
// = total completed by stitching (events + legacy) - already approved
//   by assembly (events). Returned per size + total.
async function jaUpstreamSizes(conn, cuttingLotId, lotNo) {
  // Stitching completed totals — prefer events, fall back to legacy data
  const [evRows] = await conn.query(
    `SELECT s.size_label, COALESCE(SUM(s.pieces),0) AS pieces
     FROM stitching_event_sizes s
     JOIN stitching_events e ON e.id = s.event_id
     WHERE e.cutting_lot_id = ? AND e.event_type = 'complete'
     GROUP BY s.size_label`,
    [cuttingLotId]
  );

  const stitchSizes = {};
  for (const r of evRows) {
    const k = stageEvents.normalizeSizeLabel(r.size_label);
    if (k) stitchSizes[k] = (stitchSizes[k] || 0) + (Number(r.pieces) || 0);
  }

  if (Object.keys(stitchSizes).length === 0) {
    // Legacy fallback — stitching submit auto-completed everything
    const [legRows] = await conn.query(
      `SELECT sds.size_label, COALESCE(SUM(sds.pieces),0) AS pieces
       FROM stitching_data_sizes sds
       JOIN stitching_data sd ON sd.id = sds.stitching_data_id
       WHERE sd.lot_no = ?
       GROUP BY sds.size_label`,
      [lotNo]
    );
    for (const r of legRows) {
      const k = stageEvents.normalizeSizeLabel(r.size_label);
      if (k) stitchSizes[k] = (stitchSizes[k] || 0) + (Number(r.pieces) || 0);
    }
  }

  // Assembly's already-approved totals per size (already normalized by helper)
  const jaSizes = await stageEvents.getStageSizeAggregates(conn, STAGE_JA, cuttingLotId);

  // Embed full per-size aggregates so frontend has no lookup work.
  const out = [];
  for (const [size_label, stitched] of Object.entries(stitchSizes)) {
    const sa = jaSizes[size_label] || { approved: 0, completed: 0, rejected: 0, inline: 0, upstream_rejected: 0, inline_rejected: 0 };
    const consumed = (sa.approved || 0) + (sa.upstream_rejected || 0);
    out.push({
      size_label,
      stitched_qty: stitched,
      approved: sa.approved,
      completed: sa.completed,
      rejected: sa.rejected,
      upstream_rejected: sa.upstream_rejected || 0,
      inline_rejected: sa.inline_rejected || 0,
      inline: sa.inline,
      approved_at_stage: sa.approved,
      available: Math.max(0, stitched - consumed),
    });
  }
  return out;
}

// Helper: identify the stitcher who should receive the payment for an
// assembly approve. Picks the stitcher with the largest stitching_data
// row for this lot (close enough for v1 — accountants can adjust if a
// lot was split across multiple stitchers).
async function jaPickStitcherForPayment(conn, lotNo) {
  const [rows] = await conn.query(
    `SELECT sd.user_id, u.username, sd.sku
     FROM stitching_data sd
     JOIN users u ON u.id = sd.user_id
     WHERE sd.lot_no = ?
     ORDER BY sd.total_pieces DESC, sd.created_at DESC
     LIMIT 1`,
    [lotNo]
  );
  return rows[0] || null;
}

// GET /jeansassemblydashboard/events  — render the new dashboard
router.get('/events', isAuthenticated, isJeansAssemblyMaster, (req, res) => {
  res.render('jeansAssemblyEvents', { user: req.session.user });
});

// ==================================================================
//   EVENT-MODEL HISTORY / JOURNEY / EXPORT / PAYMENTS
//   Cascade from stitching pattern.
// ==================================================================

router.get('/event/history', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
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
       FROM jeans_assembly_events e
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
      `SELECT event_id, size_label, pieces FROM jeans_assembly_event_sizes WHERE event_id IN (?)`,
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
    console.error('[ERROR] GET /jeansassemblydashboard/event/history =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/lot-journey/:cuttingLotId', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const lotId = parseInt(req.params.cuttingLotId, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) {
      return res.status(400).json({ error: 'Invalid cutting_lot_id' });
    }
    const [events] = await pool.query(
      `SELECT e.id, e.event_type, e.pieces, e.remark, e.created_at, e.parent_event_id,
              u.username AS operator
       FROM jeans_assembly_events e
       JOIN users u ON u.id = e.operator_id
       WHERE e.cutting_lot_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
      [lotId]
    );
    if (!events.length) return res.json({ events: [] });
    const ids = events.map(e => e.id);
    const [sizes] = await pool.query(
      `SELECT event_id, size_label, pieces FROM jeans_assembly_event_sizes WHERE event_id IN (?)`,
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
    console.error('[ERROR] GET /jeansassemblydashboard/event/lot-journey =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/export', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
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
       FROM jeans_assembly_events e
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
        `SELECT event_id, size_label, pieces FROM jeans_assembly_event_sizes
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
    const ws = wb.addWorksheet('Jeans Assembly Events');
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

    const fname = `jeans_assembly_${username}_${days}d_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/event/export =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/payments', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
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
         AND stage = 'jeans_assembly'
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
       WHERE user_id = ? AND stage = 'jeans_assembly'
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
    console.error('[ERROR] GET /jeansassemblydashboard/event/payments =>', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/event/payments/export', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
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
         AND stage = 'jeans_assembly'
         AND created_at >= (NOW() - INTERVAL ? DAY)
         ${statusFilter}
       ORDER BY created_at DESC`,
      params
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kotty Track';
    wb.created = new Date();
    const ws = wb.addWorksheet('Jeans Assembly Payments');
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

    const fname = `jeans_assembly_payments_${username}_${days}d_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/event/payments/export =>', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /jeansassemblydashboard/event/search?q=...
router.get('/event/search', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ lots: [] });
    const like = `%${q}%`;
    // Restrict to denim — assembly is denim-only
    const [lots] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.remark AS cutting_remark,
              cl.flow_type,
              u.username AS cutting_master, u.is_denim_cutter
       FROM cutting_lots cl
       JOIN users u ON u.id = cl.user_id
       WHERE (cl.lot_no LIKE ? OR cl.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
         AND (cl.flow_type = 'denim' OR (cl.flow_type IS NULL AND u.is_denim_cutter = 1)
              OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL
                  AND (cl.lot_no LIKE 'AK%' OR cl.lot_no LIKE 'UM%')))
       ORDER BY cl.created_at DESC
       LIMIT 25`,
      [like, like, like, like]
    );
    res.json({ lots });
  } catch (err) {
    console.error('[ERROR] GET /event/search =>', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /jeansassemblydashboard/event/lot-state/:cuttingLotId
router.get('/event/lot-state/:cuttingLotId', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const lotId = parseInt(req.params.cuttingLotId, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) {
      return res.status(400).json({ error: 'Invalid cutting_lot_id' });
    }

    const [[lot]] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.remark AS cutting_remark, cl.flow_type,
              u.username AS cutting_master, u.is_denim_cutter
       FROM cutting_lots cl
       JOIN users u ON u.id = cl.user_id
       WHERE cl.id = ?`,
      [lotId]
    );
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    const userId = req.session?.user?.id;
    const aggregates      = await stageEvents.getStageAggregates(pool, STAGE_JA, lotId);
    const sizeAggregates  = await stageEvents.getStageSizeAggregates(pool, STAGE_JA, lotId);
    // Owner-locked: only show this operator's own open approves.
    const openApprovals   = await stageEvents.getOpenApprovals(pool, STAGE_JA, lotId, userId);
    const upstreamSizes   = await jaUpstreamSizes(pool, lotId, lot.lot_no);
    const upstreamTotal   = upstreamSizes.reduce((a, s) => a + s.available, 0);

    const stageUsers = await getLotStageUsers(pool, { id: lot.id, flow_type: lot.flow_type, cutter_name: lot.cutting_master });

    res.json({
      lot,
      stage_aggregates: aggregates,
      stage_size_aggregates: sizeAggregates,
      upstream_sizes: upstreamSizes,
      upstream_total_available: upstreamTotal,
      open_approvals: openApprovals,
      stage_users: stageUsers,
    });
  } catch (err) {
    console.error('[ERROR] GET /event/lot-state =>', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /jeansassemblydashboard/event/approve
// Body: { cutting_lot_id, sizes: [{size_label, pieces}], remark? }
//
// Side effects (after the events insert):
//   - createStagePayment('stitching', ...) for the qty being taken,
//     paid to the lot's primary stitcher.
router.post('/event/approve', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { cutting_lot_id, sizes, rejected_sizes, remark, reject_reason } = req.body;

    const lotId = parseInt(cutting_lot_id, 10);
    if (!Number.isFinite(lotId) || lotId <= 0) {
      return res.status(400).json({ error: 'Invalid cutting_lot_id' });
    }
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
      `SELECT lot_no, sku FROM cutting_lots WHERE id = ?`,
      [lotId]
    );
    if (!lot) {
      await conn.rollback();
      return res.status(404).json({ error: 'Lot not found' });
    }

    const upstream = await jaUpstreamSizes(conn, lotId, lot.lot_no);
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
        return res.status(400).json({
          error: `Size ${k}: only ${avail} pieces available from stitching (requested ${taken + rej} = take ${taken} + reject ${rej})`,
        });
      }
    }

    let approveEventId = null;
    let rejectEventId  = null;

    if (cleanSizes.length) {
      const approveRes = await stageEvents.recordEvent(conn, {
        stage: STAGE_JA,
        cuttingLotId: lotId,
        eventType: 'approve',
        operatorId: userId,
        sizes: cleanSizes,
        parentEventId: null,
        remark: remark ? String(remark).trim() : null,
      });
      // Idempotency: identical take-in seconds ago = double-submit; don't pay
      // the stitcher again.
      if (approveRes.deduped) {
        await conn.commit();
        return res.json({ success: true, deduped: true, event_id: approveRes.eventId, total_pieces: 0 });
      }
      approveEventId = approveRes.eventId;
    }
    if (cleanRejected.length) {
      rejectEventId = (await stageEvents.recordEvent(conn, {
        stage: STAGE_JA,
        cuttingLotId: lotId,
        eventType: 'reject',
        operatorId: userId,
        sizes: cleanRejected,
        parentEventId: null,
        remark: reject_reason ? String(reject_reason).trim() : null,
      })).eventId;
    }

    await conn.commit();

    // Stitching payment fires for taken pieces only — best-effort
    const totalPieces = cleanSizes.reduce((a, s) => a + s.pieces, 0);
    if (totalPieces > 0) {
      try {
        const stitcher = await jaPickStitcherForPayment(pool, lot.lot_no);
        if (stitcher) {
          await createStagePayment('stitching', {
            lot_no: lot.lot_no,
            sku: stitcher.sku || lot.sku,
            qty: totalPieces,
            user_id: stitcher.user_id,
            username: stitcher.username,
          });
        }
      } catch (payErr) {
        console.error('[WARN] /event/approve stitching payment failed:', payErr.message);
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
    console.error('[ERROR] POST /event/approve =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /jeansassemblydashboard/event/complete
// Body: { parent_event_id, completed_sizes, rejected_sizes?, remark?, reject_reason? }
//
// Side effects: dual-writes to jeans_assembly_data + jeans_assembly_data_sizes
// for the COMPLETED pieces so downstream washing's existing queries see the
// completed pieces under their old shape until washing migrates.
router.post('/event/complete', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { parent_event_id, completed_sizes, rejected_sizes, reject_reason, complete_remark } = req.body;

    const parentId = parseInt(parent_event_id, 10);
    if (!Number.isFinite(parentId) || parentId <= 0) {
      return res.status(400).json({ error: 'Invalid parent_event_id' });
    }

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

    const { events, eventSizes } = stageEvents.tablesFor(STAGE_JA);

    const [[parent]] = await conn.query(
      `SELECT id, cutting_lot_id, event_type, pieces, operator_id
       FROM ${events}
       WHERE id = ? FOR UPDATE`,
      [parentId]
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
      `SELECT size_label, pieces FROM ${eventSizes} WHERE event_id = ?`,
      [parentId]
    );
    const parentSizeMap = {};
    for (const r of parentSizesRows) parentSizeMap[r.size_label] = Number(r.pieces) || 0;

    const [childSizesRows] = await conn.query(
      `SELECT s.size_label, e.event_type, SUM(s.pieces) AS pieces
       FROM ${events} e
       JOIN ${eventSizes} s ON s.event_id = e.id
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
      const newComplete = cleanCompleted.filter(s => s.size_label === label).reduce((a, s) => a + s.pieces, 0);
      const newReject = cleanRejected.filter(s => s.size_label === label).reduce((a, s) => a + s.pieces, 0);
      const totalAfter = prev.complete + prev.reject + newComplete + newReject;
      if (totalAfter > approved) {
        await conn.rollback();
        return res.status(400).json({
          error: `Size ${label}: total complete+reject (${totalAfter}) exceeds approved ${approved}`,
        });
      }
    }

    let completeEventId = null;
    let rejectEventId = null;

    if (cleanCompleted.length) {
      const completeRes = await stageEvents.recordEvent(conn, {
        stage: STAGE_JA,
        cuttingLotId: parent.cutting_lot_id,
        eventType: 'complete',
        operatorId: userId,
        sizes: cleanCompleted,
        parentEventId: parentId,
        remark: complete_remark ? String(complete_remark).trim() : null,
      });
      if (completeRes.deduped) {
        await conn.commit();
        return res.json({ success: true, deduped: true, complete_event_id: completeRes.eventId, completed_total: 0 });
      }
      completeEventId = completeRes.eventId;
    }
    if (cleanRejected.length) {
      rejectEventId = (await stageEvents.recordEvent(conn, {
        stage: STAGE_JA,
        cuttingLotId: parent.cutting_lot_id,
        eventType: 'reject',
        operatorId: userId,
        sizes: cleanRejected,
        parentEventId: parentId,
        remark: reject_reason ? String(reject_reason).trim() : null,
      })).eventId;
    }

    // Dual-write to jeans_assembly_data for downstream compatibility
    // (washing reads jeans_assembly_data via lot_no in its existing query).
    if (cleanCompleted.length) {
      const [[lot]] = await conn.query(
        `SELECT lot_no, sku FROM cutting_lots WHERE id = ?`,
        [parent.cutting_lot_id]
      );
      const totalCompleted = cleanCompleted.reduce((a, s) => a + s.pieces, 0);
      const [adResult] = await conn.query(
        `INSERT INTO jeans_assembly_data
           (user_id, lot_no, sku, total_pieces, remark, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [userId, lot.lot_no, lot.sku, totalCompleted, complete_remark || null]
      );
      const adId = adResult.insertId;
      const adSizes = cleanCompleted.map(s => [adId, s.size_label, s.pieces]);
      await conn.query(
        `INSERT INTO jeans_assembly_data_sizes (jeans_assembly_data_id, size_label, pieces) VALUES ?`,
        [adSizes]
      );
    }

    await conn.commit();
    res.json({
      success: true,
      complete_event_id: completeEventId,
      reject_event_id: rejectEventId,
      completed_total: cleanCompleted.reduce((a, s) => a + s.pieces, 0),
      rejected_total: cleanRejected.reduce((a, s) => a + s.pieces, 0),
    });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[ERROR] POST /event/complete =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

router.get('/list-entries', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const limit = 100;

    const [rows] = await pool.query(`
      SELECT ja_data.*,
             cl.manual_lot_number,
             cl.remark AS cutting_remark,
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('size_label', jas.size_label, 'pieces', jas.pieces))
              FROM jeans_assembly_data_sizes jas
              WHERE jas.jeans_assembly_data_id = ja_data.id) AS sizes
      FROM jeans_assembly_data ja_data
      LEFT JOIN cutting_lots cl ON cl.lot_no = ja_data.lot_no
      WHERE ja_data.user_id = ?
        AND (ja_data.lot_no LIKE ? OR ja_data.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
      ORDER BY ja_data.created_at DESC
      LIMIT ?, ?
    `, [userId, search, search, search, search, offset, limit]);

    const hasMore = rows.length === limit;
    return res.json({ data: rows, hasMore });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// ==================================================================
//               SELF-ASSIGNMENT ENDPOINTS
// ==================================================================

/**
 * GET /jeansassemblydashboard/available-lots
 * Search for denim lots available for self-assignment
 * Returns lots that have stitching_data but haven't been fully assembled
 */
router.get('/available-lots', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const { search } = req.query;

    if (!search || search.trim().length < 1) {
      return res.json({ lots: [] });
    }

    const searchLike = `%${search.trim()}%`;

    // Get denim lots that have stitching_data with available sizes for assembly
    const [lots] = await pool.query(`
      SELECT
        sd.id AS stitching_data_id,
        sd.lot_no,
        cl.manual_lot_number,
        sd.sku,
        sd.total_pieces AS stitched_total,
        sd.created_at AS stitch_date,
        cl.remark AS cutting_remark,
        u.username AS stitching_master
      FROM stitching_data sd
      JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
      JOIN users u ON sd.user_id = u.id
      JOIN users cu ON cl.user_id = cu.id
      WHERE (sd.lot_no LIKE ? OR sd.sku LIKE ? OR cl.remark LIKE ? OR cl.manual_lot_number LIKE ?)
        AND (cl.flow_type = 'denim' OR (cl.flow_type IS NULL AND cu.is_denim_cutter = 1) OR (cl.flow_type IS NULL AND cu.is_denim_cutter IS NULL AND (sd.lot_no LIKE 'AK%' OR sd.lot_no LIKE 'UM%')))
        AND EXISTS (
          SELECT 1 FROM stitching_data_sizes sds
          WHERE sds.stitching_data_id = sd.id
            AND sds.pieces > COALESCE((
              SELECT SUM(jads.pieces) FROM jeans_assembly_data jad
              JOIN jeans_assembly_data_sizes jads ON jads.jeans_assembly_data_id = jad.id
              WHERE jad.lot_no = sd.lot_no AND jads.size_label = sds.size_label
            ), 0)
        )
      ORDER BY sd.created_at DESC
      LIMIT 10
    `, [searchLike, searchLike, searchLike, searchLike]);

    // For each lot, get size details
    for (const lot of lots) {
      const [sizes] = await pool.query(`
        SELECT
          sds.id,
          sds.size_label,
          sds.pieces AS stitched_qty,
          COALESCE((
            SELECT SUM(jads.pieces) FROM jeans_assembly_data jad
            JOIN jeans_assembly_data_sizes jads ON jads.jeans_assembly_data_id = jad.id
            WHERE jad.lot_no = ? AND jads.size_label = sds.size_label
          ), 0) AS assembled_qty,
          sds.pieces - COALESCE((
            SELECT SUM(jads.pieces) FROM jeans_assembly_data jad
            JOIN jeans_assembly_data_sizes jads ON jads.jeans_assembly_data_id = jad.id
            WHERE jad.lot_no = ? AND jads.size_label = sds.size_label
          ), 0) AS available_qty
        FROM stitching_data_sizes sds
        WHERE sds.stitching_data_id = ?
        HAVING available_qty > 0
        ORDER BY FIELD(sds.size_label, 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', '6XL', '26', '28', '30', '32', '34', '36'), sds.size_label
      `, [lot.lot_no, lot.lot_no, lot.stitching_data_id]);

      lot.sizes = sizes.map(s => ({
        id: s.id,
        size_label: s.size_label,
        pieces: Number(s.stitched_qty),
        remain: Number(s.available_qty)
      }));
    }

    return res.json({ lots });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/available-lots =>', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /jeansassemblydashboard/submit
 * Self-assign and complete assembly in one step
 * Creates jeans_assembly_assignments (auto-approved) + jeans_assembly_data
 */
router.post('/submit', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = req.session.user.id;
    const username = req.session.user.username;
    const { selectedLotId, remark } = req.body;
    const sizesObj = req.body.sizes || {};

    if (!selectedLotId) {
      return res.status(400).json({ error: 'Missing lot selection' });
    }

    // Calculate total from sizes object {sizeId: qty}
    let grandTotal = 0;
    for (const sizeId of Object.keys(sizesObj)) {
      const qty = parseInt(sizesObj[sizeId], 10);
      if (!isNaN(qty) && qty > 0) grandTotal += qty;
    }
    if (grandTotal <= 0) {
      return res.status(400).json({ error: 'No pieces requested' });
    }

    await conn.beginTransaction();

    // Get stitching data details
    const [[sd]] = await conn.query(`
      SELECT sd.*, u.username AS stitching_master, cl.remark AS cutting_remark
      FROM stitching_data sd
      JOIN users u ON sd.user_id = u.id
      LEFT JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
      WHERE sd.id = ?
      FOR UPDATE
    `, [selectedLotId]);

    if (!sd) {
      await conn.rollback();
      return res.status(404).json({ error: 'Stitching data not found' });
    }

    // Get size details from IDs
    const sizeIds = Object.keys(sizesObj).map(id => parseInt(id, 10)).filter(Boolean);
    const [sizeRows] = await conn.query(
      `SELECT id, size_label, pieces FROM stitching_data_sizes WHERE id IN (?)`,
      [sizeIds.length ? sizeIds : [0]]
    );
    const sizeMap = {};
    for (const row of sizeRows) sizeMap[row.id] = row;

    // Get already used quantities
    const sizeLabels = sizeRows.map(r => r.size_label);
    const [usedRows] = await conn.query(
      `SELECT jads.size_label, COALESCE(SUM(jads.pieces), 0) AS usedCount
       FROM jeans_assembly_data_sizes jads
       JOIN jeans_assembly_data jad ON jads.jeans_assembly_data_id = jad.id
       WHERE jad.lot_no = ? AND jads.size_label IN (?)
       GROUP BY jads.size_label`,
      [sd.lot_no, sizeLabels.length ? sizeLabels : ['']]
    );
    const usedMap = {};
    for (const row of usedRows) usedMap[row.size_label] = row.usedCount;

    // Validate each size
    const validSizes = [];
    for (const sizeId of sizeIds) {
      const row = sizeMap[sizeId];
      if (!row) continue;
      const requested = parseInt(sizesObj[sizeId], 10) || 0;
      if (requested === 0) continue;
      const used = usedMap[row.size_label] || 0;
      const remain = row.pieces - used;
      if (requested > remain) {
        await conn.rollback();
        return res.status(400).json({
          error: `Requested ${requested} for ${row.size_label}, but only ${remain} remain.`
        });
      }
      validSizes.push({ size_label: row.size_label, qty: requested });
    }

    // 1. Create jeans_assembly_assignments record (auto-approved)
    const sizesJson = JSON.stringify(validSizes.map(s => ({ size: s.size_label, qty: s.qty })));
    const [assignResult] = await conn.query(`
      INSERT INTO jeans_assembly_assignments
        (stitching_master_id, user_id, stitching_assignment_id, sizes_json, is_approved, assigned_on)
      VALUES (?, ?, ?, ?, 1, NOW())
    `, [sd.user_id, userId, sd.id, sizesJson]);

    // 2. Create jeans_assembly_data record
    const totalPieces = validSizes.reduce((sum, s) => sum + s.qty, 0);
    const [dataResult] = await conn.query(`
      INSERT INTO jeans_assembly_data (user_id, lot_no, sku, total_pieces, remark, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [userId, sd.lot_no, sd.sku, totalPieces, remark || null]);

    const assemblyDataId = dataResult.insertId;

    // 3. Create jeans_assembly_data_sizes records
    for (const s of validSizes) {
      await conn.query(`
        INSERT INTO jeans_assembly_data_sizes (jeans_assembly_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [assemblyDataId, s.size_label, s.qty]);
    }

    await conn.commit();

    // Auto-create stitching payment
    try {
      await createStagePayment('stitching', {
        lot_no: sd.lot_no,
        sku: sd.sku,
        qty: totalPieces,
        user_id: sd.user_id,
        username: sd.stitching_master
      });
    } catch (payErr) {
      console.error('[WARN] Failed to create stitching payment:', payErr.message);
    }

    return res.json({
      success: true,
      message: `Assembly completed: ${totalPieces} pieces`,
      jeans_assembly_data_id: assemblyDataId
    });

  } catch (err) {
    await conn.rollback();
    console.error('[ERROR] POST /jeansassemblydashboard/submit =>', err);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET /jeansassemblydashboard/my-today
router.get('/my-today', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [rows] = await pool.query(`
      SELECT id, lot_no, sku, total_pieces, created_at
      FROM jeans_assembly_data
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

// GET /jeansassemblydashboard/my-entries
router.get('/my-entries', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset) || 0;
    const limit = 20;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = `
      SELECT jad.id, jad.lot_no, jad.sku, jad.total_pieces, jad.created_at, cl.remark as cutting_remark
      FROM jeans_assembly_data jad
      LEFT JOIN cutting_lots cl ON jad.lot_no = cl.lot_no
      WHERE jad.user_id = ? AND (jad.lot_no LIKE ? OR jad.sku LIKE ?)
    `;
    const params = [userId, search, search];

    if (startDate) {
      query += ` AND DATE(jad.created_at) >= ?`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND DATE(jad.created_at) <= ?`;
      params.push(endDate);
    }

    query += ` ORDER BY jad.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await pool.query(query, params);

    return res.json({ entries: rows });
  } catch (err) {
    console.error('[ERROR] GET /my-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /jeansassemblydashboard/lot-details/:lotNo
router.get('/lot-details/:lotNo', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
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

    const [[assemblyData]] = await pool.query(`
      SELECT jad.*, u.username as assembly_master_name
      FROM jeans_assembly_data jad
      LEFT JOIN users u ON jad.user_id = u.id
      WHERE jad.lot_no = ? AND jad.user_id = ?
    `, [lotNo, userId]);

    let assemblySizes = [];
    if (assemblyData) {
      const [sizes] = await pool.query(`
        SELECT size_label, pieces FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = ?
      `, [assemblyData.id]);
      assemblySizes = sizes;
    }

    const [[paymentInfo]] = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) as total_paid, COUNT(*) as payment_count
      FROM stage_payments
      WHERE user_id = ? AND lot_no = ? AND stage = 'jeans_assembly' AND status = 'approved'
    `, [userId, lotNo]);

    const [[pendingPayment]] = await pool.query(`
      SELECT COALESCE(SUM(total_amount), 0) as pending_amount
      FROM stage_payments
      WHERE user_id = ? AND lot_no = ? AND stage = 'jeans_assembly' AND status = 'pending'
    `, [userId, lotNo]);

    const totalCutPieces = cuttingSizes.reduce((sum, s) => sum + (s.pieces || 0), 0);
    const totalAssembledPieces = assemblySizes.reduce((sum, s) => sum + (s.pieces || 0), 0);

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
      assembly: {
        data_id: assemblyData?.id,
        sizes: assemblySizes,
        total_pieces: totalAssembledPieces,
        pending_pieces: totalCutPieces - totalAssembledPieces,
        created_at: assemblyData?.created_at
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

// GET /jeansassemblydashboard/history-download
router.get('/history-download', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let query = `
      SELECT jad.lot_no, jad.sku, jad.total_pieces, jad.created_at,
             cl.remark as cutting_remark, cl.fabric_type,
             COALESCE(pay.total_paid, 0) as total_paid
      FROM jeans_assembly_data jad
      LEFT JOIN cutting_lots cl ON jad.lot_no = cl.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_amount) as total_paid
        FROM stage_payments WHERE user_id = ? AND stage = 'jeans_assembly' AND status = 'approved'
        GROUP BY lot_no
      ) pay ON jad.lot_no = pay.lot_no
      WHERE jad.user_id = ?
    `;
    const params = [userId, userId];

    if (startDate) { query += ` AND DATE(jad.created_at) >= ?`; params.push(startDate); }
    if (endDate) { query += ` AND DATE(jad.created_at) <= ?`; params.push(endDate); }
    query += ` ORDER BY jad.created_at DESC`;

    const [rows] = await pool.query(query, params);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Jeans Assembly History');

    sheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Pieces', key: 'total_pieces', width: 10 },
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
        cutting_remark: row.cutting_remark || '-',
        fabric_type: row.fabric_type || '-',
        total_paid: row.total_paid,
        created_at: row.created_at ? new Date(row.created_at).toLocaleDateString('en-IN') : '-'
      });
    });

    const filename = `jeans_assembly_history_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /history-download =>', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
