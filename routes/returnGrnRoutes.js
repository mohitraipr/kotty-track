/**
 * Return GRN (Goods Received Note) Routes
 * Handles return scanning by warehouse employees
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, hasRole } = require('../middlewares/auth');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const ExcelJS = require('exceljs');
const { getReturnsList, getAllReturns } = require('../utils/easyecomReturnsClient');

// GCS setup for image uploads
const storage = new Storage();
const bucketName = process.env.GCS_BUCKET || 'kotty-uploads';

// Multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images and videos allowed.'));
    }
  }
});

// Helper to format date to IST
function formatISTDateTime() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(',', '').replace(/\//g, '-');
}

// Helper to get IST date string
function getISTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Allowed roles for GRN scanning
const allowGrnAccess = (req, res, next) => {
  const allowedRoles = ['return_grn', 'returns_operator', 'admin', 'operator'];
  if (req.session.user && allowedRoles.includes(req.session.user.role)) {
    return next();
  }
  req.flash('error', 'Access denied. You do not have permission to access Return GRN.');
  res.redirect('/login');
};

// Operator-only access
const allowOperatorAccess = (req, res, next) => {
  const allowedRoles = ['returns_operator', 'admin', 'operator'];
  if (req.session.user && allowedRoles.includes(req.session.user.role)) {
    return next();
  }
  req.flash('error', 'Access denied. Operator access required.');
  res.redirect('/login');
};

/**
 * Employee Scan Page
 */
