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
    // Fetch brand codes and categories
    const [brandCodes] = await pool.query('SELECT code FROM sku_brand_codes WHERE is_active = 1 ORDER BY code');
    const [categories] = await pool.query('SELECT name FROM sku_categories WHERE is_active = 1 ORDER BY name');

    res.render('po-creator/inward', {
      user: req.session.user,
      brandCodes,
      categories
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

    const { carton_number, date_of_packing, packed_by, skus } = req.body;

    // Validate required fields
    if (!carton_number || !date_of_packing || !packed_by || !skus || skus.length === 0) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if carton number already exists
    const [existing] = await connection.query(
      'SELECT id FROM cartons WHERE carton_number = ?',
      [carton_number]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Carton number already exists' });
    }

    // Insert carton
    const [cartonResult] = await connection.query(
      'INSERT INTO cartons (carton_number, date_of_packing, packed_by, creator_user_id) VALUES (?, ?, ?, ?)',
      [carton_number, date_of_packing, packed_by, req.session.user.id]
    );

    const cartonId = cartonResult.insertId;

    // Insert SKUs
    for (const sku of skus) {
      const fullSKU = `${sku.brand_code}-${sku.category}-${sku.sku_code}`;

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
      LEFT JOIN users u ON c.creator_user_id = u.id
      ORDER BY c.created_at DESC, c.carton_number, cs.id
    `);

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('All Inward Data');

    // Add headers
    worksheet.columns = [
      { header: 'Creator', key: 'creator_username', width: 20 },
      { header: 'Carton Number', key: 'carton_number', width: 20 },
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

module.exports = router;
