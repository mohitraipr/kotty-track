// routes/nowiPoRoutes.js
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { pool } = require('../config/db');
const { isAuthenticated, isNowiPOOrganization } = require('../middlewares/auth');

const router = express.Router();
const upload = multer();

const REQUIRED_MAPPING_FIELDS = ['sku', 'vendor_code'];
const OPTIONAL_MAPPING_FIELDS = ['color', 'link', 'image', 'weight'];
const REQUIRED_PO_FIELDS = ['sku', 'size', 'quantity'];

const headerAliases = {
  sku: ['sku'],
  vendor_code: ['vendorcode', 'vendor_code', 'vendor code'],
  color: ['color', 'colour'],
  link: ['link', 'url'],
  image: ['image', 'imageurl', 'image url'],
  weight: ['weight', 'wt']
};

const poHeaderAliases = {
  sku: ['sku'],
  size: ['size', 'product size', 'productsize'],
  quantity: ['quantity', 'qty']
};

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function resolveHeaderIndexes(headers, requiredFields, aliases) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const indexMap = {};

  Object.entries(aliases).forEach(([field, candidates]) => {
    const normalizedCandidates = candidates.map(normalizeHeader);
    const index = normalizedHeaders.findIndex(header => normalizedCandidates.includes(header));
    if (index !== -1) {
      indexMap[field] = index;
    }
  });

  const missing = requiredFields.filter(field => typeof indexMap[field] !== 'number');
  return { indexMap, missing };
}

function parseSheet(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const [sheetName] = workbook.SheetNames;
  if (!sheetName) {
    return { headers: [], rows: [] };
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headers = rows.length > 0 ? rows[0] : [];
  return { headers, rows: rows.slice(1) };
}

function isEmptyRow(values) {
  return values.every(value => String(value || '').trim() === '');
}

router.get('/dashboard', isAuthenticated, isNowiPOOrganization, async (req, res) => {
  try {
    const [[mappingCount]] = await pool.query(
      'SELECT COUNT(*) AS count FROM nowi_po_sku_mappings'
    );
    const [[poCount]] = await pool.query('SELECT COUNT(*) AS count FROM nowi_po_headers');
    const [recentPos] = await pool.query(
      `SELECT id, po_number, vendor_code, created_at
       FROM nowi_po_headers
       ORDER BY created_at DESC
       LIMIT 5`
    );

    res.render('nowi-po/dashboard', {
      user: req.session.user,
      mappingCount: mappingCount?.count || 0,
      poCount: poCount?.count || 0,
      recentPos
    });
  } catch (error) {
    console.error('Error loading nowi-po dashboard:', error);
    req.flash('error', 'Unable to load dashboard data.');
    res.render('nowi-po/dashboard', {
      user: req.session.user,
      mappingCount: 0,
      poCount: 0,
      recentPos: []
    });
  }
});

router.post(
  '/mappings/upload',
  isAuthenticated,
  isNowiPOOrganization,
  upload.single('mappingFile'),
  async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please upload a mapping sheet to continue.');
      return res.redirect('/nowi-po/dashboard');
    }

    const { headers, rows } = parseSheet(req.file.buffer);
    const { indexMap, missing } = resolveHeaderIndexes(
      headers,
      REQUIRED_MAPPING_FIELDS,
      headerAliases
    );

    if (missing.length > 0) {
      req.flash(
        'error',
        `Missing required columns: ${missing.join(', ')}.`
      );
      return res.redirect('/nowi-po/dashboard');
    }

    const mappingValues = [];
    const errors = [];

    rows.forEach((row, idx) => {
      if (isEmptyRow(row)) {
        return;
      }

      const rowNumber = idx + 2;
      const sku = String(row[indexMap.sku] || '').trim();
      const vendorCode = String(row[indexMap.vendor_code] || '').trim();
      const color = String(row[indexMap.color] || '').trim();
      const link = String(row[indexMap.link] || '').trim();
      const image = String(row[indexMap.image] || '').trim();
      const weightRaw = String(row[indexMap.weight] || '').trim();
      const weight = weightRaw ? Number(weightRaw) : null;

      if (!sku || !vendorCode) {
        errors.push(`Row ${rowNumber}: SKU and Vendor Code are required.`);
        return;
      }

      if (weightRaw && Number.isNaN(weight)) {
        errors.push(`Row ${rowNumber}: Weight must be a number.`);
        return;
      }

      mappingValues.push([
        sku,
        vendorCode,
        color || null,
        link || null,
        image || null,
        weight
      ]);
    });

    if (errors.length > 0) {
      req.flash('error', errors.slice(0, 5).join(' '));
      return res.redirect('/nowi-po/dashboard');
    }

    if (mappingValues.length === 0) {
      req.flash('error', 'No valid rows were found in the mapping sheet.');
      return res.redirect('/nowi-po/dashboard');
    }

    try {
      await pool.query(
        `INSERT INTO nowi_po_sku_mappings
          (sku, vendor_code, color, link, image, weight)
         VALUES ?
         ON DUPLICATE KEY UPDATE
          vendor_code = VALUES(vendor_code),
          color = VALUES(color),
          link = VALUES(link),
          image = VALUES(image),
          weight = VALUES(weight)`,
        [mappingValues]
      );

      req.flash(
        'success',
        `Uploaded ${mappingValues.length} SKU mapping rows successfully.`
      );
      return res.redirect('/nowi-po/dashboard');
    } catch (error) {
      console.error('Error uploading SKU mappings:', error);
      req.flash('error', 'Failed to upload mapping sheet.');
      return res.redirect('/nowi-po/dashboard');
    }
  }
);

