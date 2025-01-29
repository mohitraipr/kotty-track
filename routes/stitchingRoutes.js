// routes/stitchingRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isStitchingMaster } = require('../middlewares/auth');

// MULTER SETUP FOR IMAGE UPLOAD
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

/**
 * GET /stitchingdashboard
 * Renders the main stitching dashboard.
 * We only show lots that have not yet been used in stitching_data,
 * ensuring "once a lot no. entry has been created, it shouldn't be available again."
 */
router.get('/', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Only those cutting lots that do NOT appear in stitching_data (by lot_no).
    // Also joined with stitching_assignments so we only get lots assigned to this user.
    const [lots] = await pool.query(
      `
      SELECT c.id, c.lot_no, c.sku, c.total_pieces
      FROM cutting_lots c
      JOIN stitching_assignments ula ON ula.cutting_lot_id = c.id
      WHERE ula.user_id = ?
        AND c.lot_no NOT IN (
          SELECT lot_no FROM stitching_data
        )
      ORDER BY c.created_at DESC
      LIMIT 10
      `,
      [userId]
    );

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    return res.render('stitchingDashboard', {
      user: req.session.user,
      lots, // We'll pass the "unused" lots for the dropdown
      error: errorMessages,    // arrays
      success: successMessages // arrays
    });
  } catch (err) {
    console.error('Error loading dashboard:', err);
    req.flash('error', 'Cannot load dashboard data.');
    return res.redirect('/');
  }
});

/**
 * GET /stitchingdashboard/list-entries
 * For lazy-loading existing stitching_data entries with optional search.
 */
