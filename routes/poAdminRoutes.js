const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const crypto = require('crypto');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');
const {
  API_MARKETPLACE_CONFIG,
  MARKETPLACE_MATCH_RULES,
  ensurePoAdminSetup,
  fetchMarketplaces,
  hashAccessKey
} = require('../helpers/poAdminData');
const { ensurePoCreatorLotEntriesSchema } = require('../helpers/poCreatorData');

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

function applyPoUpdatesToMaster(masterData, poData, options = {}) {
  const updatedData = { ...masterData };
  const changes = [];
  const skipHeaders = (options.skipHeaders || []).map(header => normalizeHeader(header));

  Object.keys(masterData || {}).forEach(masterKey => {
    if (skipHeaders.includes(normalizeHeader(masterKey))) {
      return;
    }
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

function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildJsonPath(columnName) {
  const safeName = String(columnName || '').replace(/"/g, '\\"');
  return `$.\"${safeName}\"`;
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

router.get('/api-dashboard', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  try {
    await ensurePoAdminSetup();
    const marketplaces = await fetchMarketplaces();

    res.render('po-admin/api-dashboard', {
      user: req.session.user,
      marketplaces,
      apiMarketplaceConfig: API_MARKETPLACE_CONFIG
    });
  } catch (error) {
    console.error('Error loading PO Admin API dashboard:', error);
    req.flash('error', 'Unable to load PO Admin API dashboard.');
    res.redirect('/po-admin/dashboard');
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

router.get('/lot-entries', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  try {
    await ensurePoCreatorLotEntriesSchema();
    const { date, search } = req.query;
    const selectedDate = date || getTodayDateString();
    const filters = [];
    const params = [];

    if (selectedDate) {
      filters.push('COALESCE(le.entry_date, DATE(le.created_at)) = ?');
      params.push(selectedDate);
    }

    if (search) {
      filters.push('(le.lot_code LIKE ? OR le.sku LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [entries] = await pool.query(
      `
      SELECT
        le.id,
        le.lot_code,
        le.sku,
        le.size,
        le.quantity,
        le.entry_date,
        le.created_at,
        COALESCE(le.entry_date, DATE(le.created_at)) AS display_date,
        u.username AS creator_username
      FROM po_creator_lot_entries le
      INNER JOIN users u ON le.creator_user_id = u.id
      ${whereClause}
      ORDER BY COALESCE(le.entry_date, DATE(le.created_at)) DESC, le.created_at DESC
      `,
      params
    );

    res.render('po-admin/lot-entries', {
      user: req.session.user,
      entries,
      selectedDate,
      searchTerm: search || ''
    });
  } catch (error) {
    console.error('Error loading PO Admin lot entries:', error);
    req.flash('error', 'Unable to load lot entries.');
    res.redirect('/po-admin/dashboard');
  }
});

router.get('/lot-entries/export', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  try {
    await ensurePoCreatorLotEntriesSchema();
    const { date, search } = req.query;
    const filters = [];
    const params = [];

    if (date) {
      filters.push('COALESCE(le.entry_date, DATE(le.created_at)) = ?');
      params.push(date);
    }

    if (search) {
      filters.push('(le.lot_code LIKE ? OR le.sku LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [entries] = await pool.query(
      `
      SELECT
        COALESCE(le.entry_date, DATE(le.created_at)) AS display_date,
        u.username AS creator_username,
        le.lot_code,
        le.sku,
        le.size,
        le.quantity,
        le.created_at
      FROM po_creator_lot_entries le
      INNER JOIN users u ON le.creator_user_id = u.id
      ${whereClause}
      ORDER BY COALESCE(le.entry_date, DATE(le.created_at)) DESC, le.created_at DESC
      `,
      params
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Lot Entries');

    worksheet.columns = [
      { header: 'Entry Date', key: 'display_date', width: 15 },
      { header: 'Creator', key: 'creator_username', width: 20 },
      { header: 'Lot Code', key: 'lot_code', width: 20 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Size', key: 'size', width: 12 },
      { header: 'Quantity', key: 'quantity', width: 12 },
      { header: 'Created At', key: 'created_at', width: 22 }
    ];

    worksheet.getRow(1).font = { bold: true };

    entries.forEach(entry => {
      worksheet.addRow({
        ...entry,
        display_date: entry.display_date,
        created_at: entry.created_at
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=po-lot-entries-${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting PO Admin lot entries:', error);
    req.flash('error', 'Unable to export lot entries.');
    res.redirect('/po-admin/lot-entries');
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
    const rowSignatures = new Set();
    const duplicateRows = new Set();
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

      const signature = headers
        .map(header => `${normalizeHeader(header)}:${String(rowData[header] || '').trim().toLowerCase()}`)
        .join('|');
      if (rowSignatures.has(signature)) {
        duplicateRows.add(signature);
        return;
      }
      rowSignatures.add(signature);

      poRows.push({
        data: rowData,
        searchBlob: buildSearchBlob(rowData)
      });
    });

    let updatedCount = 0;
    const missingIdentifiers = new Set();
    const changeSummaries = [];
    const matchRule = MARKETPLACE_MATCH_RULES[marketplaceRow.name];
    const marketplaceConfig = API_MARKETPLACE_CONFIG[marketplaceRow.name];

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

        const skipHeaders = marketplaceRow.name === 'Myntra' ? ['Quantity'] : [];
        const { updatedData, changes } = applyPoUpdatesToMaster(masterEntry.data, poRow.data, { skipHeaders });
        if (marketplaceRow.name === 'Myntra') {
          const poQuantity = getValueByHeader(poRow.data, marketplaceConfig?.quantityKey || 'Quantity');
          if (poQuantity) {
            const currentOrderQty = String(masterEntry.data?.order_qty || '').trim();
            if (currentOrderQty !== poQuantity) {
              updatedData.order_qty = poQuantity;
              changes.push({ field: 'order_qty', from: currentOrderQty, to: poQuantity });
            }
          }
        }
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
      changesTruncated: changeSummaries.length > maxChanges,
      skippedDuplicateCount: duplicateRows.size
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

router.get('/api/po-summary', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  const marketplaceId = Number(req.query.marketplaceId);
  const poNumber = String(req.query.poNumber || '').trim();

  if (!marketplaceId) {
    return res.status(400).json({ error: 'Marketplace is required.' });
  }
  if (!poNumber) {
    return res.status(400).json({ error: 'PO number is required.' });
  }

  try {
    await ensurePoAdminSetup();
    const [[marketplaceRow]] = await pool.query(
      'SELECT name FROM po_admin_marketplaces WHERE id = ? LIMIT 1',
      [marketplaceId]
    );
    if (!marketplaceRow) {
      return res.status(404).json({ error: 'Marketplace not found.' });
    }

    const config = API_MARKETPLACE_CONFIG[marketplaceRow.name];
    if (!config) {
      return res.status(400).json({ error: 'Marketplace not supported for PO summary.' });
    }

    const poNumberPath = buildJsonPath(config.poNumberKey);
    const [poRows] = await pool.query(
      `SELECT data FROM po_admin_po_uploads
       WHERE marketplace_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, ?)) = ?`,
      [marketplaceId, poNumberPath, poNumber]
    );

    const totalQuantity = poRows.reduce((sum, row) => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
      const qtyRaw = getValueByHeader(data, config.quantityKey);
      const qty = Number(qtyRaw || 0);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);

    return res.json({
      poNumber,
      rowCount: poRows.length,
      totalQuantity
    });
  } catch (error) {
    console.error('Error fetching PO summary:', error);
    return res.status(500).json({ error: 'Unable to fetch PO summary.' });
  }
});

router.post('/api/delete-po', isAuthenticated, allowRoles(['poadmins', 'poadmin']), async (req, res) => {
  const marketplaceId = Number(req.body.marketplaceId);
  const poNumber = String(req.body.poNumber || '').trim();

  if (!marketplaceId) {
    return res.status(400).json({ error: 'Marketplace is required.' });
  }
  if (!poNumber) {
    return res.status(400).json({ error: 'PO number is required.' });
  }

  try {
    await ensurePoAdminSetup();
    const [[marketplaceRow]] = await pool.query(
      'SELECT name FROM po_admin_marketplaces WHERE id = ? LIMIT 1',
      [marketplaceId]
    );
    if (!marketplaceRow) {
      return res.status(404).json({ error: 'Marketplace not found.' });
    }

    const config = API_MARKETPLACE_CONFIG[marketplaceRow.name];
    if (!config) {
      return res.status(400).json({ error: 'Marketplace not supported for PO deletion.' });
    }

    const poNumberPath = buildJsonPath(config.poNumberKey);
    const [poRows] = await pool.query(
      `SELECT data FROM po_admin_po_uploads
       WHERE marketplace_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, ?)) = ?`,
      [marketplaceId, poNumberPath, poNumber]
    );

    if (!poRows.length) {
      return res.status(404).json({ error: 'PO number not found.' });
    }

    const totalQuantity = poRows.reduce((sum, row) => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
      const qtyRaw = getValueByHeader(data, config.quantityKey);
      const qty = Number(qtyRaw || 0);
      return sum + (Number.isFinite(qty) ? qty : 0);
    }, 0);

    const [result] = await pool.query(
      `DELETE FROM po_admin_po_uploads
       WHERE marketplace_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, ?)) = ?`,
      [marketplaceId, poNumberPath, poNumber]
    );

    return res.json({
      poNumber,
      deletedCount: result.affectedRows || 0,
      totalQuantity
    });
  } catch (error) {
    console.error('Error deleting PO data:', error);
    return res.status(500).json({ error: 'Unable to delete PO data.' });
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
