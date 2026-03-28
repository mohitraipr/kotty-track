const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
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

// Helper to get store settings
async function getStoreSetting(key, defaultValue = 'true') {
  try {
    const [[row]] = await pool.query('SELECT setting_value FROM store_settings WHERE setting_key = ?', [key]);
    return row ? row.setting_value : defaultValue;
  } catch {
    return defaultValue;
  }
}

router.get('/', isAuthenticated, isIndentFiller, async (req, res) => {
  try {
    const [[requests], [goods], allowFreetext] = await Promise.all([
      pool.query(
        `SELECT ir.*, g.shade
           FROM indent_requests ir
      LEFT JOIN goods_inventory g ON ir.goods_id = g.id
          WHERE ir.filler_id = ?
          ORDER BY ir.created_at DESC
          LIMIT 200`,
        [req.session.user.id]
      ),
      pool.query('SELECT * FROM goods_inventory ORDER BY description_of_goods, shade, size'),
      getStoreSetting('allow_freetext_indent', 'true')
    ]);

    res.render('indentFillerDashboard', {
      user: req.session.user,
      requests,
      goods,
      allowFreetext: allowFreetext === 'true'
    });
  } catch (error) {
    console.error('Error loading indent filler dashboard:', error);
    req.flash('error', 'Unable to load your indent requests right now.');
    res.redirect('/');
  }
});

