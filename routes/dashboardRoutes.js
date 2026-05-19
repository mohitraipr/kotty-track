// routes/dashboardRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { 
  isAuthenticated, 
  isAdmin, 
  isFabricManager, 
  isCuttingManager, 
  isStitchingMaster 
} = require('../middlewares/auth');
const xlsx = require('xlsx');
const fs = require('fs');
const multer = require('multer');

// For file uploads
const upload = multer({ dest: 'uploads/' });

/**
 * Helpers for Excel date conversion.
 * Excel often stores dates as serial numbers (e.g., 45342),
 * so we need to convert to a JS Date, then format to YYYY-MM-DD for MySQL.
 */
function excelSerialDateToJSDate(serial) {
  // Excel's day 1 is typically 1899-12-30 in Windows versions.
  const excelEpoch = new Date(Date.UTC(1899, 11, 30));
  const daysInMs = serial * 24 * 60 * 60 * 1000;
  return new Date(excelEpoch.getTime() + daysInMs);
}

function formatDateToMySQL(dateObj) {
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * GET /dashboard
 * Lists dashboards for the current user’s role.
 */
router.get('/', isAuthenticated, async (req, res) => {
  const userRoleId = req.session.user.roleId;
  try {
    const [dashboards] = await pool.query(
      'SELECT * FROM dashboards WHERE role_id = ?',
      [userRoleId]
    );
    return res.render('dashboard', {
      user: req.session.user,
      dashboards,
      tableName: null
    });
  } catch (err) {
    console.error('Error listing dashboards:', err);
    req.flash('error', 'Error loading dashboards.');
    return res.redirect('/');
  }
});

/**
 * GET /dashboard/view?table=...&search=...&page=...
 * Shows a single table with search & pagination (25 rows/page).
 */
router.get('/view', isAuthenticated, async (req, res) => {
  const tableName = req.query.table;
  if (!tableName) return res.redirect('/dashboard');

  const userRoleId = req.session.user.roleId;
  const searchTerm = req.query.search || '';
  const pageNum = parseInt(req.query.page || '1', 10);
  const pageSize = 25;
  const offset = (pageNum - 1) * pageSize;

  try {
    // Check if user’s role can access this table
    const [dash] = await pool.query(
      `SELECT can_update, role_id
       FROM dashboards
       WHERE table_name = ? AND role_id = ?`,
      [tableName, userRoleId]
    );
    if (!dash.length) {
      req.flash('error', 'Access denied: No access to this table.');
      return res.redirect('/dashboard');
    }

    const canUpdate = dash[0].can_update;

    // Describe columns for building table headers, form fields
    const [columns] = await pool.query(`DESCRIBE \`${tableName}\``);

    // Build a search WHERE clause if searchTerm is provided
    let whereClause = '';
    const whereParams = [];

    // Filter data based on user roles and ownership
    // For example, if the table has a 'user_id' column, filter by it
    const hasUserId = columns.some(col => col.Field === 'user_id');

    if (hasUserId) {
      whereClause += `WHERE user_id = ?`;
      whereParams.push(req.session.user.id);
      if (searchTerm) {
        whereClause += ` AND CONCAT_WS('', ${columns.map(c => `IFNULL(\`${c.Field}\`, '')`).join(', ')}) LIKE ?`;
        whereParams.push(`%${searchTerm}%`);
      }
    } else {
      if (searchTerm) {
        const colNames = columns.map(c => `IFNULL(\`${c.Field}\`, '')`);
        const concatClause = `CONCAT_WS('', ${colNames.join(', ')}) LIKE ?`;
        whereClause = `WHERE ${concatClause}`;
        whereParams.push(`%${searchTerm}%`);
      }
    }

    // Count total rows for pagination
    const countSQL = `
      SELECT COUNT(*) AS totalCount
      FROM \`${tableName}\`
      ${whereClause}
    `;
    const [countRows] = await pool.query(countSQL, whereParams);
    const totalCount = countRows[0].totalCount;
    const totalPages = Math.ceil(totalCount / pageSize);

    // Fetch actual data for this page
    const dataSQL = `
      SELECT *
      FROM \`${tableName}\`
      ${whereClause}
      LIMIT ? OFFSET ?
    `;
    const params = [...whereParams, pageSize, offset];
    const [rows] = await pool.query(dataSQL, params);

    // If user is not admin, possibly further filter data
    // This depends on your specific requirements

    return res.render('dashboard', {
      user: req.session.user,
      tableName,
      columns,
      rows,
      canUpdate,
      searchTerm,
      currentPage: pageNum,
      totalPages
    });
  } catch (err) {
    console.error('Error in /dashboard/view:', err);
    req.flash('error', 'Error loading table data.');
    return res.redirect('/dashboard');
  }
});