router.get('/scan', isAuthenticated, allowGrnAccess, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const today = getISTDate();

    // Get today's scans for this employee
    const [recentScans] = await pool.query(
      `SELECT id, awb, status, image_url, scanned_at, is_matched
       FROM return_grn_scans
       WHERE employee_id = ? AND DATE(scanned_at) = ?
       ORDER BY scanned_at DESC
       LIMIT 20`,
      [userId, today]
    );

    // Get today's counts
    const [counts] = await pool.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'good' THEN 1 ELSE 0 END) as good_count,
         SUM(CASE WHEN status = 'bad' THEN 1 ELSE 0 END) as bad_count
       FROM return_grn_scans
       WHERE employee_id = ? AND DATE(scanned_at) = ?`,
      [userId, today]
    );

    res.render('returnGrnScan', {
      user: req.session.user,
      recentScans,
      counts: counts[0],
      today
    });
  } catch (error) {
    console.error('Error loading GRN scan page:', error);
    req.flash('error', 'Failed to load scan page');
    res.redirect('/');
  }
});

/**
 * Submit AWB scan
 */
router.post('/scan', isAuthenticated, allowGrnAccess, upload.single('image'), async (req, res) => {
  const { awb, status } = req.body;
  const userId = req.session.user.id;
  const userName = req.session.user.username;

  if (!awb || !awb.trim()) {
    return res.status(400).json({ success: false, error: 'AWB is required' });
  }

  const trimmedAwb = awb.trim().toUpperCase();

  try {
    // Check for duplicate AWB
    const [existing] = await pool.query(
      'SELECT id, scanned_at, employee_name FROM return_grn_scans WHERE awb = ?',
      [trimmedAwb]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        error: `AWB already scanned by ${existing[0].employee_name} at ${new Date(existing[0].scanned_at).toLocaleString('en-IN')}`
      });
    }

    // Upload image to GCS if provided
    let imageUrl = null;
    if (req.file && status === 'bad') {
      const fileName = `return-grn/${getISTDate()}/${trimmedAwb}-${Date.now()}${path.extname(req.file.originalname)}`;
      const bucket = storage.bucket(bucketName);
      const blob = bucket.file(fileName);

      await blob.save(req.file.buffer, {
        contentType: req.file.mimetype,
        metadata: { cacheControl: 'public, max-age=31536000' }
      });

      imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    }

    // Insert scan record
    const scannedAt = formatISTDateTime();
    const [result] = await pool.query(
      `INSERT INTO return_grn_scans
       (awb, employee_id, employee_name, status, image_url, scanned_at, warehouse)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [trimmedAwb, userId, userName, status || 'good', imageUrl, scannedAt, 'faridabad']
    );

    // Get updated counts
    const today = getISTDate();
    const [counts] = await pool.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'good' THEN 1 ELSE 0 END) as good_count,
         SUM(CASE WHEN status = 'bad' THEN 1 ELSE 0 END) as bad_count
       FROM return_grn_scans
       WHERE employee_id = ? AND DATE(scanned_at) = ?`,
      [userId, today]
    );

    res.json({
      success: true,
      message: 'AWB scanned successfully',
      scan: {
        id: result.insertId,
        awb: trimmedAwb,
        status: status || 'good',
        scanned_at: scannedAt,
        image_url: imageUrl
      },
      counts: counts[0]
    });
  } catch (error) {
    console.error('Error saving GRN scan:', error);
    res.status(500).json({ success: false, error: 'Failed to save scan' });
  }
});

/**
 * Update scan (within 30 min window)
 */
router.put('/scan/:id', isAuthenticated, allowGrnAccess, upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const userId = req.session.user.id;

  try {
    // Check if scan exists and belongs to user, and is within 30 min
    const [scan] = await pool.query(
      `SELECT * FROM return_grn_scans
       WHERE id = ? AND employee_id = ?
       AND TIMESTAMPDIFF(MINUTE, scanned_at, NOW()) <= 30`,
      [id, userId]
    );

    if (scan.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Cannot edit. Either not your scan or 30 minute window expired.'
      });
    }

    // Upload new image if provided
    let imageUrl = scan[0].image_url;
    if (req.file && status === 'bad') {
      const fileName = `return-grn/${getISTDate()}/${scan[0].awb}-${Date.now()}${path.extname(req.file.originalname)}`;
      const bucket = storage.bucket(bucketName);
      const blob = bucket.file(fileName);

      await blob.save(req.file.buffer, {
        contentType: req.file.mimetype,
        metadata: { cacheControl: 'public, max-age=31536000' }
      });

      imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    }

    await pool.query(
      'UPDATE return_grn_scans SET status = ?, image_url = ? WHERE id = ?',
      [status || scan[0].status, imageUrl, id]
    );

    res.json({ success: true, message: 'Scan updated' });
  } catch (error) {
    console.error('Error updating GRN scan:', error);
    res.status(500).json({ success: false, error: 'Failed to update scan' });
  }
});

/**
 * Delete scan (within 30 min window)
 */
router.delete('/scan/:id', isAuthenticated, allowGrnAccess, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.user.id;

  try {
    const [result] = await pool.query(
      `DELETE FROM return_grn_scans
       WHERE id = ? AND employee_id = ?
       AND TIMESTAMPDIFF(MINUTE, scanned_at, NOW()) <= 30`,
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(403).json({
        success: false,
        error: 'Cannot delete. Either not your scan or 30 minute window expired.'
      });
    }

    res.json({ success: true, message: 'Scan deleted' });
  } catch (error) {
    console.error('Error deleting GRN scan:', error);
    res.status(500).json({ success: false, error: 'Failed to delete scan' });
  }
});

/**
 * Operator Dashboard
 */
router.get('/dashboard', isAuthenticated, allowOperatorAccess, async (req, res) => {
  try {
    const today = getISTDate();

    // Get summary stats
    const [stats] = await pool.query(
      `SELECT
         COUNT(*) as total_scanned,
         SUM(CASE WHEN is_matched = 1 THEN 1 ELSE 0 END) as matched,
         SUM(CASE WHEN is_matched = 0 THEN 1 ELSE 0 END) as unmatched,
         SUM(CASE WHEN status = 'good' THEN 1 ELSE 0 END) as good_count,
         SUM(CASE WHEN status = 'bad' THEN 1 ELSE 0 END) as bad_count
       FROM return_grn_scans
       WHERE DATE(scanned_at) = ?`,
      [today]
    );

    // Get employee list for filter
    const [employees] = await pool.query(
      `SELECT DISTINCT employee_id, employee_name
       FROM return_grn_scans
       ORDER BY employee_name`
    );

    res.render('returnGrnDashboard', {
      user: req.session.user,
      stats: stats[0],
      employees,
      today
    });
  } catch (error) {
    console.error('Error loading GRN dashboard:', error);
    req.flash('error', 'Failed to load dashboard');
    res.redirect('/');
  }
});

/**
 * Get scans data (for dashboard table)
 */
router.get('/data', isAuthenticated, allowOperatorAccess, async (req, res) => {
  const { fromDate, toDate, employeeId, status, matched } = req.query;

  try {
    let query = `
      SELECT id, awb, employee_id, employee_name, status, image_url,
             scanned_at, warehouse, is_matched, matched_at,
             ee_order_id, ee_reference_code, ee_sku, ee_customer_name,
             ee_marketplace, ee_return_type, ee_amount
      FROM return_grn_scans
      WHERE 1=1
    `;
    const params = [];

    if (fromDate) {
      query += ' AND DATE(scanned_at) >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      query += ' AND DATE(scanned_at) <= ?';
      params.push(toDate);
    }
    if (employeeId) {
      query += ' AND employee_id = ?';
      params.push(employeeId);
    }
    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    if (matched === 'yes') {
      query += ' AND is_matched = 1';
    } else if (matched === 'no') {
      query += ' AND is_matched = 0';
    }

    query += ' ORDER BY scanned_at DESC LIMIT 1000';

    const [scans] = await pool.query(query, params);

    res.json({ success: true, data: scans });
  } catch (error) {
    console.error('Error fetching GRN data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch data' });
  }
});

/**
 * Reconcile with EasyEcom
 * Fetches pending returns and matches with scanned AWBs
 */
router.post('/reconcile', isAuthenticated, allowOperatorAccess, async (req, res) => {
  try {
    console.log('Starting GRN reconciliation...');

    // Get all unmatched scans
    const [unmatchedScans] = await pool.query(
      'SELECT id, awb FROM return_grn_scans WHERE is_matched = 0'
    );

    if (unmatchedScans.length === 0) {
      return res.json({ success: true, message: 'No unmatched scans to reconcile', matched: 0 });
    }

    console.log(`Found ${unmatchedScans.length} unmatched scans`);

    // Fetch pending returns from EasyEcom
    const pendingReturns = await getAllReturns({});
    console.log(`Fetched ${pendingReturns.length} pending returns from EasyEcom`);

    // Build AWB lookup map from EasyEcom data
    const awbToReturn = new Map();
    for (const ret of pendingReturns) {
      const item = ret.items?.[0] || {};
      const awb = (item.return_awb_number || ret.Forward_Awb_Number || '').toUpperCase().trim();
      if (awb) {
        awbToReturn.set(awb, {
          order_id: ret.order_id,
          reference_code: ret.reference_code,
          sku: item.sku,
          customer_name: ret.forward_shipment_customer_name || ret.forward_shipment_billing_name,
          customer_phone: ret.forward_shipment_customer_contact_num || ret.forward_shipment_billing_mobile,
          return_reason: item.return_reason,
          amount: ret.total_invoice_amount || item.total_item_selling_price,
          marketplace: ret.marketplace,
          return_type: item.return_type,
          return_date: item.pending_return_creation_date || ret.order_date,
          warehouse_id: ret.warehouseId,
          raw: ret
        });
      }
    }

    // Match and update scans
    let matchedCount = 0;
    const matchedAt = formatISTDateTime();

    for (const scan of unmatchedScans) {
      const returnData = awbToReturn.get(scan.awb);
      if (returnData) {
        await pool.query(
          `UPDATE return_grn_scans SET
             is_matched = 1,
             matched_at = ?,
             ee_order_id = ?,
             ee_reference_code = ?,
             ee_sku = ?,
             ee_customer_name = ?,
             ee_customer_phone = ?,
             ee_return_reason = ?,
             ee_amount = ?,
             ee_marketplace = ?,
             ee_return_type = ?,
             ee_return_date = ?,
             ee_warehouse_id = ?,
             ee_raw = ?
           WHERE id = ?`,
          [
            matchedAt,
            returnData.order_id,
            returnData.reference_code,
            returnData.sku,
            returnData.customer_name,
            returnData.customer_phone,
            returnData.return_reason,
            returnData.amount,
            returnData.marketplace,
            returnData.return_type,
            returnData.return_date,
            returnData.warehouse_id,
            JSON.stringify(returnData.raw),
            scan.id
          ]
        );
        matchedCount++;
      }
    }

    console.log(`Reconciliation complete: ${matchedCount} matched out of ${unmatchedScans.length}`);

    res.json({
      success: true,
      message: `Reconciliation complete`,
      total: unmatchedScans.length,
      matched: matchedCount,
      unmatched: unmatchedScans.length - matchedCount
    });
  } catch (error) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ success: false, error: 'Reconciliation failed: ' + error.message });
  }
});

/**
 * Download Excel report
 */
router.get('/download', isAuthenticated, allowOperatorAccess, async (req, res) => {
  const { fromDate, toDate, employeeId, status, matched } = req.query;

  try {
    let query = `
      SELECT awb, employee_name, status, scanned_at, warehouse,
             is_matched, matched_at, ee_order_id, ee_reference_code,
             ee_sku, ee_customer_name, ee_customer_phone,
             ee_marketplace, ee_return_type, ee_amount, ee_return_reason
      FROM return_grn_scans
      WHERE 1=1
    `;
    const params = [];

    if (fromDate) {
      query += ' AND DATE(scanned_at) >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      query += ' AND DATE(scanned_at) <= ?';
      params.push(toDate);
    }
    if (employeeId) {
      query += ' AND employee_id = ?';
      params.push(employeeId);
    }
    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    if (matched === 'yes') {
      query += ' AND is_matched = 1';
    } else if (matched === 'no') {
      query += ' AND is_matched = 0';
    }

    query += ' ORDER BY scanned_at DESC';

    const [scans] = await pool.query(query, params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Return GRN');

    sheet.columns = [
      { header: 'AWB', key: 'awb', width: 18 },
      { header: 'Employee', key: 'employee_name', width: 15 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Scanned At', key: 'scanned_at', width: 18 },
      { header: 'Matched', key: 'is_matched', width: 10 },
      { header: 'Order ID', key: 'ee_order_id', width: 15 },
      { header: 'Reference', key: 'ee_reference_code', width: 18 },
      { header: 'SKU', key: 'ee_sku', width: 20 },
      { header: 'Customer', key: 'ee_customer_name', width: 20 },
      { header: 'Phone', key: 'ee_customer_phone', width: 15 },
      { header: 'Marketplace', key: 'ee_marketplace', width: 12 },
      { header: 'Return Type', key: 'ee_return_type', width: 15 },
      { header: 'Amount', key: 'ee_amount', width: 12 },
      { header: 'Return Reason', key: 'ee_return_reason', width: 25 }
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    scans.forEach(scan => {
      sheet.addRow({
        ...scan,
        is_matched: scan.is_matched ? 'Yes' : 'No',
        scanned_at: new Date(scan.scanned_at).toLocaleString('en-IN')
      });
    });

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `return-grn-${dateStr}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error generating GRN Excel:', error);
    res.status(500).json({ success: false, error: 'Failed to generate report' });
  }
});

/**
 * Get employee stats (for operator view)
 */
router.get('/employee-stats', isAuthenticated, allowOperatorAccess, async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getISTDate();

  try {
    const [stats] = await pool.query(
      `SELECT
         employee_id,
         employee_name,
         COUNT(*) as total,
         SUM(CASE WHEN status = 'good' THEN 1 ELSE 0 END) as good_count,
         SUM(CASE WHEN status = 'bad' THEN 1 ELSE 0 END) as bad_count,
         SUM(CASE WHEN is_matched = 1 THEN 1 ELSE 0 END) as matched
       FROM return_grn_scans
       WHERE DATE(scanned_at) = ?
       GROUP BY employee_id, employee_name
       ORDER BY total DESC`,
      [targetDate]
    );

    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error fetching employee stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

module.exports = router;
