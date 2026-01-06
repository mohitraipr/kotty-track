const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAccountsAdmin, allowUsernames } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs');

// Multer setup for Excel uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.mkdirSync('uploads', { recursive: true });
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

const sapnaOnly = [isAuthenticated, allowUsernames(['sapna']), isAccountsAdmin];

// GET /purchase - render dashboard for accounts role
router.get('/', sapnaOnly, async (req, res) => {
  try {
    // Fetch parties and factories concurrently to speed up dashboard load
    const [[parties], [factories]] = await Promise.all([
      pool.query(
        'SELECT id, name, gst_number, state, pincode, due_payment_days FROM parties ORDER BY name'
      ),
      pool.query(
        'SELECT id, name, gst_number, state FROM factories ORDER BY name'
      )
    ]);

    res.render('purchaseDashboard', {
      user: req.session.user,
      parties,
      factories
    });
  } catch (err) {
    console.error('Error loading purchase dashboard:', err);
    req.flash('error', 'Failed to load purchase dashboard');
    res.redirect('/');
  }
});

// POST /purchase/parties - create a new party
router.post('/parties', sapnaOnly, async (req, res) => {
  const { name, gst_number, state, pincode, due_payment_days } = req.body;
  if (!name) {
    req.flash('error', 'Party name is required');
    return res.redirect('/purchase');
  }
  try {
    await pool.query(
      `INSERT INTO parties (name, gst_number, state, pincode, due_payment_days)
       VALUES (?, ?, ?, ?, ?)`,
      [name, gst_number, state, pincode, due_payment_days || 0]
    );
    req.flash('success', 'Party created');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error creating party:', err);
    req.flash('error', 'Failed to create party');
    res.redirect('/purchase');
  }
});

// POST /purchase/parties/:id - update an existing party
// Restrict :id to digits only so that routes like /parties/bulk don't match
router.post('/parties/:id(\\d+)', sapnaOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, gst_number, state, pincode, due_payment_days } = req.body;

  if (Number.isNaN(id)) {
    req.flash('error', 'Invalid party ID');
    return res.redirect('/purchase');
  }

  try {
    await pool.query(
      `UPDATE parties
       SET name = ?, gst_number = ?, state = ?, pincode = ?, due_payment_days = ?
       WHERE id = ?`,
      [name, gst_number, state, pincode, due_payment_days || 0, id]
    );
    req.flash('success', 'Party updated');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error updating party:', err);
    req.flash('error', 'Failed to update party');
    res.redirect('/purchase');
  }
});

// POST /purchase/factories - create a new factory
router.post('/factories', sapnaOnly, async (req, res) => {
  const { name, gst_number, state } = req.body;
  if (!name) {
    req.flash('error', 'Factory name is required');
    return res.redirect('/purchase');
  }
  try {
    await pool.query(
      `INSERT INTO factories (name, gst_number, state) VALUES (?, ?, ?)`,
      [name, gst_number, state]
    );
    req.flash('success', 'Factory created');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error creating factory:', err);
    req.flash('error', 'Failed to create factory');
    res.redirect('/purchase');
  }
});

// POST /purchase/factories/:id - update factory
router.post('/factories/:id', sapnaOnly, async (req, res) => {
  const id = req.params.id;
  const { name, gst_number, state } = req.body;
  try {
    await pool.query(
      `UPDATE factories SET name = ?, gst_number = ?, state = ? WHERE id = ?`,
      [name, gst_number, state, id]
    );
    req.flash('success', 'Factory updated');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error updating factory:', err);
    req.flash('error', 'Failed to update factory');
    res.redirect('/purchase');
  }
});

// GET /purchase/parties/template - download Excel template for bulk upload
router.get('/parties/template', sapnaOnly, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Parties');
    sheet.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'GST Number', key: 'gst_number', width: 20 },
      { header: 'State', key: 'state', width: 15 },
      { header: 'Pincode', key: 'pincode', width: 10 },
      { header: 'Due Payment Days', key: 'due_payment_days', width: 18 }
    ];
    sheet.addRow({
      name: 'ABC Traders',
      gst_number: '22AAAAA0000A1Z5',
      state: 'Karnataka',
      pincode: '560001',
      due_payment_days: 30
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=PartyTemplate.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating parties template:', err);
    req.flash('error', 'Failed to generate template');
    res.redirect('/purchase');
  }
});

// POST /purchase/parties/bulk - upload parties from Excel
router.post('/parties/bulk', sapnaOnly, upload.single('excelFile'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'No file uploaded');
    return res.redirect('/purchase');
  }
  let conn;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);
    const sheet = workbook.getWorksheet('Parties') || workbook.worksheets[0];
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = row.getCell(1).value ? row.getCell(1).value.toString().trim() : '';
      const gst_number = row.getCell(2).value ? row.getCell(2).value.toString().trim() : null;
      const state = row.getCell(3).value ? row.getCell(3).value.toString().trim() : null;
      const pincode = row.getCell(4).value ? row.getCell(4).value.toString().trim() : null;
      const dueVal = row.getCell(5).value;
      let due_payment_days = 0;
      if (dueVal) {
        const match = dueVal.toString().match(/\d+/);
        due_payment_days = match ? parseInt(match[0], 10) : 0;
      }
      if (name) rows.push([name, gst_number, state, pincode, due_payment_days]);
    });
    if (!rows.length) {
      throw new Error('No valid data found in file');
    }
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO parties (name, gst_number, state, pincode, due_payment_days) VALUES ?
       ON DUPLICATE KEY UPDATE name = VALUES(name), state = VALUES(state),
       pincode = VALUES(pincode), due_payment_days = VALUES(due_payment_days)`,
      [rows]
    );
    await conn.commit();
    req.flash('success', 'Parties uploaded successfully');
  } catch (err) {
    console.error('Error uploading parties:', err);
    if (conn) {
      await conn.rollback();
    }
    req.flash('error', err.message || 'Failed to upload parties');
  } finally {
    if (conn) conn.release();
    fs.unlink(file.path, () => {});
  }
  res.redirect('/purchase');
});

module.exports = router;
