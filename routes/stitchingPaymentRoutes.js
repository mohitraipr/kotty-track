const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isStitchingMaster, isOperator, allowUserIds } = require('../middlewares/auth');

// Multer setup for Excel uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------
// Allowed user ids for payment pages
const CONTRACT_USERS = [6, 35];
const OPERATION_USERS = [8];

// ---------------------
// Helper to fetch rates
async function getSkuRate(sku) {
  const [[row]] = await pool.query('SELECT rate FROM stitching_rates WHERE sku = ?', [sku]);
  return row ? parseFloat(row.rate) : 0;
}

// ---------------------
// Contract wise payments
router.get('/contract', isAuthenticated, isStitchingMaster, allowUserIds(CONTRACT_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [rows] = await pool.query(`
      SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces, cl.remark AS cutting_remark
      FROM stitching_data sd
      LEFT JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
      JOIN jeans_assembly_assignments ja ON ja.stitching_assignment_id = sd.id
      WHERE sd.user_id = ?
        AND ja.is_approved = 1
        AND sd.lot_no NOT IN (
          SELECT lot_no FROM stitching_payments_contract WHERE master_id = ?
        )
      ORDER BY sd.created_at DESC
    `, [userId, userId]);

    for (const r of rows) {
      r.rate = await getSkuRate(r.sku);
      r.amount = r.rate * r.total_pieces;
    }

    res.render('stitchingContractPayments', { user: req.session.user, lots: rows });
  } catch (err) {
    console.error('contract payments list', err);
    res.status(500).send('Server error');
  }
});

router.get('/contract/summary', isAuthenticated, isStitchingMaster, allowUserIds(CONTRACT_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const ids = String(req.query.ids || '').split(',').map(id => parseInt(id, 10)).filter(Boolean);
    if (!ids.length) return res.redirect('/stitchingdashboard/payments/contract');
    const [rows] = await pool.query(
      `SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces
       FROM stitching_data sd
       WHERE sd.user_id = ? AND sd.id IN (?)`,
      [userId, ids]
    );
    for (const r of rows) {
      r.rate = await getSkuRate(r.sku);
      r.amount = r.rate * r.total_pieces;
    }
    const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);
    res.render('stitchingContractSummary', { lots: rows, totalAmount: totalAmount.toFixed(2) });
  } catch (err) {
    console.error('contract summary', err);
    res.status(500).send('Server error');
  }
});

router.get('/contract/history', isAuthenticated, isStitchingMaster, allowUserIds(CONTRACT_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [rows] = await pool.query(
      'SELECT lot_no, sku, qty, rate, amount, paid_on FROM stitching_payments_contract WHERE master_id = ? ORDER BY paid_on DESC',
      [userId]
    );

    const sessionsMap = new Map();
    rows.forEach(r => {
      const ts = r.paid_on.getTime();
      if (!sessionsMap.has(ts)) {
        sessionsMap.set(ts, { time: r.paid_on, payments: [], total: 0 });
      }
      const s = sessionsMap.get(ts);
      s.payments.push(r);
      s.total += parseFloat(r.amount);
    });
    const sessions = Array.from(sessionsMap.values()).sort((a, b) => b.time - a.time);

    res.render('stitchingContractHistory', { sessions });
  } catch (err) {
    console.error('contract history', err);
    res.status(500).send('Server error');
  }
});

router.get('/contract/receipt/:time', isAuthenticated, isStitchingMaster, allowUserIds(CONTRACT_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const ts = parseInt(req.params.time, 10);
    if (isNaN(ts)) return res.redirect('/stitchingdashboard/payments/contract/history');

    const paidTime = new Date(ts);
    const [rows] = await pool.query(
      'SELECT lot_no, sku, qty, rate, amount FROM stitching_payments_contract WHERE master_id = ? AND paid_on = ?',
      [userId, paidTime]
    );

    if (!rows.length) return res.redirect('/stitchingdashboard/payments/contract/history');

    const totalAmount = rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    res.render('stitchingContractReceipt', {
      payments: rows,
      paidAt: paidTime.toLocaleString('en-CA', { hour12: false }),
      totalAmount: totalAmount.toFixed(2)
    });
  } catch (err) {
    console.error('contract receipt', err);
    res.status(500).send('Server error');
  }
});

