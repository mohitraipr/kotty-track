// routes/finishingRoutes.js

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isFinishingMaster } = require('../middlewares/auth');

// ------------------------------------
// MULTER CONFIG FOR IMAGE UPLOAD
// ------------------------------------
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

// ------------------------------------
// GET /finishingdashboard
// Show lots assigned (finishing_assignments) that are not used in finishing_data
// ------------------------------------
router.get('/', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // finishing_assignments references stitching_assignment_id or washing_assignment_id
    // we find the cutting lot from that chain, exclude if finishing_data already exists
    const [lots] = await pool.query(`
      SELECT c.id, c.lot_no, c.sku, c.total_pieces
      FROM finishing_assignments fa
      LEFT JOIN stitching_assignments sa ON fa.stitching_assignment_id = sa.id
      LEFT JOIN washing_assignments wa ON fa.washing_assignment_id = wa.id
      LEFT JOIN stitching_assignments sa2 ON wa.stitching_assignment_id = sa2.id
      LEFT JOIN cutting_lots c
        ON c.id = sa.cutting_lot_id
        OR c.id = sa2.cutting_lot_id
      WHERE fa.user_id = ?
        AND c.lot_no NOT IN (SELECT lot_no FROM finishing_data)
      ORDER BY c.created_at DESC
      LIMIT 10
    `, [userId]);

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    return res.render('finishingDashboard', {
      user: req.session.user,
      lots,
      error: errorMessages,
      success: successMessages
    });
  } catch (err) {
    console.error('Error loading finishing dashboard:', err);
    req.flash('error', 'Cannot load finishing dashboard data.');
    return res.redirect('/');
  }
});

