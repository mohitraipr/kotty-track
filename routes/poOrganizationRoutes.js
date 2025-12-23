const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isNowIPOOrganization } = require('../middlewares/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const normalizeHeader = (value) =>
  value ? value.toString().trim().toLowerCase().replace(/\s+/g, '_') : '';

const buildHeaderIndex = (worksheet) => {
  const headerRow = worksheet.getRow(1);
  const index = {};
  headerRow.eachCell((cell, colNumber) => {
    const key = normalizeHeader(cell.value);
    if (key) {
      index[key] = colNumber;
    }
  });
  return index;
};

const readCell = (row, colIndex) => {
  if (!colIndex) {
    return '';
  }
  const cellValue = row.getCell(colIndex).value;
  if (cellValue === null || typeof cellValue === 'undefined') {
    return '';
  }
  if (typeof cellValue === 'object' && cellValue.text) {
    return cellValue.text.toString().trim();
  }
  return cellValue.toString().trim();
};

const parseNumber = (value) => {
  if (value === '' || value === null || typeof value === 'undefined') {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

router.get('/dashboard', isNowIPOOrganization, async (req, res) => {
  try {
    const [batches] = await pool.query(
      `
      SELECT
        b.id,
        b.created_at,
        u.username AS created_by,
        COUNT(DISTINCT o.id) AS vendor_count,
        COALESCE(SUM(i.quantity), 0) AS total_quantity
      FROM po_vendor_batches b
      LEFT JOIN users u ON b.created_by = u.id
      LEFT JOIN po_vendor_orders o ON o.batch_id = b.id
      LEFT JOIN po_vendor_order_items i ON i.order_id = o.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT 10
      `
    );

    res.render('po-organization/dashboard', {
      user: req.session.user,
      batches
    });
  } catch (error) {
    console.error('Error loading PO Organization dashboard:', error);
    req.flash('error', 'Error loading dashboard.');
    res.redirect('/');
  }
});

router.post(
  '/mappings/upload',
  isNowIPOOrganization,
  upload.single('mappingFile'),
  async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please upload a mapping file.');
      return res.redirect('/po-organization/dashboard');
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.worksheets[0];

      if (!worksheet) {
        req.flash('error', 'Uploaded file is empty.');
        return res.redirect('/po-organization/dashboard');
      }

      const headerIndex = buildHeaderIndex(worksheet);
      const vendorCol =
        headerIndex.vendor_code || headerIndex.vendor || headerIndex.vendorcode;
      const skuCol = headerIndex.sku;
      const colorCol = headerIndex.color;
      const linkCol = headerIndex.link || headerIndex.product_link;
      const imageCol = headerIndex.image || headerIndex.image_url;
      const weightCol = headerIndex.weight;

      if (!vendorCol || !skuCol) {
        req.flash('error', 'File must include vendor_code and sku columns.');
        return res.redirect('/po-organization/dashboard');
      }

      const rows = [];
      const errors = [];
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const sku = readCell(row, skuCol);
        const vendorCode = readCell(row, vendorCol);
        const color = readCell(row, colorCol);
        const link = readCell(row, linkCol);
        const imageUrl = readCell(row, imageCol);
        const weight = parseNumber(readCell(row, weightCol));

        if (!sku && !vendorCode) {
          return;
        }
        if (!sku || !vendorCode) {
          errors.push(`Row ${rowNumber}: sku and vendor_code are required.`);
          return;
        }

        rows.push({
          sku,
          vendorCode,
          color,
          link,
          imageUrl,
          weight
        });
      });

      if (errors.length) {
        req.flash('error', errors.join(' '));
        return res.redirect('/po-organization/dashboard');
      }

      if (!rows.length) {
        req.flash('error', 'No valid rows found in the mapping file.');
        return res.redirect('/po-organization/dashboard');
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const row of rows) {
          await connection.query(
            `
            INSERT INTO po_sku_vendor_mappings
              (sku, vendor_code, color, image_url, weight, link)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              vendor_code = VALUES(vendor_code),
              color = VALUES(color),
              image_url = VALUES(image_url),
              weight = VALUES(weight),
              link = VALUES(link)
            `,
            [
              row.sku,
              row.vendorCode,
              row.color || null,
              row.imageUrl || null,
              row.weight,
              row.link || null
            ]
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      req.flash('success', 'SKU mapping file processed successfully.');
      return res.redirect('/po-organization/dashboard');
    } catch (error) {
      console.error('Error uploading SKU mappings:', error);
      req.flash('error', 'Failed to process the mapping file.');
      return res.redirect('/po-organization/dashboard');
    }
  }
);

router.post(
  '/po/upload',
  isNowIPOOrganization,
  upload.single('poFile'),
  async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please upload a PO file.');
      return res.redirect('/po-organization/dashboard');
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.worksheets[0];

      if (!worksheet) {
        req.flash('error', 'Uploaded file is empty.');
        return res.redirect('/po-organization/dashboard');
      }

      const headerIndex = buildHeaderIndex(worksheet);
      const skuCol = headerIndex.sku;
      const sizeCol = headerIndex.size || headerIndex.product_size;
      const quantityCol = headerIndex.quantity || headerIndex.qty;

      if (!skuCol || !sizeCol || !quantityCol) {
        req.flash('error', 'File must include sku, size, and quantity columns.');
        return res.redirect('/po-organization/dashboard');
      }

      const items = [];
      const errors = [];
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const sku = readCell(row, skuCol);
        const size = readCell(row, sizeCol);
        const quantity = parseNumber(readCell(row, quantityCol));

        if (!sku && !size && !quantity) {
          return;
        }
        if (!sku || !size || !quantity) {
          errors.push(`Row ${rowNumber}: sku, size, and quantity are required.`);
          return;
        }
        if (quantity <= 0) {
          errors.push(`Row ${rowNumber}: quantity must be greater than 0.`);
          return;
        }
        items.push({ sku, size, quantity });
      });

      if (errors.length) {
        req.flash('error', errors.join(' '));
        return res.redirect('/po-organization/dashboard');
      }

      if (!items.length) {
        req.flash('error', 'No valid rows found in the PO file.');
        return res.redirect('/po-organization/dashboard');
      }

      const uniqueSkus = [...new Set(items.map((item) => item.sku))];
      const [mappingRows] = await pool.query(
        'SELECT * FROM po_sku_vendor_mappings WHERE sku IN (?)',
        [uniqueSkus]
      );

      const mappingMap = new Map(mappingRows.map((row) => [row.sku, row]));
      const missingSkus = uniqueSkus.filter((sku) => !mappingMap.has(sku));

      if (missingSkus.length) {
        req.flash(
          'error',
          `Missing mappings for SKU(s): ${missingSkus.join(', ')}`
        );
        return res.redirect('/po-organization/dashboard');
      }

      const groupedByVendor = new Map();
      for (const item of items) {
        const mapping = mappingMap.get(item.sku);
        const vendorCode = mapping.vendor_code;
        if (!groupedByVendor.has(vendorCode)) {
          groupedByVendor.set(vendorCode, []);
        }
        groupedByVendor.get(vendorCode).push({
          sku: item.sku,
          size: item.size,
          quantity: item.quantity,
          color: mapping.color,
          image_url: mapping.image_url,
          weight: mapping.weight,
          link: mapping.link
        });
      }

      const connection = await pool.getConnection();
      let batchId;
      try {
        await connection.beginTransaction();
        const [batchResult] = await connection.query(
          'INSERT INTO po_vendor_batches (created_by) VALUES (?)',
          [req.session.user.id]
        );
        batchId = batchResult.insertId;

        for (const [vendorCode, vendorItems] of groupedByVendor.entries()) {
          const [orderResult] = await connection.query(
            'INSERT INTO po_vendor_orders (batch_id, vendor_code) VALUES (?, ?)',
            [batchId, vendorCode]
          );
          const orderId = orderResult.insertId;
          const values = vendorItems.map((row) => [
            orderId,
            row.sku,
            row.size,
            row.quantity,
            row.color,
            row.image_url,
            row.weight,
            row.link
          ]);
          await connection.query(
            `
            INSERT INTO po_vendor_order_items
              (order_id, sku, product_size, quantity, color, image_url, weight, link)
            VALUES ?
            `,
            [values]
          );
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      req.flash('success', 'PO batch generated successfully.');
      return res.redirect(`/po-organization/batch/${batchId}`);
    } catch (error) {
      console.error('Error generating PO batch:', error);
      req.flash('error', 'Failed to generate PO batch.');
      return res.redirect('/po-organization/dashboard');
    }
  }
);

