    // routes/stitchingRoutes.js
    const express = require('express');
    const router = express.Router();
    const path = require('path');
    const multer = require('multer');
    const ExcelJS = require('exceljs');
    const { pool } = require('../config/db');
    const { isAuthenticated, isStitchingMaster } = require('../middlewares/auth');

    // Multer for file
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
     */
    router.get('/', isAuthenticated, isStitchingMaster, async (req, res) => {
      try {
        const userId = req.session.user.id;

        // main data
        const [rows] = await pool.query(`
          SELECT *
          FROM stitching_data
          WHERE user_id = ?
          ORDER BY created_at DESC
        `, [userId]);

        // fetch child sizes
        const myData = [];
        for (const r of rows) {
          const [sz] = await pool.query(`
            SELECT *
            FROM stitching_data_sizes
            WHERE stitching_data_id = ?
            ORDER BY created_at ASC
          `, [r.id]);
          myData.push({ ...r, sizes: sz });
        }

        // cutting lots
        const [lots] = await pool.query(`
          SELECT id, lot_no, sku
          FROM cutting_lots
          ORDER BY created_at DESC
        `);

        return res.render('stitchingDashboard', {
          user: req.session.user,
          myData,
          lots
        });
      } catch (err) {
        console.error('Error loading dashboard:', err);
        req.flash('error', 'Cannot load dashboard data.');
        return res.redirect('/');
      }
    });

    /**
     * POST /stitchingdashboard/create
     * Create new data, handle "Other" custom sizes.
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

          // file
          let image_url = null;
          if (req.file) {
            image_url = '/uploads/' + req.file.filename;
          }

          // parse sizes
          let sizeLabels = Array.isArray(req.body.sizeLabels)
            ? req.body.sizeLabels
            : req.body.sizeLabels
            ? [req.body.sizeLabels]
            : [];
          let pieceCounts = Array.isArray(req.body.pieceCounts)
            ? req.body.pieceCounts
            : req.body.pieceCounts
            ? [req.body.pieceCounts]
            : [];
          // handle custom for "Other"
          // e.g. if user picks "Other" in select, we store the typed text from customSizeLabels
          let customLabels = Array.isArray(req.body.customSizeLabels)
            ? req.body.customSizeLabels
            : req.body.customSizeLabels
            ? [req.body.customSizeLabels]
            : [];

          // convert "Other" to the typed label
          for (let i = 0; i < sizeLabels.length; i++) {
            if (sizeLabels[i] === 'Other' && customLabels[i] && customLabels[i].trim()) {
              sizeLabels[i] = customLabels[i].trim();
            }
          }

          conn = await pool.getConnection();
          await conn.beginTransaction();

          // validate lot
          const [[lot]] = await conn.query(`
            SELECT lot_no, sku
            FROM cutting_lots
            WHERE id = ?
          `, [selectedLotId]);
          if (!lot) {
            req.flash('error', 'Invalid or no lot selected.');
            await conn.rollback();
            conn.release();
            return res.redirect('/stitchingdashboard');
          }

          // sum
          let totalPieces = 0;
          pieceCounts.forEach(pc => {
            const val = parseInt(pc, 10);
            if (isNaN(val) || val < 0) {
              throw new Error('Invalid piece count: ' + pc);
            }
            totalPieces += val;
          });

          // insert main
          const [main] = await conn.query(`
            INSERT INTO stitching_data (
              user_id, lot_no, sku, total_pieces, remark, image_url, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, NOW())
          `, [
            userId,
            lot.lot_no,
            lot.sku,
            totalPieces,
            remark || null,
            image_url
          ]);

          const newId = main.insertId;

          // insert sizes
          for (let i = 0; i < sizeLabels.length; i++) {
            const lbl = sizeLabels[i];
            const pcs = parseInt(pieceCounts[i], 10) || 0;
            if (!lbl) continue;
            await conn.query(`
              INSERT INTO stitching_data_sizes (
                stitching_data_id, size_label, pieces
              ) VALUES (?, ?, ?)
            `, [newId, lbl, pcs]);
          }

          await conn.commit();
          conn.release();
          req.flash('success', 'Stitching data created successfully!');
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
     * Return existing sizes
     */
    router.get('/update/:id/json', isAuthenticated, isStitchingMaster, async (req, res) => {
      try {
        const userId = req.session.user.id;
        const entryId = req.params.id;
        console.log('Made it to update route')
        // check ownership
        const [[rec]] = await pool.query(`
          SELECT *
          FROM stitching_data
          WHERE id = ?
            AND user_id = ?
        `, [entryId, userId]);
        if (!rec) {
          return res.status(403).json({ error: 'Not found or no permission.' });
        }

        const [existing] = await pool.query(`
          SELECT *
          FROM stitching_data_sizes
          WHERE stitching_data_id = ?
          ORDER BY created_at ASC
        `, [entryId]);
        return res.json({ sizes: existing });
      } catch (err) {
        console.error('Error fetching existing sizes for update:', err);
        return res.status(500).json({ error: err.message });
      }
    });

    /**
     * POST /stitchingdashboard/update/:id
     * existingSizeLabels + existingIncrements
     * newSizeLabels + newSizePieces
     * Also handle customNewSizeLabels for "Other" in new sizes.
     */
    router.post('/update/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
      let conn;
      try {
        console.log('---In /update/:id route---');
  console.log('req.body = ', req.body);
        const userId = req.session.user.id;
        const entryId = req.params.id;

        // parse existing
        const existingSizeLabels = Array.isArray(req.body.existingSizeLabels)
          ? req.body.existingSizeLabels
          : req.body.existingSizeLabels
          ? [req.body.existingSizeLabels]
          : [];
        const existingIncrements = Array.isArray(req.body.existingIncrements)
          ? req.body.existingIncrements
          : req.body.existingIncrements
          ? [req.body.existingIncrements]
          : [];

        // parse new
        let newSizeLabels = Array.isArray(req.body.newSizeLabels)
          ? req.body.newSizeLabels
          : req.body.newSizeLabels
          ? [req.body.newSizeLabels]
          : [];
        const newSizePieces = Array.isArray(req.body.newSizePieces)
          ? req.body.newSizePieces
          : req.body.newSizePieces
          ? [req.body.newSizePieces]
          : [];
        // parse custom for new "Other"
        let customNewSizeLabels = Array.isArray(req.body.customNewSizeLabels)
          ? req.body.customNewSizeLabels
          : req.body.customNewSizeLabels
          ? [req.body.customNewSizeLabels]
          : [];

        // If newSizeLabels[i] === 'Other' => use customNewSizeLabels[i]
        for (let i = 0; i < newSizeLabels.length; i++) {
          if (newSizeLabels[i] === 'Other' && customNewSizeLabels[i] && customNewSizeLabels[i].trim()) {
            newSizeLabels[i] = customNewSizeLabels[i].trim();
          }
        }

        // log it
        console.log('Updating sizes for entryId=', entryId, {
          existingSizeLabels,
          existingIncrements,
          newSizeLabels,
          newSizePieces
        });

        conn = await pool.getConnection();
        await conn.beginTransaction();

        // check record
        const [[record]] = await conn.query(`
          SELECT *
          FROM stitching_data
          WHERE id = ?
            AND user_id = ?
        `, [entryId, userId]);
        if (!record) {
          req.flash('error', 'Record not found or no permission.');
          await conn.rollback();
          conn.release();
          return res.redirect('/stitchingdashboard');
        }

        // ========== 1) existing increments ==========
        for (let i = 0; i < existingSizeLabels.length; i++) {
          const lbl = existingSizeLabels[i];
          const inc = parseInt(existingIncrements[i], 10);
          if (!lbl || isNaN(inc) || inc < 0) continue;

          // insert updates
          await conn.query(`
            INSERT INTO stitching_data_updates (
              stitching_data_id, size_label, pieces, updated_at
            ) VALUES (?, ?, ?, NOW())
          `, [entryId, lbl, inc]);

          // find size row
          const [[szRow]] = await conn.query(`
            SELECT *
            FROM stitching_data_sizes
            WHERE stitching_data_id = ?
              AND size_label = ?
          `, [entryId, lbl]);
          if (szRow) {
            const newCount = szRow.pieces + inc;
            await conn.query(`
              UPDATE stitching_data_sizes
              SET pieces = ?
              WHERE id = ?
            `, [newCount, szRow.id]);
          }
        }

        // ========== 2) new sizes ==========
        for (let i = 0; i < newSizeLabels.length; i++) {
          const lbl = newSizeLabels[i];
          const pcs = parseInt(newSizePieces[i], 10);
          if (!lbl || isNaN(pcs) || pcs < 0) continue;

          // updates
          await conn.query(`
            INSERT INTO stitching_data_updates (
              stitching_data_id, size_label, pieces, updated_at
            ) VALUES (?, ?, ?, NOW())
          `, [entryId, lbl, pcs]);

          // check if label existed
          const [[maybe]] = await conn.query(`
            SELECT *
            FROM stitching_data_sizes
            WHERE stitching_data_id = ?
              AND size_label = ?
          `, [entryId, lbl]);
          if (maybe) {
            const sumCount = maybe.pieces + pcs;
            await conn.query(`
              UPDATE stitching_data_sizes
              SET pieces = ?
              WHERE id = ?
            `, [sumCount, maybe.id]);
          } else {
            await conn.query(`
              INSERT INTO stitching_data_sizes (
                stitching_data_id, size_label, pieces
              ) VALUES (?, ?, ?)
            `, [entryId, lbl, pcs]);
          }
        }

        // ========== recalc total ==========
        const [[{ total }]] = await conn.query(`
          SELECT SUM(pieces) as total
          FROM stitching_data_sizes
          WHERE stitching_data_id = ?
        `, [entryId]);
        await conn.query(`
          UPDATE stitching_data
          SET total_pieces = ?
          WHERE id = ?
        `, [total || 0, entryId]);

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
     * Show the challan with updates
     */
    router.get('/challan/:id', isAuthenticated, isStitchingMaster, async (req, res) => {
      try {
        const userId = req.session.user.id;
        const entryId = req.params.id;

        // main
        const [[row]] = await pool.query(`
          SELECT *
          FROM stitching_data
          WHERE id = ?
            AND user_id = ?
        `, [entryId, userId]);
        if (!row) {
          req.flash('error', 'Challan not found or no permission.');
          return res.redirect('/stitchingdashboard');
        }

        // child sizes
        const [sizes] = await pool.query(`
          SELECT *
          FROM stitching_data_sizes
          WHERE stitching_data_id = ?
          ORDER BY created_at ASC
        `, [entryId]);

        // updates
        const [updates] = await pool.query(`
          SELECT *
          FROM stitching_data_updates
          WHERE stitching_data_id = ?
          ORDER BY updated_at ASC
        `, [entryId]);

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
     * GET /stitchingdashboard/search-lots
     * Must match EXACTLY how your front-end calls it
     */
    router.get('/search-lots', isAuthenticated, isStitchingMaster, async (req, res) => {
      try {
        const { query } = req.query || '';
        if (!query || query.length < 2) {
          return res.json([]);
        }
        const [lots] = await pool.query(`
          SELECT id, lot_no, sku
          FROM cutting_lots
          WHERE lot_no LIKE CONCAT('%', ?, '%')
          ORDER BY created_at DESC
          LIMIT 20
        `, [query]);
        return res.json(lots);
      } catch (err) {
        console.error('Error searching lots:', err);
        return res.status(500).json({ error: err.message });
      }
    });

    /**
     * GET /stitchingdashboard/download-all
     * Multi-sheet Excel with main, sizes, updates
     */
    router.get('/download-all', isAuthenticated, isStitchingMaster, async (req, res) => {
      try {
        const userId = req.session.user.id;

        // main
        const [mainRows] = await pool.query(`
          SELECT *
          FROM stitching_data
          WHERE user_id = ?
          ORDER BY created_at ASC
        `, [userId]);

        // all sizes
        const [allSizes] = await pool.query(`
          SELECT s.*
          FROM stitching_data_sizes s
          JOIN stitching_data d ON s.stitching_data_id = d.id
          WHERE d.user_id = ?
          ORDER BY s.stitching_data_id, s.created_at
        `, [userId]);

        // all updates
        const [allUpdates] = await pool.query(`
          SELECT u.*
          FROM stitching_data_updates u
          JOIN stitching_data d ON u.stitching_data_id = d.id
          WHERE d.user_id = ?
          ORDER BY u.stitching_data_id, u.updated_at
        `, [userId]);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'KottyLifestyle';
        workbook.created = new Date();

        // 1) main sheet
        const mainSheet = workbook.addWorksheet('MainData');
        mainSheet.columns = [
          { header: 'ID', key: 'id', width: 6 },
          { header: 'Lot No', key: 'lot_no', width: 15 },
          { header: 'SKU', key: 'sku', width: 12 },
          { header: 'Total Pieces', key: 'total_pieces', width: 12 },
          { header: 'Remark', key: 'remark', width: 20 },
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

        // 2) sizes sheet
        const sizesSheet = workbook.addWorksheet('Sizes');
        sizesSheet.columns = [
          { header: 'ID', key: 'id', width: 6 },
          { header: 'Stitching ID', key: 'stitching_data_id', width: 12 },
          { header: 'Size Label', key: 'size_label', width: 12 },
          { header: 'Pieces', key: 'pieces', width: 8 },
          { header: 'Created At', key: 'created_at', width: 20 }
        ];
        allSizes.forEach(s => {
          sizesSheet.addRow({
            id: s.id,
            stitching_data_id: s.stitching_data_id,
            size_label: s.size_label,
            pieces: s.pieces,
            created_at: s.created_at
          });
        });

        // 3) updates sheet
        const updatesSheet = workbook.addWorksheet('Updates');
        updatesSheet.columns = [
          { header: 'ID', key: 'id', width: 6 },
          { header: 'Stitching ID', key: 'stitching_data_id', width: 12 },
          { header: 'Size Label', key: 'size_label', width: 12 },
          { header: 'Pieces', key: 'pieces', width: 8 },
          { header: 'Updated At', key: 'updated_at', width: 20 }
        ];
        allUpdates.forEach(u => {
          updatesSheet.addRow({
            id: u.id,
            stitching_data_id: u.stitching_data_id,
            size_label: u.size_label,
            pieces: u.pieces,
            updated_at: u.updated_at
          });
        });

        res.setHeader('Content-Disposition', 'attachment; filename="StitchingData.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

        await workbook.xlsx.write(res);
        res.end();
      } catch (err) {
        console.error('Error generating multi-sheet Excel:', err);
        req.flash('error', 'Could not download Excel: ' + err.message);
        return res.redirect('/stitchingdashboard');
      }
    });

    module.exports = router;