router.get('/list-entries', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    const limit = 5;
    const searchLike = `%${searchTerm}%`;

    // Fetch a chunk of stitching_data
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

    // If no data, return empty
    if (!rows || rows.length === 0) {
      return res.json({ data: [], hasMore: false });
    }

    // Gather stitching_data_sizes for these rows
    const entryIds = rows.map(r => r.id);
    const [sizeRows] = await pool.query(
      `
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id IN (?)
      `,
      [entryIds]
    );

    // Group sizes by stitching_data_id
    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.stitching_data_id]) {
        sizesMap[s.stitching_data_id] = [];
      }
      sizesMap[s.stitching_data_id].push(s);
    });

    // Attach sizes
    const resultData = rows.map(r => ({
      ...r,
      sizes: sizesMap[r.id] || []
    }));

    // Check if more data remains
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
    console.error('Error fetching lazy entries:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /stitchingdashboard/get-lot-sizes/:lotId
 * Returns JSON of sizes & remain for a given lotId.
 */
router.get('/get-lot-sizes/:lotId', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;

    const [[lot]] = await pool.query(
      `SELECT * FROM cutting_lots WHERE id = ?`,
      [lotId]
    );
    if (!lot) {
      return res.status(404).json({ error: 'Lot not found' });
    }

    // All size rows for this lot
    const [lotSizes] = await pool.query(
      `
      SELECT *
      FROM cutting_lot_sizes
      WHERE cutting_lot_id = ?
      ORDER BY id ASC
      `,
      [lotId]
    );

    // Calculate remain for each size
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
    console.error('Error fetching lot sizes:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /stitchingdashboard/create
 * Creates a new stitching entry; after creation, that lot_no is considered "used."
 */
router.post(
  '/create',
  isAuthenticated,
  isStitchingMaster,
  upload.single('image_file'),
  async (req, res) => {
    let conn;
    try {
      const userId = req.session.user.id;
      const { selectedLotId, remark } = req.body;

      // Handle uploaded file (if any)
      let image_url = null;
      if (req.file) {
        image_url = '/uploads/' + req.file.filename;
      }

      // The sizes object: { sizeId: pieceCount, ... }
      const sizesObj = req.body.sizes || {};
      if (!Object.keys(sizesObj).length) {
        req.flash('error', 'No size data provided.');
        return res.redirect('/stitchingdashboard');
      }

      conn = await pool.getConnection();
      await conn.beginTransaction();

      // Validate the chosen lot
      const [[lot]] = await conn.query(
        `SELECT * FROM cutting_lots WHERE id = ?`,
        [selectedLotId]
      );
      if (!lot) {
        req.flash('error', 'Invalid or no lot selected.');
        await conn.rollback();
        conn.release();
        return res.redirect('/stitchingdashboard');
      }

      // Double-check if this lot_no is already used in stitching_data
      const [[alreadyUsed]] = await conn.query(
        `SELECT id FROM stitching_data WHERE lot_no = ?`,
        [lot.lot_no]
      );
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

        // The cutting_lot_sizes row for this size
        const [[cls]] = await conn.query(
          `SELECT * FROM cutting_lot_sizes WHERE id = ?`,
          [sizeId]
        );
        if (!cls) {
          req.flash('error', 'Invalid size reference: ' + sizeId);
          await conn.rollback();
          conn.release();
          return res.redirect('/stitchingdashboard');
        }

        // Already used in other stitching_data
        const [[usedRow]] = await conn.query(
          `
          SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
          FROM stitching_data_sizes sds
          JOIN stitching_data sd ON sds.stitching_data_id = sd.id
          WHERE sd.lot_no = ?
            AND sds.size_label = ?
          `,
          [lot.lot_no, cls.size_label]
        );
        const used = usedRow.usedCount || 0;
        const remain = cls.total_pieces - used;
        if (userCount > remain) {
          req.flash(
            'error',
            `Cannot create: you requested ${userCount} for size [${cls.size_label}] but only ${remain} remain.`
          );
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

      // Insert into stitching_data
      const [main] = await conn.query(
        `
        INSERT INTO stitching_data
          (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
        `,
        [userId, lot.lot_no, lot.sku, grandTotal, remark || null, image_url]
      );
      const newId = main.insertId;

      // Insert each size row
      for (const sizeId of Object.keys(sizesObj)) {
        const countVal = parseInt(sizesObj[sizeId], 10) || 0;
        if (countVal <= 0) continue;

        const [[cls]] = await conn.query(
          `SELECT * FROM cutting_lot_sizes WHERE id = ?`,
          [sizeId]
        );
        await conn.query(
          `
          INSERT INTO stitching_data_sizes
            (stitching_data_id, size_label, pieces)
          VALUES (?, ?, ?)
          `,
          [newId, cls.size_label, countVal]
        );
      }

      await conn.commit();
      conn.release();
      req.flash('success', 'Stitching entry created successfully!');
      return res.redirect('/stitchingdashboard');
    } catch (err) {
      console.error('Error creating stitching data:', err);
      if (conn) {
        await conn.rollback();
        conn.release();
      }
      req.flash('error', 'Error creating data: ' + err.message);
      return res.redirect('/stitchingdashboard');
    }
  }
);

/**
 * GET /stitchingdashboard/update/:id/json
 * Return info about existing sizes to help the update modal.
 */
router.get('/update/:id/json', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    const [[entry]] = await pool.query(
      `
      SELECT *
      FROM stitching_data
      WHERE id = ?
        AND user_id = ?
      `,
      [entryId, userId]
    );
    if (!entry) {
      return res.status(403).json({ error: 'No permission or not found' });
    }

    // Current stitching_data_sizes rows for this entry
    const [sizes] = await pool.query(
      `
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
      ORDER BY id ASC
      `,
      [entryId]
    );

    // For each size, figure out how many remain if we add more
    const output = [];
    for (const sz of sizes) {
      // Find the corresponding cutting_lot_sizes row
      const [[cls]] = await pool.query(
        `
        SELECT *
        FROM cutting_lot_sizes
        WHERE cutting_lot_id = (
          SELECT id
          FROM cutting_lots
          WHERE lot_no = ?
          LIMIT 1
        )
          AND size_label = ?
        `,
        [entry.lot_no, sz.size_label]
      );
      if (!cls) {
        // fallback large remain
        output.push({
          ...sz,
          remain: 99999
        });
        continue;
      }

      // Globally used
      const [[usedRow]] = await pool.query(
        `
        SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
        FROM stitching_data_sizes sds
        JOIN stitching_data sd ON sds.stitching_data_id = sd.id
        WHERE sd.lot_no = ?
          AND sds.size_label = ?
        `,
        [entry.lot_no, cls.size_label]
      );
      const used = usedRow.usedCount || 0;
      const totalInLot = cls.total_pieces;
      const remainNow = totalInLot - used;

      output.push({
        ...sz,
        remain: remainNow < 0 ? 0 : remainNow
      });
    }
    return res.json({ sizes: output });
  } catch (err) {
    console.error('Error fetching update data:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /stitchingdashboard/update/:id
 * Incrementally adds new pieces for each size.
 * Also logs each increment to stitching_data_updates.
 */
router.post('/update/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
  let conn;
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;
    const updateSizes = req.body.updateSizes || {};

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Check if record belongs to this user
    const [[entry]] = await conn.query(
      `
      SELECT *
      FROM stitching_data
      WHERE id = ?
        AND user_id = ?
      `,
      [entryId, userId]
    );
    if (!entry) {
      req.flash('error', 'Record not found or no permission');
      await conn.rollback();
      conn.release();
      return res.redirect('/stitchingdashboard');
    }

    let updatedGrandTotal = entry.total_pieces; // start from current total

    for (const lbl of Object.keys(updateSizes)) {
      let increment = parseInt(updateSizes[lbl], 10);
      // If the field was blank or invalid, treat increment as 0
      if (isNaN(increment) || increment < 0) {
        increment = 0;
      }
      if (increment === 0) {
        // No addition for this size label
        continue;
      }

      // Find existing row for that label
      const [[existingRow]] = await conn.query(
        `
        SELECT *
        FROM stitching_data_sizes
        WHERE stitching_data_id = ?
          AND size_label = ?
        `,
        [entryId, lbl]
      );

      if (!existingRow) {
        // If there's no existing row, create a new one
        const [[cls]] = await conn.query(
          `
          SELECT *
          FROM cutting_lot_sizes
          WHERE cutting_lot_id = (
            SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
          )
            AND size_label = ?
          `,
          [entry.lot_no, lbl]
        );
        if (!cls) {
          throw new Error(`Size label ${lbl} not found in cutting_lot_sizes`);
        }

        // Check remain
        const [[usedRow]] = await conn.query(
          `
          SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
          FROM stitching_data_sizes sds
          JOIN stitching_data sd ON sds.stitching_data_id = sd.id
          WHERE sd.lot_no = ?
            AND sds.size_label = ?
          `,
          [entry.lot_no, lbl]
        );
        const used = usedRow.usedCount || 0;
        const remain = cls.total_pieces - used;

        if (increment > remain) {
          throw new Error(
            `Cannot add ${increment} to size [${lbl}]. Max remain is ${remain}.`
          );
        }

        // Insert new row in stitching_data_sizes
        await conn.query(
          `
          INSERT INTO stitching_data_sizes (stitching_data_id, size_label, pieces)
          VALUES (?, ?, ?)
          `,
          [entryId, lbl, increment]
        );
        updatedGrandTotal += increment;
      } else {
        // We have an existing row
        const [[cls]] = await conn.query(
          `
          SELECT *
          FROM cutting_lot_sizes
          WHERE cutting_lot_id = (
            SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
          )
            AND size_label = ?
          `,
          [entry.lot_no, lbl]
        );
        if (!cls) {
          throw new Error(`Size label ${lbl} not found in cutting_lot_sizes.`);
        }

        const [[usedRow]] = await conn.query(
          `
          SELECT COALESCE(SUM(sds.pieces),0) AS usedCount
          FROM stitching_data_sizes sds
          JOIN stitching_data sd ON sds.stitching_data_id = sd.id
          WHERE sd.lot_no = ?
            AND sds.size_label = ?
          `,
          [entry.lot_no, lbl]
        );
        const used = usedRow.usedCount || 0;
        const totalInLot = cls.total_pieces;
        const remainGlobal = totalInLot - used;
        if (increment > remainGlobal) {
          throw new Error(
            `Cannot add ${increment} to size [${lbl}]. Max remain is ${remainGlobal}.`
          );
        }

        // New total in that row
        const newPieceCount = existingRow.pieces + increment;
        await conn.query(
          `
          UPDATE stitching_data_sizes
          SET pieces = ?
          WHERE id = ?
          `,
          [newPieceCount, existingRow.id]
        );
        updatedGrandTotal += increment;
      }

      // IMPORTANT: Log this increment in stitching_data_updates
      await conn.query(
        `
        INSERT INTO stitching_data_updates
          (stitching_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
        `,
        [entryId, lbl, increment]
      );
    }

    // Update total_pieces in main stitching_data
    await conn.query(
      `
      UPDATE stitching_data
      SET total_pieces = ?
      WHERE id = ?
      `,
      [updatedGrandTotal, entryId]
    );

    await conn.commit();
    conn.release();

    req.flash('success', 'Stitching data updated successfully!');
    return res.redirect('/stitchingdashboard');
  } catch (err) {
    console.error('Error updating data:', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Could not update data: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

/**
 * GET /stitchingdashboard/challan/:id
 * Show or download a "challan" including update history.
 */
router.get('/challan/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const entryId = req.params.id;

    // 1) Fetch the main row
    const [[row]] = await pool.query(
      `
      SELECT *
      FROM stitching_data
      WHERE id = ?
        AND user_id = ?
      `,
      [entryId, userId]
    );
    if (!row) {
      req.flash('error', 'Challan not found or no permission.');
      return res.redirect('/stitchingdashboard');
    }

    // 2) Fetch current sizes
    const [sizes] = await pool.query(
      `
      SELECT *
      FROM stitching_data_sizes
      WHERE stitching_data_id = ?
      ORDER BY id ASC
      `,
      [entryId]
    );

    // 3) Fetch updates from stitching_data_updates
    const [updates] = await pool.query(
      `
      SELECT *
      FROM stitching_data_updates
      WHERE stitching_data_id = ?
      ORDER BY updated_at ASC
      `,
      [entryId]
    );

    return res.render('challan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates
    });
  } catch (err) {
    console.error('Error loading challan:', err);
    req.flash('error', 'Error loading challan page: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

/**
 * GET /stitchingdashboard/download-all
 * Download all data as Excel.
 */
router.get('/download-all', isAuthenticated, isStitchingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 1) Main stitching_data
    const [mainRows] = await pool.query(
      `
      SELECT *
      FROM stitching_data
      WHERE user_id = ?
      ORDER BY created_at ASC
      `,
      [userId]
    );

    // 2) All sizes
    const [allSizes] = await pool.query(
      `
      SELECT s.*
      FROM stitching_data_sizes s
      JOIN stitching_data d ON s.stitching_data_id = d.id
      WHERE d.user_id = ?
      ORDER BY s.stitching_data_id, s.id
      `,
      [userId]
    );

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'KottyLifestyle';
    workbook.created = new Date();

    // MainData sheet
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

    // Sizes sheet
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

    // Send workbook
    res.setHeader('Content-Disposition', 'attachment; filename="StitchingData.xlsx"');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating Excel:', err);
    req.flash('error', 'Could not download Excel: ' + err.message);
    return res.redirect('/stitchingdashboard');
  }
});

module.exports = router;
