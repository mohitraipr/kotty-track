// routes/poCreatorRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isPOCreator, isAuthenticated, isOperator } = require('../middlewares/auth');
const ExcelJS = require('exceljs');

// Dashboard - Main page
router.get('/dashboard', isPOCreator, async (req, res) => {
  try {
    res.render('po-creator/dashboard', {
      user: req.session.user
    });
  } catch (error) {
    console.error('Error loading PO Creator dashboard:', error);
    req.flash('error', 'Error loading dashboard');
    res.redirect('/');
  }
});

// Inward - Entry form page
router.get('/inward', isPOCreator, async (req, res) => {
  try {
    // Fetch brand codes, categories, and panel names
    const [brandCodes] = await pool.query('SELECT code FROM sku_brand_codes WHERE is_active = 1 ORDER BY code');
    const [categories] = await pool.query('SELECT name FROM sku_categories WHERE is_active = 1 ORDER BY name');
    const [panelNames] = await pool.query('SELECT name, prefix FROM panel_names WHERE is_active = 1 ORDER BY name');

    res.render('po-creator/inward', {
      user: req.session.user,
      brandCodes,
      categories,
      panelNames
    });
  } catch (error) {
    console.error('Error loading inward form:', error);
    req.flash('error', 'Error loading inward form');
    res.redirect('/po-creator/dashboard');
  }
});