/**
 * GET /dashboard/download-excel?table=...&search=...
 * Exports the same filtered data to Excel.
 */
router.get('/download-excel', isAuthenticated, async (req, res) => {
  const tableName = req.query.table;
  if (!tableName) return res.status(400).send('No table specified');

  const userRoleId = req.session.user.roleId;
  const searchTerm = req.query.search || '';

  try {
    // Check if user’s role can see table
    const [dash] = await pool.query(
      `SELECT can_update
       FROM dashboards
       WHERE table_name = ? AND role_id = ?`,
      [tableName, userRoleId]
    );
    if (!dash.length) {
      req.flash('error', 'Access denied: No access to table.');
      return res.redirect('/dashboard');
    }

    // Describe columns for building search
    const [columns] = await pool.query(`DESCRIBE \`${tableName}\``);
    let whereClause = '';
    const whereParams = [];

    const hasUserId = columns.some(col => col.Field === 'user_id');

    if (hasUserId) {
      whereClause += `WHERE user_id = ?`;
      whereParams.push(req.session.user.id);
      if (searchTerm) {
        whereClause += ` AND CONCAT_WS('', ${columns.map(c => `IFNULL(\`${c.Field}\`, '')`).join(', ')}) LIKE ?`;
        whereParams.push(`%${searchTerm}%`);
      }
    } else {
      if (searchTerm) {
        const colNames = columns.map(c => `IFNULL(\`${c.Field}\`, '')`);
        const concatClause = `CONCAT_WS('', ${colNames.join(', ')}) LIKE ?`;
        whereClause = `WHERE ${concatClause}`;
        whereParams.push(`%${searchTerm}%`);
      }
    }

    // LIMIT to 50,000 rows to prevent memory exhaustion on large tables
    const MAX_EXPORT_ROWS = 50000;
    const sql = `
      SELECT *
      FROM \`${tableName}\`
      ${whereClause}
      LIMIT ${MAX_EXPORT_ROWS}
    `;
    const [rows] = await pool.query(sql, whereParams);

    if (!rows.length) {
      return exportEmptyExcel(tableName, res);
    }

    // Convert rows to a worksheet
    const worksheet = xlsx.utils.json_to_sheet(rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Data');

    // Send .xlsx
    const fileName = `${tableName}-export.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const excelBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return res.send(excelBuffer);
  } catch (err) {
    console.error('Error in /dashboard/download-excel:', err);
    req.flash('error', 'Error exporting data.');
    return res.redirect('/dashboard');
  }
});

/**
 * If no rows to export, build an empty workbook.
 */
async function exportEmptyExcel(tableName, res) {
  try {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet([]);
    xlsx.utils.book_append_sheet(wb, ws, 'Data');

    const fileName = `${tableName}-export.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return res.send(buffer);
  } catch (err) {
    console.error('Error exporting empty Excel:', err);
    req.flash('error', 'Error exporting empty data.');
    return res.redirect('/dashboard');
  }
}

/**
 * POST /dashboard/insert/:table
 * Insert single row if can_update is true.
 */
router.post('/insert/:table', isAuthenticated, async (req, res) => {
  const tableName = req.params.table;
  const userRoleId = req.session.user.roleId;

  try {
    // Check permission
    const [dash] = await pool.query(
      `SELECT can_update
       FROM dashboards
       WHERE table_name = ? AND role_id = ?`,
      [tableName, userRoleId]
    );
    if (!dash.length || !dash[0].can_update) {
      req.flash('error', 'No permission to insert data.');
      return res.redirect(`/dashboard/view?table=${tableName}`);
    }

    const formFields = req.body;
    const columns = Object.keys(formFields).map(col => `\`${col}\``);
    const placeholders = Object.keys(formFields).map(() => '?');
    const values = Object.values(formFields);

    // Optionally store user_id
    if (!Object.keys(formFields).includes('user_id') && tableName !== 'roles') { // Exclude roles table
      columns.push('user_id');
      placeholders.push('?');
      values.push(req.session.user.id);
    }

    const insertSQL = `
      INSERT INTO \`${tableName}\` (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `;
    await pool.query(insertSQL, values);

    req.flash('success', 'Data inserted successfully.');
    return res.redirect(`/dashboard/view?table=${tableName}`);
  } catch (err) {
    console.error('Error inserting data:', err);
    req.flash('error', 'Error inserting data.');
    return res.redirect(`/dashboard/view?table=${tableName}`);
  }
});