// ------------------------------------
// GET /finishingdashboard/list-entries
// Paginated listing of finishing_data
// ------------------------------------
router.get('/list-entries', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    const limit = 5;
    const searchLike = `%${searchTerm}%`;

    const [rows] = await pool.query(`
      SELECT *
      FROM finishing_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, searchLike, searchLike, limit, offset]);

    if (!rows || rows.length === 0) {
      return res.json({ data: [], hasMore: false });
    }

    const ids = rows.map(r => r.id);
    const [sizeRows] = await pool.query(`
      SELECT *
      FROM finishing_data_sizes
      WHERE finishing_data_id IN (?)
    `, [ids]);

    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.finishing_data_id]) {
        sizesMap[s.finishing_data_id] = [];
      }
      sizesMap[s.finishing_data_id].push(s);
    });

    const dataOut = rows.map(r => ({
      ...r,
      sizes: sizesMap[r.id] || []
    }));

    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) as totalCount
      FROM finishing_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
    `, [userId, searchLike, searchLike]);

    const hasMore = offset + rows.length < totalCount;
    return res.json({ data: dataOut, hasMore });
  } catch (err) {
    console.error('Error finishing list-entries:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------
// GET /finishingdashboard/get-lot-sizes/:lotId
// Fetch sizes from STITCHING_DATA instead of cutting_lot_sizes
// ------------------------------------
router.get('/get-lot-sizes/:lotId', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;

    // 1. Fetch the lot row from cutting_lots (we still need the lot_no)
    const [[lot]] = await pool.query(`
      SELECT *
      FROM cutting_lots
      WHERE id = ?
    `, [lotId]);

    if (!lot) {
      return res.status(404).json({ error: 'Lot not found.' });
    }

    // 2. Find the matching stitching_data row by lot_no
    const [[stitchData]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      ORDER BY id DESC
      LIMIT 1
    `, [lot.lot_no]);

    if (!stitchData) {
      return res.status(404).json({ error: 'No stitching data found for this lot.' });
    }

    // 3. Get the stitching_data_sizes for that stitching_data.id
    const [stSizes] = await pool.query(`
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
      ORDER BY id ASC
    `, [stitchData.id]);

    // 4. Calculate remain = total from stitching - used in finishing
    const output = [];
    for (const s of stSizes) {
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(fds.pieces),0) as usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [lot.lot_no, s.size_label]);

      const used = usedRow.usedCount || 0;
      const remain = s.pieces - used;

      output.push({
        id: s.id,               // PK of stitching_data_sizes
        size_label: s.size_label,
        total_pieces: s.pieces, // how many were stitched
        used,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json(output);
  } catch (err) {
    console.error('Error finishing get-lot-sizes:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------
// POST /finishingdashboard/create
// Create finishing_data entry using stitching_data_sizes
// ------------------------------------
router.post('/create', isAuthenticated, isFinishingMaster, upload.single('image_file'), async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const { selectedLotId, remark } = req.body;
    let image_url = null;
    if (req.file) {
      image_url = '/uploads/' + req.file.filename;
    }

    const sizesObj = req.body.sizes || {};
    if (!Object.keys(sizesObj).length) {
      req.flash('error', 'No size data provided.');
      return res.redirect('/finishingdashboard');
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1. Confirm the lot
    const [[lot]] = await conn.query(`
      SELECT *
      FROM cutting_lots
      WHERE id = ?
    `, [selectedLotId]);
    if (!lot) {
      req.flash('error', 'Invalid lot selected.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // 2. Find matching stitching_data by lot_no
    const [[stitchData]] = await conn.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      ORDER BY id DESC
      LIMIT 1
    `, [lot.lot_no]);

    if (!stitchData) {
      req.flash('error', 'No stitching_data found for this lot.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // 3. Check if finishing_data for this lot_no already exists
    const [[already]] = await conn.query(`
      SELECT id
      FROM finishing_data
      WHERE lot_no = ?
    `, [lot.lot_no]);
    if (already) {
      req.flash('error', `Lot ${lot.lot_no} already used for finishing.`);
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    let grandTotal = 0;

    // 4. Validate size inputs against stitching_data_sizes
    for (const sizeId of Object.keys(sizesObj)) {
      const requestedPieces = parseInt(sizesObj[sizeId], 10);
      if (isNaN(requestedPieces) || requestedPieces < 0) {
        req.flash('error', 'Invalid piece count');
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }
      if (requestedPieces === 0) continue;

      // fetch from stitching_data_sizes
      const [[sdSize]] = await conn.query(`
        SELECT *
        FROM stitching_data_sizes
        WHERE id = ?
      `, [sizeId]);

      if (!sdSize) {
        req.flash('error', 'Bad size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }

      // check how many used so far in finishing
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(fds.pieces),0) as usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [lot.lot_no, sdSize.size_label]);

      const used = usedRow.usedCount || 0;
      const remain = sdSize.pieces - used;
      if (requestedPieces > remain) {
        req.flash(
          'error',
          `Cannot create finishing: requested ${requestedPieces} but only ${remain} remain for size ${sdSize.size_label}.`
        );
        await conn.rollback();
        conn.release();
        return res.redirect('/finishingdashboard');
      }

      grandTotal += requestedPieces;
    }

    if (grandTotal <= 0) {
      req.flash('error', 'No pieces > 0 provided.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    // 5. Insert finishing_data
    const [main] = await conn.query(`
      INSERT INTO finishing_data
        (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, lot.lot_no, lot.sku, grandTotal, remark || null, image_url]);
    const newId = main.insertId;

    // 6. Insert finishing_data_sizes
    for (const sizeId of Object.keys(sizesObj)) {
      const requestedPieces = parseInt(sizesObj[sizeId], 10) || 0;
      if (requestedPieces <= 0) continue;

      const [[sdSize]] = await conn.query(`
        SELECT *
        FROM stitching_data_sizes
        WHERE id = ?
      `, [sizeId]);

      await conn.query(`
        INSERT INTO finishing_data_sizes (finishing_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [newId, sdSize.size_label, requestedPieces]);
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

// ------------------------------------
// GET /finishingdashboard/update/:id/json
// Return existing finishing_data_sizes and how many remain (based on stitching_data_sizes)
// ------------------------------------
router.get('/update/:id/json', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    const [[entry]] = await pool.query(`
      SELECT *
      FROM finishing_data
      WHERE id = ?
        AND user_id = ?
    `, [entryId, userId]);
    if (!entry) {
      return res.status(403).json({ error: 'Not found or no permission' });
    }

    const [sizes] = await pool.query(`
      SELECT *
      FROM finishing_data_sizes
      WHERE finishing_data_id = ?
    `, [entryId]);

    // To compute remain properly, look up the matching stitching_data
    const [[stitchData]] = await pool.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      ORDER BY id DESC
      LIMIT 1
    `, [entry.lot_no]);

    if (!stitchData) {
      // If there's no stitching data, we can't compute remain.
      // Return sizes but remain is unknown or 0
      return res.json({
        sizes: sizes.map(sz => ({
          ...sz,
          remain: 0
        }))
      });
    }

    // Get all stitching_data_sizes for that record
    const [stSizes] = await pool.query(`
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
    `, [stitchData.id]);

    // Make a quick map of size_label -> total pieces
    const stMap = {};
    for (const s of stSizes) {
      stMap[s.size_label] = s.pieces;
    }

    const output = [];
    for (const sz of sizes) {
      const totalStitched = stMap[sz.size_label] || 0;

      // How many used so far in finishing (for all finishing_data)?
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(fds.pieces),0) as usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [entry.lot_no, sz.size_label]);

      const used = usedRow.usedCount || 0;
      const remain = totalStitched - used;

      output.push({
        ...sz,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json({ sizes: output });
  } catch (err) {
    console.error('Error finishing update JSON:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------
// POST /finishingdashboard/update/:id
// Update finishing data pieces with reference to stitching_data_sizes
// ------------------------------------
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

    // Find matching stitching_data for lot_no
    const [[stitchData]] = await conn.query(`
      SELECT *
      FROM stitching_data
      WHERE lot_no = ?
      ORDER BY id DESC
      LIMIT 1
    `, [entry.lot_no]);

    if (!stitchData) {
      req.flash('error', 'No stitching data found for this lot.');
      await conn.rollback();
      conn.release();
      return res.redirect('/finishingdashboard');
    }

    let updatedTotal = entry.total_pieces;

    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      if (isNaN(increment) || increment < 0) increment = 0;
      if (increment === 0) continue;

      // Check if finishing_data_sizes row already exists for that label
      const [[existingRow]] = await conn.query(`
        SELECT *
        FROM finishing_data_sizes
        WHERE finishing_data_id = ?
          AND size_label = ?
      `, [entryId, lbl]);

      // Query stitching_data_sizes to see how many pieces exist for that label
      const [[stSize]] = await conn.query(`
        SELECT *
        FROM stitching_data_sizes
        WHERE stitching_data_id = ?
          AND size_label = ?
      `, [stitchData.id, lbl]);

      if (!stSize) {
        throw new Error(`Size label ${lbl} not found in stitching_data_sizes`);
      }

      // How many of that label are already used in *all* finishing_data for this lot?
      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(fds.pieces),0) as usedCount
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fd.id = fds.finishing_data_id
        WHERE fd.lot_no = ?
          AND fds.size_label = ?
      `, [entry.lot_no, lbl]);

      const used = usedRow.usedCount || 0;
      const remain = stSize.pieces - used;
      if (increment > remain) {
        throw new Error(`Cannot add ${increment} for [${lbl}] because only ${remain} remain.`);
      }

      if (!existingRow) {
        // Create new finishing_data_sizes row
        await conn.query(`
          INSERT INTO finishing_data_sizes (finishing_data_id, size_label, pieces)
          VALUES (?, ?, ?)
        `, [entryId, lbl, increment]);

        updatedTotal += increment;
      } else {
        // Update existing row
        const newPieceCount = existingRow.pieces + increment;
        await conn.query(`
          UPDATE finishing_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newPieceCount, existingRow.id]);

        updatedTotal += increment;
      }

      // Log each increment in finishing_data_updates
      await conn.query(`
        INSERT INTO finishing_data_updates
          (finishing_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
    }

    // Update main finishing_data total
    await conn.query(`
      UPDATE finishing_data
      SET total_pieces = ?
      WHERE id = ?
    `, [updatedTotal, entryId]);

    await conn.commit();
    conn.release();

    req.flash('success', 'Finishing data updated successfully!');
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

// ------------------------------------
// GET /finishingdashboard/challan/:id
// Render finishingChallan view
// ------------------------------------
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

    res.render('finishingChallan', {
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

// ------------------------------------
// GET /finishingdashboard/download-all
// Export finishing_data and finishing_data_sizes to Excel
// ------------------------------------
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
      { header: 'Pieces', key: 'pieces', width: 8 }
    ];
    allSizes.forEach(s => {
      sizesSheet.addRow({
        id: s.id,
        finishing_data_id: s.finishing_data_id,
        size_label: s.size_label,
        pieces: s.pieces
      });
    });

    res.setHeader('Content-Disposition', 'attachment; filename="FinishingData.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error finishing download-all:', err);
    req.flash('error', 'Could not download finishing Excel: ' + err.message);
    return res.redirect('/finishingdashboard');
  }
});

module.exports = router;