router.get('/batch/:id', isNowIPOOrganization, async (req, res) => {
  try {
    const [batches] = await pool.query(
      `
      SELECT
        b.id,
        b.created_at,
        u.username AS created_by
      FROM po_vendor_batches b
      LEFT JOIN users u ON b.created_by = u.id
      WHERE b.id = ?
      `,
      [req.params.id]
    );

    if (!batches.length) {
      req.flash('error', 'Batch not found.');
      return res.redirect('/po-organization/dashboard');
    }

    const [orders] = await pool.query(
      `
      SELECT
        o.id,
        o.vendor_code,
        o.created_at,
        COUNT(i.id) AS item_count,
        COALESCE(SUM(i.quantity), 0) AS total_quantity
      FROM po_vendor_orders o
      LEFT JOIN po_vendor_order_items i ON i.order_id = o.id
      WHERE o.batch_id = ?
      GROUP BY o.id
      ORDER BY o.vendor_code
      `,
      [req.params.id]
    );

    res.render('po-organization/batch', {
      user: req.session.user,
      batch: batches[0],
      orders
    });
  } catch (error) {
    console.error('Error loading batch details:', error);
    req.flash('error', 'Error loading batch details.');
    res.redirect('/po-organization/dashboard');
  }
});

router.get('/order/:id', isNowIPOOrganization, async (req, res) => {
  try {
    const [orders] = await pool.query(
      `
      SELECT o.*, b.id AS batch_id
      FROM po_vendor_orders o
      JOIN po_vendor_batches b ON b.id = o.batch_id
      WHERE o.id = ?
      `,
      [req.params.id]
    );

    if (!orders.length) {
      req.flash('error', 'PO order not found.');
      return res.redirect('/po-organization/dashboard');
    }

    const [items] = await pool.query(
      `
      SELECT
        sku,
        color,
        product_size,
        quantity,
        weight,
        link,
        image_url
      FROM po_vendor_order_items
      WHERE order_id = ?
      ORDER BY sku
      `,
      [req.params.id]
    );

    res.render('po-organization/order', {
      user: req.session.user,
      order: orders[0],
      items
    });
  } catch (error) {
    console.error('Error loading PO order:', error);
    req.flash('error', 'Error loading PO order.');
    res.redirect('/po-organization/dashboard');
  }
});

