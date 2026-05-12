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

// Roles allowed to create indents from stage dashboards
const STAGE_INDENT_ROLES = ['stitching_master', 'jeans_assembly_master', 'finishing_master', 'finishing', 'cutting_master', 'operator', 'washing_in_master'];

// Map role to stage name
const ROLE_TO_STAGE = {
  stitching_master: 'Stitching',
  jeans_assembly_master: 'Jeans Assembly',
  finishing_master: 'Finishing',
  cutting_master: 'Cutting',
  operator: 'Operator',
  washing_in_master: 'Washing In'
};

// Middleware to check if user can create stage indents
function canCreateStageIndent(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (STAGE_INDENT_ROLES.includes(req.session.user.role)) {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Not authorized to create indents from stage dashboard' });
}

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

// One-time migration - auto-run on first load
let migrationRan = false;
let migrationRunning = false;
async function ensureMigration() {
  if (migrationRan || migrationRunning) return;
  migrationRunning = true;
  try {
    // Check if shade column exists
    const [cols] = await pool.query(`SHOW COLUMNS FROM goods_inventory LIKE 'shade'`);
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE goods_inventory ADD COLUMN shade VARCHAR(100) DEFAULT NULL AFTER size`);
    }
    // Ensure unit column is VARCHAR(50) to allow any unit value (e.g. GROSS)
    const [unitCol] = await pool.query(`SHOW COLUMNS FROM goods_inventory LIKE 'unit'`);
    if (unitCol.length > 0 && unitCol[0].Type && unitCol[0].Type.toLowerCase().startsWith('enum')) {
      await pool.query(`ALTER TABLE goods_inventory MODIFY COLUMN unit VARCHAR(50) NOT NULL`);
    }
    // Create store_settings
    await pool.query(`CREATE TABLE IF NOT EXISTS store_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value VARCHAR(500) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(`INSERT IGNORE INTO store_settings (setting_key, setting_value) VALUES ('allow_freetext_indent', 'true')`);
    // Add columns to incoming_data
    const [incCols] = await pool.query(`SHOW COLUMNS FROM incoming_data LIKE 'invoice_number'`);
    if (incCols.length === 0) {
      await pool.query(`ALTER TABLE incoming_data ADD COLUMN invoice_number VARCHAR(100) DEFAULT NULL, ADD COLUMN vendor_name VARCHAR(255) DEFAULT NULL, ADD COLUMN entry_date DATE DEFAULT NULL`);
    }
    // Add weight verification columns
    const [wCols] = await pool.query(`SHOW COLUMNS FROM incoming_data LIKE 'weight_per_gross'`);
    if (wCols.length === 0) {
      await pool.query(`ALTER TABLE incoming_data
        ADD COLUMN weight_per_gross DECIMAL(10,3) DEFAULT NULL,
        ADD COLUMN gross_count DECIMAL(10,3) DEFAULT NULL,
        ADD COLUMN actual_weight_kg DECIMAL(10,3) DEFAULT NULL,
        ADD COLUMN expected_weight_kg DECIMAL(10,3) DEFAULT NULL,
        ADD COLUMN weight_discrepancy_kg DECIMAL(10,3) DEFAULT NULL,
        ADD COLUMN weight_check_status ENUM('ok','short','over') DEFAULT NULL`);
    }
    // Create store_vendors
    await pool.query(`CREATE TABLE IF NOT EXISTS store_vendors (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    // Add goods_id to indent_requests
    const [irCols] = await pool.query(`SHOW COLUMNS FROM indent_requests LIKE 'goods_id'`);
    if (irCols.length === 0) {
      await pool.query(`ALTER TABLE indent_requests ADD COLUMN goods_id BIGINT UNSIGNED DEFAULT NULL AFTER filler_id`);
    }
    // Add lot_no and filler_stage columns for stage indent integration
    const [lotCol] = await pool.query(`SHOW COLUMNS FROM indent_requests LIKE 'lot_no'`);
    if (lotCol.length === 0) {
      await pool.query(`ALTER TABLE indent_requests ADD COLUMN lot_no VARCHAR(50) DEFAULT NULL AFTER filler_id`);
      await pool.query(`ALTER TABLE indent_requests ADD COLUMN filler_stage VARCHAR(50) DEFAULT NULL AFTER lot_no`);
      await pool.query(`CREATE INDEX idx_indent_requests_lot ON indent_requests(lot_no)`);
      await pool.query(`CREATE INDEX idx_indent_requests_stage ON indent_requests(filler_stage)`);
    }

    // ---- Lot-aware indent system migration ----
    // item_categories table
    await pool.query(`CREATE TABLE IF NOT EXISTS item_categories (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      display_label VARCHAR(80) NOT NULL,
      unit_default VARCHAR(20) NOT NULL DEFAULT 'PCS',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`INSERT IGNORE INTO item_categories (name, display_label, unit_default) VALUES
      ('zipper','Zipper','PCS'),
      ('button','Button','PCS'),
      ('dhaga','Dhaga (Thread)','CONE'),
      ('elastic','Elastic','MTR'),
      ('other','Other','PCS')`);

    // goods_inventory: category_id + variant_number
    const [catCol] = await pool.query(`SHOW COLUMNS FROM goods_inventory LIKE 'category_id'`);
    if (catCol.length === 0) {
      await pool.query(`ALTER TABLE goods_inventory ADD COLUMN category_id INT UNSIGNED DEFAULT NULL,
                        ADD COLUMN variant_number VARCHAR(50) DEFAULT NULL`);
      await pool.query(`CREATE INDEX idx_goods_category ON goods_inventory(category_id)`);
    }

    // Auto-classify existing goods rows by description heuristic (one-shot, only nulls)
    await pool.query(`UPDATE goods_inventory g
      JOIN item_categories c ON c.name = CASE
        WHEN LOWER(g.description_of_goods) LIKE '%zip%' THEN 'zipper'
        WHEN LOWER(g.description_of_goods) LIKE '%button%' OR LOWER(g.description_of_goods) LIKE '%btn%' THEN 'button'
        WHEN LOWER(g.description_of_goods) LIKE '%dhaga%' OR LOWER(g.description_of_goods) LIKE '%thread%' THEN 'dhaga'
        WHEN LOWER(g.description_of_goods) LIKE '%elastic%' THEN 'elastic'
        ELSE 'other' END
      SET g.category_id = c.id
      WHERE g.category_id IS NULL`);

    // cutting_lots.lot_type
    const [ltCol] = await pool.query(`SHOW COLUMNS FROM cutting_lots LIKE 'lot_type'`);
    if (ltCol.length === 0) {
      await pool.query(`ALTER TABLE cutting_lots ADD COLUMN lot_type ENUM('denim','hosiery','other') DEFAULT NULL`);
      await pool.query(`CREATE INDEX idx_cutting_lots_type ON cutting_lots(lot_type)`);
    }
    // Backfill lot_type from fabric_type
    await pool.query(`UPDATE cutting_lots SET lot_type = CASE
      WHEN LOWER(fabric_type) LIKE '%denim%' THEN 'denim'
      WHEN LOWER(fabric_type) LIKE '%hosi%' OR LOWER(fabric_type) LIKE '%knit%' THEN 'hosiery'
      ELSE 'other' END
      WHERE lot_type IS NULL`);

    // lot_material_consumption table
    await pool.query(`CREATE TABLE IF NOT EXISTS lot_material_consumption (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      indent_request_id BIGINT UNSIGNED NOT NULL,
      lot_no VARCHAR(50) NOT NULL,
      filler_stage VARCHAR(50) DEFAULT NULL,
      category_id INT UNSIGNED DEFAULT NULL,
      variant_number VARCHAR(50) DEFAULT NULL,
      goods_id BIGINT UNSIGNED DEFAULT NULL,
      planned_qty DECIMAL(12,2) NOT NULL,
      final_qty DECIMAL(12,2) DEFAULT NULL,
      status ENUM('open','proceeding','arrived','cancelled') DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      finalized_at DATETIME DEFAULT NULL,
      INDEX idx_lmc_lot (lot_no),
      INDEX idx_lmc_indent (indent_request_id),
      INDEX idx_lmc_cat (category_id, lot_no)
    )`);

    migrationRan = true;
    console.log('Store/indent migration completed successfully');
  } catch (err) {
    console.error('Migration error (non-fatal):', err.message);
    migrationRan = true; // Don't retry on every request
  }
}

// One-time: Reset all stock to 0
router.get('/manage/reset-stock', isAuthenticated, isStoreManager, async (req, res) => {
  try {
    const [result] = await pool.query('UPDATE goods_inventory SET qty = 0');
    res.json({ success: true, message: `Reset ${result.affectedRows} items to 0 stock` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
    await ensureMigration();
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
    await ensureMigration();
    const [[requests], [statsRows], allowFreetext, [goods]] = await Promise.all([
      pool.query(
        `SELECT ir.*, uf.username AS filler_name,
                up.username AS proceeded_by_name,
                ua.username AS arrived_by_name,
                g.qty AS current_stock, g.shade, g.variant_number,
                ic.name AS category_name, ic.display_label AS category_label,
                cl.sku AS lot_sku, cl.total_pieces AS lot_total_pieces, cl.lot_type
           FROM indent_requests ir
      LEFT JOIN users uf ON ir.filler_id = uf.id
      LEFT JOIN users up ON ir.proceeded_by = up.id
      LEFT JOIN users ua ON ir.arrived_by = ua.id
      LEFT JOIN goods_inventory g ON ir.goods_id = g.id
      LEFT JOIN item_categories ic ON ic.id = g.category_id
      LEFT JOIN cutting_lots cl ON cl.lot_no = ir.lot_no
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

    await pool.query(
      `UPDATE lot_material_consumption SET status = 'proceeding' WHERE indent_request_id = ?`,
      [requestId]
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
      if (deductQty > 0) {
        await conn.query(
          'UPDATE goods_inventory SET qty = GREATEST(0, qty - ?) WHERE id = ?',
          [deductQty, request.goods_id]
        );
      }
    }

    // Finalize lot-material consumption rows tied to this indent
    await conn.query(
      `UPDATE lot_material_consumption
          SET status = 'arrived',
              final_qty = COALESCE(?, planned_qty),
              finalized_at = NOW()
        WHERE indent_request_id = ?`,
      [parsedQuantity, requestId]
    );

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

// JSON search for Select2 item dropdown (optional category_id filter)
router.get('/api/items', isAuthenticated, async (req, res) => {
  const q = req.query.q || '';
  const categoryId = parseInt(req.query.category_id, 10);
  const categoryName = (req.query.category || '').toLowerCase().trim();
  try {
    let where = `(g.description_of_goods LIKE CONCAT('%', ?, '%') OR g.shade LIKE CONCAT('%', ?, '%') OR g.variant_number LIKE CONCAT('%', ?, '%'))`;
    const params = [q, q, q];
    if (Number.isInteger(categoryId) && categoryId > 0) {
      where += ' AND g.category_id = ?';
      params.push(categoryId);
    } else if (categoryName) {
      where += ' AND c.name = ?';
      params.push(categoryName);
    }
    const [rows] = await pool.query(
      `SELECT g.id, g.description_of_goods, g.shade, g.size, g.unit, g.qty,
              g.category_id, g.variant_number, c.name AS category_name, c.display_label AS category_label
         FROM goods_inventory g
    LEFT JOIN item_categories c ON c.id = g.category_id
        WHERE ${where}
        ORDER BY g.description_of_goods, g.variant_number, g.shade, g.size
        LIMIT 50`,
      params
    );
    res.json(rows.map(r => ({
      id: r.id,
      text: r.description_of_goods +
        (r.variant_number ? ' ' + r.variant_number : '') +
        (r.shade ? ' - ' + r.shade : '') +
        (r.size ? ' (' + r.size + ')' : '') +
        ' [' + r.unit + ']' +
        ' (Stock: ' + r.qty + ')',
      unit: r.unit,
      category_id: r.category_id,
      category_name: r.category_name,
      variant_number: r.variant_number
    })));
  } catch (err) {
    console.error('Error searching items:', err);
    res.json([]);
  }
});

// GET /indent/api/categories - list item categories
router.get('/api/categories', isAuthenticated, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, display_label, unit_default FROM item_categories ORDER BY id');
    res.json({ success: true, categories: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /indent/api/my-approved-lots?lot_type=denim
// Returns lots that the calling stage worker has approved/is processing,
// with total approved pieces (for auto-suggest qty) and lot_type.
router.get('/api/my-approved-lots', isAuthenticated, canCreateStageIndent, async (req, res) => {
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  const lotType = (req.query.lot_type || '').toLowerCase();
  try {
    let rows = [];
    if (userRole === 'stitching_master') {
      // Lots assigned & approved to this stitching master, with cutting lot info
      const [r] = await pool.query(
        `SELECT c.lot_no, c.sku, c.total_pieces, c.lot_type, c.fabric_type
           FROM stitching_assignments sa
           JOIN cutting_lots c ON c.id = sa.cutting_lot_id
          WHERE sa.user_id = ? AND sa.isApproved = 1
            ${lotType ? 'AND c.lot_type = ?' : ''}
          ORDER BY sa.approved_on DESC
          LIMIT 200`,
        lotType ? [userId, lotType] : [userId]
      );
      rows = r;
    } else if (userRole === 'cutting_master') {
      const [r] = await pool.query(
        `SELECT lot_no, sku, total_pieces, lot_type, fabric_type
           FROM cutting_lots
          WHERE user_id = ?
            ${lotType ? 'AND lot_type = ?' : ''}
          ORDER BY created_at DESC LIMIT 200`,
        lotType ? [userId, lotType] : [userId]
      );
      rows = r;
    } else {
      // For finishing/jeans-assembly/washing-in/operator: pull from their data table and join cutting_lots
      const stageTables = {
        finishing_master: 'finishing_data',
        jeans_assembly_master: 'jeans_assembly_data',
        washing_in_master: 'washing_in_data',
        operator: 'stitching_data'
      };
      const t = stageTables[userRole];
      if (t) {
        const [r] = await pool.query(
          `SELECT DISTINCT c.lot_no, c.sku, c.total_pieces, c.lot_type, c.fabric_type
             FROM ${t} s
             JOIN cutting_lots c ON c.lot_no = s.lot_no
            WHERE ${userRole === 'operator' ? '1=1' : 's.user_id = ?'}
              ${lotType ? 'AND c.lot_type = ?' : ''}
            ORDER BY s.created_at DESC
            LIMIT 200`,
          userRole === 'operator'
            ? (lotType ? [lotType] : [])
            : (lotType ? [userId, lotType] : [userId])
        );
        rows = r;
      }
    }
    res.json({ success: true, lots: rows });
  } catch (err) {
    console.error('Error /my-approved-lots:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /indent/api/lot-summary?lot_no=XXX
// Returns lot details + prior indent/consumption for the lot.
router.get('/api/lot-summary', isAuthenticated, async (req, res) => {
  const lotNo = (req.query.lot_no || '').trim();
  if (!lotNo) return res.status(400).json({ success: false, error: 'lot_no required' });
  try {
    const [[lot]] = await pool.query(
      `SELECT id, lot_no, sku, total_pieces, lot_type, fabric_type, remark
         FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
      [lotNo]
    );
    const [consumption] = await pool.query(
      `SELECT lmc.*, c.name AS category_name, c.display_label AS category_label,
              ir.status AS indent_status, ir.goods_description, u.username AS filler_name
         FROM lot_material_consumption lmc
    LEFT JOIN item_categories c ON c.id = lmc.category_id
    LEFT JOIN indent_requests ir ON ir.id = lmc.indent_request_id
    LEFT JOIN users u ON u.id = ir.filler_id
        WHERE lmc.lot_no = ?
        ORDER BY lmc.created_at DESC`,
      [lotNo]
    );
    res.json({ success: true, lot: lot || null, consumption });
  } catch (err) {
    console.error('Error /lot-summary:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /indent/api/bom-suggest?lot_nos=A,B,C&stage=Stitching
// Returns suggested BOM lines (zipper/button/dhaga25/dhaga50/elastic) for given lots.
router.get('/api/bom-suggest', isAuthenticated, canCreateStageIndent, async (req, res) => {
  const lotNos = (req.query.lot_nos || '').split(',').map(s => s.trim()).filter(Boolean);
  if (lotNos.length === 0) return res.json({ success: true, suggestions: [], lots: [] });
  try {
    const [lots] = await pool.query(
      `SELECT lot_no, sku, total_pieces, lot_type FROM cutting_lots WHERE lot_no IN (?)`,
      [lotNos]
    );
    const totalPieces = lots.reduce((s, l) => s + (Number(l.total_pieces) || 0), 0);
    const hasDenim = lots.some(l => l.lot_type === 'denim');
    const hasHosiery = lots.some(l => l.lot_type === 'hosiery');

    const suggestions = [];
    if (hasDenim) {
      suggestions.push({ category: 'zipper', label: 'Zipper', default_qty: totalPieces, unit: 'PCS', editable_variant: true, auto: true });
      suggestions.push({ category: 'button', label: 'Button', default_qty: totalPieces, unit: 'PCS', editable_variant: true, auto: true });
    }
    if (hasHosiery) {
      suggestions.push({ category: 'elastic', label: 'Elastic', default_qty: 0, unit: 'MTR', editable_variant: true, auto: true });
    }
    // Dhaga always — both 25 and 50 — qty manual (cones)
    suggestions.push({ category: 'dhaga', variant_number: '25', label: 'Dhaga 25 No.', default_qty: 0, unit: 'CONE', editable_variant: false, auto: true });
    suggestions.push({ category: 'dhaga', variant_number: '50', label: 'Dhaga 50 No.', default_qty: 0, unit: 'CONE', editable_variant: false, auto: true });

    res.json({ success: true, lots, total_pieces: totalPieces, suggestions });
  } catch (err) {
    console.error('Error /bom-suggest:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Toggle free-text setting
router.post('/manage/settings', isAuthenticated, isStoreManager, async (req, res) => {
  const raw = req.body.allow_freetext || req.body.allowFreetext;
  // When checkbox is checked, Express sends ['false','true'] (hidden + checkbox). Last value wins.
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const isEnabled = value === 'true' ? 'true' : 'false';
  try {
    await pool.query(
      `INSERT INTO store_settings (setting_key, setting_value) VALUES ('allow_freetext_indent', ?)
       ON DUPLICATE KEY UPDATE setting_value = ?`,
      [isEnabled, isEnabled]
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

// Store manager: Add stock to an item
router.post('/manage/stock/add', isAuthenticated, isStoreManager, async (req, res) => {
  const goodsId = req.body.goods_id;
  const qty = parseInt(req.body.quantity, 10);
  const invoiceNumber = req.body.invoice_number || null;
  const vendorName = req.body.vendor_name || null;
  const entryDate = req.body.entry_date || null;

  const weightPerGross = sanitizeDecimal(req.body.weight_per_gross);
  const grossCount = sanitizeDecimal(req.body.gross_count);
  const actualWeightKg = sanitizeDecimal(req.body.actual_weight_kg);

  let expectedWeightKg = null, discrepancyKg = null, weightCheckStatus = null;
  if (weightPerGross != null && grossCount != null && actualWeightKg != null) {
    expectedWeightKg = parseFloat(((weightPerGross * grossCount) / 1000).toFixed(3));
    discrepancyKg = parseFloat((actualWeightKg - expectedWeightKg).toFixed(3));
    weightCheckStatus = Math.abs(discrepancyKg) < 0.001 ? 'ok' : (discrepancyKg < 0 ? 'short' : 'over');
  }

  if (!goodsId || isNaN(qty) || qty <= 0) {
    req.flash('error', 'Select an item and enter a valid quantity.');
    return res.redirect('/indent/manage');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO incoming_data (goods_id, quantity, added_by, added_at, invoice_number, vendor_name, entry_date,
        weight_per_gross, gross_count, actual_weight_kg, expected_weight_kg, weight_discrepancy_kg, weight_check_status)
       VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [goodsId, qty, req.session.user.id, invoiceNumber, vendorName, entryDate,
       weightPerGross, grossCount, actualWeightKg, expectedWeightKg, discrepancyKg, weightCheckStatus]
    );
    await conn.query('UPDATE goods_inventory SET qty = qty + ? WHERE id = ?', [qty, goodsId]);
    if (vendorName) {
      await conn.query('INSERT IGNORE INTO store_vendors (name) VALUES (?)', [vendorName.trim()]);
    }
    await conn.commit();
    req.flash('success', 'Stock added successfully.');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('Error adding stock:', err);
    req.flash('error', 'Could not add stock.');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/indent/manage');
});

// Dispatch removed - stock deduction happens automatically when marking indent as arrived

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

// ═══════════════════════════════════════════════════════════════════════════
// STAGE WORKER INDENT ENDPOINTS
// Allows stitching/finishing/cutting/operator to create indents from their dashboards
// ═══════════════════════════════════════════════════════════════════════════

// POST /indent/stage-create - Bulk create indents from stage dashboard
router.post('/stage-create', isAuthenticated, canCreateStageIndent, async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'No items provided' });
  }

  if (items.length > 30) {
    return res.status(400).json({ success: false, error: 'Maximum 30 items per request' });
  }

  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  const fillerStage = ROLE_TO_STAGE[userRole] || userRole;
  const requestDate = new Date().toISOString().split('T')[0];

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const insertedIds = [];
    const duplicates = [];

    for (const item of items) {
      const { goods_id, goods_description, quantity, remark, category_id, variant_number } = item;
      // lot_nos: new array form; lot_no: legacy single. Falls back to [null].
      let lotNos = Array.isArray(item.lot_nos) ? item.lot_nos.filter(Boolean) : null;
      if (!lotNos || lotNos.length === 0) lotNos = [item.lot_no || null];

      if (!quantity || parseFloat(quantity) <= 0) {
        continue;
      }

      let resolvedGoodsId = null;
      let resolvedDescription = '';
      let resolvedCategoryId = category_id ? parseInt(category_id, 10) : null;
      let resolvedVariant = variant_number ? String(variant_number).trim().substring(0, 50) : null;

      if (goods_id && parseInt(goods_id, 10) > 0) {
        const [[goodsItem]] = await conn.query('SELECT * FROM goods_inventory WHERE id = ?', [goods_id]);
        if (goodsItem) {
          resolvedGoodsId = goodsItem.id;
          if (!resolvedCategoryId) resolvedCategoryId = goodsItem.category_id || null;
          if (!resolvedVariant) resolvedVariant = goodsItem.variant_number || null;
          resolvedDescription = goodsItem.description_of_goods +
            (goodsItem.variant_number ? ' ' + goodsItem.variant_number : '') +
            (goodsItem.shade ? ' - ' + goodsItem.shade : '') +
            (goodsItem.size ? ' (' + goodsItem.size + ')' : '') +
            ' [' + goodsItem.unit + ']';
        }
      } else if (goods_description && goods_description.trim()) {
        resolvedDescription = goods_description.trim().substring(0, 255);
      }

      if (!resolvedDescription) {
        continue;
      }

      const qty = parseFloat(quantity);
      // For multi-lot indents, qty is split proportionally if a per-lot qty array isn't sent.
      // Default: same qty replicated per lot UNLESS item.split_evenly === true.
      const qtyPerLot = item.split_evenly && lotNos.length > 1
        ? +(qty / lotNos.length).toFixed(2)
        : qty;

      for (const lot of lotNos) {
        // Duplicate guard: an open/proceeding indent already exists for this (lot, category, variant)
        if (lot && resolvedCategoryId) {
          const [dup] = await conn.query(
            `SELECT ir.id FROM indent_requests ir
              WHERE ir.lot_no = ? AND ir.status IN ('open','proceeding')
                AND EXISTS (SELECT 1 FROM lot_material_consumption lmc
                             WHERE lmc.indent_request_id = ir.id
                               AND lmc.category_id = ?
                               AND COALESCE(lmc.variant_number,'') = COALESCE(?, ''))
              LIMIT 1`,
            [lot, resolvedCategoryId, resolvedVariant]
          );
          if (dup.length > 0 && !item.allow_duplicate) {
            duplicates.push({ lot_no: lot, category_id: resolvedCategoryId, variant_number: resolvedVariant });
            continue;
          }
        }

        const [result] = await conn.query(
          `INSERT INTO indent_requests
             (filler_id, lot_no, filler_stage, goods_id, goods_description, quantity_requested, request_date, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            lot || null,
            fillerStage,
            resolvedGoodsId,
            resolvedDescription,
            qtyPerLot,
            requestDate,
            remark ? remark.trim().substring(0, 255) : null
          ]
        );

        // Always write consumption audit row when lot is known
        if (lot) {
          await conn.query(
            `INSERT INTO lot_material_consumption
               (indent_request_id, lot_no, filler_stage, category_id, variant_number, goods_id, planned_qty, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
            [result.insertId, lot, fillerStage, resolvedCategoryId, resolvedVariant, resolvedGoodsId, qtyPerLot]
          );
        }

        insertedIds.push(result.insertId);
      }
    }

    await conn.commit();

    if (insertedIds.length === 0 && duplicates.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Duplicate indent already pending for this lot+item.',
        duplicates,
        count: 0
      });
    }

    res.json({
      success: true,
      message: `Created ${insertedIds.length} indent request(s)`,
      count: insertedIds.length,
      duplicates
    });
  } catch (error) {
    if (conn) await conn.rollback();
    console.error('Error creating stage indents:', error);
    res.status(500).json({ success: false, error: 'Failed to create indent requests' });
  } finally {
    if (conn) conn.release();
  }
});

// GET /indent/my-requests - Get user's recent indent requests
router.get('/my-requests', isAuthenticated, canCreateStageIndent, async (req, res) => {
  const userId = req.session.user.id;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const [requests] = await pool.query(
      `SELECT ir.id, ir.goods_description, ir.quantity_requested, ir.lot_no, ir.filler_stage,
              ir.status, ir.remark, ir.created_at,
              cl.sku AS lot_sku, cl.lot_type
         FROM indent_requests ir
    LEFT JOIN cutting_lots cl ON cl.lot_no = ir.lot_no
        WHERE ir.filler_id = ?
        ORDER BY ir.created_at DESC
        LIMIT ?`,
      [userId, limit]
    );

    res.json({ success: true, requests });
  } catch (error) {
    console.error('Error fetching user indent requests:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch requests' });
  }
});

// GET /indent/recent-lots - Get user's recent lots for dropdown
router.get('/recent-lots', isAuthenticated, canCreateStageIndent, async (req, res) => {
  const userId = req.session.user.id;
  const userRole = req.session.user.role;

  try {
    let recentLots = [];

    // Get lots based on user's stage
    if (userRole === 'stitching_master') {
      const [lots] = await pool.query(
        `SELECT DISTINCT lot_no
           FROM stitching_data
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId]
      );
      recentLots = lots.map(l => l.lot_no);
    } else if (userRole === 'finishing_master') {
      const [lots] = await pool.query(
        `SELECT DISTINCT lot_no
           FROM finishing_data
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId]
      );
      recentLots = lots.map(l => l.lot_no);
    } else if (userRole === 'cutting_master') {
      const [lots] = await pool.query(
        `SELECT DISTINCT lot_no
           FROM cutting_lots
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId]
      );
      recentLots = lots.map(l => l.lot_no);
    } else if (userRole === 'jeans_assembly_master') {
      const [lots] = await pool.query(
        `SELECT DISTINCT lot_no
           FROM jeans_assembly_data
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId]
      );
      recentLots = lots.map(l => l.lot_no);
    } else if (userRole === 'operator') {
      const [lots] = await pool.query(
        `SELECT DISTINCT lot_no
           FROM stitching_data
          ORDER BY created_at DESC
          LIMIT 20`
      );
      recentLots = lots.map(l => l.lot_no);
    } else if (userRole === 'washing_in_master') {
      const [lots] = await pool.query(
        `SELECT DISTINCT lot_no
           FROM washing_in_data
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20`,
        [userId]
      );
      recentLots = lots.map(l => l.lot_no);
    }

    res.json({ success: true, lots: recentLots });
  } catch (error) {
    console.error('Error fetching recent lots:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch lots' });
  }
});

module.exports = router;