router.post(
  '/po/upload',
  isAuthenticated,
  isNowiPOOrganization,
  upload.single('poFile'),
  async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please upload a PO sheet to continue.');
      return res.redirect('/nowi-po/dashboard');
    }

    const { headers, rows } = parseSheet(req.file.buffer);
    const { indexMap, missing } = resolveHeaderIndexes(
      headers,
      REQUIRED_PO_FIELDS,
      poHeaderAliases
    );

    if (missing.length > 0) {
      req.flash('error', `Missing required columns: ${missing.join(', ')}.`);
      return res.redirect('/nowi-po/dashboard');
    }

    const poRows = [];
    const errors = [];

    rows.forEach((row, idx) => {
      if (isEmptyRow(row)) {
        return;
      }

      const rowNumber = idx + 2;
      const sku = String(row[indexMap.sku] || '').trim();
      const size = String(row[indexMap.size] || '').trim();
      const quantityRaw = String(row[indexMap.quantity] || '').trim();
      const quantity = Number(quantityRaw);

      if (!sku || !size || !quantityRaw) {
        errors.push(`Row ${rowNumber}: SKU, Size, and Quantity are required.`);
        return;
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push(`Row ${rowNumber}: Quantity must be a positive integer.`);
        return;
      }

      poRows.push({ sku, size, quantity });
    });

    if (errors.length > 0) {
      req.flash('error', errors.slice(0, 5).join(' '));
      return res.redirect('/nowi-po/dashboard');
    }

    if (poRows.length === 0) {
      req.flash('error', 'No valid rows were found in the PO sheet.');
      return res.redirect('/nowi-po/dashboard');
    }

    const uniqueSkus = [...new Set(poRows.map(row => row.sku))];

    try {
      const [mappingRows] = await pool.query(
        'SELECT sku, vendor_code, color, link, image, weight FROM nowi_po_sku_mappings WHERE sku IN (?)',
        [uniqueSkus]
      );

      const mappingMap = new Map(mappingRows.map(row => [row.sku, row]));
      const missingSkus = uniqueSkus.filter(sku => !mappingMap.has(sku));

      if (missingSkus.length > 0) {
        req.flash(
          'error',
          `Missing SKU mappings for: ${missingSkus.slice(0, 5).join(', ')}.`
        );
        return res.redirect('/nowi-po/dashboard');
      }

      const groupedByVendor = poRows.reduce((acc, row) => {
        const mapping = mappingMap.get(row.sku);
        const vendorCode = mapping.vendor_code;
        if (!acc[vendorCode]) {
          acc[vendorCode] = [];
        }
        acc[vendorCode].push({
          ...row,
          color: mapping.color,
          link: mapping.link,
          image: mapping.image,
          weight: mapping.weight,
          vendor_code: vendorCode
        });
        return acc;
      }, {});

      const connection = await pool.getConnection();
      const createdPoIds = [];

      try {
        await connection.beginTransaction();

        for (const [vendorCode, lines] of Object.entries(groupedByVendor)) {
          const [headerResult] = await connection.query(
            'INSERT INTO nowi_po_headers (vendor_code, created_by) VALUES (?, ?)',
            [vendorCode, req.session.user.id]
          );

          const poId = headerResult.insertId;
          const poNumber = `NOWI-PO-${poId}`;
          await connection.query(
            'UPDATE nowi_po_headers SET po_number = ? WHERE id = ?',
            [poNumber, poId]
          );

          const lineValues = lines.map(line => [
            poId,
            line.sku,
            line.size,
            line.quantity,
            line.color || null,
            line.image || null,
            line.link || null,
            line.weight ?? null,
            vendorCode
          ]);

          await connection.query(
            `INSERT INTO nowi_po_lines
              (po_id, sku, size, quantity, color, image, link, weight, vendor_code)
             VALUES ?`,
            [lineValues]
          );

          createdPoIds.push(poId);
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      req.flash(
        'success',
        `Generated ${createdPoIds.length} vendor PO(s) successfully.`
      );
      return res.redirect('/nowi-po/po');
    } catch (error) {
      console.error('Error generating PO:', error);
      req.flash('error', 'Failed to generate vendor PO files.');
      return res.redirect('/nowi-po/dashboard');
    }
  }
);

