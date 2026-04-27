/**
 * Accounts Payment Routes
 * Routes for accounts team to mark payments as paid
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');

// Stages for filtering
const STAGES = ['cutting', 'stitching', 'washing', 'assembly', 'finishing'];

// Middleware: Check if user has accounts role
const isAccounts = (req, res, next) => {
  const userRole = req.session.user?.role?.toLowerCase() || '';
  // Allow accounts role or admin/operator for flexibility
  if (userRole === 'accounts' || userRole === 'admin' || userRole === 'operator') {
    return next();
  }
  req.flash('error', 'Access denied. Accounts role required.');
  return res.redirect('/');
};

// Generate batch ID
function generateBatchId() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `PAY-${dateStr}-${rand}`;
}

// View pending payments (accounts) - shows ALL pending including those without rates
router.get('/pending', isAuthenticated, isAccounts, async (req, res) => {
  try {
    const { stage = 'all', user_id, search = '', show = 'all' } = req.query;

    let query = `
      SELECT sp.*,
        cl.remark AS cutting_remark,
        cl.created_at AS cutting_date,
        cl.total_pieces AS cut_pieces
      FROM stage_payments sp
      LEFT JOIN cutting_lots cl ON cl.lot_no = sp.lot_no
      WHERE sp.status = 'pending'
    `;
    const params = [];

    // Filter by rate_configured if specified
    if (show === 'ready') {
      query += ' AND sp.rate_configured = 1';
    } else if (show === 'no-rate') {
      query += ' AND sp.rate_configured = 0';
    }

    if (stage !== 'all') {
      query += ' AND sp.stage = ?';
      params.push(stage);
    }
    if (user_id) {
      query += ' AND sp.user_id = ?';
      params.push(user_id);
    }
    if (search) {
      query += ' AND (sp.lot_no LIKE ? OR sp.username LIKE ? OR sp.sku LIKE ? OR cl.remark LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    query += ' ORDER BY sp.rate_configured DESC, sp.created_at DESC';

    const [payments] = await pool.query(query, params);

    // Get all workers for filter dropdown
    const [users] = await pool.query(
      `SELECT DISTINCT user_id, username FROM stage_payments WHERE status = 'pending' ORDER BY username`
    );

    // Calculate totals
    const totalPending = payments.filter(p => p.rate_configured).reduce((sum, p) => sum + parseFloat(p.total_amount || 0), 0);
    const noRateCount = payments.filter(p => !p.rate_configured).length;

    res.render('accountsPaymentList', {
      user: req.session.user,
      payments,
      users,
      stages: STAGES,
      currentStage: stage,
      currentUserId: user_id || '',
      search,
      show,
      totalPending,
      noRateCount,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading accounts payments:', err);
    req.flash('error', 'Failed to load payments');
    res.redirect('/');
  }
});

// Set rate for a payment (when rate not configured)
router.post('/set-rate/:id', isAuthenticated, isAccounts, async (req, res) => {
  try {
    const paymentId = req.params.id;
    const { base_rate } = req.body;

    if (!base_rate || isNaN(parseFloat(base_rate)) || parseFloat(base_rate) < 0) {
      return res.status(400).json({ error: 'Invalid rate' });
    }

    const [[payment]] = await pool.query('SELECT * FROM stage_payments WHERE id = ?', [paymentId]);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const rate = parseFloat(base_rate);
    const totalAmount = rate * payment.qty;

    await pool.query(
      `UPDATE stage_payments
       SET base_rate = ?, total_amount = ?, rate_configured = 1
       WHERE id = ?`,
      [rate, totalAmount, paymentId]
    );

    return res.json({
      success: true,
      message: `Rate set to ₹${rate} for ${payment.qty} pieces = ₹${totalAmount.toFixed(2)}`,
      total_amount: totalAmount
    });
  } catch (err) {
    console.error('Error setting rate:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Get payment details with lot info
router.get('/details/:id', isAuthenticated, isAccounts, async (req, res) => {
  try {
    const [[payment]] = await pool.query(`
      SELECT sp.*,
        cl.remark AS cutting_remark,
        cl.created_at AS cutting_date,
        cl.total_pieces AS cut_pieces,
        cu.username AS cutting_master
      FROM stage_payments sp
      LEFT JOIN cutting_lots cl ON cl.lot_no = sp.lot_no
      LEFT JOIN users cu ON cl.user_id = cu.id
      WHERE sp.id = ?
    `, [req.params.id]);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Get existing rate if any
    const [[rateConfig]] = await pool.query(
      `SELECT * FROM stage_rates WHERE sku = ? AND stage = ?`,
      [payment.sku, payment.stage]
    );

    return res.json({ payment, rateConfig });
  } catch (err) {
    console.error('Error getting payment details:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Mark payments as paid (accounts)
router.post('/mark-paid', isAuthenticated, isAccounts, async (req, res) => {
  const { paymentIds, payment_remark } = req.body;

  if (!paymentIds || !paymentIds.length) {
    req.flash('error', 'No payments selected');
    return res.redirect('/accounts/payments/pending');
  }

  const ids = Array.isArray(paymentIds) ? paymentIds : [paymentIds];
  const batchId = generateBatchId();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Update payments
    await conn.query(
      `UPDATE stage_payments
       SET status = 'paid', paid_on = NOW(), paid_by = ?, batch_id = ?, payment_remark = ?
       WHERE id IN (?) AND status = 'pending' AND rate_configured = 1`,
      [req.session.user.id, batchId, payment_remark || null, ids]
    );

    // Get totals for batch record
    const [stageGroups] = await conn.query(
      `SELECT stage, SUM(total_amount) AS total, COUNT(*) AS cnt
       FROM stage_payments WHERE batch_id = ? GROUP BY stage`,
      [batchId]
    );

    // Create batch records
    for (const group of stageGroups) {
      await conn.query(
        `INSERT INTO stage_payment_batches (batch_id, stage, total_amount, payment_count, paid_by, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [batchId, group.stage, group.total, group.cnt, req.session.user.id, payment_remark || null]
      );
    }

    await conn.commit();

    const totalPaid = stageGroups.reduce((sum, g) => sum + parseFloat(g.total), 0);
    req.flash('success', `Marked ${ids.length} payments as paid. Total: Rs. ${totalPaid.toLocaleString('en-IN')}. Batch: ${batchId}`);
  } catch (err) {
    await conn.rollback();
    console.error('Error marking payments:', err);
    req.flash('error', 'Failed to update payments');
  } finally {
    conn.release();
  }

  res.redirect('/accounts/payments/pending');
});

// Payment history (accounts view)
router.get('/history', isAuthenticated, isAccounts, async (req, res) => {
  try {
    const { stage = 'all', user_id, startDate, endDate } = req.query;

    let query = 'SELECT * FROM stage_payments WHERE status = ?';
    const params = ['paid'];

    if (stage !== 'all') {
      query += ' AND stage = ?';
      params.push(stage);
    }
    if (user_id) {
      query += ' AND user_id = ?';
      params.push(user_id);
    }
    if (startDate) {
      query += ' AND DATE(paid_on) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND DATE(paid_on) <= ?';
      params.push(endDate);
    }
    query += ' ORDER BY paid_on DESC LIMIT 500';

    const [payments] = await pool.query(query, params);

    const [users] = await pool.query(
      `SELECT DISTINCT user_id, username FROM stage_payments WHERE status = 'paid' ORDER BY username`
    );

    res.render('accountsPaymentHistory', {
      user: req.session.user,
      payments,
      users,
      stages: STAGES,
      currentStage: stage,
      filters: { user_id, startDate, endDate },
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading payment history:', err);
    req.flash('error', 'Failed to load history');
    res.redirect('/accounts/payments/pending');
  }
});

module.exports = router;
