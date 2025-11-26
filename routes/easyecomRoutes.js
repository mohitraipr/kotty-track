const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const {
  PERIOD_PRESETS,
  resolvePeriod,
  getOrderAggregates,
  getInventoryAlerts,
  getInventoryStatuses,
  getInventoryRunway,
  getMomentumWithGrowth,
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

router.get('/stock-market', isAuthenticated, isOperator, async (req, res) => {
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

module.exports = router;