router.post('/create', isAuthenticated, isIndentFiller, async (req, res) => {
  const {
    goods_id,
    goodsDescription,
    quantity,
    requestDate,
    usedLastMonth,
    usedLastSevenDays
  } = req.body;

  if (!quantity || !requestDate) {
    req.flash('error', 'Quantity and date are required.');
    return res.redirect('/indent');
  }

  const parsedQuantity = parseFloat(quantity);
  if (Number.isNaN(parsedQuantity) || parsedQuantity <= 0) {
    req.flash('error', 'Quantity must be a positive number.');
    return res.redirect('/indent');
  }

  let resolvedGoodsId = null;
  let resolvedDescription = '';

  try {
    if (goods_id && parseInt(goods_id, 10) > 0) {
      // Selected from dropdown
      const [[item]] = await pool.query('SELECT * FROM goods_inventory WHERE id = ?', [goods_id]);
      if (!item) {
        req.flash('error', 'Selected item not found.');
        return res.redirect('/indent');
      }
      resolvedGoodsId = item.id;
      resolvedDescription = item.description_of_goods +
        (item.shade ? ' - ' + item.shade : '') +
        (item.size ? ' (' + item.size + ')' : '') +
        ' [' + item.unit + ']';
    } else if (goodsDescription && goodsDescription.trim()) {
      // Free-text entry - check if allowed
      const allowFreetext = await getStoreSetting('allow_freetext_indent', 'true');
      if (allowFreetext !== 'true') {
        req.flash('error', 'Free-text entry is disabled. Please select an item from the list.');
        return res.redirect('/indent');
      }
      resolvedDescription = goodsDescription.trim();
      if (resolvedDescription.length > 255) {
        req.flash('error', 'Goods description should be under 255 characters.');
        return res.redirect('/indent');
      }
    } else {
      req.flash('error', 'Please select or enter an item.');
      return res.redirect('/indent');
    }

    await pool.query(
      `INSERT INTO indent_requests
         (filler_id, goods_id, goods_description, quantity_requested, request_date,
          used_last_month, used_last_seven_days)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.id,
        resolvedGoodsId,
        resolvedDescription,
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
    const [[requests], [statsRows], allowFreetext, [goods]] = await Promise.all([
      pool.query(
        `SELECT ir.*, uf.username AS filler_name,
                up.username AS proceeded_by_name,
                ua.username AS arrived_by_name,
                g.qty AS current_stock, g.shade
           FROM indent_requests ir
      LEFT JOIN users uf ON ir.filler_id = uf.id
      LEFT JOIN users up ON ir.proceeded_by = up.id
      LEFT JOIN users ua ON ir.arrived_by = ua.id
      LEFT JOIN goods_inventory g ON ir.goods_id = g.id
       ORDER BY ir.created_at DESC
          LIMIT 400`
      ),
      pool.query(
        `SELECT status, COUNT(*) AS total
           FROM indent_requests
          GROUP BY status`
      ),
      getStoreSetting('allow_freetext_indent', 'true'),
      pool.query('SELECT * FROM goods_inventory ORDER BY description_of_goods, shade, size')
    ]);

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
      stats,
      goods,
      allowFreetext: allowFreetext === 'true'
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

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[request]] = await conn.query(
      'SELECT status, goods_id, quantity_requested FROM indent_requests WHERE id = ?',
      [requestId]
    );

    if (!request) {
      await conn.rollback();
      req.flash('error', 'Indent request not found.');
      return res.redirect('/indent/manage');
    }

    if (request.status !== 'proceeding') {
      await conn.rollback();
      req.flash('error', 'Only proceeding requests can be marked as arrived.');
      return res.redirect('/indent/manage');
    }

    await conn.query(
      `UPDATE indent_requests
          SET status = 'arrived',
              arrival_date = ?,
              arrived_by = ?,
              final_quantity = ?,
              remark = ?
        WHERE id = ?`,
      [
        normalizedArrival,
        req.session.user.id,
        parsedQuantity,
        remark ? remark.trim() : null,
        requestId
      ]
    );

    // Deduct dispatched quantity from goods_inventory if goods_id exists
    if (request.goods_id) {
      const deductQty = parsedQuantity || request.quantity_requested;
      await conn.query(
        'UPDATE goods_inventory SET qty = GREATEST(0, qty - ?) WHERE id = ?',
        [deductQty, request.goods_id]
      );
    }

    await conn.commit();

    await logStatusChange(requestId, req.session.user.id, request.status, 'arrived', remark);

    req.flash('success', 'Request marked as arrived and stock updated.');
    res.redirect('/indent/manage');
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('Error marking request as arrived:', error);
    req.flash('error', 'Unable to update the request.');
    res.redirect('/indent/manage');
  } finally {
    if (conn) conn.release();
  }
});

// Excel Export
router.get('/manage/export', isAuthenticated, isStoreManager, async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;

    let query = `
      SELECT ir.*,
             uf.username AS filler_name,
             up.username AS proceeded_by_name,
             ua.username AS arrived_by_name
        FROM indent_requests ir
   LEFT JOIN users uf ON ir.filler_id = uf.id
   LEFT JOIN users up ON ir.proceeded_by = up.id
   LEFT JOIN users ua ON ir.arrived_by = ua.id
       WHERE 1=1
    `;
    const params = [];

    if (status && ALLOWED_STATUSES.includes(status)) {
      query += ' AND ir.status = ?';
      params.push(status);
    }

    if (startDate) {
      query += ' AND ir.request_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND ir.request_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY ir.created_at DESC';

    const [requests] = await pool.query(query, params);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kotty Track';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Indent Requests');

    // Define columns
    sheet.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Goods Description', key: 'goods_description', width: 35 },
      { header: 'Qty Requested', key: 'quantity_requested', width: 14 },
      { header: 'Final Qty', key: 'final_quantity', width: 12 },
      { header: 'Indent Filler', key: 'filler_name', width: 18 },
      { header: 'Request Date', key: 'request_date', width: 14 },
      { header: 'Proceed Date', key: 'proceed_date', width: 14 },
      { header: 'Arrival Date', key: 'arrival_date', width: 14 },
      { header: 'Used Last Month', key: 'used_last_month', width: 16 },
      { header: 'Used Last 7 Days', key: 'used_last_seven_days', width: 16 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Proceeded By', key: 'proceeded_by_name', width: 16 },
      { header: 'Arrived By', key: 'arrived_by_name', width: 16 },
      { header: 'Remark', key: 'remark', width: 30 },
      { header: 'Created At', key: 'created_at', width: 18 }
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E40AF' }
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add data rows
    requests.forEach(row => {
      sheet.addRow({
        id: row.id,
        goods_description: row.goods_description,
        quantity_requested: row.quantity_requested,
        final_quantity: row.final_quantity || '',
        filler_name: row.filler_name || '',
        request_date: row.request_date ? new Date(row.request_date).toLocaleDateString('en-IN') : '',
        proceed_date: row.proceed_date ? new Date(row.proceed_date).toLocaleDateString('en-IN') : '',
        arrival_date: row.arrival_date ? new Date(row.arrival_date).toLocaleDateString('en-IN') : '',
        used_last_month: row.used_last_month || 0,
        used_last_seven_days: row.used_last_seven_days || 0,
        status: row.status,
        proceeded_by_name: row.proceeded_by_name || '',
        arrived_by_name: row.arrived_by_name || '',
        remark: row.remark || '',
        created_at: row.created_at ? new Date(row.created_at).toLocaleString('en-IN') : ''
      });
    });

    // Color code status cells
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const statusCell = row.getCell('status');
      const status = statusCell.value;
      if (status === 'open') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        statusCell.font = { color: { argb: 'FF9A3412' } };
      } else if (status === 'proceeding') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCFFAFE' } };
        statusCell.font = { color: { argb: 'FF155E75' } };
      } else if (status === 'arrived') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
        statusCell.font = { color: { argb: 'FF065F46' } };
      }
    });

    // Set response headers
    const filename = `indent_requests_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting indent requests:', error);
    req.flash('error', 'Unable to export indent requests.');
    res.redirect('/indent/manage');
  }
});

// JSON search for Select2 item dropdown
router.get('/api/items', isAuthenticated, async (req, res) => {
  const q = req.query.q || '';
  try {
    const [rows] = await pool.query(
      `SELECT id, description_of_goods, shade, size, unit, qty
         FROM goods_inventory
        WHERE description_of_goods LIKE CONCAT('%', ?, '%')
           OR shade LIKE CONCAT('%', ?, '%')
        ORDER BY description_of_goods, shade, size
        LIMIT 50`,
      [q, q]
    );
    res.json(rows.map(r => ({
      id: r.id,
      text: r.description_of_goods +
        (r.shade ? ' - ' + r.shade : '') +
        (r.size ? ' (' + r.size + ')' : '') +
        ' [' + r.unit + ']' +
        ' (Stock: ' + r.qty + ')'
    })));
  } catch (err) {
    console.error('Error searching items:', err);
    res.json([]);
  }
});

// Toggle free-text setting
router.post('/manage/settings', isAuthenticated, isStoreManager, async (req, res) => {
  const { allow_freetext } = req.body;
  try {
    await pool.query(
      `INSERT INTO store_settings (setting_key, setting_value) VALUES ('allow_freetext_indent', ?)
       ON DUPLICATE KEY UPDATE setting_value = ?`,
      [allow_freetext === 'true' ? 'true' : 'false', allow_freetext === 'true' ? 'true' : 'false']
    );
    req.flash('success', 'Setting updated.');
  } catch (err) {
    console.error('Error updating setting:', err);
    req.flash('error', 'Could not update setting.');
  }
  res.redirect('/indent/manage');
});

// Store manager can also create item types
router.post('/manage/items/create', isAuthenticated, isStoreManager, async (req, res) => {
  const { description, shade, unit, size } = req.body;
  if (!description || !unit) {
    req.flash('error', 'Name and Unit are required.');
    return res.redirect('/indent/manage');
  }
  try {
    await pool.query(
      'INSERT INTO goods_inventory (description_of_goods, shade, unit, size, qty) VALUES (?, ?, ?, ?, 0)',
      [description.trim(), shade || null, unit, size || null]
    );
    req.flash('success', 'Item type created.');
  } catch (err) {
    console.error('Error creating item type:', err);
    req.flash('error', 'Could not create item type.');
  }
  res.redirect('/indent/manage');
});

// Stock Analytics Dashboard
router.get('/manage/analytics', isAuthenticated, isStoreManager, async (req, res) => {
  try {
    // Get all goods with pending request counts
    const [items] = await pool.query(`
      SELECT g.*,
        COALESCE(pending.cnt, 0) AS pending_requests,
        COALESCE(pending.total_qty, 0) AS pending_qty
      FROM goods_inventory g
      LEFT JOIN (
        SELECT goods_id, COUNT(*) AS cnt, SUM(quantity_requested) AS total_qty
        FROM indent_requests
        WHERE status IN ('open', 'proceeding') AND goods_id IS NOT NULL
        GROUP BY goods_id
      ) pending ON g.id = pending.goods_id
      ORDER BY g.qty ASC, pending.cnt DESC
    `);

    // Get dispatch DRR (last 30 days)
    const [dispatchDRR] = await pool.query(`
      SELECT goods_id,
        SUM(CASE WHEN dispatched_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN quantity ELSE 0 END) AS usage_7d,
        SUM(CASE WHEN dispatched_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN quantity ELSE 0 END) AS usage_30d
      FROM dispatched_data
      WHERE dispatched_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY goods_id
    `);

    // Get indent-reported usage averages (from arrived requests)
    const [indentUsage] = await pool.query(`
      SELECT goods_id,
        AVG(used_last_month) AS avg_monthly,
        AVG(used_last_seven_days) AS avg_weekly
      FROM indent_requests
      WHERE status = 'arrived' AND goods_id IS NOT NULL
        AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
      GROUP BY goods_id
    `);

    // Build lookup maps
    const dispatchMap = {};
    dispatchDRR.forEach(r => { dispatchMap[r.goods_id] = r; });
    const indentMap = {};
    indentUsage.forEach(r => { indentMap[r.goods_id] = r; });

    // Calculate DRR and days-until-OOS for each item
    const analytics = items.map(item => {
      const dispatch = dispatchMap[item.id] || {};
      const indent = indentMap[item.id] || {};

      const dispatchDrrDaily = (dispatch.usage_30d || 0) / 30;
      const indentDrrDaily = (indent.avg_monthly || 0) / 30;

      let drr;
      if (dispatchDrrDaily > 0 && indentDrrDaily > 0) {
        drr = dispatchDrrDaily * 0.7 + indentDrrDaily * 0.3;
      } else {
        drr = dispatchDrrDaily || indentDrrDaily || 0;
      }

      const daysUntilOOS = drr > 0 ? Math.floor(item.qty / drr) : null;

      return {
        id: item.id,
        name: item.description_of_goods,
        shade: item.shade,
        size: item.size,
        unit: item.unit,
        qty: item.qty,
        usage_7d: dispatch.usage_7d || 0,
        usage_30d: dispatch.usage_30d || 0,
        drr: Math.round(drr * 100) / 100,
        days_until_oos: daysUntilOOS,
        pending_requests: item.pending_requests,
        pending_qty: item.pending_qty
      };
    });

    // Summary stats
    const totalItems = analytics.length;
    const outOfStock = analytics.filter(a => a.qty <= 0).length;
    const oosWithRequests = analytics.filter(a => a.qty <= 0 && a.pending_requests > 0).length;
    const criticalItems = analytics.filter(a => a.days_until_oos !== null && a.days_until_oos <= 7).length;

    res.render('storeManagerAnalytics', {
      user: req.session.user,
      analytics,
      stats: { totalItems, outOfStock, oosWithRequests, criticalItems }
    });
  } catch (error) {
    console.error('Error loading analytics:', error);
    req.flash('error', 'Unable to load analytics.');
    res.redirect('/indent/manage');
  }
});

module.exports = router;
