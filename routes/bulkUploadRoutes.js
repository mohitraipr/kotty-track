// routes/bulkUploadRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isCuttingManager } = require('../middlewares/auth');

// Set up Multer for Excel file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    console.log('Uploading file:', file.originalname);
    cb(null, 'uploads/'); // Ensure this folder exists
  },
  filename: function (req, file, cb) {
    const newFileName = Date.now() + path.extname(file.originalname); // e.g., 1598465759595.xlsx
    console.log('New filename for upload:', newFileName);
    cb(null, newFileName);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max for Excel uploads
});

/* ------------------------------------------------------------
   GET /bulk-upload
   Render the dashboard page for bulk operations.
------------------------------------------------------------- */
router.get('/bulk-upload', isAuthenticated, isCuttingManager, (req, res) => {
  console.log(`User ${req.session.user.username} accessed /bulk-upload dashboard.`);
  res.render('bulkUploadDashboard', {
    user: req.session.user,
    error: req.flash('error'),
    success: req.flash('success')
  });
});

/* ------------------------------------------------------------
   GET /bulk-upload/template
   Generate and download an Excel template for bulk lot upload.
   Template includes three sheets:
     - Lots: Lot details (lot_no, sku, fabric_type, remark)
     - Sizes: Lot sizes (lot_no, size_label, pattern_count)
     - Rolls: Lot roll details (lot_no, roll_no, weight_used, layers)
------------------------------------------------------------- */
router.get('/bulk-upload/template', isAuthenticated, isCuttingManager, async (req, res) => {
  console.log(`User ${req.session.user.username} requested bulk upload template.`);
  try {
    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Lots
    const lotsSheet = workbook.addWorksheet('Lots');
    lotsSheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Fabric Type', key: 'fabric_type', width: 15 },
      { header: 'Remark', key: 'remark', width: 20 }
    ];
    // Add an example row
    lotsSheet.addRow({ lot_no: 'LOT001', sku: 'SKU001', fabric_type: 'Cotton', remark: 'Older lot' });

    // Sheet 2: Sizes
    const sizesSheet = workbook.addWorksheet('Sizes');
    sizesSheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Size Label', key: 'size_label', width: 15 },
      { header: 'Pattern Count', key: 'pattern_count', width: 15 }
    ];
    sizesSheet.addRow({ lot_no: 'LOT001', size_label: 'M', pattern_count: 10 });

    // Sheet 3: Rolls
    const rollsSheet = workbook.addWorksheet('Rolls');
    rollsSheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Roll No', key: 'roll_no', width: 15 },
      { header: 'Weight Used', key: 'weight_used', width: 15 },
      { header: 'Layers', key: 'layers', width: 15 }
    ];
    rollsSheet.addRow({ lot_no: 'LOT001', roll_no: 'ROLL123', weight_used: 5.0, layers: 3 });

    console.log('Excel template generated successfully.');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=BulkUploadTemplate.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating Excel template:', err);
    req.flash('error', 'Failed to generate Excel template.');
    res.redirect('/bulk-upload');
  }
});