/**
 * Bulk Upload
 * 1) GET => Show the upload page
 * 2) POST => Parse the Excel, do a transaction, insert multiple rows
 */
router.get('/bulk-upload', isAuthenticated, async (req, res) => {
  const tableName = req.query.table;
  if (!tableName) return res.redirect('/dashboard');

  // e.g. only fabric_manager can do bulk upload
  if (req.session.user.roleName !== 'fabric_manager') {
    req.flash('error', 'Access denied: Only fabric_manager can do bulk upload.');
    return res.redirect('/dashboard');
  }

  return res.render('bulkUpload', {
    user: req.session.user,
    tableName,
    errorMessage: null
  });
});

const multerUpload = multer({ dest: 'uploads/' }); // define your storage

router.post('/bulk-upload/:table', isAuthenticated, multerUpload.single('excelFile'), async (req, res) => {
  const tableName = req.params.table;

  // role check
  if (req.session.user.roleName !== 'fabric_manager') {
    return res.status(403).send('Access Denied: Only fabric_manager can do bulk upload.');
  }

  try {
    if (!req.file) {
      return res.render('bulkUpload', {
        user: req.session.user,
        tableName,
        errorMessage: 'No file was uploaded.'
      });
    }

    // check can_update
    const userRoleId = req.session.user.roleId;
    const [dash] = await pool.query(
      `SELECT can_update
       FROM dashboards
       WHERE table_name = ? AND role_id = ?`,
      [tableName, userRoleId]
    );
    if (!dash.length || !dash[0].can_update) {
      fs.unlinkSync(req.file.path);
      return res.render('bulkUpload', {
        user: req.session.user,
        tableName,
        errorMessage: 'No permission to insert data.'
      });
    }

    // parse Excel
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(worksheet);

    // Convert Excel date serials (e.g. 45342) to 'YYYY-MM-DD'
    for (const row of jsonData) {
      if (row.date_invoice && typeof row.date_invoice === 'number') {
        const jsDate = excelSerialDateToJSDate(row.date_invoice);
        row.date_invoice = formatDateToMySQL(jsDate);
      }
      if (row.date_received && typeof row.date_received === 'number') {
        const jsDate = excelSerialDateToJSDate(row.date_received);
        row.date_received = formatDateToMySQL(jsDate);
      }
      // ... replicate for any other date columns you have
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const row of jsonData) {
        const rowCols = Object.keys(row).map(c => `\`${c}\``);
        const placeholders = Object.keys(row).map(() => '?');
        const vals = Object.values(row);

        // Add user_id
        if (!Object.keys(row).includes('user_id') && tableName !== 'roles') { // Exclude roles table
          rowCols.push('user_id');
          placeholders.push('?');
          vals.push(req.session.user.id);
        }

        const sql = `
          INSERT INTO \`${tableName}\` (${rowCols.join(', ')})
          VALUES (${placeholders.join(', ')})
        `;
        await conn.query(sql, vals);
      }

      await conn.commit();
      conn.release();
    } catch (bulkErr) {
      await conn.rollback();
      conn.release();
      fs.unlinkSync(req.file.path);
      return res.render('bulkUpload', {
        user: req.session.user,
        tableName,
        errorMessage: `Bulk insert failed: ${bulkErr.message}`
      });
    }

    fs.unlinkSync(req.file.path);
    req.flash('success', 'Bulk upload successful.');
    return res.redirect(`/dashboard/view?table=${tableName}`);
  } catch (err) {
    console.error('Bulk upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.render('bulkUpload', {
      user: req.session.user,
      tableName,
      errorMessage: `Error: ${err.message}`
    });
  }
});

/**
 * GET /dashboard/rejected-lots
 * Report of all rejected lots across all stages
 */