// API endpoint to submit inward data
router.post('/api/inward', isPOCreator, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { panel_name, date_of_packing, packed_by, skus } = req.body;

    // Validate required fields
    if (!panel_name || !date_of_packing || !packed_by || !skus || skus.length === 0) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Get panel info and generate carton number
    const [panelInfo] = await connection.query(
      'SELECT prefix, current_number FROM panel_names WHERE name = ? FOR UPDATE',
      [panel_name]
    );

    if (panelInfo.length === 0) {
      return res.status(400).json({ error: 'Invalid panel name' });
    }

    const prefix = panelInfo[0].prefix;
    const nextNumber = panelInfo[0].current_number + 1;
    const carton_number = `${prefix}${nextNumber}`;

    // Update current_number in panel_names
    await connection.query(
      'UPDATE panel_names SET current_number = ? WHERE name = ?',
      [nextNumber, panel_name]
    );

    // Insert carton
    const [cartonResult] = await connection.query(
      'INSERT INTO cartons (carton_number, panel_name, date_of_packing, packed_by, creator_user_id) VALUES (?, ?, ?, ?, ?)',
      [carton_number, panel_name, date_of_packing, packed_by, req.session.user.id]
    );

    const cartonId = cartonResult.insertId;

    // Insert SKUs
    for (const sku of skus) {
      const fullSKU = `${sku.brand_code}${sku.category}${sku.sku_code}`;

      await connection.query(
        `INSERT INTO carton_skus (carton_id, brand_code, category, sku_code, full_sku, size, quantity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cartonId, sku.brand_code, sku.category, sku.sku_code, fullSKU, sku.size, sku.quantity]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Inward entry saved successfully', carton_id: cartonId });

  } catch (error) {
    await connection.rollback();
    console.error('Error saving inward data:', error);
    res.status(500).json({ error: 'Error saving inward data' });
  } finally {
    connection.release();
  }
});

// View all inward data
router.get('/inward/view', isPOCreator, async (req, res) => {
  try {
    const [cartons] = await pool.query(`
      SELECT
        c.id,
        c.carton_number,
        c.panel_name,
        c.date_of_packing,
        c.packed_by,
        c.created_at,
        COUNT(cs.id) as sku_count,
        SUM(cs.quantity) as total_quantity
      FROM cartons c
      LEFT JOIN carton_skus cs ON c.id = cs.carton_id
      WHERE c.creator_user_id = ?
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `, [req.session.user.id]);

    res.render('po-creator/inward-view', {
      user: req.session.user,
      cartons
    });
  } catch (error) {
    console.error('Error loading inward data:', error);
    req.flash('error', 'Error loading inward data');
    res.redirect('/po-creator/dashboard');
  }
});

// Get carton details with SKUs
router.get('/api/carton/:id', isPOCreator, async (req, res) => {
  try {
    const [cartons] = await pool.query(`
      SELECT * FROM cartons WHERE id = ? AND creator_user_id = ?
    `, [req.params.id, req.session.user.id]);

    if (cartons.length === 0) {
      return res.status(404).json({ error: 'Carton not found' });
    }

    const [skus] = await pool.query(`
      SELECT * FROM carton_skus WHERE carton_id = ? ORDER BY id
    `, [req.params.id]);

    res.json({
      carton: cartons[0],
      skus
    });
  } catch (error) {
    console.error('Error fetching carton details:', error);
    res.status(500).json({ error: 'Error fetching carton details' });
  }
});

// Search cartons by carton number or SKU
router.get('/api/search-cartons', isPOCreator, async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.json([]);
    }

    const [cartons] = await pool.query(`
      SELECT DISTINCT
        c.id,
        c.carton_number,
        c.date_of_packing,
        c.packed_by
      FROM cartons c
      LEFT JOIN carton_skus cs ON c.id = cs.carton_id
      WHERE c.creator_user_id = ?
        AND (
          c.carton_number LIKE ?
          OR cs.full_sku LIKE ?
        )
      ORDER BY c.created_at DESC
      LIMIT 20
    `, [req.session.user.id, `%${query}%`, `%${query}%`]);

    res.json(cartons);
  } catch (error) {
    console.error('Error searching cartons:', error);
    res.status(500).json({ error: 'Error searching cartons' });
  }
});

// Download Excel for all inward data
router.get('/download/inward-excel', isPOCreator, async (req, res) => {
  try {
    const [data] = await pool.query(`
      SELECT
        c.carton_number,
        c.panel_name,
        c.date_of_packing,
        c.packed_by,
        cs.brand_code,
        cs.category,
        cs.sku_code,
        cs.full_sku,
        cs.size,
        cs.quantity,
        c.created_at
      FROM cartons c
      LEFT JOIN carton_skus cs ON c.id = cs.carton_id
      WHERE c.creator_user_id = ?
      ORDER BY c.created_at DESC, c.carton_number, cs.id
    `, [req.session.user.id]);

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Inward Data');

    // Add headers
    worksheet.columns = [
      { header: 'Carton Number', key: 'carton_number', width: 20 },
      { header: 'Panel Name', key: 'panel_name', width: 20 },
      { header: 'Date of Packing', key: 'date_of_packing', width: 15 },
      { header: 'Packed By', key: 'packed_by', width: 20 },
      { header: 'Brand Code', key: 'brand_code', width: 12 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'SKU Code', key: 'sku_code', width: 12 },
      { header: 'Full SKU', key: 'full_sku', width: 30 },
      { header: 'Size', key: 'size', width: 10 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add data
    data.forEach(row => {
      worksheet.addRow({
        carton_number: row.carton_number,
        panel_name: row.panel_name,
        date_of_packing: row.date_of_packing,
        packed_by: row.packed_by,
        brand_code: row.brand_code,
        category: row.category,
        sku_code: row.sku_code,
        full_sku: row.full_sku,
        size: row.size,
        quantity: row.quantity,
        created_at: row.created_at
      });
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=inward-data-${Date.now()}.xlsx`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error generating Excel:', error);
    req.flash('error', 'Error generating Excel file');
    res.redirect('/po-creator/inward/view');
  }
});