/* ------------------------------------------------------------
   POST /bulk-upload/upload-lots
   Process the Excel file upload to bulk create older lots.
   The file is expected to have three sheets: Lots, Sizes, Rolls.
------------------------------------------------------------- */
router.post('/bulk-upload/upload-lots', isAuthenticated, isCuttingManager, upload.single('excelFile'), async (req, res) => {
  console.log(`User ${req.session.user.username} initiated bulk lot upload.`);
  const file = req.file;
  if (!file) {
    console.error('No file uploaded for bulk lot upload.');
    req.flash('error', 'No file uploaded.');
    return res.redirect('/bulk-upload');
  }

  let conn;
  try {
    console.log('Reading Excel file from path:', file.path);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);

    // Get the worksheets (must be named exactly as in the template)
    const lotsSheet = workbook.getWorksheet('Lots');
    const sizesSheet = workbook.getWorksheet('Sizes');
    const rollsSheet = workbook.getWorksheet('Rolls');

    if (!lotsSheet) {
      throw new Error('Missing "Lots" sheet in Excel file.');
    }

    // Read lot data
    const lotsData = [];
    lotsSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // Skip header row
      if (rowNumber === 1) return;
      const lot_no = row.getCell(1).value;
      const sku = row.getCell(2).value;
      const fabric_type = row.getCell(3).value;
      const remark = row.getCell(4).value;
      console.log(`Row ${rowNumber} - Lot No: ${lot_no}, SKU: ${sku}, Fabric Type: ${fabric_type}, Remark: ${remark}`);
      if (lot_no && sku && fabric_type) {
        lotsData.push({ lot_no, sku, fabric_type, remark });
      }
    });
    console.log('Lots data extracted:', lotsData.length);

    // Read sizes data, grouping by lot_no
    const sizesData = {};
    if (sizesSheet) {
      sizesSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const lot_no = row.getCell(1).value;
        const size_label = row.getCell(2).value;
        const pattern_count = row.getCell(3).value;
        console.log(`Sizes Row ${rowNumber} - Lot No: ${lot_no}, Size Label: ${size_label}, Pattern Count: ${pattern_count}`);
        if (lot_no && size_label && pattern_count) {
          if (!sizesData[lot_no]) sizesData[lot_no] = [];
          sizesData[lot_no].push({ size_label, pattern_count: parseInt(pattern_count, 10) });
        }
      });
    }
    console.log('Sizes data grouped by lot:', Object.keys(sizesData).length);

    // Read rolls data, grouping by lot_no
    const rollsData = {};
    if (rollsSheet) {
      rollsSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const lot_no = row.getCell(1).value;
        const roll_no = row.getCell(2).value;
        const weight_used = row.getCell(3).value;
        const layers = row.getCell(4).value;
        console.log(`Rolls Row ${rowNumber} - Lot No: ${lot_no}, Roll No: ${roll_no}, Weight Used: ${weight_used}, Layers: ${layers}`);
        if (lot_no && roll_no && weight_used && layers) {
          if (!rollsData[lot_no]) rollsData[lot_no] = [];
          rollsData[lot_no].push({
            roll_no,
            weight_used: parseFloat(weight_used),
            layers: parseInt(layers, 10)
          });
        }
      });
    }
    console.log('Rolls data grouped by lot:', Object.keys(rollsData).length);

    // Begin a database transaction
    conn = await pool.getConnection();
    await conn.beginTransaction();
    console.log('Database transaction started for bulk lot upload.');

    // Process each lot row from the Lots sheet
    for (const lot of lotsData) {
      const lotSizes = sizesData[lot.lot_no] || [];
      const lotRolls = rollsData[lot.lot_no] || [];
      const sumPatterns = lotSizes.reduce((sum, s) => sum + s.pattern_count, 0);
      const sumLayers = lotRolls.reduce((sum, r) => sum + r.layers, 0);
      const totalPieces = sumPatterns * sumLayers;

      const [result] = await conn.query(
        `INSERT INTO cutting_lots (lot_no, sku, fabric_type, remark, user_id, total_pieces)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lot.lot_no, lot.sku, lot.fabric_type, lot.remark || null, req.session.user.id, totalPieces]
      );
      const cuttingLotId = result.insertId;

      for (const size of lotSizes) {
        await conn.query(
          `INSERT INTO cutting_lot_sizes (cutting_lot_id, size_label, pattern_count, total_pieces, created_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [cuttingLotId, size.size_label, size.pattern_count, size.pattern_count * sumLayers]
        );
      }

      // Insert rolls for this lot (if any)
      const rollNos = lotRolls.map(r => r.roll_no);
      if (rollNos.length) {
        const [rollRows] = await conn.query(
          `SELECT roll_no, per_roll_weight FROM fabric_invoice_rolls WHERE roll_no IN (?) FOR UPDATE`,
          [rollNos]
        );
        const rollMap = new Map(rollRows.map(r => [r.roll_no, parseFloat(r.per_roll_weight)]));

        for (const roll of lotRolls) {
          const availableWeight = rollMap.get(roll.roll_no);
          if (availableWeight === undefined) {
            throw new Error(`Roll No. ${roll.roll_no} does not exist for lot ${lot.lot_no}.`);
          }
          if (roll.weight_used > availableWeight) {
            throw new Error(
              `Insufficient weight for Roll No. ${roll.roll_no} in lot ${lot.lot_no}. ` +
              `Available: ${availableWeight}, Requested: ${roll.weight_used}`
            );
          }
          await conn.query(
            `INSERT INTO cutting_lot_rolls (cutting_lot_id, roll_no, weight_used, layers, total_pieces, created_at)
             VALUES (?, ?, ?, ?, 0, NOW())`,
            [cuttingLotId, roll.roll_no, roll.weight_used, roll.layers]
          );
          await conn.query(
            `UPDATE fabric_invoice_rolls SET per_roll_weight = per_roll_weight - ? WHERE roll_no = ?`,
            [roll.weight_used, roll.roll_no]
          );
        }
      }
    }

    await conn.commit();
    console.log('Bulk lot upload transaction committed successfully.');
    conn.release();
    req.flash('success', 'Bulk lots uploaded successfully.');
    res.redirect('/bulk-upload');
  } catch (err) {
    console.error('Error processing bulk lot upload:', err);
    if (conn) {
      await conn.rollback();
      console.log('Database transaction rolled back.');
      conn.release();
    }
    req.flash('error', err.message || 'Error processing the file.');
    res.redirect('/bulk-upload');
  }
});

