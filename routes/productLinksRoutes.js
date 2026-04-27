/**
 * Product Links Routes
 *
 * Features:
 * - View product links (operator + productviewer)
 * - Upload product links from Excel (operator only)
 * - Download Excel template (operator only)
 * - Delete single entry (operator only)
 * - Filter by brand (nowi, kotty)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, allowRoles } = require('../middlewares/auth');

// Multer setup for Excel uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Middleware: Allow operator OR productviewer
const allowProductLinksAccess = allowRoles(['operator', 'productviewer']);

// Available brands
const BRANDS = ['nowi', 'kotty'];

/**
 * GET /product-links
 * View all product links (both operator and productviewer)
 */
router.get('/', isAuthenticated, allowProductLinksAccess, async (req, res) => {
  try {
    const [links] = await pool.query(`
      SELECT id, brand, sku, amazon_link, myntra_link, nykaa_link, flipkart_link, created_at
      FROM product_links
      ORDER BY brand ASC, sku ASC
    `);

    // Get brand counts for filter badges
    const [brandCounts] = await pool.query(`
      SELECT brand, COUNT(*) as count FROM product_links GROUP BY brand
    `);
    const counts = {};
    brandCounts.forEach(b => { counts[b.brand] = b.count; });

    res.render('productLinks', {
      user: req.session.user,
      links,
      brands: BRANDS,
      brandCounts: counts,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error fetching product links:', err);
    req.flash('error', 'Failed to load product links');
    res.redirect('/');
  }
});

/**
 * GET /product-links/template
 * Download Excel template (operator only)
 */
router.get('/template', isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('ProductLinks');

    // Header row styling
    sheet.columns = [
      { header: 'SKU', key: 'sku', width: 25 },
      { header: 'Amazon', key: 'amazon', width: 60 },
      { header: 'Myntra', key: 'myntra', width: 60 },
      { header: 'Nykaa', key: 'nykaa', width: 60 },
      { header: 'Flipkart', key: 'flipkart', width: 60 }
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' }
    };

    // Add example rows
    sheet.addRow({
      sku: 'EXAMPLE-SKU-001',
      amazon: 'https://www.amazon.in/dp/EXAMPLE123',
      myntra: 'https://www.myntra.com/example/123',
      nykaa: 'https://www.nykaaFashion.com/example',
      flipkart: 'https://www.flipkart.com/example'
    });

    sheet.addRow({
      sku: 'EXAMPLE-SKU-002',
      amazon: 'https://www.amazon.in/dp/EXAMPLE456',
      myntra: '',
      nykaa: 'https://www.nykaaFashion.com/example2',
      flipkart: ''
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ProductLinksTemplate.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating template:', err);
    req.flash('error', 'Failed to generate template');
    res.redirect('/product-links');
  }
});

/**
 * POST /product-links/upload
 * Upload product links from Excel (operator only)
 * Returns JSON for AJAX requests, redirects for form submissions
 */
router.post('/upload', isAuthenticated, isOperator, upload.single('excelFile'), async (req, res) => {
  const isAjax = req.headers.accept && req.headers.accept.includes('application/json');
  const file = req.file;
  const brand = (req.body.brand || 'nowi').toLowerCase().trim();

  if (!file) {
    if (isAjax) return res.status(400).json({ error: 'No file uploaded' });
    req.flash('error', 'No file uploaded');
    return res.redirect('/product-links');
  }

  if (!BRANDS.includes(brand)) {
    if (isAjax) return res.status(400).json({ error: 'Invalid brand selected' });
    req.flash('error', 'Invalid brand selected');
    return res.redirect('/product-links');
  }

  let rows;
  try {
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (err) {
    console.error('Failed to parse Excel:', err);
    if (isAjax) return res.status(400).json({ error: 'Invalid Excel file' });
    req.flash('error', 'Invalid Excel file');
    return res.redirect('/product-links');
  }

  if (!rows || rows.length === 0) {
    if (isAjax) return res.status(400).json({ error: 'Excel file is empty' });
    req.flash('error', 'Excel file is empty');
    return res.redirect('/product-links');
  }

  const userId = req.session.user.id;
  let successCount = 0;
  let errorCount = 0;
  const errors = [];
  const insertedLinks = [];

  for (const r of rows) {
    const sku = String(r.SKU || r.sku || r.Sku || '').trim();
    if (!sku) {
      errorCount++;
      errors.push('Row with empty SKU skipped');
      continue;
    }

    const amazon = String(r.Amazon || r.amazon || r.AMAZON || '').trim() || null;
    const myntra = String(r.Myntra || r.myntra || r.MYNTRA || '').trim() || null;
    const nykaa = String(r.Nykaa || r.nykaa || r.NYKAA || '').trim() || null;
    const flipkart = String(r.Flipkart || r.flipkart || r.FLIPKART || '').trim() || null;

    try {
      const [result] = await pool.query(`
        INSERT INTO product_links (brand, sku, amazon_link, myntra_link, nykaa_link, flipkart_link, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          amazon_link = VALUES(amazon_link),
          myntra_link = VALUES(myntra_link),
          nykaa_link = VALUES(nykaa_link),
          flipkart_link = VALUES(flipkart_link),
          updated_at = NOW()
      `, [brand, sku, amazon, myntra, nykaa, flipkart, userId]);

      successCount++;
      insertedLinks.push({
        id: result.insertId || null,
        brand,
        sku,
        amazon_link: amazon,
        myntra_link: myntra,
        nykaa_link: nykaa,
        flipkart_link: flipkart
      });
    } catch (err) {
      console.error(`Error inserting SKU ${sku}:`, err);
      errorCount++;
      errors.push(`Failed to insert SKU: ${sku}`);
    }
  }

  if (isAjax) {
    // Fetch updated data for the brand
    const [links] = await pool.query(`
      SELECT id, brand, sku, amazon_link, myntra_link, nykaa_link, flipkart_link
      FROM product_links
      WHERE brand = ?
      ORDER BY sku ASC
    `, [brand]);

    // Get updated brand counts
    const [brandCounts] = await pool.query(`
      SELECT brand, COUNT(*) as count FROM product_links GROUP BY brand
    `);
    const counts = {};
    brandCounts.forEach(b => { counts[b.brand] = b.count; });

    return res.json({
      success: successCount > 0,
      message: successCount > 0
        ? `Uploaded ${successCount} link(s) for ${brand.toUpperCase()}`
        : 'No links uploaded',
      successCount,
      errorCount,
      errors: errors.slice(0, 5),
      links,
      brandCounts: counts,
      totalCount: Object.values(counts).reduce((a, b) => a + b, 0)
    });
  }

  if (successCount > 0) {
    req.flash('success', `Successfully uploaded ${successCount} product link(s) for brand "${brand.toUpperCase()}"`);
  }
  if (errorCount > 0) {
    req.flash('error', `Failed to upload ${errorCount} row(s). ${errors.slice(0, 3).join(', ')}`);
  }

  res.redirect('/product-links');
});

/**
 * POST /product-links/:id/delete
 * Delete a single product link entry (operator only)
 * Returns JSON for AJAX requests
 */
router.post('/:id/delete', isAuthenticated, isOperator, async (req, res) => {
  const isAjax = req.headers.accept && req.headers.accept.includes('application/json');
  const { id } = req.params;

  try {
    const [result] = await pool.query('DELETE FROM product_links WHERE id = ?', [id]);
    if (result.affectedRows > 0) {
      if (isAjax) return res.json({ success: true, message: 'Deleted successfully' });
      req.flash('success', 'Product link deleted successfully');
    } else {
      if (isAjax) return res.status(404).json({ success: false, error: 'Product link not found' });
      req.flash('error', 'Product link not found');
    }
  } catch (err) {
    console.error('Error deleting product link:', err);
    if (isAjax) return res.status(500).json({ success: false, error: 'Failed to delete' });
    req.flash('error', 'Failed to delete product link');
  }

  res.redirect('/product-links');
});

/**
 * GET /product-links/export
 * Export all product links to Excel (operator only)
 */
router.get('/export', isAuthenticated, isOperator, async (req, res) => {
  try {
    const brand = req.query.brand;
    let query = `
      SELECT brand, sku, amazon_link, myntra_link, nykaa_link, flipkart_link, created_at
      FROM product_links
    `;
    const params = [];

    if (brand && BRANDS.includes(brand.toLowerCase())) {
      query += ' WHERE brand = ?';
      params.push(brand.toLowerCase());
    }

    query += ' ORDER BY brand ASC, sku ASC';

    const [links] = await pool.query(query, params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('ProductLinks');

    sheet.columns = [
      { header: 'Brand', key: 'brand', width: 15 },
      { header: 'SKU', key: 'sku', width: 25 },
      { header: 'Amazon', key: 'amazon_link', width: 60 },
      { header: 'Myntra', key: 'myntra_link', width: 60 },
      { header: 'Nykaa', key: 'nykaa_link', width: 60 },
      { header: 'Flipkart', key: 'flipkart_link', width: 60 },
      { header: 'Created At', key: 'created_at', width: 20 }
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' }
    };

    links.forEach(link => {
      link.brand = link.brand.toUpperCase();
      sheet.addRow(link);
    });

    const brandSuffix = brand ? `-${brand.toUpperCase()}` : '';
    const filename = `ProductLinks${brandSuffix}-${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting product links:', err);
    req.flash('error', 'Failed to export product links');
    res.redirect('/product-links');
  }
});

module.exports = router;