// Operator view - See all PO creators' data
router.get('/operator/view-all', isOperator, async (req, res) => {
  try {
    const [cartons] = await pool.query(`
      SELECT
        c.id,
        c.carton_number,
        c.panel_name,
        c.date_of_packing,
        c.packed_by,
        c.created_at,
        u.username as creator_username,
        COUNT(cs.id) as sku_count,
        SUM(cs.quantity) as total_quantity
      FROM cartons c
      LEFT JOIN carton_skus cs ON c.id = cs.carton_id
      LEFT JOIN users u ON c.creator_user_id = u.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    res.render('po-creator/operator-view-all', {
      user: req.session.user,
      cartons
    });
  } catch (error) {
    console.error('Error loading all inward data:', error);
    req.flash('error', 'Error loading data');
    res.redirect('/operator/dashboard');
  }
});

// Operator download all data
router.get('/operator/download-all-excel', isOperator, async (req, res) => {
  try {
    const [data] = await pool.query(`
      SELECT
        u.username as creator_username,
        c.carton_number,
        c.panel_name,
        c.date_of_packing,
        c.packed_by,
        cs.brand_code,
        cs.category,
        cs.sku_code,
        cs.full_sku,
        cs.size,
        cs.quantity,
        CASE WHEN co.id IS NOT NULL THEN 'Dispatched' ELSE 'Not Dispatched' END as dispatch_status,
        co.po_number,
        c.created_at
      FROM cartons c
      LEFT JOIN carton_skus cs ON c.id = cs.carton_id
      LEFT JOIN users u ON c.creator_user_id = u.id
      LEFT JOIN carton_outward co ON c.id = co.carton_id
      ORDER BY c.created_at DESC, c.carton_number, cs.id
    `);

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('All Inward Data');

    // Add headers
    worksheet.columns = [
      { header: 'Creator', key: 'creator_username', width: 20 },
      { header: 'Carton Number', key: 'carton_number', width: 20 },
      { header: 'Panel Name', key: 'panel_name', width: 20 },
      { header: 'Date of Packing', key: 'date_of_packing', width: 15 },
      { header: 'Packed By', key: 'packed_by', width: 20 },
      { header: 'Brand Code', key: 'brand_code', width: 12 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'SKU Code', key: 'sku_code', width: 12 },
      { header: 'Full SKU', key: 'full_sku', width: 30 },
      { header: 'Size', key: 'size', width: 10 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Dispatch Status', key: 'dispatch_status', width: 18 },
      { header: 'PO Number', key: 'po_number', width: 20 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add data
    data.forEach(row => {
      worksheet.addRow(row);
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=all-inward-data-${Date.now()}.xlsx`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error generating Excel:', error);
    req.flash('error', 'Error generating Excel file');
    res.redirect('/operator/dashboard');
  }
});

// Outward - Entry form page (only creator can create outward for their cartons)
router.get('/outward', isPOCreator, async (req, res) => {
  try {
    // Fetch user's cartons that haven't been dispatched yet
    const [cartons] = await pool.query(`
      SELECT c.id, c.carton_number, c.date_of_packing, c.packed_by
      FROM cartons c
      LEFT JOIN carton_outward co ON c.id = co.carton_id
      WHERE c.creator_user_id = ? AND co.id IS NULL
      ORDER BY c.created_at DESC
    `, [req.session.user.id]);

    res.render('po-creator/outward', {
      user: req.session.user,
      cartons
    });
  } catch (error) {
    console.error('Error loading outward form:', error);
    req.flash('error', 'Error loading outward form');
    res.redirect('/po-creator/dashboard');
  }
});

// API endpoint to submit outward data
router.post('/api/outward', isPOCreator, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { carton_ids, po_number, dispatch_date, panel_name } = req.body;

    if (!carton_ids || carton_ids.length === 0 || !po_number || !dispatch_date || !panel_name) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Verify all cartons belong to the user
    const [cartons] = await connection.query(
      `SELECT id FROM cartons WHERE id IN (?) AND creator_user_id = ?`,
      [carton_ids, req.session.user.id]
    );

    if (cartons.length !== carton_ids.length) {
      return res.status(403).json({ error: 'You can only create outward for your own cartons' });
    }

    // Insert outward records
    for (const cartonId of carton_ids) {
      await connection.query(
        `INSERT INTO carton_outward (carton_id, po_number, dispatch_date, panel_name, creator_user_id)
         VALUES (?, ?, ?, ?, ?)`,
        [cartonId, po_number, dispatch_date, panel_name, req.session.user.id]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Outward entry saved successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error saving outward data:', error);
    res.status(500).json({ error: 'Error saving outward data' });
  } finally {
    connection.release();
  }
});

// Operator - Main Dashboard
router.get('/operator/dashboard', isOperator, async (req, res) => {
  try {
    res.render('po-operator-dashboard', {
      user: req.session.user
    });
  } catch (error) {
    console.error('Error loading PO Operator dashboard:', error);
    req.flash('error', 'Error loading dashboard');
    res.redirect('/operator/dashboard');
  }
});

// Operator - Stats API
router.get('/operator/api/stats', isOperator, async (req, res) => {
  try {
    const [cartonStats] = await pool.query('SELECT COUNT(*) as totalCartons FROM cartons');
    const [skuStats] = await pool.query('SELECT COUNT(DISTINCT full_sku) as totalSKUs, SUM(quantity) as totalQty FROM carton_skus');
    const [creatorStats] = await pool.query('SELECT COUNT(DISTINCT creator_user_id) as totalCreators FROM cartons');

    res.json({
      totalCartons: cartonStats[0].totalCartons,
      totalSKUs: skuStats[0].totalSKUs,
      totalQty: skuStats[0].totalQty,
      totalCreators: creatorStats[0].totalCreators
    });
  } catch (error) {
    console.error('Error loading stats:', error);
    res.status(500).json({ error: 'Error loading stats' });
  }
});

// Operator - Manage Brand Codes
router.get('/operator/manage-brands', isOperator, async (req, res) => {
  try {
    const [brandCodes] = await pool.query('SELECT * FROM sku_brand_codes ORDER BY code');

    res.render('po-creator/operator-manage-brands', {
      user: req.session.user,
      brandCodes
    });
  } catch (error) {
    console.error('Error loading brands:', error);
    req.flash('error', 'Error loading brands');
    res.redirect('/operator/dashboard');
  }
});

// Operator - Add Brand Code
router.post('/operator/api/add-brand', isOperator, async (req, res) => {
  try {
    const { code, description } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Brand code is required' });
    }

    await pool.query(
      'INSERT INTO sku_brand_codes (code, description) VALUES (?, ?)',
      [code.toUpperCase(), description || '']
    );

    res.json({ success: true, message: 'Brand code added successfully' });
  } catch (error) {
    console.error('Error adding brand code:', error);
    res.status(500).json({ error: 'Error adding brand code' });
  }
});

