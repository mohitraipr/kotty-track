const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isStitchingMaster, isOperator } = require('../middlewares/auth');

// ---------------------
// Helper to fetch rates
async function getSkuRate(sku) {
  const [[row]] = await pool.query('SELECT rate FROM stitching_rates WHERE sku = ?', [sku]);
  return row ? parseFloat(row.rate) : 0;
}

// ---------------------
// Contract wise payments
router.get('/contract', isAuthenticated, isStitchingMaster, async (req, res) => {
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
      LIMIT 50
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

router.post('/contract/pay', isAuthenticated, isStitchingMaster, async (req, res) => {
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
    res.redirect('/stitchingdashboard/payments/contract');
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

router.get('/operation', isAuthenticated, isStitchingMaster, async (req, res) => {
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
      LIMIT 50
    `, [userId]);

    res.render('stitchingOperationPayments', { user: req.session.user, lots, operations: OPERATIONS });
  } catch (err) {
    console.error('operation payments', err);
    res.status(500).send('Server error');
  }
});

router.post('/operation/pay', isAuthenticated, isStitchingMaster, async (req, res) => {
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
  res.render('stitchingRateConfig', { skuRows, opRows });
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

module.exports = router;
