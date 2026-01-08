const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const {
  API_MARKETPLACE_CONFIG,
  MARKETPLACE_MATCH_RULES,
  ensurePoAdminSetup,
  hashAccessKey
} = require('../helpers/poAdminData');

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

function buildJsonPath(columnName) {
  const safeName = String(columnName || '').replace(/"/g, '\\"');
  return `$.\"${safeName}\"`;
}

async function validateAccessKey(accessKey, keyName) {
  const keyHash = hashAccessKey(accessKey);
  const [rows] = await pool.query(
    'SELECT id FROM po_admin_api_keys WHERE key_name = ? AND key_hash = ? LIMIT 1',
    [keyName, keyHash]
  );
  return rows.length > 0;
}

router.post('/lookup', async (req, res) => {
  const accessKey = String(req.body.accessKey || '').trim();
  const keyName = String(req.body.keyName || '').trim();
  const marketplaceInput = String(req.body.marketplace || '').trim();

  if (!accessKey || !keyName || !marketplaceInput) {
    return res.status(400).json({ error: 'Access key, key name, and marketplace are required.' });
  }

  try {
    await ensurePoAdminSetup();
    const isValidKey = await validateAccessKey(accessKey, keyName);
    if (!isValidKey) {
      return res.status(401).json({ error: 'Invalid access key.' });
    }

    const marketplaceName = Object.keys(API_MARKETPLACE_CONFIG).find(
      key => key.toLowerCase() === marketplaceInput.toLowerCase()
    );
    if (!marketplaceName) {
      return res.status(400).json({ error: 'Marketplace not supported.' });
    }

    const config = API_MARKETPLACE_CONFIG[marketplaceName];
    const identifierValue = String(req.body[config.requestField] || '').trim();
    if (!identifierValue) {
      return res.status(400).json({ error: `Please provide ${config.requestLabel}.` });
    }

    const [[marketplaceRow]] = await pool.query(
      'SELECT id FROM po_admin_marketplaces WHERE name = ? LIMIT 1',
      [marketplaceName]
    );
    if (!marketplaceRow) {
      return res.status(400).json({ error: 'Marketplace not configured.' });
    }

    const poNumberPath = buildJsonPath(config.poNumberKey);
    const [poRows] = await pool.query(
      `SELECT data FROM po_admin_po_uploads
       WHERE marketplace_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, ?)) = ?`,
      [marketplaceRow.id, poNumberPath, identifierValue]
    );

    if (poRows.length === 0) {
      return res.json({ marketplace: marketplaceName, results: [] });
    }

    const matchRule = MARKETPLACE_MATCH_RULES[marketplaceName];
    const quantityMap = new Map();

    poRows.forEach(row => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
      const identifier = getValueByHeader(data, matchRule.poKey).toUpperCase();
      if (!identifier) return;
      const qtyRaw = getValueByHeader(data, config.quantityKey);
      const qty = Number(qtyRaw || 0);
      quantityMap.set(identifier, (quantityMap.get(identifier) || 0) + (Number.isFinite(qty) ? qty : 0));
    });

    const identifiers = Array.from(quantityMap.keys());
    if (identifiers.length === 0) {
      return res.json({ marketplace: marketplaceName, results: [] });
    }

    const masterPath = buildJsonPath(matchRule.masterKey);
    const [masterRows] = await pool.query(
      `SELECT data FROM po_admin_master_data
       WHERE marketplace_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, ?)) IN (?)`,
      [marketplaceRow.id, masterPath, identifiers]
    );

    const masterMap = new Map();
    masterRows.forEach(row => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
      const identifier = getValueByHeader(data, matchRule.masterKey).toUpperCase();
      if (!identifier) return;
      masterMap.set(identifier, data);
    });

    const results = identifiers.map(identifier => {
      const masterData = masterMap.get(identifier) || {};
      return {
        [config.responseKey]: identifier,
        quantity: quantityMap.get(identifier) || 0,
        ...masterData
      };
    });

    return res.json({ marketplace: marketplaceName, results });
  } catch (error) {
    console.error('Error fetching PO lookup data:', error);
    return res.status(500).json({ error: 'Unable to fetch PO data.' });
  }
});

module.exports = router;
