const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const {
  resolvePeriod,
  getOrderAggregates,
  refreshInventoryHealth,
  saveReplenishmentRule,
  getInventoryAlerts,
  getInventoryStatuses,
} = require('../utils/easyecomAnalytics');

// Map easy-to-read period aliases for query parameters
const PERIOD_KEYS = new Set(['1h', '12h', '1d', '3d', '7d']);

function normalizePeriod(period) {
  if (PERIOD_KEYS.has(period)) return period;
  return '1d';
}

router.get('/orders/summary', async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const aggregates = await getOrderAggregates(pool, {
      periodKey,
      marketplaceId: req.query.marketplaceId,
      warehouseId: req.query.warehouseId,
      sku: req.query.sku,
    });
    res.json({ period: resolvePeriod(periodKey), results: aggregates });
  } catch (err) {
    console.error('Failed to build order summary', err);
    res.status(500).json({ error: 'Unable to fetch order summary' });
  }
});

router.get('/orders/realtime', async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const aggregates = await getOrderAggregates(pool, {
      periodKey,
      marketplaceId: req.query.marketplaceId,
      warehouseId: req.query.warehouseId,
      sku: req.query.sku,
    });
    res.json({ period: resolvePeriod(periodKey), results: aggregates });
  } catch (err) {
    console.error('Failed to build realtime order data', err);
    res.status(500).json({ error: 'Unable to fetch realtime data' });
  }
});

router.post('/rules', async (req, res) => {
  try {
    const { sku, warehouse_id, threshold, making_time_days } = req.body || {};
    await saveReplenishmentRule(pool, { sku, warehouse_id, threshold, making_time_days });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Failed to save replenishment rule', err);
    res.status(400).json({ error: err.message || 'Unable to save rule' });
  }
});

router.get('/inventory/alerts', async (req, res) => {
  try {
    const alerts = await getInventoryAlerts(pool, { warehouseId: req.query.warehouseId });
    res.json({ alerts });
  } catch (err) {
    console.error('Failed to fetch alerts', err);
    res.status(500).json({ error: 'Unable to fetch alerts' });
  }
});

router.get('/inventory/status', async (req, res) => {
  try {
    const statuses = await getInventoryStatuses(pool, {
      warehouseId: req.query.warehouseId,
      status: req.query.status,
    });
    res.json({ statuses });
  } catch (err) {
    console.error('Failed to fetch inventory status', err);
    res.status(500).json({ error: 'Unable to fetch inventory status' });
  }
});

router.post('/inventory/refresh', async (req, res) => {
  try {
    const { sku, warehouse_id, inventory, period } = req.body || {};
    if (!sku || warehouse_id === undefined || warehouse_id === null || inventory === undefined || inventory === null) {
      return res.status(400).json({ error: 'sku, warehouse_id and inventory are required' });
    }
    const health = await refreshInventoryHealth(pool, {
      sku: sku.toUpperCase(),
      warehouseId: warehouse_id,
      inventory: Number(inventory),
      periodKey: normalizePeriod(period),
    });
    res.json({ ok: true, health });
  } catch (err) {
    console.error('Failed to refresh inventory health', err);
    res.status(500).json({ error: 'Unable to refresh inventory health' });
  }
});

module.exports = router;
