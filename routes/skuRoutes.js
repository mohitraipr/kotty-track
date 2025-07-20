const express = require('express');
const router = express.Router();
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const { pool } = require('../config/db');

// Simple in-memory cache for inventory alerts
const ALERT_CACHE_TTL_MS = 60 * 1000; // 1 minute
let alertCache = { data: null, expiry: 0 };

async function getInventoryAlerts() {
  const now = Date.now();
  if (alertCache.data && alertCache.expiry > now) {
    return alertCache.data;
  }
  const [rows] = await pool.query(
    'SELECT sku, quantity, created_at FROM inventory_alerts ORDER BY created_at DESC LIMIT 50'
  );
  alertCache = { data: rows, expiry: now + ALERT_CACHE_TTL_MS };
  return rows;
}

router.get('/sku/:sku', isAuthenticated, isOperator, (req, res) => {
  const sku = req.params.sku;
  res.render('skuDetail', { sku });
});

router.get('/inventory/alerts', isAuthenticated, isOperator, async (req, res) => {
  try {
    const alerts = await getInventoryAlerts();
    res.render('inventoryAlerts', { alerts });
  } catch (err) {
    console.error('Failed to load inventory alerts', err);
    res.render('inventoryAlerts', { alerts: [] });
  }
});

module.exports = router;
