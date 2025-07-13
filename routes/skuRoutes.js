const express = require('express');
const router = express.Router();
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const { pool } = require('../config/db');

router.get('/sku/:sku', isAuthenticated, isOperator, (req, res) => {
  const sku = req.params.sku;
  res.render('skuDetail', { sku });
});

router.get('/inventory/alerts', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [alerts] = await pool.query(
      'SELECT sku, quantity, created_at FROM inventory_alerts ORDER BY created_at DESC LIMIT 50'
    );
    res.render('inventoryAlerts', { alerts });
  } catch (err) {
    console.error('Failed to load inventory alerts', err);
    res.render('inventoryAlerts', { alerts: [] });
  }
});

module.exports = router;