/* ------------------------------------------------------------
   BULK ASSIGNMENT ROUTES
   (Allows you to assign multiple lots to stitching users via an Excel file)
------------------------------------------------------------- */

/* GET /bulk-assign
   Render the bulk assignment dashboard.
------------------------------------------------------------- */
router.get('/bulk-assign', isAuthenticated, isCuttingManager, (req, res) => {
  console.log(`User ${req.session.user.username} accessed /bulk-assign dashboard.`);
  res.render('bulkUploadDashboard', {
    user: req.session.user,
    error: req.flash('error'),
    success: req.flash('success')
  });
});

/* GET /bulk-assign/template
   Generate and download an Excel template for bulk assignments.
   The template includes a single sheet “Assignments” with columns:
     - Lot No (must match a lot that you own)
     - Stitching User ID (the ID of the stitching user to assign)
------------------------------------------------------------- */
router.get('/bulk-assign/template', isAuthenticated, isCuttingManager, async (req, res) => {
  console.log(`User ${req.session.user.username} requested bulk assignment template.`);
  try {
    const workbook = new ExcelJS.Workbook();
    const assignSheet = workbook.addWorksheet('Assignments');
    assignSheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Stitching User ID', key: 'user_id', width: 15 }
    ];
    assignSheet.addRow({ lot_no: 'LOT001', user_id: 123 }); // example row

    console.log('Bulk assignment template generated successfully.');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=BulkAssignmentTemplate.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating assignment template:', err);
    req.flash('error', 'Failed to generate assignment template.');
    res.redirect('/bulk-assign');
  }
});

/* POST /bulk-assign
   Process the Excel file upload for bulk assignments.
   The file should have a sheet named “Assignments” with:
     - Lot No
     - Stitching User ID
------------------------------------------------------------- */
router.post('/bulk-assign', isAuthenticated, isCuttingManager, upload.single('excelFile'), async (req, res) => {
  console.log(`User ${req.session.user.username} initiated bulk assignment upload.`);
  const file = req.file;
  if (!file) {
    console.error('No file uploaded for bulk assignment.');
    req.flash('error', 'No file uploaded.');
    return res.redirect('/bulk-assign');
  }

  let conn;
  try {
    console.log('Reading Excel file from path:', file.path);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);
    const assignSheet = workbook.getWorksheet('Assignments');
    if (!assignSheet) {
      throw new Error('Missing "Assignments" sheet in Excel file.');
    }

    const assignments = [];
    assignSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      let lot_no = row.getCell(1).value;
      const user_id = row.getCell(2).value;
      if (lot_no) lot_no = lot_no.toString().trim();
      if (lot_no && user_id) assignments.push({ lot_no, user_id });
    });
    console.log('Assignments data extracted:', assignments.length);

    conn = await pool.getConnection();
    await conn.beginTransaction();
    console.log('Database transaction started for bulk assignment upload.');

    const lotNos = [...new Set(assignments.map(a => a.lot_no))];
    const [lotRows] = await conn.query(
      `SELECT id, TRIM(lot_no) AS lot_no FROM cutting_lots WHERE TRIM(lot_no) IN (?) AND user_id = ?`,
      [lotNos, req.session.user.id]
    );
    const lotMap = new Map(lotRows.map(r => [r.lot_no, r.id]));
    const lotIds = Array.from(lotMap.values());
    let assignedSet = new Set();
    if (lotIds.length) {
      const [assignedRows] = await conn.query(
        `SELECT cutting_lot_id FROM stitching_assignments WHERE cutting_lot_id IN (?)`,
        [lotIds]
      );
      assignedSet = new Set(assignedRows.map(r => r.cutting_lot_id));
    }

    const insertValues = [];
    for (const assign of assignments) {
      const cuttingLotId = lotMap.get(assign.lot_no);
      if (!cuttingLotId) {
        throw new Error(`Lot No. ${assign.lot_no} not found or not owned by you.`);
      }
      if (assignedSet.has(cuttingLotId)) continue;
      insertValues.push([req.session.user.id, assign.user_id, cuttingLotId, new Date()]);
      assignedSet.add(cuttingLotId);
    }

    if (insertValues.length) {
      await conn.query(
        `INSERT INTO stitching_assignments (assigner_cutting_master, user_id, cutting_lot_id, assigned_on) VALUES ?`,
        [insertValues]
      );
    }

    await conn.commit();
    console.log('Bulk assignment transaction committed successfully.');
    conn.release();
    req.flash('success', 'Bulk assignments uploaded successfully.');
    res.redirect('/bulk-assign');
  } catch (err) {
    console.error('Error processing bulk assignment upload:', err);
    if (conn) {
      await conn.rollback();
      console.log('Database transaction rolled back for bulk assignment.');
      conn.release();
    }
    req.flash('error', err.message || 'Error processing the file.');
    res.redirect('/bulk-assign');
  }
});

module.exports = router;
