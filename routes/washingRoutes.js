// routes/washingRoutes.js

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isWashingMaster } = require('../middlewares/auth');

// Setup multer for image upload
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

/**
 * GET /washingdashboard
 * Show lots assigned to this user (via washing_assignments) that are not yet used in washing_data.
 */
router.get('/', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Join washing_assignments -> stitching_assignments -> cutting_lots
    // Exclude those lot_no that already appear in washing_data
    const [lots] = await pool.query(`
      SELECT c.id, c.lot_no, c.sku, c.total_pieces
      FROM washing_assignments wa
      JOIN stitching_assignments sa ON wa.stitching_assignment_id = sa.id
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE wa.user_id = ?
        AND c.lot_no NOT IN (SELECT lot_no FROM washing_data)
      ORDER BY c.created_at DESC
      LIMIT 10
    `, [userId]);

    const errorMessages = req.flash('error');
    const successMessages = req.flash('success');

    return res.render('washingDashboard', {
      user: req.session.user,
      lots,
      error: errorMessages,
      success: successMessages
    });
  } catch (err) {
    console.error('Error loading washing dashboard:', err);
    req.flash('error', 'Cannot load washing dashboard data.');
    return res.redirect('/');
  }
});

/**
 * GET /washingdashboard/list-entries
 * Lazy load existing washing_data for this user.
 */
