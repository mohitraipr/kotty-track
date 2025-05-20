// routes/jeansAssemblyRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isJeansAssemblyMaster } = require('../middlewares/auth');

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
const upload = multer({ storage });

// ------------------------------------------------------------------
// 1) GET /jeansassemblydashboard
//    Renders the main "Jeans Assembly Dashboard" with lots & washers
// ------------------------------------------------------------------
router.get('/', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 1) Fetch un-used lots (approved for the user but not used in jeans_assembly_data)
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

    // 2) Fetch washers (active users with role "washing")
    const [washers] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'washing'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);

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
    console.error('[ERROR] GET /jeansassemblydashboard =>', err);
    req.flash('error', 'Cannot load jeans assembly dashboard data.');
    return res.redirect('/');
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

      // 3) Validate each size piece count
      let grandTotal = 0;
      for (const sizeId of Object.keys(sizesObj)) {
        const requested = parseInt(sizesObj[sizeId], 10) || 0;
        if (requested < 0) {
          req.flash('error', 'Invalid negative pieces');
          await conn.rollback();
          conn.release();
          return res.redirect('/jeansassemblydashboard');
        }
        if (requested === 0) continue;

        // Check that stitching_data_sizes row exists
        const [[sds]] = await conn.query(`
          SELECT *
          FROM stitching_data_sizes
          WHERE id = ?
        `, [sizeId]);
        if (!sds) {
          req.flash('error', 'Bad size reference: ' + sizeId);
          await conn.rollback();
          conn.release();
          return res.redirect('/jeansassemblydashboard');
        }

        // Check how many have already been used in previous Jeans Assembly
        const [[usedRow]] = await conn.query(`
          SELECT COALESCE(SUM(jds.pieces),0) AS usedCount
          FROM jeans_assembly_data_sizes jds
          JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
          WHERE jd.lot_no = ?
            AND jds.size_label = ?
        `, [sd.lot_no, sds.size_label]);

        const used = usedRow.usedCount || 0;
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

      // 5) Insert each size
      for (const sizeId of Object.keys(sizesObj)) {
        const requested = parseInt(sizesObj[sizeId], 10) || 0;
        if (requested > 0) {
          // Need the size_label from stitching_data_sizes
          const [[sds]] = await conn.query(`
            SELECT * FROM stitching_data_sizes
            WHERE id = ?
          `, [sizeId]);

          await conn.query(`
            INSERT INTO jeans_assembly_data_sizes
              (jeans_assembly_data_id, size_label, pieces, created_at)
            VALUES (?, ?, ?, NOW())
          `, [newAssemblyId, sds.size_label, requested]);
        }
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

    // Fetch sizes for that lot
    const [sizes] = await pool.query(`
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
    `, [lotId]);

    // Calculate how many remain
    const results = [];
    for (const size of sizes) {
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(jds.pieces),0) AS usedCount
        FROM jeans_assembly_data_sizes jds
        JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
        WHERE jd.lot_no = ?
          AND jds.size_label = ?
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

    // gather the total pieces from stitching_data_sizes
    const [sdSizes] = await pool.query(`
      SELECT size_label, pieces
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
    `, [sd.id]);

    const sdMap = {};
    sdSizes.forEach(r => { sdMap[r.size_label] = r.pieces; });

    const output = [];
    for (const sz of sizes) {
      const totalDept = sdMap[sz.size_label] || 0;
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(jds.pieces),0) AS usedCount
        FROM jeans_assembly_data_sizes jds
        JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
        WHERE jd.lot_no = ? AND jds.size_label = ?
      `, [entry.lot_no, sz.size_label]);

      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;
      output.push({ ...sz, remain: remain < 0 ? 0 : remain });
    }

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

    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;

      // check remain
      const totalDept = sdMap[lbl] || 0;
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(jds.pieces),0) AS usedCount
        FROM jeans_assembly_data_sizes jds
        JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
        WHERE jd.lot_no = ? AND jds.size_label = ?
      `, [entry.lot_no, lbl]);
      const used = usedRow.usedCount || 0;
      const remain = totalDept - used;
      if (increment > remain) {
        throw new Error(`Cannot add ${increment} for [${lbl}]; only ${remain} remain.`);
      }

      // Insert or update that size row
      const [[existing]] = await conn.query(`
        SELECT *
        FROM jeans_assembly_data_sizes
        WHERE jeans_assembly_data_id = ? AND size_label = ?
      `, [entryId, lbl]);

      if (!existing) {
        await conn.query(`
          INSERT INTO jeans_assembly_data_sizes
            (jeans_assembly_data_id, size_label, pieces, created_at)
          VALUES (?, ?, ?, NOW())
        `, [entryId, lbl, increment]);
        updatedTotal += increment;
      } else {
        const newCount = existing.pieces + increment;
        await conn.query(`
          UPDATE jeans_assembly_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newCount, existing.id]);
        updatedTotal += increment;
      }

      // Log the update
      await conn.query(`
        INSERT INTO jeans_assembly_data_updates
          (jeans_assembly_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
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
      SELECT *
      FROM jeans_assembly_data
      WHERE id = ? AND user_id = ?
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

    await pool.query(`
      UPDATE jeans_assembly_assignments
      SET is_approved = 1,approved_on = NOW(),
          assignment_remark = ?
      WHERE id = ?
        AND user_id = ?
    `, [remark, assignment_id, userId]);

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

router.get('/list-entries', isAuthenticated, isJeansAssemblyMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const limit = 100;

    const [rows] = await pool.query(`
      SELECT ja_data.*,
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('size_label', jas.size_label, 'pieces', jas.pieces))
              FROM jeans_assembly_data_sizes jas
              WHERE jas.jeans_assembly_data_id = ja_data.id) AS sizes
      FROM jeans_assembly_data ja_data
      WHERE ja_data.user_id = ?
        AND (ja_data.lot_no LIKE ? OR ja_data.sku LIKE ?)
      ORDER BY ja_data.created_at DESC
      LIMIT ?, ?
    `, [userId, search, search, offset, limit]);

    const hasMore = rows.length === limit;
    return res.json({ data: rows, hasMore });
  } catch (err) {
    console.error('[ERROR] GET /jeansassemblydashboard/list-entries =>', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