router.post('/contract/pay', isAuthenticated, isStitchingMaster, allowUserIds(CONTRACT_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { lotIds = [] } = req.body;
    if (!Array.isArray(lotIds) || !lotIds.length) return res.redirect('/stitchingdashboard/payments/contract');

    const [lots] = await pool.query(`
      SELECT sd.lot_no, sd.sku, sd.total_pieces
      FROM stitching_data sd
      WHERE sd.user_id = ? AND sd.id IN (?)
    `, [userId, lotIds]);

    const insertRows = [];
    for (const l of lots) {
      const rate = await getSkuRate(l.sku);
      const amt = rate * l.total_pieces;
      insertRows.push([userId, l.lot_no, l.sku, l.total_pieces, rate, amt]);
    }
    if (insertRows.length) {
      await pool.query(
        'INSERT INTO stitching_payments_contract (master_id, lot_no, sku, qty, rate, amount) VALUES ?',
        [insertRows]
      );
    }
    res.redirect('/stitchingdashboard/payments/contract/history');
  } catch (err) {
    console.error('contract pay', err);
    res.status(500).send('Server error');
  }
});

// ---------------------
// Operation wise payments
const OPERATIONS = ['BILT', 'FIVETHREAD', 'FITUP', 'BOTOOM', 'THOKA', '9 INCH'];

async function getOperationRate(op) {
  const [[row]] = await pool.query('SELECT rate FROM stitching_operation_rates WHERE operation = ?', [op]);
  return row ? parseFloat(row.rate) : 0;
}

router.get('/operation', isAuthenticated, isStitchingMaster, allowUserIds(OPERATION_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [lots] = await pool.query(`
      SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces, cl.remark AS cutting_remark
      FROM stitching_data sd
      LEFT JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
      JOIN jeans_assembly_assignments ja ON ja.stitching_assignment_id = sd.id
      WHERE sd.user_id = ?
        AND ja.is_approved = 1
      ORDER BY sd.created_at DESC
    `, [userId]);

    res.render('stitchingOperationPayments', { user: req.session.user, lots, operations: OPERATIONS });
  } catch (err) {
    console.error('operation payments', err);
    res.status(500).send('Server error');
  }
});

router.post('/operation/pay', isAuthenticated, isStitchingMaster, allowUserIds(OPERATION_USERS), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { lot_no, payments } = req.body; // payments should be JSON string [{operation, name, qty}]
    if (!lot_no || !payments) return res.redirect('/stitchingdashboard/payments/operation');
    let parsed;
    try { parsed = JSON.parse(payments); } catch { parsed = []; }
    const insertRows = [];
    for (const p of parsed) {
      const rate = await getOperationRate(p.operation);
      const amt = rate * Number(p.qty || 0);
      insertRows.push([userId, lot_no, p.operation, p.name, p.qty, rate, amt]);
    }
    if (insertRows.length) {
      await pool.query(
        'INSERT INTO stitching_operation_payments (master_id, lot_no, operation, worker_name, qty, rate, amount) VALUES ?',
        [insertRows]
      );
    }
    res.redirect('/stitchingdashboard/payments/operation');
  } catch (err) {
    console.error('operation pay', err);
    res.status(500).send('Server error');
  }
});

// ---------------------
// Operator rate configuration
router.get('/rates', isAuthenticated, isOperator, async (req, res) => {
  const [skuRows] = await pool.query('SELECT sku, rate FROM stitching_rates ORDER BY sku');
  const [opRows] = await pool.query('SELECT operation, rate FROM stitching_operation_rates ORDER BY operation');
  res.render('stitchingRateConfig', {
    skuRows,
    opRows,
    error: req.flash('error'),
    success: req.flash('success')
  });
});