router.get('/list-entries', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const searchTerm = req.query.search || '';
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    const limit = 5;
    const searchLike = `%${searchTerm}%`;

    const [rows] = await pool.query(`
      SELECT *
      FROM washing_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, searchLike, searchLike, limit, offset]);

    if (!rows || rows.length === 0) {
      return res.json({ data: [], hasMore: false });
    }

    // gather child sizes
    const ids = rows.map(r => r.id);
    const [sizeRows] = await pool.query(`
      SELECT *
      FROM washing_data_sizes
      WHERE washing_data_id IN (?)
    `, [ids]);

    const sizesMap = {};
    sizeRows.forEach(s => {
      if (!sizesMap[s.washing_data_id]) {
        sizesMap[s.washing_data_id] = [];
      }
      sizesMap[s.washing_data_id].push(s);
    });

    const dataOut = rows.map(r => ({
      ...r,
      sizes: sizesMap[r.id] || []
    }));

    // check if more remain
    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM washing_data
      WHERE user_id = ?
        AND (lot_no LIKE ? OR sku LIKE ?)
    `, [userId, searchLike, searchLike]);

    const hasMore = offset + rows.length < totalCount;
    return res.json({ data: dataOut, hasMore });
  } catch (err) {
    console.error('Error fetching washing entries:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /washingdashboard/get-lot-sizes/:lotId
 * Return sizes & remain for a given lotId, referencing cutting_lot_sizes minus what's used in washing_data.
 */
router.get('/get-lot-sizes/:lotId', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const lotId = req.params.lotId;
    const [[lot]] = await pool.query(`SELECT * FROM cutting_lots WHERE id = ?`, [lotId]);
    if (!lot) {
      return res.status(404).json({ error: 'Lot not found.' });
    }

    const [lotSizes] = await pool.query(`
      SELECT *
      FROM cutting_lot_sizes
      WHERE cutting_lot_id = ?
      ORDER BY id ASC
    `, [lotId]);

    const output = [];
    for (const s of lotSizes) {
      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wds.pieces),0) as usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ?
          AND wds.size_label = ?
      `, [lot.lot_no, s.size_label]);
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
    console.error('Error get-lot-sizes washing:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /washingdashboard/create
 * Creates new washing_data from the selected lot.
 */
router.post('/create', isAuthenticated, isWashingMaster, upload.single('image_file'), async (req, res) => {
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
      return res.redirect('/washingdashboard');
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // confirm cutting_lot
    const [[lot]] = await conn.query(`SELECT * FROM cutting_lots WHERE id = ?`, [selectedLotId]);
    if (!lot) {
      req.flash('error', 'Invalid lot selection.');
      await conn.rollback();
      conn.release();
      return res.redirect('/washingdashboard');
    }

    // check if already used in washing_data
    const [[already]] = await conn.query(`
      SELECT id FROM washing_data WHERE lot_no = ?
    `, [lot.lot_no]);
    if (already) {
      req.flash('error', `Lot ${lot.lot_no} already used for washing.`);
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

      const [[cls]] = await conn.query(`SELECT * FROM cutting_lot_sizes WHERE id = ?`, [sizeId]);
      if (!cls) {
        req.flash('error', 'Bad size reference: ' + sizeId);
        await conn.rollback();
        conn.release();
        return res.redirect('/washingdashboard');
      }

      const [[usedRow]] = await conn.query(`
        SELECT COALESCE(SUM(wds.pieces),0) as usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ?
          AND wds.size_label = ?
      `, [lot.lot_no, cls.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = cls.total_pieces - used;
      if (requested > remain) {
        req.flash('error', `Cannot create washing: requested ${requested} but only ${remain} remain for size ${cls.size_label}.`);
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

    // insert main washing_data
    const [main] = await conn.query(`
      INSERT INTO washing_data
        (user_id, lot_no, sku, total_pieces, remark, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [userId, lot.lot_no, lot.sku, grandTotal, remark || null, image_url]);
    const newId = main.insertId;

    // insert sizes
    for (const sizeId of Object.keys(sizesObj)) {
      const numVal = parseInt(sizesObj[sizeId], 10) || 0;
      if (numVal <= 0) continue;

      const [[cls]] = await conn.query(`SELECT * FROM cutting_lot_sizes WHERE id = ?`, [sizeId]);
      await conn.query(`
        INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces)
        VALUES (?, ?, ?)
      `, [newId, cls.size_label, numVal]);
    }

    await conn.commit();
    conn.release();
    req.flash('success', 'Washing entry created successfully.');
    return res.redirect('/washingdashboard');
  } catch (err) {
    console.error('Error creating washing data:', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error creating washing data: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

/**
 * GET /washingdashboard/update/:id/json
 * Return existing washing_data_sizes so user can do incremental updates.
 */
router.get('/update/:id/json', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const entryId = req.params.id;
    const userId = req.session.user.id;

    const [[entry]] = await pool.query(`
      SELECT *
      FROM washing_data
      WHERE id = ?
        AND user_id = ?
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
      // find cutting_lot_sizes
      const [[cls]] = await pool.query(`
        SELECT *
        FROM cutting_lot_sizes
        WHERE cutting_lot_id = (
          SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
        )
          AND size_label = ?
      `, [entry.lot_no, sz.size_label]);

      if (!cls) {
        output.push({
          ...sz,
          remain: 999999
        });
        continue;
      }

      const [[usedRow]] = await pool.query(`
        SELECT COALESCE(SUM(wds.pieces),0) as usedCount
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
        WHERE wd.lot_no = ?
          AND wds.size_label = ?
      `, [entry.lot_no, sz.size_label]);
      const used = usedRow.usedCount || 0;
      const remain = cls.total_pieces - used;
      output.push({
        ...sz,
        remain: remain < 0 ? 0 : remain
      });
    }

    return res.json({ sizes: output });
  } catch (err) {
    console.error('Error fetching washing update data:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /washingdashboard/update/:id
 * Incrementally updates washing_data_sizes.
 */
router.post('/update/:id', isAuthenticated, isWashingMaster, async (req, res) => {
  let conn;
  try {
    const entryId = req.params.id;
    const userId = req.session.user.id;
    const updateSizes = req.body.updateSizes || {};

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[entry]] = await conn.query(`
      SELECT *
      FROM washing_data
      WHERE id = ?
        AND user_id = ?
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

      // find existing row
      const [[existingRow]] = await conn.query(`
        SELECT *
        FROM washing_data_sizes
        WHERE washing_data_id = ?
          AND size_label = ?
      `, [entryId, lbl]);

      if (!existingRow) {
        // new row
        const [[cls]] = await conn.query(`
          SELECT *
          FROM cutting_lot_sizes
          WHERE cutting_lot_id = (
            SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
          )
            AND size_label = ?
        `, [entry.lot_no, lbl]);
        if (!cls) {
          throw new Error(`Size label ${lbl} not found in cutting_lot_sizes`);
        }

        const [[usedRow]] = await conn.query(`
          SELECT COALESCE(SUM(wds.pieces),0) as usedCount
          FROM washing_data_sizes wds
          JOIN washing_data wd ON wds.washing_data_id = wd.id
          WHERE wd.lot_no = ?
            AND wds.size_label = ?
        `, [entry.lot_no, lbl]);
        const used = usedRow.usedCount || 0;
        const remain = cls.total_pieces - used;
        if (increment > remain) {
          throw new Error(`Cannot add ${increment} to [${lbl}] because only ${remain} remain.`);
        }

        await conn.query(`
          INSERT INTO washing_data_sizes (washing_data_id, size_label, pieces)
          VALUES (?, ?, ?)
        `, [entryId, lbl, increment]);
        updatedTotal += increment;
      } else {
        // row exists
        const [[cls]] = await conn.query(`
          SELECT *
          FROM cutting_lot_sizes
          WHERE cutting_lot_id = (
            SELECT id FROM cutting_lots WHERE lot_no = ? LIMIT 1
          )
            AND size_label = ?
        `, [entry.lot_no, lbl]);
        if (!cls) {
          throw new Error(`Size label ${lbl} not found in cutting_lot_sizes`);
        }

        const [[usedRow]] = await conn.query(`
          SELECT COALESCE(SUM(wds.pieces),0) as usedCount
          FROM washing_data_sizes wds
          JOIN washing_data wd ON wds.washing_data_id = wd.id
          WHERE wd.lot_no = ?
            AND wds.size_label = ?
        `, [entry.lot_no, lbl]);
        const used = usedRow.usedCount || 0;
        const remain = cls.total_pieces - used;
        if (increment > remain) {
          throw new Error(`Cannot add ${increment} for [${lbl}] because only ${remain} remain.`);
        }

        const newPieces = existingRow.pieces + increment;
        await conn.query(`
          UPDATE washing_data_sizes
          SET pieces = ?
          WHERE id = ?
        `, [newPieces, existingRow.id]);

        updatedTotal += increment;
      }

      // Log increment
      await conn.query(`
        INSERT INTO washing_data_updates
          (washing_data_id, size_label, pieces, updated_at)
        VALUES (?, ?, ?, NOW())
      `, [entryId, lbl, increment]);
    }

    // update main total
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
    console.error('Error updating washing data:', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    req.flash('error', 'Error updating washing data: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

/**
 * GET /washingdashboard/challan/:id
 * Similar to stitching: show a "challan" with updates.
 */
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

    res.render('washingChallan', {
      user: req.session.user,
      entry: row,
      sizes,
      updates
    });
  } catch (err) {
    console.error('Error loading washing challan:', err);
    req.flash('error', 'Error loading washing challan: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

/**
 * GET /washingdashboard/download-all
 * Export all washing_data as Excel.
 */
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
    console.error('Error downloading washing excel:', err);
    req.flash('error', 'Could not download washing Excel: ' + err.message);
    return res.redirect('/washingdashboard');
  }
});

module.exports = router;