router.get('/po', isAuthenticated, isNowiPOOrganization, async (req, res) => {
  try {
    const [poRows] = await pool.query(
      `SELECT h.id, h.po_number, h.vendor_code, h.created_at, u.username,
              COUNT(l.id) AS line_count, COALESCE(SUM(l.quantity), 0) AS total_quantity
         FROM nowi_po_headers h
         LEFT JOIN users u ON h.created_by = u.id
         LEFT JOIN nowi_po_lines l ON l.po_id = h.id
        GROUP BY h.id
        ORDER BY h.created_at DESC`
    );

    res.render('nowi-po/po-list', {
      user: req.session.user,
      poRows
    });
  } catch (error) {
    console.error('Error loading PO list:', error);
    req.flash('error', 'Unable to load PO list.');
    res.render('nowi-po/po-list', {
      user: req.session.user,
      poRows: []
    });
  }
});

router.get('/po/:id', isAuthenticated, isNowiPOOrganization, async (req, res) => {
  try {
    const { id } = req.params;

    const [[header]] = await pool.query(
      `SELECT h.id, h.po_number, h.vendor_code, h.created_at, u.username
         FROM nowi_po_headers h
         LEFT JOIN users u ON h.created_by = u.id
        WHERE h.id = ?`,
      [id]
    );

    if (!header) {
      req.flash('error', 'PO not found.');
      return res.redirect('/nowi-po/po');
    }

    const [lines] = await pool.query(
      `SELECT sku, size, quantity, color, image, link, weight, vendor_code
         FROM nowi_po_lines
        WHERE po_id = ?
        ORDER BY id ASC`,
      [id]
    );

    res.render('nowi-po/po-view', {
      user: req.session.user,
      header,
      lines
    });
  } catch (error) {
    console.error('Error loading PO details:', error);
    req.flash('error', 'Unable to load PO details.');
    return res.redirect('/nowi-po/po');
  }
});

module.exports = router;
