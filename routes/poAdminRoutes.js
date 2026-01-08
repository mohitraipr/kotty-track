const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx files are allowed!'), false);
    }
  }
});

const fsPromises = fs.promises;

const DEFAULT_MARKETPLACES = [
  {
    name: 'Flipkart',
    masterColumns: ['FSN', 'TITLE', 'MRP', 'STYLECODE', 'COLOR', 'SIZE', 'GENERIC NAME', 'SKU'],
    poColumns: [
      'Product Name',
      'FSN',
      'SKU Id',
      'Brand',
      'Size',
      'Style Code',
      'Color',
      'Isbn',
      'Model Id',
      'Quantity Sent',
      'Quantity Received',
      'Inwarded to Store',
      'QC Fail',
      'QC In Progress',
      'QC Passed',
      'Cost Price',
      'Length(In cms)',
      'Breadth(In cms)',
      'Height(In cms)',
      'Weight(In kgs)'
    ]
  },
  {
    name: 'Amazon',
    masterColumns: ['SKU', 'ASIN', 'SIZE', 'MRP', 'COLOR', 'STYLE ID', 'TITLE', 'GENERIC NAME', 'Condition'],
    poColumns: [
      'PO+ASIN',
      'PO',
      'Vendor',
      'Ship to location',
      'ASIN',
      'External Id',
      'External Id Type',
      'Model Number',
      'Title',
      'Availability',
      'Window Type',
      'Window start',
      'Window end',
      'Expected date',
      'Quantity Requested',
      'Accepted quantity',
      'Quantity received',
      'Quantity Outstanding',
      'Unit Cost',
      'Total cost'
    ]
  },
  {
    name: 'Myntra',
    masterColumns: [
      'SKU',
      'ARTICLENUMBER',
      'SKUCODE',
      'STYLECODE',
      'Quantity',
      'Size',
      'Color',
      'Warehouse References',
      'MRP',
      'Title'
    ],
    poColumns: [
      'PO NUMBER',
      'SKU Id',
      'Style Id',
      'SKU Code',
      'HSN Code',
      'Brand',
      'GTIN',
      'Vendor Article Number',
      'Vendor Article Name',
      'Size',
      'Colour',
      'Mrp',
      'Credit Period',
      'Margin Type',
      'Agreed Margin',
      'Gross Margin',
      'Quantity',
      'FOB Amount',
      'List price(FOB+Transport-Excise)',
      'Landing Price',
      'Estimated Delivery Date',
      'Tax BCD',
      'Tax BCD Amount',
      'Buying Tax IGST',
      'Buying Tax IGST Amount',
      'Tax SWT',
      'Tax SWT Amount',
      'Selling Tax CGST',
      'Selling Tax CGST Amount',
      'Selling Tax IGST',
      'Selling Tax IGST Amount',
      'Selling Tax SGST',
      'Selling Tax SGST Amount'
    ]
  }
];

function getCellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.richText) return value.richText.map(item => item.text).join('').trim();
    if (value.result) return String(value.result).trim();
    if (value.hyperlink) return String(value.text || value.hyperlink).trim();
  }
  return String(value).trim();
}

function normalizeHeader(header) {
  return String(header || '').trim().toLowerCase();
}

