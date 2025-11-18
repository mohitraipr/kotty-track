const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const {
  isAuthenticated,
  isIndentFiller,
  isStoreManager
} = require('../middlewares/auth');

const ALLOWED_STATUSES = ['open', 'proceeding', 'arrived'];

function sanitizeInteger(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function sanitizeDecimal(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function logStatusChange(requestId, userId, previousStatus, newStatus, note = null) {
  if (previousStatus === newStatus) {
    return;
  }
  try {
    await pool.query(
      `INSERT INTO indent_request_audit (request_id, changed_by, previous_status, new_status, note)
       VALUES (?, ?, ?, ?, ?)`,
      [requestId, userId, previousStatus, newStatus, note]
    );
  } catch (error) {
    console.warn('Could not write indent audit log:', error.message);
  }
}

router.get('/', isAuthenticated, isIndentFiller, async (req, res) => {
  try {
    const [requests] = await pool.query(
      `SELECT ir.*
         FROM indent_requests ir
        WHERE ir.filler_id = ?
        ORDER BY ir.created_at DESC
        LIMIT 200`,
      [req.session.user.id]
    );

    res.render('indentFillerDashboard', {
      user: req.session.user,
      requests
    });
  } catch (error) {
    console.error('Error loading indent filler dashboard:', error);
    req.flash('error', 'Unable to load your indent requests right now.');
    res.redirect('/');
  }
});

router.post('/create', isAuthenticated, isIndentFiller, async (req, res) => {
  const {
    goodsDescription,
    quantity,
    requestDate,
    usedLastMonth,
    usedLastSevenDays
  } = req.body;

  if (!goodsDescription || !quantity || !requestDate) {
    req.flash('error', 'Goods description, quantity and date are required.');
    return res.redirect('/indent');
  }

  const normalizedDescription = goodsDescription.trim();
  if (normalizedDescription.length > 255) {
    req.flash('error', 'Goods description should be under 255 characters.');
    return res.redirect('/indent');
  }

  const parsedQuantity = parseFloat(quantity);
  if (Number.isNaN(parsedQuantity) || parsedQuantity <= 0) {
    req.flash('error', 'Quantity must be a positive number.');
    return res.redirect('/indent');
  }

  try {
    await pool.query(
      `INSERT INTO indent_requests
         (filler_id, goods_description, quantity_requested, request_date,
          used_last_month, used_last_seven_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        normalizedDescription,
        parsedQuantity,
        requestDate,
        sanitizeInteger(usedLastMonth),
        sanitizeInteger(usedLastSevenDays)
      ]
    );

    req.flash('success', 'Indent request submitted successfully.');
    res.redirect('/indent');
  } catch (error) {
    console.error('Error creating indent request:', error);
    req.flash('error', 'Unable to submit your request at the moment.');
    res.redirect('/indent');
  }
});

router.get('/manage', isAuthenticated, isStoreManager, async (req, res) => {
  try {
    const [requests] = await pool.query(
      `SELECT ir.*, uf.username AS filler_name,
              up.username AS proceeded_by_name,
              ua.username AS arrived_by_name
         FROM indent_requests ir
    LEFT JOIN users uf ON ir.filler_id = uf.id
    LEFT JOIN users up ON ir.proceeded_by = up.id
    LEFT JOIN users ua ON ir.arrived_by = ua.id
     ORDER BY ir.created_at DESC
        LIMIT 400`
    );

    const [statsRows] = await pool.query(
      `SELECT status, COUNT(*) AS total
         FROM indent_requests
        GROUP BY status`
    );

    const stats = ALLOWED_STATUSES.reduce((acc, status) => {
      acc[status] = 0;
      return acc;
    }, {});
    statsRows.forEach(row => {
      if (ALLOWED_STATUSES.includes(row.status)) {
        stats[row.status] = row.total;
      }
    });

    res.render('storeManagerIndentDashboard', {
      user: req.session.user,
      requests,
      stats
    });
  } catch (error) {
    console.error('Error loading store manager dashboard:', error);
    req.flash('error', 'Unable to load indent requests right now.');
    res.redirect('/');
  }
});

router.post('/requests/:id/proceed', isAuthenticated, isStoreManager, async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    req.flash('error', 'Invalid request selected.');
    return res.redirect('/indent/manage');
  }

  try {
    const [[request]] = await pool.query(
      'SELECT status FROM indent_requests WHERE id = ?',
      [requestId]
    );

    if (!request) {
      req.flash('error', 'Indent request not found.');
      return res.redirect('/indent/manage');
    }

    if (request.status !== 'open') {
      req.flash('error', 'Only open requests can be moved to proceeding.');
      return res.redirect('/indent/manage');
    }

    await pool.query(
      `UPDATE indent_requests
          SET status = 'proceeding',
              proceed_date = NOW(),
              proceeded_by = ?
        WHERE id = ?`,
      [req.session.user.id, requestId]
    );

    await logStatusChange(requestId, req.session.user.id, request.status, 'proceeding');

    req.flash('success', 'Request marked as proceeding.');
    res.redirect('/indent/manage');
  } catch (error) {
    console.error('Error updating request status to proceeding:', error);
    req.flash('error', 'Unable to update the request.');
    res.redirect('/indent/manage');
  }
});

router.post('/requests/:id/arrive', isAuthenticated, isStoreManager, async (req, res) => {
  const requestId = Number(req.params.id);
  const { arrivalDate, finalQuantity, remark } = req.body;
  if (!Number.isInteger(requestId) || requestId <= 0) {
    req.flash('error', 'Invalid request selected.');
    return res.redirect('/indent/manage');
  }
  if (!arrivalDate) {
    req.flash('error', 'Arrival date is required.');
    return res.redirect('/indent/manage');
  }
  const normalizedArrival = arrivalDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedArrival)) {
    req.flash('error', 'Please provide arrival date in YYYY-MM-DD format.');
    return res.redirect('/indent/manage');
  }

  const parsedQuantity = sanitizeDecimal(finalQuantity);

  try {
    const [[request]] = await pool.query(
      'SELECT status FROM indent_requests WHERE id = ?',
      [requestId]
    );

    if (!request) {
      req.flash('error', 'Indent request not found.');
      return res.redirect('/indent/manage');
    }

    await pool.query(
      `UPDATE indent_requests
          SET status = 'arrived',
              arrival_date = ?,
              arrived_by = ?,
              final_quantity = ?,
              remark = ?,
              proceed_date = COALESCE(proceed_date, NOW()),
              proceeded_by = COALESCE(proceeded_by, ?)
        WHERE id = ?`,
      [
        normalizedArrival,
        req.session.user.id,
        parsedQuantity,
        remark ? remark.trim() : null,
        req.session.user.id,
        requestId
      ]
    );

    await logStatusChange(requestId, req.session.user.id, request.status, 'arrived', remark);

    req.flash('success', 'Request marked as arrived.');
    res.redirect('/indent/manage');
  } catch (error) {
    console.error('Error marking request as arrived:', error);
    req.flash('error', 'Unable to update the request.');
    res.redirect('/indent/manage');
  }
});

module.exports = router;