router.get('/order/:id/download', isNowIPOOrganization, async (req, res) => {
  try {
    const [orders] = await pool.query(
      `
      SELECT id, vendor_code, created_at
      FROM po_vendor_orders
      WHERE id = ?
      `,
      [req.params.id]
    );

    if (!orders.length) {
      req.flash('error', 'PO order not found.');
      return res.redirect('/po-organization/dashboard');
    }

    const [items] = await pool.query(
      `
      SELECT
        sku,
        color,
        product_size,
        quantity,
        weight,
        link,
        image_url
      FROM po_vendor_order_items
      WHERE order_id = ?
      ORDER BY sku
      `,
      [req.params.id]
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Vendor PO');
    worksheet.columns = [
      { header: 'Vendor Code', key: 'vendor_code', width: 18 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Color', key: 'color', width: 15 },
      { header: 'Product Size', key: 'product_size', width: 15 },
      { header: 'Quantity', key: 'quantity', width: 12 },
      { header: 'Weight', key: 'weight', width: 12 },
      { header: 'Link', key: 'link', width: 40 },
      { header: 'Image', key: 'image_url', width: 40 }
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    items.forEach((item) => {
      worksheet.addRow({
        vendor_code: orders[0].vendor_code,
        sku: item.sku,
        color: item.color,
        product_size: item.product_size,
        quantity: item.quantity,
        weight: item.weight,
        link: item.link,
        image_url: item.image_url
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=vendor-po-${orders[0].vendor_code}-${Date.now()}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error downloading PO order:', error);
    req.flash('error', 'Failed to download PO order.');
    res.redirect('/po-organization/dashboard');
  }
});

module.exports = router;