// Download Excel template for rate uploads
router.get('/rates/template', isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('RatesTemplate');
    sheet.columns = [
      { header: 'sku', key: 'sku', width: 15 },
      { header: 'rate', key: 'rate', width: 10 }
    ];
    sheet.addRow({ sku: 'SKU001', rate: 0 });

    res.setHeader('Content-Disposition', 'attachment; filename="stitching_rates_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating rates template:', err);
    req.flash('error', 'Failed to generate template');
    res.redirect('/stitchingdashboard/payments/rates');
  }
});

router.post('/rates', isAuthenticated, isOperator, async (req, res) => {
  const { skuRates = '', opRates = '' } = req.body;
  const skuMap = {};
  skuRates.split(/\r?\n/).forEach(line => {
    const [sku, r] = line.split(':');
    if (sku && r) skuMap[sku.trim()] = parseFloat(r.trim()) || 0;
  });
  const opMap = {};
  opRates.split(/\r?\n/).forEach(line => {
    const [op, r] = line.split(':');
    if (op && r) opMap[op.trim()] = parseFloat(r.trim()) || 0;
  });
  const skuEntries = Object.entries(skuMap);
  if (skuEntries.length) {
    const values = skuEntries.map(() => '(?, ?)').join(',');
    const params = skuEntries.flatMap(x => x);
    await pool.query(`INSERT INTO stitching_rates (sku, rate) VALUES ${values} ON DUPLICATE KEY UPDATE rate = VALUES(rate)`, params);
  }
  const opEntries = Object.entries(opMap);
  if (opEntries.length) {
    const values = opEntries.map(() => '(?, ?)').join(',');
    const params = opEntries.flatMap(x => x);
    await pool.query(`INSERT INTO stitching_operation_rates (operation, rate) VALUES ${values} ON DUPLICATE KEY UPDATE rate = VALUES(rate)`, params);
  }
  res.redirect('/stitchingdashboard/payments/rates');
});

// Upload rates via Excel file
router.post('/rates/upload', isAuthenticated, isOperator, upload.single('excelFile'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'No file uploaded');
    return res.redirect('/stitchingdashboard/payments/rates');
  }

  let rows;
  try {
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (err) {
    console.error('Failed to parse Excel:', err);
    req.flash('error', 'Invalid Excel file');
    return res.redirect('/stitchingdashboard/payments/rates');
  }

  const inserts = [];
  rows.forEach(r => {
    const sku = String(r.sku || r.SKU || '').trim();
    const rate = parseFloat(r.rate || r.Rate);
    if (sku && !isNaN(rate)) inserts.push([sku, rate]);
  });

  if (inserts.length) {
    const values = inserts.map(() => '(?, ?)').join(',');
    const params = inserts.flat();
    try {
      await pool.query(`INSERT INTO stitching_rates (sku, rate) VALUES ${values} ON DUPLICATE KEY UPDATE rate = VALUES(rate)`, params);
      req.flash('success', `Uploaded ${inserts.length} rates`);
    } catch (err) {
      console.error('Error uploading rates:', err);
      req.flash('error', 'Failed to upload rates');
    }
  } else {
    req.flash('error', 'No valid rows found');
  }

  res.redirect('/stitchingdashboard/payments/rates');
});

// Update a single SKU rate
router.post('/rates/update', isAuthenticated, isOperator, async (req, res) => {
  const { sku, rate } = req.body;
  if (!sku) return res.redirect('/stitchingdashboard/payments/rates');
  try {
    await pool.query(
      'INSERT INTO stitching_rates (sku, rate) VALUES (?, ?) ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
      [sku.trim(), parseFloat(rate) || 0]
    );
    req.flash('success', 'Rate updated');
  } catch (err) {
    console.error('Error updating rate', err);
    req.flash('error', 'Failed to update rate');
  }
  res.redirect('/stitchingdashboard/payments/rates');
});

module.exports = router;
