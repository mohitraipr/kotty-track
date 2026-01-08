const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const crypto = require('crypto');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');
const {
  MARKETPLACE_MATCH_RULES,
  ensurePoAdminSetup,
  fetchMarketplaces,
  hashAccessKey
} = require('../helpers/poAdminData');

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

function getValueByHeader(rowData, headerName) {
  const target = normalizeHeader(headerName);
  for (const [key, value] of Object.entries(rowData || {})) {
    if (normalizeHeader(key) === target) {
      return String(value || '').trim();
    }
  }
  return '';
}

function buildSearchBlob(rowData) {
  return Object.values(rowData)
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function applyPoUpdatesToMaster(masterData, poData) {
  const updatedData = { ...masterData };
  const changes = [];

  Object.keys(masterData || {}).forEach(masterKey => {
    const poValue = getValueByHeader(poData, masterKey);
    if (!poValue) return;
    const masterValue = String(masterData[masterKey] || '').trim();
    if (masterValue !== poValue) {
      updatedData[masterKey] = poValue;
      changes.push({ field: masterKey, from: masterValue, to: poValue });
    }
  });

  return { updatedData, changes };
}

function generateAccessKey() {
  return crypto.randomBytes(24).toString('hex');
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

router.get('/api/keys', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  try {
    await ensurePoAdminSetup();
    const [rows] = await pool.query(
      'SELECT id, key_name AS keyName, key_prefix AS keyPrefix, created_at AS createdAt FROM po_admin_api_keys ORDER BY created_at DESC'
    );
    res.json({ keys: rows });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Unable to load API keys.' });
  }
});

router.post('/api/keys', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  const keyName = String(req.body.keyName || '').trim();
  if (!keyName) {
    return res.status(400).json({ error: 'Key name is required.' });
  }

  try {
    await ensurePoAdminSetup();
    const accessKey = generateAccessKey();
    const keyHash = hashAccessKey(accessKey);
    const keyPrefix = accessKey.slice(0, 10);

    await pool.query(
      'INSERT INTO po_admin_api_keys (key_name, key_hash, key_prefix) VALUES (?, ?, ?)',
      [keyName, keyHash, keyPrefix]
    );

    res.json({ keyName, accessKey, keyPrefix });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Key name already exists.' });
    }
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Unable to create API key.' });
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

    const [[marketplaceRow]] = await pool.query(
      'SELECT name FROM po_admin_marketplaces WHERE id = ? LIMIT 1',
      [marketplaceId]
    );
    if (!marketplaceRow) {
      return res.status(400).json({ error: 'Marketplace not found.' });
    }

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

    const poRows = [];
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

      poRows.push({
        data: rowData,
        searchBlob: buildSearchBlob(rowData)
      });
    });

    let updatedCount = 0;
    const missingIdentifiers = new Set();
    const changeSummaries = [];
    const matchRule = MARKETPLACE_MATCH_RULES[marketplaceRow.name];

    if (matchRule) {
      const [masterRows] = await pool.query(
        'SELECT id, data FROM po_admin_master_data WHERE marketplace_id = ?',
        [marketplaceId]
      );
      const masterMap = new Map();

      masterRows.forEach(row => {
        const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
        const identifier = getValueByHeader(data, matchRule.masterKey).toUpperCase();
        if (identifier) {
          masterMap.set(identifier, { id: row.id, data });
        }
      });

      for (const poRow of poRows) {
        const identifierRaw = getValueByHeader(poRow.data, matchRule.poKey);
        const identifier = identifierRaw.toUpperCase();
        if (!identifier) continue;

        const masterEntry = masterMap.get(identifier);
        if (!masterEntry) {
          missingIdentifiers.add(identifierRaw);
          continue;
        }

        const { updatedData, changes } = applyPoUpdatesToMaster(masterEntry.data, poRow.data);
        if (changes.length > 0) {
          updatedCount += 1;
          changeSummaries.push({ identifier: identifierRaw, changes });
          await pool.query(
            'UPDATE po_admin_master_data SET data = ?, search_blob = ? WHERE id = ?',
            [JSON.stringify(updatedData), buildSearchBlob(updatedData), masterEntry.id]
          );
        }
      }
    }

    const insertValues = poRows.map(row => ([
      marketplaceId,
      JSON.stringify(row.data),
      row.searchBlob
    ]));

    if (insertValues.length) {
      await pool.query(
        'INSERT INTO po_admin_po_uploads (marketplace_id, data, search_blob) VALUES ?'
        , [insertValues]
      );
    }

    const maxChanges = 50;
    const trimmedChanges = changeSummaries.slice(0, maxChanges);

    res.json({
      insertedCount: insertValues.length,
      updatedCount,
      missingIdentifiers: Array.from(missingIdentifiers),
      changeSummaries: trimmedChanges,
      changesTruncated: changeSummaries.length > maxChanges
    });
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
