const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isOnlyMohitOperator } = require('../middlewares/auth');
const {
  PERIOD_PRESETS,
  resolvePeriod,
  getOrderAggregates,
  getInventoryAlerts,
  getInventoryStatuses,
  getInventoryRunway,
  getMomentumWithGrowth,
  saveReplenishmentRule,
} = require('../utils/easyecomAnalytics');

const PERIOD_KEYS = new Set(Object.keys(PERIOD_PRESETS));
function normalizePeriod(period) {
  if (PERIOD_KEYS.has(period)) return period;
  return '1d';
}

router.get('/ops', isAuthenticated, isOperator, async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const filters = {
      marketplaceId: req.query.marketplaceId || '',
      warehouseId: req.query.warehouseId || '',
      sku: (req.query.sku || '').toUpperCase(),
      status: req.query.status || '',
    };

    const [orders, alerts, statuses] = await Promise.all([
      getOrderAggregates(pool, { periodKey, ...filters, sku: filters.sku || undefined }),
      getInventoryAlerts(pool, { warehouseId: filters.warehouseId || undefined }),
      getInventoryStatuses(pool, {
        warehouseId: filters.warehouseId || undefined,
        status: filters.status || undefined,
      }),
    ]);

    res.render('easyecomOps', {
      user: req.session?.user || null,
      periodKey,
      period: resolvePeriod(periodKey),
      periodPresets: PERIOD_PRESETS,
      orders,
      alerts,
      statuses,
      filters,
    });
  } catch (err) {
    console.error('Failed to render EasyEcom Ops UI:', err);
    req.flash('error', 'Could not load EasyEcom operations');
    res.redirect('/');
  }
});

router.get('/stock-market', isAuthenticated, async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const [inventory, orders] = await Promise.all([
      getInventoryRunway(pool),
      getMomentumWithGrowth(pool, { periodKey }),
    ]);

    res.render('stockMarket', {
      user: req.session?.user || null,
      inventory,
      orders,
      periodKey,
      period: resolvePeriod(periodKey),
      periodPresets: PERIOD_PRESETS,
    });
  } catch (err) {
    console.error('Failed to render stock market view:', err);
    req.flash('error', 'Could not load stock market view');
    res.redirect('/');
  }
});

router.get('/stock-market/data', isAuthenticated, async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const [inventory, orders] = await Promise.all([
      getInventoryRunway(pool),
      getMomentumWithGrowth(pool, { periodKey }),
    ]);

    res.json({
      inventory,
      orders,
      period: resolvePeriod(periodKey),
    });
  } catch (err) {
    console.error('Failed to fetch stock market data:', err);
    res.status(500).json({ error: 'Unable to refresh data' });
  }
});

function parseBulkLines(input = '') {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

router.get('/stock-market/making-time', isAuthenticated, isOnlyMohitOperator, (req, res) => {
  res.render('stockMarketBulkMakingTime', {
    user: req.session?.user || null,
    result: null,
    bulkInput: '',
  });
});

router.post('/stock-market/making-time', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  const bulkInput = req.body?.bulkInput || '';
  const lines = parseBulkLines(bulkInput);
  const errors = [];
  const success = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const [skuRaw, warehouseRaw, daysRaw] = lines[idx];
    const sku = skuRaw?.toUpperCase();
    const warehouse = warehouseRaw || null;
    const makingTime = Number(daysRaw);

    if (!sku || Number.isNaN(makingTime)) {
      errors.push(`Row ${idx + 1}: Invalid data`);
      continue;
    }

    try {
      await saveReplenishmentRule(pool, {
        sku,
        warehouse_id: warehouse || null,
        making_time_days: makingTime,
      });
      success.push(sku);
    } catch (err) {
      console.error('Failed to save making time', err);
      errors.push(`Row ${idx + 1}: Could not save ${sku}`);
    }
  }

  res.render('stockMarketBulkMakingTime', {
    user: req.session?.user || null,
    bulkInput,
    result: { errors, success },
  });
});

module.exports = router;
