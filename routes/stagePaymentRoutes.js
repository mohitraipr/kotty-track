/**
 * Stage Payment Routes
 * Unified payment system for all production stages
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isStitchingMaster, isWashingMaster } = require('../middlewares/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const STAGES = ['cutting', 'stitching', 'washing', 'assembly', 'finishing'];

// Helper: Get base rate for SKU + stage
async function getBaseRate(sku, stage) {
  const [[row]] = await pool.query(
    'SELECT rate FROM stage_rates WHERE sku = ? AND stage = ?',
    [sku, stage]
  );
  return row ? parseFloat(row.rate) : 0;
}

// Helper: Get extra rates for SKU + stage
async function getExtraRates(sku, stage) {
  const [rows] = await pool.query(
    'SELECT extra_name, rate FROM stage_extra_rates WHERE sku = ? AND stage = ?',
    [sku, stage]
  );
  return rows;
}

// Helper: Generate batch ID
function generateBatchId() {
  return `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

// =====================================================
// RATE CONFIGURATION (Operator only)
// =====================================================

// View all rates
router.get('/rates', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { stage = 'all', search = '' } = req.query;

    let rateQuery = 'SELECT * FROM stage_rates WHERE 1=1';
    const params = [];

    if (stage !== 'all') {
      rateQuery += ' AND stage = ?';
      params.push(stage);
    }
    if (search) {
      rateQuery += ' AND sku LIKE ?';
      params.push(`%${search}%`);
    }
    rateQuery += ' ORDER BY stage, sku';

    const [rates] = await pool.query(rateQuery, params);

    // Get extra rates grouped by sku+stage
    const [extraRates] = await pool.query(
      'SELECT * FROM stage_extra_rates ORDER BY sku, stage, extra_name'
    );

    // Group extra rates by sku_stage key
    const extraRatesMap = {};
    extraRates.forEach(er => {
      const key = `${er.sku}_${er.stage}`;
      if (!extraRatesMap[key]) extraRatesMap[key] = [];
      extraRatesMap[key].push(er);
    });

    res.render('stageRateConfig', {
      user: req.session.user,
      rates,
      extraRatesMap,
      stages: STAGES,
      currentStage: stage,
      search,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading rates:', err);
    req.flash('error', 'Failed to load rates');
    res.redirect('/operator/dashboard');
  }
});

// Download rate template
router.get('/rates/template', isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('StageRates');
    sheet.columns = [
      { header: 'sku', key: 'sku', width: 20 },
      { header: 'stage', key: 'stage', width: 12 },
      { header: 'rate', key: 'rate', width: 10 }
    ];
    sheet.addRow({ sku: 'EXAMPLE-SKU', stage: 'stitching', rate: 20 });
    sheet.addRow({ sku: 'EXAMPLE-SKU', stage: 'washing', rate: 15 });

    res.setHeader('Content-Disposition', 'attachment; filename="stage_rates_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating template:', err);
    req.flash('error', 'Failed to generate template');
    res.redirect('/operator/payments/rates');
  }
});

// Add/update single rate
router.post('/rates', isAuthenticated, isOperator, async (req, res) => {
  const { sku, stage, rate, redirect } = req.body;
  const redirectUrl = redirect || '/operator/payments/rates';

  if (!sku || !stage || !STAGES.includes(stage)) {
    req.flash('error', 'Invalid SKU or stage');
    return res.redirect(redirectUrl);
  }

  try {
    const skuUpper = sku.trim().toUpperCase();
    const rateValue = parseFloat(rate) || 0;

    await pool.query(
      `INSERT INTO stage_rates (sku, stage, rate, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()`,
      [skuUpper, stage, rateValue, req.session.user.id]
    );

    // Update any pending payments with rate_configured = 0 for this SKU+stage
    const [pendingPayments] = await pool.query(
      `SELECT id, qty FROM stage_payments
       WHERE sku = ? AND stage = ? AND status = 'pending' AND rate_configured = 0`,
      [skuUpper, stage]
    );

    if (pendingPayments.length > 0) {
      // Get extra rates for this SKU+stage
      const [extraRates] = await pool.query(
        `SELECT extra_name, rate FROM stage_extra_rates WHERE sku = ? AND stage = ?`,
        [skuUpper, stage]
      );

      for (const p of pendingPayments) {
        let extraAmount = 0;
        let extraRatesJson = null;

        if (extraRates.length > 0) {
          const extras = extraRates.map(e => ({ name: e.extra_name, rate: parseFloat(e.rate) }));
          extraRatesJson = JSON.stringify(extras);
          extraAmount = extras.reduce((sum, e) => sum + (e.rate * p.qty), 0);
        }

        const totalAmount = (rateValue * p.qty) + extraAmount;

        await pool.query(
          `UPDATE stage_payments
           SET base_rate = ?, extra_rates_json = ?, extra_amount = ?, total_amount = ?, rate_configured = 1, updated_at = NOW()
           WHERE id = ?`,
          [rateValue, extraRatesJson, extraAmount, totalAmount, p.id]
        );
      }
      req.flash('success', `Rate saved. Updated ${pendingPayments.length} pending payments.`);
    } else {
      req.flash('success', `Rate saved for ${sku} - ${stage}`);
    }
  } catch (err) {
    console.error('Error saving rate:', err);
    req.flash('error', 'Failed to save rate');
  }
  res.redirect(redirectUrl);
});

// Upload rates via Excel
router.post('/rates/upload', isAuthenticated, isOperator, upload.single('excelFile'), async (req, res) => {
  if (!req.file) {
    req.flash('error', 'No file uploaded');
    return res.redirect('/operator/payments/rates');
  }

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const inserts = [];
    rows.forEach(r => {
      const sku = String(r.sku || r.SKU || '').trim().toUpperCase();
      const stage = String(r.stage || r.Stage || '').trim().toLowerCase();
      const rate = parseFloat(r.rate || r.Rate);

      if (sku && STAGES.includes(stage) && !isNaN(rate)) {
        inserts.push([sku, stage, rate, req.session.user.id]);
      }
    });

    if (inserts.length) {
      const values = inserts.map(() => '(?, ?, ?, ?)').join(',');
      const params = inserts.flat();
      await pool.query(
        `INSERT INTO stage_rates (sku, stage, rate, created_by) VALUES ${values}
         ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()`,
        params
      );
      req.flash('success', `Uploaded ${inserts.length} rates`);
    } else {
      req.flash('error', 'No valid rows found. Ensure columns: sku, stage, rate');
    }
  } catch (err) {
    console.error('Error uploading rates:', err);
    req.flash('error', 'Failed to parse Excel file');
  }

  res.redirect('/operator/payments/rates');
});

// Delete rate
router.post('/rates/delete', isAuthenticated, isOperator, async (req, res) => {
  const { id } = req.body;
  try {
    await pool.query('DELETE FROM stage_rates WHERE id = ?', [id]);
    req.flash('success', 'Rate deleted');
  } catch (err) {
    console.error('Error deleting rate:', err);
    req.flash('error', 'Failed to delete rate');
  }
  res.redirect('/operator/payments/rates');
});

// Add extra rate
router.post('/extra-rates', isAuthenticated, isOperator, async (req, res) => {
  const { sku, stage, extra_name, rate } = req.body;

  if (!sku || !stage || !extra_name) {
    req.flash('error', 'All fields are required');
    return res.redirect('/operator/payments/rates');
  }

  try {
    await pool.query(
      `INSERT INTO stage_extra_rates (sku, stage, extra_name, rate, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rate = VALUES(rate)`,
      [sku.trim().toUpperCase(), stage, extra_name.trim(), parseFloat(rate) || 0, req.session.user.id]
    );
    req.flash('success', `Extra rate saved: ${extra_name}`);
  } catch (err) {
    console.error('Error saving extra rate:', err);
    req.flash('error', 'Failed to save extra rate');
  }
  res.redirect('/operator/payments/rates');
});

// Delete extra rate
router.post('/extra-rates/delete', isAuthenticated, isOperator, async (req, res) => {
  const { id } = req.body;
  try {
    await pool.query('DELETE FROM stage_extra_rates WHERE id = ?', [id]);
    req.flash('success', 'Extra rate deleted');
  } catch (err) {
    req.flash('error', 'Failed to delete');
  }
  res.redirect('/operator/payments/rates');
});

// =====================================================
// PAYMENT CREATION (Operator only)
// =====================================================

// Payment creation page
router.get('/create', isAuthenticated, isOperator, async (req, res) => {
  try {
    res.render('stagePaymentCreate', {
      user: req.session.user,
      stages: STAGES.filter(s => s !== 'cutting'), // Cutting handled separately
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading payment create:', err);
    req.flash('error', 'Failed to load page');
    res.redirect('/operator/dashboard');
  }
});

// API: Get eligible lots for a stage
router.get('/api/eligible-lots', isAuthenticated, isOperator, async (req, res) => {
  const { stage, search = '' } = req.query;

  if (!stage || !STAGES.includes(stage)) {
    return res.status(400).json({ error: 'Invalid stage' });
  }

  try {
    let query = '';
    const params = [];
    const searchLike = `%${search}%`;

    // Eligibility is sourced from the *_events tables (truth source).
    // Per-(lot, operator) a row is eligible when the operator has a
    // 'complete' event in their stage AND the downstream stage has any
    // 'approve' event (i.e. taken delivery), AND no non-cancelled payment
    // exists yet. Finishing has no downstream — completion alone qualifies.
    const stageConfig = {
      stitching: { eventsTbl: 'stitching_events',      downstream: ['jeans_assembly_events', 'finishing_events'] },
      assembly:  { eventsTbl: 'jeans_assembly_events', downstream: ['washing_events'] },
      washing:   { eventsTbl: 'washing_events',        downstream: ['washing_in_events'] },
      finishing: { eventsTbl: 'finishing_events',      downstream: [] },
    }[stage];

    if (!stageConfig) {
      return res.json({ lots: [], message: 'Stage not configured' });
    }

    const downstreamClause = stageConfig.downstream.length
      ? `AND (${stageConfig.downstream.map(t =>
          `EXISTS (SELECT 1 FROM ${t} d WHERE d.cutting_lot_id = cl.id AND d.event_type='approve')`
        ).join(' OR ')})`
      : '';

    query = `
      SELECT
        MIN(e.id)            AS source_id,
        cl.lot_no            AS lot_no,
        cl.manual_lot_number AS manual_lot_number,
        cl.sku               AS sku,
        SUM(e.pieces)        AS qty,
        e.operator_id        AS user_id,
        u.username           AS username,
        MIN(e.created_at)    AS created_at
      FROM ${stageConfig.eventsTbl} e
      JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
      JOIN users u         ON u.id = e.operator_id
      WHERE e.event_type = 'complete'
        ${downstreamClause}
        AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)
        AND NOT EXISTS (
          SELECT 1 FROM stage_payments sp
          WHERE sp.lot_no  = cl.lot_no
            AND sp.stage   = ?
            AND sp.user_id = e.operator_id
            AND sp.status != 'cancelled'
        )
      GROUP BY cl.id, e.operator_id, cl.lot_no, cl.manual_lot_number, cl.sku, u.username
      ORDER BY MIN(e.created_at) DESC
      LIMIT 100
    `;
    params.push(searchLike, searchLike, stage);

    const [lots] = await pool.query(query, params);

    // Enrich with rates
    for (const lot of lots) {
      lot.base_rate = await getBaseRate(lot.sku, stage);
      lot.extra_rates = await getExtraRates(lot.sku, stage);
      lot.base_amount = lot.base_rate * lot.qty;
    }

    res.json({ lots });
  } catch (err) {
    console.error('Error fetching eligible lots:', err);
    res.status(500).json({ error: 'Failed to fetch lots' });
  }
});

// Create payments
router.post('/create', isAuthenticated, isOperator, async (req, res) => {
  const { stage, payments } = req.body;

  if (!stage || !payments || !Array.isArray(payments) || !payments.length) {
    req.flash('error', 'No payments to create');
    return res.redirect('/operator/payments/create');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const p of payments) {
      const baseRate = parseFloat(p.base_rate) || 0;
      const extraAmount = parseFloat(p.extra_amount) || 0;
      const totalAmount = (baseRate * parseInt(p.qty)) + extraAmount;

      await conn.query(
        `INSERT INTO stage_payments
         (user_id, username, lot_no, sku, stage, qty, base_rate, extra_rates_json, extra_amount, total_amount, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.user_id,
          p.username,
          p.lot_no,
          p.sku,
          stage,
          p.qty,
          baseRate,
          p.extra_rates_json || null,
          extraAmount,
          totalAmount,
          req.session.user.id
        ]
      );
    }

    await conn.commit();
    req.flash('success', `Created ${payments.length} payment entries`);
  } catch (err) {
    await conn.rollback();
    console.error('Error creating payments:', err);
    req.flash('error', 'Failed to create payments');
  } finally {
    conn.release();
  }

  res.redirect('/operator/payments/pending');
});

// =====================================================
// PAYMENT MANAGEMENT (Operator only)
// =====================================================

// View pending payments
router.get('/pending', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { stage = 'all', search = '' } = req.query;

    let query = `
      SELECT sp.*,
             cl.manual_lot_number AS manual_lot_number,
             (SELECT SUM(amount) FROM stage_debits sd
              WHERE sd.user_id = sp.user_id AND sd.status = 'approved') AS total_debits
      FROM stage_payments sp
      LEFT JOIN cutting_lots cl ON cl.lot_no = sp.lot_no
      WHERE sp.status = 'pending'
    `;
    const params = [];

    if (stage !== 'all') {
      query += ' AND sp.stage = ?';
      params.push(stage);
    }
    if (search) {
      query += ' AND (sp.lot_no LIKE ? OR sp.username LIKE ? OR sp.sku LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    query += ' ORDER BY sp.created_at DESC';

    const [payments] = await pool.query(query, params);

    // Calculate totals by user
    const userTotals = {};
    payments.forEach(p => {
      if (!userTotals[p.user_id]) {
        userTotals[p.user_id] = { username: p.username, total: 0, count: 0, debits: p.total_debits || 0 };
      }
      userTotals[p.user_id].total += parseFloat(p.total_amount);
      userTotals[p.user_id].count++;
    });

    res.render('stagePaymentPending', {
      user: req.session.user,
      payments,
      userTotals,
      stages: STAGES,
      currentStage: stage,
      search,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading pending payments:', err);
    req.flash('error', 'Failed to load payments');
    res.redirect('/operator/dashboard');
  }
});

// Mark payments as paid
router.post('/mark-paid', isAuthenticated, isOperator, async (req, res) => {
  const { paymentIds, notes } = req.body;

  if (!paymentIds || !paymentIds.length) {
    req.flash('error', 'No payments selected');
    return res.redirect('/operator/payments/pending');
  }

  const ids = Array.isArray(paymentIds) ? paymentIds : [paymentIds];
  const batchId = generateBatchId();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Update payments
    await conn.query(
      `UPDATE stage_payments
       SET status = 'paid', paid_on = NOW(), paid_by = ?, batch_id = ?
       WHERE id IN (?) AND status = 'pending'`,
      [req.session.user.id, batchId, ids]
    );

    // Get total for batch record
    const [[totals]] = await conn.query(
      `SELECT stage, SUM(total_amount) AS total, COUNT(*) AS cnt
       FROM stage_payments WHERE batch_id = ? GROUP BY stage`,
      [batchId]
    );

    if (totals) {
      await conn.query(
        `INSERT INTO stage_payment_batches (batch_id, stage, total_amount, payment_count, paid_by, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [batchId, totals.stage, totals.total, totals.cnt, req.session.user.id, notes || null]
      );
    }

    await conn.commit();
    req.flash('success', `Marked ${ids.length} payments as paid. Batch: ${batchId}`);
  } catch (err) {
    await conn.rollback();
    console.error('Error marking payments:', err);
    req.flash('error', 'Failed to update payments');
  } finally {
    conn.release();
  }

  res.redirect('/operator/payments/pending');
});

// Edit payment (operator)
router.post('/edit/:id', isAuthenticated, isOperator, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const { qty, base_rate } = req.body;

    // Get payment details
    const [[payment]] = await pool.query(
      'SELECT * FROM stage_payments WHERE id = ? AND status = ?',
      [paymentId, 'pending']
    );

    if (!payment) {
      req.flash('error', 'Payment not found or already processed');
      return res.redirect('/operator/payments/pending');
    }

    // Calculate extra amount from existing extra_rates_json
    let extraAmount = 0;
    if (payment.extra_rates_json) {
      try {
        const extraRates = JSON.parse(payment.extra_rates_json);
        extraAmount = extraRates.reduce((sum, e) => sum + (parseFloat(e.rate) * parseInt(qty)), 0);
      } catch (e) {
        // Ignore JSON parse errors
      }
    }

    const totalAmount = (parseFloat(base_rate) * parseInt(qty)) + extraAmount;

    await pool.query(
      `UPDATE stage_payments
       SET qty = ?, base_rate = ?, extra_amount = ?, total_amount = ?, rate_configured = 1, updated_at = NOW()
       WHERE id = ?`,
      [qty, base_rate, extraAmount, totalAmount, paymentId]
    );

    req.flash('success', 'Payment updated successfully');
  } catch (err) {
    console.error('Error editing payment:', err);
    req.flash('error', 'Failed to update payment');
  }
  res.redirect('/operator/payments/pending');
});

// Cancel payment (operator)
router.post('/cancel/:id', isAuthenticated, isOperator, async (req, res) => {
  try {
    const paymentId = req.params.id;

    const [result] = await pool.query(
      `UPDATE stage_payments SET status = 'cancelled', updated_at = NOW() WHERE id = ? AND status = 'pending'`,
      [paymentId]
    );

    if (result.affectedRows > 0) {
      req.flash('success', 'Payment cancelled');
    } else {
      req.flash('error', 'Payment not found or already processed');
    }
  } catch (err) {
    console.error('Error cancelling payment:', err);
    req.flash('error', 'Failed to cancel payment');
  }
  res.redirect('/operator/payments/pending');
});

// Payment history
router.get('/history', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { stage = 'all', user_id, startDate, endDate } = req.query;

    let query = `SELECT sp.*, cl.manual_lot_number AS manual_lot_number
                   FROM stage_payments sp
              LEFT JOIN cutting_lots cl ON cl.lot_no = sp.lot_no
                  WHERE sp.status = ?`;
    const params = ['paid'];

    if (stage !== 'all') {
      query += ' AND sp.stage = ?';
      params.push(stage);
    }
    if (user_id) {
      query += ' AND sp.user_id = ?';
      params.push(user_id);
    }
    if (startDate) {
      query += ' AND DATE(sp.paid_on) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND DATE(sp.paid_on) <= ?';
      params.push(endDate);
    }
    query += ' ORDER BY sp.paid_on DESC LIMIT 500';

    const [payments] = await pool.query(query, params);

    // Get users for filter
    const [users] = await pool.query(
      'SELECT DISTINCT user_id, username FROM stage_payments ORDER BY username'
    );

    res.render('stagePaymentHistory', {
      user: req.session.user,
      payments,
      users,
      stages: STAGES,
      currentStage: stage,
      filters: { user_id, startDate, endDate }
    });
  } catch (err) {
    console.error('Error loading history:', err);
    req.flash('error', 'Failed to load history');
    res.redirect('/operator/dashboard');
  }
});

// Download history as Excel
router.get('/history/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { stage = 'all', startDate, endDate } = req.query;

    let query = `SELECT sp.*, cl.manual_lot_number AS manual_lot_number
                   FROM stage_payments sp
              LEFT JOIN cutting_lots cl ON cl.lot_no = sp.lot_no
                  WHERE 1=1`;
    const params = [];

    if (stage !== 'all') {
      query += ' AND sp.stage = ?';
      params.push(stage);
    }
    if (startDate) {
      query += ' AND DATE(sp.created_at) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND DATE(sp.created_at) <= ?';
      params.push(endDate);
    }
    query += ' ORDER BY sp.created_at DESC';

    const [rows] = await pool.query(query, params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payments');
    sheet.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'User', key: 'username', width: 15 },
      { header: 'Lot No', key: 'lot_no', width: 12 },
      { header: 'Manual Lot No', key: 'manual_lot_number', width: 14 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Stage', key: 'stage', width: 12 },
      { header: 'Qty', key: 'qty', width: 8 },
      { header: 'Base Rate', key: 'base_rate', width: 10 },
      { header: 'Extra', key: 'extra_amount', width: 10 },
      { header: 'Total', key: 'total_amount', width: 12 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Created', key: 'created_at', width: 18 },
      { header: 'Paid On', key: 'paid_on', width: 18 }
    ];
    rows.forEach(r => sheet.addRow(r));

    res.setHeader('Content-Disposition', 'attachment; filename="stage_payments.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading:', err);
    req.flash('error', 'Download failed');
    res.redirect('/operator/payments/history');
  }
});

// =====================================================
// DEBIT MANAGEMENT (Operator only)
// =====================================================

// View debits
router.get('/debits', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { status = 'all' } = req.query;

    let query = 'SELECT sd.*, u.username AS raised_by_name FROM stage_debits sd LEFT JOIN users u ON sd.raised_by = u.id';
    const params = [];

    if (status !== 'all') {
      query += ' WHERE sd.status = ?';
      params.push(status);
    }
    query += ' ORDER BY sd.created_at DESC';

    const [debits] = await pool.query(query, params);

    // Get users for dropdown
    const [users] = await pool.query(
      `SELECT DISTINCT u.id, u.username
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE r.name IN ('stitching_master', 'washing_master', 'supervisor')
       ORDER BY u.username`
    );

    res.render('stageDebitList', {
      user: req.session.user,
      debits,
      users,
      stages: STAGES,
      currentStatus: status,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading debits:', err);
    req.flash('error', 'Failed to load debits');
    res.redirect('/operator/dashboard');
  }
});

// Create debit
router.post('/debits', isAuthenticated, isOperator, async (req, res) => {
  const { user_id, lot_no, sku, stage, qty, rate, amount, reason } = req.body;

  if (!user_id || !stage || !amount || !reason) {
    req.flash('error', 'User, stage, amount and reason are required');
    return res.redirect('/operator/payments/debits');
  }

  try {
    // Get username
    const [[user]] = await pool.query('SELECT username FROM users WHERE id = ?', [user_id]);

    await pool.query(
      `INSERT INTO stage_debits (user_id, username, lot_no, sku, stage, qty, rate, amount, reason, raised_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        user?.username || 'Unknown',
        lot_no || null,
        sku || null,
        stage,
        qty || null,
        rate || null,
        parseFloat(amount),
        reason,
        req.session.user.id
      ]
    );
    req.flash('success', 'Debit created successfully');
  } catch (err) {
    console.error('Error creating debit:', err);
    req.flash('error', 'Failed to create debit');
  }
  res.redirect('/operator/payments/debits');
});

// Approve debit
router.post('/debits/approve/:id', isAuthenticated, isOperator, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE stage_debits SET status = 'approved', approved_by = ?, approved_on = NOW() WHERE id = ?`,
      [req.session.user.id, id]
    );
    req.flash('success', 'Debit approved');
  } catch (err) {
    req.flash('error', 'Failed to approve');
  }
  res.redirect('/operator/payments/debits');
});

// Reject debit
router.post('/debits/reject/:id', isAuthenticated, isOperator, async (req, res) => {
  const { id } = req.params;
  const { rejection_reason } = req.body;
  try {
    await pool.query(
      `UPDATE stage_debits SET status = 'rejected', approved_by = ?, approved_on = NOW(), rejection_reason = ? WHERE id = ?`,
      [req.session.user.id, rejection_reason || null, id]
    );
    req.flash('success', 'Debit rejected');
  } catch (err) {
    req.flash('error', 'Failed to reject');
  }
  res.redirect('/operator/payments/debits');
});

// =====================================================
// WORKER VIEW (Role-based access)
// =====================================================

// Check if user has worker role
function isWorker(req, res, next) {
  const role = req.session.user?.roleName;
  // Allow workers who get piece-rate payments
  if (['cutting_manager', 'stitching_master', 'washing', 'washing_in', 'finishing', 'jeans_assembly', 'supervisor'].includes(role)) {
    return next();
  }
  req.flash('error', 'Access denied');
  res.redirect('/');
}

// My payments view
router.get('/my-payments', isAuthenticated, isWorker, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { status = 'all' } = req.query;

    let query = 'SELECT * FROM stage_payments WHERE user_id = ?';
    const params = [userId];

    if (status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';

    const [payments] = await pool.query(query, params);

    // Get debits
    const [debits] = await pool.query(
      'SELECT * FROM stage_debits WHERE user_id = ? AND status = ? ORDER BY created_at DESC',
      [userId, 'approved']
    );

    // Calculate summaries (only include rate_configured payments in totals)
    const summary = {
      pending: payments.filter(p => p.status === 'pending' && p.rate_configured).reduce((sum, p) => sum + parseFloat(p.total_amount), 0),
      paid: payments.filter(p => p.status === 'paid').reduce((sum, p) => sum + parseFloat(p.total_amount), 0),
      debits: debits.reduce((sum, d) => sum + parseFloat(d.amount), 0),
      unconfigured: payments.filter(p => !p.rate_configured).length
    };

    res.render('myPayments', {
      user: req.session.user,
      payments,
      debits,
      summary,
      currentStatus: status
    });
  } catch (err) {
    console.error('Error loading my payments:', err);
    req.flash('error', 'Failed to load payments');
    res.redirect('/');
  }
});

module.exports = router;