router.get('/rejected-lots', isAuthenticated, async (req, res) => {
  try {
    const { stage = 'all', search = '', days = 30 } = req.query;
    const daysAgo = parseInt(days) || 30;

    // Query rejected lots from all stages
    const queries = [];
    const params = [];
    const dateFilter = `AND approved_on >= DATE_SUB(NOW(), INTERVAL ? DAY)`;

    // Rejections come from BOTH the legacy *_assignments tables (is_approved
    // = 0, or 2 for finishing) AND the *_events tables (event_type='reject').
    // The events feed is the truth source for newer activity; legacy still
    // holds historical denials. Union them.
    const eventDateFilter = `AND e.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`;

    // --- Stitching ---
    if (stage === 'all' || stage === 'stitching') {
      queries.push(`
        SELECT
          'Stitching' AS stage,
          cl.lot_no,
          cl.sku,
          sa.approved_on AS rejected_on,
          u_assigned.username AS assigned_to,
          u_assigner.username AS assigner,
          sa.assignment_remark AS rejection_reason,
          cls_total.total_pieces
        FROM stitching_assignments sa
        JOIN cutting_lots cl ON cl.id = sa.cutting_lot_id
        JOIN users u_assigned ON u_assigned.id = sa.user_id
        LEFT JOIN users u_assigner ON u_assigner.id = sa.assigner_cutting_master
        LEFT JOIN (SELECT cutting_lot_id, SUM(total_pieces) AS total_pieces FROM cutting_lot_sizes GROUP BY cutting_lot_id) cls_total ON cls_total.cutting_lot_id = cl.id
        WHERE sa.isApproved = 0 ${dateFilter}
        ${search ? 'AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }

      queries.push(`
        SELECT 'Stitching' AS stage, cl.lot_no, cl.sku,
               e.created_at AS rejected_on,
               u.username AS assigned_to, NULL AS assigner,
               e.remark AS rejection_reason, e.pieces AS total_pieces
          FROM stitching_events e
          JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
          JOIN users u ON u.id = e.operator_id
         WHERE e.event_type='reject' ${eventDateFilter}
         ${search ? 'AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }
    }

    // --- Assembly ---
    if (stage === 'all' || stage === 'assembly') {
      queries.push(`
        SELECT
          'Assembly' AS stage,
          sd.lot_no,
          sd.sku,
          ja.approved_on AS rejected_on,
          u_assigned.username AS assigned_to,
          u_assigner.username AS assigner,
          ja.assignment_remark AS rejection_reason,
          sd.total_pieces
        FROM jeans_assembly_assignments ja
        JOIN stitching_data sd ON sd.id = ja.stitching_assignment_id
        JOIN users u_assigned ON u_assigned.id = ja.user_id
        LEFT JOIN users u_assigner ON u_assigner.id = ja.stitching_master_id
        WHERE ja.is_approved = 0 ${dateFilter}
        ${search ? 'AND (sd.lot_no LIKE ? OR sd.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }

      queries.push(`
        SELECT 'Assembly' AS stage, cl.lot_no, cl.sku,
               e.created_at AS rejected_on,
               u.username AS assigned_to, NULL AS assigner,
               e.remark AS rejection_reason, e.pieces AS total_pieces
          FROM jeans_assembly_events e
          JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
          JOIN users u ON u.id = e.operator_id
         WHERE e.event_type='reject' ${eventDateFilter}
         ${search ? 'AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }
    }

    // --- Washing ---
    // (legacy query reference to non-existent assembly_data dropped; replaced
    // with jeans_assembly_data, the actual upstream table.)
    if (stage === 'all' || stage === 'washing') {
      queries.push(`
        SELECT
          'Washing' AS stage,
          jd.lot_no,
          jd.sku,
          wa.approved_on AS rejected_on,
          u_assigned.username AS assigned_to,
          u_assigner.username AS assigner,
          wa.assignment_remark AS rejection_reason,
          jd.total_pieces
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON jd.id = wa.jeans_assembly_assignment_id
        JOIN users u_assigned ON u_assigned.id = wa.user_id
        LEFT JOIN users u_assigner ON u_assigner.id = wa.jeans_assembly_master_id
        WHERE wa.is_approved = 0 ${dateFilter}
        ${search ? 'AND (jd.lot_no LIKE ? OR jd.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }

      queries.push(`
        SELECT 'Washing' AS stage, cl.lot_no, cl.sku,
               e.created_at AS rejected_on,
               u.username AS assigned_to, NULL AS assigner,
               e.remark AS rejection_reason, e.pieces AS total_pieces
          FROM washing_events e
          JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
          JOIN users u ON u.id = e.operator_id
         WHERE e.event_type='reject' ${eventDateFilter}
         ${search ? 'AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }
    }

    // --- Washing-In ---
    if (stage === 'all' || stage === 'washing_in') {
      queries.push(`
        SELECT
          'Washing-In' AS stage,
          wd.lot_no,
          wd.sku,
          wia.approved_on AS rejected_on,
          u_assigned.username AS assigned_to,
          u_assigner.username AS assigner,
          wia.assignment_remark AS rejection_reason,
          wd.total_pieces
        FROM washing_in_assignments wia
        JOIN washing_data wd ON wd.id = wia.washing_data_id
        JOIN users u_assigned ON u_assigned.id = wia.user_id
        LEFT JOIN users u_assigner ON u_assigner.id = wia.washing_master_id
        WHERE wia.is_approved = 0 ${dateFilter}
        ${search ? 'AND (wd.lot_no LIKE ? OR wd.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }

      queries.push(`
        SELECT 'Washing-In' AS stage, cl.lot_no, cl.sku,
               e.created_at AS rejected_on,
               u.username AS assigned_to, NULL AS assigner,
               e.remark AS rejection_reason, e.pieces AS total_pieces
          FROM washing_in_events e
          JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
          JOIN users u ON u.id = e.operator_id
         WHERE e.event_type='reject' ${eventDateFilter}
         ${search ? 'AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }
    }

    // --- Finishing ---
    if (stage === 'all' || stage === 'finishing') {
      queries.push(`
        SELECT
          'Finishing' AS stage,
          COALESCE(wid.lot_no, sd.lot_no) AS lot_no,
          COALESCE(wid.sku, sd.sku) AS sku,
          fa.approved_on AS rejected_on,
          u_assigned.username AS assigned_to,
          NULL AS assigner,
          fa.assignment_remark AS rejection_reason,
          COALESCE(wid.total_pieces, sd.total_pieces) AS total_pieces
        FROM finishing_assignments fa
        LEFT JOIN washing_in_data wid ON wid.id = fa.washing_in_data_id
        LEFT JOIN stitching_data sd ON sd.id = fa.stitching_assignment_id
        JOIN users u_assigned ON u_assigned.id = fa.user_id
        WHERE fa.is_approved = 2 ${dateFilter}
        ${search ? 'AND (COALESCE(wid.lot_no, sd.lot_no) LIKE ? OR COALESCE(wid.sku, sd.sku) LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }

      queries.push(`
        SELECT 'Finishing' AS stage, cl.lot_no, cl.sku,
               e.created_at AS rejected_on,
               u.username AS assigned_to, NULL AS assigner,
               e.remark AS rejection_reason, e.pieces AS total_pieces
          FROM finishing_events e
          JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
          JOIN users u ON u.id = e.operator_id
         WHERE e.event_type='reject' ${eventDateFilter}
         ${search ? 'AND (cl.lot_no LIKE ? OR cl.sku LIKE ?)' : ''}
      `);
      params.push(daysAgo);
      if (search) { params.push(`%${search}%`, `%${search}%`); }
    }

    if (queries.length === 0) {
      return res.render('rejectedLots', { user: req.session.user, rejectedLots: [], stage, search, days: daysAgo });
    }

    const fullQuery = queries.join(' UNION ALL ') + ' ORDER BY rejected_on DESC';
    const [rejectedLots] = await pool.query(fullQuery, params);

    res.render('rejectedLots', {
      user: req.session.user,
      rejectedLots,
      stage,
      search,
      days: daysAgo
    });
  } catch (err) {
    console.error('Error loading rejected lots:', err);
    // Show error on the page instead of redirecting
    res.render('rejectedLots', {
      user: req.session.user,
      rejectedLots: [],
      stage: req.query.stage || 'all',
      search: req.query.search || '',
      days: parseInt(req.query.days) || 30,
      error: 'Error loading data: ' + err.message
    });
  }
});

module.exports = router;
