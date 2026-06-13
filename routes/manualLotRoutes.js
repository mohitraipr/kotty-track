// routes/manualLotRoutes.js
//
// Map a manual (handwritten / physical) lot number onto existing cutting lots.
// Two ways in:
//   - inline search-and-edit page (one lot at a time)
//   - bulk Excel upload (system lot_no -> manual lot number)
//
// The system cutting_lots.lot_no is never touched here; we only set
// manual_lot_number, which is a display label.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isCuttingManager } = require('../middlewares/auth');

// Reuse the same disk-upload setup as bulk lot upload.
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

async function fetchLots(search) {
  if (search) {
    const like = `%${search}%`;
    const [rows] = await pool.query(
      `SELECT id, lot_no, manual_lot_number, sku, remark, created_at
         FROM cutting_lots
        WHERE lot_no LIKE ? OR sku LIKE ? OR remark LIKE ? OR manual_lot_number LIKE ?
        ORDER BY created_at DESC
        LIMIT 200`,
      [like, like, like, like]
    );
    return rows;
  }
  const [rows] = await pool.query(
    `SELECT id, lot_no, manual_lot_number, sku, remark, created_at
       FROM cutting_lots
      ORDER BY created_at DESC
      LIMIT 200`
  );
  return rows;
}

// GET /manual-lot  — inline mapping page (with optional ?search=)
router.get('/', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const lots = await fetchLots(search);
    res.render('manualLotMapping', {
      user: req.session.user,
      lots,
      search,
      uploadResult: null,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /manual-lot:', err);
    req.flash('error', 'Could not load manual lot mapping.');
    res.redirect('/cutting-manager/dashboard');
  }
});

// POST /manual-lot/update — set/clear manual_lot_number for one lot (by id)
router.post('/update', isAuthenticated, isCuttingManager, async (req, res) => {
  const search = (req.body.search || '').trim();
  const back = `/manual-lot${search ? `?search=${encodeURIComponent(search)}` : ''}`;
  try {
    const id = parseInt(req.body.id, 10);
    const manualLotNumber = (req.body.manual_lot_number || '').trim();
    if (!id) {
      req.flash('error', 'Invalid lot.');
      return res.redirect(back);
    }
    await pool.query(
      'UPDATE cutting_lots SET manual_lot_number = ? WHERE id = ?',
      [manualLotNumber || null, id]
    );
    req.flash('success', `Manual lot number ${manualLotNumber ? 'saved' : 'cleared'}.`);
    res.redirect(back);
  } catch (err) {
    console.error('[ERROR] POST /manual-lot/update:', err);
    req.flash('error', 'Failed to update manual lot number.');
    res.redirect(back);
  }
});

// GET /manual-lot/template — download the bulk mapping Excel template
router.get('/template', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Mapping');
    sheet.columns = [
      { header: 'System Lot No', key: 'lot_no', width: 20 },
      { header: 'Manual Lot Number', key: 'manual_lot_number', width: 22 }
    ];
    sheet.addRow({ lot_no: 'jo1', manual_lot_number: 'A-1024' });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=ManualLotMappingTemplate.xlsx'
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[ERROR] GET /manual-lot/template:', err);
    req.flash('error', 'Could not generate template.');
    res.redirect('/manual-lot');
  }
});

// POST /manual-lot/upload — bulk map by system lot_no
router.post('/upload', isAuthenticated, isCuttingManager, upload.single('excelFile'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'No file uploaded.');
    return res.redirect('/manual-lot');
  }

  let conn;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);
    const sheet = workbook.getWorksheet('Mapping') || workbook.worksheets[0];
    if (!sheet) {
      throw new Error('No worksheet found in the uploaded file.');
    }

    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const lotNo = row.getCell(1).value;
      const manual = row.getCell(2).value;
      rows.push({
        lot_no: lotNo == null ? '' : lotNo.toString().trim(),
        manual_lot_number: manual == null ? '' : manual.toString().trim()
      });
    });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let matched = 0;
    let skipped = 0;
    const unmatched = [];

    for (const r of rows) {
      if (!r.lot_no || !r.manual_lot_number) {
        skipped += 1;
        continue;
      }
      const [result] = await conn.query(
        'UPDATE cutting_lots SET manual_lot_number = ? WHERE lot_no = ?',
        [r.manual_lot_number, r.lot_no]
      );
      if (result.affectedRows >= 1) {
        matched += 1;
      } else {
        unmatched.push(r.lot_no);
      }
    }

    await conn.commit();
    conn.release();

    const search = '';
    const lots = await fetchLots(search);
    res.render('manualLotMapping', {
      user: req.session.user,
      lots,
      search,
      uploadResult: { matched, skipped, unmatched },
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    console.error('[ERROR] POST /manual-lot/upload:', err);
    req.flash('error', `Upload failed: ${err.message}`);
    res.redirect('/manual-lot');
  }
});

module.exports = router;