// Operator - Manage Categories
router.get('/operator/manage-categories', isOperator, async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT * FROM sku_categories ORDER BY name');

    res.render('po-creator/operator-manage-categories', {
      user: req.session.user,
      categories
    });
  } catch (error) {
    console.error('Error loading categories:', error);
    req.flash('error', 'Error loading categories');
    res.redirect('/operator/dashboard');
  }
});

// Operator - Add Category
router.post('/operator/api/add-category', isOperator, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    await pool.query(
      'INSERT INTO sku_categories (name, description) VALUES (?, ?)',
      [name.toUpperCase(), description || '']
    );

    res.json({ success: true, message: 'Category added successfully' });
  } catch (error) {
    console.error('Error adding category:', error);
    res.status(500).json({ error: 'Error adding category' });
  }
});

// Operator - SKU-wise view
router.get('/operator/view-sku-wise', isOperator, async (req, res) => {
  try {
    const [skuData] = await pool.query(`
      SELECT
        cs.full_sku,
        cs.brand_code,
        cs.category,
        cs.sku_code,
        cs.size,
        SUM(cs.quantity) as total_quantity,
        COUNT(DISTINCT c.id) as carton_count,
        GROUP_CONCAT(DISTINCT u.username) as creators
      FROM carton_skus cs
      JOIN cartons c ON cs.carton_id = c.id
      JOIN users u ON c.creator_user_id = u.id
      GROUP BY cs.full_sku, cs.size
      ORDER BY cs.full_sku, cs.size
    `);

    res.render('po-creator/operator-view-sku-wise', {
      user: req.session.user,
      skuData
    });
  } catch (error) {
    console.error('Error loading SKU-wise view:', error);
    req.flash('error', 'Error loading SKU-wise view');
    res.redirect('/operator/dashboard');
  }
});

// Operator - Panel-wise view
router.get('/operator/view-panel-wise', isOperator, async (req, res) => {
  try {
    const [panelData] = await pool.query(`
      SELECT
        co.panel_name,
        co.po_number,
        co.dispatch_date,
        COUNT(DISTINCT co.carton_id) as carton_count,
        SUM(cs.quantity) as total_quantity,
        u.username as creator
      FROM carton_outward co
      JOIN cartons c ON co.carton_id = c.id
      JOIN users u ON c.creator_user_id = u.id
      LEFT JOIN carton_skus cs ON c.id = cs.carton_id
      GROUP BY co.panel_name, co.po_number, co.dispatch_date, u.username
      ORDER BY co.dispatch_date DESC
    `);

    res.render('po-creator/operator-view-panel-wise', {
      user: req.session.user,
      panelData
    });
  } catch (error) {
    console.error('Error loading panel-wise view:', error);
    req.flash('error', 'Error loading panel-wise view');
    res.redirect('/operator/dashboard');
  }
});

module.exports = router;