function buildSearchBlob(rowData) {
  return Object.values(rowData)
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

async function ensurePoAdminSetup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_marketplaces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(60) NOT NULL UNIQUE,
      master_columns JSON NOT NULL,
      po_columns JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_master_data (
      id INT AUTO_INCREMENT PRIMARY KEY,
      marketplace_id INT NOT NULL,
      sku VARCHAR(150) NOT NULL,
      data JSON NOT NULL,
      search_blob LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_marketplace_sku (marketplace_id, sku),
      INDEX idx_master_marketplace (marketplace_id),
      CONSTRAINT fk_po_admin_master_marketplace
        FOREIGN KEY (marketplace_id) REFERENCES po_admin_marketplaces(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_admin_po_uploads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      marketplace_id INT NOT NULL,
      data JSON NOT NULL,
      search_blob LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_po_marketplace (marketplace_id),
      CONSTRAINT fk_po_admin_po_marketplace
        FOREIGN KEY (marketplace_id) REFERENCES po_admin_marketplaces(id)
        ON DELETE CASCADE
    )
  `);

  const [[marketplaceCount]] = await pool.query(
    'SELECT COUNT(*) AS count FROM po_admin_marketplaces'
  );

  if (marketplaceCount.count === 0) {
    const values = DEFAULT_MARKETPLACES.map(marketplace => [
      marketplace.name,
      JSON.stringify(marketplace.masterColumns),
      JSON.stringify(marketplace.poColumns)
    ]);
    await pool.query(
      'INSERT INTO po_admin_marketplaces (name, master_columns, po_columns) VALUES ?'
      , [values]
    );
  }
}

async function fetchMarketplaces() {
  const [rows] = await pool.query(
    'SELECT id, name, master_columns AS masterColumns, po_columns AS poColumns FROM po_admin_marketplaces ORDER BY name'
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    masterColumns: Array.isArray(row.masterColumns) ? row.masterColumns : JSON.parse(row.masterColumns || '[]'),
    poColumns: Array.isArray(row.poColumns) ? row.poColumns : JSON.parse(row.poColumns || '[]')
  }));
}

function chunkArray(items, chunkSize = 500) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

router.get('/dashboard', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  try {
    await ensurePoAdminSetup();
    const marketplaces = await fetchMarketplaces();

    res.render('po-admin/dashboard', {
      user: req.session.user,
      marketplaces
    });
  } catch (error) {
    console.error('Error loading PO Admin dashboard:', error);
    req.flash('error', 'Unable to load PO Admin dashboard.');
    res.redirect('/');
  }
});

router.get('/api/marketplaces', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  try {
    await ensurePoAdminSetup();
    const marketplaces = await fetchMarketplaces();
    res.json({ marketplaces });
  } catch (error) {
    console.error('Error fetching marketplaces:', error);
    res.status(500).json({ error: 'Unable to load marketplaces.' });
  }
});

router.post('/upload-master', isAuthenticated, allowRoles(['poadmins', 'poadmin']), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a valid .xlsx file.' });
  }

  const marketplaceId = Number(req.body.marketplaceId);
  if (!marketplaceId) {
    return res.status(400).json({ error: 'Marketplace is required.' });
  }

  try {
    await ensurePoAdminSetup();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ error: 'No worksheet found in the uploaded file.' });
    }

    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell((cell, colNumber) => {
      headers[colNumber - 1] = getCellText(cell.value);
    });

    const normalizedHeaders = headers.map(header => normalizeHeader(header));
    const skuIndex = normalizedHeaders.findIndex(header => header === 'sku');
    if (skuIndex === -1) {
      return res.status(400).json({ error: 'Master data sheet must include a SKU column.' });
    }

    const fileSkuSet = new Set();
    const duplicateSkus = new Set();
    const rowsToInsert = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const rowData = {};
      headers.forEach((header, index) => {
        if (header) {
          rowData[header] = getCellText(row.getCell(index + 1).value);
        }
      });

      const skuRaw = rowData[headers[skuIndex]] || '';
      const sku = String(skuRaw || '').trim().toUpperCase();
      if (!sku) {
        return;
      }

      if (fileSkuSet.has(sku)) {
        duplicateSkus.add(sku);
        return;
      }

      fileSkuSet.add(sku);
      rowsToInsert.push({
        sku,
        data: rowData,
        searchBlob: buildSearchBlob(rowData)
      });
    });

    if (rowsToInsert.length === 0) {
      return res.json({ insertedCount: 0, skippedExisting: [], skippedDuplicates: Array.from(duplicateSkus) });
    }

    const existingSkus = new Set();
    const skuChunks = chunkArray(rowsToInsert.map(row => row.sku));
    for (const chunk of skuChunks) {
      const [existingRows] = await pool.query(
        'SELECT sku FROM po_admin_master_data WHERE marketplace_id = ? AND sku IN (?)',
        [marketplaceId, chunk]
      );
      existingRows.forEach(row => existingSkus.add(String(row.sku).toUpperCase()));
    }

    const insertValues = [];
    const skippedExisting = [];

    rowsToInsert.forEach(row => {
      if (existingSkus.has(row.sku)) {
        skippedExisting.push(row.sku);
        return;
      }
      insertValues.push([
        marketplaceId,
        row.sku,
        JSON.stringify(row.data),
        row.searchBlob
      ]);
    });

    if (insertValues.length) {
      await pool.query(
        'INSERT INTO po_admin_master_data (marketplace_id, sku, data, search_blob) VALUES ?'
        , [insertValues]
      );
    }

    res.json({
      insertedCount: insertValues.length,
      skippedExisting,
      skippedDuplicates: Array.from(duplicateSkus)
    });
  } catch (error) {
    console.error('Error uploading master data:', error);
    res.status(500).json({ error: 'Unable to upload master data.' });
  } finally {
    if (req.file?.path) {
      await fsPromises.unlink(req.file.path).catch(() => undefined);
    }
  }
});

router.post('/upload-po', isAuthenticated, allowRoles(['poadmins', 'poadmin']), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a valid .xlsx file.' });
  }

  const marketplaceId = Number(req.body.marketplaceId);
  if (!marketplaceId) {
    return res.status(400).json({ error: 'Marketplace is required.' });
  }

  try {
    await ensurePoAdminSetup();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ error: 'No worksheet found in the uploaded file.' });
    }

    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell((cell, colNumber) => {
      headers[colNumber - 1] = getCellText(cell.value);
    });

    const insertValues = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const rowData = {};
      headers.forEach((header, index) => {
        if (header) {
          rowData[header] = getCellText(row.getCell(index + 1).value);
        }
      });

      const hasValues = Object.values(rowData).some(value => String(value || '').trim());
      if (!hasValues) {
        return;
      }

      insertValues.push([
        marketplaceId,
        JSON.stringify(rowData),
        buildSearchBlob(rowData)
      ]);
    });

    if (insertValues.length) {
      await pool.query(
        'INSERT INTO po_admin_po_uploads (marketplace_id, data, search_blob) VALUES ?'
        , [insertValues]
      );
    }

    res.json({ insertedCount: insertValues.length });
  } catch (error) {
    console.error('Error uploading PO data:', error);
    res.status(500).json({ error: 'Unable to upload PO data.' });
  } finally {
    if (req.file?.path) {
      await fsPromises.unlink(req.file.path).catch(() => undefined);
    }
  }
});

router.get('/api/master-data', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  const marketplaceId = Number(req.query.marketplaceId);
  const search = String(req.query.search || '').trim();
  const page = Number(req.query.page || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  if (!marketplaceId) {
    return res.status(400).json({ error: 'Marketplace is required.' });
  }

  try {
    await ensurePoAdminSetup();

    const whereClause = search
      ? 'AND (sku LIKE ? OR search_blob LIKE ?)'
      : '';
    const searchParams = search
      ? [`%${search}%`, `%${search.toLowerCase()}%`]
      : [];

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM po_admin_master_data WHERE marketplace_id = ? ${whereClause}`,
      [marketplaceId, ...searchParams]
    );

    const [rows] = await pool.query(
      `SELECT id, sku, data, created_at FROM po_admin_master_data
       WHERE marketplace_id = ? ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [marketplaceId, ...searchParams, pageSize, offset]
    );

    res.json({
      total: countRows[0]?.total || 0,
      page,
      pageSize,
      rows: rows.map(row => ({
        id: row.id,
        sku: row.sku,
        createdAt: row.created_at,
        data: typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data
      }))
    });
  } catch (error) {
    console.error('Error fetching master data:', error);
    res.status(500).json({ error: 'Unable to load master data.' });
  }
});

router.get('/api/po-data', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  const marketplaceId = Number(req.query.marketplaceId);
  const search = String(req.query.search || '').trim();
  const page = Number(req.query.page || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  if (!marketplaceId) {
    return res.status(400).json({ error: 'Marketplace is required.' });
  }

  try {
    await ensurePoAdminSetup();

    const whereClause = search ? 'AND search_blob LIKE ?' : '';
    const searchParams = search ? [`%${search.toLowerCase()}%`] : [];

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM po_admin_po_uploads WHERE marketplace_id = ? ${whereClause}`,
      [marketplaceId, ...searchParams]
    );

    const [rows] = await pool.query(
      `SELECT id, data, created_at FROM po_admin_po_uploads
       WHERE marketplace_id = ? ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [marketplaceId, ...searchParams, pageSize, offset]
    );

    res.json({
      total: countRows[0]?.total || 0,
      page,
      pageSize,
      rows: rows.map(row => ({
        id: row.id,
        createdAt: row.created_at,
        data: typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data
      }))
    });
  } catch (error) {
    console.error('Error fetching PO data:', error);
    res.status(500).json({ error: 'Unable to load PO data.' });
  }
});

module.exports = router;
