const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isWashingMaster } = require('../middlewares/auth');

// Show washing item rates configuration
router.get('/rates', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT description, rate FROM washing_item_rates ORDER BY description'
    );
    res.render('washingRateConfig', {
      items: rows,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('fetch washing rates', err);
    req.flash('error', 'Failed to load rates');
    res.redirect('/operator');
  }
});

// Create or update an item rate
router.post('/rates/update', isAuthenticated, isOperator, async (req, res) => {
  const { description = '', rate = 0 } = req.body;
  if (!description.trim()) {
    return res.redirect('/washingdashboard/payments/rates');
  }
  try {
    await pool.query(
      'INSERT INTO washing_item_rates (description, rate) VALUES (?, ?) ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
      [description.trim(), parseFloat(rate) || 0]
    );
    req.flash('success', 'Rate saved');
  } catch (err) {
    console.error('save washing rate', err);
    req.flash('error', 'Failed to save rate');
  }
  res.redirect('/washingdashboard/payments/rates');
});

// ---------------------------------------------------------------------------
// Payment dashboard – pending lots grouped by washer
// ---------------------------------------------------------------------------
router.get('/', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.username, COUNT(*) AS lot_count
      FROM washing_data wd
      JOIN users u ON wd.user_id = u.id
      JOIN washing_in_assignments wia ON wia.washing_data_id = wd.id AND wia.is_approved = 1
      LEFT JOIN washing_invoice_items wii ON wii.washing_data_id = wd.id
      WHERE wii.id IS NULL
      GROUP BY u.id, u.username
      ORDER BY u.username
    `);
    res.render('washingPaymentDashboard', { washers: rows });
  } catch (err) {
    console.error('washing payment dashboard', err);
    res.status(500).send('Server error');
  }
});

// Fetch pending lots for a washer (AJAX)
router.get('/washer/:id/lots', isAuthenticated, isOperator, async (req, res) => {
  try {
    const washerId = parseInt(req.params.id, 10);
    const [rows] = await pool.query(
      `SELECT wd.id, wd.lot_no, wd.total_pieces
       FROM washing_data wd
       JOIN washing_in_assignments wia ON wia.washing_data_id = wd.id AND wia.is_approved = 1
       LEFT JOIN washing_invoice_items wii ON wii.washing_data_id = wd.id
       WHERE wii.id IS NULL AND wd.user_id = ?
       ORDER BY wd.id DESC`,
      [washerId]
    );
    res.json({ lots: rows });
  } catch (err) {
    console.error('fetch washer lots', err);
    res.status(500).json({ error: 'Failed to load lots' });
  }
});

// ---------------------------------------------------------------------------
// Summary page for selected lots
// ---------------------------------------------------------------------------
router.get('/summary', isAuthenticated, isOperator, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(id => parseInt(id, 10))
      .filter(Boolean);
    if (!ids.length) return res.redirect('/washingdashboard/payments');

    const [lots] = await pool.query(
      `SELECT wd.id, wd.lot_no, wd.total_pieces, wd.user_id, u.username
       FROM washing_data wd
       JOIN users u ON wd.user_id = u.id
       WHERE wd.id IN (?)`,
      [ids]
    );
    if (!lots.length) return res.redirect('/washingdashboard/payments');
    const washerId = lots[0].user_id;
    if (lots.some(l => l.user_id !== washerId)) {
      req.flash('error', 'Please select lots for a single washer.');
      return res.redirect('/washingdashboard/payments');
    }
    const [rates] = await pool.query('SELECT description, rate FROM washing_item_rates ORDER BY description');
    res.render('washingPaymentSummary', { lots, rates });
  } catch (err) {
    console.error('washing payment summary', err);
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------------------------
// Create invoice
// ---------------------------------------------------------------------------
router.post('/create', isAuthenticated, isOperator, async (req, res) => {
  const lotIds = Array.isArray(req.body.lotIds)
    ? req.body.lotIds.map(id => parseInt(id, 10))
    : [parseInt(req.body.lotIds, 10)].filter(Boolean);
  if (!lotIds.length) return res.redirect('/washingdashboard/payments');

  let conn;
  try {
    conn = await pool.getConnection();
    const [lots] = await conn.query(
      `SELECT id, lot_no, total_pieces, user_id FROM washing_data WHERE id IN (?)`,
      [lotIds]
    );
    if (!lots.length) {
      conn.release();
      return res.redirect('/washingdashboard/payments');
    }
    const washerId = lots[0].user_id;
    if (lots.some(l => l.user_id !== washerId)) {
      conn.release();
      req.flash('error', 'Invalid lot selection.');
      return res.redirect('/washingdashboard/payments');
    }

    let totalAmount = 0;
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO washing_invoices (washer_id, operator_id, total_amount, invoice_url, created_at)
       VALUES (?, ?, 0, '', NOW())`,
      [washerId, req.session.user.id]
    );
    const invoiceId = ins.insertId;

    for (const lot of lots) {
      const descs = req.body['desc_' + lot.id];
      if (!descs) continue;
      const descriptions = Array.isArray(descs) ? descs : [descs];
      for (const d of descriptions) {
        const [[rateRow]] = await conn.query(
          'SELECT rate FROM washing_item_rates WHERE description = ?',
          [d]
        );
        const rate = rateRow ? parseFloat(rateRow.rate) : 0;
        const amount = rate * lot.total_pieces;
        totalAmount += amount;
        await conn.query(
          `INSERT INTO washing_invoice_items (invoice_id, washing_data_id, lot_no, description, qty, rate, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [invoiceId, lot.id, lot.lot_no, d, lot.total_pieces, rate, amount]
        );
      }
    }

    await conn.query(
      'UPDATE washing_invoices SET total_amount = ?, invoice_url = ? WHERE id = ?',
      [totalAmount, `/washingdashboard/payments/invoice/${invoiceId}`, invoiceId]
    );
    await conn.commit();
    conn.release();
    res.redirect(`/washingdashboard/payments/invoice/${invoiceId}`);
  } catch (err) {
    console.error('washing payment create', err);
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------------------------
// Invoice list for operator
// ---------------------------------------------------------------------------
router.get('/invoices', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT wi.id, wi.total_amount, wi.created_at, u.username AS washer_name
      FROM washing_invoices wi
      JOIN users u ON wi.washer_id = u.id
      ORDER BY wi.created_at DESC
    `);
    res.render('washingInvoiceList', { invoices: rows, baseUrl: '/washingdashboard/payments/invoice/' });
  } catch (err) {
    console.error('washing invoice list', err);
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------------------------
// Invoice list for washer – only their invoices
// ---------------------------------------------------------------------------
router.get('/my-invoices', isAuthenticated, isWashingMaster, async (req, res) => {
  try {
    const washerId = req.session.user.id;
    const [rows] = await pool.query(
      `SELECT id, total_amount, created_at FROM washing_invoices WHERE washer_id = ? ORDER BY created_at DESC`,
      [washerId]
    );
    res.render('washingInvoiceList', { invoices: rows, baseUrl: '/washingdashboard/payments/invoice/' });
  } catch (err) {
    console.error('washer invoice list', err);
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------------------------
// View invoice details – allowed for operator or owning washer
// ---------------------------------------------------------------------------
router.get('/invoice/:id', isAuthenticated, async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id, 10);
    const [[invoice]] = await pool.query(
      `SELECT wi.*, u.username AS washer_name, op.username AS operator_name
       FROM washing_invoices wi
       JOIN users u ON wi.washer_id = u.id
       LEFT JOIN users op ON wi.operator_id = op.id
       WHERE wi.id = ?`,
      [invoiceId]
    );
    if (!invoice) return res.status(404).send('Not found');

    const user = req.session.user;
    if (user.roleName !== 'operator' && user.id !== invoice.washer_id) {
      req.flash('error', 'You do not have permission to view this invoice');
      return res.redirect('/');
    }

    const [items] = await pool.query(
      'SELECT lot_no, description, qty, rate, amount FROM washing_invoice_items WHERE invoice_id = ?',
      [invoiceId]
    );
    res.render('washingInvoice', { invoice, items });
  } catch (err) {
    console.error('washing invoice detail', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
