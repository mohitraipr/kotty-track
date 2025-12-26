const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isOnlyMohitOperator } = require('../middlewares/auth');
const ExcelJS = require('exceljs');
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

function allowStockMarketAccess(req, res, next) {
  const username = req.session?.user?.username?.toLowerCase();
  const role = req.session?.user?.roleName;

  if (
    username === 'mohitoperator' ||
    role === 'inventory_operator' ||
    role === 'operator' ||
    role === 'outofstock'
  ) {
    return next();
  }

  req.flash('error', 'You do not have permission to view this page.');
  return res.redirect('/');
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

router.get('/stock-market', isAuthenticated, allowStockMarketAccess, async (req, res) => {
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

router.get('/stock-market/data', isAuthenticated, allowStockMarketAccess, async (req, res) => {
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

router.get('/stock-market/download', isAuthenticated, allowStockMarketAccess, async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const [inventory, orders] = await Promise.all([
      getInventoryRunway(pool),
      getMomentumWithGrowth(pool, { periodKey }),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kotty Track';
    const inventorySheet = workbook.addWorksheet('Inventory Runway');
    inventorySheet.columns = [
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Warehouse', key: 'warehouse_id', width: 16 },
      { header: 'Inventory', key: 'inventory', width: 14 },
      { header: 'Making time (days)', key: 'making_time_days', width: 18 },
      { header: 'Yesterday orders', key: 'yesterday_orders', width: 18 },
      { header: 'Days left', key: 'days_left', width: 12 },
      { header: 'Status', key: 'status', width: 12 },
    ];
    inventory.forEach((row) => {
      const daysLeft = Number.isFinite(row.days_left) ? Number(row.days_left).toFixed(1) : '∞';
      inventorySheet.addRow({ ...row, days_left: daysLeft });
    });

    const ordersSheet = workbook.addWorksheet('Order Momentum');
    const periodLabel = resolvePeriod(periodKey).label;
    ordersSheet.columns = [
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Warehouse', key: 'warehouse_id', width: 16 },
      { header: `Orders (${periodLabel})`, key: 'orders', width: 18 },
      { header: 'Previous window', key: 'previous_orders', width: 18 },
      { header: 'Growth %', key: 'growth', width: 12 },
    ];
    orders.forEach((row) => {
      ordersSheet.addRow({ ...row, growth: Number(row.growth || 0).toFixed(1) });
    });

    const fileName = `stock-market-${periodKey}.xlsx`;
    const buffer = await workbook.xlsx.writeBuffer();
    const outputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=\"${fileName}\"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Length', outputBuffer.length);
    res.send(outputBuffer);
  } catch (err) {
    console.error('Failed to download stock market Excel:', err);
    res.status(500).json({ error: 'Unable to download Excel' });
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
